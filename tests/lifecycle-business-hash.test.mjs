import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { snapshotLifecycleBusinessState } from '../scripts/lifecycle-business-hash-lib.mjs';

const cli = path.resolve('scripts/lifecycle-business-hash.mjs');

function createDatabase(root, reverse = false) {
  const databasePath = path.join(root, reverse ? 'reverse.sqlite3' : 'business.sqlite3');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA user_version = 31;
    CREATE TABLE account_principals (
      id TEXT PRIMARY KEY, display_name TEXT, status TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE conversation_sessions (
      id TEXT PRIMARY KEY, user_id TEXT, namespace TEXT, client_name TEXT,
      external_id TEXT, persona_id TEXT, project_id TEXT, identity_source TEXT,
      identity_status TEXT, started_at TEXT, metadata_json TEXT
    );
    CREATE TABLE conversation_turns (
      id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, namespace TEXT,
      external_id TEXT, role TEXT, content TEXT, content_hash TEXT, round_id TEXT,
      occurred_at TEXT, created_at TEXT, metadata_json TEXT
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, user_id TEXT, namespace TEXT, kind TEXT, title TEXT,
      content TEXT, summary TEXT, status TEXT, source TEXT, scope_type TEXT,
      scope_key TEXT, source_authority TEXT, semantic_revision INTEGER, negated INTEGER,
      updated_at TEXT, access_count INTEGER, checksum TEXT
    );
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY, user_id TEXT, namespace TEXT, kind TEXT, stable_key TEXT,
      current_version_id TEXT, status TEXT, revision INTEGER, predicate_key TEXT,
      predicate_cardinality TEXT, scope_type TEXT, scope_key TEXT,
      source_authority TEXT, pinned INTEGER, observation_count INTEGER,
      retrieved_count INTEGER, updated_at TEXT
    );
    CREATE TABLE memory_versions (
      id TEXT PRIMARY KEY, memory_item_id TEXT, version INTEGER, namespace TEXT,
      kind TEXT, predicate_key TEXT, predicate_cardinality TEXT, scope_type TEXT,
      scope_key TEXT, source TEXT, source_authority TEXT, negated INTEGER,
      title TEXT, content TEXT, summary TEXT, created_at TEXT
    );
    CREATE TABLE memory_evidence (
      id TEXT PRIMARY KEY, memory_version_id TEXT, turn_id TEXT, evidence_type TEXT,
      source_authority TEXT, excerpt TEXT, source_ref TEXT, created_at TEXT
    );
    CREATE TABLE memory_candidate_evidence (
      candidate_id TEXT, turn_id TEXT, evidence_type TEXT, ordinal INTEGER,
      excerpt TEXT, excerpt_hash TEXT, created_at TEXT
    );
    CREATE TABLE conversation_lineage_keys (
      session_id TEXT, fingerprint TEXT, key_type TEXT, message_count INTEGER, updated_at TEXT
    );
    CREATE TABLE memory_jobs (
      id TEXT PRIMARY KEY, user_id TEXT, namespace TEXT, status TEXT,
      attempts INTEGER, lease_until TEXT, updated_at TEXT
    );
  `);
  const statements = [
    "INSERT INTO account_principals VALUES ('alice', 'private-a', 'active', 't1', 't1')",
    "INSERT INTO account_principals VALUES ('bob', 'private-b', 'active', 't1', 't1')",
    "INSERT INTO conversation_sessions VALUES ('s-a', 'alice', 'personal', 'airi', 'ext-a', 'p-a', NULL, 'credential', 'complete', 't1', '{\"private\":true}')",
    "INSERT INTO conversation_sessions VALUES ('s-b', 'bob', 'personal', 'airi', 'ext-b', 'p-b', NULL, 'credential', 'complete', 't1', '{\"private\":true}')",
    "INSERT INTO conversation_turns VALUES ('t-a1', 's-a', 'alice', 'personal', 'turn-a1', 'user', 'private chat a1', 'hash-a1', 'r-a', 't1', 't1', '{}')",
    "INSERT INTO conversation_turns VALUES ('t-a2', 's-a', 'alice', 'personal', 'turn-a2', 'assistant', 'private chat a2', 'hash-a2', 'r-a', 't2', 't2', '{}')",
    "INSERT INTO conversation_turns VALUES ('t-b1', 's-b', 'bob', 'personal', 'turn-b1', 'user', 'private chat b1', 'hash-b1', 'r-b', 't1', 't1', '{}')",
    "INSERT INTO memories VALUES ('m-a', 'alice', 'personal', 'preference', 'private', 'private body a', '', 'active', 'mcp', 'personal', 'self', 'direct_user', 1, 0, 't1', 99, 'private-checksum-a')",
    "INSERT INTO memories VALUES ('m-a-old', 'alice', 'project', 'event', 'private', 'private body old', '', 'deleted', 'mcp', 'project', 'proj-a', 'direct_user', 1, 0, 't1', 12, 'private-checksum-old')",
    "INSERT INTO memories VALUES ('m-b', 'bob', 'personal', 'preference', 'private', 'private body b', '', 'active', 'mcp', 'personal', 'self', 'direct_user', 1, 0, 't1', 7, 'private-checksum-b')",
    "INSERT INTO memory_items VALUES ('mi-a', 'alice', 'personal', 'preference', 'stable-a', 'mv-a1', 'active', 1, 'likes', 'single', 'personal', 'self', 'direct_user', 0, 1, 30, 't1')",
    "INSERT INTO memory_items VALUES ('mi-b', 'bob', 'personal', 'preference', 'stable-b', 'mv-b1', 'active', 1, 'likes', 'single', 'personal', 'self', 'direct_user', 0, 1, 20, 't1')",
    "INSERT INTO memory_versions VALUES ('mv-a1', 'mi-a', 1, 'personal', 'preference', 'likes', 'single', 'personal', 'self', 'mcp', 'direct_user', 0, 'private', 'private version a', '', 't1')",
    "INSERT INTO memory_versions VALUES ('mv-b1', 'mi-b', 1, 'personal', 'preference', 'likes', 'single', 'personal', 'self', 'mcp', 'direct_user', 0, 'private', 'private version b', '', 't1')",
    "INSERT INTO memory_evidence VALUES ('ev-a', 'mv-a1', 't-a1', 'direct', 'direct_user', 'private excerpt', 'private-ref', 't1')",
    "INSERT INTO memory_candidate_evidence VALUES ('candidate-a', 't-a1', 'direct', 0, 'private excerpt', 'private-excerpt-hash', 't1')",
    "INSERT INTO conversation_lineage_keys VALUES ('s-a', 'lineage-a', 'exact', 2, 't1')",
  ];
  for (const statement of reverse ? [...statements].reverse() : statements) database.exec(statement);
  database.close();
  return databasePath;
}

test('logical lifecycle hashes are canonical, tenant-aware, and privacy-safe', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'business-hash-'));
  try {
    const databasePath = createDatabase(root);
    const reversePath = createDatabase(root, true);
    const initial = snapshotLifecycleBusinessState(databasePath);
    const reverse = snapshotLifecycleBusinessState(reversePath);
    assert.deepEqual(initial, reverse);
    assert.deepEqual(initial.counts, {
      principals: 2,
      principalNamespaces: 3,
      sessions: 2,
      turns: 3,
      memoryProjections: 3,
      memoryItems: 2,
      memoryVersions: 2,
      evidenceEdges: 1,
      candidateEvidenceEdges: 1,
      lineageKeys: 1,
    });
    assert.equal(initial.mcp.recallList.count, 2);
    assert.equal(initial.mcp.stats.total, 3);
    assert.equal(initial.mcp.stats.groups, 3);
    for (const hash of [
      initial.hashes.turns,
      initial.hashes.memories,
      initial.hashes.lineage,
      initial.hashes.overall,
      initial.mcp.recallList.hash,
      initial.mcp.stats.hash,
    ]) {
      assert.match(hash, /^[a-f0-9]{64}$/u);
    }
    const serialized = JSON.stringify(initial);
    for (const privateValue of [
      'alice', 'bob', 'private chat', 'private body', 'private excerpt',
      'private-checksum', 'lineage-a', 'proj-a',
    ]) {
      assert.doesNotMatch(serialized, new RegExp(privateValue, 'u'));
    }

    const cliResult = spawnSync(process.execPath, [cli, '--database', databasePath], {
      encoding: 'utf8',
    });
    assert.equal(cliResult.status, 0, cliResult.stderr);
    assert.deepEqual(JSON.parse(cliResult.stdout), initial);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WAL, timestamps, jobs, logs, and volatile counters do not change business hashes', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'business-hash-volatile-'));
  try {
    const databasePath = createDatabase(root);
    const initial = snapshotLifecycleBusinessState(databasePath);
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA journal_mode = WAL;
      UPDATE conversation_turns
         SET content = 'changed private chat', created_at = 't9', metadata_json = '{"changed":true}'
       WHERE id = 't-a1';
      UPDATE memories
         SET title = 'changed private title', content = 'changed private body',
             updated_at = 't9', access_count = access_count + 100,
             checksum = 'changed-private-checksum'
       WHERE id = 'm-a';
      UPDATE memory_items
         SET retrieved_count = retrieved_count + 100, updated_at = 't9'
       WHERE id = 'mi-a';
      INSERT INTO memory_jobs VALUES ('job-volatile', 'alice', 'personal', 'running', 9, 't9', 't9');
    `);
    const afterVolatile = snapshotLifecycleBusinessState(databasePath);
    assert.deepEqual(afterVolatile, initial);

    database.exec(`
      UPDATE memories SET status = 'archived' WHERE id = 'm-a';
      UPDATE memory_items
         SET current_version_id = 'mv-a2', status = 'archived', revision = 2
       WHERE id = 'mi-a';
      INSERT INTO memory_versions VALUES (
        'mv-a2', 'mi-a', 2, 'personal', 'preference', 'likes', 'single',
        'personal', 'self', 'mcp', 'direct_user', 0,
        'private', 'private version a2', '', 't9'
      );
    `);
    const afterBusinessChange = snapshotLifecycleBusinessState(databasePath);
    assert.equal(afterBusinessChange.hashes.turns, initial.hashes.turns);
    assert.notEqual(afterBusinessChange.hashes.memories, initial.hashes.memories);
    assert.equal(afterBusinessChange.hashes.lineage, initial.hashes.lineage);
    assert.notEqual(afterBusinessChange.hashes.overall, initial.hashes.overall);
    assert.notEqual(afterBusinessChange.mcp.stats.hash, initial.mcp.stats.hash);

    database.exec(`
      INSERT INTO memory_evidence VALUES (
        'ev-a2', 'mv-a2', 't-a2', 'direct', 'direct_user',
        'private excerpt a2', 'private-ref-a2', 't9'
      );
    `);
    const afterLineageChange = snapshotLifecycleBusinessState(databasePath);
    assert.equal(afterLineageChange.hashes.turns, afterBusinessChange.hashes.turns);
    assert.equal(afterLineageChange.hashes.memories, afterBusinessChange.hashes.memories);
    assert.notEqual(afterLineageChange.hashes.lineage, afterBusinessChange.hashes.lineage);
    database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unsupported schema versions and missing stable tables fail closed', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'business-hash-schema-'));
  try {
    const oldPath = path.join(root, 'schema30.sqlite3');
    const oldDatabase = new DatabaseSync(oldPath);
    oldDatabase.exec('PRAGMA user_version = 30;');
    oldDatabase.close();
    assert.throws(
      () => snapshotLifecycleBusinessState(oldPath),
      /schema 31/u,
    );

    const incompletePath = path.join(root, 'incomplete.sqlite3');
    const incomplete = new DatabaseSync(incompletePath);
    incomplete.exec(`
      PRAGMA user_version = 31;
      CREATE TABLE account_principals (id TEXT PRIMARY KEY, status TEXT);
    `);
    incomplete.close();
    assert.throws(
      () => snapshotLifecycleBusinessState(incompletePath),
      /缺少表：conversation_sessions/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
