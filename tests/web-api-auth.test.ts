import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, api } from '../src/web/src/api.js';

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: '需要身份凭据' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('任意 API 的当前凭据 401 会立即清除 Token 并通知门禁', async () => {
  const originalFetch = globalThis.fetch;
  let authorization = '';
  let notificationCount = 0;
  const unsubscribe = api.onAuthenticationRequired(() => {
    notificationCount += 1;
  });
  try {
    api.setAccessToken('active-token');
    globalThis.fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get('Authorization') || '';
      return unauthorizedResponse();
    };

    await assert.rejects(
      api.health(),
      (error: unknown) =>
        error instanceof ApiError && error.status === 401,
    );
    assert.equal(authorization, 'Bearer active-token');
    assert.equal(api.hasAccessToken(), false);
    assert.equal(notificationCount, 1);
  } finally {
    unsubscribe();
    api.clearAccessToken();
    globalThis.fetch = originalFetch;
  }
});

test('旧请求迟到的 401 不会清除刚替换的新 Token', async () => {
  const originalFetch = globalThis.fetch;
  let resolveOldRequest: ((response: Response) => void) | null = null;
  let notificationCount = 0;
  const unsubscribe = api.onAuthenticationRequired(() => {
    notificationCount += 1;
  });
  try {
    api.setAccessToken('old-token');
    globalThis.fetch = () => new Promise<Response>((resolve) => {
      resolveOldRequest = resolve;
    });
    const oldRequest = api.health();

    api.setAccessToken('new-token');
    assert.ok(resolveOldRequest);
    resolveOldRequest(unauthorizedResponse());
    await assert.rejects(oldRequest, ApiError);

    assert.equal(api.hasAccessToken(), true);
    assert.equal(notificationCount, 0);

    let authorization = '';
    globalThis.fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get('Authorization') || '';
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    await api.health();
    assert.equal(authorization, 'Bearer new-token');
  } finally {
    unsubscribe();
    api.clearAccessToken();
    globalThis.fetch = originalFetch;
  }
});
