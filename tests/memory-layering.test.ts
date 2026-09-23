import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyMemoryLayer,
  memoryLayerContextFields,
  selectLayeredRecallResults,
} from '../src/server/memory-layering.js';
import type { MemoryRecord, RecallResult } from '../src/server/types.js';

function result(
  id: string,
  source: string,
  score: number,
): RecallResult {
  const memory: MemoryRecord = {
    id,
    userId: 'alice',
    namespace: 'personal',
    kind: 'event',
    title: id,
    content: id,
    summary: '',
    tags: [],
    importance: 0.5,
    confidence: 0.9,
    status: 'active',
    source,
    sourceRef: null,
    occurredAt: null,
    validFrom: null,
    validTo: null,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    accessCount: 0,
    lastAccessedAt: null,
    scopeType: 'personal',
    scopeKey: 'self',
    sensitivity: 'normal',
    sourceAuthority: 'direct_user',
    negated: false,
  };
  return {
    memory,
    score,
    reasons: ['test'],
    explanation: {
      lexicalRank: null,
      annRank: null,
      termRank: null,
      graphRank: null,
      semanticSimilarity: 1,
      rerankConfidence: 1,
      feedbackPrior: 0,
      importance: 0.5,
      memoryConfidence: 0.9,
      recency: 1,
      status: 'active',
      conflictState: 'none',
      diversityPenalty: 0,
    },
  };
}

test('记忆层由受控 source 分类并生成不会混淆事实的上下文标签', () => {
  assert.equal(classifyMemoryLayer('conversation_episode'), 'episode');
  assert.equal(classifyMemoryLayer('hierarchical_summary'), 'summary');
  assert.equal(classifyMemoryLayer('consolidation'), 'summary');
  assert.equal(classifyMemoryLayer('lifecycle-auto'), 'fact');

  assert.deepEqual(memoryLayerContextFields('conversation_episode'), {
    heading: '过往对话情景',
    contentLabel: '情景',
    caution: '这只证明以前聊过这些内容，不等于已验证的用户事实。',
  });
  assert.equal(
    memoryLayerContextFields('lifecycle-auto').heading,
    '已验证事实',
  );
});

test('统一召回在候选齐全时限制情景数量且保留事实和摘要', () => {
  const ranked = [
    ...Array.from({ length: 8 }, (_, index) =>
      result(`episode-${index}`, 'conversation_episode', 1 - index / 100)),
    ...Array.from({ length: 5 }, (_, index) =>
      result(`fact-${index}`, 'lifecycle-auto', 0.9 - index / 100)),
    ...Array.from({ length: 3 }, (_, index) =>
      result(`summary-${index}`, 'hierarchical_summary', 0.8 - index / 100)),
  ].sort((left, right) => right.score - left.score);

  const selected = selectLayeredRecallResults(ranked, 8);
  const counts = selected.reduce<Record<string, number>>((value, item) => {
    const layer = classifyMemoryLayer(item.memory.source);
    value[layer] = (value[layer] || 0) + 1;
    return value;
  }, {});

  assert.equal(selected.length, 8);
  assert.ok((counts.fact || 0) > 0);
  assert.ok((counts.summary || 0) > 0);
  assert.ok((counts.episode || 0) <= 3);
});

test('某一层是唯一相关来源时，剩余额度按原排序补齐', () => {
  const ranked = Array.from({ length: 10 }, (_, index) =>
    result(`episode-${index}`, 'conversation_episode', 1 - index / 100));

  assert.deepEqual(
    selectLayeredRecallResults(ranked, 8).map((item) => item.memory.id),
    ranked.slice(0, 8).map((item) => item.memory.id),
  );
});
