import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';
import {
  OllamaCompatibilityError,
  resolveLifecycleRequestContext,
} from '../src/server/ollama-compat.js';

const principal = Object.freeze({
  principalId: 'alice',
  namespace: 'personal',
  credentialId: 'credential-alice',
  authSource: 'credential',
});

function requestWithHeaders(
  headers: Array<[string, string]>,
): IncomingMessage {
  return {
    rawHeaders: headers.flatMap(([name, value]) => [name, value]),
  } as IncomingMessage;
}

test('AIRI 身份上下文只在完整 v1 契约下标记 complete', () => {
  const context = resolveLifecycleRequestContext(
    requestWithHeaders([
      ['x-memory-bridge-context-version', '1'],
      ['x-airi-character-id', 'persona-A'],
      ['x-airi-session-id', 'session-A1'],
      ['x-airi-round-id', 'round-1'],
      ['x-airi-project-id', 'project-A'],
    ]),
    principal,
  );

  assert.deepEqual(context, {
    ...principal,
    personaId: 'persona-A',
    sessionId: 'session-A1',
    roundId: 'round-1',
    projectId: 'project-A',
    identityStatus: 'complete',
  });
  assert.equal(Object.isFrozen(context), true);
});

test('AIRI 缺失或未声明版本的身份头 fail closed 为 degraded', () => {
  const missing = resolveLifecycleRequestContext(
    requestWithHeaders([]),
    principal,
  );
  assert.equal(missing.identityStatus, 'degraded');
  assert.equal(missing.personaId, null);
  assert.equal(missing.sessionId, null);
  assert.equal(missing.roundId, null);
  assert.equal(missing.projectId, null);

  const completeWithoutProject = resolveLifecycleRequestContext(
    requestWithHeaders([
      ['x-memory-bridge-context-version', '1'],
      ['x-airi-character-id', 'persona-A'],
      ['x-airi-session-id', 'session-A1'],
      ['x-airi-round-id', 'round-1'],
    ]),
    principal,
  );
  assert.equal(completeWithoutProject.identityStatus, 'complete');
  assert.equal(completeWithoutProject.projectId, null);

  const unversioned = resolveLifecycleRequestContext(
    requestWithHeaders([
      ['x-airi-character-id', 'persona-A'],
      ['x-airi-session-id', 'session-A1'],
      ['x-airi-round-id', 'round-1'],
      ['x-airi-project-id', 'project-A'],
    ]),
    principal,
  );
  assert.equal(unversioned.identityStatus, 'degraded');
  assert.equal(unversioned.personaId, null);
  assert.equal(unversioned.sessionId, null);
  assert.equal(unversioned.roundId, null);
  assert.equal(unversioned.projectId, null);
});

test('AIRI 接受以下划线或连字符开头的 URL-safe nanoid', () => {
  const context = resolveLifecycleRequestContext(
    requestWithHeaders([
      ['x-memory-bridge-context-version', '1'],
      ['x-airi-character-id', '_persona-A'],
      ['x-airi-session-id', '-session-A1'],
      ['x-airi-round-id', '_round-1'],
      ['x-airi-project-id', '-project-A'],
    ]),
    principal,
  );

  assert.equal(context.identityStatus, 'complete');
  assert.equal(context.personaId, '_persona-A');
  assert.equal(context.sessionId, '-session-A1');
  assert.equal(context.roundId, '_round-1');
  assert.equal(context.projectId, '-project-A');
});

test('AIRI 身份头拒绝重复、非法字符和未知协议版本', () => {
  for (const request of [
    requestWithHeaders([
      ['x-memory-bridge-context-version', '1'],
      ['x-airi-character-id', 'persona-A'],
      ['x-airi-character-id', 'persona-B'],
    ]),
    requestWithHeaders([
      ['x-memory-bridge-context-version', '1'],
      ['x-airi-session-id', 'session A1'],
    ]),
    requestWithHeaders([
      ['x-memory-bridge-context-version', '1'],
      ['x-airi-project-id', 'project-A'],
      ['x-airi-project-id', 'project-B'],
    ]),
    requestWithHeaders([
      ['x-memory-bridge-context-version', '1'],
      ['x-airi-project-id', 'project A'],
    ]),
    requestWithHeaders([
      ['x-memory-bridge-context-version', '1'],
      ['x-airi-project-id', 'project/A'],
    ]),
    requestWithHeaders([
      ['x-memory-bridge-context-version', '1'],
      ['x-airi-project-id', 'p'.repeat(129)],
    ]),
    requestWithHeaders([
      ['x-memory-bridge-context-version', '2'],
    ]),
  ]) {
    assert.throws(
      () => resolveLifecycleRequestContext(request, principal),
      (error: unknown) =>
        error instanceof OllamaCompatibilityError &&
        error.status === 400,
    );
  }
});
