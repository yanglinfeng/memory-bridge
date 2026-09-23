import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/server/database.js';
import {
  DENSE_EVALUATION_CASES,
  DENSE_EVALUATION_DATASET_ID,
  DenseIndexEvaluator,
} from '../src/server/dense-index-evaluator.js';
import { MemoryStore } from '../src/server/memory-store.js';
import type {
  SemanticCandidate,
  SemanticDecision,
  SemanticRanker,
} from '../src/server/semantic-ranker.js';

function evaluationCaseIndex(text: string): number {
  const normalized = text.normalize('NFKC');
  return DENSE_EVALUATION_CASES.findIndex(
    (fixture) =>
      normalized.includes(fixture.query.normalize('NFKC')) ||
      normalized.includes(fixture.relevant.normalize('NFKC')),
  );
}

function normalizedVector(values: number[]): Float32Array {
  const norm = Math.sqrt(
    values.reduce((total, value) => total + value * value, 0),
  );
  return Float32Array.from(values, (value) => value / norm);
}

class OracleEvaluationRanker implements SemanticRanker {
  readonly rerankModel = 'evaluation-oracle-reranker-v1';
  rerankCalls = 0;

  constructor(readonly embeddingModel: string) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const caseIndex = evaluationCaseIndex(text);
      if (caseIndex < 0) {
        return normalizedVector(Array.from(
          { length: 128 },
          (_, index) => (index % 2 === 0 ? -1 : -0.5),
        ));
      }
      return normalizedVector(Array.from(
        { length: 128 },
        (_, index) =>
          Math.sin((index + 1) * (caseIndex + 1) * 0.31) +
          Math.cos((index + 3) * (caseIndex + 2) * 0.17),
      ));
    });
  }

  async rerank(
    query: string,
    candidates: SemanticCandidate[],
  ): Promise<SemanticDecision[]> {
    this.rerankCalls += 1;
    const fixture = DENSE_EVALUATION_CASES.find(
      (item) => item.query.normalize('NFKC') === query,
    );
    return candidates.map((candidate) => {
      const relevant = Boolean(
        fixture &&
        candidate.memory.normalize('NFKC').includes(
          fixture.relevant.normalize('NFKC'),
        ),
      );
      return {
        id: candidate.id,
        relevant,
        confidence: relevant ? 1 : 0,
        reason: relevant ? '固定评测目标一致' : '固定评测干扰项',
      };
    });
  }
}

test('固定 Dense 评测只在隔离库运行并以审计报告原子切换', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-evaluator-test-'),
  );
  const database = openDatabase(
    path.join(directory, 'production.sqlite3'),
  );
  try {
    const v1 = new OracleEvaluationRanker('oracle-embedding-v1');
    const initialStore = new MemoryStore(database, v1);
    initialStore.remember({
      kind: 'knowledge',
      content: '正式库只保留这一条业务种子记忆。',
    });
    const initial = await initialStore.backfillDenseIndex();
    assert.equal(initial.complete, true);

    const v2 = new OracleEvaluationRanker('oracle-embedding-v2');
    const store = new MemoryStore(database, [v2, v1]);
    const building = await store.backfillDenseIndex();
    assert.equal(building.complete, true);
    assert.notEqual(building.generationId, initial.generationId);

    const outcome = await new DenseIndexEvaluator(
      store,
    ).evaluateAndActivate({
      generationId: building.generationId!,
    });
    assert.equal(
      outcome.activated,
      true,
      JSON.stringify(outcome.report),
    );
    assert.equal(outcome.report.datasetId, DENSE_EVALUATION_DATASET_ID);
    assert.equal(outcome.report.queryCount, 20);
    assert.equal(outcome.report.recallAt20, 1);
    assert.equal(outcome.report.mrrAt10, 1);
    assert.equal(outcome.report.passed, true);
    assert.equal(
      v2.rerankCalls,
      0,
      'Dense generation 固定评测不得混入 reranker 质量',
    );
    assert.equal(
      store.denseIndexAlias()?.activeGenerationId,
      building.generationId,
    );
    assert.equal(
      store.denseIndexAlias()?.previousGenerationId,
      initial.generationId,
    );
    assert.deepEqual(
      store.denseIndexEvaluation(outcome.report.evaluationId),
      outcome.report,
    );
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memories
           WHERE source = 'dense-index-evaluation'`,
        )
        .get()?.count,
      0,
    );
    const activatedAudit = store.audits(10).find(
      (entry) => entry.action === 'dense_index_activated',
    );
    assert.equal(
      activatedAudit?.detail.evaluationId,
      outcome.report.evaluationId,
    );
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
