import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { embedText, vectorToBuffer } from '../src/server/embedding.js';
import { MemoryStore } from '../src/server/memory-store.js';
import type {
  SemanticCandidate,
  SemanticDecision,
  SemanticRanker,
} from '../src/server/semantic-ranker.js';

const semanticTargets = [
  {
    queryMarker: '玄鹤',
    contentMarker: '日出前整理',
    content: '用户习惯在日出前整理当天的任务。',
  },
  {
    queryMarker: '赤狐',
    contentMarker: '空白数据',
    content: '用户在编写新程序时坚持从空白数据开始。',
  },
  {
    queryMarker: '蓝鲸',
    contentMarker: '纸质版本',
    content: '用户阅读长文时更喜欢纸质版本。',
  },
] as const;

function targetIndex(text: string): number {
  return semanticTargets.findIndex(
    (target) =>
      text.includes(target.queryMarker) ||
      text.includes(target.contentMarker),
  );
}

function controlledVector(index: number): Float32Array {
  if (index < 0) {
    return Float32Array.from(
      { length: 96 },
      (_, dimension) => (dimension % 3 === 0 ? -1 : -0.25),
    );
  }
  return Float32Array.from(
    { length: 96 },
    (_, dimension) =>
      Math.sin((dimension + 1) * (index + 1) * 0.71) +
      Math.cos((dimension + 3) * (index + 2) * 0.37),
  );
}

class DenseScaleRanker implements SemanticRanker {
  readonly embeddingModel = 'dense-scale-model-v1';
  readonly rerankModel = 'dense-scale-reranker-v1';

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => controlledVector(targetIndex(text)));
  }

  async rerank(
    query: string,
    candidates: SemanticCandidate[],
  ): Promise<SemanticDecision[]> {
    const expected = targetIndex(query);
    return candidates.map((candidate) => {
      const relevant = targetIndex(candidate.memory) === expected;
      return {
        id: candidate.id,
        relevant,
        confidence: relevant ? 1 : 0,
        reason: relevant ? '边界语义目标一致' : '边界填充项',
      };
    });
  }
}

test('Dense ANN 召回第 1001、第 10001 与最老的无词面目标', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-dense-scale-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database, new DenseScaleRanker());
  const insert = database.prepare(
    `INSERT INTO memories (
       id, user_id, namespace, kind, title, content, summary,
       tags_json, importance, confidence, status, source, source_ref,
       occurred_at, valid_from, valid_to, created_at, updated_at,
       last_seen_at, access_count, checksum, embedding
     ) VALUES (
       ?, 'default', 'personal', 'knowledge', ?, ?, '', '[]',
       0.8, 1, 'active', 'dense-scale-test', NULL,
       NULL, NULL, NULL, ?, ?, ?, 0, ?, ?
     )`,
  );
  const fillerVector = vectorToBuffer(embedText('普通向量规模填充记录'));
  const base = Date.parse('2026-07-29T12:00:00.000Z');
  const positions = [1_000, 10_000, 10_019];
  const targetByPosition = new Map(
    positions.map((position, index) => [
      position,
      {
        id: `dense-boundary-${position + 1}`,
        ...semanticTargets[index],
      },
    ]),
  );

  try {
    database.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 10_020; index += 1) {
      const target = targetByPosition.get(index);
      const timestamp = new Date(base - index * 1_000).toISOString();
      insert.run(
        target?.id || `dense-filler-${index}`,
        `向量规模记录 ${index}`,
        target?.content || `普通向量规模填充记录 ${index}。`,
        timestamp,
        timestamp,
        timestamp,
        String(index).padStart(64, '0').slice(-64),
        fillerVector,
      );
    }
    database.exec('COMMIT');

    let backfill = await store.backfillDenseIndex();
    while (!backfill.complete) {
      assert.ok(backfill.processed > 0);
      backfill = await store.backfillDenseIndex();
    }
    assert.equal(backfill.eligible, 10_020);
    assert.equal(backfill.indexed, 10_020);

    for (const target of targetByPosition.values()) {
      const recalled = await store.recallReliable({
        query: `${target.queryMarker}问题的答案是什么？`,
        limit: 3,
      });
      assert.equal(recalled[0]?.memory.id, target.id);
      assert.match(
        recalled[0]?.reasons.join(' ') || '',
        /Dense sign-LSH/,
      );
      const audit = store.audits(1)[0];
      assert.equal(audit.detail.lexicalCandidateCount, 0);
      assert.equal(audit.detail.termCandidateCount, 0);
      assert.ok(Number(audit.detail.annCandidateCount) >= 1);
    }
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
