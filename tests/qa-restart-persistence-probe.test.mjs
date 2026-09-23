import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeRetrievalTraceStages,
  evaluateCompatAudit,
  evaluateProbeAnswer,
  finiteNonNegativeNumber,
  finitePositiveNumber,
  parseCompatAuditLog,
  reliableRecallLatency,
} from '../scripts/qa-restart-persistence-probe-lib.mjs';

const COMPLETE_TRACE = [
  'request',
  'rewrite',
  'channels',
  'fusion',
  'semantic',
  'rerank',
  'selection',
  'context',
  'result',
].map((stage) => ({ stage }));

test('真实探针必须持有顺序完整的九阶段 trace', () => {
  assert.equal(completeRetrievalTraceStages(COMPLETE_TRACE), true);
  assert.equal(
    completeRetrievalTraceStages(
      COMPLETE_TRACE.filter((event) => event.stage !== 'fusion'),
    ),
    false,
  );
  assert.equal(
    completeRetrievalTraceStages([...COMPLETE_TRACE].reverse()),
    false,
  );
});

test('真实探针接受同一 trace 的完整补救 attempt 和 not-useful 终止', () => {
  const pipeline = COMPLETE_TRACE.slice(1, -2);
  assert.equal(
    completeRetrievalTraceStages([
      COMPLETE_TRACE[0],
      ...pipeline.map((event) => ({ ...event, details: { attempt: 1 } })),
      ...pipeline.map((event) => ({ ...event, details: { attempt: 2 } })),
      ...COMPLETE_TRACE.slice(-2),
    ]),
    true,
  );
  assert.equal(
    completeRetrievalTraceStages([
      COMPLETE_TRACE[0],
      ...pipeline,
      {
        stage: 'rewrite',
        details: {
          attempt: 2,
          skipped: true,
          reason: 'quality_fallback_no_query_delta',
        },
      },
      ...COMPLETE_TRACE.slice(-2),
    ]),
    true,
  );
  assert.equal(
    completeRetrievalTraceStages([
      COMPLETE_TRACE[0],
      ...pipeline,
      {
        stage: 'rewrite',
        details: {
          attempt: 2,
          skipped: true,
          reason: 'quality_fallback_not_useful',
        },
      },
      ...COMPLETE_TRACE.slice(-2),
    ]),
    true,
  );
  assert.equal(
    completeRetrievalTraceStages([
      COMPLETE_TRACE[0],
      ...pipeline,
      { stage: 'rewrite', details: { attempt: 2 } },
      ...COMPLETE_TRACE.slice(-2),
    ]),
    false,
  );
});

test('真实探针按 grounded、abstain 和 clarify 结果类型判定', () => {
  assert.equal(evaluateProbeAnswer({
    expectedResult: 'grounded',
    expected: ['银鸥29'],
    forbidden: ['蓝鲸17'],
  }, '根据长期记忆：项目代号是银鸥29。').passed, true);
  assert.equal(evaluateProbeAnswer({
    expectedResult: 'grounded',
    expected: ['银鸥29'],
    forbidden: ['蓝鲸17'],
  }, '项目代号是银鸥29。').passed, false);
  assert.equal(evaluateProbeAnswer({
    expectedResult: 'grounded',
    expected: ['银鸥29'],
    forbidden: ['蓝鲸17'],
  }, '项目代号是晨曦计划。').passed, false);

  assert.equal(evaluateProbeAnswer({
    expectedResult: 'abstain',
    expected: [],
    forbidden: ['翠叶禁区'],
  }, '不知道。').passed, true);
  assert.equal(evaluateProbeAnswer({
    expectedResult: 'abstain',
    expected: [],
    forbidden: ['翠叶禁区'],
  }, '可能叫绿色花园。').passed, false);
  assert.equal(evaluateProbeAnswer({
    expectedResult: 'abstain',
    expected: [],
    forbidden: ['翠叶禁区'],
  }, '不知道，也许是翠叶禁区。').passed, false);
  assert.equal(evaluateProbeAnswer({
    expectedResult: 'abstain',
    expected: [],
    forbidden: [],
  }, '我不知道，也许叫绿色花园。').passed, false);
  for (const looseAbstention of ['不知道', '不知道.', '不知道!']) {
    assert.equal(evaluateProbeAnswer({
      expectedResult: 'abstain',
      expected: [],
      forbidden: [],
    }, looseAbstention).passed, false);
  }

  assert.equal(evaluateProbeAnswer({
    expectedResult: 'clarify',
    expected: [],
    forbidden: [],
  }, '你是指星港项目还是晨舟项目？').passed, true);
  assert.equal(evaluateProbeAnswer({
    expectedResult: 'clarify',
    expected: [],
    forbidden: [],
  }, '暂时无法回答。').passed, false);

  const leakedProvenance = evaluateProbeAnswer({
    expectedResult: 'grounded',
    expected: ['绿松石33'],
    forbidden: [],
  }, '根据长期记忆：[派生摘要:session/84cd0bc1-c1ca-45af-a87d-416ba2859ed8] 代号是绿松石33。');
  assert.equal(leakedProvenance.passed, false);
  assert.equal(leakedProvenance.containsInternalProvenance, true);

  assert.equal(evaluateProbeAnswer({
    expectedResult: 'passthrough',
    expected: [],
    forbidden: [],
  }, '向量数据库用于按向量相似度检索数据。').passed, true);
  assert.equal(evaluateProbeAnswer({
    expectedResult: 'passthrough',
    expected: [],
    forbidden: [],
  }, '不知道。').passed, false);
});

test('延迟证据不把 null、空值和非法数字转换成 0', () => {
  for (const value of [null, undefined, '', '   ', Number.NaN, Infinity, -1]) {
    assert.equal(finiteNonNegativeNumber(value), null);
  }
  assert.equal(finiteNonNegativeNumber(0), 0);
  assert.equal(finiteNonNegativeNumber('12.5'), 12.5);
});

test('可靠召回延迟必须同时存在 rewrite 事件和 retrieval trace', () => {
  assert.equal(reliableRecallLatency(undefined, 30), null);
  assert.equal(reliableRecallLatency({}, 30), null);
  assert.equal(reliableRecallLatency({ latencyMs: null }, 30), null);
  assert.equal(reliableRecallLatency({ latencyMs: 10 }, null), null);
  assert.deepEqual(reliableRecallLatency({ latencyMs: 10.25 }, 30.5), {
    queryUnderstandingMs: 10.25,
    retrievalTraceMs: 30.5,
    reliableRecallMs: 40.75,
  });
});

test('发布阈值必须是有限正数', () => {
  for (const value of [null, undefined, '', 0, -1, Number.NaN, Infinity]) {
    assert.equal(finitePositiveNumber(value), null);
  }
  assert.equal(finitePositiveNumber('2500'), 2500);
});

test('兼容层审计快照只绑定严格行首的合法事件', () => {
  const event = {
    action: 'proxy_result',
    requestId: '11111111-1111-4111-8111-111111111111',
    result: 'success',
  };
  const base = parseCompatAuditLog(
    `[ollama-compat] ${JSON.stringify(event)}\n`,
  );
  const withShutdownNoise = parseCompatAuditLog(
    `[ollama-compat] ${JSON.stringify(event)}\nserver stopped\n`,
  );
  assert.deepEqual(withShutdownNoise, base);
  assert.equal(base.events.length, 1);
  assert.equal(base.canonicalJsonl, `${JSON.stringify(event)}\n`);

  const embeddedPrefix = parseCompatAuditLog(
    `noise [ollama-compat] ${JSON.stringify(event)}\n`,
  );
  assert.equal(embeddedPrefix.events.length, 0);

  const malformed = parseCompatAuditLog(
    '[ollama-compat] {bad-json}\n',
  );
  assert.equal(malformed.events.length, 0);
  assert.equal(malformed.invalidPrefixedLineCount, 1);
});

test('真实探针把回答门禁与同请求的脱敏兼容层审计关联', () => {
  const requestId = '11111111-1111-4111-8111-111111111111';
  const traceId = '22222222-2222-4222-8222-222222222222';
  const events = [
    {
      action: 'memory_lifecycle',
      requestId,
      result: 'before_model_completed',
    },
    {
      action: 'zero_recall_abstention',
      requestId,
      result: 'forced',
      memoryContextReason: 'private_fact_query',
      retrievalTraceId: traceId,
    },
    {
      action: 'proxy_result',
      requestId,
      result: 'success',
      retrievalTraceId: traceId,
    },
  ];
  assert.equal(evaluateCompatAudit({
    expectedResult: 'abstain',
    expectedAuditReason: 'private_fact_query',
    expectedTraceId: traceId,
  }, requestId, events).passed, true);
  assert.equal(evaluateCompatAudit({
    expectedResult: 'abstain',
    expectedAuditReason: 'explicit_query',
  }, requestId, events).passed, false);
  assert.equal(evaluateCompatAudit({
    expectedResult: 'abstain',
    expectedAuditReason: 'private_fact_query',
  }, 'another-request', events).passed, false);

  const duplicateForced = [
    ...events,
    {
      action: 'zero_recall_abstention',
      requestId,
      result: 'forced',
      memoryContextReason: 'private_fact_query',
    },
  ];
  assert.equal(evaluateCompatAudit({
    expectedResult: 'abstain',
    expectedAuditReason: 'private_fact_query',
  }, requestId, duplicateForced).passed, false);
  const conflictingForced = [
    ...events,
    {
      action: 'grounded_recall_repair',
      requestId,
      result: 'forced',
      memoryContextReason: 'private_fact_query',
    },
  ];
  assert.equal(evaluateCompatAudit({
    expectedResult: 'abstain',
    expectedAuditReason: 'private_fact_query',
  }, requestId, conflictingForced).passed, false);
  assert.equal(evaluateCompatAudit({
    expectedResult: 'clarify',
  }, requestId, events).passed, false);
  assert.equal(evaluateCompatAudit({
    expectedResult: 'abstain',
    expectedAuditReason: 'private_fact_query',
  }, 'not-a-uuid', events).requestIdValid, false);
  const wrongForcedTrace = events.map((event) =>
    event.action === 'zero_recall_abstention'
      ? { ...event, retrievalTraceId: '33333333-3333-4333-8333-333333333333' }
      : event
  );
  assert.equal(evaluateCompatAudit({
    expectedResult: 'abstain',
    expectedAuditReason: 'private_fact_query',
    expectedTraceId: traceId,
  }, requestId, wrongForcedTrace).traceMatched, false);
});
