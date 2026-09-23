/**
 * v16 · 候选裁决运行、证据与墓碑
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import { addColumnIfMissing } from '../sqlite-schema-helpers.js';
export function applyV16(context: MigrationContext): void {
  const { database } = context;

  addColumnIfMissing(
    database,
    'memory_candidates',
    'negated',
    `ALTER TABLE memory_candidates
         ADD COLUMN negated INTEGER NOT NULL DEFAULT 0
           CHECK (negated IN (0, 1))`,
  );
  addColumnIfMissing(
    database,
    'memory_candidates',
    'scope_type',
    `ALTER TABLE memory_candidates
         ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'personal'
           CHECK (scope_type IN ('personal', 'project', 'role', 'session'))`,
  );
  addColumnIfMissing(
    database,
    'memory_candidates',
    'scope_key',
    `ALTER TABLE memory_candidates
         ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'self'`,
  );
  for (const [column, sql] of [
    ['claim_occurred_at', `ALTER TABLE memory_candidates
          ADD COLUMN claim_occurred_at TEXT`],
    ['claim_valid_from', `ALTER TABLE memory_candidates
          ADD COLUMN claim_valid_from TEXT`],
    ['claim_valid_to', `ALTER TABLE memory_candidates
          ADD COLUMN claim_valid_to TEXT`],
    ['source_excerpt', `ALTER TABLE memory_candidates
          ADD COLUMN source_excerpt TEXT`],
    ['extractor_id', `ALTER TABLE memory_candidates
          ADD COLUMN extractor_id TEXT NOT NULL DEFAULT 'legacy'`],
    ['extractor_version', `ALTER TABLE memory_candidates
          ADD COLUMN extractor_version TEXT NOT NULL DEFAULT 'v1'`],
    ['extraction_model', `ALTER TABLE memory_candidates
          ADD COLUMN extraction_model TEXT NOT NULL DEFAULT 'unknown'`],
    ['extraction_prompt_version', `ALTER TABLE memory_candidates
          ADD COLUMN extraction_prompt_version TEXT NOT NULL DEFAULT 'unknown'`],
  ] as const) {
    addColumnIfMissing(
      database,
      'memory_candidates',
      column,
      sql,
    );
  }
  addColumnIfMissing(
    database,
    'memory_candidates',
    'source_authority',
    `ALTER TABLE memory_candidates
         ADD COLUMN source_authority TEXT NOT NULL DEFAULT 'legacy_unknown'
           CHECK (source_authority IN (
             'direct_user', 'user_confirmed', 'assistant_inference',
             'imported', 'legacy_unknown'
           ))`,
  );

  for (const table of ['memories', 'memory_items'] as const) {
    addColumnIfMissing(
      database,
      table,
      'scope_type',
      `ALTER TABLE ${table}
           ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'personal'
             CHECK (scope_type IN ('personal', 'project', 'role', 'session'))`,
    );
    addColumnIfMissing(
      database,
      table,
      'scope_key',
      `ALTER TABLE ${table}
           ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'self'`,
    );
    addColumnIfMissing(
      database,
      table,
      'sensitivity',
      `ALTER TABLE ${table}
           ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal'
             CHECK (sensitivity IN ('normal', 'sensitive', 'credential'))`,
    );
    addColumnIfMissing(
      database,
      table,
      'source_authority',
      `ALTER TABLE ${table}
           ADD COLUMN source_authority TEXT NOT NULL DEFAULT 'legacy_unknown'
             CHECK (source_authority IN (
               'direct_user', 'user_confirmed', 'assistant_inference',
               'imported', 'legacy_unknown'
             ))`,
    );
  }
  addColumnIfMissing(
    database,
    'memories',
    'negated',
    `ALTER TABLE memories
         ADD COLUMN negated INTEGER NOT NULL DEFAULT 0
           CHECK (negated IN (0, 1))`,
  );

  for (const [column, sql] of [
    ['scope_type', `ALTER TABLE memory_versions
          ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'personal'
            CHECK (scope_type IN ('personal', 'project', 'role', 'session'))`],
    ['scope_key', `ALTER TABLE memory_versions
          ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'self'`],
    ['sensitivity', `ALTER TABLE memory_versions
          ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal'
            CHECK (sensitivity IN ('normal', 'sensitive', 'credential'))`],
    ['source_authority', `ALTER TABLE memory_versions
          ADD COLUMN source_authority TEXT NOT NULL DEFAULT 'legacy_unknown'
            CHECK (source_authority IN (
              'direct_user', 'user_confirmed', 'assistant_inference',
              'imported', 'legacy_unknown'
            ))`],
    ['negated', `ALTER TABLE memory_versions
          ADD COLUMN negated INTEGER NOT NULL DEFAULT 0
            CHECK (negated IN (0, 1))`],
  ] as const) {
    addColumnIfMissing(
      database,
      'memory_versions',
      column,
      sql,
    );
  }

  addColumnIfMissing(
    database,
    'memory_evidence',
    'sensitivity',
    `ALTER TABLE memory_evidence
         ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal'
           CHECK (sensitivity IN ('normal', 'sensitive', 'credential'))`,
  );
  addColumnIfMissing(
    database,
    'memory_evidence',
    'source_authority',
    `ALTER TABLE memory_evidence
         ADD COLUMN source_authority TEXT NOT NULL DEFAULT 'legacy_unknown'
           CHECK (source_authority IN (
             'direct_user', 'user_confirmed', 'assistant_inference',
             'imported', 'legacy_unknown'
           ))`,
  );
  addColumnIfMissing(
    database,
    'memory_tombstones',
    'scope_type',
    `ALTER TABLE memory_tombstones
         ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'personal'
           CHECK (scope_type IN ('personal', 'project', 'role', 'session'))`,
  );
  addColumnIfMissing(
    database,
    'memory_tombstones',
    'scope_key',
    `ALTER TABLE memory_tombstones
         ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'self'`,
  );

  database.exec(`
      CREATE TABLE IF NOT EXISTS candidate_resolution_runs (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL
          REFERENCES memory_candidates(id) ON DELETE CASCADE,
        target_memory_item_id TEXT
          REFERENCES memory_items(id) ON DELETE SET NULL,
        relation TEXT NOT NULL
          CHECK (relation IN (
            'equivalent', 'reinforces', 'supersedes',
            'contradicts', 'coexists'
          )),
        method TEXT NOT NULL
          CHECK (method IN ('exact', 'rule', 'embedding', 'model', 'manual')),
        confidence REAL NOT NULL
          CHECK (confidence >= 0 AND confidence <= 1),
        model TEXT,
        prompt_version TEXT,
        rationale TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('completed', 'failed')),
        error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(candidate_id, target_memory_item_id, relation, method)
      );

      CREATE INDEX IF NOT EXISTS candidate_resolution_candidate_idx
        ON candidate_resolution_runs(candidate_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS memory_candidates_scoped_key_idx
        ON memory_candidates(
          user_id, namespace, scope_type, scope_key, normalized_key
        );
      CREATE INDEX IF NOT EXISTS memory_items_scoped_predicate_idx
        ON memory_items(
          user_id, namespace, scope_type, scope_key,
          predicate_key, status
        );
      CREATE INDEX IF NOT EXISTS memories_recall_scope_idx
        ON memories(
          user_id, namespace, scope_type, scope_key,
          sensitivity, status
        );
      CREATE INDEX IF NOT EXISTS memory_tombstones_scoped_idx
        ON memory_tombstones(
          user_id, namespace, scope_type, scope_key, stable_key
        );

      PRAGMA user_version = 16;
      `);
}
