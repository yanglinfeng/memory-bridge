import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { createHttpServer } from '../src/server/http-server.js';
import { IdentityService } from '../src/server/identity.js';
import { MemoryStore } from '../src/server/memory-store.js';

const PUBLIC_HEALTH_KEYS = [
  'mcpTransport',
  'ok',
  'service',
  'version',
];

async function assertMinimalPublicHealth(
  base: string,
  sentinels: string[] = [],
): Promise<void> {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), PUBLIC_HEALTH_KEYS);
  assert.deepEqual(body, {
    ok: true,
    service: 'memory-bridge',
    version: '1.0.0',
    mcpTransport: 'stdio',
  });
  assert.equal(sentinels.filter((sentinel) => text.includes(sentinel)).length, 0);
}

test('HTTP 本机 bootstrap 一次关闭并提供 principal 自服务凭据与 persona 管理', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-http-identity-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  const identity = new IdentityService(database, {
    defaultPrincipalId: 'default',
  });
  const server = createHttpServer(store, {
    identityService: identity,
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const bearerHeaders = (token: string) => ({
    ...jsonHeaders,
    Authorization: `Bearer ${token}`,
  });

  try {
    await assertMinimalPublicHealth(base, ['health-secret-sentinel']);

    const crossSiteBootstrap = await fetch(
      `${base}/api/identity/bootstrap`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Origin: 'https://attacker.example',
          'Sec-Fetch-Site': 'cross-site',
        },
        body: JSON.stringify({
          displayName: '跨站抢注账户',
          label: 'cross-site-bootstrap',
        }),
      },
    );
    assert.equal(crossSiteBootstrap.status, 403);
    assert.equal(
      database.prepare(
        'SELECT COUNT(*) AS count FROM auth_credentials',
      ).get()?.count,
      0,
    );

    const nonJsonBootstrap = await fetch(
      `${base}/api/identity/bootstrap`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          displayName: '非 JSON 抢注账户',
          label: 'non-json-bootstrap',
        }),
      },
    );
    assert.equal(nonJsonBootstrap.status, 415);
    assert.equal(
      database.prepare(
        'SELECT COUNT(*) AS count FROM auth_credentials',
      ).get()?.count,
      0,
    );

    const spoofedBootstrap = await fetch(
      `${base}/api/identity/bootstrap`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          userId: 'attacker',
          displayName: '不应创建',
          label: 'spoofed',
        }),
      },
    );
    assert.equal(spoofedBootstrap.status, 400);
    assert.equal(
      database.prepare(
        'SELECT COUNT(*) AS count FROM auth_credentials',
      ).get()?.count,
      0,
    );

    const bootstrapResponse = await fetch(
      `${base}/api/identity/bootstrap`,
      {
        method: 'POST',
        headers: {
          ...jsonHeaders,
          Origin: base,
          'Sec-Fetch-Site': 'same-origin',
        },
        body: JSON.stringify({
          displayName: '本机主人',
          label: 'health-secret-sentinel',
        }),
      },
    );
    assert.equal(bootstrapResponse.status, 201);
    const bootstrapText = await bootstrapResponse.text();
    const bootstrap = JSON.parse(bootstrapText) as {
      principal: { id: string; displayName: string };
      credential: { id: string; principalId: string };
      token: string;
    };
    assert.equal(bootstrap.principal.id, 'default');
    assert.equal(bootstrap.principal.displayName, '本机主人');
    assert.equal(bootstrap.credential.principalId, 'default');
    assert.match(
      bootstrap.token,
      /^mb1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u,
    );
    await assertMinimalPublicHealth(base, [
      'health-secret-sentinel',
      bootstrap.token,
      bootstrap.credential.id,
      bootstrap.principal.displayName,
    ]);
    assert.equal(
      (await fetch(`${base}/api/health`, { method: 'HEAD' })).status,
      401,
    );
    assert.equal(
      (await fetch(`${base}/api/health`, { method: 'POST' })).status,
      401,
    );
    assert.equal((await fetch(`${base}/api/health/`)).status, 401);
    assert.equal((await fetch(`${base}/api/config`)).status, 401);
    assert.equal((await fetch(`${base}/api/stats`)).status, 401);

    const persistedIdentityText = JSON.stringify({
      credentials: database
        .prepare(
          `SELECT id, principal_id, label, secret_hint, status,
                  created_at, expires_at, revoked_at, last_used_at
           FROM auth_credentials`,
        )
        .all(),
      audit: database
        .prepare(
          `SELECT action, outcome, principal_id, credential_id,
                  source, detail_json, created_at
           FROM identity_audit_log`,
        )
        .all(),
    });
    assert.equal(
      persistedIdentityText.includes(bootstrap.token),
      false,
    );
    assert.equal(
      (await fetch(`${base}/api/identity`)).status,
      401,
    );

    const repeatedBootstrap = await fetch(
      `${base}/api/identity/bootstrap`,
      {
        method: 'POST',
        headers: bearerHeaders(bootstrap.token),
        body: JSON.stringify({
          displayName: '第二次',
          label: 'must fail',
        }),
      },
    );
    assert.equal(repeatedBootstrap.status, 409);

    const spoofedIssue = await fetch(
      `${base}/api/identity/credentials`,
      {
        method: 'POST',
        headers: bearerHeaders(bootstrap.token),
        body: JSON.stringify({
          principalId: 'bob',
          label: 'cross principal',
        }),
      },
    );
    assert.equal(spoofedIssue.status, 400);

    const issueResponse = await fetch(
      `${base}/api/identity/credentials`,
      {
        method: 'POST',
        headers: bearerHeaders(bootstrap.token),
        body: JSON.stringify({ label: 'rotated desktop' }),
      },
    );
    assert.equal(issueResponse.status, 201);
    const issued = await issueResponse.json() as {
      credential: { id: string; principalId: string };
      token: string;
    };
    assert.equal(issued.credential.principalId, 'default');

    const credentialListResponse = await fetch(
      `${base}/api/identity/credentials`,
      { headers: bearerHeaders(bootstrap.token) },
    );
    assert.equal(credentialListResponse.status, 200);
    const credentialListText = await credentialListResponse.text();
    const credentialList = JSON.parse(credentialListText) as {
      currentCredentialId: string;
      credentials: Array<{
        id: string;
        principalId: string;
        secretHint: string;
      }>;
    };
    assert.equal(
      credentialList.currentCredentialId,
      bootstrap.credential.id,
    );
    assert.equal(credentialList.credentials.length, 2);
    assert.equal(
      credentialList.credentials.every(
        (credential) => credential.principalId === 'default',
      ),
      true,
    );
    assert.equal(credentialListText.includes(bootstrap.token), false);
    assert.equal(credentialListText.includes(issued.token), false);
    assert.equal(credentialListText.includes('secret_hash'), false);
    assert.equal(
      (
        await fetch(
          `${base}/api/identity/credentials?principalId=bob`,
          { headers: bearerHeaders(bootstrap.token) },
        )
      ).status,
      400,
    );

    const defaultPrincipal = identity.authenticate({
      token: bootstrap.token,
      isLoopback: true,
    });
    identity.bindPersona(defaultPrincipal, {
      clientType: 'airi',
      clientInstanceId: 'default-desktop',
      personaId: 'persona-default',
      displayName: '默认角色',
    });
    store.remember({
      userId: 'default',
      namespace: 'personal',
      kind: 'relationship',
      content: '只属于默认角色的关系记忆。',
      scopeType: 'role',
      scopeKey: 'persona-default',
    });

    identity.createPrincipal({ id: 'bob', displayName: 'Bob' });
    const bobCredential = identity.issueCredential({
      principalId: 'bob',
      label: 'Bob desktop',
    });
    identity.bindPersona(identity.trustPrincipal('bob'), {
      clientType: 'airi',
      clientInstanceId: 'bob-desktop',
      personaId: 'persona-bob',
      displayName: 'Bob 角色',
    });

    const personasResponse = await fetch(
      `${base}/api/identity/personas`,
      { headers: bearerHeaders(bootstrap.token) },
    );
    assert.equal(personasResponse.status, 200);
    const personasText = await personasResponse.text();
    const personas = JSON.parse(personasText) as {
      personas: Array<{
        personaId: string;
        roleMemoryCount: number;
      }>;
    };
    assert.deepEqual(personas.personas, [
      {
        ...personas.personas[0],
        personaId: 'persona-default',
        roleMemoryCount: 1,
      },
    ]);
    assert.equal(personasText.includes('persona-bob'), false);

    const crossRevoke = await fetch(
      `${base}/api/identity/credentials/${bobCredential.credential.id}/revoke`,
      {
        method: 'POST',
        headers: bearerHeaders(bootstrap.token),
        body: JSON.stringify({ reason: 'cross account attempt' }),
      },
    );
    assert.equal(crossRevoke.status, 404);
    assert.equal(
      (
        await fetch(`${base}/api/identity`, {
          headers: bearerHeaders(bobCredential.token),
        })
      ).status,
      200,
    );

    const revokeRotated = await fetch(
      `${base}/api/identity/credentials/${issued.credential.id}/revoke`,
      {
        method: 'POST',
        headers: bearerHeaders(bootstrap.token),
        body: JSON.stringify({ reason: 'rotation complete' }),
      },
    );
    assert.equal(revokeRotated.status, 200);
    assert.equal(
      (
        await fetch(`${base}/api/identity`, {
          headers: bearerHeaders(issued.token),
        })
      ).status,
      401,
    );

    const revokeCurrent = await fetch(
      `${base}/api/identity/credentials/${bootstrap.credential.id}/revoke`,
      {
        method: 'POST',
        headers: bearerHeaders(bootstrap.token),
        body: '{}',
      },
    );
    assert.equal(revokeCurrent.status, 200);
    assert.equal(
      (
        await fetch(`${base}/api/identity`, {
          headers: bearerHeaders(bootstrap.token),
        })
      ).status,
      401,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    database.close();
  }
});
