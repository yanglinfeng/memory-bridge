import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { MemoryStore } from '../src/server/memory-store.js';

interface EvidenceDigestView {
  versionId: string | null;
  proofCount: number;
  firstEvidenceAt: string | null;
  lastEvidenceAt: string | null;
  excerpts: string[];
  evidence: Array<{
    evidenceType: string;
    turnId: string | null;
    sourceRef: string | null;
  }>;
}

interface EvidenceDigestStore {
  memoryEvidenceDigests(
    memoryIds: readonly string[],
    ownerId: string,
  ): Map<string, EvidenceDigestView>;
}

interface SqlObservation {
  marker: 'summary' | 'metadata' | 'excerpts';
  rowCount: number;
  sql: string;
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      status TEXT NOT NULL,
      sensitivity TEXT NOT NULL
    );
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      current_version_id TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE memory_versions (
      id TEXT PRIMARY KEY,
      memory_item_id TEXT NOT NULL,
      superseded_at TEXT
    );
    CREATE TABLE conversation_turns (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      user_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      content TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE TABLE memory_evidence (
      id TEXT PRIMARY KEY,
      memory_version_id TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      turn_id TEXT,
      excerpt TEXT,
      source_ref TEXT,
      sensitivity TEXT NOT NULL,
      source_authority TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX memory_evidence_version_idx
      ON memory_evidence(memory_version_id, created_at ASC);
  `);
}

function storeFor(database: DatabaseSync): EvidenceDigestStore {
  const store = Object.create(MemoryStore.prototype) as object;
  Object.defineProperty(store, 'database', {
    configurable: true,
    value: database,
  });
  return store as EvidenceDigestStore;
}

function insertMemory(
  database: DatabaseSync,
  memoryId: string,
  sensitivity = 'normal',
): string {
  const versionId = `${memoryId}-version`;
  database.prepare(
    `INSERT INTO memories (
       id, user_id, namespace, status, sensitivity
     ) VALUES (?, 'alice', 'personal', 'active', ?)`,
  ).run(memoryId, sensitivity);
  database.prepare(
    `INSERT INTO memory_items (
       id, user_id, namespace, current_version_id, status
     ) VALUES (?, 'alice', 'personal', ?, 'active')`,
  ).run(memoryId, versionId);
  database.prepare(
    `INSERT INTO memory_versions (
       id, memory_item_id, superseded_at
     ) VALUES (?, ?, NULL)`,
  ).run(versionId, memoryId);
  return versionId;
}

function insertTurn(
  database: DatabaseSync,
  input: {
    id: string;
    role?: string;
    userId?: string;
    namespace?: string;
    content: string;
    occurredAt: string;
  },
): void {
  database.prepare(
    `INSERT INTO conversation_turns (
       id, role, user_id, namespace, content, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.role || 'user',
    input.userId || 'alice',
    input.namespace || 'personal',
    input.content,
    input.occurredAt,
  );
}

function insertEvidence(
  database: DatabaseSync,
  input: {
    id: string;
    versionId: string;
    turnId?: string | null;
    excerpt?: string | null;
    evidenceType?: string;
    sourceRef?: string | null;
    sensitivity?: string;
    sourceAuthority?: string;
    createdAt: string;
  },
): void {
  database.prepare(
    `INSERT INTO memory_evidence (
       id, memory_version_id, evidence_type, turn_id, excerpt,
       source_ref, sensitivity, source_authority, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.versionId,
    input.evidenceType || input.id,
    input.turnId ?? null,
    input.excerpt ?? null,
    input.sourceRef ?? null,
    input.sensitivity || 'normal',
    input.sourceAuthority || 'direct_user',
    input.createdAt,
  );
}

function observedDatabase(
  database: DatabaseSync,
  observations: SqlObservation[],
): DatabaseSync {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          const statement = target.prepare(sql);
          const marker = sql.match(
            /memory_evidence_digest_(summary|metadata|excerpts)/u,
          )?.[1] as SqlObservation['marker'] | undefined;
          if (!marker) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === 'all') {
                return (...parameters: SQLInputValue[]) => {
                  const rows = statementTarget.all(...parameters);
                  observations.push({
                    marker,
                    rowCount: rows.length,
                    sql,
                  });
                  return rows;
                };
              }
              const value = Reflect.get(
                statementTarget,
                statementProperty,
                statementTarget,
              );
              return typeof value === 'function'
                ? value.bind(statementTarget)
                : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('证据摘要保持证明、时间、元数据和合法原文语义', () => {
  const database = new DatabaseSync(':memory:');
  try {
    createSchema(database);
    const versionId = insertMemory(database, 'memory-main');
    const turns = [
      {
        id: 'turn-old',
        content: '用户补充：我以前常喝铁观音。',
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'turn-secret',
        content: 'API Key 是 sk-abcdefghijklmnopqrstuvwxyz123456',
        occurredAt: '2026-01-12T00:00:00.000Z',
      },
      {
        id: 'turn-assistant',
        role: 'assistant',
        content: '我猜用户喜欢咖啡。',
        occurredAt: '2026-01-13T00:00:00.000Z',
      },
      {
        id: 'turn-wrong-owner',
        userId: 'bob',
        content: '我喜欢红茶。',
        occurredAt: '2026-01-14T00:00:00.000Z',
      },
      {
        id: 'turn-wrong-namespace',
        namespace: 'work',
        content: '我喜欢绿茶。',
        occurredAt: '2026-01-15T00:00:00.000Z',
      },
      {
        id: 'turn-latest',
        content: '现在我最常喝   龙井。',
        occurredAt: '2026-01-10T00:00:00.000Z',
      },
      {
        id: 'turn-second',
        content: '最近我也常喝普洱。',
        occurredAt: '2026-01-09T00:00:00.000Z',
      },
      {
        id: 'turn-invalid-excerpt',
        content: '这段原文里没有目标句子。',
        occurredAt: '2026-01-11T00:00:00.000Z',
      },
      {
        id: 'turn-third',
        content: '周末我会喝白茶。',
        occurredAt: '2026-01-08T00:00:00.000Z',
      },
      {
        id: 'turn-imported',
        content: '我喜欢咖啡。',
        occurredAt: '2026-01-16T00:00:00.000Z',
      },
    ];
    for (const turn of turns) insertTurn(database, turn);
    const evidence = [
      ['turn-old', '  我以前常喝铁观音。  ', 'direct_user'],
      ['turn-old', '我以前常喝铁观音。', 'direct_user'],
      [
        'turn-secret',
        'API Key 是 sk-abcdefghijklmnopqrstuvwxyz123456',
        'direct_user',
      ],
      ['turn-assistant', '我猜用户喜欢咖啡。', 'direct_user'],
      ['turn-wrong-owner', '我喜欢红茶。', 'direct_user'],
      ['turn-wrong-namespace', '我喜欢绿茶。', 'direct_user'],
      ['turn-latest', '我最常喝   龙井。', 'direct_user'],
      ['turn-second', '最近我也常喝普洱。', 'user_confirmed'],
      ['turn-latest', '我最常喝   龙井。', 'direct_user'],
      ['turn-invalid-excerpt', '我每天跑步。', 'direct_user'],
      ['turn-third', '周末我会喝白茶。', 'direct_user'],
      ['turn-imported', '我喜欢咖啡。', 'imported'],
    ] as const;
    evidence.forEach(([turnId, excerpt, sourceAuthority], index) => {
      insertEvidence(database, {
        id: `e-${String(index).padStart(2, '0')}`,
        versionId,
        turnId,
        excerpt,
        sourceAuthority,
        sourceRef: `ref-${String(index).padStart(2, '0')}`,
        createdAt:
          `2026-02-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      });
    });

    const sensitiveVersion = insertMemory(
      database,
      'memory-sensitive',
      'sensitive',
    );
    insertTurn(database, {
      id: 'turn-sensitive',
      content: '我的住址是测试地址。',
      occurredAt: '2026-01-20T00:00:00.000Z',
    });
    insertEvidence(database, {
      id: 'sensitive-evidence',
      versionId: sensitiveVersion,
      turnId: 'turn-sensitive',
      excerpt: '我的住址是测试地址。',
      sourceRef: 'sensitive-ref',
      createdAt: '2026-02-02T00:00:00.000Z',
    });

    const digests = storeFor(database).memoryEvidenceDigests(
      ['memory-main', 'memory-sensitive'],
      'alice',
    );
    const digest = digests.get('memory-main');
    assert.ok(digest);
    assert.equal(digest.versionId, versionId);
    assert.equal(digest.proofCount, 6);
    assert.equal(digest.firstEvidenceAt, '2026-01-01T00:00:00.000Z');
    assert.equal(digest.lastEvidenceAt, '2026-01-12T00:00:00.000Z');
    assert.deepEqual(digest.excerpts, [
      '我最常喝 龙井。',
      '最近我也常喝普洱。',
    ]);
    assert.deepEqual(
      digest.evidence.map((item) => item.sourceRef),
      Array.from(
        { length: 10 },
        (_, index) => `ref-${String(index).padStart(2, '0')}`,
      ),
    );
    assert.equal(digest.evidence.length, 10);

    const sensitiveDigest = digests.get('memory-sensitive');
    assert.ok(sensitiveDigest);
    assert.equal(sensitiveDigest.proofCount, 1);
    assert.deepEqual(sensitiveDigest.excerpts, []);
    assert.deepEqual(sensitiveDigest.evidence, [{
      evidenceType: 'sensitive-evidence',
      turnId: 'turn-sensitive',
      sourceRef: 'sensitive-ref',
    }]);
  } finally {
    database.close();
  }
});

test('10 到 10000 条证据时 JS 只接收固定上限摘要行', () => {
  const database = new DatabaseSync(':memory:');
  try {
    createSchema(database);
    const insertTurnStatement = database.prepare(
      `INSERT INTO conversation_turns (
         id, role, user_id, namespace, content, occurred_at
       ) VALUES (?, 'user', 'alice', 'personal', ?, ?)`,
    );
    const insertEvidenceStatement = database.prepare(
      `INSERT INTO memory_evidence (
         id, memory_version_id, evidence_type, turn_id, excerpt,
         source_ref, sensitivity, source_authority, created_at
       ) VALUES (?, ?, 'scale', ?, ?, NULL, 'normal',
                 'direct_user', ?)`,
    );
    const sizes = [10, 1_000, 10_000] as const;
    database.exec('BEGIN');
    for (const size of sizes) {
      const memoryId = `scale-${size}`;
      const versionId = insertMemory(database, memoryId);
      for (let index = 0; index < size; index += 1) {
        const suffix = String(index).padStart(5, '0');
        const turnId = `${memoryId}-turn-${suffix}`;
        const excerpt = `${memoryId} 的第 ${index} 条长期证据。`;
        const timestamp = new Date(
          Date.UTC(2026, 0, 1, 0, 0, index),
        ).toISOString();
        insertTurnStatement.run(turnId, excerpt, timestamp);
        insertEvidenceStatement.run(
          `${memoryId}-evidence-${suffix}`,
          versionId,
          turnId,
          excerpt,
          timestamp,
        );
      }
    }
    database.exec('COMMIT');

    const observations: SqlObservation[] = [];
    const store = storeFor(observedDatabase(database, observations));
    for (const size of sizes) {
      observations.length = 0;
      const memoryId = `scale-${size}`;
      const digest = store.memoryEvidenceDigests([memoryId], 'alice').get(
        memoryId,
      );
      assert.ok(digest);
      assert.equal(digest.proofCount, size);
      assert.equal(digest.evidence.length, 10);
      assert.equal(digest.excerpts.length, 2);
      assert.deepEqual(
        observations.map(({ marker, rowCount }) => ({ marker, rowCount })),
        [
          { marker: 'summary', rowCount: 1 },
          { marker: 'metadata', rowCount: 10 },
          { marker: 'excerpts', rowCount: 2 },
        ],
      );
      const summarySql = observations.find(
        ({ marker }) => marker === 'summary',
      )?.sql || '';
      assert.doesNotMatch(summarySql, /t\.content\s+AS\s+turn_content/iu);
    }
  } finally {
    database.close();
  }
});
