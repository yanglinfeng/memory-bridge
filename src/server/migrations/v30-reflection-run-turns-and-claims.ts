/**
 * v30 · 反思运行轮次 / 模型调用 / 声明表
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import {
  hasColumn,
  addColumnIfMissing,
} from '../sqlite-schema-helpers.js';
export function applyV30(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      CREATE TABLE IF NOT EXISTS memory_turn_ingest_order (
        ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL UNIQUE
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        ingested_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO memory_turn_ingest_order (
        turn_id, user_id, namespace, ingested_at
      )
      SELECT id, user_id, namespace, created_at
      FROM conversation_turns
      ORDER BY created_at ASC, rowid ASC;

      CREATE INDEX IF NOT EXISTS memory_turn_ingest_owner_idx
        ON memory_turn_ingest_order(
          user_id, namespace, ingest_seq ASC
        );

      CREATE TRIGGER IF NOT EXISTS conversation_turn_ingest_order_insert
      AFTER INSERT ON conversation_turns
      BEGIN
        INSERT OR IGNORE INTO memory_turn_ingest_order (
          turn_id, user_id, namespace, ingested_at
        ) VALUES (NEW.id, NEW.user_id, NEW.namespace, NEW.created_at);
      END;
      `);
  if (!hasColumn(
    database,
    'memory_reflection_checkpoints',
    'run_type',
  )) {
    database.exec(`
      DROP INDEX IF EXISTS memory_reflection_checkpoints_lag_idx;
      ALTER TABLE memory_reflection_checkpoints
        RENAME TO memory_reflection_checkpoints_v29;

      CREATE TABLE memory_reflection_checkpoints (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        scope_type TEXT NOT NULL
          CHECK (scope_type IN ('personal', 'project', 'role', 'session')),
        scope_key TEXT NOT NULL,
        run_type TEXT NOT NULL
          CHECK (run_type IN ('reextract', 'reflect')),
        generation_key TEXT NOT NULL,
        last_ingest_seq INTEGER NOT NULL DEFAULT 0
          CHECK (last_ingest_seq >= 0),
        last_turn_occurred_at TEXT,
        last_turn_id TEXT,
        extractor_id TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        extraction_prompt_version TEXT NOT NULL,
        reflection_model TEXT NOT NULL,
        reflection_prompt_version TEXT NOT NULL,
        implementation_version TEXT NOT NULL,
        last_success_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (
          user_id, namespace, scope_type, scope_key,
          run_type, generation_key
        )
      );

      INSERT INTO memory_reflection_checkpoints (
        id, user_id, namespace, scope_type, scope_key,
        run_type, generation_key, last_ingest_seq,
        last_turn_occurred_at, last_turn_id,
        extractor_id, extractor_version, extraction_prompt_version,
        reflection_model, reflection_prompt_version,
        implementation_version, last_success_at, created_at, updated_at
      )
      SELECT
        id || ':reextract', user_id, namespace, scope_type, scope_key,
        'reextract',
        implementation_version || ':' || extractor_id || ':' ||
          extractor_version || ':' || extraction_prompt_version,
        COALESCE((
          SELECT ingest_seq FROM memory_turn_ingest_order o
          WHERE o.turn_id = memory_reflection_checkpoints_v29.last_turn_id
        ), 0),
        last_turn_occurred_at, last_turn_id,
        extractor_id, extractor_version, extraction_prompt_version,
        reflection_model, reflection_prompt_version,
        implementation_version, last_success_at, created_at, updated_at
      FROM memory_reflection_checkpoints_v29;

      INSERT INTO memory_reflection_checkpoints (
        id, user_id, namespace, scope_type, scope_key,
        run_type, generation_key, last_ingest_seq,
        last_turn_occurred_at, last_turn_id,
        extractor_id, extractor_version, extraction_prompt_version,
        reflection_model, reflection_prompt_version,
        implementation_version, last_success_at, created_at, updated_at
      )
      SELECT
        id || ':reflect', user_id, namespace, scope_type, scope_key,
        'reflect',
        implementation_version || ':' || reflection_model || ':' ||
          reflection_prompt_version,
        COALESCE((
          SELECT ingest_seq FROM memory_turn_ingest_order o
          WHERE o.turn_id = memory_reflection_checkpoints_v29.last_turn_id
        ), 0),
        last_turn_occurred_at, last_turn_id,
        extractor_id, extractor_version, extraction_prompt_version,
        reflection_model, reflection_prompt_version,
        implementation_version, last_success_at, created_at, updated_at
      FROM memory_reflection_checkpoints_v29;

      DROP TABLE memory_reflection_checkpoints_v29;

      CREATE INDEX IF NOT EXISTS memory_reflection_checkpoints_lag_idx
        ON memory_reflection_checkpoints(
          user_id, namespace, run_type, generation_key,
          last_ingest_seq ASC
        );
        `);
  }
  database.exec(`

      CREATE TABLE IF NOT EXISTS memory_reflection_run_turns (
        run_id TEXT NOT NULL
          REFERENCES memory_reflection_runs(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL
          REFERENCES conversation_turns(id) ON DELETE RESTRICT,
        ingest_seq INTEGER NOT NULL CHECK (ingest_seq > 0),
        turn_alias TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        content_hash TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (run_id, turn_id),
        UNIQUE (run_id, ordinal),
        UNIQUE (run_id, turn_alias)
      );

      CREATE INDEX IF NOT EXISTS memory_reflection_run_turns_turn_idx
        ON memory_reflection_run_turns(turn_id, run_id);

      CREATE TABLE IF NOT EXISTS memory_reflection_model_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL
          REFERENCES memory_reflection_runs(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        budget_day TEXT NOT NULL,
        call_type TEXT NOT NULL
          CHECK (call_type IN ('reextract', 'reflect')),
        model TEXT NOT NULL,
        estimated_tokens INTEGER NOT NULL DEFAULT 0
          CHECK (estimated_tokens >= 0),
        status TEXT NOT NULL
          CHECK (status IN (
            'reserved', 'completed', 'failed', 'refunded'
          )),
        error TEXT,
        reserved_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (run_id, call_type, id)
      );

      CREATE INDEX IF NOT EXISTS memory_reflection_model_calls_budget_idx
        ON memory_reflection_model_calls(
          user_id, namespace, budget_day, status
        );

      CREATE TABLE IF NOT EXISTS memory_reflection_claims (
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        scope_type TEXT NOT NULL
          CHECK (scope_type IN ('personal', 'project', 'role', 'session')),
        scope_key TEXT NOT NULL,
        claim_fingerprint TEXT NOT NULL,
        candidate_id TEXT
          REFERENCES memory_candidates(id) ON DELETE SET NULL,
        decision TEXT NOT NULL DEFAULT 'active'
          CHECK (decision IN (
            'active', 'confirmed', 'rejected', 'blocked'
          )),
        first_run_id TEXT NOT NULL
          REFERENCES memory_reflection_runs(id) ON DELETE RESTRICT,
        last_run_id TEXT NOT NULL
          REFERENCES memory_reflection_runs(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (
          user_id, namespace, scope_type, scope_key, claim_fingerprint
        )
      );

      CREATE UNIQUE INDEX IF NOT EXISTS memory_reflection_claims_candidate_idx
        ON memory_reflection_claims(candidate_id)
        WHERE candidate_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS memory_reflection_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL
          REFERENCES memory_reflection_runs(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        event_type TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS memory_reflection_events_run_idx
        ON memory_reflection_events(run_id, id ASC);
      `);
  addColumnIfMissing(
    database,
    'memory_reflection_runs',
    'generation_key',
    `ALTER TABLE memory_reflection_runs
         ADD COLUMN generation_key TEXT NOT NULL DEFAULT 'legacy-v29'`,
  );
  addColumnIfMissing(
    database,
    'memory_reflection_runs',
    'window_start_ingest_seq',
    `ALTER TABLE memory_reflection_runs
         ADD COLUMN window_start_ingest_seq INTEGER`,
  );
  addColumnIfMissing(
    database,
    'memory_reflection_runs',
    'window_end_ingest_seq',
    `ALTER TABLE memory_reflection_runs
         ADD COLUMN window_end_ingest_seq INTEGER`,
  );
  addColumnIfMissing(
    database,
    'memory_candidate_evidence',
    'user_id',
    `ALTER TABLE memory_candidate_evidence
         ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
  );
  addColumnIfMissing(
    database,
    'memory_candidate_evidence',
    'namespace',
    `ALTER TABLE memory_candidate_evidence
         ADD COLUMN namespace TEXT NOT NULL DEFAULT ''`,
  );
  addColumnIfMissing(
    database,
    'memory_candidate_evidence',
    'scope_type',
    `ALTER TABLE memory_candidate_evidence
         ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'personal'`,
  );
  addColumnIfMissing(
    database,
    'memory_candidate_evidence',
    'scope_key',
    `ALTER TABLE memory_candidate_evidence
         ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'self'`,
  );
  database.exec(`
      UPDATE memory_candidate_evidence
      SET
        user_id = (
          SELECT c.user_id FROM memory_candidates c
          WHERE c.id = memory_candidate_evidence.candidate_id
        ),
        namespace = (
          SELECT c.namespace FROM memory_candidates c
          WHERE c.id = memory_candidate_evidence.candidate_id
        ),
        scope_type = (
          SELECT c.scope_type FROM memory_candidates c
          WHERE c.id = memory_candidate_evidence.candidate_id
        ),
        scope_key = (
          SELECT c.scope_key FROM memory_candidates c
          WHERE c.id = memory_candidate_evidence.candidate_id
        );

      CREATE TRIGGER IF NOT EXISTS memory_candidate_evidence_owner_insert
      BEFORE INSERT ON memory_candidate_evidence
      WHEN NOT EXISTS (
        SELECT 1
        FROM memory_candidates c
        JOIN conversation_turns t ON t.id = NEW.turn_id
        WHERE c.id = NEW.candidate_id
          AND c.user_id = NEW.user_id
          AND c.namespace = NEW.namespace
          AND c.scope_type = NEW.scope_type
          AND c.scope_key = NEW.scope_key
          AND t.user_id = c.user_id
          AND t.namespace = c.namespace
      )
      BEGIN
        SELECT RAISE(ABORT, 'candidate evidence owner/scope mismatch');
      END;

      CREATE TRIGGER IF NOT EXISTS memory_candidate_evidence_owner_update
      BEFORE UPDATE OF
        candidate_id, turn_id, user_id, namespace, scope_type, scope_key
      ON memory_candidate_evidence
      BEGIN
        SELECT RAISE(ABORT, 'candidate evidence identity is immutable');
      END;

      PRAGMA user_version = 30;
      `);
}
