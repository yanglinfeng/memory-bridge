import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CandidateResolver } from '../src/server/candidate-resolver.js';
import { openDatabase } from '../src/server/database.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import { MemoryAdminService } from '../src/server/memory-admin.js';
import {
  type ConsolidationProvider,
  MemoryConsolidator,
} from '../src/server/memory-consolidator.js';
import { MemoryGovernance } from '../src/server/memory-governance.js';
import { MemoryStore } from '../src/server/memory-store.js';
import { Schema28LongMemoryDefectRepair } from
  '../src/server/schema28-defect-repair.js';

const provider: ConsolidationProvider = {
  model: 'repair-test-model',
  promptVersion: 'repair-test-v1',
  async consolidate(_scope, sources) {
    return {
      sentences: [{
        text: sources.map((source) => source.content).join(' '),
        sourceVersionIds: sources.map(
          (source) => source.memoryVersionId,
        ),
      }],
    };
  },
  async verifySupport(_scope, _sources, sentences) {
    return sentences.map((_sentence, sentenceIndex) => ({
      sentenceIndex,
      supported: true,
      rationale: 'deterministic repair fixture',
    }));
  },
};

function createFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-schema28-repair-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  const lifecycle = new LifecycleStore(database);
  const resolver = new CandidateResolver(
    database,
    lifecycle,
    store,
    { mode: 'auto' },
  );
  const governance = new MemoryGovernance(database, lifecycle, store);
  return {
    database,
    store,
    lifecycle,
    consolidator: new MemoryConsolidator(
      database,
      lifecycle,
      store,
      provider,
      2,
      100,
      2,
    ),
    admin: new MemoryAdminService(
      database,
      store,
      lifecycle,
      resolver,
      governance,
    ),
    repair: new Schema28LongMemoryDefectRepair(
      database,
      store,
      lifecycle,
    ),
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function bindPersona(
  database: ReturnType<typeof openDatabase>,
  personaId: string,
  displayName: string,
): void {
  const timestamp = '2026-08-09T00:00:00.000Z';
  database.prepare(
    `INSERT INTO client_persona_bindings (
       id, principal_id, client_type, client_instance_id,
       persona_id, display_name, status, created_at,
       updated_at, last_seen_at
     ) VALUES (?, 'default', 'airi', 'repair-test', ?, ?,
               'active', ?, ?, ?)`,
  ).run(
    `binding-${personaId}`,
    personaId,
    displayName,
    timestamp,
    timestamp,
    timestamp,
  );
}

function recordTrustedTurn(
  fixture: ReturnType<typeof createFixture>,
  personaId: string,
  externalId: string,
  content: string,
) {
  return fixture.lifecycle.recordTurn({
    userId: 'default',
    namespace: 'personal',
    personaId,
    projectId: null,
    identitySource: 'credential',
    identityStatus: 'complete',
    roundId: `${externalId}-round`,
    clientName: 'ollama-compat',
    sessionExternalId: `${externalId}-session`,
    turnExternalId: `${externalId}-turn`,
    role: 'user',
    content,
  }).turn;
}

function doctorCount(
  fixture: ReturnType<typeof createFixture>,
  category: string,
): number {
  return fixture.admin.runMemoryDoctor('default').issues.find(
    (issue) => issue.category === category,
  )?.count || 0;
}

function seedLegacyMixedRoleConsolidation(
  fixture: ReturnType<typeof createFixture>,
  sourceMemoryIds: string[],
): {
  status: 'created';
  consolidationId: string;
  memoryId: string;
} {
  const consolidationId = 'legacy-mixed-role-consolidation';
  const sourceVersionIds = sourceMemoryIds.map((memoryId) => {
    const versionId = fixture.database.prepare(
      'SELECT current_version_id FROM memory_items WHERE id = ?',
    ).get(memoryId)?.current_version_id;
    assert.ok(versionId);
    return String(versionId);
  });
  const memory = fixture.store.remember({
    kind: 'preference',
    content: '用户在星璃角色中称为小枫，在墨言角色中称为阿林。',
    source: 'consolidation',
    sourceRef: `consolidation:${consolidationId}`,
    stableKey: 'legacy::mixed-role-consolidation',
    predicateKey: 'derived::topic::legacy-mixed-role',
    normalizedValue: 'legacy-mixed-role',
    normalizedValueHash: 'legacy-mixed-role',
    scopeType: 'personal',
    scopeKey: 'self',
  }).memory;
  const timestamp = '2026-08-01T00:00:00.000Z';
  fixture.database.prepare(
    `INSERT INTO derived_consolidations (
       id, memory_id, user_id, namespace, scope_type, scope_key,
       source_set_hash, model, prompt_version, status, generated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    consolidationId,
    memory.id,
    'default',
    'personal',
    'topic',
    'kind:preference',
    'legacy-mixed-role-source-set',
    provider.model,
    provider.promptVersion,
    'active',
    timestamp,
  );
  for (const versionId of sourceVersionIds) {
    fixture.database.prepare(
      `INSERT INTO derived_consolidation_sources (
         consolidation_id, memory_version_id
       ) VALUES (?, ?)`,
    ).run(consolidationId, versionId);
  }
  return {
    status: 'created',
    consolidationId,
    memoryId: memory.id,
  };
}

test('schema 28 修复把可证明角色事实迁移并失效混合摘要且保持幂等', async () => {
  const fixture = createFixture();
  try {
    bindPersona(fixture.database, 'persona-star', '星璃');
    bindPersona(fixture.database, 'persona-ink', '墨言');
    const starText =
      '只在和星璃这个角色聊天时，请叫我小枫。';
    const inkText =
      '只在和墨言这个角色聊天时，请叫我阿林。';
    const starTurn = recordTrustedTurn(
      fixture,
      'persona-star',
      'star-role-repair',
      starText,
    );
    const inkTurn = recordTrustedTurn(
      fixture,
      'persona-ink',
      'ink-role-repair',
      inkText,
    );
    const star = fixture.store.remember({
      kind: 'preference',
      content: `用户/角色称呼/${starText}`,
      source: 'lifecycle-auto',
      stableKey: '用户::星璃角色称呼',
      predicateKey: '用户::星璃角色称呼',
      normalizedValue: starText,
      normalizedValueHash: 'star-role-name',
      evidenceTurnId: starTurn.id,
      evidenceExcerpt: starText,
      scopeType: 'personal',
      scopeKey: 'self',
    }).memory;
    const ink = fixture.store.remember({
      kind: 'preference',
      content: `用户/角色称呼/${inkText}`,
      source: 'lifecycle-auto',
      stableKey: '用户::墨言角色称呼',
      predicateKey: '用户::墨言角色称呼',
      normalizedValue: inkText,
      normalizedValueHash: 'ink-role-name',
      evidenceTurnId: inkTurn.id,
      evidenceExcerpt: inkText,
      scopeType: 'personal',
      scopeKey: 'self',
    }).memory;
    fixture.store.addRelation(
      star.id,
      ink.id,
      'related',
      'default',
    );
    const consolidation = seedLegacyMixedRoleConsolidation(
      fixture,
      [star.id, ink.id],
    );
    assert.equal(consolidation.status, 'created');
    const evidenceBefore = Number(fixture.database.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_evidence
       WHERE memory_version_id IN (
         SELECT id FROM memory_versions
         WHERE memory_item_id IN (?, ?)
       )`,
    ).get(star.id, ink.id)?.count || 0);
    assert.equal(doctorCount(
      fixture,
      'role_constraint_in_personal_scope',
    ), 2);
    assert.equal(doctorCount(
      fixture,
      'mixed_role_consolidation',
    ), 1);

    const dryRun = fixture.repair.run();
    assert.equal(dryRun.applied, false);
    assert.equal(dryRun.planned, 2);
    assert.equal(dryRun.migratedRoleMemories, 0);
    assert.equal(fixture.store.get(star.id)?.scopeType, 'personal');

    const applied = fixture.repair.run({ apply: true });
    assert.equal(applied.migratedRoleMemories, 2);
    assert.equal(applied.quarantinedMemories, 0);
    assert.equal(applied.consolidationsInvalidated, 1);
    assert.deepEqual(
      [
        fixture.store.get(star.id)?.scopeType,
        fixture.store.get(star.id)?.scopeKey,
        fixture.store.get(ink.id)?.scopeType,
        fixture.store.get(ink.id)?.scopeKey,
      ],
      ['role', 'persona-star', 'role', 'persona-ink'],
    );
    assert.equal(
      fixture.database.prepare(
        'SELECT status FROM derived_consolidations WHERE id = ?',
      ).get(consolidation.consolidationId!)?.status,
      'stale',
    );
    assert.equal(
      fixture.database.prepare(
        'SELECT status FROM memories WHERE id = ?',
      ).get(consolidation.memoryId!)?.status,
      'archived',
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memory_edges
         WHERE from_memory_item_id IN (?, ?) OR to_memory_item_id IN (?, ?)`,
      ).get(star.id, ink.id, star.id, ink.id)?.count,
      0,
    );
    assert.equal(doctorCount(
      fixture,
      'role_constraint_in_personal_scope',
    ), 0);
    assert.equal(doctorCount(
      fixture,
      'mixed_role_consolidation',
    ), 0);
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_evidence
         WHERE memory_version_id IN (
           SELECT id FROM memory_versions
           WHERE memory_item_id IN (?, ?)
         )`,
      ).get(star.id, ink.id)?.count || 0),
      evidenceBefore,
    );
    assert.equal(
      fixture.store.list({
        scopeType: 'role',
        scopeKey: 'persona-star',
      }).items.some((memory) => memory.id === ink.id),
      false,
    );
    const secondRun = fixture.repair.run({ apply: true });
    assert.equal(secondRun.planned, 0);
    assert.equal(secondRun.migratedRoleMemories, 0);
    assert.equal(
      fixture.database.prepare('PRAGMA foreign_key_check').all().length,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('schema 28 修复隔离条件缺失事实并排入可信 v17 重提取任务', () => {
  const fixture = createFixture();
  try {
    const content = '早上还是桂花乌龙，这个习惯在工作日也一样。';
    const turn = recordTrustedTurn(
      fixture,
      'persona-star',
      'condition-repair',
      content,
    );
    const memory = fixture.store.remember({
      kind: 'preference',
      content: '用户/主要饮品/桂花乌龙',
      source: 'lifecycle-auto',
      stableKey: '用户::主要饮品',
      predicateKey: '用户::主要饮品',
      normalizedValue: '桂花乌龙',
      normalizedValueHash: 'osmanthus-tea',
      evidenceTurnId: turn.id,
      evidenceExcerpt: content,
    }).memory;
    const before = fixture.repair.run();
    assert.equal(before.conditionCandidates, 1);
    assert.deepEqual(before.items[0].missingQualifiers, [
      '工作日',
      '早上',
    ]);

    const applied = fixture.repair.run({ apply: true });
    assert.equal(applied.quarantinedMemories, 1);
    assert.equal(applied.reextractJobsQueued, 1);
    assert.equal(fixture.store.get(memory.id, true)?.status, 'archived');
    const job = fixture.database.prepare(
      `SELECT job_type, user_id, namespace, payload_json, status
       FROM memory_jobs
       WHERE id LIKE 'schema28-condition-reextract-v17:%'`,
    ).get();
    assert.equal(job?.job_type, 'extract_turn');
    assert.equal(job?.user_id, 'default');
    assert.equal(job?.namespace, 'personal');
    assert.equal(job?.status, 'pending');
    const payload = JSON.parse(String(job?.payload_json));
    assert.equal(payload.turnId, turn.id);
    assert.equal(payload.personaId, 'persona-star');
    assert.equal(payload.identityStatus, 'complete');
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memories_fts
         WHERE memory_id = ?`,
      ).get(memory.id)?.count,
      0,
    );
    assert.equal(fixture.repair.run({ apply: true }).planned, 0);
    assert.equal(
      fixture.database.prepare('PRAGMA integrity_check').get()?.integrity_check,
      'ok',
    );
  } finally {
    fixture.close();
  }
});

test('schema 28 修复对未知角色名 fail closed 并保留原始证据', () => {
  const fixture = createFixture();
  try {
    const content = '只在和未知角色这个角色聊天时，请叫我小枫。';
    const turn = recordTrustedTurn(
      fixture,
      'persona-star',
      'unknown-role-repair',
      content,
    );
    const memory = fixture.store.remember({
      kind: 'preference',
      content: `用户/角色称呼/${content}`,
      source: 'lifecycle-auto',
      stableKey: '用户::未知角色称呼',
      predicateKey: '用户::未知角色称呼',
      normalizedValue: content,
      normalizedValueHash: 'unknown-role-name',
      evidenceTurnId: turn.id,
      evidenceExcerpt: content,
    }).memory;
    const report = fixture.repair.run({ apply: true });
    assert.equal(report.migratedRoleMemories, 0);
    assert.equal(report.quarantinedMemories, 1);
    assert.equal(report.items[0].action, 'quarantine_role');
    assert.equal(report.items[0].reason, 'trusted_role_name_unmapped');
    assert.equal(fixture.store.get(memory.id, true)?.status, 'archived');
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_evidence e
         JOIN memory_versions v ON v.id = e.memory_version_id
         WHERE v.memory_item_id = ?`,
      ).get(memory.id)?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});
