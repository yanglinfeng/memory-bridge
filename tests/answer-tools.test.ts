import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnswerToolRegistry,
  answerToolRegistry,
  evaluateArithmeticExpression,
  parseDateInput,
} from '../src/server/answer-tools.js';
import {
  ABSTENTION_PROFILES,
  resolveAbstentionProfile,
} from '../src/server/config.js';

// ── 弃答策略档案 ──────────────────────────────────────────

test('弃答档案：未知值回落 strict（零回归基线）', () => {
  assert.equal(resolveAbstentionProfile(undefined), 'strict');
  assert.equal(resolveAbstentionProfile(''), 'strict');
  assert.equal(resolveAbstentionProfile('aggressive'), 'strict');
  assert.equal(resolveAbstentionProfile(' BALANCED '), 'balanced');
});

test('弃答档案：三档默认值按预期放宽', () => {
  // 相似度门随放宽单调收紧下降；兜底与 filler 随放宽递增
  assert.ok(
    ABSTENTION_PROFILES.strict.semanticMinSimilarity >
      ABSTENTION_PROFILES.balanced.semanticMinSimilarity,
  );
  assert.ok(
    ABSTENTION_PROFILES.balanced.semanticMinSimilarity >
      ABSTENTION_PROFILES.eager.semanticMinSimilarity,
  );
  assert.ok(
    ABSTENTION_PROFILES.strict.semanticRerankEmptyFallbackLimit <=
      ABSTENTION_PROFILES.balanced.semanticRerankEmptyFallbackLimit &&
      ABSTENTION_PROFILES.balanced.semanticRerankEmptyFallbackLimit <=
        ABSTENTION_PROFILES.eager.semanticRerankEmptyFallbackLimit,
  );
  assert.ok(
    ABSTENTION_PROFILES.strict.semanticRerankFillerLimit <=
      ABSTENTION_PROFILES.balanced.semanticRerankFillerLimit &&
      ABSTENTION_PROFILES.balanced.semanticRerankFillerLimit <=
        ABSTENTION_PROFILES.eager.semanticRerankFillerLimit,
  );
  // balanced 档与已验证的评测口径对齐：filler 必须开启
  assert.ok(ABSTENTION_PROFILES.balanced.semanticRerankFillerLimit > 0);
  // strict 档必须保持出厂零回归基线
  assert.equal(ABSTENTION_PROFILES.strict.semanticRerankFillerLimit, 0);
  assert.equal(ABSTENTION_PROFILES.strict.semanticMinSimilarity, 0.35);
});

// ── 计算器：正确性 ────────────────────────────────────────

test('calculator：四则运算、幂、一元负号', () => {
  assert.equal(evaluateArithmeticExpression('1 + 2 * 3'), 7);
  assert.equal(evaluateArithmeticExpression('(1 + 2) * 3'), 9);
  assert.equal(evaluateArithmeticExpression('2 ^ 10'), 1024);
  assert.equal(evaluateArithmeticExpression('-5 + 3'), -2);
  assert.equal(evaluateArithmeticExpression('10 - -3'), 13);
  assert.equal(evaluateArithmeticExpression('0.1 + 0.2'), 0.3);
  assert.equal(evaluateArithmeticExpression('2 ^ 3 ^ 2'), 512); // 右结合
  assert.equal(evaluateArithmeticExpression('10 % 3'), 1);
});

test('calculator：注入面与非法输入全部拒绝', () => {
  const rejected = [
    'process.exit(1)',
    '1; 2',
    '__proto__',
    'alert(1)',
    '1 + apple',
    '0x10 + 1',
    '',
    '   ',
    '1 +',
    '(1 + 2',
    '1 + 2)',
  ];
  for (const expression of rejected) {
    assert.throws(
      () => evaluateArithmeticExpression(expression),
      undefined,
      `应拒绝：${expression}`,
    );
  }
});

test('calculator：除零与超长表达式拒绝', () => {
  assert.throws(() => evaluateArithmeticExpression('1 / 0'));
  assert.throws(() =>
    evaluateArithmeticExpression('1 + ' + '2 + '.repeat(200) + '3')
  );
  assert.throws(() => evaluateArithmeticExpression('1 + '.repeat(200)));
});

// ── 日期工具 ─────────────────────────────────────────────

test('date_diff：天数差与年月日拆分（含中文日期）', () => {
  const base = answerToolRegistry.get('date_diff');
  assert.ok(base);
  const result = base.execute({
    from: '2024-01-01',
    to: '2024-03-05',
  }) as { days: number; wholeDays: number; calendar: { months: number; days: number } };
  assert.equal(result.wholeDays, 64);
  assert.equal(result.calendar.months, 2);
  assert.equal(result.calendar.days, 4);

  const cn = base.execute({
    from: '2024年3月5日',
    to: '2024/3/15',
  }) as { wholeDays: number };
  assert.equal(cn.wholeDays, 10);
});

test('date_diff：负跨度与非法日期', () => {
  const base = answerToolRegistry.get('date_diff');
  assert.ok(base);
  const reversed = base.execute({
    from: '2024-03-05',
    to: '2024-01-01',
  }) as { wholeDays: number };
  assert.equal(reversed.wholeDays, -64);
  assert.throws(() => base.execute({ from: '2024-02-30', to: '2024-03-01' }));
  assert.throws(() => base.execute({ from: '不是日期', to: '2024-03-01' }));
  assert.throws(() => base.execute({ from: '2024-01-01' }));
});

test('date_shift：正负平移与星期', () => {
  const base = answerToolRegistry.get('date_shift');
  assert.ok(base);
  const result = base.execute({
    date: '2024-01-01',
    days: 30,
  }) as { result: string; weekday: string };
  assert.equal(result.result, '2024-01-31');
  const back = base.execute({
    date: '2024-03-01',
    days: -1,
  }) as { result: string };
  assert.equal(back.result, '2024-02-29'); // 闰年
  assert.throws(() => base.execute({ date: '2024-01-01', days: 1.5 }));
});

test('parseDateInput：完整 ISO 时间戳可用', () => {
  const parsed = parseDateInput('2024-03-05T08:30:00Z', 'from');
  assert.equal(parsed.toISOString(), '2024-03-05T08:30:00.000Z');
});

// ── 注册表通用行为 ────────────────────────────────────────

test('registry：invoke 错误封装与结果尺寸护栏', async () => {
  const registry = new AnswerToolRegistry();
  registry.register({
    name: 'boom',
    title: 'boom',
    description: 'always throws',
    params: [],
    execute() {
      throw new Error('故意失败');
    },
  });
  registry.register({
    name: 'huge',
    title: 'huge',
    description: 'oversized result',
    params: [],
    execute() {
      return { blob: 'x'.repeat(10_000) };
    },
  });
  const bad = await registry.invoke('boom', {});
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /故意失败/);
  const unknown = await registry.invoke('nope', {});
  assert.equal(unknown.ok, false);
  assert.match(String(unknown.error), /未知工具/);
  const oversized = await registry.invoke('huge', {});
  assert.equal(oversized.ok, false);
  assert.match(String(oversized.error), /字节上限/);
});

test('registry：重名与非法工具名拒绝', () => {
  const registry = new AnswerToolRegistry();
  const tool = {
    name: 'ok_tool',
    title: 'ok',
    description: 'ok',
    params: [],
    execute() {
      return 1;
    },
  };
  registry.register(tool);
  assert.throws(() => registry.register(tool));
  assert.throws(() =>
    registry.register({ ...tool, name: 'Bad-Name' }),
  );
  assert.ok(answerToolRegistry.has('calculator'));
  assert.ok(answerToolRegistry.list().length >= 3);
});
