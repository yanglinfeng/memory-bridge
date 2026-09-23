import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OllamaClaimRelationClassifier,
} from '../src/server/claim-relation-classifier.js';
import {
  canonicalStableKey,
  classifyPredicateCardinality,
  type ClaimSubject,
} from '../src/server/claim-relation-engine.js';
import type { MemoryCandidate } from '../src/server/lifecycle-store.js';

const candidate: MemoryCandidate = {
  id: 'candidate-1',
  userId: 'default',
  namespace: 'personal',
  turnId: 'turn-1',
  extractionRunId: 'run-1',
  kind: 'preference',
  subject: '用户',
  predicate: '首要代码工具',
  value: 'Cursor',
  normalizedKey: '用户::首要代码工具',
  normalizedHash: 'candidate-hash',
  stableKey: 'personal::self::用户::首要代码工具',
  content: '用户首要代码工具是 Cursor。',
  confidence: 0.99,
  importance: 0.9,
  sensitivity: 'normal',
  negated: false,
  scopeType: 'personal',
  scopeKey: 'self',
  claimOccurredAt: null,
  claimValidFrom: null,
  claimValidTo: null,
  sourceExcerpt: '首要代码工具是 Cursor',
  sourceAuthority: 'direct_user',
  extractorId: 'test',
  extractorVersion: 'v1',
  extractionModel: 'qwen2.5:14b',
  extractionPromptVersion: 'extract-v1',
  state: 'pending',
  decisionReason: null,
  explicitCorrection: false,
  resolvedMemoryItemId: null,
  resolvedAt: null,
  createdAt: '2026-07-29T00:00:00.000Z',
  updatedAt: '2026-07-29T00:00:00.000Z',
};

const targets = [
  {
    id: 'memory-1',
    predicateKey: '用户::主要编辑器',
    normalizedValue: 'VS Code',
    content: '用户主要编辑器是 VS Code。',
    sourceAuthority: 'direct_user' as const,
    occurredAt: null,
    validFrom: null,
    validTo: null,
  },
];

test('稳定生活习惯无论模型误报 kind 都是多值且同 scope 可共存 10 种', () => {
  const kinds = [
    'profile',
    'preference',
    'project',
    'event',
    'knowledge',
    'relationship',
    'instruction',
  ] as const;
  for (const kind of kinds) {
    assert.equal(
      classifyPredicateCardinality(kind, '稳定生活习惯'),
      'set',
    );
  }

  const habits = [
    '早餐喝黑咖啡',
    '午餐吃清淡菜',
    '晚饭少吃主食',
    '工作日步行上班',
    '周二晚上游泳',
    '睡前阅读半小时',
    '晚上十一点前睡觉',
    '起床后先喝水',
    '周末整理房间',
    '通勤时听播客',
  ];
  const stableKey = 'personal::self::用户::稳定生活习惯';
  const keys = habits.map((value, index) => canonicalStableKey({
    ...candidate,
    id: `habit-${index + 1}`,
    kind: kinds[index % kinds.length]!,
    predicate: '稳定生活习惯',
    value,
    normalizedKey: '用户::稳定生活习惯',
    normalizedHash: `habit-value-${index + 1}`,
    stableKey,
    content: `用户${value}。`,
  } satisfies ClaimSubject, 'set'));

  assert.equal(new Set(keys).size, habits.length);
  assert.ok(keys.every((key) => key.startsWith(`${stableKey}::set::`)));
});

test('qwen2.5:14b 关系分类器使用结构化五路输出', async () => {
  let requestBody: Record<string, unknown> | null = null;
  const classifier = new OllamaClaimRelationClassifier({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'claim-relation-v1',
    timeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              relation: 'supersedes',
              targetMemoryId: 'memory-1',
              confidence: 0.98,
              rationale: '用户说明当前工具变化',
            }),
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  });

  const result = await classifier.classify(candidate, targets);
  assert.equal(requestBody?.model, 'qwen2.5:14b');
  assert.equal(requestBody?.stream, false);
  assert.ok(requestBody?.format);
  assert.deepEqual(result, {
    relation: 'supersedes',
    targetMemoryId: 'memory-1',
    confidence: 0.98,
    rationale: '用户说明当前工具变化',
  });
});

test('关系分类器拒绝模型虚构的 target ID', async () => {
  const classifier = new OllamaClaimRelationClassifier({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'claim-relation-v1',
    timeoutMs: 5_000,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              relation: 'equivalent',
              targetMemoryId: 'invented-memory',
              confidence: 1,
              rationale: '错误目标',
            }),
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
  });

  await assert.rejects(
    classifier.classify(candidate, targets),
    /未知记忆/,
  );
});
