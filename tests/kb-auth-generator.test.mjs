// tools/kb-auth-generator.html 的回归测试。
//
// 背景：该工具曾把角色 scope 生成为 `role-kb-admin`（少了冒号），
// 而内核要求 scope 形如 `type:key`——这种产出会让整份授权矩阵
// 校验失败、会话签发被静默禁用，且错误只在服务端日志里出现。
// 这里用最小 DOM 桩跑页面脚本，并用内核真实的 parseGrantedScope 裁决产出。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  parseGrantedScope,
  ISSUABLE_SCOPE_TYPES,
} from '../src/server/trusted-sessions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, '..', 'tools', 'kb-auth-generator.html');

function runGeneratorScript() {
  const html = fs.readFileSync(TOOL, 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/u);
  assert.ok(match, '工具页里应能提取到 script 块');

  const elements = new Map();
  const makeElement = (id) => ({
    id,
    innerHTML: '',
    textContent: '',
    className: '',
    value: '',
    addEventListener() {},
    click() {},
  });
  const documentStub = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    createElement: () => makeElement('created'),
  };

  // 每次调用起独立上下文：页面脚本用顶层 const 声明，同一上下文重复执行会重声明报错。
  const context = vm.createContext({
    document: documentStub,
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
    Blob: class {},
    console,
  });
  vm.runInContext(
    `${match[1]}\n;globalThis.__gen = { out, state, validate, build, addRole };`,
    context,
    { filename: 'kb-auth-generator.inline.js' },
  );
  return { ...context.__gen, documentStub };
}

test('生成器产出可通过内核 scope 校验', () => {
  const { out } = runGeneratorScript();
  const spec = JSON.parse(out.spec);
  const grants = JSON.parse(out.grants);

  assert.equal(spec.principals.length, 1);
  assert.equal(spec.principals[0].id, 'kb-writer');
  assert.ok(spec.principals[0].scopes.includes('project:dept-finance'));
  assert.equal(spec.principals[0].maxActiveSessions, 32);

  // 每个 scope 都要能被内核解析（防 role-xxx / 无冒号 之类的回归）
  for (const [principalId, entry] of Object.entries(grants.principals)) {
    assert.ok(Array.isArray(entry.scopes), `${principalId} 应有 scopes 数组`);
    for (const scope of entry.scopes) {
      const parsed = parseGrantedScope(scope);
      assert.ok(
        ISSUABLE_SCOPE_TYPES.includes(parsed.scopeType),
        `${scope} 的 type 不可签发`,
      );
    }
    assert.ok(
      Number.isInteger(entry.maxActiveSessions) && entry.maxActiveSessions > 0,
    );
  }

  for (const scope of spec.principals[0].scopes) {
    assert.ok(scope.includes(':'), `scope 缺少分隔冒号：${scope}`);
  }
});

test('自定义角色被规范化为 role:<key> 形式', () => {
  const { build, addRole } = runGeneratorScript();
  addRole(0, 'role-DATA-Review');
  const spec = JSON.parse(build().spec);
  assert.ok(spec.principals[0].scopes.includes('role:data-review'));
  assert.ok(!spec.principals[0].scopes.some((s) => s.startsWith('role-')));
  for (const scope of spec.principals[0].scopes) parseGrantedScope(scope);
});

test('校验器能拦住非法配置并始终提示开关效应', () => {
  const { state, validate } = runGeneratorScript();
  assert.equal(validate().errors.length, 0);

  state.principals.push({
    id: 'BAD ID!',
    displayName: '',
    depts: [],
    roles: [],
    maxActiveSessions: 0,
    tokenLabel: '',
    expiresAt: '',
  });
  const result = validate();
  assert.ok(result.errors.some((e) => e.includes('不合法')));
  assert.ok(result.errors.some((e) => e.includes('maxActiveSessions')));
  assert.ok(result.warnings.some((w) => w.includes('未授予任何 scope')));
  assert.ok(result.warnings.some((w) => w.includes('匿名')));
});

test('幂等键模板始终带部门前缀', () => {
  const { out, documentStub } = runGeneratorScript();
  const templates = documentStub.getElementById('idem').innerHTML;
  assert.ok(out.cmd.includes('check --spec') && out.cmd.includes('apply --spec'));
  assert.ok(templates.includes('kb:dept-finance:'));
  assert.ok(templates.includes('kb:dept-hr:'));
});
