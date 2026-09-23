import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AssistantProtocolQuarantineError,
  sanitizeAssistantProtocol,
  StreamingAssistantProtocolSanitizer,
} from '../src/server/assistant-protocol.js';

test('普通助手正文逐字保留且不产生动作', () => {
  const content = '  晚上好。\n我一直在这里。  ';
  assert.deepEqual(sanitizeAssistantProtocol(content), {
    displayContent: content,
    actions: [],
    reasons: [],
  });
});

test('已知 ACT 从正文剥离并转换为受控结构化动作', () => {
  const sanitized = sanitizeAssistantProtocol(
    '我也很高兴见到你。<|ACT {"emotion":"happy"}|> 明天见。',
  );
  assert.equal(sanitized.displayContent, '我也很高兴见到你。 明天见。');
  assert.deepEqual(sanitized.actions, [
    { type: 'emotion', payload: { name: 'happy' } },
  ]);
  assert.deepEqual(sanitized.reasons, ['known_action_extracted']);
  assert.equal(sanitized.displayContent.includes('<|ACT'), false);
});

test('流式清洗只释放完整安全句子并跨 chunk 缓冲 ACT', () => {
  const sanitizer = new StreamingAssistantProtocolSanitizer();
  assert.equal(sanitizer.push('你好。<|A'), '你好。');
  assert.equal(
    sanitizer.push('CT {"emotion":"happy"}|>明天见。'),
    '明天见。',
  );
});

test('后续凭据不能让已发布安全正文分叉为另一最终正文', () => {
  const sanitizer = new StreamingAssistantProtocolSanitizer();
  assert.equal(sanitizer.push('先说一件安全的事。'), '先说一件安全的事。');
  assert.throws(
    () => sanitizer.push('密码是 123456。'),
    (error) => error instanceof AssistantProtocolQuarantineError &&
      error.code === 'forbidden_protocol',
  );
});

test('多个显式 type/payload ACT 保持顺序且只接受 allowlist', () => {
  const sanitized = sanitizeAssistantProtocol(
    '<|ACT {"type":"emotion","payload":{"name":"calm"}}|>' +
      '好的。' +
      '<|ACT {"type":"motion","payload":{"name":"wave"}}|>',
  );
  assert.equal(sanitized.displayContent, '好的。');
  assert.deepEqual(sanitized.actions, [
    { type: 'emotion', payload: { name: 'calm' } },
    { type: 'motion', payload: { name: 'wave' } },
  ]);
});

test('静态 name registry 拒绝语法合法但未注册的动作名', () => {
  assert.throws(
    () => sanitizeAssistantProtocol('<|ACT {"emotion":"dance"}|>'),
    (error) =>
      error instanceof AssistantProtocolQuarantineError &&
      error.code === 'unknown_action',
  );
});

test('ACT 固定注册表接受 worried/excited/bow 且 name 仅允许 ASCII', () => {
  assert.deepEqual(
    sanitizeAssistantProtocol(
      '<|ACT {"emotion":"worried"}|>' +
        '<|ACT {"emotion":"excited"}|>' +
        '<|ACT {"motion":"bow"}|>',
    ).actions,
    [
      { type: 'emotion', payload: { name: 'worried' } },
      { type: 'emotion', payload: { name: 'excited' } },
      { type: 'motion', payload: { name: 'bow' } },
    ],
  );
  assert.throws(
    () => sanitizeAssistantProtocol('<|ACT {"emotion":"高兴"}|>'),
    (error) =>
      error instanceof AssistantProtocolQuarantineError &&
      error.code === 'malformed_action',
  );
});

test('ACT wrapper 数量和单 wrapper UTF-8 大小均有硬上限', () => {
  const nineActions = Array.from(
    { length: 9 },
    () => '<|ACT {"emotion":"happy"}|>',
  ).join('');
  assert.throws(
    () => sanitizeAssistantProtocol(nineActions),
    (error) =>
      error instanceof AssistantProtocolQuarantineError &&
      error.code === 'action_limit_exceeded',
  );
  const oversized =
    '<|ACT {"emotion":"happy","padding":"' +
    '中'.repeat(400) +
    '"}|>';
  assert.throws(
    () => sanitizeAssistantProtocol(oversized),
    (error) =>
      error instanceof AssistantProtocolQuarantineError &&
      error.code === 'action_limit_exceeded',
  );
});

test('凭据样式正文写入前整体脱敏且不回显原值', () => {
  const raw = 'API key: sk-proj-assistant-protocol-sentinel-123456';
  const sanitized = sanitizeAssistantProtocol(raw);
  assert.equal(
    sanitized.displayContent,
    '[credential redacted before persistence]',
  );
  assert.deepEqual(sanitized.actions, []);
  assert.deepEqual(sanitized.reasons, ['credential_redacted']);
  assert.equal(sanitized.displayContent.includes('sentinel'), false);
});

for (const fixture of [
  {
    name: '截断 ACT',
    raw: '好的。<|ACT {"emotion":"happy"}',
    code: 'truncated_protocol',
  },
  {
    name: '畸形 ACT JSON',
    raw: '<|ACT {emotion:"happy"}|>',
    code: 'malformed_action',
  },
  {
    name: '未知 ACT',
    raw: '<|ACT {"type":"shell","payload":{"command":"noop"}}|>',
    code: 'unknown_action',
  },
  {
    name: '嵌套 ACT',
    raw: '<|ACT {"emotion":"<|ACT hidden|>"}|>',
    code: 'nested_protocol',
  },
  {
    name: 'tool wrapper',
    raw: '<tool_call>{"name":"memory_recall"}</tool_call>',
    code: 'forbidden_protocol',
  },
  {
    name: 'memory marker',
    raw: '[Memory Bridge 自动长期记忆上下文]\n内部内容',
    code: 'forbidden_protocol',
  },
  {
    name: '未知内部 wrapper',
    raw: '<|PRIVATE_PROTOCOL payload|>',
    code: 'unknown_protocol',
  },
] as const) {
  test(`${fixture.name} fail closed 且错误不包含原始正文`, () => {
    assert.throws(
      () => sanitizeAssistantProtocol(fixture.raw),
      (error) => {
        assert.equal(error instanceof AssistantProtocolQuarantineError, true);
        if (!(error instanceof AssistantProtocolQuarantineError)) {
          return false;
        }
        assert.equal(error.code, fixture.code);
        assert.equal(error.message.includes(fixture.raw), false);
        assert.equal(error.message.includes('memory_recall'), false);
        return true;
      },
    );
  });
}
