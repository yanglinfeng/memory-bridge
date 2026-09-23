import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DenseIndexEvaluator,
} from '../dist/server/dense-index-evaluator.js';
import { openDatabase } from '../dist/server/database.js';
import { MemoryStore } from '../dist/server/memory-store.js';
import {
  createConfiguredSemanticRanker,
} from '../dist/server/semantic-ranker.js';

const namespace = 'isolated-switch-rollback';
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'memory-bridge-dense-switch-'),
);
const database = openDatabase(
  path.join(directory, 'isolated-switch.sqlite3'),
);

async function finishBackfill(store, generationId) {
  let result = await store.backfillDenseIndex(
    256,
    undefined,
    undefined,
    namespace,
    undefined,
    undefined,
    undefined,
    generationId,
  );
  while (!result.complete) {
    if (result.processed === 0) {
      throw new Error('Dense 世代回填没有进展');
    }
    result = await store.backfillDenseIndex(
      256,
      undefined,
      undefined,
      namespace,
      undefined,
      undefined,
      undefined,
      generationId,
    );
  }
  return result;
}

try {
  const baseRanker = createConfiguredSemanticRanker();
  if (!baseRanker) {
    throw new Error('语义模式已关闭，无法验证 Dense 世代切换与回滚');
  }
  const switchedRanker = {
    embeddingModel: `${baseRanker.embeddingModel}@switch-probe`,
    rerankModel: baseRanker.rerankModel,
    async embed(texts) {
      const vectors = await baseRanker.embed(texts);
      return vectors.map((vector) =>
        Float32Array.from(vector, (value) => -value));
    },
    rerank(query, candidates) {
      return baseRanker.rerank(query, candidates);
    },
  };

  const firstStore = new MemoryStore(database, baseRanker);
  const seed = firstStore.remember({
    namespace,
    kind: 'preference',
    content: '用户希望长期记忆索引升级可以无停机回滚。',
    source: 'dense-switch-rollback-acceptance',
    stableKey: 'dense-switch-rollback-seed',
  }).memory;
  let first = await firstStore.backfillDenseIndex(
    256,
    undefined,
    undefined,
    namespace,
  );
  if (!first.generationId) {
    throw new Error('无法创建初始 Dense generation');
  }
  first = await finishBackfill(firstStore, first.generationId);
  const firstEvaluation = await new DenseIndexEvaluator(
    firstStore,
  ).evaluateAndActivate({
    generationId: first.generationId,
    namespace,
  });
  if (!firstEvaluation.report.passed || !firstEvaluation.activated) {
    throw new Error('初始 Dense generation 固定评测未通过');
  }

  const secondStore = new MemoryStore(
    database,
    [switchedRanker, baseRanker],
  );
  let second = await secondStore.backfillDenseIndex(
    256,
    undefined,
    undefined,
    namespace,
  );
  if (!second.generationId) {
    throw new Error('无法创建待切换 Dense generation');
  }
  second = await finishBackfill(secondStore, second.generationId);
  const secondEvaluation = await new DenseIndexEvaluator(
    secondStore,
  ).evaluateAndActivate({
    generationId: second.generationId,
    namespace,
  });
  if (!secondEvaluation.report.passed || !secondEvaluation.activated) {
    throw new Error('待切换 Dense generation 固定评测未通过');
  }

  const switchedAlias = secondStore.denseIndexAlias(
    undefined,
    namespace,
  );
  if (
    !switchedAlias ||
    switchedAlias.activeGenerationId !== second.generationId ||
    switchedAlias.previousGenerationId !== first.generationId
  ) {
    throw new Error('Dense alias 未原子切换到新世代');
  }
  const beforeRollback = await secondStore.getContextReliable({
    namespace,
    query: '索引升级需要具备什么恢复能力？',
  });
  if (
    beforeRollback.qualityState !== 'full' ||
    beforeRollback.memories[0]?.memory.id !== seed.id
  ) {
    throw new Error('新 Dense generation 切换后召回失败');
  }

  const rolledBack = await secondStore.rollbackDenseIndexGeneration({
    expectedAliasRevision: switchedAlias.revision,
    namespace,
    reason: '真实 BGE 世代切换验收回滚',
  });
  if (
    rolledBack.activeGenerationId !== first.generationId ||
    rolledBack.previousGenerationId !== second.generationId
  ) {
    throw new Error('Dense alias 未回滚到上一世代');
  }
  const afterRollback = await secondStore.getContextReliable({
    namespace,
    query: '索引升级需要具备什么恢复能力？',
  });
  if (
    afterRollback.qualityState !== 'full' ||
    afterRollback.memories[0]?.memory.id !== seed.id
  ) {
    throw new Error('Dense generation 回滚后召回失败');
  }

  console.log(JSON.stringify({
    passed: true,
    physicalEmbeddingModel: baseRanker.embeddingModel,
    switchedEmbeddingProfile: switchedRanker.embeddingModel,
    dimensions: first.dimensions,
    firstGenerationId: first.generationId,
    secondGenerationId: second.generationId,
    switchedAliasRevision: switchedAlias.revision,
    rolledBackAliasRevision: rolledBack.revision,
    recallBeforeRollback: beforeRollback.qualityState,
    recallAfterRollback: afterRollback.qualityState,
    firstEvaluation: {
      recallAt20: firstEvaluation.report.recallAt20,
      mrrAt10: firstEvaluation.report.mrrAt10,
    },
    secondEvaluation: {
      recallAt20: secondEvaluation.report.recallAt20,
      mrrAt10: secondEvaluation.report.mrrAt10,
    },
    isolatedDatabaseRemovedOnExit: true,
  }, null, 2));
} finally {
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
