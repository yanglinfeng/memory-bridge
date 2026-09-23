import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import { MemoryJournal } from '../src/server/memory-journal.js';
import { MemoryStore } from '../src/server/memory-store.js';

function createFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-scope-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  return {
    database,
    store,
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('scope 参与去重并隔离 personal、project 和 role 召回', () => {
  const fixture = createFixture();
  try {
    const personal = fixture.store.remember({
      kind: 'preference',
      content: '用户在个人环境使用青色主题。',
      scopeType: 'personal',
      scopeKey: 'self',
    }).memory;
    const projectA = fixture.store.remember({
      kind: 'preference',
      content: '用户在项目环境使用青色主题。',
      scopeType: 'project',
      scopeKey: 'project-a',
    }).memory;
    const projectB = fixture.store.remember({
      kind: 'preference',
      content: '用户在项目环境使用青色主题。',
      scopeType: 'project',
      scopeKey: 'project-b',
    }).memory;
    const role = fixture.store.remember({
      kind: 'instruction',
      content: '用户在审查员角色使用青色主题。',
      scopeType: 'role',
      scopeKey: 'reviewer',
    }).memory;

    assert.notEqual(projectA.id, projectB.id);
    assert.deepEqual(
      fixture.store
        .recall({ query: '个人环境青色主题' })
        .map((entry) => entry.memory.id),
      [personal.id],
    );
    assert.deepEqual(
      fixture.store
        .recall({
          query: '项目环境青色主题',
          scopeType: 'project',
          scopeKey: 'project-a',
        })
        .map((entry) => entry.memory.id),
      [projectA.id],
    );
    assert.deepEqual(
      fixture.store
        .recall({
          query: '项目环境青色主题',
          scopeType: 'project',
          scopeKey: 'project-b',
        })
        .map((entry) => entry.memory.id),
      [projectB.id],
    );
    assert.deepEqual(
      fixture.store
        .recall({
          query: '审查员角色青色主题',
          scopeType: 'role',
          scopeKey: 'reviewer',
        })
        .map((entry) => entry.memory.id),
      [role.id],
    );
  } finally {
    fixture.close();
  }
});

test('一次召回可合并 personal、role、session 且严格隔离聊天对象', () => {
  const fixture = createFixture();
  try {
    const personal = fixture.store.remember({
      kind: 'knowledge',
      content: '分层作用域召回验证：共同记忆对所有聊天对象可见。',
      scopeType: 'personal',
      scopeKey: 'self',
    }).memory;
    const roleA = fixture.store.remember({
      kind: 'knowledge',
      content: '分层作用域召回验证：角色 A 的角色记忆。',
      scopeType: 'role',
      scopeKey: 'persona-a',
    }).memory;
    const roleB = fixture.store.remember({
      kind: 'knowledge',
      content: '分层作用域召回验证：角色 B 的角色记忆。',
      scopeType: 'role',
      scopeKey: 'persona-b',
    }).memory;
    const sessionA1 = fixture.store.remember({
      kind: 'knowledge',
      content: '分层作用域召回验证：会话 A1 的会话记忆。',
      scopeType: 'session',
      scopeKey: 'persona-a:session-1',
    }).memory;

    const recallIds = (
      scopes: Array<{
        scopeType: 'personal' | 'role' | 'session';
        scopeKey: string;
      }>,
    ) =>
      fixture.store.recall({
        query: '分层作用域召回验证 共同记忆 角色记忆 会话记忆',
        scopes,
        limit: 10,
      }).map((entry) => entry.memory.id).sort();

    assert.deepEqual(
      recallIds([
        { scopeType: 'session', scopeKey: 'persona-a:session-1' },
        { scopeType: 'role', scopeKey: 'persona-a' },
        { scopeType: 'personal', scopeKey: 'self' },
      ]),
      [personal.id, roleA.id, sessionA1.id].sort(),
    );
    assert.deepEqual(
      recallIds([
        { scopeType: 'role', scopeKey: 'persona-b' },
        { scopeType: 'personal', scopeKey: 'self' },
      ]),
      [personal.id, roleB.id].sort(),
    );
    assert.deepEqual(
      recallIds([
        { scopeType: 'session', scopeKey: 'persona-a:session-2' },
        { scopeType: 'role', scopeKey: 'persona-a' },
        { scopeType: 'personal', scopeKey: 'self' },
      ]),
      [personal.id, roleA.id].sort(),
    );
  } finally {
    fixture.close();
  }
});

test('同谓词按 session、role、project、personal 遮蔽且仅最终结果计数', () => {
  const fixture = createFixture();
  try {
    const rememberLayer = (
      scopeType: 'personal' | 'project' | 'role' | 'session',
      scopeKey: string,
      answer: string,
    ) => fixture.store.remember({
      kind: 'preference',
      content: `分层同谓词遮蔽验证：当前称呼答案是${answer}。`,
      scopeType,
      scopeKey,
      stableKey: `${scopeType}::${scopeKey}::用户::当前称呼`,
      predicateKey: '用户::当前称呼',
      normalizedValue: answer,
      normalizedValueHash: `${scopeType}-${scopeKey}-${answer}`,
    }).memory;
    const personal = rememberLayer('personal', 'self', '个人称呼');
    const project = rememberLayer('project', 'airi', '项目称呼');
    const role = rememberLayer('role', 'persona-a', '角色称呼');
    const session = rememberLayer(
      'session',
      'persona-a:session-1',
      '会话称呼',
    );
    const differentPredicate = fixture.store.remember({
      kind: 'preference',
      content:
        '分层同谓词遮蔽验证：当前称呼对话里的输出风格答案是简洁。',
      scopeType: 'personal',
      scopeKey: 'self',
      stableKey: 'personal::self::用户::输出风格',
      predicateKey: '用户::输出风格',
      normalizedValue: '简洁',
      normalizedValueHash: 'personal-self-concise',
    }).memory;
    const query = '分层同谓词遮蔽验证 当前称呼 输出风格';
    const ids = (scopes: Array<{
      scopeType: 'personal' | 'project' | 'role' | 'session';
      scopeKey: string;
    }>) =>
      fixture.store.recall({ query, scopes, limit: 10 })
        .map((entry) => entry.memory.id)
        .sort();

    assert.deepEqual(
      ids([
        { scopeType: 'session', scopeKey: 'persona-a:session-1' },
        { scopeType: 'role', scopeKey: 'persona-a' },
        { scopeType: 'project', scopeKey: 'airi' },
        { scopeType: 'personal', scopeKey: 'self' },
      ]),
      [session.id, differentPredicate.id].sort(),
    );
    assert.equal(fixture.store.get(session.id)?.accessCount, 1);
    assert.equal(fixture.store.get(differentPredicate.id)?.accessCount, 1);
    assert.equal(fixture.store.get(role.id)?.accessCount, 0);
    assert.equal(fixture.store.get(project.id)?.accessCount, 0);
    assert.equal(fixture.store.get(personal.id)?.accessCount, 0);

    assert.deepEqual(
      ids([
        { scopeType: 'role', scopeKey: 'persona-a' },
        { scopeType: 'project', scopeKey: 'airi' },
        { scopeType: 'personal', scopeKey: 'self' },
      ]),
      [role.id, differentPredicate.id].sort(),
    );
    assert.deepEqual(
      ids([
        { scopeType: 'project', scopeKey: 'airi' },
        { scopeType: 'personal', scopeKey: 'self' },
      ]),
      [project.id, differentPredicate.id].sort(),
    );
    assert.deepEqual(
      ids([{ scopeType: 'personal', scopeKey: 'self' }]),
      [personal.id, differentPredicate.id].sort(),
    );
  } finally {
    fixture.close();
  }
});

test('scopes 为空或与旧 scope 字段冲突时拒绝，等价旧字段仍兼容', () => {
  const fixture = createFixture();
  try {
    const role = fixture.store.remember({
      kind: 'instruction',
      content: '作用域冲突验证：角色 A 使用简洁回答。',
      scopeType: 'role',
      scopeKey: 'persona-a',
    }).memory;

    assert.deepEqual(
      fixture.store.recall({
        query: '作用域冲突验证 简洁回答',
        scopes: [{ scopeType: 'role', scopeKey: 'persona-a' }],
        scopeType: 'role',
        scopeKey: 'persona-a',
      }).map((entry) => entry.memory.id),
      [role.id],
    );
    assert.throws(
      () => fixture.store.recall({
        query: '作用域冲突验证',
        scopes: [{ scopeType: 'role', scopeKey: 'persona-a' }],
        scopeType: 'personal',
        scopeKey: 'self',
      }),
      /作用域.*冲突|不能混用/u,
    );
    assert.throws(
      () => fixture.store.recall({
        query: '作用域冲突验证',
        scopes: [],
      }),
      /作用域.*不能为空|scopes.*不能为空/u,
    );
  } finally {
    fixture.close();
  }
});

test('敏感记忆默认拒绝且 credential 永远不能写入或召回', () => {
  const fixture = createFixture();
  try {
    const sensitive = fixture.store.remember({
      kind: 'profile',
      content: '用户的医疗过敏记录是青霉素。',
      sensitivity: 'sensitive',
      sourceAuthority: 'direct_user',
    }).memory;

    assert.deepEqual(
      fixture.store.recall({ query: '医疗过敏青霉素' }),
      [],
    );
    assert.deepEqual(
      fixture.store
        .recall({
          query: '医疗过敏青霉素',
          allowedSensitivities: ['normal', 'sensitive'],
        })
        .map((entry) => entry.memory.id),
      [sensitive.id],
    );
    assert.deepEqual(
      fixture.store.recall({
        query: '医疗过敏青霉素',
        allowedSensitivities: ['credential'],
      }),
      [],
    );
    assert.throws(
      () =>
        fixture.store.remember({
          kind: 'knowledge',
          content: '用户的 API Key 是 secret-value。',
          sensitivity: 'credential',
        }),
      /凭据不能保存/,
    );
  } finally {
    fixture.close();
  }
});

test('安全属性贯穿投影、规范项、版本、证据和 tombstone', () => {
  const fixture = createFixture();
  try {
    const memory = fixture.store.remember({
      kind: 'project',
      content: 'AIRI 项目决定只使用本地模型。',
      scopeType: 'project',
      scopeKey: 'airi',
      sensitivity: 'sensitive',
      sourceAuthority: 'direct_user',
      negated: false,
      evidenceExcerpt: '只使用本地模型',
    }).memory;
    fixture.store.forget(memory.id, 'scope security test');

    const item = fixture.database
      .prepare(
        `SELECT scope_type, scope_key, sensitivity, source_authority
         FROM memory_items WHERE id = ?`,
      )
      .get(memory.id);
    const version = fixture.database
      .prepare(
        `SELECT scope_type, scope_key, sensitivity, source_authority,
                negated
         FROM memory_versions WHERE memory_item_id = ?`,
      )
      .get(memory.id);
    const evidence = fixture.database
      .prepare(
        `SELECT sensitivity, source_authority
         FROM memory_evidence
         WHERE memory_version_id = (
           SELECT current_version_id FROM memory_items WHERE id = ?
         )`,
      )
      .get(memory.id);
    const tombstone = fixture.database
      .prepare(
        `SELECT scope_type, scope_key
         FROM memory_tombstones WHERE user_id = ?`,
      )
      .get(memory.userId);

    assert.deepEqual({ ...item }, {
      scope_type: 'project',
      scope_key: 'airi',
      sensitivity: 'sensitive',
      source_authority: 'direct_user',
    });
    assert.deepEqual({ ...version }, {
      scope_type: 'project',
      scope_key: 'airi',
      sensitivity: 'sensitive',
      source_authority: 'direct_user',
      negated: 0,
    });
    assert.deepEqual({ ...evidence }, {
      sensitivity: 'sensitive',
      source_authority: 'direct_user',
    });
    assert.deepEqual({ ...tombstone }, {
      scope_type: 'project',
      scope_key: 'airi',
    });
  } finally {
    fixture.close();
  }
});

test('正式证据在服务层和数据库层强制 owner、namespace 与 scope 对齐', () => {
  const fixture = createFixture();
  try {
    const lifecycle = new LifecycleStore(fixture.database);
    const journal = new MemoryJournal(fixture.database);
    const recordTurn = (input: {
      userId: string;
      namespace: string;
      personaId: string;
      projectId: string;
      sessionId: string;
      suffix: string;
    }) => lifecycle.recordTurn({
      userId: input.userId,
      namespace: input.namespace,
      personaId: input.personaId,
      projectId: input.projectId,
      identitySource: 'scope-evidence-test',
      identityStatus: 'complete',
      roundId: `round-${input.suffix}`,
      clientName: 'scope-evidence-test',
      sessionExternalId: input.sessionId,
      turnExternalId: `turn-${input.suffix}`,
      role: 'user',
      content: `证据隔离测试回合 ${input.suffix}`,
    }).turn;
    const turnA = recordTurn({
      userId: 'alice',
      namespace: 'namespace-a',
      personaId: 'persona-a',
      projectId: 'project-a',
      sessionId: 'session-a',
      suffix: 'alice-a',
    });
    const roleBTurn = recordTurn({
      userId: 'alice',
      namespace: 'namespace-a',
      personaId: 'persona-b',
      projectId: 'project-a',
      sessionId: 'session-role-b',
      suffix: 'role-b',
    });
    const projectBTurn = recordTurn({
      userId: 'alice',
      namespace: 'namespace-a',
      personaId: 'persona-a',
      projectId: 'project-b',
      sessionId: 'session-project-b',
      suffix: 'project-b',
    });
    const namespaceBTurn = recordTurn({
      userId: 'alice',
      namespace: 'namespace-b',
      personaId: 'persona-a',
      projectId: 'project-a',
      sessionId: 'session-namespace-b',
      suffix: 'namespace-b',
    });
    const bobTurn = recordTurn({
      userId: 'bob',
      namespace: 'namespace-a',
      personaId: 'persona-a',
      projectId: 'project-a',
      sessionId: 'session-bob',
      suffix: 'bob',
    });

    const memories = {
      personal: fixture.store.remember({
        userId: 'alice',
        namespace: 'namespace-a',
        kind: 'preference',
        content: 'Alice 的个人证据绑定事实。',
        scopeType: 'personal',
        scopeKey: 'self',
        evidenceTurnId: turnA.id,
        evidenceExcerpt: turnA.content,
      }).memory,
      role: fixture.store.remember({
        userId: 'alice',
        namespace: 'namespace-a',
        kind: 'relationship',
        content: 'Alice 与角色 A 的证据绑定事实。',
        scopeType: 'role',
        scopeKey: 'persona-a',
        evidenceTurnId: turnA.id,
        evidenceExcerpt: turnA.content,
      }).memory,
      project: fixture.store.remember({
        userId: 'alice',
        namespace: 'namespace-a',
        kind: 'project',
        content: 'Alice 在项目 A 的证据绑定事实。',
        scopeType: 'project',
        scopeKey: 'project-a',
        evidenceTurnId: turnA.id,
        evidenceExcerpt: turnA.content,
      }).memory,
      session: fixture.store.remember({
        userId: 'alice',
        namespace: 'namespace-a',
        kind: 'event',
        content: 'Alice 在会话 A 的证据绑定事实。',
        scopeType: 'session',
        scopeKey: 'session-a',
        evidenceTurnId: turnA.id,
        evidenceExcerpt: turnA.content,
      }).memory,
      external: fixture.store.remember({
        userId: 'alice',
        namespace: 'namespace-a',
        kind: 'knowledge',
        content: 'Alice 的外部来源证据事实。',
        scopeType: 'role',
        scopeKey: 'persona-a',
        evidenceExcerpt: '外部来源没有 conversation turn。',
        sourceRef: 'external:test',
      }).memory,
    };
    const versionId = (memoryId: string): string => String(
      fixture.database.prepare(
        `SELECT current_version_id FROM memory_items WHERE id = ?`,
      ).get(memoryId)?.current_version_id || '',
    );
    const versions = {
      personal: versionId(memories.personal.id),
      role: versionId(memories.role.id),
      project: versionId(memories.project.id),
      session: versionId(memories.session.id),
      external: versionId(memories.external.id),
    };
    assert.equal(
      Object.values(versions).every((value) => value.length > 0),
      true,
    );
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_evidence
         WHERE memory_version_id IN (?, ?, ?, ?, ?)`,
      ).get(...Object.values(versions))?.count),
      5,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT turn_id FROM memory_evidence
         WHERE memory_version_id = ?`,
      ).get(versions.external)?.turn_id,
      null,
    );

    const evidenceInput = (turnId: string) => ({
      turnId,
      evidenceType: 'security_test',
      excerpt: '不应写入的错绑证据',
      sourceAuthority: 'direct_user' as const,
      createdAt: '2026-08-31T00:00:00.000Z',
    });
    for (const [targetVersionId, invalidTurnId] of [
      [versions.personal, namespaceBTurn.id],
      [versions.personal, bobTurn.id],
      [versions.role, roleBTurn.id],
      [versions.project, projectBTurn.id],
      [versions.session, roleBTurn.id],
    ] as const) {
      assert.throws(
        () => journal.recordEvidence(
          targetVersionId,
          evidenceInput(invalidTurnId),
        ),
        /证据 owner\/namespace\/scope 不一致/u,
      );
    }

    const rawInsert = fixture.database.prepare(
      `INSERT INTO memory_evidence (
         id, memory_version_id, turn_id, evidence_type, excerpt,
         source_ref, sensitivity, source_authority, created_at
       ) VALUES (?, ?, ?, 'raw_security_test', NULL, NULL,
                 'normal', 'direct_user', ?)`,
    );
    for (const [targetVersionId, invalidTurnId] of [
      [versions.personal, namespaceBTurn.id],
      [versions.personal, bobTurn.id],
      [versions.role, roleBTurn.id],
      [versions.project, projectBTurn.id],
      [versions.session, roleBTurn.id],
    ] as const) {
      assert.throws(
        () => rawInsert.run(
          randomUUID(),
          targetVersionId,
          invalidTurnId,
          '2026-08-31T00:00:00.000Z',
        ),
        /memory evidence owner\/scope mismatch/u,
      );
    }

    const correctEvidenceId = randomUUID();
    rawInsert.run(
      correctEvidenceId,
      versions.role,
      turnA.id,
      '2026-08-31T00:00:00.000Z',
    );
    const externalEvidenceId = randomUUID();
    rawInsert.run(
      externalEvidenceId,
      versions.role,
      null,
      '2026-08-31T00:00:00.000Z',
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT turn_id FROM memory_evidence WHERE id = ?`,
      ).get(externalEvidenceId)?.turn_id,
      null,
    );
    assert.throws(
      () => fixture.database.prepare(
        `UPDATE memory_evidence SET turn_id = NULL WHERE id = ?`,
      ).run(correctEvidenceId),
      /memory evidence identity is immutable/u,
    );
    assert.throws(
      () => fixture.database.prepare(
        `UPDATE memory_evidence
         SET memory_version_id = ? WHERE id = ?`,
      ).run(versions.personal, correctEvidenceId),
      /memory evidence identity is immutable/u,
    );
    fixture.database.prepare(
      `UPDATE memory_evidence
       SET evidence_type = 'verified_security_test' WHERE id = ?`,
    ).run(correctEvidenceId);
    assert.equal(
      fixture.database.prepare(
        `SELECT evidence_type FROM memory_evidence WHERE id = ?`,
      ).get(correctEvidenceId)?.evidence_type,
      'verified_security_test',
    );
  } finally {
    fixture.close();
  }
});

test('tombstone 严格隔离 scope、kind 和规范谓词', () => {
  const fixture = createFixture();
  try {
    const forgotten = fixture.store.remember({
      kind: 'preference',
      content: '用户在 A 项目的主要编辑器是 VS Code。',
      scopeType: 'project',
      scopeKey: 'project-a',
      stableKey: 'project::project-a::用户::主要编辑器',
      predicateKey: '用户::主要编辑器',
      normalizedValue: 'VS Code',
      normalizedValueHash: 'project-a-vscode',
    }).memory;
    fixture.store.forget(forgotten.id);

    const otherScope = fixture.store.remember({
      kind: 'preference',
      content: '用户在 B 项目的主要编辑器是 VS Code。',
      scopeType: 'project',
      scopeKey: 'project-b',
      stableKey: 'project::project-b::用户::主要编辑器',
      predicateKey: '用户::主要编辑器',
      normalizedValue: 'VS Code',
      normalizedValueHash: 'project-b-vscode',
    }).memory;
    const otherKind = fixture.store.remember({
      kind: 'knowledge',
      content: 'A 项目的编辑器知识条目记录 VS Code。',
      scopeType: 'project',
      scopeKey: 'project-a',
      stableKey: 'project::project-a::用户::主要编辑器',
      predicateKey: '用户::主要编辑器',
      normalizedValue: 'VS Code',
      normalizedValueHash: 'project-a-vscode-knowledge',
    }).memory;
    const otherPredicate = fixture.store.remember({
      kind: 'preference',
      content: '用户在 A 项目的辅助编辑器是 Visual Studio Code。',
      scopeType: 'project',
      scopeKey: 'project-a',
      stableKey: 'project::project-a::用户::辅助编辑器',
      predicateKey: '用户::辅助编辑器',
      normalizedValue: 'Visual Studio Code',
      normalizedValueHash: 'project-a-secondary-vscode',
    }).memory;

    assert.equal(otherScope.status, 'active');
    assert.equal(otherKind.status, 'active');
    assert.equal(otherPredicate.status, 'active');
    assert.equal(fixture.store.list().total, 3);
  } finally {
    fixture.close();
  }
});
