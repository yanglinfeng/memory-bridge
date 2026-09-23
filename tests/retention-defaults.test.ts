import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import { MemoryGovernance } from '../src/server/memory-governance.js';
import { MemoryStore } from '../src/server/memory-store.js';

function createFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-retention-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const memoryStore = new MemoryStore(database);
  const lifecycleStore = new LifecycleStore(database);
  const governance = new MemoryGovernance(
    database,
    lifecycleStore,
    memoryStore,
  );
  return {
    database,
    memoryStore,
    lifecycleStore,
    governance,
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

const DAY = 86_400_000;

function recordOldTurn(
  fixture: ReturnType<typeof createFixture>,
  suffix: string,
  content: string,
) {
  return fixture.lifecycleStore.recordTurn({
    clientName: 'retention-test',
    sessionExternalId: `session-${suffix}`,
    turnExternalId: `turn-${suffix}`,
    role: 'user',
    content,
    occurredAt: new Date(Date.now() - 100 * DAY).toISOString(),
  }).turn;
}

test('默认不衰减：未配置策略时老记忆不会被自动归档', () => {
  const fixture = createFixture();
  try {
    const memory = fixture.memoryStore.remember({
      kind: 'event',
      content: '用户一年前记录过一件不起眼的小事。',
      stableKey: '用户::不起眼的小事',
    }).memory;

    const result = fixture.governance.runRetentionSweep({
      at: new Date(Date.now() + 1000 * DAY).toISOString(),
    });

    assert.equal(result.archived, 0);
    assert.equal(fixture.memoryStore.get(memory.id)?.status, 'active');
  } finally {
    fixture.close();
  }
});

test('默认不抹除：旧对话原文与挂在记忆上的证据摘要都保持原样', () => {
  const fixture = createFixture();
  try {
    const turn = recordOldTurn(
      fixture,
      'keep',
      '我在考虑换工作，想找远程岗位。',
    );
    const memory = fixture.memoryStore.remember({
      kind: 'event',
      content: '用户考虑换工作，想找远程岗位。',
      stableKey: '用户::换工作',
      evidenceTurnId: turn.id,
      evidenceExcerpt: turn.content,
    }).memory;

    const result = fixture.governance.runRetentionSweep({
      at: new Date().toISOString(),
    });

    assert.equal(result.evidenceRedacted, 0);
    assert.equal(
      fixture.lifecycleStore.getTurn(turn.id)?.content,
      '我在考虑换工作，想找远程岗位。',
    );
    assert.equal(
      fixture.database
        .prepare('SELECT excerpt FROM memory_evidence WHERE turn_id = ?')
        .get(turn.id)?.excerpt,
      '我在考虑换工作，想找远程岗位。',
    );
    assert.equal(fixture.memoryStore.get(memory.id)?.status, 'active');
  } finally {
    fixture.close();
  }
});

test('显式配置 halfLifeDays 后，衰减归档能力保留', () => {
  const fixture = createFixture();
  try {
    fixture.governance.upsertPolicy({ halfLifeDays: 90 });
    const memory = fixture.memoryStore.remember({
      kind: 'event',
      content: '用户记录过一件需要按时间淘汰的临时事项。',
      stableKey: '用户::临时事项',
    }).memory;

    const result = fixture.governance.runRetentionSweep({
      at: new Date(Date.now() + 1000 * DAY).toISOString(),
    });

    assert.equal(result.archived, 1);
    assert.equal(fixture.memoryStore.get(memory.id)?.status, 'archived');
    assert.equal(
      fixture.governance.get(memory.id)?.archiveReason,
      'retention_decay',
    );
  } finally {
    fixture.close();
  }
});

test('显式配置 halfLifeDays: null 可覆盖既有策略，表达不衰减', () => {
  const fixture = createFixture();
  try {
    fixture.governance.upsertPolicy({ halfLifeDays: 90 });
    fixture.governance.upsertPolicy({ halfLifeDays: null });
    const memory = fixture.memoryStore.remember({
      kind: 'event',
      content: '用户记录过一件后来决定永久保留的事项。',
      stableKey: '用户::永久保留事项',
    }).memory;

    const result = fixture.governance.runRetentionSweep({
      at: new Date(Date.now() + 1000 * DAY).toISOString(),
    });

    assert.equal(result.archived, 0);
    assert.equal(fixture.memoryStore.get(memory.id)?.status, 'active');
  } finally {
    fixture.close();
  }
});

test('显式配置 evidenceTtlDays 后，证据抹除能力保留', () => {
  const fixture = createFixture();
  try {
    fixture.governance.upsertPolicy({ evidenceTtlDays: 30 });
    const turn = recordOldTurn(
      fixture,
      'redact',
      '这是一条超过 TTL 的原始用户证据。',
    );
    fixture.memoryStore.remember({
      kind: 'event',
      content: '用户曾记录一条普通旧事件。',
      stableKey: '用户::普通旧事件',
      evidenceTurnId: turn.id,
      evidenceExcerpt: turn.content,
    });

    const result = fixture.governance.runRetentionSweep({
      at: new Date().toISOString(),
    });

    assert.equal(result.evidenceRedacted, 1);
    assert.equal(
      fixture.lifecycleStore.getTurn(turn.id)?.content,
      '[retention-redacted]',
    );
    assert.equal(
      fixture.database
        .prepare('SELECT excerpt FROM memory_evidence WHERE turn_id = ?')
        .get(turn.id)?.excerpt,
      null,
    );
  } finally {
    fixture.close();
  }
});

test('显式配置 evidenceTtlDays: null 可覆盖既有策略，表达不抹除', () => {
  const fixture = createFixture();
  try {
    fixture.governance.upsertPolicy({ evidenceTtlDays: 30 });
    fixture.governance.upsertPolicy({ evidenceTtlDays: null });
    const turn = recordOldTurn(
      fixture,
      'keep-explicit',
      '这是一条希望被永久保留的原始证据。',
    );

    const result = fixture.governance.runRetentionSweep({
      at: new Date().toISOString(),
    });

    assert.equal(result.evidenceRedacted, 0);
    assert.equal(
      fixture.lifecycleStore.getTurn(turn.id)?.content,
      '这是一条希望被永久保留的原始证据。',
    );
  } finally {
    fixture.close();
  }
});

test('显式 TTL 过期仍会归档，不受不衰减默认值影响', () => {
  const fixture = createFixture();
  try {
    const memory = fixture.memoryStore.remember({
      kind: 'event',
      content: '用户有一条明确写了失效时间的临时计划。',
      stableKey: '用户::临时计划',
    }).memory;
    fixture.governance.setTtl(
      memory.id,
      new Date(Date.now() - DAY).toISOString(),
    );

    const result = fixture.governance.runRetentionSweep({
      at: new Date().toISOString(),
    });

    assert.equal(result.archived, 1);
    assert.equal(
      fixture.governance.get(memory.id)?.archiveReason,
      'ttl_expired',
    );
  } finally {
    fixture.close();
  }
});
