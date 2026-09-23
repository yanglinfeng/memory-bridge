import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DENSE_EVALUATION_DATASET_ID,
  DenseIndexEvaluator,
} from '../dist/server/dense-index-evaluator.js';
import { openDatabase } from '../dist/server/database.js';
import { MemoryStore } from '../dist/server/memory-store.js';
import {
  createConfiguredSemanticRanker,
} from '../dist/server/semantic-ranker.js';

const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'memory-bridge-dense-gate-'),
);
const database = openDatabase(
  path.join(directory, 'isolated-evaluation.sqlite3'),
);
try {
  const ranker = createConfiguredSemanticRanker();
  if (!ranker) {
    throw new Error('语义模式已关闭，无法运行 Dense 固定评测');
  }
  const store = new MemoryStore(database, ranker);
  store.remember({
    namespace: 'isolated-gate',
    kind: 'knowledge',
    content: '这是隔离评测库的索引种子，不会写入正式数据库。',
    source: 'isolated-evaluation-bootstrap',
  });
  const generation = await store.backfillDenseIndex(
    256,
    undefined,
    undefined,
    'isolated-gate',
  );
  if (!generation.complete || !generation.generationId) {
    throw new Error('隔离评测库的目标 generation 回填未完成');
  }
  const outcome = await new DenseIndexEvaluator(
    store,
  ).evaluateAndActivate({
    generationId: generation.generationId,
    namespace: 'isolated-gate',
  });
  const failedCases = outcome.report.cases
    .filter((item) => !item.hitAt20)
    .map((item) => item.caseId);
  console.log(JSON.stringify({
    passed: outcome.report.passed,
    activated: outcome.activated,
    datasetId: DENSE_EVALUATION_DATASET_ID,
    datasetSha256: outcome.report.datasetSha256,
    evaluatorVersion: outcome.report.evaluatorVersion,
    generationId: outcome.report.generationId,
    embeddingModel: outcome.report.embeddingModel,
    dimensions: outcome.report.dimensions,
    queryCount: outcome.report.queryCount,
    recallAt20: outcome.report.recallAt20,
    mrrAt10: outcome.report.mrrAt10,
    failedCases,
    startedAt: outcome.report.startedAt,
    completedAt: outcome.report.completedAt,
    isolatedDatabaseRemovedOnExit: true,
  }, null, 2));
  if (!outcome.report.passed) {
    process.exitCode = 1;
  }
} finally {
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
