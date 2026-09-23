import { createHash } from 'node:crypto';
import { config } from './config.js';
import { tokenOverlap, topicTokenOverlap } from './embedding.js';
import { backgroundModelAbortSignal } from './model-qos.js';

export interface SemanticCandidateEvidence {
  authority: 'direct_user' | 'user_confirmed' | 'assistant' | 'imported' |
    'unknown';
  currentVersion: boolean;
  active: boolean;
  scopeAuthorized: boolean;
  revoked?: boolean;
  forgotten?: boolean;
  occurredAt?: string | null;
  eventType?: string | null;
  entities?: string[];
}

export interface SemanticCandidate {
  id: string;
  kind?: string;
  memory: string;
  evidence?: SemanticCandidateEvidence;
}

export interface SemanticDecision {
  id: string;
  relevant: boolean;
  confidence: number;
  reason: string;
}

export interface SemanticCacheStats {
  rewriteHits: number;
  rewriteSingleFlightShares: number;
  rerankHits: number;
  rerankSingleFlightShares: number;
}

export interface SemanticModelTelemetry {
  totalDurationMs: number | null;
  loadDurationMs: number | null;
  promptEvalCount: number | null;
  promptEvalDurationMs: number | null;
  evalCount: number | null;
  evalDurationMs: number | null;
  thermalState: 'cold' | 'warm' | 'unknown';
}

export interface SemanticOperationTelemetry {
  route: 'deterministic_fast' | 'model' | 'cache';
  providerCalls: number;
  baseProviderCalls?: number;
  firstCandidateConfirmationCalls?: number;
  protocolRecoveryCalls?: number;
  protocolRecoveryMaxDepth?: number;
  parallelBatchCount?: number;
  providerQueueWaitMs?: number;
  providerPeakActive?: number;
  providerMaxConcurrency?: number;
  cacheHit: boolean;
  singleFlightShared: boolean;
  keyFingerprint: string;
  requestDurationMs: number;
  providerDurationMs: number | null;
  model: SemanticModelTelemetry | null;
}

export interface SemanticOperationResult<T> {
  result: T;
  telemetry: SemanticOperationTelemetry;
}

export type SemanticOperationName = 'embed' | 'rewrite' | 'rerank';

export type SemanticOperationFailureCode =
  | 'provider_transport_error'
  | 'provider_http_error'
  | 'provider_protocol_error';

export class SemanticOperationError extends Error {
  constructor(
    message: string,
    readonly operation: SemanticOperationName,
    readonly code: SemanticOperationFailureCode,
    readonly telemetry: SemanticOperationTelemetry,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'SemanticOperationError';
  }
}

export function semanticOperationFailure(
  error: unknown,
): SemanticOperationError | null {
  let current = error;
  const visited = new Set<unknown>();
  while (current && !visited.has(current)) {
    visited.add(current);
    if (current instanceof SemanticOperationError) return current;
    current = current instanceof Error ? current.cause : null;
  }
  return null;
}

export interface SemanticRanker {
  readonly embeddingModel: string;
  readonly rerankModel: string;
  embed(texts: string[]): Promise<Float32Array[]>;
  embedWithTelemetry?(
    texts: string[],
  ): Promise<SemanticOperationResult<Float32Array[]>>;
  rerank(
    query: string,
    candidates: SemanticCandidate[],
  ): Promise<SemanticDecision[]>;
  rewrite?(query: string): Promise<string[]>;
  rerankWithTelemetry?(
    query: string,
    candidates: SemanticCandidate[],
  ): Promise<SemanticOperationResult<SemanticDecision[]>>;
  rewriteWithTelemetry?(
    query: string,
  ): Promise<SemanticOperationResult<string[]>>;
  cacheStats?(): SemanticCacheStats;
}

interface OllamaSemanticRankerOptions {
  baseUrl: string;
  embeddingModel: string;
  rerankModel: string;
  embedBatchSize: number;
  rerankBatchSize: number;
  timeoutMs: number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  rerankConcurrency?: number;
  rerankProviderCallBudget?: number;
  fetchImpl?: typeof fetch;
  // 配置后重排走 cross-encoder sidecar（bge-reranker-v2-m3 等），
  // 确定性预筛/缓存/单飞/遥测外壳全部复用，仅替换"未决候选 → 决策"这一段。
  crossEncoder?: {
    baseUrl: string;
    model: string;
    batchSize: number;
    timeoutMs: number;
    confidenceScale: number;
  };
}

interface OllamaEmbedResponse extends OllamaChatResponse {
  embeddings?: unknown;
}

interface OllamaChatResponse {
  message?: {
    content?: unknown;
  };
  total_duration?: unknown;
  load_duration?: unknown;
  prompt_eval_count?: unknown;
  prompt_eval_duration?: unknown;
  eval_count?: unknown;
  eval_duration?: unknown;
}

interface ProviderOperationResult<T> {
  result: T;
  providerCalls: number;
  providerDurationMs: number;
  modelSamples: SemanticModelTelemetry[];
  baseProviderCalls?: number;
  firstCandidateConfirmationCalls?: number;
  protocolRecoveryCalls?: number;
  protocolRecoveryMaxDepth?: number;
  parallelBatchCount?: number;
  providerQueueWaitMs?: number;
  providerPeakActive?: number;
  providerMaxConcurrency?: number;
}

type RerankProviderCallKind = 'base' | 'recovery';

interface RerankModelCallOptions {
  singleBatch: boolean;
  callKind: RerankProviderCallKind;
  recoveryDepth: number;
  runProviderCall: ProviderCallRunner;
  callBudget: RerankProviderCallBudget;
}

interface RerankModelRootPlan {
  stageEnds?: number[];
}

interface ProviderGateTelemetry {
  queueWaitMs: number;
  peakActive: number;
  maximumConcurrency: number;
}

type ProviderCallRunner = <T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
) => Promise<T>;

interface ProviderGateWaiter {
  resolve: (active: number) => void;
  reject: (reason?: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

class SharedProviderGate {
  private active = 0;
  private readonly waiting: ProviderGateWaiter[] = [];
  private maximum: number;

  constructor(maximumConcurrency: number) {
    this.maximum = maximumConcurrency;
  }

  get maximumConcurrency(): number {
    return this.maximum;
  }

  tightenMaximumConcurrency(maximumConcurrency: number): void {
    this.maximum = Math.min(this.maximum, maximumConcurrency);
  }

  private async acquire(signal: AbortSignal): Promise<number> {
    if (signal.aborted) throw signal.reason;
    if (this.active < this.maximumConcurrency) {
      this.active += 1;
      return this.active;
    }
    return await new Promise<number>((resolve, reject) => {
      const waiter: ProviderGateWaiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private release(): void {
    if (this.active > this.maximumConcurrency) {
      this.active = Math.max(0, this.active - 1);
      return;
    }
    while (this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      next.signal.removeEventListener('abort', next.onAbort);
      if (next.signal.aborted) {
        next.reject(next.signal.reason);
        continue;
      }
      next.resolve(this.active);
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  runner(telemetry: ProviderGateTelemetry): ProviderCallRunner {
    return async <T>(
      operation: () => Promise<T>,
      signal: AbortSignal,
    ): Promise<T> => {
      const queuedAt = performance.now();
      const active = await this.acquire(signal);
      telemetry.queueWaitMs += performance.now() - queuedAt;
      telemetry.peakActive = Math.max(telemetry.peakActive, active);
      try {
        return await operation();
      } finally {
        this.release();
      }
    };
  }
}

const SHARED_RERANK_PROVIDER_GATES = new WeakMap<
  typeof fetch,
  Map<string, SharedProviderGate>
>();

function sharedRerankProviderGate(
  fetchImpl: typeof fetch,
  baseUrl: string,
  model: string,
  maximumConcurrency: number,
): SharedProviderGate {
  let providerGates = SHARED_RERANK_PROVIDER_GATES.get(fetchImpl);
  if (!providerGates) {
    providerGates = new Map();
    SHARED_RERANK_PROVIDER_GATES.set(fetchImpl, providerGates);
  }
  const key = `${baseUrl}\n${model}`;
  const existing = providerGates.get(key);
  if (existing) {
    existing.tightenMaximumConcurrency(maximumConcurrency);
    return existing;
  }
  const created = new SharedProviderGate(maximumConcurrency);
  providerGates.set(key, created);
  return created;
}

class RerankProviderBudgetError extends Error {
  constructor() {
    super('Ollama 重排 provider 调用超过单次逻辑预算');
    this.name = 'RerankProviderBudgetError';
  }
}

class RerankProviderCallBudget {
  private used = 0;

  constructor(readonly maximum: number) {}

  reserve(): void {
    if (this.used >= this.maximum) throw new RerankProviderBudgetError();
    this.used += 1;
  }
}

class ProviderOperationError extends Error {
  readonly baseProviderCalls: number;
  readonly firstCandidateConfirmationCalls: number;
  readonly protocolRecoveryCalls: number;
  readonly protocolRecoveryMaxDepth: number;
  readonly parallelBatchCount: number;
  readonly providerQueueWaitMs: number;
  readonly providerPeakActive: number;
  readonly providerMaxConcurrency: number;

  constructor(
    message: string,
    readonly code: SemanticOperationFailureCode,
    readonly providerCalls: number,
    readonly providerDurationMs: number,
    readonly modelSamples: SemanticModelTelemetry[],
    cause?: unknown,
    callTelemetry: Partial<Pick<
      ProviderOperationResult<unknown>,
      'baseProviderCalls' | 'firstCandidateConfirmationCalls' |
      'protocolRecoveryCalls' | 'protocolRecoveryMaxDepth' |
      'parallelBatchCount' | 'providerQueueWaitMs' |
      'providerPeakActive' | 'providerMaxConcurrency'
    >> = {},
  ) {
    super(message, { cause });
    this.name = 'ProviderOperationError';
    this.baseProviderCalls = callTelemetry.baseProviderCalls || 0;
    this.firstCandidateConfirmationCalls =
      callTelemetry.firstCandidateConfirmationCalls || 0;
    this.protocolRecoveryCalls = callTelemetry.protocolRecoveryCalls || 0;
    this.protocolRecoveryMaxDepth =
      callTelemetry.protocolRecoveryMaxDepth || 0;
    this.parallelBatchCount = callTelemetry.parallelBatchCount || 0;
    this.providerQueueWaitMs = callTelemetry.providerQueueWaitMs || 0;
    this.providerPeakActive = callTelemetry.providerPeakActive || 0;
    this.providerMaxConcurrency = callTelemetry.providerMaxConcurrency || 0;
  }
}

class ProviderCallError extends Error {
  constructor(
    message: string,
    readonly code: SemanticOperationFailureCode,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'ProviderCallError';
  }
}

function providerFailureCode(error: unknown): SemanticOperationFailureCode {
  if (error instanceof ProviderCallError) return error.code;
  if (
    error instanceof RerankProtocolError ||
    error instanceof RerankProviderBudgetError ||
    error instanceof SyntaxError
  ) {
    return 'provider_protocol_error';
  }
  return 'provider_transport_error';
}

function providerOperationError(
  error: unknown,
  providerCalls: number,
  providerStarted: number,
  modelSamples: readonly SemanticModelTelemetry[],
  callTelemetry: Partial<Pick<
    ProviderOperationResult<unknown>,
    'baseProviderCalls' | 'firstCandidateConfirmationCalls' |
    'protocolRecoveryCalls' | 'protocolRecoveryMaxDepth' |
    'parallelBatchCount' | 'providerQueueWaitMs' |
    'providerPeakActive' | 'providerMaxConcurrency'
  >> = {},
): ProviderOperationError {
  if (error instanceof ProviderOperationError) return error;
  return new ProviderOperationError(
    error instanceof Error ? error.message : String(error),
    providerFailureCode(error),
    providerCalls,
    Number((performance.now() - providerStarted).toFixed(3)),
    [...modelSamples],
    error,
    callTelemetry,
  );
}

function semanticOperationError(
  error: unknown,
  operation: SemanticOperationName,
  keyFingerprint: string,
  started: number,
  overrides: Partial<Pick<
    SemanticOperationTelemetry,
    'route' | 'providerCalls' | 'cacheHit' | 'singleFlightShared' |
    'providerDurationMs' | 'model' | 'baseProviderCalls' |
    'firstCandidateConfirmationCalls' | 'protocolRecoveryCalls' |
    'protocolRecoveryMaxDepth' | 'parallelBatchCount' |
    'providerQueueWaitMs' | 'providerPeakActive' |
    'providerMaxConcurrency'
  >> = {},
): SemanticOperationError {
  if (error instanceof SemanticOperationError) return error;
  const provider = error instanceof ProviderOperationError ? error : null;
  const providerCalls = overrides.providerCalls ?? provider?.providerCalls ?? 0;
  return new SemanticOperationError(
    error instanceof Error ? error.message : String(error),
    operation,
    provider?.code || providerFailureCode(error),
    {
      route: overrides.route || (providerCalls > 0 ? 'model' : 'deterministic_fast'),
      providerCalls,
      baseProviderCalls: overrides.baseProviderCalls ??
        provider?.baseProviderCalls,
      firstCandidateConfirmationCalls:
        overrides.firstCandidateConfirmationCalls ??
        provider?.firstCandidateConfirmationCalls,
      protocolRecoveryCalls: overrides.protocolRecoveryCalls ??
        provider?.protocolRecoveryCalls,
      protocolRecoveryMaxDepth: overrides.protocolRecoveryMaxDepth ??
        provider?.protocolRecoveryMaxDepth,
      parallelBatchCount: overrides.parallelBatchCount ??
        provider?.parallelBatchCount,
      providerQueueWaitMs: overrides.providerQueueWaitMs ??
        provider?.providerQueueWaitMs,
      providerPeakActive: overrides.providerPeakActive ??
        provider?.providerPeakActive,
      providerMaxConcurrency: overrides.providerMaxConcurrency ??
        provider?.providerMaxConcurrency,
      cacheHit: overrides.cacheHit || false,
      singleFlightShared: overrides.singleFlightShared || false,
      keyFingerprint,
      requestDurationMs: Number((performance.now() - started).toFixed(3)),
      providerDurationMs: overrides.providerDurationMs ??
        (providerCalls > 0 ? provider?.providerDurationMs ?? null : null),
      model: overrides.model ?? aggregateModelTelemetry(
        provider?.modelSamples || [],
      ),
    },
    error,
  );
}

function durationMs(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Number((parsed / 1_000_000).toFixed(3))
    : null;
}

function tokenCount(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.trunc(parsed)
    : null;
}

function modelTelemetry(
  payload: OllamaChatResponse,
): SemanticModelTelemetry {
  const loadDurationMs = durationMs(payload.load_duration);
  return {
    totalDurationMs: durationMs(payload.total_duration),
    loadDurationMs,
    promptEvalCount: tokenCount(payload.prompt_eval_count),
    promptEvalDurationMs: durationMs(payload.prompt_eval_duration),
    evalCount: tokenCount(payload.eval_count),
    evalDurationMs: durationMs(payload.eval_duration),
    thermalState: loadDurationMs === null
      ? 'unknown'
      : loadDurationMs >= 100 ? 'cold' : 'warm',
  };
}

function aggregateModelTelemetry(
  samples: readonly SemanticModelTelemetry[],
): SemanticModelTelemetry | null {
  if (samples.length === 0) return null;
  const sum = (
    select: (sample: SemanticModelTelemetry) => number | null,
  ): number | null => {
    const values = samples.map(select).filter(
      (value): value is number => value !== null,
    );
    return values.length > 0
      ? Number(values.reduce((total, value) => total + value, 0).toFixed(3))
      : null;
  };
  return {
    totalDurationMs: sum((sample) => sample.totalDurationMs),
    loadDurationMs: sum((sample) => sample.loadDurationMs),
    promptEvalCount: sum((sample) => sample.promptEvalCount),
    promptEvalDurationMs: sum((sample) => sample.promptEvalDurationMs),
    evalCount: sum((sample) => sample.evalCount),
    evalDurationMs: sum((sample) => sample.evalDurationMs),
    thermalState: samples.some((sample) => sample.thermalState === 'cold')
      ? 'cold'
      : samples.every((sample) => sample.thermalState === 'warm')
        ? 'warm'
        : 'unknown',
  };
}

const RERANK_SYSTEM_PROMPT = '你是长期记忆重排器。逐条判断 m（每项为[下标,记忆]）：①主体同一，查询点名人、账户、角色或项目时须同主体；“我/用户”=当前用户，他人、公司、文件、教程、设备、测试数据不算用户事实。②对象、谓词、否定、时间及事实/要求模态一致；接触、拥有、学习≠偏好、身份或习惯。③无需猜测即可直接回答 q。三项全真才选。计划、清单或建议可选直接适用的习惯、工作/沟通偏好或称呼，项目状态不算。允许零项或多项；“怎样/怎么做”须选全并列做法，不强选。只返回 m 相关下标的升序无重复紧凑单行 JSON 整数数组，无相关为[]，不解释。校准：运动偏好×[体育馆地板,运动鞋促销]=>[]；复杂任务起手×[画流程图,列风险,咖啡]=>[0,1]。';

// 知识库版判定 prompt：m 为受控文档片段，q 为口语化提问。
// 与对话版的核心差异：不看主体身份（"文件不算用户事实"不适用），
// 只判内容是否承载回答所需信息，允许多条片段共同回答。
const KB_RERANK_SYSTEM_PROMPT = '你是知识库重排器。m 的每项是[下标,文档片段]，q 是用户口语化提问。逐条判断：该片段是否包含回答 q 所需的信息。片段与 q 的措辞不同但语义对应（同义、近义、更正式的表述）即算匹配；口语俗称对应正式术语也算匹配。只看片段内容本身，不要求片段单独完整回答 q——多个片段可共同支撑答案。片段若只是主题相近但不含 q 所需信息则不选。允许零项或多项。只返回相关下标的升序无重复紧凑单行 JSON 整数数组，无相关为[]，不解释。校准：[年假须提前5个工作日在HR系统发起]×[下周想歇两天咋弄]=>[0]；[报销制度适用范围]×[公司创始人是谁]=>[]。';

function rerankFormat(batchSize: number) {
  return {
    type: 'array',
    items: {
      type: 'integer',
      minimum: 0,
      maximum: batchSize - 1,
    },
    uniqueItems: true,
    maxItems: batchSize,
  } as const;
}

const MAX_RERANK_BATCH_SIZE = 32;
const MAX_RERANK_CONCURRENCY = 2;
const MAX_RERANK_LOGICAL_PROVIDER_CALLS = 6;
const MAX_RERANK_RECOVERY_DEPTH = 1;
const MAX_RERANK_QUERY_CHARS = 2_000;
const MAX_RERANK_MEMORY_CHARS = 2_000;
const MAX_RERANK_BATCH_MEMORY_CHARS = 32_000;

function validateRerankBatchBudget(
  query: string,
  candidates: readonly SemanticCandidate[],
): void {
  if (query.length > MAX_RERANK_QUERY_CHARS) {
    throw new RerankProtocolError('Ollama 重排查询文本超过预算');
  }
  const oversized = candidates.find(
    (candidate) => candidate.memory.length > MAX_RERANK_MEMORY_CHARS,
  );
  if (oversized) {
    throw new RerankProtocolError(
      `Ollama 重排候选文本超过预算：${oversized.id}`,
    );
  }
  const memoryChars = candidates.reduce(
    (total, candidate) => total + candidate.memory.length,
    0,
  );
  if (memoryChars > MAX_RERANK_BATCH_MEMORY_CHARS) {
    throw new RerankProtocolError('Ollama 重排批次候选文本总量超过预算');
  }
}

interface ModelRerankDecision {
  index: number;
  relevant: boolean;
  confidence: number;
  subjectMatch: boolean;
  predicateMatch: boolean;
  entails: boolean;
}

class RerankProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RerankProtocolError';
  }
}

const PERSONAL_RESPONSE_QUERY_PATTERN =
  /(?:(?:用户|我|我的).{0,16}(?:偏好|喜欢|习惯|希望|要求).{0,16}(?:回答|回复|答复|解释|风格|简洁|详细|精炼)|(?:回答|回复|答复).{0,16}(?:偏好|应该|需要|风格|简洁|详细|精炼))/u;
const PERSONAL_RESPONSE_MEMORY_PATTERN =
  /(?:(?:用户|我|我的).{0,16}(?:回答|回复|答复).{0,16}(?:偏好|喜欢|希望|要求|简洁|详细|精炼)|(?:回答|回复|答复).{0,12}(?:保持|应该|需要|必须|要(?!求)))/u;
const DIRECT_PERSONAL_RESPONSE_MEMORY_PATTERN =
  /(?:(?:用户|我|我的).{0,16}(?:回答|回复|答复).{0,16}(?:偏好|喜欢|希望|要求).{0,16}(?:简洁|简短|精炼|直接|详细|完整|示例|结论|依据)|(?:回答|回复|答复).{0,16}(?:保持|应该|需要|必须|要(?!求)).{0,16}(?:简洁|简短|精炼|直接|详细|完整|示例|结论|依据))/u;
const ARTIFACT_STATE_MEMORY_PATTERN =
  /(?:项目|文件|文档|报告|总结|教程|手册|仓库|代码|版本|数据集).{0,32}(?:归档|保存|更新|发布|完成|存在|删除|生成|精炼版|打包|编译|构建)/u;
const USER_PROFILE_QUERY_PATTERN =
  /(?:用户|我|我的|本人).{0,24}(?:住址|地址|工作|职业|宠物|喜欢|偏好|常用|回复语言|回答语言|时区|居住|过敏|上班|饮食|界面|主题)/u;
const EXTERNAL_CONTEXT_MEMORY_PATTERN =
  /(?:公司|分公司|招聘|职位|商店|超市|咖啡店|宠物店|餐厅|食堂|办公(?:室|区|楼)|会议室|例会室|茶水间|插件(?:市场|服务器)|教程|课程|手册|仓库|测试环境|预发布环境|翻译文件|本地化资源|样例记录|设备|维修|检修|维护|故障|原料|机场|园区|游戏|另一个团队|其他团队|别的团队|小区门卫|采购|主题包|依赖库|机房|客户端|促销|翻修|搬迁|扩容|空调)/u;
const EXPLICIT_EXTERNAL_SUBJECT_PATTERN =
  /^(?:公司|分公司|招聘|商店|超市|咖啡店|宠物店|餐厅|食堂|办公(?:室|区|楼)|会议室|例会室|茶水间|插件|教程|课程|手册|仓库|测试环境|预发布环境|机场|园区|某游戏|另一个团队|其他团队|别的团队|小区门卫|机房|客户端)/u;
const EXPLICIT_THIRD_PARTY_PERSON_PATTERN =
  /^((?:姐姐|妹妹|哥哥|弟弟|父亲|母亲|爸爸|妈妈|同学|同事|朋友|室友|客户|甲方|乙方|老板|导师|老师|医生|邻居|队友|[\p{Script=Han}]{1,3}(?:总|工|老师|经理|医生)))(?=的|现在|目前|当前|平常|通常|日常|常用|最喜欢|喜欢|住|居住|是|叫|例会|会议|同步会)/u;

function explicitThirdPartyPerson(memory: string): string | null {
  return memory.match(EXPLICIT_THIRD_PARTY_PERSON_PATTERN)?.[1] || null;
}
const PERSONALIZED_SYNTHESIS_QUERY_PATTERN =
  /(?:(?:根据|结合).{0,20}(?:长期|了解|记忆|习惯|偏好).{0,24}(?:安排|计划|建议|清单)|(?:个性化|懂我).{0,16}(?:安排|计划|建议|清单)|(?:我的|用户).{0,12}(?:习惯|偏好).{0,16}(?:安排|计划|建议|清单))/u;
const USER_PROFILE_PREDICATE_PATTERN =
  /(?:习惯|偏好|饮品|饮食|作息|决策|优先|排序|工作方式|任务安排|回答方式|回复方式|沟通方式|称呼|清单)/u;
const ROLE_PROFILE_PREDICATE_PATTERN =
  /(?:回答方式|回复方式|沟通方式|称呼)/u;
const ROLE_ADDRESS_QUERY_PATTERN =
  /(?:你|这个角色|该角色).{0,24}(?:称呼|叫).{0,6}(?:我|用户)/u;
const ROLE_ADDRESS_PREDICATE_PATTERN =
  /(?:角色)?称呼|昵称|叫法/u;

interface DirectFactRule {
  name: string;
  query: RegExp;
  memory: RegExp;
}

const DIRECT_FACT_RULES: readonly DirectFactRule[] = [
  {
    name: 'drink_modifier',
    query: /(?:喝|饮用).{0,12}(?:加不加|是否加|糖|蜂蜜)/u,
    memory: /(?:喝|饮用).{0,20}(?:不加|无糖|不放|只喝).{0,12}(?:糖|蜂蜜|咖啡|茶)/u,
  },
  {
    name: 'residence',
    query: /(?:住在哪|居住(?:城市|地点|哪里)|(?:家庭|当前|目前)?住址(?:是什么|在哪里)?)/u,
    memory: /(?:目前|当前|现在)?(?:居住|住)在.{1,24}/u,
  },
  {
    name: 'occupation',
    query: /(?:从事什么|做什么)(?:工作|职业)|(?:工作|职业)(?:是什么|是做什么|为哪种)/u,
    memory: /(?:(?:当前|现在|目前).{0,8}(?:工作|职业).{0,6}(?:是|为)|现在是一名|目前是一名)/u,
  },
  {
    name: 'pet_name',
    query: /(?:宠物|猫|狗).{0,8}(?:叫什?么|名字)/u,
    memory: /(?:宠物|猫|狗).{0,12}(?:名叫|名字是|叫).{1,16}/u,
  },
  {
    name: 'empty_first_run',
    query: /(?:首次|初次|第一次).{0,16}(?:启动|打开).{0,16}(?:数据|记录|预置)/u,
    memory: /(?:首次|初次|第一次).{0,16}(?:启动|打开).{0,16}(?:必须|应该|要求).{0,16}(?:空数据|零记录|无记录|不预置|不要预置)/u,
  },
  {
    name: 'favorite_item',
    query: /(?:最喜欢|最偏爱|最爱|偏爱).{0,16}(?:甜点|水果|编程语言)/u,
    memory: /(?:最喜欢|最偏爱|最爱|偏爱).{0,20}(?:甜点|水果|编程语言).{0,8}(?:是|为)/u,
  },
  {
    name: 'editor',
    query: /(?:常用|主要用|日常主要用).{0,12}(?:IDE|编辑器)|(?:IDE|编辑器).{0,12}(?:哪个|什么)/iu,
    memory: /(?:常用|主要使用|日常主要使用|默认使用).{0,20}(?:IDE|编辑器|VS\s*Code|Rider|IntelliJ|WebStorm|Vim|Neovim|Emacs)/iu,
  },
  {
    name: 'response_language',
    query: /(?:回复|回答|答复).{0,12}语言|使用什么语言(?:回复|回答|答复)/u,
    memory: /(?:要求|希望|偏好).{0,16}(?:回复|回答|答复).{0,16}(?:使用|用).{0,12}(?:中文|英文|法语|日语|德语|西班牙语|语言)/u,
  },
  {
    name: 'transport_preference',
    query: /(?:出行|出差|通勤).{0,16}(?:交通|方式|优先|首选)/u,
    memory: /(?:出行|出差|通勤).{0,20}(?:优先|首选).{0,12}(?:乘坐|选择|骑|开|步行)/u,
  },
  {
    name: 'daily_time',
    query: /(?:几点|什么时间).{0,12}(?:起床|上班|开始办公)|(?:起床|上班).{0,12}(?:几点|什么时间)/u,
    memory: /(?:早上|上午|下午|晚上|每天).{0,12}(?:[零〇一二两三四五六七八九十百千万\d]{1,6}点|[零〇一二两三四五六七八九十百千万\d]{1,6}时).{0,12}(?:起床|上班|开始办公)/u,
  },
  {
    name: 'allergy',
    query: /(?:饮食|吃|食用).{0,16}(?:避开|避免|不能|过敏)|(?:过敏|避开).{0,12}(?:坚果|海鲜|食物)/u,
    memory: /(?:对.{1,16}(?:严重)?过敏|不能吃.{1,16}|食用.{1,16}会过敏)/u,
  },
  {
    name: 'interface_preference',
    query: /(?:界面|外观|主题).{0,16}(?:偏好|喜欢|是否)|(?:高对比度|深色|夜间).{0,12}(?:界面|主题)/u,
    memory: /(?:明确)?(?:偏好|喜欢|采用|使用).{0,16}(?:高对比度|深色模式|夜间主题)/u,
  },
  {
    name: 'timezone',
    query: /(?:时区|UTC\s*偏移)/iu,
    memory: /(?:使用|所在|时区是).{0,12}(?:[A-Za-z_]+\/[A-Za-z_]+|UTC[+-]?\d{0,2})|(?:时区是|使用).{0,12}时区/u,
  },
  {
    name: 'answer_example',
    query: /(?:回答|回复|答复).{0,12}(?:需要|应该|要不要).{0,8}(?:示例|例子)/u,
    memory: /(?:希望|要求).{0,16}(?:回答|回复|答复).{0,16}(?:附带|包含|给出).{0,8}(?:示例|例子)/u,
  },
  {
    name: 'technology_stack',
    query: /(?:服务|后端).{0,16}(?:技术栈|技术|使用什么|采用什么)/u,
    memory: /(?:服务|后端).{0,24}(?:使用|采用|基于).{0,32}(?:和|与|、|\+).{0,24}/u,
  },
  {
    name: 'meeting_time',
    query: /(?:例会|同步会|会议).{0,12}(?:时间|什么时候|几点|安排)/u,
    memory: /(?:(?:例会|同步会|会议).{0,20}(?:固定|安排|召开|定在).{0,20}(?:每周|上午|下午|晚上|点)|(?:每周|上午|下午|晚上|点).{0,20}(?:召开|安排|定在).{0,8}(?:例会|同步会|会议))/u,
  },
  {
    name: 'office_location',
    query: /(?:办公|工作)(?:地点|位置|在哪里)/u,
    memory: /(?:固定|目前|当前).{0,8}(?:在.{1,20}(?:办公|工作)|办公地点是.{1,20})/u,
  },
  {
    name: 'activity_audio',
    query: /(?:跑步|运动).{0,12}(?:听什么|喜欢听)/u,
    memory: /(?:跑步|运动).{0,16}(?:习惯|喜欢).{0,8}听.{1,16}/u,
  },
];

interface AtomicMemoryClaim {
  subject: string;
  predicate: string;
  value: string;
  negated: boolean;
}

interface AtomicProfileFactRule {
  name: string;
  query: RegExp;
  predicate: RegExp;
}

const ATOMIC_PROFILE_FACT_RULES: readonly AtomicProfileFactRule[] = [
  {
    name: 'favorite_drink',
    query:
      /^(?:(?:(?:平时|通常)?我|用户|本人).{0,12}(?:最常|常)?(?:喝|饮用).{0,8}(?:什么|哪种)|(?:最常|常)喝.{0,8}(?:什么|哪种)|饮品.{0,8}(?:偏好|什么|哪种)|(?:平时|通常)?.{0,4}(?:给我|替我).{0,6}(?:点|选|推荐).{0,4}(?:饮料|饮品).{0,8}(?:优先|首选).{0,6}(?:什么|哪种)|(?:我|用户|本人).{0,8}(?:最常|常)(?:喝|饮用).{1,24}(?:吗|是否|是不是))/u,
    predicate:
      /(?:饮品|喝|饮用|点单时的首选茶|首选(?:茶|饮料))/u,
  },
  {
    name: 'occupation',
    query:
      /^(?:我|用户|本人)(?:的|目前|现在)?.{0,8}(?:职业|工作)(?:背景)?.{0,8}(?:是什么|是做什么|做什么|哪种)/u,
    predicate: /(?:职业|工作|职位|职务)/u,
  },
  {
    name: 'temporary_accommodation',
    query:
      /^(?:我|用户|本人).{0,20}(?:(?:临时|这次)出差|住宿|旅店|酒店|公寓|宾馆|民宿).{0,20}(?:住在哪里|住哪|地点|哪里|还有效|仍然有效|是否有效|有效吗|还算数)/u,
    predicate: /(?:临时)?住宿地点/u,
  },
  {
    name: 'home_city',
    query:
      /^(?:我|用户|本人).{0,8}(?:长期|目前|现在)?(?:生活|居住|住).{0,8}(?:在哪个|在哪座|在什么|在哪里|城市是什么|城市是哪里)/u,
    predicate:
      /(?:长期|目前|当前)?(?:生活|居住)(?:城市|地点)|(?:长期|目前|当前)?(?:居住|常住)(?:地|城市)|(?:家乡|所在城市)/u,
  },
  {
    name: 'food_aversion',
    query:
      /^(?:(?:给我|为我).{0,8}(?:推荐|选择).{0,8}(?:吃的|食物|菜).{0,8}(?:时|时候)?.{0,6}(?:要)?(?:避开|避免|忌口|不能吃).{0,6}(?:什么|哪些)|(?:我|用户|本人).{0,8}(?:饮食|吃东西).{0,8}(?:忌口|避开|避免|不能吃).{0,6}(?:什么|哪些))/u,
    predicate:
      /(?:饮食|食物).*(?:忌口|禁忌|避开|避免)|(?:忌口|禁忌|过敏|饮食偏好|推荐餐食规则)/u,
  },
  {
    name: 'learning_goal',
    query:
      /^(?:我|用户|本人).{0,8}(?:今年|长期)?.{0,6}(?:想|要|计划)?(?:学成|学会|学习目标).{0,6}(?:什么|哪些)/u,
    predicate: /(?:长期)?(?:学习|进修).*(?:目标|计划)|长期学习目标/u,
  },
  {
    name: 'commute_mode',
    query:
      /^(?:(?:(?:工作日|平时|通常)?我|用户|本人).{0,10}(?:怎么|如何|以什么方式).{0,6}(?:通勤|上班)|(?:怎么|如何).{0,6}通勤|通勤.{0,8}(?:方式|交通|怎么|如何))/u,
    predicate: /(?:通勤|上班).*(?:方式|交通)?/u,
  },
  {
    name: 'editor',
    query:
      /^(?:(?:我|用户|本人).{0,8})?(?:现在)?(?:常用|主要用|日常主要用).{0,12}(?:IDE|编辑器)|^(?:我|用户|本人)?(?:现在)?(?:IDE|编辑器).{0,12}(?:哪个|什么)/iu,
    predicate: /(?:IDE|编辑器)/iu,
  },
  {
    name: 'response_style',
    query:
      /^(?:(?:(?:当前角色|这个角色|该角色|角色)(?!项目|系统|产品|文件|文档)|我|用户|本人).{0,16}(?:回复|回答|答复).{0,12}(?:组织|方式|风格|要求)|(?:当前角色|这个角色|该角色|角色)(?!项目|系统|产品|文件|文档).{0,16}(?:怎样|如何|应该).{0,8}(?:组织|安排).{0,6}(?:回复|回答|答复)|(?:当前角色|这个角色|该角色|角色)(?!项目|系统|产品|文件|文档).{0,12}(?:是否|是不是)?(?:要求|希望).{1,48}[?？]?$)/u,
    predicate:
      /(?:回复|回答|答复|沟通).*(?:组织|方式|风格|要求)|(?:与特定角色交流规则|角色专属规则)/u,
  },
];

export function deterministicAtomicProfileQueryRule(
  query: string,
): string | null {
  const normalizedQuery = query.normalize('NFKC').trim();
  return ATOMIC_PROFILE_FACT_RULES.find((candidate) =>
    candidate.query.test(normalizedQuery)
  )?.name || null;
}

export function deterministicAtomicProfilePredicateMatches(
  query: string,
  predicate: string,
): boolean {
  const normalizedQuery = query.normalize('NFKC').trim();
  const rule = ATOMIC_PROFILE_FACT_RULES.find((candidate) =>
    candidate.query.test(normalizedQuery)
  );
  return Boolean(rule?.predicate.test(predicate.normalize('NFKC').trim()));
}

function atomicMemoryClaim(memory: string): AtomicMemoryClaim | null {
  const lines = memory
    .split(/\r?\n/u)
    .filter((value) => value.startsWith('atomic-memory-v1:'));
  for (const line of lines) {
    try {
      const parsed = JSON.parse(
        line.slice('atomic-memory-v1:'.length),
      ) as Record<string, unknown>;
      if (
        typeof parsed.subject !== 'string' ||
        typeof parsed.predicate !== 'string'
      ) {
        continue;
      }
      return {
        subject: parsed.subject.normalize('NFKC').trim(),
        predicate: parsed.predicate.normalize('NFKC').trim(),
        value: typeof parsed.value === 'string'
          ? parsed.value.normalize('NFKC').trim()
          : '',
        negated: parsed.negated === true,
      };
    } catch {
      continue;
    }
  }
  return null;
}

function providerAtomicMemory(memory: string): string {
  const prefix = 'atomic-memory-v1:';
  if (!memory.startsWith(prefix) || /[\r\n]/u.test(memory)) return memory;
  try {
    const parsed = JSON.parse(memory.slice(prefix.length)) as
      Record<string, unknown>;
    if (
      typeof parsed.subject !== 'string' ||
      typeof parsed.predicate !== 'string' ||
      typeof parsed.value !== 'string' ||
      typeof parsed.negated !== 'boolean'
    ) {
      return memory;
    }
    const canonical = prefix + JSON.stringify({
      subject: parsed.subject,
      predicate: parsed.predicate,
      value: parsed.value,
      negated: parsed.negated,
    });
    if (memory !== canonical) return memory;
    return `原子${JSON.stringify({
      主体: parsed.subject,
      谓词: parsed.predicate,
      值: parsed.value,
      否定: parsed.negated,
    })}`;
  } catch {
    return memory;
  }
}

function atomicProfilePredicateMatches(
  rule: AtomicProfileFactRule,
  claim: AtomicMemoryClaim,
): boolean {
  if (!rule.predicate.test(claim.predicate)) return false;
  if (
    rule.name === 'food_aversion' &&
    /^(?:饮食偏好|推荐餐食规则)$/u.test(claim.predicate)
  ) {
    return /(?:不吃|不要|不能吃|避开|避免|忌口|过敏)/u.test(
      claim.value,
    );
  }
  return true;
}

function atomicProfilePredicateDisposition(
  rule: AtomicProfileFactRule,
  claim: AtomicMemoryClaim,
): 'match' | 'known_mismatch' | 'unknown' {
  if (atomicProfilePredicateMatches(rule, claim)) return 'match';
  if (rule.predicate.test(claim.predicate)) return 'unknown';
  const matchesAnotherKnownRule = ATOMIC_PROFILE_FACT_RULES.some(
    (candidate) =>
      candidate !== rule && atomicProfilePredicateMatches(candidate, claim),
  );
  return matchesAnotherKnownRule ? 'known_mismatch' : 'unknown';
}

function accommodationEntities(value: string): string[] {
  const normalized = value.normalize('NFKC').trim();
  const contextual = [
    ...normalized.matchAll(
      /(?:说的|住在|入住|暂住|住|选择|是)([\p{Script=Han}A-Za-z0-9_-]{2,12}?(?:旅店|酒店|公寓|宾馆|民宿))/gu,
    ),
  ].map((match) => match[1]);
  const standalone = normalized.match(
    /^([\p{Script=Han}A-Za-z0-9_-]{2,12}(?:旅店|酒店|公寓|宾馆|民宿))$/u,
  )?.[1];
  return [...new Set([...contextual, ...(standalone ? [standalone] : [])])];
}

function atomicProfileValueMatches(
  query: string,
  claim: AtomicMemoryClaim,
  ruleName: string,
): boolean {
  if (query.includes(claim.value)) return true;
  if (ruleName === 'temporary_accommodation') {
    const queryEntities = new Set(accommodationEntities(query));
    return accommodationEntities(claim.value).some((entity) =>
      queryEntities.has(entity)
    );
  }
  if (ruleName === 'response_style') {
    const requested = query.match(
      /(?:要求|希望)(.+?)(?:吗|[?？])?$/u,
    )?.[1];
    const compactRequested = requested
      ? compactEvidenceText(requested)
      : '';
    return compactRequested.length >= 4 &&
      compactEvidenceText(claim.value).includes(compactRequested);
  }
  return false;
}

function deterministicAtomicProfileFactDecision(
  query: string,
  memory: string,
): Omit<SemanticDecision, 'id'> | null {
  const normalizedQuery = query.normalize('NFKC').trim();
  const ruleName = deterministicAtomicProfileQueryRule(normalizedQuery);
  const rule = ruleName
    ? ATOMIC_PROFILE_FACT_RULES.find((candidate) =>
        candidate.name === ruleName
      )
    : null;
  if (!rule) return null;
  const claim = atomicMemoryClaim(memory);
  if (
    !claim ||
    !/^(?:用户|我|本人)$/u.test(claim.subject) ||
    profileConditionConflicts(normalizedQuery, claim.predicate)
  ) {
    return null;
  }
  const predicateDisposition = atomicProfilePredicateDisposition(rule, claim);
  if (predicateDisposition === 'unknown') return null;
  const predicateMatches = predicateDisposition === 'match';
  if (predicateMatches && claim.negated) return null;
  const verifiesSpecificValue =
    /(?:是否|是不是|还有效|仍然有效|还算数)/u.test(
      normalizedQuery,
    ) || /(?:吗|是么)[？?]?$/u.test(normalizedQuery);
  const valueMatches = !verifiesSpecificValue ||
    atomicProfileValueMatches(normalizedQuery, claim, rule.name);
  return {
    relevant: predicateMatches && valueMatches,
    confidence: predicateMatches && valueMatches ? 0.95 : 1,
    reason: predicateMatches && !valueMatches
      ? `deterministic_atomic_profile_value_mismatch:${rule.name}`
      : predicateMatches
      ? `deterministic_atomic_profile_fact_match:${rule.name}`
      : `deterministic_predicate_mismatch:atomic_profile_${rule.name}`,
  };
}

function verificationEvidencePhrase(query: string): string | null {
  const normalized = query.normalize('NFKC').trim();
  const match = normalized.match(
    /^(?:我|用户|本人)(?:(?:是不是|是否)(?:曾经)?(?:要求|希望)(?:你)?|(?:有没有|是否)(?:曾经)?说过)(.+?)(?:吗)?[？?]?$/u,
  );
  return match?.[1]?.trim() || null;
}

function compactEvidenceText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function directUserEvidenceText(memory: string): string | null {
  const evidence = memory
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match = line.normalize('NFKC').trim().match(
        /^(?:用户原话|用户说)[：:]\s*(.+)$/u,
      );
      return match?.[1]?.trim() ? [match[1].trim()] : [];
    });
  return evidence.length > 0 ? evidence.join('\n') : null;
}

const CHRONOLOGICAL_MULTI_EVENT_QUERY_PATTERN =
  /(?:(?:前后|先后).{0,6}(?:两|二|2)次|(?:两|二|2)次.{0,8}(?:分别|各自))/u;
const CHRONOLOGICAL_LATEST_EVENT_QUERY_PATTERN =
  /最近(?:的)?(?:一|这)次/u;
const CHRONOLOGICAL_SCENE_ANCHOR_PATTERN =
  /(?:书店|咖啡馆|咖啡店|餐厅|饭店|食堂|健身房|电影院|医院|诊所|超市|商场|公园|博物馆|图书馆|旅店|酒店|公寓|宾馆|民宿|办公室|公司|学校|车站|机场)/gu;

function trustedCurrentUserEvidence(
  candidate: SemanticCandidate,
): boolean {
  const evidence = candidate.evidence;
  return Boolean(
    evidence &&
      (evidence.authority === 'direct_user' ||
        evidence.authority === 'user_confirmed') &&
      evidence.currentVersion === true &&
      evidence.active === true &&
      evidence.scopeAuthorized === true &&
      evidence.revoked !== true &&
      evidence.forgotten !== true,
  );
}

interface TrustedEventMetadata {
  occurredAtMs: number;
  eventType: string;
  entities: string[];
}

function trustedEventMetadata(
  candidate: SemanticCandidate,
): TrustedEventMetadata | null {
  if (!trustedCurrentUserEvidence(candidate)) return null;
  const occurredAt = candidate.evidence?.occurredAt;
  const eventType = candidate.evidence?.eventType?.normalize('NFKC').trim();
  const entities = candidate.evidence?.entities
    ?.map((value) => value.normalize('NFKC').trim())
    .filter(Boolean) || [];
  const occurredAtMs = typeof occurredAt === 'string'
    ? Date.parse(occurredAt)
    : Number.NaN;
  return Number.isFinite(occurredAtMs) && eventType && entities.length > 0
    ? { occurredAtMs, eventType, entities }
    : null;
}

function chronologicalSceneAnchors(query: string): string[] {
  return [...new Set(
    query.normalize('NFKC').match(CHRONOLOGICAL_SCENE_ANCHOR_PATTERN) || [],
  )];
}

function eventMatchesScene(
  event: TrustedEventMetadata,
  anchors: readonly string[],
): boolean {
  return anchors.length > 0 && anchors.every((anchor) =>
    event.entities.some((entity) => entity.includes(anchor)) ||
    event.eventType.includes(anchor)
  );
}

function questionLikeUserEvidence(value: string): boolean {
  const normalized = value.normalize('NFKC').trim();
  return /[?？]/u.test(normalized) ||
    /(?:叫什么|什么来着|哪(?:家|个|里|儿)|是否|是不是|有没有|怎么|如何|吗|是么)[。！!]*$/u.test(
      normalized,
    );
}

function deterministicChronologicalEventDecision(
  query: string,
  candidate: SemanticCandidate,
  visibleCandidates: readonly SemanticCandidate[],
): Omit<SemanticDecision, 'id'> | null {
  const normalizedQuery = query.normalize('NFKC').trim();
  const multiEvent = CHRONOLOGICAL_MULTI_EVENT_QUERY_PATTERN.test(
    normalizedQuery,
  );
  const latestEvent = CHRONOLOGICAL_LATEST_EVENT_QUERY_PATTERN.test(
    normalizedQuery,
  );
  if (!multiEvent && !latestEvent) {
    return null;
  }
  const evidence = directUserEvidenceText(candidate.memory);
  if (!evidence) return null;
  if (questionLikeUserEvidence(evidence)) {
    return {
      relevant: false,
      confidence: 1,
      reason: 'deterministic_chronological_event_mismatch',
    };
  }
  const event = trustedEventMetadata(candidate);
  const anchors = chronologicalSceneAnchors(normalizedQuery);
  if (!event || anchors.length === 0) return null;
  if (!eventMatchesScene(event, anchors)) {
    return {
      relevant: false,
      confidence: 1,
      reason: 'deterministic_chronological_event_scene_mismatch',
    };
  }
  const overlap = Math.max(
    tokenOverlap(normalizedQuery, evidence),
    topicTokenOverlap(normalizedQuery, evidence),
  );
  if (latestEvent) {
    const latestOccurredAt = visibleCandidates
      .map((item) => trustedEventMetadata(item))
      .filter((item): item is TrustedEventMetadata =>
        Boolean(item && eventMatchesScene(item, anchors))
      )
      .reduce(
        (latest, item) => Math.max(latest, item.occurredAtMs),
        Number.NEGATIVE_INFINITY,
      );
    if (event.occurredAtMs < latestOccurredAt) {
      return {
        relevant: false,
        confidence: 1,
        reason: 'deterministic_chronological_event_not_latest',
      };
    }
  }
  if (latestEvent && overlap >= 0.25) {
    return {
      relevant: true,
      confidence: 0.95,
      reason: 'deterministic_latest_event_match',
    };
  }
  if (latestEvent && overlap >= 0.18) return null;
  if (multiEvent && overlap < 0.12) return null;
  const relevant = multiEvent;
  return {
    relevant,
    confidence: relevant ? 0.95 : 1,
    reason: relevant
      ? 'deterministic_chronological_event_match'
      : 'deterministic_chronological_event_mismatch',
  };
}

function deterministicDirectVerificationMatch(
  query: string,
  phrase: string,
  evidence: string,
): boolean {
  if (questionLikeUserEvidence(evidence)) return false;
  const compactPhrase = compactEvidenceText(phrase);
  const compactEvidence = compactEvidenceText(evidence);
  if (compactPhrase.length < 4) return false;
  const matchIndex = compactEvidence.indexOf(compactPhrase);
  if (matchIndex < 0) return false;
  const prefix = compactEvidence.slice(0, matchIndex);
  const suffix = compactEvidence.slice(matchIndex + compactPhrase.length);
  if (
    /(?:没有|从未|不曾|不要求|不需要|不要|无需|停止|取消|撤销|废止|作废)/u.test(prefix) ||
    /(?:不用这样|不再|停止|取消|撤销|废止|作废)/u.test(suffix)
  ) {
    return false;
  }
  const historical = /(?:曾经|以前|过去)/u;
  return !historical.test(query) && !historical.test(prefix);
}

function verificationCandidatePriority(candidate: SemanticCandidate): number {
  if (trustedCurrentUserEvidence(candidate)) return 3;
  if (directUserEvidenceText(candidate.memory)) return 2;
  const claim = atomicMemoryClaim(candidate.memory);
  if (claim && /^(?:用户|我|本人)$/u.test(claim.subject)) return 3;
  return candidate.memory
      .split(/\r?\n/u)
      .some((line) =>
        /^(?:用户|我|本人)(?:偏好|要求|希望|习惯|通常|当前|现在|明确|曾经|说过)/u.test(
          line.normalize('NFKC').trim(),
        )
      )
    ? 1
    : 0;
}

function verificationCandidateOverlap(
  phrase: string,
  memory: string,
): number {
  return Math.max(
    tokenOverlap(phrase, memory),
    topicTokenOverlap(phrase, memory),
  );
}

const EXPLICIT_NON_EVIDENCE_MEMORY_PATTERN =
  /(?:只是(?:路过|顺手|今天|这次)|暂时没有打算|目前不需要把它当作偏好|没有形成(?:明确|长期)|过后没有继续关注|当天就已经结束|没有参与后续|和当前项目没有直接关系|没有由此改变原来的计划|不代表我|不影响后面|不是重复发生|没有延续到第二天|不用根据它推断)/u;

function deterministicVerificationEvidenceDecision(
  query: string,
  candidate: SemanticCandidate,
): Omit<SemanticDecision, 'id'> | null {
  const { memory } = candidate;
  const phrase = verificationEvidencePhrase(query);
  if (!phrase) return null;
  const directEvidence = directUserEvidenceText(memory);
  if (
    directEvidence &&
    deterministicDirectVerificationMatch(query, phrase, directEvidence)
  ) {
    return {
      relevant: true,
      confidence: 0.95,
      reason: 'deterministic_verification_direct_evidence',
    };
  }
  const evidenceText = directEvidence || memory;
  const overlap = verificationCandidateOverlap(phrase, evidenceText);
  if (
    topicTokenOverlap(phrase, evidenceText) === 0 &&
    EXPLICIT_NON_EVIDENCE_MEMORY_PATTERN.test(evidenceText)
  ) {
    return {
      relevant: false,
      confidence: 1,
      reason: 'deterministic_verification_no_direct_evidence',
    };
  }
  if (verificationCandidatePriority(candidate) > 0) return null;
  if (overlap >= 0.18) return null;
  return {
    relevant: false,
    confidence: 1,
    reason: 'deterministic_verification_no_direct_evidence',
  };
}

const MAX_VERIFICATION_MODEL_CANDIDATES = 4;

function verificationModelStageEnds(
  candidateCount: number,
  trustedCandidateCount: number,
): number[] {
  if (candidateCount <= 0) return [];
  const firstStage = Math.min(
    candidateCount,
    Math.max(MAX_VERIFICATION_MODEL_CANDIDATES, trustedCandidateCount),
  );
  return [...new Set(
    [firstStage, 16, 32, candidateCount]
      .map((value) => Math.min(candidateCount, Math.max(firstStage, value)))
      .filter((value) => value > 0),
  )].sort((left, right) => left - right);
}

function profileConditionConflicts(
  query: string,
  predicate: string,
): boolean {
  const qualifier = predicate.match(/\[条件:([^\]]+)\]/u)?.[1] || '';
  if (!qualifier) return false;
  const normalizedQuery = query.normalize('NFKC');
  if (
    /(?:早上|早晨|上午|morning)/iu.test(normalizedQuery) &&
    /(?:下午|晚上|夜间|深夜|afternoon|evening|night)/iu.test(qualifier)
  ) {
    return true;
  }
  if (
    /(?:下午|晚上|夜间|深夜|afternoon|evening|night)/iu.test(
      normalizedQuery,
    ) &&
    /(?:清晨|早上|早晨|上午|morning)/iu.test(qualifier)
  ) {
    return true;
  }
  if (
    /(?:工作日|平日|weekday)/iu.test(normalizedQuery) &&
    /(?:周末|weekend)/iu.test(qualifier)
  ) {
    return true;
  }
  if (
    /(?:周末|weekend)/iu.test(normalizedQuery) &&
    /(?:工作日|平日|weekday)/iu.test(qualifier)
  ) {
    return true;
  }
  return false;
}

export function deterministicSynthesisRelevance(
  query: string,
  memory: string,
): string | null {
  const normalizedQuery = query.normalize('NFKC');
  if (!PERSONALIZED_SYNTHESIS_QUERY_PATTERN.test(normalizedQuery)) {
    return null;
  }
  const claim = atomicMemoryClaim(memory);
  if (!claim || profileConditionConflicts(query, claim.predicate)) {
    return null;
  }
  const userProfile =
    /^(?:用户|我|本人)$/u.test(claim.subject) &&
    USER_PROFILE_PREDICATE_PATTERN.test(claim.predicate);
  const roleProfile =
    !/(?:项目|文件|文档|系统|产品|公司)/u.test(claim.subject) &&
    ROLE_PROFILE_PREDICATE_PATTERN.test(claim.predicate);
  return userProfile || roleProfile
    ? 'deterministic_synthesis_profile_match'
    : null;
}

function deterministicDirectRelevance(
  query: string,
  memory: string,
): string | null {
  const normalizedQuery = query.normalize('NFKC');
  const normalizedMemory = memory.normalize('NFKC');
  if (
    PERSONAL_RESPONSE_QUERY_PATTERN.test(normalizedQuery) &&
    DIRECT_PERSONAL_RESPONSE_MEMORY_PATTERN.test(normalizedMemory) &&
    !ARTIFACT_STATE_MEMORY_PATTERN.test(normalizedMemory)
  ) {
    return 'deterministic_direct_profile_match';
  }
  return null;
}

function deterministicRoleAddressRelevance(
  query: string,
  memory: string,
): string | null {
  const normalizedQuery = query.normalize('NFKC');
  if (!ROLE_ADDRESS_QUERY_PATTERN.test(normalizedQuery)) return null;
  const claim = atomicMemoryClaim(memory);
  if (
    !claim ||
    claim.negated ||
    !ROLE_ADDRESS_PREDICATE_PATTERN.test(claim.predicate) ||
    /(?:项目|文件|文档|系统|产品|公司)/u.test(claim.subject) ||
    !(
      /^(?:用户|我|本人)$/u.test(claim.subject) ||
      /(?:我|用户)/u.test(claim.value)
    )
  ) {
    return null;
  }
  return 'deterministic_role_address_match';
}

function namedPersonSubject(query: string): string | null {
  const normalized = query.normalize('NFKC');
  if (/^(?:用户|我|我的|本人)/u.test(normalized)) return null;
  const match = normalized.match(
    /^([\p{Script=Han}]{2,4}?)(?=平常|现在|目前|当前|通常|日常|的)/u,
  );
  const subject = match?.[1] || '';
  return /^(?:用户|本人|我们|应用|产品|团队)$/u.test(subject) ||
      /(?:服务|应用|项目|系统|产品)$/u.test(subject)
    ? null
    : subject || null;
}

function namedSystemSubject(query: string): string | null {
  return query.normalize('NFKC').match(
    /^([\p{Script=Han}A-Za-z0-9_-]{2,30}(?:服务|应用|项目|系统|产品))(?=使用|采用|的|现在|目前)/u,
  )?.[1] || null;
}

function matchingDirectFactRule(
  query: string,
  memory?: string,
): DirectFactRule | undefined {
  return DIRECT_FACT_RULES.find(
    (rule) =>
      rule.query.test(query) &&
      (memory === undefined || rule.memory.test(memory)),
  );
}

function deterministicTimezoneFactRelevance(
  query: string,
  memory: string,
): string | null {
  const rule = matchingDirectFactRule(query, memory);
  if (rule?.name !== 'timezone') return null;
  const queryIsUserScoped = /(?:用户|我|我的|本人)/u.test(query);
  const memoryIsUserScoped = /(?:用户|我|我的|本人)/u.test(memory);
  return !queryIsUserScoped || memoryIsUserScoped
    ? 'deterministic_timezone_fact_match'
    : null;
}

const PROJECT_FACT_PREDICATE_GROUPS: ReadonlyArray<
  readonly [RegExp, RegExp]
> = [
  [/(?:代号|编号|代码名称)/u, /(?:代号|编号|代码名称)/u],
  [
    /(?:发布|上线)(?:时间|窗口)/u,
    /(?:发布|上线)(?:时间|窗口)/u,
  ],
  [/(?:验收)(?:时间|窗口)/u, /(?:验收)(?:时间|窗口)/u],
];
const NAMED_PROJECT_FACT_QUERY_PATTERN =
  /(?:^|[^\p{Script=Han}A-Za-z0-9_-])(?!(?:这个|那个|当前|本次|该|我的|我们(?:的)?|用户(?:的)?))[\p{Script=Han}A-Za-z0-9_-]{2,30}(?:项目|软件|应用|系统|产品)/u;
const DISPLAY_MEMORY_PROJECT_PATTERN =
  /(?:^|\n)\s*(?:\[[^\]\n]{1,120}\]\s*)?([\p{Script=Han}A-Za-z0-9_-]{2,30}(?:项目|软件|应用|系统|产品))/gu;

function memoryProjectSubjects(memory: string): string[] {
  const claim = atomicMemoryClaim(memory);
  if (
    claim &&
    /(?:项目|软件|应用|系统|产品)/u.test(claim.subject)
  ) {
    const projectEntity = claim.subject.match(
      /^([\p{Script=Han}A-Za-z0-9_-]{2,30}?(?:项目|软件|应用|系统|产品))(?:\s|$)/u,
    )?.[1];
    return [projectEntity || claim.subject];
  }
  return [
    ...memory.normalize('NFKC').matchAll(
      DISPLAY_MEMORY_PROJECT_PATTERN,
    ),
  ].map((match) => match[1]);
}

function deterministicProjectSubjectMismatch(
  query: string,
  memory: string,
): string | null {
  const normalizedQuery = query.normalize('NFKC');
  const projectSubjects = memoryProjectSubjects(memory);
  const asksProjectFact = PROJECT_FACT_PREDICATE_GROUPS.some(
    ([queryPattern]) => queryPattern.test(normalizedQuery),
  );
  if (
    !asksProjectFact ||
    !NAMED_PROJECT_FACT_QUERY_PATTERN.test(normalizedQuery) ||
    projectSubjects.length === 0 ||
    projectSubjects.some((subject) => normalizedQuery.includes(subject))
  ) {
    return null;
  }
  return 'deterministic_subject_mismatch:explicit_project';
}

function deterministicProjectFactRelevance(
  query: string,
  memory: string,
): string | null {
  const normalizedQuery = query.normalize('NFKC');
  const claim = atomicMemoryClaim(memory);
  const projectSubjects = memoryProjectSubjects(memory);
  if (
    !claim ||
    claim.negated ||
    projectSubjects.length === 0 ||
    !projectSubjects.some((subject) => normalizedQuery.includes(subject))
  ) {
    return null;
  }
  const predicate = claim.predicate.replace(
    /\s*\[条件:[^\]]+\]\s*$/u,
    '',
  );
  const predicateEvidence = `${claim.subject} ${predicate}`;
  return PROJECT_FACT_PREDICATE_GROUPS.some(
    ([queryPattern, memoryPattern]) =>
      queryPattern.test(normalizedQuery) &&
      memoryPattern.test(predicateEvidence),
  )
    ? 'deterministic_project_fact_match'
    : null;
}

function deterministicProjectFactDecision(
  query: string,
  memory: string,
  explicitProjectSubjects: readonly string[],
): SemanticDecision | null {
  const normalizedQuery = query.normalize('NFKC');
  const asksProjectFact = PROJECT_FACT_PREDICATE_GROUPS.some(
    ([queryPattern]) => queryPattern.test(normalizedQuery),
  );
  if (
    !asksProjectFact ||
    !NAMED_PROJECT_FACT_QUERY_PATTERN.test(normalizedQuery) ||
    explicitProjectSubjects.length === 0
  ) {
    return null;
  }

  const normalizedMemory = memory.normalize('NFKC');
  const mentionsExplicitProject = explicitProjectSubjects.some(
    (subject) => normalizedMemory.includes(subject),
  );
  if (!mentionsExplicitProject) {
    return {
      id: '',
      relevant: false,
      confidence: 1,
      reason: 'deterministic_subject_mismatch:explicit_project',
    };
  }

  const relevance = deterministicProjectFactRelevance(
    normalizedQuery,
    normalizedMemory,
  );
  if (relevance) {
    return {
      id: '',
      relevant: true,
      confidence: 0.95,
      reason: relevance,
    };
  }

  const claim = atomicMemoryClaim(normalizedMemory);
  if (claim && memoryProjectSubjects(normalizedMemory).length > 0) {
    return {
      id: '',
      relevant: false,
      confidence: 1,
      reason: 'deterministic_predicate_mismatch:explicit_project_fact',
    };
  }
  return null;
}

function deterministicPositiveRelevance(
  query: string,
  memory: string,
): string | null {
  return deterministicDirectRelevance(query, memory) ||
    deterministicRoleAddressRelevance(query, memory) ||
    deterministicTimezoneFactRelevance(query, memory) ||
    deterministicSynthesisRelevance(query, memory) ||
    deterministicProjectFactRelevance(query, memory);
}

export function deterministicRelevanceRejection(
  query: string,
  memory: string,
): string | null {
  const normalizedQuery = query.normalize('NFKC');
  const normalizedMemory = memory.normalize('NFKC');
  const personSubject = namedPersonSubject(normalizedQuery);
  if (personSubject && !normalizedMemory.includes(personSubject)) {
    return 'deterministic_subject_mismatch:explicit_person';
  }
  const projectSubjectMismatch = deterministicProjectSubjectMismatch(
    normalizedQuery,
    normalizedMemory,
  );
  if (projectSubjectMismatch) return projectSubjectMismatch;
  const systemSubject = namedSystemSubject(normalizedQuery);
  if (systemSubject && !normalizedMemory.includes(systemSubject)) {
    return 'deterministic_subject_mismatch:explicit_system';
  }
  const directFactRule = matchingDirectFactRule(normalizedQuery);
  const thirdPartyPerson = explicitThirdPartyPerson(normalizedMemory);
  if (
    thirdPartyPerson &&
    (USER_PROFILE_QUERY_PATTERN.test(normalizedQuery) || directFactRule) &&
    !normalizedQuery.includes(thirdPartyPerson)
  ) {
    return 'deterministic_subject_mismatch:explicit_third_party';
  }
  if (
    PERSONAL_RESPONSE_QUERY_PATTERN.test(normalizedQuery) &&
    ARTIFACT_STATE_MEMORY_PATTERN.test(normalizedMemory) &&
    !PERSONAL_RESPONSE_MEMORY_PATTERN.test(normalizedMemory)
  ) {
    return 'deterministic_predicate_mismatch:response_preference_vs_artifact_state';
  }
  if (
    USER_PROFILE_QUERY_PATTERN.test(normalizedQuery) &&
    EXTERNAL_CONTEXT_MEMORY_PATTERN.test(normalizedMemory) &&
    !/(?:用户|我|我的|本人)/u.test(normalizedMemory)
  ) {
    return 'deterministic_subject_mismatch:user_profile_vs_external_context';
  }
  if (
    directFactRule &&
    ARTIFACT_STATE_MEMORY_PATTERN.test(normalizedMemory) &&
    !matchingDirectFactRule(normalizedQuery, normalizedMemory)
  ) {
    return 'deterministic_predicate_mismatch:direct_fact_vs_artifact_state';
  }
  if (
    directFactRule &&
    EXTERNAL_CONTEXT_MEMORY_PATTERN.test(normalizedMemory) &&
    (
      EXPLICIT_EXTERNAL_SUBJECT_PATTERN.test(normalizedMemory) ||
      !matchingDirectFactRule(normalizedQuery, normalizedMemory)
    )
  ) {
    return 'deterministic_predicate_mismatch:direct_fact_vs_external_context';
  }
  return null;
}

const REWRITE_SYSTEM_PROMPT = [
  '你是长期记忆检索查询改写器。',
  '生成最多 3 个短查询，补全口语省略、同义表达和明确的主体/属性。',
  '输入主要为英文时，至少生成一个保持原意的中文查询，以支持中英文跨语言检索。',
  '必须保留原问题的否定、时间、范围、对象和事实/要求模态，不得添加原问题没有的答案或猜测。',
  '查询之间要有词汇差异；不要输出解释。',
].join('');

const REWRITE_FORMAT = {
  type: 'object',
  properties: {
    rewrites: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string' },
    },
  },
  required: ['rewrites'],
} as const;

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export class OllamaSemanticRanker implements SemanticRanker {
  readonly embeddingModel: string;
  readonly rerankModel: string;
  private readonly baseUrl: string;
  private readonly embedBatchSize: number;
  private readonly rerankBatchSize: number;
  private readonly rerankProviderCallBudget: number;
  private readonly rerankProviderGate: SharedProviderGate;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly crossEncoder?: {
    baseUrl: string;
    model: string;
    batchSize: number;
    timeoutMs: number;
    confidenceScale: number;
  };
  private readonly rerankCache = new Map<string, {
    expiresAt: number;
    settled: boolean;
    promise: Promise<ProviderOperationResult<SemanticDecision[]>>;
  }>();
  private readonly rewriteCache = new Map<string, {
    expiresAt: number;
    settled: boolean;
    promise: Promise<ProviderOperationResult<string[]>>;
  }>();
  private readonly cacheCounters: SemanticCacheStats = {
    rewriteHits: 0,
    rewriteSingleFlightShares: 0,
    rerankHits: 0,
    rerankSingleFlightShares: 0,
  };

  constructor(options: OllamaSemanticRankerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.embeddingModel = options.embeddingModel;
    this.rerankModel = options.rerankModel;
    this.embedBatchSize = Math.max(1, options.embedBatchSize);
    const configuredRerankBatchSize = Number.isFinite(options.rerankBatchSize)
      ? Math.trunc(options.rerankBatchSize)
      : 1;
    this.rerankBatchSize = Math.min(
      MAX_RERANK_BATCH_SIZE,
      Math.max(1, configuredRerankBatchSize),
    );
    const configuredRerankConcurrency = Number.isFinite(
        options.rerankConcurrency,
      )
      ? Math.trunc(options.rerankConcurrency!)
      : 1;
    const rerankConcurrency = Math.min(
      MAX_RERANK_CONCURRENCY,
      Math.max(1, configuredRerankConcurrency),
    );
    const configuredProviderCallBudget = Number.isFinite(
        options.rerankProviderCallBudget,
      )
      ? Math.trunc(options.rerankProviderCallBudget!)
      : MAX_RERANK_LOGICAL_PROVIDER_CALLS;
    this.rerankProviderCallBudget = Math.min(
      MAX_RERANK_LOGICAL_PROVIDER_CALLS,
      Math.max(1, configuredProviderCallBudget),
    );
    this.timeoutMs = Math.max(1_000, options.timeoutMs);
    this.cacheTtlMs = options.cacheTtlMs === 0
      ? 0
      : Math.max(1_000, options.cacheTtlMs ?? 30_000);
    this.cacheMaxEntries = Math.max(1, options.cacheMaxEntries ?? 256);
    this.fetchImpl = options.fetchImpl || fetch;
    if (options.crossEncoder) {
      this.crossEncoder = {
        baseUrl: options.crossEncoder.baseUrl.replace(/\/+$/, ''),
        model: options.crossEncoder.model,
        batchSize: Math.min(
          128,
          Math.max(1, Math.trunc(options.crossEncoder.batchSize || 32)),
        ),
        timeoutMs: Math.max(1_000, options.crossEncoder.timeoutMs),
        confidenceScale: Math.min(
          10,
          Math.max(1, options.crossEncoder.confidenceScale || 3),
        ),
      };
    }
    this.rerankProviderGate = sharedRerankProviderGate(
      this.fetchImpl,
      this.baseUrl,
      this.rerankModel,
      rerankConcurrency,
    );
  }

  private cacheKey(value: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(value))
      .digest('hex');
  }

  private pruneCache<T>(
    cache: Map<string, { expiresAt: number; promise: Promise<T> }>,
    now = Date.now(),
  ): void {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
    while (cache.size > this.cacheMaxEntries) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) break;
      cache.delete(oldest);
    }
  }

  cacheStats(): SemanticCacheStats {
    return { ...this.cacheCounters };
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return (await this.embedWithTelemetry(texts)).result;
  }

  async embedWithTelemetry(
    texts: string[],
  ): Promise<SemanticOperationResult<Float32Array[]>> {
    const started = performance.now();
    const providerStarted = performance.now();
    const keyFingerprint = this.cacheKey({
      protocol: 'embed-v1',
      model: this.embeddingModel,
      inputs: texts.map((text) => this.cacheKey(text)),
    });
    const vectors: Float32Array[] = [];
    const modelSamples: SemanticModelTelemetry[] = [];
    let providerCalls = 0;
    try {
      for (const batch of chunk(texts, this.embedBatchSize)) {
        providerCalls += 1;
        const response = await this.fetchImpl(
          `${this.baseUrl}/api/embed`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: backgroundModelAbortSignal(this.timeoutMs),
            body: JSON.stringify({
              model: this.embeddingModel,
              input: batch,
              keep_alive: config.modelKeepAlive,
            }),
          },
        );
        if (!response.ok) {
          throw new ProviderCallError(
            `Ollama embedding 请求失败：HTTP ${response.status}`,
            'provider_http_error',
          );
        }
        let payload: OllamaEmbedResponse;
        try {
          payload = await response.json() as OllamaEmbedResponse;
        } catch (error) {
          throw new ProviderCallError(
            'Ollama embedding 返回的 JSON 无法解析',
            'provider_protocol_error',
            error,
          );
        }
        modelSamples.push(modelTelemetry(payload));
        if (
          !Array.isArray(payload.embeddings) ||
          payload.embeddings.length !== batch.length
        ) {
          throw new ProviderCallError(
            'Ollama embedding 返回数量不正确',
            'provider_protocol_error',
          );
        }
        for (const value of payload.embeddings) {
          if (
            !Array.isArray(value) ||
            value.length === 0 ||
            value.some((item) => !Number.isFinite(Number(item)))
          ) {
            throw new ProviderCallError(
              'Ollama embedding 返回了无效向量',
              'provider_protocol_error',
            );
          }
          vectors.push(Float32Array.from(value.map(Number)));
        }
      }
    } catch (error) {
      const providerError = providerOperationError(
        error,
        providerCalls,
        providerStarted,
        modelSamples,
      );
      throw semanticOperationError(
        providerError,
        'embed',
        keyFingerprint,
        started,
      );
    }
    const requestDurationMs = Number(
      (performance.now() - started).toFixed(3),
    );
    return {
      result: vectors,
      telemetry: {
        route: providerCalls > 0 ? 'model' : 'deterministic_fast',
        providerCalls,
        cacheHit: false,
        singleFlightShared: false,
        keyFingerprint,
        requestDurationMs,
        providerDurationMs: providerCalls > 0
          ? Number((performance.now() - providerStarted).toFixed(3))
          : null,
        model: aggregateModelTelemetry(modelSamples),
      },
    };
  }

  async rerank(
    query: string,
    candidates: SemanticCandidate[],
  ): Promise<SemanticDecision[]> {
    return (await this.rerankWithTelemetry(query, candidates)).result;
  }

  async rerankWithTelemetry(
    query: string,
    candidates: SemanticCandidate[],
  ): Promise<SemanticOperationResult<SemanticDecision[]>> {
    const started = performance.now();
    const key = this.cacheKey({
      protocol: 'rerank-v9-compact-atomic-provider',
      model: this.rerankCacheModelId(),
      query: query.normalize('NFKC').trim(),
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        memoryHash: this.cacheKey(candidate.memory),
        evidence: candidate.evidence || null,
      })),
    });
    const complete = (
      operation: ProviderOperationResult<SemanticDecision[]>,
    ): SemanticOperationResult<SemanticDecision[]> => ({
      result: operation.result.map((decision) => ({ ...decision })),
      telemetry: {
        route: operation.providerCalls === 0
          ? 'deterministic_fast'
          : 'model',
        providerCalls: operation.providerCalls,
        baseProviderCalls: operation.baseProviderCalls || 0,
        firstCandidateConfirmationCalls:
          operation.firstCandidateConfirmationCalls || 0,
        protocolRecoveryCalls: operation.protocolRecoveryCalls || 0,
        protocolRecoveryMaxDepth: operation.protocolRecoveryMaxDepth || 0,
        parallelBatchCount: operation.parallelBatchCount || 0,
        providerQueueWaitMs: operation.providerQueueWaitMs || 0,
        providerPeakActive: operation.providerPeakActive || 0,
        providerMaxConcurrency: operation.providerMaxConcurrency || 0,
        cacheHit: false,
        singleFlightShared: false,
        keyFingerprint: key,
        requestDurationMs: Number(
          (performance.now() - started).toFixed(3),
        ),
        providerDurationMs: operation.providerCalls > 0
          ? operation.providerDurationMs
          : null,
        model: aggregateModelTelemetry(operation.modelSamples),
      },
    });
    if (candidates.length === 0) {
      return complete({
        result: [],
        providerCalls: 0,
        providerDurationMs: 0,
        modelSamples: [],
      });
    }
    if (this.cacheTtlMs === 0) {
      try {
        return complete(await this.rerankUncached(query, candidates));
      } catch (error) {
        throw semanticOperationError(
          error,
          'rerank',
          key,
          started,
        );
      }
    }
    const now = Date.now();
    this.pruneCache(this.rerankCache, now);
    const existing = this.rerankCache.get(key);
    if (existing && existing.expiresAt > now) {
      const singleFlightShared = !existing.settled;
      if (singleFlightShared) {
        this.cacheCounters.rerankSingleFlightShares += 1;
      } else {
        this.cacheCounters.rerankHits += 1;
      }
      try {
        const operation = await existing.promise;
        return {
          result: operation.result.map((decision) => ({ ...decision })),
          telemetry: {
            route: 'cache',
            providerCalls: 0,
            baseProviderCalls: 0,
            firstCandidateConfirmationCalls: 0,
            protocolRecoveryCalls: 0,
            protocolRecoveryMaxDepth: 0,
            parallelBatchCount: 0,
            providerQueueWaitMs: 0,
            providerPeakActive: 0,
            providerMaxConcurrency: 0,
            cacheHit: !singleFlightShared,
            singleFlightShared,
            keyFingerprint: key,
            requestDurationMs: Number(
              (performance.now() - started).toFixed(3),
            ),
            providerDurationMs: null,
            model: null,
          },
        };
      } catch (error) {
        throw semanticOperationError(
          error,
          'rerank',
          key,
          started,
          {
            route: 'cache',
            providerCalls: 0,
            baseProviderCalls: 0,
            firstCandidateConfirmationCalls: 0,
            protocolRecoveryCalls: 0,
            protocolRecoveryMaxDepth: 0,
            parallelBatchCount: 0,
            providerQueueWaitMs: 0,
            providerPeakActive: 0,
            providerMaxConcurrency: 0,
            cacheHit: !singleFlightShared,
            singleFlightShared,
            providerDurationMs: null,
            model: null,
          },
        );
      }
    }
    const entry = {
      expiresAt: Number.POSITIVE_INFINITY,
      settled: false,
      promise: this.rerankUncached(query, candidates),
    };
    this.rerankCache.set(key, entry);
    try {
      const operation = await entry.promise;
      entry.settled = true;
      entry.expiresAt = Date.now() + this.cacheTtlMs;
      this.pruneCache(this.rerankCache);
      return complete(operation);
    } catch (error) {
      if (this.rerankCache.get(key)?.promise === entry.promise) {
        this.rerankCache.delete(key);
      }
      throw semanticOperationError(
        error,
        'rerank',
        key,
        started,
      );
    }
  }

  private rerankCacheModelId(): string {
    return this.crossEncoder
      ? `cross_encoder:${this.crossEncoder.model}`
      : this.rerankModel;
  }

  private async rerankUncached(
    query: string,
    candidates: SemanticCandidate[],
  ): Promise<ProviderOperationResult<SemanticDecision[]>> {
    if (candidates.length > MAX_RERANK_BATCH_SIZE * 2) {
      throw new RerankProtocolError('Ollama 重排候选数量超过预算');
    }
    // 文本预算只为 LLM prompt 而设；cross-encoder 由 sidecar 按 token
    // 截断（sidecar 自带 max_len），跳过预算校验正是 CE 的收益之一。
    if (!this.crossEncoder) {
      for (const batch of chunk(candidates, this.rerankBatchSize)) {
        validateRerankBatchBudget(query, batch);
      }
    }
    const explicitProjectSubjects = [
      ...new Set(
        candidates.flatMap((candidate) =>
          memoryProjectSubjects(candidate.memory).filter((subject) =>
            query.normalize('NFKC').includes(subject)
          )
        ),
      ),
    ];
    const deterministicDecisions = new Map<string, SemanticDecision>();
    const rejections = new Map<string, string>();
    const verificationPhrase = verificationEvidencePhrase(query);
    let unresolved = candidates.filter((candidate) => {
      const settleDeterministic = (
        decision: Omit<SemanticDecision, 'id'> | null,
      ): boolean => {
        if (!decision) return false;
        if (decision.relevant && !trustedCurrentUserEvidence(candidate)) {
          return false;
        }
        deterministicDecisions.set(candidate.id, {
          ...decision,
          id: candidate.id,
        });
        return true;
      };
      const atomicProfileDecision = deterministicAtomicProfileFactDecision(
        query,
        candidate.memory,
      );
      if (
        atomicProfileDecision?.relevant &&
        !trustedCurrentUserEvidence(candidate)
      ) {
        return true;
      }
      if (settleDeterministic(atomicProfileDecision)) return false;
      const chronologicalEventDecision =
        deterministicChronologicalEventDecision(query, candidate, candidates);
      if (settleDeterministic(chronologicalEventDecision)) return false;
      const verificationDecision =
        deterministicVerificationEvidenceDecision(query, candidate);
      if (
        verificationDecision?.relevant &&
        !trustedCurrentUserEvidence(candidate)
      ) {
        return true;
      }
      if (settleDeterministic(verificationDecision)) return false;
      const projectDecision = deterministicProjectFactDecision(
        query,
        candidate.memory,
        explicitProjectSubjects,
      );
      if (settleDeterministic(projectDecision)) return false;
      const rejection = deterministicRelevanceRejection(
        query,
        candidate.memory,
      );
      if (rejection) {
        rejections.set(candidate.id, rejection);
        return false;
      }
      const positive = deterministicPositiveRelevance(
        query,
        candidate.memory,
      );
      if (positive && trustedCurrentUserEvidence(candidate)) {
        deterministicDecisions.set(candidate.id, {
          id: candidate.id,
          relevant: true,
          confidence: 0.95,
          reason: positive,
        });
        return false;
      }
      return true;
    });
    let rerankRootPlan: RerankModelRootPlan | undefined;
    if (verificationPhrase && unresolved.length > 0) {
      const originalIndex = new Map(
        candidates.map((candidate, index) => [candidate.id, index]),
      );
      unresolved = [...unresolved].sort((left, right) =>
            verificationCandidatePriority(right) -
              verificationCandidatePriority(left) ||
            verificationCandidateOverlap(
              verificationPhrase,
              right.memory,
            ) - verificationCandidateOverlap(
              verificationPhrase,
              left.memory,
            ) ||
            (originalIndex.get(left.id) || 0) -
              (originalIndex.get(right.id) || 0)
      );
      rerankRootPlan = {
        stageEnds: verificationModelStageEnds(
          unresolved.length,
          unresolved.filter(trustedCurrentUserEvidence).length,
        ),
      };
    }
    if (!this.crossEncoder) {
      for (const batch of chunk(unresolved, this.rerankBatchSize)) {
        validateRerankBatchBudget(query, batch);
      }
    }
    const providerStarted = performance.now();
    let modelOperation = unresolved.length > 0
      ? this.crossEncoder
        ? await this.rerankViaCrossEncoder(
          query,
          unresolved,
          providerStarted,
        )
        : await this.rerankModelUncached(
          query,
          unresolved,
          undefined,
          rerankRootPlan,
        )
      : {
        result: [],
        providerCalls: 0,
        providerDurationMs: 0,
        modelSamples: [],
      };
    const modelDecisions = modelOperation.result;
    const modelById = new Map(
      modelDecisions.map((decision) => [decision.id, decision]),
    );
    const result = candidates.map((candidate) => {
      const deterministicDecision = deterministicDecisions.get(
        candidate.id,
      );
      if (deterministicDecision) return deterministicDecision;
      const rejection = rejections.get(candidate.id);
      if (rejection) {
        return {
          id: candidate.id,
          relevant: false,
          confidence: 1,
          reason: rejection,
        };
      }
      const decision = modelById.get(candidate.id);
      if (!decision) {
        throw new RerankProtocolError('Ollama 重排遗漏了未决候选');
      }
      return decision;
    });
    return {
      result,
      providerCalls: modelOperation.providerCalls,
      providerDurationMs: modelOperation.providerCalls > 0
        ? Number((performance.now() - providerStarted).toFixed(3))
        : 0,
      modelSamples: modelOperation.modelSamples,
      baseProviderCalls: modelOperation.baseProviderCalls || 0,
      firstCandidateConfirmationCalls:
        modelOperation.firstCandidateConfirmationCalls || 0,
      protocolRecoveryCalls: modelOperation.protocolRecoveryCalls || 0,
      protocolRecoveryMaxDepth:
        modelOperation.protocolRecoveryMaxDepth || 0,
      parallelBatchCount: modelOperation.parallelBatchCount || 0,
      providerQueueWaitMs: modelOperation.providerQueueWaitMs || 0,
      providerPeakActive: modelOperation.providerPeakActive || 0,
      providerMaxConcurrency: modelOperation.providerMaxConcurrency || 0,
    };
  }

  // cross-encoder sidecar 路径：对未决候选整批打分。
  // 分数经 sigmoid(score × confidenceScale) 映射为 confidence（与 LLM 决策
  // 同一消费语义：memory-store 侧 semanticMinConfidence 门槛照常生效）。
  // relevant = score >= 0——"包含回答所需信息"的天然分界。
  // confidenceScale 让明显相关的候选 confidence 快速饱和到 ≈1，
  // 使最终排序回归 dense 分主导（LLM 模式的 0.95/1.0 二值 confidence 同语义），
  // 避免 CE 的连续置信度注入排序公式造成 gold 被干扰项反超。
  private async rerankViaCrossEncoder(
    query: string,
    candidates: SemanticCandidate[],
    providerStarted: number,
  ): Promise<ProviderOperationResult<SemanticDecision[]>> {
    const provider = this.crossEncoder!;
    const modelSamples: SemanticModelTelemetry[] = [];
    const decisions: SemanticDecision[] = [];
    let providerCalls = 0;
    try {
      for (const batch of chunk(candidates, provider.batchSize)) {
        providerCalls += 1;
        const signal = backgroundModelAbortSignal(provider.timeoutMs);
        const response = await this.fetchImpl(
          `${provider.baseUrl}/rerank`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal,
            body: JSON.stringify({
              query,
              passages: batch.map((candidate) => candidate.memory),
            }),
          },
        );
        if (!response.ok) {
          throw new ProviderCallError(
            `Cross-encoder 重排请求失败：HTTP ${response.status}`,
            'provider_http_error',
          );
        }
        let payload: { scores?: unknown; elapsed_ms?: unknown };
        try {
          payload = await response.json() as typeof payload;
        } catch (error) {
          throw new ProviderCallError(
            'Cross-encoder 重排返回的 JSON 无法解析',
            'provider_protocol_error',
            error,
          );
        }
        if (
          !Array.isArray(payload.scores) ||
          payload.scores.length !== batch.length ||
          payload.scores.some((value) => !Number.isFinite(Number(value)))
        ) {
          throw new ProviderCallError(
            'Cross-encoder 重排返回的分数数量或类型无效',
            'provider_protocol_error',
          );
        }
        if (providerCalls === 1) {
          modelSamples.push({
            totalDurationMs: Number(payload.elapsed_ms) || null,
            loadDurationMs: null,
            promptEvalCount: null,
            promptEvalDurationMs: null,
            evalCount: null,
            evalDurationMs: null,
            thermalState: 'unknown',
          });
        }
        for (const [index, raw] of payload.scores.entries()) {
          const score = Number(raw);
          const confidence =
            1 / (1 + Math.exp(-score * provider.confidenceScale));
          decisions.push({
            id: batch[index].id,
            relevant: score >= 0,
            confidence: Number(confidence.toFixed(6)),
            reason: `cross_encoder:${score.toFixed(4)}`,
          });
        }
      }
    } catch (error) {
      throw providerOperationError(
        error,
        providerCalls,
        providerStarted,
        modelSamples,
      );
    }
    return {
      result: decisions,
      providerCalls,
      providerDurationMs: Number(
        (performance.now() - providerStarted).toFixed(3),
      ),
      modelSamples,
    };
  }

  private async rerankModelUncached(
    query: string,
    candidates: SemanticCandidate[],
    options?: RerankModelCallOptions,
    rootPlan: RerankModelRootPlan = {},
  ): Promise<ProviderOperationResult<SemanticDecision[]>> {
    if (!options) {
      const providerStarted = performance.now();
      const gateTelemetry: ProviderGateTelemetry = {
        queueWaitMs: 0,
        peakActive: 0,
        maximumConcurrency: this.rerankProviderGate.maximumConcurrency,
      };
      const runProviderCall = this.rerankProviderGate.runner(gateTelemetry);
      const callBudget = new RerankProviderCallBudget(
        this.rerankProviderCallBudget,
      );
      const stageEnds = rootPlan.stageEnds?.length
        ? [...new Set(rootPlan.stageEnds)]
          .filter((value) => value > 0 && value <= candidates.length)
          .sort((left, right) => left - right)
        : [candidates.length];
      if (stageEnds.at(-1) !== candidates.length) {
        stageEnds.push(candidates.length);
      }
      const decisions: SemanticDecision[] = [];
      const modelSamples: SemanticModelTelemetry[] = [];
      let providerCalls = 0;
      let baseProviderCalls = 0;
      let protocolRecoveryCalls = 0;
      let protocolRecoveryMaxDepth = 0;
      let parallelBatchCount = 0;
      let stageStart = 0;
      for (const stageEnd of stageEnds) {
        if (stageEnd <= stageStart) continue;
        const batches = chunk(
          candidates.slice(stageStart, stageEnd),
          this.rerankBatchSize,
        );
        parallelBatchCount += batches.length;
        const baseResults = await Promise.allSettled(
          batches.map((batch) =>
            this.rerankModelUncached(query, batch, {
              singleBatch: true,
              callKind: 'base',
              recoveryDepth: 0,
              runProviderCall,
              callBudget,
            })
          ),
        );
        let failure: ProviderOperationError | null = null;
        let stageRelevant = false;
        for (const result of baseResults) {
          const operation = result.status === 'fulfilled'
            ? result.value
            : result.reason instanceof ProviderOperationError
              ? result.reason
              : providerOperationError(result.reason, 0, providerStarted, []);
          providerCalls += operation.providerCalls;
          baseProviderCalls += operation.baseProviderCalls || 0;
          protocolRecoveryCalls += operation.protocolRecoveryCalls || 0;
          protocolRecoveryMaxDepth = Math.max(
            protocolRecoveryMaxDepth,
            operation.protocolRecoveryMaxDepth || 0,
          );
          modelSamples.push(...operation.modelSamples);
          if (result.status === 'fulfilled') {
            decisions.push(...result.value.result);
            stageRelevant ||= result.value.result.some(
              (decision) => decision.relevant,
            );
          } else {
            failure ||= operation as ProviderOperationError;
          }
        }
        if (failure) {
          throw new ProviderOperationError(
            failure.message,
            failure.code,
            providerCalls,
            Number((performance.now() - providerStarted).toFixed(3)),
            modelSamples,
            failure,
            {
              baseProviderCalls,
              firstCandidateConfirmationCalls: 0,
              protocolRecoveryCalls,
              protocolRecoveryMaxDepth,
              parallelBatchCount,
              providerQueueWaitMs: Number(
                gateTelemetry.queueWaitMs.toFixed(3),
              ),
              providerPeakActive: gateTelemetry.peakActive,
              providerMaxConcurrency: gateTelemetry.maximumConcurrency,
            },
          );
        }
        stageStart = stageEnd;
        if (rootPlan.stageEnds && stageRelevant && stageEnd < candidates.length) {
          decisions.push(
            ...candidates.slice(stageEnd).map((candidate) => ({
              id: candidate.id,
              relevant: false,
              confidence: 0,
              reason: 'not_evaluated:verification_answer_supported',
            })),
          );
          break;
        }
      }
      return {
        result: decisions,
        providerCalls,
        providerDurationMs: Number(
          (performance.now() - providerStarted).toFixed(3),
        ),
        modelSamples,
        baseProviderCalls,
        firstCandidateConfirmationCalls: 0,
        protocolRecoveryCalls,
        protocolRecoveryMaxDepth,
        parallelBatchCount,
        providerQueueWaitMs: Number(gateTelemetry.queueWaitMs.toFixed(3)),
        providerPeakActive: gateTelemetry.peakActive,
        providerMaxConcurrency: gateTelemetry.maximumConcurrency,
      };
    }
    const decisions: SemanticDecision[] = [];
    const modelSamples: SemanticModelTelemetry[] = [];
    let providerCalls = 0;
    let baseProviderCalls = 0;
    const firstCandidateConfirmationCalls = 0;
    let protocolRecoveryCalls = 0;
    let protocolRecoveryMaxDepth = 0;
    validateRerankBatchBudget(query, candidates);
    const providerStarted = performance.now();
    const batches = [candidates];
    for (const batch of batches) {
      try {
      const indexed = batch.map(
        (candidate, index) => [
          index,
          providerAtomicMemory(candidate.memory),
        ] as const,
      );
      // 按批内容类型选判定规则：文档批用知识库 prompt，对话批用长期记忆 prompt。
      // 批内同构由上游分批保证；若出现混合批，从严回落对话规则。
      const batchIsDocument = batch.length > 0 &&
        batch.every((candidate) => candidate.kind === 'document_chunk');
      const systemPrompt = batchIsDocument
        ? KB_RERANK_SYSTEM_PROMPT
        : RERANK_SYSTEM_PROMPT;
      const signal = backgroundModelAbortSignal(this.timeoutMs);
      const response = await options.runProviderCall(async () => {
        options.callBudget.reserve();
        providerCalls += 1;
        if (options.callKind === 'base') {
          baseProviderCalls += 1;
        } else {
          protocolRecoveryCalls += 1;
          protocolRecoveryMaxDepth = Math.max(
            protocolRecoveryMaxDepth,
            options.recoveryDepth,
          );
        }
        return await this.fetchImpl(
          `${this.baseUrl}/api/chat`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal,
            body: JSON.stringify({
              model: this.rerankModel,
              stream: false,
              think: false,
              keep_alive: config.modelKeepAlive,
              format: rerankFormat(batch.length),
              options: {
                temperature: 0,
                seed: 42,
                num_batch: 1_024,
                num_predict: Math.max(
                  24,
                  batch.length * 3 + 12,
                ),
                // 只在显式配置时下发 num_ctx；0 = 沿用 Ollama 运行时默认
                // （通常 2048），与出厂行为一致。候选文本预算放大后必须
                // 同步抬高，否则超出的候选被上下文窗口静默截断。
                ...(config.semanticRerankNumCtx > 0
                  ? { num_ctx: config.semanticRerankNumCtx }
                  : {}),
              },
              messages: [
                { role: 'system', content: RERANK_SYSTEM_PROMPT },
                {
                  role: 'user',
                  content: JSON.stringify({ q: query, m: indexed }),
                },
              ],
            }),
          },
        );
      }, signal);
      if (!response.ok) {
        throw new ProviderCallError(
          `Ollama 重排请求失败：HTTP ${response.status}`,
          'provider_http_error',
        );
      }
      let payload: OllamaChatResponse;
      try {
        payload = await response.json() as OllamaChatResponse;
      } catch (error) {
        throw new ProviderCallError(
          'Ollama 重排返回的 JSON 无法解析',
          'provider_protocol_error',
          error,
        );
      }
      modelSamples.push(modelTelemetry(payload));
      if (typeof payload.message?.content !== 'string') {
        throw new RerankProtocolError('Ollama 重排没有返回文本结果');
      }
      let parsed: {
        codes?: unknown;
        decisions?: unknown;
        relevant_indexes?: unknown;
      } | unknown[];
      try {
        parsed = JSON.parse(payload.message.content) as typeof parsed;
      } catch {
        throw new RerankProtocolError('Ollama 重排返回的 JSON 无法解析');
      }
      const modelDecisions = new Map<number, ModelRerankDecision>();
      if (Array.isArray(parsed)) {
        const relevantIndexes = new Set<number>();
        for (const value of parsed) {
          if (
            typeof value !== 'number' ||
            !Number.isInteger(value) ||
            value < 0 ||
            value >= batch.length ||
            relevantIndexes.has(value)
          ) {
            throw new RerankProtocolError(
              'Ollama 重排返回了无效或重复的 index',
            );
          }
          relevantIndexes.add(value);
        }
        for (let index = 0; index < batch.length; index += 1) {
          const relevant = relevantIndexes.has(index);
          modelDecisions.set(index, {
            index,
            relevant,
            confidence: 1,
            subjectMatch: relevant,
            predicateMatch: relevant,
            entails: relevant,
          });
        }
      } else if (typeof parsed.codes === 'string') {
        if (
          parsed.codes.length !== batch.length ||
          !/^[0-7]+$/u.test(parsed.codes)
        ) {
          throw new RerankProtocolError('Ollama 重排 codes 字符串无效');
        }
        for (const [index, value] of [...parsed.codes].entries()) {
          const checks = Number(value);
          modelDecisions.set(index, {
            index,
            relevant: checks === 7,
            confidence: 0.95,
            subjectMatch: (checks & 1) === 1,
            predicateMatch: (checks & 2) === 2,
            entails: (checks & 4) === 4,
          });
        }
      } else if (Array.isArray(parsed.codes)) {
        if (parsed.codes.length !== batch.length) {
          throw new RerankProtocolError('Ollama 重排 codes 数量不正确');
        }
        for (const [index, value] of parsed.codes.entries()) {
          const code = Number(value);
          if (!Number.isInteger(code) || code < 0 || code > 799) {
            throw new RerankProtocolError('Ollama 重排 code 无效');
          }
          const checks = Math.floor(code / 100);
          const confidence = (code % 100) / 100;
          modelDecisions.set(index, {
            index,
            relevant: checks === 7,
            confidence,
            subjectMatch: (checks & 1) === 1,
            predicateMatch: (checks & 2) === 2,
            entails: (checks & 4) === 4,
          });
        }
      } else if (Array.isArray(parsed.decisions)) {
        for (const [position, value] of parsed.decisions.entries()) {
          if (
            typeof value !== 'object' ||
            value === null ||
            Array.isArray(value)
          ) {
            throw new RerankProtocolError('Ollama 重排 decision 结构无效');
          }
          const item = value as Record<string, unknown>;
          const index = item.index === undefined
            ? position
            : Number(item.index);
          const confidence = Number(item.confidence);
          const compact = item.checks !== undefined;
          const checks = Number(item.checks);
          if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= batch.length ||
            modelDecisions.has(index) ||
            !Number.isFinite(confidence) ||
            confidence < 0 ||
            confidence > 1 ||
            (
              compact
                ? !Number.isInteger(checks) || checks < 0 || checks > 7
                : typeof item.relevant !== 'boolean' ||
                  typeof item.subject_match !== 'boolean' ||
                  typeof item.predicate_match !== 'boolean' ||
                  typeof item.entails !== 'boolean'
            )
          ) {
            throw new RerankProtocolError(
              'Ollama 重排返回了无效或重复的 decision',
            );
          }
          const subjectMatch = compact
            ? (checks & 1) === 1
            : item.subject_match as boolean;
          const predicateMatch = compact
            ? (checks & 2) === 2
            : item.predicate_match as boolean;
          const entails = compact
            ? (checks & 4) === 4
            : item.entails as boolean;
          modelDecisions.set(index, {
            index,
            relevant: compact ? checks === 7 : item.relevant as boolean,
            confidence,
            subjectMatch,
            predicateMatch,
            entails,
          });
        }
        if (modelDecisions.size !== batch.length) {
          throw new RerankProtocolError('Ollama 重排遗漏了候选 decision');
        }
      } else if (Array.isArray(parsed.relevant_indexes)) {
        const relevantIndexes = new Set<number>();
        for (const value of parsed.relevant_indexes) {
          const index = Number(value);
          if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= batch.length ||
            relevantIndexes.has(index)
          ) {
            throw new RerankProtocolError(
              'Ollama 重排返回了无效或重复的 index',
            );
          }
          relevantIndexes.add(index);
        }
        for (let index = 0; index < batch.length; index += 1) {
          const relevant = relevantIndexes.has(index);
          modelDecisions.set(index, {
            index,
            relevant,
            confidence: 1,
            subjectMatch: relevant,
            predicateMatch: relevant,
            entails: relevant,
          });
        }
      } else {
        throw new RerankProtocolError('Ollama 重排返回缺少 decisions');
      }
      for (let index = 0; index < batch.length; index += 1) {
        const modelDecision = modelDecisions.get(index)!;
        const relevant = modelDecision.relevant &&
          modelDecision.subjectMatch &&
          modelDecision.predicateMatch &&
          modelDecision.entails;
        const failedChecks = [
          !modelDecision.subjectMatch ? 'subject_mismatch' : '',
          !modelDecision.predicateMatch ? 'predicate_mismatch' : '',
          !modelDecision.entails ? 'not_entailed' : '',
        ].filter(Boolean);
        decisions.push({
          id: batch[index].id,
          relevant,
          confidence: modelDecision.confidence,
          reason: relevant
            ? 'model_selected:subject_predicate_entailment_passed'
            : failedChecks.length > 0
              ? `model_rejected:${failedChecks.join(',')}`
              : 'model_rejected:not_relevant',
        });
      }
      } catch (error) {
        if (
          !(error instanceof RerankProtocolError) ||
          batch.length <= 1 ||
          options.recoveryDepth >= MAX_RERANK_RECOVERY_DEPTH
        ) {
          throw providerOperationError(
            error,
            providerCalls,
            providerStarted,
            modelSamples,
            {
              baseProviderCalls,
              firstCandidateConfirmationCalls,
              protocolRecoveryCalls,
              protocolRecoveryMaxDepth,
              parallelBatchCount: 1,
            },
          );
        }
        const midpoint = Math.ceil(batch.length / 2);
        const split = await Promise.allSettled([
          this.rerankModelUncached(query, batch.slice(0, midpoint), {
            singleBatch: true,
            callKind: 'recovery',
            recoveryDepth: options.recoveryDepth + 1,
            runProviderCall: options.runProviderCall,
            callBudget: options.callBudget,
          }),
          this.rerankModelUncached(query, batch.slice(midpoint), {
            singleBatch: true,
            callKind: 'recovery',
            recoveryDepth: options.recoveryDepth + 1,
            runProviderCall: options.runProviderCall,
            callBudget: options.callBudget,
          }),
        ]);
        let splitFailure: unknown = null;
        for (const result of split) {
          if (result.status === 'fulfilled') {
            providerCalls += result.value.providerCalls;
            baseProviderCalls += result.value.baseProviderCalls || 0;
            protocolRecoveryCalls +=
              result.value.protocolRecoveryCalls || 0;
            protocolRecoveryMaxDepth = Math.max(
              protocolRecoveryMaxDepth,
              result.value.protocolRecoveryMaxDepth || 0,
            );
            modelSamples.push(...result.value.modelSamples);
            decisions.push(...result.value.result);
            continue;
          }
          const failure = result.reason instanceof ProviderOperationError
            ? result.reason
            : providerOperationError(
              result.reason,
              0,
              providerStarted,
              [],
            );
          providerCalls += failure.providerCalls;
          baseProviderCalls += failure.baseProviderCalls;
          protocolRecoveryCalls += failure.protocolRecoveryCalls;
          protocolRecoveryMaxDepth = Math.max(
            protocolRecoveryMaxDepth,
            failure.protocolRecoveryMaxDepth,
          );
          modelSamples.push(...failure.modelSamples);
          splitFailure ||= failure;
        }
        if (splitFailure) {
          const failure = splitFailure as ProviderOperationError;
          throw new ProviderOperationError(
            failure.message,
            failure.code,
            providerCalls,
            Number((performance.now() - providerStarted).toFixed(3)),
            [...modelSamples],
            failure,
            {
              baseProviderCalls,
              firstCandidateConfirmationCalls,
              protocolRecoveryCalls,
              protocolRecoveryMaxDepth,
              parallelBatchCount: 1,
            },
          );
        }
      }
    }
    return {
      result: decisions,
      providerCalls,
      providerDurationMs: Number(
        (performance.now() - providerStarted).toFixed(3),
      ),
      modelSamples,
      baseProviderCalls,
      firstCandidateConfirmationCalls,
      protocolRecoveryCalls,
      protocolRecoveryMaxDepth,
      parallelBatchCount: 1,
    };
  }

  async rewrite(query: string): Promise<string[]> {
    return (await this.rewriteWithTelemetry(query)).result;
  }

  async rewriteWithTelemetry(
    query: string,
  ): Promise<SemanticOperationResult<string[]>> {
    const started = performance.now();
    const normalizedQuery = query.normalize('NFKC').trim();
    const key = this.cacheKey({
      protocol: 'rewrite-v1',
      model: this.rerankModel,
      query: normalizedQuery,
    });
    const complete = (
      operation: ProviderOperationResult<string[]>,
    ): SemanticOperationResult<string[]> => ({
      result: [...operation.result],
      telemetry: {
        route: 'model',
        providerCalls: operation.providerCalls,
        cacheHit: false,
        singleFlightShared: false,
        keyFingerprint: key,
        requestDurationMs: Number(
          (performance.now() - started).toFixed(3),
        ),
        providerDurationMs: operation.providerDurationMs,
        model: aggregateModelTelemetry(operation.modelSamples),
      },
    });
    if (this.cacheTtlMs === 0) {
      try {
        return complete(await this.rewriteUncached(normalizedQuery));
      } catch (error) {
        throw semanticOperationError(
          error,
          'rewrite',
          key,
          started,
        );
      }
    }
    const now = Date.now();
    this.pruneCache(this.rewriteCache, now);
    const existing = this.rewriteCache.get(key);
    if (existing && existing.expiresAt > now) {
      const singleFlightShared = !existing.settled;
      if (singleFlightShared) {
        this.cacheCounters.rewriteSingleFlightShares += 1;
      } else {
        this.cacheCounters.rewriteHits += 1;
      }
      try {
        const operation = await existing.promise;
        return {
          result: [...operation.result],
          telemetry: {
            route: 'cache',
            providerCalls: 0,
            cacheHit: !singleFlightShared,
            singleFlightShared,
            keyFingerprint: key,
            requestDurationMs: Number(
              (performance.now() - started).toFixed(3),
            ),
            providerDurationMs: null,
            model: null,
          },
        };
      } catch (error) {
        throw semanticOperationError(
          error,
          'rewrite',
          key,
          started,
          {
            route: 'cache',
            providerCalls: 0,
            cacheHit: !singleFlightShared,
            singleFlightShared,
            providerDurationMs: null,
            model: null,
          },
        );
      }
    }
    const entry = {
      expiresAt: Number.POSITIVE_INFINITY,
      settled: false,
      promise: this.rewriteUncached(normalizedQuery),
    };
    this.rewriteCache.set(key, entry);
    try {
      const operation = await entry.promise;
      entry.settled = true;
      entry.expiresAt = Date.now() + this.cacheTtlMs;
      this.pruneCache(this.rewriteCache);
      return complete(operation);
    } catch (error) {
      if (this.rewriteCache.get(key)?.promise === entry.promise) {
        this.rewriteCache.delete(key);
      }
      throw semanticOperationError(
        error,
        'rewrite',
        key,
        started,
      );
    }
  }

  private async rewriteUncached(
    query: string,
  ): Promise<ProviderOperationResult<string[]>> {
    const providerStarted = performance.now();
    let payload: OllamaChatResponse | null = null;
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: backgroundModelAbortSignal(this.timeoutMs),
          body: JSON.stringify({
            model: this.rerankModel,
            stream: false,
            think: false,
            keep_alive: config.modelKeepAlive,
            format: REWRITE_FORMAT,
            options: {
              temperature: 0,
              seed: 42,
              num_predict: 128,
            },
            messages: [
              { role: 'system', content: REWRITE_SYSTEM_PROMPT },
              { role: 'user', content: query },
            ],
          }),
        },
      );
      if (!response.ok) {
        throw new ProviderCallError(
          `Ollama 查询改写请求失败：HTTP ${response.status}`,
          'provider_http_error',
        );
      }
      try {
        payload = await response.json() as OllamaChatResponse;
      } catch (error) {
        throw new ProviderCallError(
          'Ollama 查询改写返回的 JSON 无法解析',
          'provider_protocol_error',
          error,
        );
      }
      if (typeof payload.message?.content !== 'string') {
        throw new ProviderCallError(
          'Ollama 查询改写没有返回文本结果',
          'provider_protocol_error',
        );
      }
      let parsed: { rewrites?: unknown };
      try {
        parsed = JSON.parse(payload.message.content) as {
          rewrites?: unknown;
        };
      } catch (error) {
        throw new ProviderCallError(
          'Ollama 查询改写返回的 JSON 无法解析',
          'provider_protocol_error',
          error,
        );
      }
      if (!Array.isArray(parsed.rewrites)) {
        throw new ProviderCallError(
          'Ollama 查询改写返回缺少 rewrites',
          'provider_protocol_error',
        );
      }
      const normalized = parsed.rewrites
        .map((value) => String(value ?? '').normalize('NFKC').trim())
        .filter(Boolean);
      if (normalized.length > 3) {
        throw new ProviderCallError(
          'Ollama 查询改写返回数量超过上限',
          'provider_protocol_error',
        );
      }
      return {
        result: [...new Set(normalized)],
        providerCalls: 1,
        providerDurationMs: Number(
          (performance.now() - providerStarted).toFixed(3),
        ),
        modelSamples: [modelTelemetry(payload)],
      };
    } catch (error) {
      throw providerOperationError(
        error,
        1,
        providerStarted,
        payload ? [modelTelemetry(payload)] : [],
      );
    }
  }
}

export function createConfiguredSemanticRanker(
  embeddingModel = config.embeddingModel,
):
  | SemanticRanker
  | undefined {
  if (config.semanticMode === 'off') return undefined;
  return new OllamaSemanticRanker({
    baseUrl: config.ollamaBaseUrl,
    embeddingModel,
    rerankModel: config.rerankModel,
    embedBatchSize: config.semanticEmbedBatchSize,
    rerankBatchSize: config.semanticRerankBatchSize,
    timeoutMs: config.semanticTimeoutMs,
    cacheTtlMs: config.semanticCacheTtlMs,
    cacheMaxEntries: config.semanticCacheMaxEntries,
    rerankConcurrency: config.semanticRerankConcurrency,
    ...(config.semanticRerankProvider === 'cross_encoder'
      ? {
        crossEncoder: {
          baseUrl: config.crossEncoderBaseUrl,
          model: config.crossEncoderModel,
          batchSize: config.crossEncoderBatchSize,
          timeoutMs: config.crossEncoderTimeoutMs,
          confidenceScale: config.crossEncoderConfidenceScale,
        },
      }
      : {}),
  });
}
