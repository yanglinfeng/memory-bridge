import { createHash, randomUUID } from 'node:crypto';
import {
  config,
  SYSTEM_JOB_NAMESPACE,
  SYSTEM_JOB_USER_ID,
} from './config.js';
import type { CandidateResolver } from './candidate-resolver.js';
import {
  DENSE_EVALUATION_DATASET_SHA256,
  type DenseIndexEvaluator,
} from './dense-index-evaluator.js';
import type { EpisodicMemoryService } from './episodic-memory-service.js';
import type {
  HierarchicalSummaryInput,
  HierarchicalSummaryService,
} from './hierarchical-summary-service.js';
import {
  isCanonicalConsolidationSweepJobId,
  LifecycleStore,
  type JobFailureOptions,
  type MemoryJob,
  type OutboxDispatchResult,
} from './lifecycle-store.js';
import {
  MemoryConsolidator,
} from './memory-consolidator.js';
import type { MemoryExtractor } from './memory-extractor.js';
import { MemoryGovernance } from './memory-governance.js';
import type { MemoryStore } from './memory-store.js';
import { DENSE_LSH_VERSION } from './hybrid-retrieval.js';
import type { MemoryRecord } from './types.js';
import type { MemoryReflectionService } from './memory-reflection.js';
import {
  backgroundModelWorkAllowed,
  isBackgroundModelPreempted,
  runWithBackgroundModelQos,
} from './model-qos.js';

export interface MemoryWorkerResult {
  processed: boolean;
  job: MemoryJob | null;
  candidateCount: number;
  error?: string;
}

export interface MemoryWorkerProcessOptions {
  backgroundModelAllowed?: boolean;
  _backgroundQosContext?: boolean;
}

export const PURGE_MEMORY_LEASE_SECONDS = 120;
export const PURGE_DISCOVERY_POLL_MAX_MS = 5_000;

const BACKGROUND_MODEL_JOB_TYPES = new Set([
  'extract_turn',
  'resolve_candidate',
  'consolidate_memory_change',
  'consolidate_scope',
  'consolidation_sweep',
  'reflection_sweep',
  'reextract_turn_window',
  'reflect_turn_window',
  'index_memory',
  'backfill_dense_index',
  'evaluate_dense_index',
  'summarize_memory_bucket',
]);

interface JobRecoveryDirective {
  mode: 'recompute' | 'repair';
  failureClass: string;
  strategy:
    | 'reload_current_sources_and_recompute'
    | 'recompute_eligible_clusters_only'
    | 'single_attempt_protocol_repair';
}

interface JobFailureEvidence {
  outputFingerprint?: string;
  missingSourceIds?: string[];
  modelDurationMs?: number;
}

export function purgeAwareWorkerPollMs(value: number): number {
  return Math.max(
    100,
    Math.min(
      Number.isFinite(value) ? Math.trunc(value) : 500,
      PURGE_DISCOVERY_POLL_MAX_MS,
    ),
  );
}

export function memoryJobRetryDelayMs(
  job: Pick<MemoryJob, 'id' | 'attempts' | 'updatedAt'>,
): number {
  const exponential = Math.min(
    60_000,
    1_000 * 2 ** Math.max(0, job.attempts - 1),
  );
  const jitterSeed = Number.parseInt(
    createHash('sha256')
      .update(`${job.id}:${job.attempts}:${job.updatedAt}`)
      .digest('hex')
      .slice(0, 8),
    16,
  ) / 0xffffffff;
  const jittered = Math.round(exponential * (0.8 + jitterSeed * 0.4));
  return Math.max(250, Math.min(60_000, jittered));
}

function parseJobRecoveryDirective(
  job: MemoryJob,
): JobRecoveryDirective | null {
  const value = job.payload.recovery;
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('dead letter recovery 指令无效');
  }
  const record = value as Record<string, unknown>;
  const mode = typeof record.mode === 'string' ? record.mode : '';
  const failureClass = typeof record.failureClass === 'string'
    ? record.failureClass
    : '';
  const strategy = typeof record.strategy === 'string'
    ? record.strategy
    : '';
  if (!['recompute', 'repair'].includes(mode) || !strategy) {
    throw new Error('dead letter recovery 指令不受 Worker 支持');
  }
  const expectedStrategy = mode === 'recompute'
    ? 'reload_current_sources_and_recompute'
    : failureClass === 'coverage'
      ? 'recompute_eligible_clusters_only'
      : failureClass === 'protocol'
        ? 'single_attempt_protocol_repair'
        : '';
  if (!expectedStrategy || strategy !== expectedStrategy) {
    throw new Error('dead letter recovery 策略与模式或故障分类不一致');
  }
  if (mode === 'repair' && job.maxAttempts !== 1) {
    throw new Error('dead letter repair 必须限制为一次尝试');
  }
  return {
    mode: mode as JobRecoveryDirective['mode'],
    failureClass,
    strategy: strategy as JobRecoveryDirective['strategy'],
  };
}

function jobFailureEvidence(error: unknown): JobFailureEvidence {
  if (!error || typeof error !== 'object') return {};
  const record = error as unknown as Record<string, unknown>;
  return {
    outputFingerprint:
      typeof record.outputFingerprint === 'string'
        ? record.outputFingerprint
        : undefined,
    missingSourceIds: Array.isArray(record.missingSourceIds)
      ? record.missingSourceIds.filter(
          (value): value is string => typeof value === 'string',
        )
      : undefined,
    modelDurationMs:
      typeof record.modelDurationMs === 'number' &&
      Number.isFinite(record.modelDurationMs)
        ? record.modelDurationMs
        : undefined,
  };
}

function domainFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function contentFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(String(value ?? '').normalize('NFKC'))
    .digest('hex');
}

export function classifyMemoryJobFailure(
  job: Pick<MemoryJob, 'jobType' | 'attempts'>,
  error: string,
): JobFailureOptions {
  const message = String(error || '').normalize('NFKC');
  if (/来源.*持续变化|source.?drift/iu.test(message)) {
    return {
      retryable: true,
      failureClass: 'source_drift',
      compensationAction: 'reload_sources_and_recompute',
    };
  }
  if (
    job.jobType === 'consolidate_scope' &&
    /未覆盖全部来源|coverage|遗漏.{0,12}来源/iu.test(message)
  ) {
    return {
      retryable: false,
      failureClass: 'coverage',
      compensationAction: 'stop_duplicate_retry',
    };
  }
  if (
    /JSON.*(?:解析|无效)|协议|结构无效|格式|未遵守句数预算/iu.test(
      message,
    )
  ) {
    const retryable = job.attempts < 2;
    return {
      retryable,
      failureClass: 'protocol',
      compensationAction: retryable
        ? 'retry_protocol_once'
        : 'quarantine_protocol_failure',
    };
  }
  if (
    /所有权|不支持的记忆任务|缺少(?:作用域|scopeType)|无效/u.test(
      message,
    )
  ) {
    return {
      retryable: false,
      failureClass: 'unsupported',
      compensationAction: 'quarantine_unsupported_job',
    };
  }
  if (
    /timeout|timed out|ECONN|fetch failed|temporar|429|502|503|504|暂时不可用/iu
      .test(message)
  ) {
    return {
      retryable: true,
      failureClass: 'transient',
      compensationAction: 'retry_with_backoff',
    };
  }
  return {
    retryable: true,
    failureClass: 'unknown',
    compensationAction: 'retry_with_backoff',
  };
}

interface ScopedJobTarget {
  userId: string;
  namespace: string;
}

function assertJobTargetOwnership<T extends ScopedJobTarget>(
  job: MemoryJob,
  target: T | null,
  label: string,
): asserts target is T {
  if (
    !target ||
    target.userId !== job.userId ||
    target.namespace !== job.namespace
  ) {
    throw new Error(
      `${label}不存在或所有权与任务 userId/namespace 不一致`,
    );
  }
}

function assertOptionalPayloadScope(job: MemoryJob): void {
  for (const field of ['userId', 'namespace'] as const) {
    const value = job.payload[field];
    if (
      value !== undefined &&
      (
        typeof value !== 'string' ||
        value !== job[field]
      )
    ) {
      throw new Error(
        `任务 payload.${field} 与任务所有权不一致`,
      );
    }
  }
}

export class MemoryWorker {
  constructor(
    private readonly lifecycleStore: LifecycleStore,
    private readonly extractor: MemoryExtractor,
    private readonly candidateResolver?: CandidateResolver,
    private readonly consolidator?: MemoryConsolidator,
    private readonly governance?: MemoryGovernance,
    private readonly extractionEnabled = true,
    private readonly memoryStore?: MemoryStore,
    private readonly denseEvaluator?: DenseIndexEvaluator,
    private readonly reflectionService?: MemoryReflectionService,
    private readonly episodicMemoryService?: EpisodicMemoryService,
    private readonly hierarchicalSummaryService?: HierarchicalSummaryService,
  ) {}

  private requireOwnedMemory(
    job: MemoryJob,
    memoryId: string,
    label: string,
  ): MemoryRecord {
    if (!this.memoryStore) {
      throw new Error(`${label}校验缺少记忆存储`);
    }
    const memory = this.memoryStore.get(
      memoryId,
      true,
      job.userId,
      job.namespace,
    );
    assertJobTargetOwnership(job, memory, label);
    return memory;
  }

  private assertDenseGenerationScope(
    job: MemoryJob,
    generationId: string,
    label: string,
  ): void {
    if (!this.memoryStore) {
      throw new Error(`${label}校验缺少记忆存储`);
    }
    const alias = this.memoryStore.denseIndexAlias(
      job.userId,
      job.namespace,
    );
    if (
      !alias ||
      ![
        alias.activeGenerationId,
        alias.buildingGenerationId,
        alias.previousGenerationId,
      ].includes(generationId)
    ) {
      throw new Error(
        `${label}不属于任务 userId/namespace 的 Dense alias`,
      );
    }
  }

  async processNext(
    workerId: string,
    options: MemoryWorkerProcessOptions = {},
  ): Promise<MemoryWorkerResult> {
    if (!options._backgroundQosContext) {
      return runWithBackgroundModelQos(() =>
        this.processNext(workerId, {
          ...options,
          _backgroundQosContext: true,
        }),
      );
    }
    const backgroundModelAllowed =
      options.backgroundModelAllowed !== false &&
      backgroundModelWorkAllowed(config.foregroundQuietMs);
    const leaseSeconds = Math.max(
      300,
      Math.ceil(config.semanticTimeoutMs / 1000) + 60,
    );
    const purgeJob = this.governance
      ? this.lifecycleStore.claimJob(
          workerId,
          PURGE_MEMORY_LEASE_SECONDS,
          ['purge_memory'],
        )
      : null;
    let denseCapabilities = {
      modelIds: [] as string[],
      generationIds: [] as string[],
    };
    if (
      backgroundModelAllowed &&
      !purgeJob &&
      this.memoryStore?.canDenseIndex()
    ) {
      try {
        await this.memoryStore.prepareDenseIndexScopes();
        denseCapabilities =
          this.memoryStore.denseWorkerCapabilities();
      } catch (error) {
        // Dense provider failure must not block extraction,
        // consolidation, governance, or outbox durability.
        console.warn(
          '[memory-worker] dense index probe failed:',
          error instanceof Error ? error.message : String(error).slice(0, 200),
        );
      }
    }
    const dispatched: OutboxDispatchResult = purgeJob
      ? { processed: false, event: null }
      : this.lifecycleStore.dispatchNextOutbox(
          workerId,
          leaseSeconds,
        );
    if (dispatched.error) {
      return {
        processed: true,
        job: null,
        candidateCount: 0,
        error: dispatched.error,
      };
    }
    const dispatchedBatch = [dispatched];
    if (!purgeJob && dispatched.processed) {
      for (
        let index = 1;
        index < config.semanticEmbedBatchSize;
        index += 1
      ) {
        const next = this.lifecycleStore.dispatchNextOutbox(
          workerId,
          leaseSeconds,
        );
        if (next.error) {
          return {
            processed: true,
            job: null,
            candidateCount: 0,
            error: next.error,
          };
        }
        if (!next.processed) break;
        dispatchedBatch.push(next);
      }
    }
    for (const dispatchedItem of dispatchedBatch) {
      if (
        this.governance &&
        dispatchedItem.event?.aggregateType === 'memory_event'
      ) {
        this.governance.ensureRetentionSweep(
          dispatchedItem.event.availableAt,
          dispatchedItem.event.userId,
          dispatchedItem.event.namespace,
        );
      }
      if (this.reflectionService && dispatchedItem.event) {
        this.reflectionService.ensureSweep(
          dispatchedItem.event.userId,
          dispatchedItem.event.namespace,
        );
      }
    }
    const jobTypes: string[] = [];
    if (this.episodicMemoryService) {
      jobTypes.push('materialize_episode');
    }
    if (backgroundModelAllowed && this.hierarchicalSummaryService) {
      jobTypes.push('summarize_memory_bucket');
    }
    if (backgroundModelAllowed && this.extractionEnabled) {
      jobTypes.push('extract_turn');
      if (this.candidateResolver) jobTypes.push('resolve_candidate');
    }
    if (backgroundModelAllowed && this.consolidator) {
      jobTypes.push(
        'consolidate_memory_change',
        'consolidate_scope',
        'consolidation_sweep',
      );
    }
    if (this.governance) {
      jobTypes.push('retention_sweep');
    }
    if (backgroundModelAllowed && this.reflectionService) {
      jobTypes.push(
        'reflection_sweep',
        'reextract_turn_window',
        'reflect_turn_window',
      );
    }
    if (denseCapabilities.generationIds.length > 0) {
      jobTypes.push('index_memory', 'backfill_dense_index');
      if (this.denseEvaluator) {
        jobTypes.push('evaluate_dense_index');
      }
    }
    const job =
      purgeJob ||
      (
        jobTypes.length > 0
          ? this.lifecycleStore.claimJob(
              workerId,
              leaseSeconds,
              jobTypes,
              denseCapabilities,
            )
          : null
      );
    if (!job) {
      return {
        processed: dispatchedBatch.some((item) => item.processed),
        job: null,
        candidateCount: 0,
      };
    }
    if (
      BACKGROUND_MODEL_JOB_TYPES.has(job.jobType) &&
      !backgroundModelWorkAllowed(config.foregroundQuietMs)
    ) {
      const deferred = this.lifecycleStore.deferClaimedJob(
        job.id,
        workerId,
        Math.max(100, config.foregroundQuietMs),
        'foreground_activity_after_claim',
      );
      return {
        processed: false,
        job: deferred,
        candidateCount: 0,
      };
    }

    const jobStartedAt = performance.now();
    let extractionRunId: string | null = null;
    let purgeJobId: string | null = null;
    let reflectionRunId: string | null = null;
    let recoveryDirective: JobRecoveryDirective | null = null;
    let jobInputFingerprint: string | undefined;
    let claimedDenseBatch: MemoryJob[] = [];
    try {
      assertOptionalPayloadScope(job);
      recoveryDirective = parseJobRecoveryDirective(job);
      if (job.jobType === 'materialize_episode') {
        if (!this.episodicMemoryService) {
          throw new Error('情景记忆物化服务未配置');
        }
        const userTurnId =
          typeof job.payload.userTurnId === 'string'
            ? job.payload.userTurnId
            : '';
        const assistantTurnId =
          typeof job.payload.assistantTurnId === 'string'
            ? job.payload.assistantTurnId
            : '';
        if (!userTurnId || !assistantTurnId) {
          throw new Error('情景记忆任务缺少完整 exchange turn id');
        }
        jobInputFingerprint = domainFingerprint({
          contract: 'materialize-episode-v1',
          userId: job.userId,
          namespace: job.namespace,
          userTurnId,
          assistantTurnId,
        });
        const result = this.episodicMemoryService.materialize({
          userId: job.userId,
          namespace: job.namespace,
          userTurnId,
          assistantTurnId,
        });
        const episode = this.lifecycleStore.getTurn(
          userTurnId,
          job.userId,
          job.namespace,
        );
        if (!episode) {
          throw new Error('情景记忆任务来源 turn 不存在');
        }
        this.lifecycleStore.enqueueEndedSessionSummaryJobs(
          episode.sessionId,
        );
        const completed = this.lifecycleStore.completeJob(
          job.id,
          workerId,
          {
            inputFingerprint: jobInputFingerprint,
            outputFingerprint: domainFingerprint({
              episodeId: result.episodeId,
              memoryId: result.memoryId,
              created: result.created,
            }),
            modelDurationMs: 0,
            resultStatus: result.created ? 'created' : 'idempotent_replay',
            noopReason: result.created ? null : 'episode_already_materialized',
          },
        );
        return {
          processed: true,
          job: completed,
          candidateCount: result.created ? 1 : 0,
        };
      }
      if (job.jobType === 'summarize_memory_bucket') {
        if (!this.hierarchicalSummaryService) {
          throw new Error('层级摘要服务未配置');
        }
        const summaryType = job.payload.summaryType;
        const bucketKey = job.payload.bucketKey;
        const scopeType = job.payload.scopeType;
        const scopeKey = job.payload.scopeKey;
        const timezoneOffsetMinutes = job.payload.timezoneOffsetMinutes;
        if (
          !['session', 'day', 'week'].includes(String(summaryType)) ||
          typeof bucketKey !== 'string' || !bucketKey.trim() ||
          !['personal', 'project', 'role', 'session'].includes(
            String(scopeType),
          ) ||
          typeof scopeKey !== 'string' || !scopeKey.trim() ||
          !Number.isInteger(timezoneOffsetMinutes) ||
          Number(timezoneOffsetMinutes) < -840 ||
          Number(timezoneOffsetMinutes) > 840
        ) {
          throw new Error('层级摘要任务 payload 无效');
        }
        const input: HierarchicalSummaryInput = {
          userId: job.userId,
          namespace: job.namespace,
          summaryType: summaryType as HierarchicalSummaryInput['summaryType'],
          bucketKey,
          scopeType: scopeType as HierarchicalSummaryInput['scopeType'],
          scopeKey,
          timezoneOffsetMinutes: Number(timezoneOffsetMinutes),
        };
        jobInputFingerprint = domainFingerprint({
          contract: 'summarize-memory-bucket-v1',
          ...input,
        });
        const modelStartedAt = performance.now();
        const result = await this.hierarchicalSummaryService.summarizeBucket(
          input,
        );
        const modelDurationMs = Number(
          (performance.now() - modelStartedAt).toFixed(3),
        );
        const outputFingerprint = domainFingerprint(result);
        if (
          result.status === 'failed' ||
          result.status === 'failed_preserved'
        ) {
          const failure = new Error('层级摘要 provider 暂时不可用') as
            Error & JobFailureEvidence;
          failure.outputFingerprint = outputFingerprint;
          failure.modelDurationMs = modelDurationMs;
          throw failure;
        }
        const completed = this.lifecycleStore.completeJob(
          job.id,
          workerId,
          {
            inputFingerprint: jobInputFingerprint,
            outputFingerprint,
            modelDurationMs,
            resultStatus: result.status,
            noopReason: result.status === 'unchanged'
              ? 'summary_unchanged'
              : result.status === 'blocked'
                ? result.errorCode || 'summary_blocked'
                : null,
          },
        );
        return {
          processed: true,
          job: completed,
          candidateCount: result.sentenceCount,
        };
      }
      if (job.jobType === 'reflection_sweep') {
        if (!this.reflectionService) {
          throw new Error('历史重提炼 sweep 服务未配置');
        }
        const scopeDiscoveryWatermark =
          typeof job.payload.scopeDiscoveryWatermark === 'number'
            ? job.payload.scopeDiscoveryWatermark
            : 0;
        jobInputFingerprint = domainFingerprint({
          contract: 'reflection-sweep-v1',
          userId: job.userId,
          namespace: job.namespace,
          scopeDiscoveryWatermark,
        });
        const result = this.reflectionService.runSweep(
          job.userId,
          job.namespace,
          scopeDiscoveryWatermark,
        );
        const completed = this.lifecycleStore.completeJob(
          job.id,
          workerId,
          {
            inputFingerprint: jobInputFingerprint,
            outputFingerprint: domainFingerprint({
              queuedRuns: result.queuedRuns,
              discoveryWatermark: result.discoveryWatermark,
            }),
            modelDurationMs: 0,
            resultStatus: 'completed',
          },
        );
        this.reflectionService.scheduleSweepSuccessor(
          job.userId,
          job.namespace,
          result.discoveryWatermark,
        );
        return {
          processed: true,
          job: completed,
          candidateCount: result.queuedRuns,
        };
      }
      if (
        job.jobType === 'reextract_turn_window' ||
        job.jobType === 'reflect_turn_window'
      ) {
        if (!this.reflectionService) {
          throw new Error('历史重提炼窗口服务未配置');
        }
        const requestedReflectionRunId =
          typeof job.payload.runId === 'string'
          ? job.payload.runId
          : '';
        if (!requestedReflectionRunId) {
          throw new Error('历史重提炼任务缺少 runId');
        }
        const run = this.reflectionService.getRun(
          requestedReflectionRunId,
          job.userId,
        );
        if (!run || run.namespace !== job.namespace) {
          throw new Error('历史重提炼 run 不存在或任务所有权不一致');
        }
        reflectionRunId = run.id;
        const expectedType = job.jobType === 'reflect_turn_window'
          ? 'reflect'
          : 'reextract';
        if (run.runType !== expectedType) {
          throw new Error('历史重提炼 job/run 类型不一致');
        }
        jobInputFingerprint = domainFingerprint({
          contract: 'reflection-window-v1',
          runId: run.id,
          userId: run.userId,
          namespace: run.namespace,
          scopeType: run.scopeType,
          scopeKey: run.scopeKey,
          runType: run.runType,
          turnSetHash: run.turnSetHash,
          inputTurnCount: run.inputTurnCount,
          generationKey: run.generationKey,
          model: run.model,
          promptVersion: run.promptVersion,
          extractorId: run.extractorId,
          extractorVersion: run.extractorVersion,
        });
        const modelStartedAt = performance.now();
        const result = await this.reflectionService.executeRun(
          run.id,
          workerId,
          {
            leaseSeconds,
            heartbeatMs: Math.max(
              1_000,
              Math.floor(leaseSeconds * 1_000 / 3),
            ),
            renewJobLease: () => {
              this.lifecycleStore.renewJobLease(
                job.id,
                workerId,
                leaseSeconds,
              );
            },
          },
        );
        const completed = this.lifecycleStore.completeJob(
          job.id,
          workerId,
          {
            inputFingerprint: jobInputFingerprint,
            outputFingerprint: domainFingerprint({
              runId: result.run.id,
              status: result.run.status,
              candidateCount: result.candidates.length,
              candidates: result.candidates.map((candidate) => ({
                id: candidate.id,
                normalizedHash: candidate.normalizedHash,
                state: candidate.state,
              })),
            }),
            modelDurationMs: Number(
              (performance.now() - modelStartedAt).toFixed(3),
            ),
            resultStatus: result.run.status,
          },
        );
        return {
          processed: true,
          job: completed,
          candidateCount: result.candidates.length,
        };
      }
      if (job.jobType === 'index_memory') {
        if (!this.memoryStore) {
          throw new Error('Dense 记忆索引器未配置');
        }
        const memoryId =
          typeof job.payload.memoryId === 'string'
            ? job.payload.memoryId
            : '';
        if (!memoryId) {
          throw new Error('Dense 索引任务缺少 memoryId');
        }
        this.requireOwnedMemory(job, memoryId, 'Dense 索引记忆');
        const generationId =
          typeof job.payload.generationId === 'string'
            ? job.payload.generationId
            : job.requiredGenerationId || undefined;
        if (
          job.requiredGenerationId &&
          generationId !== job.requiredGenerationId
        ) {
          throw new Error('Dense 索引任务的 generation affinity 不一致');
        }
        if (generationId) {
          this.assertDenseGenerationScope(
            job,
            generationId,
            'Dense 索引 generation',
          );
        }
        const generation = generationId
          ? this.memoryStore.denseIndexGeneration(generationId)
          : null;
        if (
          generationId &&
          (
            !generation ||
            (
              job.requiredModelId &&
              generation.modelId !== job.requiredModelId
            )
          )
        ) {
          throw new Error('Dense 索引任务的 model/generation 不一致');
        }
        const batchJobs = this.lifecycleStore.claimDenseIndexBatch(
          job.id,
          workerId,
          leaseSeconds,
          config.semanticEmbedBatchSize,
        );
        claimedDenseBatch = batchJobs;
        const batchMemoryIds = batchJobs.map((batchJob) => {
          const batchMemoryId = typeof batchJob.payload.memoryId === 'string'
            ? batchJob.payload.memoryId
            : '';
          if (!batchMemoryId) {
            throw new Error('Dense 批量索引任务缺少 memoryId');
          }
          this.requireOwnedMemory(
            batchJob,
            batchMemoryId,
            'Dense 批量索引记忆',
          );
          return batchMemoryId;
        });
        const result = await this.memoryStore.indexMemoriesDense(
          batchMemoryIds,
          job.userId,
          job.namespace,
          () => {
            for (const batchJob of batchJobs) {
              this.lifecycleStore.assertJobLease(
                batchJob.id,
                workerId,
              );
            }
          },
          generationId,
          {
            deferScopeWatermarkUntilQueueTail: true,
            deferScopeWatermarkAlways: true,
            currentJobId: job.id,
            currentJobIds: batchJobs.map((batchJob) => batchJob.id),
            reusePreparedGenerationProbe: true,
          },
        );
        const completionOptions = {
            outputFingerprint: domainFingerprint({
              generationId: result.generationId,
              processed: result.processed,
              complete: result.complete,
            }),
            modelDurationMs: result.telemetry.embeddingDurationMs,
            denseIndexTelemetry: result.telemetry,
          };
        const followerCompletionOptions = {
          ...completionOptions,
          modelDurationMs: 0,
          denseIndexTelemetry: {
            ...result.telemetry,
            probeDurationMs: 0,
            embeddingDurationMs: 0,
            databaseWriteDurationMs: 0,
            watermarkDurationMs: 0,
            embeddingBatchCalls: 0,
            physicalWorkAttributed: false,
          },
        };
        for (const batchJob of batchJobs.slice(1)) {
          this.lifecycleStore.completeJob(
            batchJob.id,
            workerId,
            followerCompletionOptions,
          );
        }
        const completed = this.lifecycleStore.completeJob(
          job.id,
          workerId,
          completionOptions,
        );
        return {
          processed: true,
          job: completed,
          candidateCount: result.processed,
        };
      }
      if (job.jobType === 'backfill_dense_index') {
        if (!this.memoryStore) {
          throw new Error('Dense 记忆索引器未配置');
        }
        const generationId =
          typeof job.payload.generationId === 'string'
            ? job.payload.generationId
            : job.requiredGenerationId || undefined;
        if (
          job.requiredGenerationId &&
          generationId !== job.requiredGenerationId
        ) {
          throw new Error('Dense 回填任务的 generation affinity 不一致');
        }
        if (generationId) {
          this.assertDenseGenerationScope(
            job,
            generationId,
            'Dense 回填 generation',
          );
        }
        const generation = generationId
          ? this.memoryStore.denseIndexGeneration(generationId)
          : null;
        const expectedModel =
          typeof job.payload.model === 'string'
            ? job.payload.model
            : undefined;
        const expectedIndexVersion =
          typeof job.payload.indexVersion === 'string'
            ? job.payload.indexVersion
            : undefined;
        if (
          generationId &&
          (
            !generation ||
            (
              job.requiredModelId &&
              generation.modelId !== job.requiredModelId
            ) ||
            (
              expectedModel &&
              generation.embeddingModel !== expectedModel
            ) ||
            (
              expectedIndexVersion &&
              generation.indexVersion !== expectedIndexVersion
            )
          )
        ) {
          throw new Error('Dense 回填任务的 model/generation 不一致');
        }
        if (
          !generationId &&
          (
            (
              expectedModel &&
              !this.memoryStore
                .denseEmbeddingModels()
                .includes(expectedModel)
            ) ||
            (
              expectedIndexVersion &&
              expectedIndexVersion !== DENSE_LSH_VERSION
            )
          )
        ) {
          throw new Error('Dense 回填任务的 embedding 模型或索引版本不一致');
        }
        const result = await this.memoryStore.backfillDenseIndex(
          config.semanticEmbedBatchSize,
          undefined,
          job.userId,
          job.namespace,
          typeof job.payload.dimensions === 'number'
            ? job.payload.dimensions
            : undefined,
          typeof job.payload.generationKey === 'string'
            ? job.payload.generationKey
            : undefined,
          () => this.lifecycleStore.assertJobLease(
            job.id,
            workerId,
          ),
          generationId,
        );
        if (!result.complete && result.processed > 0) {
          this.lifecycleStore.enqueueJob({
            id: [
              'backfill-dense',
              result.model,
              job.userId,
              job.namespace,
              randomUUID(),
            ].join(':'),
            jobType: 'backfill_dense_index',
            userId: job.userId,
            namespace: job.namespace,
            payload: {
              model: result.model,
              indexVersion: result.indexVersion,
              dimensions: result.dimensions,
              generationKey: result.generationKey,
              generationId: result.generationId,
            },
            requiredModelId: result.modelId || undefined,
            requiredGenerationId:
              result.generationId || undefined,
            priority: 2,
            maxAttempts: 5,
          });
        }
        if (result.complete && result.generationId) {
          const alias = this.memoryStore.denseIndexAlias(
            job.userId,
            job.namespace,
          );
          if (
            alias?.activeGenerationId === result.generationId ||
            alias?.buildingGenerationId === result.generationId
          ) {
            this.lifecycleStore.enqueueJob({
              id: [
                'evaluate-dense',
                result.generationId,
                DENSE_EVALUATION_DATASET_SHA256,
              ].join(':'),
              jobType: 'evaluate_dense_index',
              userId: job.userId,
              namespace: job.namespace,
              payload: {
                generationId: result.generationId,
                datasetSha256:
                  DENSE_EVALUATION_DATASET_SHA256,
              },
              requiredModelId: result.modelId || undefined,
              requiredGenerationId: result.generationId,
              priority: 1,
              maxAttempts: 3,
            });
          }
        }
        const completed = this.lifecycleStore.completeJob(
          job.id,
          workerId,
        );
        return {
          processed: true,
          job: completed,
          candidateCount: result.processed,
        };
      }
      if (job.jobType === 'evaluate_dense_index') {
        if (!this.memoryStore || !this.denseEvaluator) {
          throw new Error('Dense 固定评测器未配置');
        }
        const generationId =
          typeof job.payload.generationId === 'string'
            ? job.payload.generationId
            : job.requiredGenerationId || '';
        if (
          !generationId ||
          generationId !== job.requiredGenerationId ||
          job.payload.datasetSha256 !==
            DENSE_EVALUATION_DATASET_SHA256
        ) {
          throw new Error('Dense 固定评测任务的契约或 affinity 不一致');
        }
        this.assertDenseGenerationScope(
          job,
          generationId,
          'Dense 固定评测 generation',
        );
        const generation =
          this.memoryStore.denseIndexGeneration(generationId);
        if (
          !generation ||
          generation.modelId !== job.requiredModelId
        ) {
          throw new Error('Dense 固定评测任务的 model/generation 不一致');
        }
        const outcome =
          await this.denseEvaluator.evaluateAndActivate({
            generationId,
            userId: job.userId,
            namespace: job.namespace,
          });
        const completed = this.lifecycleStore.completeJob(
          job.id,
          workerId,
        );
        return {
          processed: true,
          job: completed,
          candidateCount: outcome.report.queryCount,
        };
      }
      if (job.jobType === 'retention_sweep') {
        if (!this.governance) {
          throw new Error('记忆治理服务未配置');
        }
        this.governance.runRetentionSweep({
          userId: job.userId,
          namespace: job.namespace,
          at:
            typeof job.payload.at === 'string'
              ? job.payload.at
              : undefined,
        });
        const nextSweepAt = new Date(
          Date.now() + config.retentionSweepHours * 3_600_000,
        ).toISOString();
        this.governance.enqueueRetentionSweep(
          nextSweepAt,
          job.userId,
          job.namespace,
          job.id,
        );
        const completed = this.lifecycleStore.completeJob(
          job.id,
          workerId,
        );
        return {
          processed: true,
          job: completed,
          candidateCount: 0,
        };
      }
      if (job.jobType === 'purge_memory') {
        if (!this.governance) {
          throw new Error('记忆治理服务未配置');
        }
        const requestedPurgeJobId =
          typeof job.payload.purgeJobId === 'string'
            ? job.payload.purgeJobId
            : '';
        if (!requestedPurgeJobId) {
          throw new Error('物理清除任务缺少 purgeJobId');
        }
        const purge = this.governance.getPurgeJob(
          requestedPurgeJobId,
          job.userId,
          job.namespace,
        );
        assertJobTargetOwnership(job, purge, '物理清除记录');
        const payloadMemoryId =
          typeof job.payload.memoryId === 'string'
            ? job.payload.memoryId
            : '';
        if (
          !payloadMemoryId ||
          payloadMemoryId !== purge.memoryId
        ) {
          throw new Error(
            '物理清除任务 memoryId 与清除记录不一致',
          );
        }
        purgeJobId = requestedPurgeJobId;
        this.governance.processPurgeJob(purgeJobId, workerId);
        const completed = this.lifecycleStore.completeJob(
          job.id,
          workerId,
        );
        return {
          processed: true,
          job: completed,
          candidateCount: 0,
        };
      }
      if (job.jobType === 'consolidation_sweep') {
        if (!this.consolidator) {
          throw new Error('记忆巩固器未配置');
        }
        if (
          job.userId !== SYSTEM_JOB_USER_ID ||
          job.namespace !== SYSTEM_JOB_NAMESPACE ||
          !isCanonicalConsolidationSweepJobId(job.id)
        ) {
          throw new Error(
            '全局巩固 sweep 只接受稳定系统所有权的规范任务',
          );
        }
        const scheduledAt =
          typeof job.payload.scheduledAt === 'string'
            ? job.payload.scheduledAt
            : job.availableAt;
        const result = this.lifecycleStore.runConsolidationSweep({
          at: scheduledAt,
          idleMinutes: config.consolidationIdleMinutes,
        });
        const nextBase = Math.max(
          Date.now(),
          Date.parse(scheduledAt),
        );
        const nextSweepAt = new Date(
          nextBase +
          config.consolidationIdleMinutes * 60_000,
        ).toISOString();
        this.lifecycleStore.enqueueConsolidationSweep(
          nextSweepAt,
          job.id,
        );
        const completed = this.lifecycleStore.completeJob(
          job.id,
          workerId,
        );
        return {
          processed: true,
          job: completed,
          candidateCount: result.enqueued,
        };
      }
      if (job.jobType === 'consolidate_memory_change') {
        if (!this.consolidator) {
          throw new Error('记忆巩固器未配置');
        }
        const memoryId =
          typeof job.payload.memoryId === 'string'
            ? job.payload.memoryId
            : '';
        const eventId =
          typeof job.payload.eventId === 'string'
            ? job.payload.eventId
            : job.id;
        if (!memoryId) {
          throw new Error('巩固失效任务缺少 memoryId');
        }
        this.requireOwnedMemory(job, memoryId, '巩固失效记忆');
        this.consolidator.handleMemoryChange(memoryId, eventId);
        const completed = this.lifecycleStore.completeJob(
          job.id,
          workerId,
        );
        return {
          processed: true,
          job: completed,
          candidateCount: 0,
        };
      }
      if (job.jobType === 'consolidate_scope') {
        if (!this.consolidator) {
          throw new Error('记忆巩固器未配置');
        }
        const scope = MemoryConsolidator.scopeFromJobPayload(
          job.payload,
        );
        assertJobTargetOwnership(job, scope, '巩固 scope');
        // session scopeKey is intentionally resolved only together with
        // the asserted userId/namespace inside MemoryConsolidator. Reading
        // an unscoped session merely to validate it would itself expose
        // another account's turns.
        const recoveryStrategy = recoveryDirective?.strategy;
        if (
          recoveryStrategy &&
          ![
            'reload_current_sources_and_recompute',
            'recompute_eligible_clusters_only',
            'single_attempt_protocol_repair',
          ].includes(recoveryStrategy)
        ) {
          throw new Error('巩固 dead letter recovery 策略不受支持');
        }
        const runOptions = recoveryStrategy
          ? { recoveryStrategy }
          : {};
        const fingerprintProvider = this.consolidator as unknown as {
          consolidationInputFingerprint?: (
            scopeValue: typeof scope,
            optionsValue: typeof runOptions,
          ) => string;
        };
        jobInputFingerprint =
          fingerprintProvider.consolidationInputFingerprint?.(
            scope,
            runOptions,
          );
        const result = await this.consolidator.consolidateScope(
          scope,
          runOptions,
        );
        const outputFingerprint = createHash('sha256')
          .update(JSON.stringify({
            status: result.status,
            consolidationId: result.consolidationId,
            memoryId: result.memoryId,
            sourceCount: result.sourceCount,
            sentenceCount: result.sentenceCount,
            unsupportedSentenceCount:
              result.unsupportedSentenceCount,
            noopReason: result.noopReason || null,
          }))
          .digest('hex');
        const completed = this.lifecycleStore.completeJob(
          job.id,
          workerId,
          {
            inputFingerprint:
              result.inputFingerprint || jobInputFingerprint,
            outputFingerprint,
            modelDurationMs:
              result.modelDurationMs ??
              performance.now() - jobStartedAt,
            missingSourceIds: result.missingSourceIds || [],
            compensationAction: result.compensationAction,
            recoveryStrategy: recoveryStrategy || null,
            resultStatus: result.status,
            noopReason: result.noopReason || null,
          },
        );
        return {
          processed: true,
          job: completed,
          candidateCount: result.sentenceCount,
        };
      }
      if (job.jobType === 'resolve_candidate') {
        const candidateId =
          typeof job.payload.candidateId === 'string'
            ? job.payload.candidateId
            : '';
        if (!candidateId) {
          throw new Error('解析任务缺少 candidateId');
        }
        if (!this.candidateResolver) {
          throw new Error('候选解析器未配置');
        }
        const candidate =
          this.lifecycleStore.getCandidate(
            candidateId,
            job.userId,
            job.namespace,
          );
        assertJobTargetOwnership(job, candidate, '候选记忆');
        if (candidate.turnId) {
          const sourceTurn = this.lifecycleStore.getTurn(
            candidate.turnId,
            job.userId,
            job.namespace,
          );
          assertJobTargetOwnership(
            job,
            sourceTurn,
            '候选来源 turn',
          );
        }
        const sourceTurn = candidate.turnId
          ? this.lifecycleStore.getTurn(
              candidate.turnId,
              job.userId,
              job.namespace,
            )
          : null;
        jobInputFingerprint = domainFingerprint({
          contract: 'resolve-candidate-v1',
          candidate: {
            id: candidate.id,
            state: candidate.state,
            candidateOrigin: candidate.candidateOrigin,
            claimFingerprint: candidate.claimFingerprint,
            normalizedHash: candidate.normalizedHash,
            stableKey: candidate.stableKey,
            kind: candidate.kind,
            scopeType: candidate.scopeType,
            scopeKey: candidate.scopeKey,
            sourceAuthority: candidate.sourceAuthority,
            extractorId: candidate.extractorId,
            extractorVersion: candidate.extractorVersion,
          },
          sourceTurn: sourceTurn
            ? {
                id: sourceTurn.id,
                contentHash: contentFingerprint(sourceTurn.content),
              }
            : null,
        });
        const modelStartedAt = performance.now();
        const resolution = await this.candidateResolver.resolve(candidateId);
        const completed = this.lifecycleStore.completeJob(
          job.id,
          workerId,
          {
            inputFingerprint: jobInputFingerprint,
            outputFingerprint: domainFingerprint({
              candidateId: resolution.candidateId,
              state: resolution.state,
              reason: resolution.reason,
              memoryId: resolution.memoryId,
              relation: resolution.relation,
              method: resolution.method,
            }),
            modelDurationMs: Number(
              (performance.now() - modelStartedAt).toFixed(3),
            ),
            resultStatus: 'completed',
          },
        );
        return {
          processed: true,
          job: completed,
          candidateCount: 1,
        };
      }
      if (job.jobType !== 'extract_turn') {
        throw new Error(`不支持的记忆任务：${job.jobType}`);
      }
      const turnId =
        typeof job.payload.turnId === 'string'
          ? job.payload.turnId
          : '';
      const turn = this.lifecycleStore.getTurn(
        turnId,
        job.userId,
        job.namespace,
      );
      if (!turn) throw new Error('提取任务引用的 turn 不存在');
      assertJobTargetOwnership(job, turn, '提取 turn');
      const payloadSessionId =
        typeof job.payload.sessionId === 'string'
          ? job.payload.sessionId
          : '';
      if (
        payloadSessionId &&
        payloadSessionId !== turn.sessionId
      ) {
        throw new Error('提取任务 sessionId 与 turn 不一致');
      }
      const assistantTurnId =
        typeof job.payload.assistantTurnId === 'string'
          ? job.payload.assistantTurnId
          : '';
      if (assistantTurnId) {
        const assistantTurn =
          this.lifecycleStore.getTurn(
            assistantTurnId,
            job.userId,
            job.namespace,
          );
        assertJobTargetOwnership(
          job,
          assistantTurn,
          '助手 turn',
        );
        if (assistantTurn.sessionId !== turn.sessionId) {
          throw new Error('助手 turn 与用户 turn 不属于同一会话');
        }
      }
      jobInputFingerprint = domainFingerprint({
        contract: 'extract-turn-v1',
        turn: {
          id: turn.id,
          sessionId: turn.sessionId,
          role: turn.role,
          contentHash: contentFingerprint(turn.content),
          occurredAt: turn.occurredAt,
          metadataHash: domainFingerprint(turn.metadata),
        },
        model: this.extractor.model,
        promptVersion: this.extractor.promptVersion,
        extractorId: this.extractor.extractorId || null,
        extractorVersion: this.extractor.extractorVersion || null,
      });
      if (turn.metadata.skipAutoExtraction === true) {
        const completed = this.lifecycleStore.completeJob(
          job.id,
          workerId,
          {
            inputFingerprint: jobInputFingerprint,
            outputFingerprint: domainFingerprint({
              status: 'skipped',
              reason: 'skip_auto_extraction',
              candidateCount: 0,
            }),
            modelDurationMs: 0,
            resultStatus: 'skipped',
            noopReason: 'skip_auto_extraction',
          },
        );
        return {
          processed: true,
          job: completed,
          candidateCount: 0,
        };
      }
      extractionRunId = this.lifecycleStore.startExtraction(
        turn.id,
        this.extractor.model,
        this.extractor.promptVersion,
        this.extractor.extractorId,
        this.extractor.extractorVersion,
      );
      const modelStartedAt = performance.now();
      const candidates = await this.extractor.extract(turn);
      const modelDurationMs = Number(
        (performance.now() - modelStartedAt).toFixed(3),
      );
      const persisted = this.lifecycleStore.completeExtraction(
        extractionRunId,
        candidates,
      );
      const completed = this.lifecycleStore.completeJob(
        job.id,
        workerId,
        {
          inputFingerprint: jobInputFingerprint,
          outputFingerprint: domainFingerprint({
            extractionRunId,
            candidateCount: persisted.length,
            candidates: persisted.map((candidate) => ({
              id: candidate.id,
              normalizedHash: candidate.normalizedHash,
              stableKey: candidate.stableKey,
              state: candidate.state,
            })),
          }),
          modelDurationMs,
          resultStatus: 'completed',
        },
      );
      return {
        processed: true,
        job: completed,
        candidateCount: persisted.length,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      if (isBackgroundModelPreempted(error)) {
        if (extractionRunId) {
          this.lifecycleStore.deferExtraction(
            extractionRunId,
            'foreground_activity_during_model',
          );
        }
        for (const batchJob of claimedDenseBatch.slice(1)) {
          const currentBatchJob = this.lifecycleStore.getJob(batchJob.id);
          if (
            currentBatchJob?.status === 'running' &&
            currentBatchJob.leaseOwner === workerId
          ) {
            this.lifecycleStore.deferClaimedJob(
              batchJob.id,
              workerId,
              Math.max(100, config.foregroundQuietMs),
              'foreground_activity_during_model',
            );
          }
        }
        const currentJob = this.lifecycleStore.getJob(job.id);
        if (
          currentJob?.status === 'running' &&
          currentJob.leaseOwner === workerId
        ) {
          const deferred = this.lifecycleStore.deferClaimedJob(
            job.id,
            workerId,
            Math.max(100, config.foregroundQuietMs),
            'foreground_activity_during_model',
          );
          return {
            processed: false,
            job: deferred,
            candidateCount: 0,
          };
        }
        return {
          processed: false,
          job: currentJob,
          candidateCount: 0,
        };
      }
      if (extractionRunId) {
        this.lifecycleStore.failExtraction(
          extractionRunId,
          message,
        );
      }
      if (purgeJobId && this.governance) {
        this.governance.failPurgeJob(
          purgeJobId,
          message,
          workerId,
        );
      }
      const currentJob = this.lifecycleStore.getJob(job.id);
      if (
        !currentJob ||
        currentJob.status !== 'running' ||
        currentJob.leaseOwner !== workerId
      ) {
        return {
          processed: true,
          job: currentJob,
          candidateCount: 0,
          error: message,
        };
      }
      const evidence = jobFailureEvidence(error);
      let failure = classifyMemoryJobFailure(job, message);
      if (recoveryDirective?.mode === 'repair') {
        failure = {
          ...failure,
          retryable: false,
          compensationAction:
            `repair_failed_${recoveryDirective.failureClass || 'unknown'}` +
            '_quarantine',
        };
      }
      for (const batchJob of claimedDenseBatch.slice(1)) {
        const currentBatchJob = this.lifecycleStore.getJob(batchJob.id);
        if (
          currentBatchJob?.status === 'running' &&
          currentBatchJob.leaseOwner === workerId
        ) {
          this.lifecycleStore.failJob(
            batchJob.id,
            workerId,
            message,
            memoryJobRetryDelayMs(batchJob),
            {
              ...classifyMemoryJobFailure(batchJob, message),
              outputFingerprint: evidence.outputFingerprint,
              missingSourceIds: evidence.missingSourceIds,
              modelDurationMs: Number((
                evidence.modelDurationMs ??
                (performance.now() - jobStartedAt)
              ).toFixed(3)),
            },
          );
        }
      }
      const failed = this.lifecycleStore.failJob(
        job.id,
        workerId,
        message,
        memoryJobRetryDelayMs(job),
        {
          ...failure,
          inputFingerprint: jobInputFingerprint,
          outputFingerprint: evidence.outputFingerprint,
          missingSourceIds: evidence.missingSourceIds,
          recoveryStrategy: recoveryDirective?.strategy || null,
          modelDurationMs: Number((
            evidence.modelDurationMs ??
            (performance.now() - jobStartedAt)
          ).toFixed(3)),
        },
      );
      if (reflectionRunId && this.reflectionService) {
        this.reflectionService.markRunFailed(
          reflectionRunId,
          job.userId,
          workerId,
          message,
          failed.status === 'dead',
        );
      }
      return {
        processed: true,
        job: failed,
        candidateCount: 0,
        error: message,
      };
    }
  }
}

export class MemoryWorkerRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private running = false;
  private readonly pollMs: number;

  constructor(
    private readonly worker: MemoryWorker,
    private readonly workerId: string,
    pollMs = config.workerPollMs,
  ) {
    this.pollMs = purgeAwareWorkerPollMs(pollMs);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const result = await this.worker.processNext(
        this.workerId,
        {
          backgroundModelAllowed: backgroundModelWorkAllowed(
            config.foregroundQuietMs,
          ),
        },
      );
      this.schedule(result.processed ? 0 : this.pollMs);
    } catch {
      this.schedule(this.pollMs);
    } finally {
      this.running = false;
    }
  }
}
