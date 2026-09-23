import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConversationService } from '../src/server/conversation-service.js';
import { openDatabase } from '../src/server/database.js';
import { createHttpServer } from '../src/server/http-server.js';
import { IdentityService } from '../src/server/identity.js';
import { MemoryStore } from '../src/server/memory-store.js';

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('本地聊天工作台初始化只创建幂等 persona/profile，不写入演示对话或记忆', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-chat-workspace-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const identity = new IdentityService(database);
  const token = identity.issueCredential({
    principalId: 'default',
    label: 'local workspace test',
  }).token;
  const conversations = new ConversationService(database);
  const server = createHttpServer(new MemoryStore(database), {
    identityService: identity,
    conversationService: conversations,
    conversationNamespace: 'workspace-test',
  });
  try {
    const base = await listen(server);
    const request = () => fetch(`${base}/api/chat-workspace/bootstrap`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const first = await request();
    assert.equal(first.status, 200);
    const firstBody = await first.json() as {
      persona: { personaId: string; displayName: string };
      profile: { personaId: string; profileVersion: number; displayName: string };
    };
    assert.equal(firstBody.persona.personaId, 'memory-bridge-local-chat');
    assert.equal(firstBody.persona.displayName, '本地助手');
    assert.equal(firstBody.profile.personaId, 'memory-bridge-local-chat');
    assert.equal(firstBody.profile.profileVersion, 1);
    assert.equal(firstBody.profile.displayName, '本地助手');

    const second = await request();
    assert.equal(second.status, 200);
    assert.equal(
      (await second.json() as { profile: { profileVersion: number } })
        .profile.profileVersion,
      1,
    );
    const list = await fetch(
      `${base}/api/conversations?personaId=memory-bridge-local-chat`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json() as { items: unknown[] }).items, []);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM memories').get()?.count,
      0,
    );
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
