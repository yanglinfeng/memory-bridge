import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { MemoryStore } from '../src/server/memory-store.js';

test('AC-09 同库双账户各 100 条时相同 namespace、谓词和正文仍保持零泄漏', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-ac09-accounts-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  const namespace = 'shared-namespace';
  const sharedContent =
    'AC-09 多账户共同正文：玄青海豚偏好低饱和度界面。';
  const sharedPredicate = '用户::界面色彩偏好';
  const memoriesByAccount = new Map<string, string>();

  try {
    for (const userId of ['alice', 'bob']) {
      const shared = store.remember({
        userId,
        namespace,
        kind: 'preference',
        content: sharedContent,
        scopeType: 'personal',
        scopeKey: 'self',
        stableKey: `personal::self::${sharedPredicate}`,
        predicateKey: sharedPredicate,
        normalizedValue: '低饱和度界面',
        normalizedValueHash: 'low-saturation-interface',
      }).memory;
      memoriesByAccount.set(userId, shared.id);

      for (let index = 1; index < 100; index += 1) {
        store.remember({
          userId,
          namespace,
          kind: 'knowledge',
          content:
            `AC-09 ${userId} 私有夹具 ${index}：` +
            `隔离标识 ${userId}-${index}。`,
          scopeType: 'personal',
          scopeKey: 'self',
          stableKey: `personal::self::用户::私有夹具-${index}`,
          predicateKey: `用户::私有夹具-${index}`,
          normalizedValue: `${userId}-${index}`,
          normalizedValueHash: `${userId}-${index}`,
        });
      }
    }

    for (const userId of ['alice', 'bob']) {
      const otherUserId = userId === 'alice' ? 'bob' : 'alice';
      const expectedId = memoriesByAccount.get(userId);
      const otherId = memoriesByAccount.get(otherUserId);
      assert.ok(expectedId);
      assert.ok(otherId);
      assert.notEqual(expectedId, otherId);
      assert.equal(
        store.list({
          userId,
          namespace,
          limit: 200,
        }).total,
        100,
      );

      const recalled = store.recall({
        userId,
        namespace,
        query: 'AC-09 玄青海豚低饱和度界面偏好是什么？',
        scopes: [{ scopeType: 'personal', scopeKey: 'self' }],
        limit: 10,
      });
      assert.deepEqual(
        recalled.map((entry) => entry.memory.id),
        [expectedId],
      );
      assert.ok(
        recalled.every((entry) => entry.memory.userId === userId),
      );
      assert.equal(
        recalled.some((entry) => entry.memory.id === otherId),
        false,
      );
      assert.equal(store.get(otherId, true, userId), null);
    }
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('AC-09 同账户 personal 共享且 persona/session 私有并执行就近遮蔽', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-ac09-personas-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  const userId = 'alice';
  const namespace = 'shared-namespace';
  const remember = (input: {
    scopeType: 'personal' | 'role' | 'session';
    scopeKey: string;
    predicateKey: string;
    value: string;
    content: string;
  }) => store.remember({
    userId,
    namespace,
    kind: 'preference',
    content: input.content,
    scopeType: input.scopeType,
    scopeKey: input.scopeKey,
    stableKey:
      `${input.scopeType}::${input.scopeKey}::${input.predicateKey}`,
    predicateKey: input.predicateKey,
    normalizedValue: input.value,
    normalizedValueHash: input.value,
  }).memory;
  const recall = (
    query: string,
    scopes: Array<{
      scopeType: 'personal' | 'role' | 'session';
      scopeKey: string;
    }>,
  ) => store.recall({
    userId,
    namespace,
    query,
    scopes,
    limit: 20,
  });
  const personalScope = {
    scopeType: 'personal' as const,
    scopeKey: 'self',
  };
  const roleA = {
    scopeType: 'role' as const,
    scopeKey: 'persona-A',
  };
  const roleB = {
    scopeType: 'role' as const,
    scopeKey: 'persona-B',
  };
  const sessionA1 = {
    scopeType: 'session' as const,
    scopeKey: 'chat-A1',
  };
  const sessionA2 = {
    scopeType: 'session' as const,
    scopeKey: 'chat-A2',
  };

  try {
    const shared = remember({
      ...personalScope,
      predicateKey: '用户::通用饮品偏好',
      value: '青竹乌龙',
      content: '用户通用饮品偏好是青竹乌龙。',
    });
    const privateRoleA = remember({
      ...roleA,
      predicateKey: '用户::当前 persona 关系口令',
      value: '栀子月-A',
      content: '当前 persona 的关系口令是栀子月-A。',
    });
    const privateRoleB = remember({
      ...roleB,
      predicateKey: '用户::当前 persona 关系口令',
      value: '栀子月-B',
      content: '当前 persona 的关系口令是栀子月-B。',
    });
    const privateSessionA1 = remember({
      ...sessionA1,
      predicateKey: '用户::当前聊天交付代号',
      value: '暮云舟-A1',
      content: '当前聊天的交付代号是暮云舟-A1。',
    });
    const privateSessionA2 = remember({
      ...sessionA2,
      predicateKey: '用户::当前聊天交付代号',
      value: '暮云舟-A2',
      content: '当前聊天的交付代号是暮云舟-A2。',
    });
    const precedencePersonal = remember({
      ...personalScope,
      predicateKey: '用户::界面模式要求',
      value: '常规模式',
      content: '用户的界面模式要求是常规模式。',
    });
    const precedenceRole = remember({
      ...roleA,
      predicateKey: '用户::界面模式要求',
      value: '角色模式',
      content: '用户的界面模式要求是角色模式。',
    });
    const precedenceSession = remember({
      ...sessionA1,
      predicateKey: '用户::界面模式要求',
      value: '会话模式',
      content: '用户的界面模式要求是会话模式。',
    });

    const personaAScopes = [personalScope, roleA, sessionA1];
    const personaBScopes = [personalScope, roleB];
    assert.deepEqual(
      recall('青竹乌龙饮品偏好', personaAScopes)
        .map((entry) => entry.memory.id),
      [shared.id],
    );
    assert.deepEqual(
      recall('青竹乌龙饮品偏好', personaBScopes)
        .map((entry) => entry.memory.id),
      [shared.id],
    );
    assert.deepEqual(
      recall('关系口令栀子月', personaAScopes)
        .map((entry) => entry.memory.id),
      [privateRoleA.id],
    );
    assert.deepEqual(
      recall('关系口令栀子月', personaBScopes)
        .map((entry) => entry.memory.id),
      [privateRoleB.id],
    );
    assert.deepEqual(
      recall(
        '当前聊天交付代号暮云舟',
        [personalScope, roleA, sessionA1],
      ).map((entry) => entry.memory.id),
      [privateSessionA1.id],
    );
    assert.deepEqual(
      recall(
        '当前聊天交付代号暮云舟',
        [personalScope, roleA, sessionA2],
      ).map((entry) => entry.memory.id),
      [privateSessionA2.id],
    );
    assert.deepEqual(
      recall('界面模式要求', personaAScopes)
        .map((entry) => entry.memory.id),
      [precedenceSession.id],
    );
    for (const memory of [
      precedencePersonal,
      precedenceRole,
      precedenceSession,
    ]) {
      assert.equal(
        store.get(memory.id, false, userId)?.status,
        'active',
      );
    }
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
