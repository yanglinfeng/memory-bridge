import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectRecallExplanation,
} from '../src/web/src/components/RecallLab.js';
import type { RecallExplanation } from '../src/web/src/types.js';

function explanation(
  input: Partial<RecallExplanation> & Pick<RecallExplanation, 'id'>,
): RecallExplanation {
  return {
    id: input.id,
    traceId: input.traceId,
    query: input.query,
    mode: input.mode || 'hybrid-local',
    candidateCount: input.candidateCount || 0,
    resultIds: input.resultIds || [],
    createdAt: input.createdAt || '2026-08-11T00:00:00.000Z',
  };
}

test('metadata 模式按 traceId 匹配召回说明且不读取已脱敏 query', () => {
  const expected = explanation({
    id: 2,
    traceId: 'trace-current',
    query: null,
  });
  const selected = selectRecallExplanation([
    explanation({ id: 1, traceId: 'trace-old', query: null }),
    expected,
  ], {
    traceId: 'trace-current',
    query: '我平时喜欢什么？',
  });

  assert.equal(selected, expected);
});

test('diagnostic 模式没有 traceId 时仍可按规范化 query 兼容匹配', () => {
  const expected = explanation({
    id: 3,
    query: '  我喜欢全角ＡＢＣ  ',
  });
  const selected = selectRecallExplanation([expected], {
    query: '我喜欢全角ABC',
  });

  assert.equal(selected, expected);
});
