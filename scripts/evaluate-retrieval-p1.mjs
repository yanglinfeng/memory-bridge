import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../dist/server/database.js';
import { LifecycleStore } from '../dist/server/lifecycle-store.js';
import { MemoryConsolidator } from '../dist/server/memory-consolidator.js';
import { MemoryStore } from '../dist/server/memory-store.js';
import {
  createConfiguredSemanticRanker,
} from '../dist/server/semantic-ranker.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const datasetPath = path.join(
  scriptDirectory,
  'fixtures',
  'retrieval-p1-quality-v1.json',
);
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'memory-bridge-retrieval-p1-'),
);
const database = openDatabase(path.join(directory, 'evaluation.sqlite3'));

function percentile(values, percentileValue) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((percentileValue / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}

function metricsFor(cases, key) {
  const positives = cases.filter((item) => item.expectedIds.length > 0);
  const negatives = cases.filter((item) => item.expectedIds.length === 0);
  const reciprocalRanks = positives.map((item) => {
    const rank = item[key].findIndex((id) => item.expectedIds.includes(id));
    return rank === -1 ? 0 : 1 / (rank + 1);
  });
  const discountedGains = positives.map((item) => {
    const rank = item[key].findIndex((id) => item.expectedIds.includes(id));
    return rank === -1 ? 0 : 1 / Math.log2(rank + 2);
  });
  const hits = reciprocalRanks.filter((score) => score > 0).length;
  const zeroResultCorrect = negatives.filter(
    (item) => item[key].length === 0,
  ).length;
  const forbiddenHits = cases.reduce(
    (count, item) => count + item[key].filter(
      (id) => item.forbiddenIds.includes(id),
    ).length,
    0,
  );
  const unexpectedHits = cases.reduce(
    (count, item) => count + item[key].filter(
      (id) => !item.expectedIds.includes(id),
    ).length,
    0,
  );
  const missingRequired = cases.reduce(
    (count, item) => count + item.requiredIds.filter(
      (id) => !item[key].includes(id),
    ).length,
    0,
  );
  return {
    positiveQueryCount: positives.length,
    negativeQueryCount: negatives.length,
    recallAt5: positives.length === 0 ? 1 : hits / positives.length,
    mrrAt5: positives.length === 0
      ? 1
      : reciprocalRanks.reduce((sum, score) => sum + score, 0) /
        positives.length,
    ndcgAt5: positives.length === 0
      ? 1
      : discountedGains.reduce((sum, score) => sum + score, 0) /
        positives.length,
    lowRecallRate: positives.length === 0
      ? 0
      : (positives.length - hits) / positives.length,
    zeroResultRate: cases.filter((item) => item[key].length === 0).length /
      Math.max(1, cases.length),
    negativeAbstentionAccuracy: negatives.length === 0
      ? 1
      : zeroResultCorrect / negatives.length,
    forbiddenHitCount: forbiddenHits,
    unexpectedHitCount: unexpectedHits,
    missingRequiredCount: missingRequired,
  };
}

const baseRanker = createConfiguredSemanticRanker();
if (!baseRanker) {
  throw new Error('语义模式已关闭，无法运行 P1 检索评测');
}
const modelCalls = {
  embedCalls: 0,
  embedItems: 0,
  rerankCalls: 0,
  rerankCandidates: 0,
  rewriteCalls: 0,
};
const ranker = {
  embeddingModel: baseRanker.embeddingModel,
  rerankModel: baseRanker.rerankModel,
  async embed(texts) {
    modelCalls.embedCalls += 1;
    modelCalls.embedItems += texts.length;
    return baseRanker.embed(texts);
  },
  async rerank(query, candidates) {
    modelCalls.rerankCalls += 1;
    modelCalls.rerankCandidates += candidates.length;
    return baseRanker.rerank(query, candidates);
  },
  async rewrite(query) {
    modelCalls.rewriteCalls += 1;
    return typeof baseRanker.rewrite === 'function'
      ? baseRanker.rewrite(query)
      : [];
  },
};

try {
  const store = new MemoryStore(database, ranker);
  const ids = new Map();
  for (const fixture of dataset.memories) {
    const supersedesId = fixture.supersedesLabel
      ? ids.get(fixture.supersedesLabel)
      : undefined;
    const memory = store.remember({
      namespace: 'evaluation',
      kind: fixture.kind,
      content: fixture.content,
      stableKey: fixture.stableKey,
      scopeType: fixture.scopeType,
      scopeKey: fixture.scopeKey,
      source: fixture.source || 'retrieval-p1-evaluation',
      sourceRef: fixture.sourceRef,
      supersedesId,
    }).memory;
    ids.set(fixture.label, memory.id);
  }

  const consolidationProvider = {
    model: 'deterministic-evaluation-provider',
    promptVersion: 'retrieval-p1-quality-v1',
    async consolidate(_scope, sources) {
      return {
        sentences: [{
          text: '用户希望开发任务先给结论，只附必要证据，并避免冗长复述。',
          sourceVersionIds: sources.map((source) => source.memoryVersionId),
        }],
      };
    },
    async verifySupport(_scope, _sources, sentences) {
      return sentences.map((_sentence, sentenceIndex) => ({
        sentenceIndex,
        supported: true,
        rationale: '固定评测来源逐句支持',
      }));
    },
  };
  const consolidation = await new MemoryConsolidator(
    database,
    new LifecycleStore(database),
    store,
    consolidationProvider,
    2,
    40,
    2,
  ).consolidateScope({
    userId: 'default',
    namespace: 'evaluation',
    scopeType: 'topic',
    scopeKey: 'kind:event',
    accessScopeType: 'personal',
    accessScopeKey: 'self',
  });
  if (consolidation.status !== 'created' || !consolidation.memoryId) {
    throw new Error('P1 评测库未生成有效的证据约束派生摘要');
  }
  ids.set('consolidated-work-style', consolidation.memoryId);

  let denseBackfill = await store.backfillDenseIndex(
    256,
    undefined,
    undefined,
    'evaluation',
  );
  while (!denseBackfill.complete && denseBackfill.processed > 0) {
    denseBackfill = await store.backfillDenseIndex(
      256,
      undefined,
      undefined,
      'evaluation',
    );
  }
  if (!denseBackfill.complete) {
    throw new Error('P1 评测库 Dense 索引回填未完成');
  }
  const labelsById = new Map(
    [...ids.entries()].map(([label, id]) => [id, label]),
  );

  Object.keys(modelCalls).forEach((key) => {
    modelCalls[key] = 0;
  });
  const cases = [];
  for (const fixture of dataset.queries) {
    const input = {
      namespace: 'evaluation',
      query: fixture.query,
      scopes: fixture.scopes,
      limit: 5,
    };
    const baselineIds = store.recall(input)
      .slice(0, 5)
      .map((result) => result.memory.id);
    const started = performance.now();
    const reliable = await store.recallReliable(input);
    const durationMs = performance.now() - started;
    const resultIds = reliable.slice(0, 5)
      .map((result) => result.memory.id);
    const latestTrace = store.listRetrievalTraces({ limit: 1 })[0];
    const traceId = reliable[0]?.traceId || latestTrace?.traceId || null;
    const expectedIds = fixture.expectedLabels.map((label) => ids.get(label));
    const requiredIds = (fixture.requiredLabels || [])
      .map((label) => ids.get(label));
    const missingExpected = expectedIds.some(
      (id) => !resultIds.includes(id),
    );
    const unexpected = resultIds.some((id) => !expectedIds.includes(id));
    const trace = traceId && (missingExpected || unexpected)
      ? store.getRetrievalTrace(traceId)
      : null;
    const eventDetail = (stage) => trace?.events.find(
      (event) => event.stage === stage,
    )?.detail || null;
    const rerankDetail = eventDetail('rerank');
    cases.push({
      caseId: fixture.caseId,
      category: fixture.category,
      expectedIds,
      requiredIds,
      forbiddenIds: (fixture.forbiddenLabels || [])
        .map((label) => ids.get(label)),
      baselineIds,
      resultIds,
      expectedLabels: fixture.expectedLabels,
      requiredLabels: fixture.requiredLabels || [],
      resultLabels: resultIds.map((id) => labelsById.get(id) || id),
      durationMs,
      traceId,
      failureDiagnostic: trace ? {
        rewrite: eventDetail('rewrite'),
        channels: eventDetail('channels'),
        semantic: eventDetail('semantic'),
        rerank: rerankDetail && {
          ...rerankDetail,
          decisions: Array.isArray(rerankDetail.decisions)
            ? rerankDetail.decisions.map((decision) => ({
              ...decision,
              label: labelsById.get(decision.memoryId) ||
                decision.memoryId,
            }))
            : rerankDetail.decisions,
        },
        selection: eventDetail('selection'),
      } : null,
    });
  }

  const baseline = metricsFor(cases, 'baselineIds');
  const p1 = metricsFor(cases, 'resultIds');
  const durations = cases.map((item) => item.durationMs);
  const gate = {
    recallNotWorseThanBaseline:
      p1.recallAt5 + Number.EPSILON >= baseline.recallAt5,
    recallAt5AtLeast80Percent: p1.recallAt5 >= 0.8,
    mrrAt5AtLeast70Percent: p1.mrrAt5 >= 0.7,
    noForbiddenHits: p1.forbiddenHitCount === 0,
    noUnexpectedHits: p1.unexpectedHitCount === 0,
    allRequiredHits: p1.missingRequiredCount === 0,
    negativeCaseAbstained: p1.negativeAbstentionAccuracy === 1,
  };
  const report = {
    datasetId: dataset.datasetId,
    warning: dataset.description,
    models: {
      embedding: ranker.embeddingModel,
      rerank: ranker.rerankModel,
    },
    denseIndex: {
      generationId: denseBackfill.generationId,
      eligible: denseBackfill.eligible,
      indexed: denseBackfill.indexed,
      complete: denseBackfill.complete,
    },
    queryCount: cases.length,
    baseline,
    p1,
    delta: {
      recallAt5: p1.recallAt5 - baseline.recallAt5,
      mrrAt5: p1.mrrAt5 - baseline.mrrAt5,
      ndcgAt5: p1.ndcgAt5 - baseline.ndcgAt5,
      zeroResultRate: p1.zeroResultRate - baseline.zeroResultRate,
    },
    latencyMs: {
      average: durations.reduce((sum, value) => sum + value, 0) /
        Math.max(1, durations.length),
      p95: percentile(durations, 95),
      maximum: Math.max(...durations, 0),
    },
    modelCalls: {
      ...modelCalls,
      callsPerQuery:
        (modelCalls.embedCalls + modelCalls.rerankCalls +
          modelCalls.rewriteCalls) / Math.max(1, cases.length),
    },
    gate,
    passed: Object.values(gate).every(Boolean),
    cases,
    isolatedDatabaseRemovedOnExit: true,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
