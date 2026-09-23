import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CandidateResolver } from '../src/server/candidate-resolver.js';
import { config } from '../src/server/config.js';
import { openDatabase } from '../src/server/database.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import { MemoryAdminService } from '../src/server/memory-admin.js';
import { MemoryGovernance } from '../src/server/memory-governance.js';
import { MemoryStore } from '../src/server/memory-store.js';
import type {
  SemanticCandidate,
  SemanticDecision,
  SemanticRanker,
} from '../src/server/semantic-ranker.js';

/**
 * 只把含"真正答案"的记忆判 relevant，其余全部 false——
 * 模拟知识库多跳场景：重排把链条中间环节（仅含线索）判为不相关。
 */
class SingleRelevantRanker implements SemanticRanker {
  readonly embeddingModel = 'filler-test-embedding-v1';
  readonly rerankModel = 'filler-test-reranker-v1';

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => Float32Array.from([1, 0, 0]));
  }

  async rerank(
    _query: string,
    candidates: SemanticCandidate[],
  ): Promise<SemanticDecision[]> {
    return candidates.map((candidate) => {
      const relevant = candidate.memory.includes('真正答案');
      return {
        id: candidate.id,
        relevant,
        confidence: relevant ? 0.98 : 0.9,
        reason: relevant ? '直接包含答案' : '仅含线索片段',
      };
    });
  }
}

function createFixture(ranker: SemanticRanker) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-rerank-filler-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database, ranker);
  const lifecycle = new LifecycleStore(database);
  const governance = new MemoryGovernance(database, lifecycle, store);
  const resolver = new CandidateResolver(
    database,
    lifecycle,
    store,
    { mode: 'auto' },
  );
  const admin = new MemoryAdminService(
    database,
    store,
    lifecycle,
    resolver,
    governance,
  );
  return {
    store,
    admin,
    close: () => {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function rememberKbChunk(
  fixture: ReturnType<typeof createFixture>,
  content: string,
  stableKey: string,
) {
  // origin=api 模拟知识库直写形态（认证通道背书，凭通道放行）
  return fixture.store.remember({
    kind: 'document_chunk',
    content,
    stableKey,
    sourceAuthority: 'direct_user',
    origin: 'api',
  });
}

const GOLD = '用户首选的出行方式是乘坐高铁，这是真正答案。';
const CLUE_A = '会议记录提到用户上个月出差去了杭州，仅含中间线索甲。';
const CLUE_B = '日程表显示用户周一上午有空，仅含中间线索乙。';
const QUERY = '两跳查询：中间线索和真正答案分别是哪条记忆？';

test('默认 filler=0：重排 false 即淘汰（现行为零回归）', async () => {
  assert.equal(config.semanticRerankFillerLimit, 0);
  const fixture = createFixture(new SingleRelevantRanker());
  try {
    rememberKbChunk(fixture, GOLD, 'filler-gold');
    rememberKbChunk(fixture, CLUE_A, 'filler-clue-a');
    rememberKbChunk(fixture, CLUE_B, 'filler-clue-b');
    const results = await fixture.store.recallReliable({
      query: QUERY,
      limit: 3,
    });
    assert.equal(results.length, 1);
    assert.ok(results[0].memory.content.includes('真正答案'));
  } finally {
    fixture.close();
  }
});

test('filler 开启：relevant 不足时按粗排分补齐并垫底', async () => {
  const previous = config.semanticRerankFillerLimit;
  config.semanticRerankFillerLimit = 2;
  const fixture = createFixture(new SingleRelevantRanker());
  try {
    rememberKbChunk(fixture, GOLD, 'filler2-gold');
    rememberKbChunk(fixture, CLUE_A, 'filler2-clue-a');
    rememberKbChunk(fixture, CLUE_B, 'filler2-clue-b');
    const results = await fixture.store.recallReliable({
      query: QUERY,
      limit: 3,
    });
    // 1 条 relevant + 1 条 filler（target=min(2,3)=2，need=1）
    assert.equal(results.length, 2);
    // relevant 优先：gold 排第一
    assert.ok(results[0].memory.content.includes('真正答案'));
    // filler 在 relevant 之后
    const fillerResults = results.slice(1);
    assert.equal(fillerResults.length, 1);
    assert.ok(fillerResults.every((result) =>
      !result.memory.content.includes('真正答案')));
    assert.ok(fillerResults.every((result) =>
      result.reasons.some((reason) => reason.includes('填充'))));
    // 另一条线索仍被淘汰（filler 只补到 target，不是无脑全放）
    assert.ok(
      results.length < 3,
      'filler 应只补齐到 target 数量，而非放开全部候选',
    );
  } finally {
    config.semanticRerankFillerLimit = previous;
    fixture.close();
  }
});

test('filler 开启但 relevant 充足时不触发填充', async () => {
  const previous = config.semanticRerankFillerLimit;
  config.semanticRerankFillerLimit = 2;
  const fixture = createFixture(new SingleRelevantRanker());
  try {
    rememberKbChunk(fixture, GOLD, 'filler3-gold-1');
    rememberKbChunk(
      fixture,
      '第二课内容也是真正答案，高铁票在钱包里。',
      'filler3-gold-2',
    );
    rememberKbChunk(fixture, CLUE_A, 'filler3-clue-a');
    const results = await fixture.store.recallReliable({
      query: QUERY,
      limit: 3,
    });
    // 2 条 relevant 已达 target=min(2,3)=2，不填充
    assert.equal(
      results.filter((result) =>
        result.memory.content.includes('真正答案')).length,
      2,
    );
    assert.equal(results.length, 2);
    assert.ok(results.every((result) =>
      !result.reasons.some((reason) => reason.includes('填充'))));
  } finally {
    config.semanticRerankFillerLimit = previous;
    fixture.close();
  }
});
