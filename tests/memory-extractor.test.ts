import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEMORY_EXTRACTOR_IMPLEMENTATION_VERSION,
  OllamaMemoryExtractor,
} from '../src/server/memory-extractor.js';
import type {
  ConversationTurn,
  MemoryCandidateInput,
} from '../src/server/lifecycle-store.js';

const OBSERVED_AT = '2026-01-03T15:23:04.615Z';

test('稳定画像校准会推进提取器实现版本', () => {
  assert.equal(MEMORY_EXTRACTOR_IMPLEMENTATION_VERSION, 'v22');
});

interface ExtractionCase {
  name: string;
  turn: string;
  predicate: string;
  value: string;
  expectedKind: MemoryCandidateInput['kind'];
  scopeType?: 'personal' | 'role';
  scopeKey?: string;
}

async function extractCase(
  fixture: ExtractionCase,
): Promise<MemoryCandidateInput> {
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-stable-profile-test-v1',
    timeoutMs: 5_000,
    fetchImpl: async () => new Response(JSON.stringify({
      message: {
        content: JSON.stringify({
          candidates: [{
            kind: 'event',
            subject: '用户',
            predicate: fixture.predicate,
            value: fixture.value,
            content: '',
            confidence: 0.99,
            importance: 0.8,
            sensitivity: 'normal',
            negated: false,
            scopeType: fixture.scopeType || 'personal',
            scopeKey: fixture.scopeKey || 'self',
            claimOccurredAt: OBSERVED_AT,
            claimValidFrom: OBSERVED_AT,
            claimValidTo: null,
            sourceExcerpt: fixture.turn,
            sourceAuthority: 'direct_user',
          }],
        }),
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  const turn: ConversationTurn = {
    id: `turn-${fixture.name}`,
    sessionId: 'session-stable-profile',
    userId: 'user-stable-profile',
    namespace: 'personal',
    externalId: `external-${fixture.name}`,
    role: 'user',
    content: fixture.turn,
    occurredAt: OBSERVED_AT,
    createdAt: OBSERVED_AT,
    metadata: {},
  };
  const [candidate] = await extractor.extract(turn);
  assert.ok(candidate, fixture.name);
  return candidate;
}

test('真实 14B 稳定画像别名会校准 kind 并清除伪造时间', async () => {
  const fixtures: ExtractionCase[] = [
    {
      name: 'drink',
      turn: '我平时最常喝桂花乌龙，点单时优先选它。',
      predicate: '点单时的首选茶',
      value: '桂花乌龙',
      expectedKind: 'preference',
    },
    {
      name: 'occupation',
      turn: '我目前的职业是室内设计师。',
      predicate: '职业',
      value: '室内设计师',
      expectedKind: 'profile',
    },
    {
      name: 'home-city',
      turn: '我长期生活在杭州。',
      predicate: '居住地',
      value: '杭州',
      expectedKind: 'profile',
    },
    {
      name: 'commute',
      turn: '工作日我通常骑共享单车到地铁站。',
      predicate: '通勤方式 [条件:工作日]',
      value: '骑共享单车到地铁站',
      expectedKind: 'preference',
    },
    {
      name: 'diet',
      turn: '我一直不吃香菜，以后推荐餐食时请避开。',
      predicate: '饮食偏好',
      value: '不吃香菜',
      expectedKind: 'preference',
    },
    {
      name: 'meal-rule',
      turn: '我一直不吃香菜，以后推荐餐食时请避开。',
      predicate: '推荐餐食规则',
      value: '推荐餐食时请避开香菜',
      expectedKind: 'instruction',
    },
    {
      name: 'learning-goal',
      turn: '我今年的长期学习目标是系统学习木工基础。',
      predicate: '长期学习目标',
      value: '系统学习木工基础',
      expectedKind: 'profile',
    },
    {
      name: 'role-rule',
      turn: '只在和小岚这个角色聊天时，请先给一句结论，再列两点依据。',
      predicate: '与特定角色交流规则',
      value: '先给一句结论，再列两点依据',
      expectedKind: 'instruction',
      scopeType: 'role',
      scopeKey: '小岚',
    },
    {
      name: 'editor',
      turn: '只在和小岚这个角色聊天时，我常用的编辑器是 Neovim。',
      predicate: '常用编辑器',
      value: 'Neovim',
      expectedKind: 'preference',
      scopeType: 'role',
      scopeKey: '小岚',
    },
  ];

  for (const fixture of fixtures) {
    const candidate = await extractCase(fixture);
    assert.equal(candidate.kind, fixture.expectedKind, fixture.name);
    assert.equal(candidate.claimOccurredAt, null, fixture.name);
    assert.equal(candidate.claimValidFrom, null, fixture.name);
    assert.equal(candidate.claimValidTo, null, fixture.name);
  }
});

test('稳定画像的明确时间仍保留，真正一次性事件仍是 event', async () => {
  const timed = await extractCase({
    name: 'timed-occupation',
    turn: '从2026年3月起我的职业是室内设计师。',
    predicate: '职业',
    value: '室内设计师',
    expectedKind: 'profile',
  });
  assert.equal(timed.kind, 'profile');
  assert.equal(timed.claimOccurredAt, OBSERVED_AT);
  assert.equal(timed.claimValidFrom, OBSERVED_AT);

  const event = await extractCase({
    name: 'one-time-event',
    turn: '今天午休我去了云杉书店。',
    predicate: '访问地点',
    value: '云杉书店',
    expectedKind: 'event',
  });
  assert.equal(event.kind, 'event');
  assert.equal(event.claimOccurredAt, OBSERVED_AT);
  assert.equal(event.claimValidFrom, OBSERVED_AT);
});
