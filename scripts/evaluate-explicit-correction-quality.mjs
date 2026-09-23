import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CandidateResolver,
} from '../dist/server/candidate-resolver.js';
import {
  OllamaClaimRelationClassifier,
} from '../dist/server/claim-relation-classifier.js';
import {
  openDatabase,
} from '../dist/server/database.js';
import {
  ExplicitMemoryIntentService,
  OllamaExplicitMemoryIntentProvider,
} from '../dist/server/explicit-memory-intent.js';
import {
  LifecycleStore,
} from '../dist/server/lifecycle-store.js';
import {
  OllamaMemoryExtractor,
} from '../dist/server/memory-extractor.js';
import {
  MemoryStore,
} from '../dist/server/memory-store.js';
import {
  OllamaSemanticRanker,
} from '../dist/server/semantic-ranker.js';

const EVALUATOR_VERSION =
  'explicit-correction-quality-evaluator-v1';
const OLLAMA_URL = 'http://127.0.0.1:11434';
const GENERATION_MODEL = 'qwen2.5:14b';
const EMBEDDING_MODEL = 'bge-m3:latest';
const EXTRACTION_PROMPT_VERSION = 'extract-v6';
const INTENT_PROMPT_VERSION = 'explicit-memory-intent-v2';
const RELATION_PROMPT_VERSION = 'claim-relation-v1';
const ROUND_COUNT = 3;
const TIMEOUT_MS = 300_000;
const EXPECTED_CORRECTED_VALUE = '自动导入一套最小示例数据';

const INITIAL_TEXT = [
  '我做新软件时从来不接受内置演示数据，第一次打开必须是空数据。',
  '这是我所有客户项目一直遵守的原则。今天先聊聊交付节奏吧。',
].join('\n');

const CORRECTION_TEXT =
  '我现在的项目原则变了：新软件第一次打开不再要求空数据，' +
  '今后应该自动导入一套最小示例数据，方便客户马上体验。';

function normalizeText(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim()
    : '';
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function queryRows(database, statement, ...values) {
  return database.prepare(statement).all(...values);
}

function databaseEvidence(database) {
  return {
    memoryItems: queryRows(
      database,
      `SELECT i.id, i.status, i.revision, i.current_version_id,
              i.predicate_key, i.normalized_value,
              m.status AS memory_status, m.content
       FROM memory_items i
       JOIN memories m ON m.id = i.id
       ORDER BY i.created_at ASC, i.id ASC`,
    ),
    memoryVersions: queryRows(
      database,
      `SELECT id, memory_item_id, version, content, superseded_at
       FROM memory_versions
       ORDER BY memory_item_id ASC, version ASC`,
    ),
    candidates: queryRows(
      database,
      `SELECT id, state, kind, subject, predicate, value_text,
              source_excerpt, explicit_correction,
              resolved_memory_item_id, decision_reason
       FROM memory_candidates
       ORDER BY created_at ASC, id ASC`,
    ),
    actionRequests: queryRows(
      database,
      `SELECT id, action, status, target_query, target_memory_id,
              candidate_id, model, prompt_version, rationale, error
       FROM memory_action_requests
       ORDER BY created_at ASC, id ASC`,
    ),
    resolveCandidateJobs: queryRows(
      database,
      `SELECT id, status, attempts, last_error
       FROM memory_jobs
       WHERE job_type = 'resolve_candidate'
       ORDER BY created_at ASC, id ASC`,
    ),
  };
}

async function assertOllamaReady() {
  let response;
  try {
    response = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new Error(
      `Ollama 不可用（${OLLAMA_URL}）：${errorMessage(error)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Ollama 模型列表请求失败：${response.status} ` +
      await response.text(),
    );
  }
  const payload = await response.json();
  const availableModels = Array.isArray(payload.models)
    ? payload.models
        .map((model) => normalizeText(model?.name || model?.model))
        .filter(Boolean)
    : [];
  for (const requiredModel of [
    GENERATION_MODEL,
    EMBEDDING_MODEL,
  ]) {
    assert.ok(
      availableModels.includes(requiredModel),
      `Ollama 缺少固定验收模型 ${requiredModel}`,
    );
  }
  return availableModels;
}

function createComponents(database) {
  const ranker = new OllamaSemanticRanker({
    baseUrl: OLLAMA_URL,
    embeddingModel: EMBEDDING_MODEL,
    rerankModel: GENERATION_MODEL,
    embedBatchSize: 64,
    rerankBatchSize: 16,
    timeoutMs: TIMEOUT_MS,
  });
  const memoryStore = new MemoryStore(database, ranker);
  const lifecycleStore = new LifecycleStore(database);
  const candidateResolver = new CandidateResolver(
    database,
    lifecycleStore,
    memoryStore,
    {
      mode: 'auto',
      embeddingProvider: ranker,
      classifier: new OllamaClaimRelationClassifier({
        baseUrl: OLLAMA_URL,
        model: GENERATION_MODEL,
        promptVersion: RELATION_PROMPT_VERSION,
        timeoutMs: TIMEOUT_MS,
      }),
    },
  );
  const extractor = new OllamaMemoryExtractor({
    baseUrl: OLLAMA_URL,
    model: GENERATION_MODEL,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    timeoutMs: TIMEOUT_MS,
  });
  return {
    ranker,
    memoryStore,
    lifecycleStore,
    candidateResolver,
    extractor,
  };
}

async function runRound(roundNumber) {
  const directory = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      `memory-bridge-explicit-correction-round-${roundNumber}-`,
    ),
  );
  const databasePath = path.join(
    directory,
    `round-${roundNumber}.sqlite3`,
  );
  const report = {
    round: roundNumber,
    passed: false,
    databasePath,
    databaseCleaned: false,
    initialExtraction: null,
    initialResolution: null,
    rawStructuredDecision: null,
    serviceResult: null,
    oldMemoryId: null,
    finalMemoryId: null,
    finalRevision: null,
    currentValue: null,
    versions: [],
    assertions: null,
    failureEvidence: null,
    error: null,
  };
  let database;
  try {
    database = openDatabase(databasePath);
    const {
      memoryStore,
      lifecycleStore,
      candidateResolver,
      extractor,
    } = createComponents(database);
    const userId = `explicit-correction-quality-user-${roundNumber}`;
    const namespace =
      `explicit-correction-quality-namespace-${roundNumber}`;

    const initialTurn = lifecycleStore.recordTurn({
      userId,
      namespace,
      clientName: 'explicit-correction-quality-gate',
      sessionExternalId: `initial-session-${roundNumber}`,
      turnExternalId: `initial-turn-${roundNumber}`,
      role: 'user',
      content: INITIAL_TEXT,
      metadata: {
        evaluator: EVALUATOR_VERSION,
        round: roundNumber,
      },
    }).turn;
    const extracted = await extractor.extract(initialTurn);
    report.initialExtraction = {
      count: extracted.length,
      candidates: extracted,
    };
    assert.equal(
      extracted.length,
      1,
      `第 ${roundNumber} 轮初始语句必须提取唯一候选`,
    );

    const initialRunId = lifecycleStore.startExtraction(
      initialTurn.id,
      extractor.model,
      extractor.promptVersion,
      extractor.extractorId,
      extractor.extractorVersion,
    );
    const persistedInitial = lifecycleStore.completeExtraction(
      initialRunId,
      extracted,
      { enqueueResolution: false },
    );
    assert.equal(
      persistedInitial.length,
      1,
      `第 ${roundNumber} 轮初始候选必须唯一持久化`,
    );
    assert.ok(
      normalizeText(persistedInitial[0].sourceExcerpt),
      `第 ${roundNumber} 轮初始候选缺少持久化来源摘录`,
    );

    const initialResolution = await candidateResolver.resolve(
      persistedInitial[0].id,
    );
    report.initialResolution = initialResolution;
    assert.equal(
      initialResolution.state,
      'accepted',
      `第 ${roundNumber} 轮初始候选未自动接受`,
    );
    assert.ok(
      normalizeText(initialResolution.memoryId),
      `第 ${roundNumber} 轮初始候选未生成记忆 UUID`,
    );
    const oldMemoryId = initialResolution.memoryId;
    report.oldMemoryId = oldMemoryId;

    const initialItems = queryRows(
      database,
      `SELECT id, status, revision
       FROM memory_items
       ORDER BY id ASC`,
    );
    assert.equal(
      initialItems.length,
      1,
      `第 ${roundNumber} 轮初始解析后必须只有一个 memory_item`,
    );
    assert.equal(initialItems[0].id, oldMemoryId);
    assert.equal(initialItems[0].status, 'active');
    assert.equal(initialItems[0].revision, 1);
    assert.equal(
      memoryStore.history(oldMemoryId, userId).length,
      1,
      `第 ${roundNumber} 轮初始记忆必须只有一个版本`,
    );

    const realIntentProvider =
      new OllamaExplicitMemoryIntentProvider({
        baseUrl: OLLAMA_URL,
        model: GENERATION_MODEL,
        promptVersion: INTENT_PROMPT_VERSION,
        timeoutMs: TIMEOUT_MS,
      });
    const observingProvider = {
      model: realIntentProvider.model,
      promptVersion: realIntentProvider.promptVersion,
      async classify(userText, actionHint) {
        const decision = await realIntentProvider.classify(
          userText,
          actionHint,
        );
        report.rawStructuredDecision = structuredClone(decision);
        return decision;
      },
    };
    const intentService = new ExplicitMemoryIntentService(
      database,
      lifecycleStore,
      memoryStore,
      candidateResolver,
      observingProvider,
    );
    const serviceResult = await intentService.handle({
      userId,
      namespace,
      clientName: 'explicit-correction-quality-gate',
      sessionExternalId: `correction-session-${roundNumber}`,
      userTurnExternalId: `correction-turn-${roundNumber}`,
      userText: CORRECTION_TEXT,
    });
    report.serviceResult = serviceResult;

    const decision = report.rawStructuredDecision;
    assert.ok(
      decision,
      `第 ${roundNumber} 轮没有获得真实结构化意图结果`,
    );
    assert.equal(
      decision.action,
      'correct',
      `第 ${roundNumber} 轮真实模型未判定为 correct`,
    );
    assert.ok(
      normalizeText(decision.targetQuery),
      `第 ${roundNumber} 轮 correct 的 targetQuery 为空`,
    );
    assert.ok(
      decision.candidate,
      `第 ${roundNumber} 轮 correct 缺少 candidate`,
    );
    const rawSourceExcerpt = normalizeText(
      decision.candidate.sourceExcerpt,
    );
    assert.ok(
      rawSourceExcerpt,
      `第 ${roundNumber} 轮 candidate.sourceExcerpt 为空`,
    );
    assert.ok(
      normalizeText(CORRECTION_TEXT).includes(rawSourceExcerpt),
      `第 ${roundNumber} 轮 sourceExcerpt 不是纠正原文的 NFKC 子串`,
    );
    assert.equal(serviceResult.action, 'correct');
    assert.equal(
      serviceResult.status,
      'completed',
      `第 ${roundNumber} 轮纠正服务未完成：${serviceResult.reason}`,
    );
    assert.equal(serviceResult.memoryId, oldMemoryId);
    assert.ok(serviceResult.candidateId);
    assert.ok(serviceResult.actionRequestId);

    const correctionCandidate = database
      .prepare(
        `SELECT id, state, source_excerpt, resolved_memory_item_id
         FROM memory_candidates
         WHERE id = ?`,
      )
      .get(serviceResult.candidateId);
    assert.ok(correctionCandidate);
    assert.ok(
      normalizeText(correctionCandidate.source_excerpt),
      `第 ${roundNumber} 轮持久化纠正候选缺少 source_excerpt`,
    );
    assert.equal(correctionCandidate.state, 'accepted');
    assert.equal(
      correctionCandidate.resolved_memory_item_id,
      oldMemoryId,
    );

    const actionRequest = database
      .prepare(
        `SELECT action, status, target_query, target_memory_id,
                candidate_id
         FROM memory_action_requests
         WHERE id = ?`,
      )
      .get(serviceResult.actionRequestId);
    assert.ok(actionRequest);
    assert.equal(actionRequest.action, 'correct');
    assert.equal(actionRequest.status, 'completed');
    assert.equal(actionRequest.target_memory_id, oldMemoryId);
    assert.equal(
      actionRequest.candidate_id,
      serviceResult.candidateId,
    );
    assert.ok(normalizeText(actionRequest.target_query));

    const memoryItems = queryRows(
      database,
      `SELECT id, status, revision, current_version_id,
              normalized_value
       FROM memory_items
       ORDER BY id ASC`,
    );
    const activeMemoryItems = memoryItems.filter(
      (item) => item.status === 'active',
    );
    assert.equal(memoryItems.length, 1);
    assert.equal(activeMemoryItems.length, 1);
    assert.equal(memoryItems[0].id, oldMemoryId);
    assert.equal(memoryItems[0].revision, 2);
    assert.equal(
      memoryItems[0].normalized_value,
      EXPECTED_CORRECTED_VALUE,
    );

    const memoryIds = queryRows(
      database,
      `SELECT id
       FROM memories
       ORDER BY id ASC`,
    ).map((row) => row.id);
    assert.deepEqual(memoryIds, [oldMemoryId]);

    const versions = queryRows(
      database,
      `SELECT id, memory_item_id, version, content, superseded_at
       FROM memory_versions
       WHERE memory_item_id = ?
       ORDER BY version ASC`,
      oldMemoryId,
    );
    assert.equal(versions.length, 2);
    assert.equal(versions[0].version, 1);
    assert.ok(versions[0].superseded_at);
    assert.equal(versions[1].version, 2);
    assert.equal(versions[1].superseded_at, null);
    assert.equal(
      memoryItems[0].current_version_id,
      versions[1].id,
    );

    const resolveCandidateJobs = queryRows(
      database,
      `SELECT id, status
       FROM memory_jobs
       WHERE job_type = 'resolve_candidate'`,
    );
    const unsafeResolutionJobs = resolveCandidateJobs.filter(
      (job) => ['pending', 'running', 'failed'].includes(job.status),
    );
    assert.equal(unsafeResolutionJobs.length, 0);
    assert.equal(resolveCandidateJobs.length, 0);

    report.finalMemoryId = memoryItems[0].id;
    report.finalRevision = memoryItems[0].revision;
    report.currentValue = memoryItems[0].normalized_value;
    report.versions = versions.map((version) => ({
      id: version.id,
      version: version.version,
      content: version.content,
      supersededAt: version.superseded_at,
    }));
    report.assertions = {
      oneMemoryItem: true,
      oneActiveMemoryItem: true,
      stableUuidPreserved: true,
      revisionTwo: true,
      exactlyTwoVersions: true,
      firstVersionSuperseded: true,
      secondVersionCurrent: true,
      correctedValueExact: true,
      correctionCandidateBoundToOldUuid: true,
      actionRequestCompletedForOldUuid: true,
      noSecondUuid: true,
      noResolveCandidateJobs: true,
    };
    report.passed = true;
  } catch (error) {
    report.error = errorMessage(error);
    if (database) {
      try {
        report.failureEvidence = databaseEvidence(database);
      } catch (evidenceError) {
        report.failureEvidence = {
          collectionError: errorMessage(evidenceError),
        };
      }
    }
  } finally {
    if (database) {
      try {
        database.close();
      } catch (closeError) {
        report.error ||= `数据库关闭失败：${errorMessage(closeError)}`;
        report.passed = false;
      }
    }
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      report.databaseCleaned = !fs.existsSync(directory);
    } catch (cleanupError) {
      report.error ||= `临时数据库清理失败：${errorMessage(cleanupError)}`;
      report.passed = false;
    }
  }
  console.log(JSON.stringify({
    event: 'explicit-correction-quality-round',
    ...report,
  }, null, 2));
  return report;
}

async function main() {
  const startedAt = new Date().toISOString();
  let availableModels;
  try {
    availableModels = await assertOllamaReady();
  } catch (error) {
    console.error(JSON.stringify({
      passed: false,
      evaluatorVersion: EVALUATOR_VERSION,
      ollamaUrl: OLLAMA_URL,
      models: {
        generation: GENERATION_MODEL,
        embedding: EMBEDDING_MODEL,
        rerank: GENERATION_MODEL,
      },
      roundsRequired: ROUND_COUNT,
      roundsCompleted: 0,
      error: errorMessage(error),
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const rounds = [];
  for (let round = 1; round <= ROUND_COUNT; round += 1) {
    rounds.push(await runRound(round));
  }
  const passed =
    rounds.length === ROUND_COUNT &&
    rounds.every(
      (round) => round.passed && round.databaseCleaned,
    );
  const report = {
    passed,
    evaluatorVersion: EVALUATOR_VERSION,
    ollamaUrl: OLLAMA_URL,
    models: {
      generation: GENERATION_MODEL,
      extraction: GENERATION_MODEL,
      explicitIntent: GENERATION_MODEL,
      relation: GENERATION_MODEL,
      embedding: EMBEDDING_MODEL,
      rerank: GENERATION_MODEL,
    },
    promptVersions: {
      extraction: EXTRACTION_PROMPT_VERSION,
      explicitIntent: INTENT_PROMPT_VERSION,
      relation: RELATION_PROMPT_VERSION,
    },
    roundsRequired: ROUND_COUNT,
    roundsCompleted: rounds.length,
    roundsPassed: rounds.filter((round) => round.passed).length,
    allTemporaryDatabasesCleaned: rounds.every(
      (round) => round.databaseCleaned,
    ),
    availableModels,
    startedAt,
    completedAt: new Date().toISOString(),
    rounds,
  };
  const output = JSON.stringify(report, null, 2);
  if (passed) {
    console.log(output);
  } else {
    console.error(output);
    process.exitCode = 1;
  }
}

await main();
