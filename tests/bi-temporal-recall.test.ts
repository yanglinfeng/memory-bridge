// bi-temporal 插电验证：
// 1) 作答侧——context 透出 发生时间/有效期 窗口（当前事实与历史事实两种形态）
// 2) 召回侧——valid_to 封口的历史事实默认不可见；superseded 历史事实对
//    as-of 过去时间可见、对"现在"不可见；valid_from 晚于 as-of 的新事实不可见
// 3) 无效 as-of 时间戳 fail-loud
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { MemoryStore } from '../src/server/memory-store.js';

function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-bi-temporal-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  return {
    store,
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('context 透出发生时间与有效期窗口（当前事实）', async () => {
  const f = fixture();
  try {
    f.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'project',
      content: '用户的家庭旅行计划是去夏威夷。',
      occurredAt: '2026-08-01T00:00:00.000Z',
      validFrom: '2026-08-01T00:00:00.000Z',
    });
    const response = await f.store.getContextReliable({
      userId: 'alice',
      namespace: 'personal',
      query: '家庭旅行',
    });
    assert.equal(response.memories.length, 1);
    assert.ok(response.context.includes('发生时间: 2026-08-01T00:00:00.000Z'));
    assert.ok(response.context.includes('有效期: 2026-08-01T00:00:00.000Z ~ 至今有效'));
  } finally {
    f.close();
  }
});

test('context 对 valid_to 封口的历史事实带"已被新事实取代"标注（as-of 过去可召回）', async () => {
  const f = fixture();
  try {
    f.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'project',
      content: '用户的家庭旅行计划是去夏威夷。',
      occurredAt: '2026-08-01T00:00:00.000Z',
      validFrom: '2026-08-01T00:00:00.000Z',
      validTo: '2026-08-20T00:00:00.000Z',
    });
    const response = await f.store.getContextReliable({
      userId: 'alice',
      namespace: 'personal',
      query: '家庭旅行',
      timestamp: '2026-08-10T00:00:00.000Z',
    });
    assert.equal(response.memories.length, 1);
    assert.ok(
      response.context.includes(
        '有效期: 2026-08-01T00:00:00.000Z ~ 2026-08-20T00:00:00.000Z（此后已被新事实取代，属历史事实）',
      ),
    );
  } finally {
    f.close();
  }
});

test('valid_to 已封口的事实对默认（现在）召回不可见', async () => {
  const f = fixture();
  try {
    f.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'project',
      content: '用户的家庭旅行计划是去夏威夷。',
      validTo: '2026-08-20T00:00:00.000Z',
    });
    f.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'project',
      content: '用户的家庭旅行计划改为去巴黎。',
    });
    const response = await f.store.getContextReliable({
      userId: 'alice',
      namespace: 'personal',
      query: '家庭旅行',
    });
    assert.ok(response.context.includes('巴黎'));
    assert.ok(!response.context.includes('夏威夷'));
  } finally {
    f.close();
  }
});

test('superseded 历史事实：as-of 过去可见、现在不可见；valid_from 晚于 as-of 的新事实不可见', async () => {
  const f = fixture();
  try {
    const prior = f.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'project',
      content: '用户的家庭旅行计划是去夏威夷。',
      occurredAt: '2026-08-01T00:00:00.000Z',
    }).memory;
    f.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'project',
      content: '用户的家庭旅行计划改为去巴黎。',
      occurredAt: '2026-08-20T00:00:00.000Z',
      validFrom: '2026-08-20T00:00:00.000Z',
      supersedesId: prior.id,
    });

    // as-of 现在：只见当前事实（巴黎），被取代的夏威夷不可见
    const nowResponse = await f.store.getContextReliable({
      userId: 'alice',
      namespace: 'personal',
      query: '家庭旅行',
    });
    assert.ok(nowResponse.context.includes('巴黎'));
    assert.ok(!nowResponse.context.includes('夏威夷'));

    // as-of 8 月 10 日：夏威夷（当时仍有效）可见，巴黎（valid_from 8-20 未生效）不可见
    const pastResponse = await f.store.getContextReliable({
      userId: 'alice',
      namespace: 'personal',
      query: '家庭旅行',
      timestamp: '2026-08-10T00:00:00.000Z',
    });
    assert.ok(pastResponse.context.includes('夏威夷'));
    assert.ok(!pastResponse.context.includes('巴黎'));
    // 历史事实在 context 中带有效期窗口/历史标注，模型可据此回答"以前是什么"
    assert.ok(
      pastResponse.context.includes('属历史事实'),
    );
  } finally {
    f.close();
  }
});

test('无效的 as-of 时间戳被拒绝（fail-loud）', async () => {
  const f = fixture();
  try {
    f.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'project',
      content: '用户的家庭旅行计划是去夏威夷。',
    });
    await assert.rejects(
      f.store.getContextReliable({
        userId: 'alice',
        namespace: 'personal',
        query: '家庭旅行',
        timestamp: 'not-a-date',
      }),
      /必须是有效的 ISO 日期时间/,
    );
  } finally {
    f.close();
  }
});
