// bi-temporal 插电验证：
// 1) 作答侧——context 透出 发生时间/有效期 窗口（当前事实与历史事实两种形态）
// 2) 召回侧——valid_to 封口的历史事实默认不可见；superseded 历史事实对
//    as-of 过去时间可见、对"现在"不可见；valid_from 晚于 as-of 的新事实不可见
// 3) 无效 as-of 时间戳 fail-loud
// 4) 取代侧——supersede 必须显式写被取代记忆的 valid_to（把 as-of 窗口从
//    通用的 updated_at 回退判据上解耦），并覆盖无法构成合法窗口的边界
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
    database,
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** 读当前投影与当前版本上的 valid_to，用于验证两者一致（完整备份导入的前提）。 */
function validityProjection(database: import('node:sqlite').DatabaseSync, id: string) {
  // node:sqlite 返回的行是 null 原型对象，assert/strict 的 deepEqual 会比较原型，
  // 故这里归一成普通对象再比较。
  const row = database
    .prepare(
      `SELECT m.valid_to AS projection, v.valid_to AS version
       FROM memories m
       JOIN memory_items i ON i.id = m.id
       JOIN memory_versions v ON v.id = i.current_version_id
       WHERE m.id = ?`,
    )
    .get(id) as { projection?: string | null; version?: string | null } | undefined;
  return {
    projection: row?.projection ?? null,
    version: row?.version ?? null,
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

test('supersede 显式写入被取代记忆的 valid_to，取继任者的 valid_from', () => {
  const f = fixture();
  try {
    const prior = f.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'project',
      content: '用户的家庭旅行计划是去夏威夷。',
      occurredAt: '2026-08-01T00:00:00.000Z',
      validFrom: '2026-08-01T00:00:00.000Z',
    }).memory;
    assert.equal(f.store.get(prior.id, true, 'alice')?.validTo, null);

    f.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'project',
      content: '用户的家庭旅行计划改为去巴黎。',
      occurredAt: '2026-08-20T00:00:00.000Z',
      validFrom: '2026-08-20T00:00:00.000Z',
      supersedesId: prior.id,
    });

    const superseded = f.store.get(prior.id, true, 'alice');
    assert.equal(superseded?.status, 'superseded');
    // 窗口闭在新事实开始有效的那一刻，而不是"取代动作发生的那一刻"
    assert.equal(superseded?.validTo, '2026-08-20T00:00:00.000Z');
    // 当前版本必须同步封口：完整备份的一致性校验会逐字段对撞投影与当前版本，
    // 只改 memories 会让备份导不回去（validateFullBackupState 的 valid_to 对撞）。
    assert.deepEqual(validityProjection(f.database, prior.id), {
      projection: '2026-08-20T00:00:00.000Z',
      version: '2026-08-20T00:00:00.000Z',
    });
  } finally {
    f.close();
  }
});

test('supersede 时继任者未声明 valid_from 则以取代时刻封口', () => {
  const f = fixture();
  try {
    const prior = f.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'project',
      content: '用户的家庭旅行计划是去夏威夷。',
      occurredAt: '2026-08-01T00:00:00.000Z',
    }).memory;
    const before = new Date().toISOString();
    f.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'project',
      content: '用户的家庭旅行计划改为去巴黎。',
      supersedesId: prior.id,
    });
    const after = new Date().toISOString();

    const validTo = f.store.get(prior.id, true, 'alice')?.validTo;
    assert.ok(validTo, 'valid_to 必须被写入');
    assert.ok(
      validTo! >= before && validTo! <= after,
      `valid_to 应落在取代时刻区间内，实得 ${validTo}`,
    );
    // 投影与当前版本一致（否则备份无法导入）
    assert.deepEqual(validityProjection(f.database, prior.id), {
      projection: validTo,
      version: validTo,
    });
  } finally {
    f.close();
  }
});

test('as-of 落在「继任者生效」与「取代时刻」之间时，旧事实不再泄漏', async () => {
  const f = fixture();
  try {
    const prior = f.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'project',
      content: '用户的家庭旅行计划是去夏威夷。',
      occurredAt: '2026-08-01T00:00:00.000Z',
      validFrom: '2026-08-01T00:00:00.000Z',
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

    // 取代动作发生在"现在"（远晚于 2026-08-20）。若只靠 updated_at 回退判据，
    // 这个时点会把旧事实一并放行——新事实 8-20 已生效，旧事实本不该可见。
    const response = await f.store.getContextReliable({
      userId: 'alice',
      namespace: 'personal',
      query: '家庭旅行',
      timestamp: '2026-09-01T00:00:00.000Z',
    });
    assert.ok(response.context.includes('巴黎'));
    assert.ok(
      !response.context.includes('夏威夷'),
      '旧事实的有效期已于 8-20 终止，as-of 9-01 不应召回',
    );

    // 早于继任者生效的时点仍能看到旧事实
    const earlier = await f.store.getContextReliable({
      userId: 'alice',
      namespace: 'personal',
      query: '家庭旅行',
      timestamp: '2026-08-10T00:00:00.000Z',
    });
    assert.ok(earlier.context.includes('夏威夷'));
    assert.ok(!earlier.context.includes('巴黎'));
  } finally {
    f.close();
  }
});

test('无法构成合法窗口时保留 valid_to 为 NULL（不去钳制历史）', () => {
  const f = fixture();
  try {
    // 旧事实的 valid_from 晚于继任者生效时刻——写 valid_to 会得到
    // valid_from >= valid_to 的倒退窗口，此时应保持 NULL。
    const prior = f.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'project',
      content: '用户的家庭旅行计划是去夏威夷。',
      validFrom: '2026-09-01T00:00:00.000Z',
    }).memory;
    f.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'project',
      content: '用户的家庭旅行计划改为去巴黎。',
      validFrom: '2026-08-20T00:00:00.000Z',
      supersedesId: prior.id,
    });

    const superseded = f.store.get(prior.id, true, 'alice');
    assert.equal(superseded?.status, 'superseded');
    assert.equal(superseded?.validTo, null);
    // NULL 同样要两张表一致——保留原值不是"只跳过一次写入"
    assert.deepEqual(validityProjection(f.database, prior.id), {
      projection: null,
      version: null,
    });
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
