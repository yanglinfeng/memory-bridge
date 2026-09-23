import assert from 'node:assert/strict';
import test from 'node:test';
import { parseModelKeepAlive } from '../src/server/config.js';
import {
  backgroundModelAbortSignal,
  backgroundModelWorkAllowed,
  beginForegroundActivity,
  isBackgroundModelPreempted,
  modelQosSnapshot,
  resetModelQosForTests,
  runWithBackgroundModelQos,
} from '../src/server/model-qos.js';

test('前台召回期间和安静窗口内后台模型任务主动让权', () => {
  resetModelQosForTests();
  let current = 10_000;
  const now = () => current;
  assert.equal(backgroundModelWorkAllowed(2_000, now), true);

  const releaseFirst = beginForegroundActivity(now);
  const releaseSecond = beginForegroundActivity(now);
  assert.equal(backgroundModelWorkAllowed(2_000, now), false);
  assert.equal(modelQosSnapshot(now).foregroundCount, 2);

  releaseFirst();
  releaseFirst();
  assert.equal(modelQosSnapshot(now).foregroundCount, 1);
  releaseSecond();
  assert.equal(modelQosSnapshot(now).foregroundCount, 0);
  assert.equal(backgroundModelWorkAllowed(2_000, now), false);

  current += 1_999;
  assert.equal(backgroundModelWorkAllowed(2_000, now), false);
  current += 1;
  assert.equal(backgroundModelWorkAllowed(2_000, now), true);
  resetModelQosForTests();
});

test('模型常驻配置拒绝会主动卸载模型的零值', () => {
  assert.equal(parseModelKeepAlive(undefined), '15m');
  assert.equal(parseModelKeepAlive('30m'), '30m');
  assert.equal(parseModelKeepAlive('-1'), -1);
  assert.throws(() => parseModelKeepAlive('0'), /正数时长/u);
  assert.throws(() => parseModelKeepAlive('0m'), /正数时长/u);
});

test('前台活动会中断当前后台模型上下文且不污染后续上下文', async () => {
  resetModelQosForTests();
  let releaseForeground: (() => void) | null = null;
  try {
    await runWithBackgroundModelQos(async () => {
      const signal = backgroundModelAbortSignal(30_000);
      assert.equal(signal.aborted, false);

      releaseForeground = beginForegroundActivity();
      assert.equal(signal.aborted, true);
      assert.equal(isBackgroundModelPreempted(signal.reason), true);
    });

    releaseForeground?.();
    releaseForeground = null;
    await runWithBackgroundModelQos(async () => {
      assert.equal(backgroundModelAbortSignal(30_000).aborted, false);
    });
  } finally {
    releaseForeground?.();
    resetModelQosForTests();
  }
});
