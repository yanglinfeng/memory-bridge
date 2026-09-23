import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/server/database.js';
import {
  IdentityAuthenticationError,
  IdentityBootstrapConflictError,
  IdentityService,
} from '../src/server/identity.js';
import { MemoryStore } from '../src/server/memory-store.js';

function createIdentityService(
  options: {
    legacyToken?: string;
    now?: () => string;
  } = {},
): {
  database: ReturnType<typeof openDatabase>;
  identity: IdentityService;
} {
  const database = openDatabase(':memory:');
  return {
    database,
    identity: new IdentityService(database, {
      defaultPrincipalId: 'default',
      ...options,
    }),
  };
}

test('identity 创建账户并签发只返回一次明文的 256-bit 凭据', () => {
  const { database, identity } = createIdentityService();
  try {
    const principal = identity.createPrincipal({
      id: 'alice',
      displayName: 'Alice',
    });
    assert.equal(principal.id, 'alice');
    assert.equal(Object.isFrozen(principal), true);

    const issued = identity.issueCredential({
      principalId: principal.id,
      label: 'AIRI desktop',
    });
    assert.match(
      issued.token,
      /^mb1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u,
    );
    assert.equal(issued.credential.principalId, 'alice');
    assert.equal(Object.isFrozen(issued.credential), true);

    const row = database
      .prepare(
        `SELECT
           secret_hash, secret_hint, status, principal_id
         FROM auth_credentials
         WHERE id = ?`,
      )
      .get(issued.credential.id);
    assert.equal(row?.principal_id, 'alice');
    assert.equal(row?.status, 'active');
    assert.equal(
      Buffer.from(row?.secret_hash as Uint8Array).byteLength,
      32,
    );
    assert.equal(row?.secret_hint, issued.credential.secretHint);
    assert.equal(
      JSON.stringify(row).includes(issued.token),
      false,
    );

    const authenticated = identity.authenticate({
      token: issued.token,
      isLoopback: true,
    });
    assert.deepEqual(
      {
        principalId: authenticated.principalId,
        credentialId: authenticated.credentialId,
        source: authenticated.source,
      },
      {
        principalId: 'alice',
        credentialId: issued.credential.id,
        source: 'credential',
      },
    );
    assert.equal(Object.isFrozen(authenticated), true);
  } finally {
    database.close();
  }
});

test('identity 首账户初始化原子创建命名 principal 且成功一次后永久关闭', () => {
  const { database, identity } = createIdentityService();
  try {
    const initialized = identity.initializeFirstAccount({
      principalId: 'alice',
      displayName: 'Alice',
      label: 'AIRI desktop',
    });
    assert.equal(initialized.principal.id, 'alice');
    assert.equal(initialized.principal.displayName, 'Alice');
    assert.equal(initialized.credential.principalId, 'alice');
    assert.match(
      initialized.token,
      /^mb1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u,
    );

    const persisted = JSON.stringify({
      credentials: database
        .prepare(
          `SELECT id, principal_id, label, secret_hint, status
           FROM auth_credentials`,
        )
        .all(),
      audit: database
        .prepare(
          `SELECT action, outcome, principal_id, credential_id,
                  detail_json
           FROM identity_audit_log`,
        )
        .all(),
    });
    assert.equal(persisted.includes(initialized.token), false);
    assert.equal(persisted.includes('secret_hash'), false);

    identity.revokeCredential(initialized.credential.id);
    assert.throws(
      () =>
        identity.initializeFirstAccount({
          principalId: 'bob',
          displayName: 'Bob',
          label: 'retry after revoke',
        }),
      (error) =>
        error instanceof IdentityBootstrapConflictError &&
        error.message === '首个账户初始化已经永久关闭',
    );
    assert.equal(
      identity.listPrincipals().some((entry) => entry.id === 'bob'),
      false,
    );
    assert.equal(identity.listCredentials('alice').length, 1);
  } finally {
    database.close();
  }
});

test('identity 默认首账户初始化保留 default 所有权并在失败时不写入', () => {
  const { database, identity } = createIdentityService({
    now: () => '2026-07-31T00:00:00.000Z',
  });
  try {
    assert.throws(
      () =>
        identity.initializeFirstAccount({
          displayName: '不应保存',
          label: 'expired',
          expiresAt: '2026-07-30T00:00:00.000Z',
        }),
      /expiresAt 必须晚于当前时间/u,
    );
    assert.equal(identity.listCredentials('default').length, 0);
    assert.equal(
      identity.listPrincipals().find((entry) => entry.id === 'default')
        ?.displayName,
      'default',
    );

    const initialized = identity.initializeFirstAccount({
      displayName: '本机主人',
      label: '首次桌面连接',
    });
    assert.equal(initialized.principal.id, 'default');
    assert.equal(initialized.principal.displayName, '本机主人');
    assert.equal(identity.listCredentials('default').length, 1);
  } finally {
    database.close();
  }
});

test('identity 撤销、过期、错误 secret 与未知 credential id 一律拒绝', () => {
  let now = '2026-07-31T00:00:00.000Z';
  const { database, identity } = createIdentityService({
    now: () => now,
  });
  try {
    identity.createPrincipal({ id: 'alice', displayName: 'Alice' });
    const revoked = identity.issueCredential({
      principalId: 'alice',
      label: 'revoked',
    });
    identity.revokeCredential(revoked.credential.id, 'manual test');
    assert.throws(
      () =>
        identity.authenticate({
          token: revoked.token,
          isLoopback: true,
        }),
      IdentityAuthenticationError,
    );

    const expiring = identity.issueCredential({
      principalId: 'alice',
      label: 'expiring',
      expiresAt: '2026-07-31T00:00:01.000Z',
    });
    now = '2026-07-31T00:00:02.000Z';
    assert.equal(
      identity
        .listCredentials('alice')
        .find(
          (credential) =>
            credential.id === expiring.credential.id,
        )?.status,
      'expired',
    );
    assert.throws(
      () =>
        identity.authenticate({
          token: expiring.token,
          isLoopback: true,
        }),
      IdentityAuthenticationError,
    );
    assert.equal(
      database
        .prepare(
          'SELECT status FROM auth_credentials WHERE id = ?',
        )
        .get(expiring.credential.id)?.status,
      'expired',
    );

    const active = identity.issueCredential({
      principalId: 'alice',
      label: 'active',
    });
    const [prefix, credentialId] = active.token.split('.');
    const wrongSecret = `${prefix}.${credentialId}.${'A'.repeat(43)}`;
    const unknownId = `${prefix}.00000000-0000-4000-8000-000000000000.${'A'.repeat(43)}`;
    for (const token of [wrongSecret, unknownId, 'not-a-token']) {
      assert.throws(
        () => identity.authenticate({ token, isLoopback: true }),
        (error) =>
          error instanceof IdentityAuthenticationError &&
          error.code === 'invalid_credentials' &&
          error.message === '身份凭据无效',
      );
    }
  } finally {
    database.close();
  }
});

test('identity 只有全空凭据库允许 anonymous loopback default', () => {
  const { database, identity } = createIdentityService();
  try {
    const anonymous = identity.authenticate({
      token: null,
      isLoopback: true,
    });
    assert.deepEqual(
      {
        principalId: anonymous.principalId,
        credentialId: anonymous.credentialId,
        source: anonymous.source,
      },
      {
        principalId: 'default',
        credentialId: null,
        source: 'anonymous_loopback',
      },
    );
    assert.throws(
      () => identity.authenticate({ token: null, isLoopback: false }),
      (error) =>
        error instanceof IdentityAuthenticationError &&
        error.code === 'authentication_required',
    );

    const issued = identity.issueCredential({
      principalId: 'default',
      label: 'default',
    });
    identity.revokeCredential(issued.credential.id);
    assert.throws(
      () => identity.authenticate({ token: null, isLoopback: true }),
      (error) =>
        error instanceof IdentityAuthenticationError &&
        error.code === 'authentication_required',
    );
  } finally {
    database.close();
  }
});

test('identity legacy token 只在内存中绑定 default principal', () => {
  const legacyToken =
    'legacy-only-in-memory-token-with-enough-entropy';
  const { database, identity } = createIdentityService({
    legacyToken,
  });
  try {
    assert.throws(
      () => identity.authenticate({ token: null, isLoopback: true }),
      IdentityAuthenticationError,
    );
    const authenticated = identity.authenticate({
      token: legacyToken,
      isLoopback: true,
    });
    assert.equal(authenticated.principalId, 'default');
    assert.equal(authenticated.credentialId, null);
    assert.equal(authenticated.source, 'legacy_token');

    const migrated = identity.issueCredential({
      principalId: 'default',
      label: 'stored replacement',
    });
    assert.throws(
      () =>
        identity.authenticate({
          token: legacyToken,
          isLoopback: true,
        }),
      IdentityAuthenticationError,
    );
    assert.equal(
      identity.authenticate({
        token: migrated.token,
        isLoopback: true,
      }).credentialId,
      migrated.credential.id,
    );

    const databaseText = JSON.stringify(
      database
        .prepare(
          `SELECT name, sql
           FROM sqlite_master
           UNION ALL
           SELECT action, detail_json
           FROM identity_audit_log`,
        )
        .all(),
    );
    assert.equal(databaseText.includes(legacyToken), false);
  } finally {
    database.close();
  }
});

test('identity context 继承可信 principal 并冻结 persona/session', () => {
  const { database, identity } = createIdentityService();
  try {
    const principal = identity.authenticate({
      token: null,
      isLoopback: true,
    });
    const context = identity.createContext(principal, {
      namespace: 'personal',
      personaId: 'persona-a',
      sessionId: 'chat-a1',
    });
    assert.deepEqual(
      {
        principalId: context.principalId,
        namespace: context.namespace,
        personaId: context.personaId,
        sessionId: context.sessionId,
        source: context.source,
      },
      {
        principalId: 'default',
        namespace: 'personal',
        personaId: 'persona-a',
        sessionId: 'chat-a1',
        source: 'anonymous_loopback',
      },
    );
    assert.equal(Object.isFrozen(context), true);
  } finally {
    database.close();
  }
});

test('identity persona 绑定按 principal 隔离并允许跨账户复用客户端角色 ID', () => {
  const { database, identity } = createIdentityService();
  try {
    identity.createPrincipal({ id: 'alice', displayName: 'Alice' });
    identity.createPrincipal({ id: 'bob', displayName: 'Bob' });
    const alice = identity.trustPrincipal('alice');
    const bob = identity.trustPrincipal('bob');

    const aliceBinding = identity.bindPersona(alice, {
      clientType: 'airi',
      clientInstanceId: 'desktop-main',
      personaId: 'persona-a',
      displayName: 'A',
    });
    const bobBinding = identity.bindPersona(bob, {
      clientType: 'airi',
      clientInstanceId: 'desktop-main',
      personaId: 'persona-a',
      displayName: 'Bob 的同名角色',
    });
    assert.equal(aliceBinding.principalId, 'alice');
    assert.equal(bobBinding.principalId, 'bob');
    assert.notEqual(aliceBinding.id, bobBinding.id);
    assert.equal(Object.isFrozen(aliceBinding), true);
    assert.equal(Object.isFrozen(bobBinding), true);
    assert.deepEqual(
      identity.listPersonaBindings('alice').map((item) => item.id),
      [aliceBinding.id],
    );
    assert.deepEqual(
      identity.listPersonaBindings('bob').map((item) => item.id),
      [bobBinding.id],
    );
  } finally {
    database.close();
  }
});

test('identity overview 与管理列表只返回可信 principal 的脱敏数据', () => {
  const { database, identity } = createIdentityService();
  const store = new MemoryStore(database);
  try {
    identity.createPrincipal({ id: 'alice', displayName: 'Alice' });
    identity.createPrincipal({ id: 'bob', displayName: 'Bob' });
    const aliceIssued = identity.issueCredential({
      principalId: 'alice',
      label: 'Alice desktop',
    });
    const bobIssued = identity.issueCredential({
      principalId: 'bob',
      label: 'Bob desktop',
    });
    const alice = identity.authenticate({
      token: aliceIssued.token,
      isLoopback: true,
    });
    const bob = identity.authenticate({
      token: bobIssued.token,
      isLoopback: true,
    });
    identity.bindPersona(alice, {
      clientType: 'airi',
      clientInstanceId: 'alice-desktop',
      personaId: 'persona-alice',
      displayName: 'Alice Persona',
    });
    identity.bindPersona(bob, {
      clientType: 'airi',
      clientInstanceId: 'bob-desktop',
      personaId: 'persona-bob',
      displayName: 'Bob Persona',
    });

    store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'profile',
      content: 'Alice personal memory。',
    });
    store.remember({
      userId: 'alice',
      namespace: 'work',
      kind: 'knowledge',
      content: 'Alice work memory。',
    });
    store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'relationship',
      content: 'Alice role private memory。',
      scopeType: 'role',
      scopeKey: 'persona-alice',
    });
    store.remember({
      userId: 'bob',
      namespace: 'personal',
      kind: 'profile',
      content: 'Bob personal memory。',
    });
    store.remember({
      userId: 'bob',
      namespace: 'personal',
      kind: 'relationship',
      content: 'Bob role private memory。',
      scopeType: 'role',
      scopeKey: 'persona-bob',
    });

    const insertSession = database.prepare(
      `INSERT INTO conversation_sessions (
         id, user_id, namespace, client_name, external_id, started_at,
         persona_id, identity_source, identity_status
       ) VALUES (?, ?, ?, 'airi', ?, ?, ?, 'credential', 'complete')`,
    );
    insertSession.run(
      'alice-session-old',
      'alice',
      'personal',
      'alice-old',
      '2026-07-30T00:00:00.000Z',
      'persona-alice',
    );
    insertSession.run(
      'alice-session-latest',
      'alice',
      'work',
      'alice-latest',
      '2026-07-31T00:00:00.000Z',
      'persona-alice',
    );
    insertSession.run(
      'bob-session-latest',
      'bob',
      'personal',
      'bob-latest',
      '2026-07-31T01:00:00.000Z',
      'persona-bob',
    );

    const overview = identity.currentOverview(alice);
    assert.equal(overview.principal.id, 'alice');
    assert.equal(
      overview.credential?.id,
      aliceIssued.credential.id,
    );
    assert.equal(overview.personalMemoryCount, 2);
    assert.deepEqual(
      overview.namespaces.map((namespace) => ({
        namespace: namespace.namespace,
        activeMemoryCount: namespace.activeMemoryCount,
        personalMemoryCount: namespace.personalMemoryCount,
      })),
      [
        {
          namespace: 'personal',
          activeMemoryCount: 2,
          personalMemoryCount: 1,
        },
        {
          namespace: 'work',
          activeMemoryCount: 1,
          personalMemoryCount: 1,
        },
      ],
    );
    assert.equal(overview.personas.length, 1);
    assert.equal(overview.personas[0]?.personaId, 'persona-alice');
    assert.equal(overview.personas[0]?.roleMemoryCount, 1);
    assert.equal(
      overview.personas[0]?.latestSession?.id,
      'alice-session-latest',
    );
    assert.equal(Object.isFrozen(overview), true);
    assert.equal(Object.isFrozen(overview.personas), true);

    const serialized = JSON.stringify(overview);
    assert.equal(serialized.includes('secret_hash'), false);
    assert.equal(serialized.includes(aliceIssued.token), false);
    assert.equal(serialized.includes(bobIssued.token), false);
    assert.equal(
      serialized.includes(bobIssued.credential.id),
      false,
    );
    assert.equal(serialized.includes('persona-bob'), false);

    const bobOverview = identity.currentOverview(bob);
    assert.equal(bobOverview.principal.id, 'bob');
    assert.deepEqual(
      bobOverview.personas.map((persona) => persona.personaId),
      ['persona-bob'],
    );
    assert.equal(
      JSON.stringify(bobOverview).includes('persona-alice'),
      false,
    );
    assert.throws(
      () => identity.currentOverview({ ...alice }),
      /可信身份解析器/u,
    );

    assert.deepEqual(
      identity.listPrincipals().map((principal) => principal.id),
      ['default', 'alice', 'bob'],
    );
    assert.deepEqual(
      identity
        .listCredentials('alice')
        .map((credential) => credential.id),
      [aliceIssued.credential.id],
    );
    assert.deepEqual(
      identity
        .listPersonaBindings('alice')
        .map((binding) => binding.personaId),
      ['persona-alice'],
    );
    assert.throws(
      () =>
        identity.revokeCredentialForPrincipal(
          'bob',
          aliceIssued.credential.id,
        ),
      /身份凭据不存在/u,
    );
    assert.equal(
      identity.listCredentials('alice')[0]?.status,
      'active',
    );
  } finally {
    database.close();
  }
});
