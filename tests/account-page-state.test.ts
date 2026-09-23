import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveScopeSelectionAfterRefresh,
} from '../src/web/src/components/AccountPage.js';

test('刷新账户数据时保留同一 persona 的手填 session', () => {
  const manuallySelected = {
    personaId: 'persona-a',
    sessionId: 'qa-chat-a1',
  };
  const refreshed = resolveScopeSelectionAfterRefresh(
    manuallySelected,
    [{
      personaId: 'persona-a',
      latestSession: { externalId: 'qa-chat-a2' },
    }],
  );

  assert.strictEqual(refreshed, manuallySelected);
  assert.equal(refreshed.sessionId, 'qa-chat-a1');
});

test('当前 persona 消失时才回退到首个 persona 的最近 session', () => {
  assert.deepEqual(
    resolveScopeSelectionAfterRefresh(
      { personaId: 'removed-persona', sessionId: 'old-chat' },
      [{
        personaId: 'persona-b',
        latestSession: { externalId: 'qa-chat-b2' },
      }],
    ),
    { personaId: 'persona-b', sessionId: 'qa-chat-b2' },
  );
});
