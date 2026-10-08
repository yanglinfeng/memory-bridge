import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authenticationGateSignalFromProbeStatus,
  reduceAuthenticationGate,
} from '../src/web/src/authentication-gate.js';

// 回归背景：/api/health 是匿名端点，旧实现拿它的 200 去撤登录门，
// 而受保护接口无令牌返回 401 会把门挂回来——管理台上形成登录框反复
// 重挂载的循环，且用户输入的令牌被逐次清空。
test('连通性信号不得改变登录门状态（防重挂载循环）', () => {
  assert.equal(
    reduceAuthenticationGate(true, { type: 'health-ok' }),
    true,
    'health 200 不得撤下已经挂起的登录门',
  );
  assert.equal(
    reduceAuthenticationGate(false, { type: 'health-ok' }),
    false,
  );
  assert.equal(
    reduceAuthenticationGate(true, { type: 'health-unreachable' }),
    true,
    '服务不可达时登录门应保持，而不是放行',
  );
});

test('登录门只由身份信号翻转', () => {
  assert.equal(
    reduceAuthenticationGate(false, { type: 'identity-unauthorized' }),
    true,
  );
  assert.equal(
    reduceAuthenticationGate(false, { type: 'authentication-lost' }),
    true,
  );
  assert.equal(
    reduceAuthenticationGate(true, { type: 'identity-ok' }),
    false,
  );
  // 未启用身份服务的实例（503）不该拦人
  assert.equal(
    reduceAuthenticationGate(true, { type: 'identity-service-absent' }),
    false,
  );
});

test('状态机是幂等的：同向重复信号不产生额外翻转', () => {
  assert.equal(
    reduceAuthenticationGate(true, { type: 'authentication-lost' }),
    true,
    '401 洪峰下重复挂门应保持同一状态（调用方据此跳过重挂载）',
  );
  assert.equal(reduceAuthenticationGate(false, { type: 'identity-ok' }), false);
});

test('身份探针状态到信号：401 挂门、503 不拦人、网络错误不表态', () => {
  assert.deepEqual(authenticationGateSignalFromProbeStatus(401), {
    type: 'identity-unauthorized',
  });
  assert.deepEqual(authenticationGateSignalFromProbeStatus(200), {
    type: 'identity-ok',
  });
  assert.deepEqual(authenticationGateSignalFromProbeStatus(503), {
    type: 'identity-service-absent',
  });
  assert.equal(
    authenticationGateSignalFromProbeStatus(null),
    null,
    '网络不可达时不携带登录态信息，调用方应保持原状态',
  );
});
