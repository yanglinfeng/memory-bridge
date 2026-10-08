import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { MemoryStore } from '../src/server/memory-store.js';

// 回归背景：记忆列表/详情响应此前不带 stableKey，下游集成方
// （如 kb-ingest）只能按 title 匹配做幂等与版本判定，脆弱且会撞同名。
test('列表与详情响应携带 stableKey（显式键与自动生成键）', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-stable-key-'));
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  try {
    const withKey = store.remember({
      kind: 'knowledge',
      content: '差旅与报销管理制度：住宿补贴一线城市每晚 450 元。',
      stableKey: 'travel-policy-v2',
    }).memory;
    const withoutKey = store.remember({
      kind: 'preference',
      content: '用户偏好安静的工作环境。',
    }).memory;

    const listed = store.list({
      userId: 'default',
      namespace: 'personal',
      query: '差旅',
    });
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].id, withKey.id);
    assert.equal(listed.items[0].stableKey, 'travel-policy-v2');

    const fetched = store.get(withoutKey.id);
    assert.ok(fetched);
    // 未显式给 stableKey 时由内核生成 explicit:<uuid> 形式的键，保证幂等判定始终可用
    assert.match(fetched.stableKey ?? '', /^explicit:[0-9a-f-]{36}$/);

    // 无查询的列表也必须带（分页浏览场景同样需要做幂等判定）
    const all = store.list({ userId: 'default', namespace: 'personal' });
    const byId = new Map(all.items.map((item) => [item.id, item]));
    assert.equal(byId.get(withKey.id)?.stableKey, 'travel-policy-v2');
    assert.match(byId.get(withoutKey.id)?.stableKey ?? '', /^explicit:[0-9a-f-]{36}$/);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('备份导出/导入保真 stableKey', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-stable-key-bk-'));
  const source = openDatabase(path.join(directory, 'source.sqlite3'));
  const target = openDatabase(path.join(directory, 'target.sqlite3'));
  const sourceStore = new MemoryStore(source);
  const targetStore = new MemoryStore(target);
  try {
    const created = sourceStore.remember({
      kind: 'knowledge',
      content: '报销制度：单次出差预算 5000 元以内由部门负责人审批。',
      stableKey: 'travel-policy-approval',
    }).memory;

    const backup = sourceStore.exportAll('default');
    const exported = backup.memories.find((item) => item.id === created.id);
    assert.equal(exported?.stableKey, 'travel-policy-approval');

    targetStore.importAll(JSON.parse(JSON.stringify(backup)));
    const restored = targetStore.list({
      userId: 'default',
      namespace: 'personal',
    });
    assert.equal(restored.total, 1);
    assert.equal(restored.items[0].stableKey, 'travel-policy-approval');
  } finally {
    source.close();
    target.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
