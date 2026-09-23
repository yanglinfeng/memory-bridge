import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  openDatabase,
  SCHEMA_VERSION,
} from '../dist/server/database.js';
import { LifecycleStore } from '../dist/server/lifecycle-store.js';
import { MemoryGovernance } from '../dist/server/memory-governance.js';
import { MemoryStore } from '../dist/server/memory-store.js';

const databasePath = path.resolve(
  process.env.MEMORY_BRIDGE_REFINEMENT_DATABASE || '',
);
const refinementAt =
  process.env.MEMORY_BRIDGE_REFINEMENT_AT || new Date().toISOString();
const hotDays = Number(
  process.env.MEMORY_BRIDGE_EPISODE_HOT_DAYS || 30,
);
const batchSize = Number(
  process.env.MEMORY_BRIDGE_EPISODE_COMPACTION_BATCH_SIZE || 1_000,
);
const runVacuum = process.env.MEMORY_BRIDGE_REFINEMENT_VACUUM === '1';

if (!process.env.MEMORY_BRIDGE_REFINEMENT_DATABASE) {
  throw new Error('必须显式设置 MEMORY_BRIDGE_REFINEMENT_DATABASE');
}
if (!fs.existsSync(databasePath)) {
  throw new Error(`数据库不存在：${databasePath}`);
}
if (!Number.isInteger(hotDays) || hotDays < 7 || hotDays > 365) {
  throw new Error('MEMORY_BRIDGE_EPISODE_HOT_DAYS 必须是 7–365 的整数');
}
if (!Number.isInteger(batchSize) || batchSize < 50 || batchSize > 5_000) {
  throw new Error(
    'MEMORY_BRIDGE_EPISODE_COMPACTION_BATCH_SIZE 必须是 50–5000 的整数',
  );
}
if (!Number.isFinite(Date.parse(refinementAt))) {
  throw new Error('MEMORY_BRIDGE_REFINEMENT_AT 必须是有效时间');
}

function scalar(database, sql, ...values) {
  const row = database.prepare(sql).get(...values) || {};
  return Number(Object.values(row)[0] || 0);
}

function pragmaText(database, name) {
  const row = database.prepare(`PRAGMA ${name}`).get() || {};
  return String(Object.values(row)[0] || '');
}

function fingerprint(database, table) {
  const hash = createHash('sha256');
  let count = 0;
  for (const row of database.prepare(
    `SELECT * FROM ${table} ORDER BY id`,
  ).iterate()) {
    hash.update(JSON.stringify(row));
    hash.update('\n');
    count += 1;
  }
  return { count, sha256: hash.digest('hex') };
}

function indexCounts(database, compactedOnly = false) {
  const join = compactedOnly
    ? ' index_row JOIN conversation_episode_compactions compacted ON compacted.memory_id = index_row.memory_id'
    : ' index_row';
  const counts = {};
  for (const table of [
    'memory_embeddings',
    'memory_dense_lsh',
    'memory_ann_index',
    'memory_term_index',
  ]) {
    counts[table] = scalar(
      database,
      `SELECT COUNT(*) FROM ${table}${join}`,
    );
  }
  return counts;
}

function databaseSnapshot(database) {
  return {
    schemaVersion: scalar(database, 'PRAGMA user_version'),
    pageCount: scalar(database, 'PRAGMA page_count'),
    freelistCount: scalar(database, 'PRAGMA freelist_count'),
    pageSize: scalar(database, 'PRAGMA page_size'),
    turns: fingerprint(database, 'conversation_turns'),
    episodes: fingerprint(database, 'conversation_episodes'),
    indexRows: indexCounts(database),
  };
}

const sourceBytes = fs.statSync(databasePath).size;
const source = new DatabaseSync(databasePath, { readOnly: true });
const before = databaseSnapshot(source);
source.close();

const database = openDatabase(databasePath);
const lifecycleStore = new LifecycleStore(database);
const memoryStore = new MemoryStore(database);
const governance = new MemoryGovernance(
  database,
  lifecycleStore,
  memoryStore,
);
const scopes = database.prepare(
  `SELECT DISTINCT user_id, namespace
   FROM conversation_episodes
   ORDER BY user_id, namespace`,
).all();
const refinement = {
  scanned: 0,
  compacted: 0,
  rehydrated: 0,
  removedEmbeddingRows: 0,
  removedDenseRows: 0,
  removedAnnRows: 0,
  removedTermRows: 0,
};

for (const scope of scopes) {
  while (true) {
    const result = governance.refineEpisodeIndexes({
      userId: String(scope.user_id),
      namespace: String(scope.namespace),
      at: refinementAt,
      hotDays,
      batchSize,
    });
    for (const key of Object.keys(refinement)) {
      refinement[key] += Number(result[key] || 0);
    }
    if (result.compacted < batchSize && result.rehydrated < batchSize) break;
  }
}

database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
const afterRefinement = databaseSnapshot(database);
database.close();

const reopened = openDatabase(databasePath);
const reopenedStore = new MemoryStore(reopened);
const compacted = scalar(
  reopened,
  'SELECT COUNT(*) FROM conversation_episode_compactions',
);
const retainedFts = scalar(
  reopened,
  `SELECT COUNT(DISTINCT compacted.memory_id)
   FROM conversation_episode_compactions compacted
   JOIN memories_fts fts ON fts.memory_id = compacted.memory_id`,
);
const coldIndexRowsAfterRestart = indexCounts(reopened, true);
const denseWatermarks = scopes.map((scope) => ({
  userId: String(scope.user_id),
  namespace: String(scope.namespace),
  ...reopenedStore.denseIndexWatermark(
    String(scope.user_id),
    String(scope.namespace),
  ),
}));
const integrityBeforeVacuum = pragmaText(reopened, 'integrity_check');
const foreignKeyViolationsBeforeVacuum = reopened.prepare(
  'PRAGMA foreign_key_check',
).all().length;
reopened.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
const bytesBeforeVacuum = fs.statSync(databasePath).size;

if (runVacuum) {
  reopened.exec('VACUUM');
  reopened.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
}
const finalSnapshot = databaseSnapshot(reopened);
const integrity = pragmaText(reopened, 'integrity_check');
const foreignKeyViolations = reopened.prepare(
  'PRAGMA foreign_key_check',
).all().length;
reopened.close();
const finalBytes = fs.statSync(databasePath).size;

const zeroColdIndexes = Object.values(
  coldIndexRowsAfterRestart,
).every((value) => value === 0);
const fingerprintsPreserved =
  before.turns.sha256 === finalSnapshot.turns.sha256 &&
  before.episodes.sha256 === finalSnapshot.episodes.sha256;
const denseComplete = denseWatermarks.every(
  (watermark) => watermark.complete === true,
);
const checks = {
  currentSchema: finalSnapshot.schemaVersion === SCHEMA_VERSION,
  compactedEpisodesExist: compacted > 0,
  ftsRetainedForEveryCompactedEpisode: retainedFts === compacted,
  coldIndexesRemainAbsentAfterRestart: zeroColdIndexes,
  originalTurnsAndEpisodesPreserved: fingerprintsPreserved,
  denseWatermarksComplete: denseComplete,
  integrityOk: integrity === 'ok',
  foreignKeysOk: foreignKeyViolations === 0,
};
const passed = Object.values(checks).every(Boolean);

console.log(JSON.stringify({
  passed,
  databasePath,
  refinementAt,
  hotDays,
  batchSize,
  runVacuum,
  bytes: {
    source: sourceBytes,
    beforeVacuum: bytesBeforeVacuum,
    final: finalBytes,
    reclaimedByVacuum: runVacuum
      ? Math.max(0, bytesBeforeVacuum - finalBytes)
      : 0,
  },
  before,
  refinement,
  afterRefinement,
  afterRestart: {
    compacted,
    retainedFts,
    coldIndexRows: coldIndexRowsAfterRestart,
    denseWatermarks,
    integrityBeforeVacuum,
    foreignKeyViolationsBeforeVacuum,
  },
  final: finalSnapshot,
  integrity,
  foreignKeyViolations,
  checks,
}, null, 2));

if (!passed) process.exitCode = 1;
