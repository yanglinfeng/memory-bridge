/**
 * v29 · 反思设置 / 检查点 / 运行表
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import { addColumnIfMissing } from '../sqlite-schema-helpers.js';
export function applyV29(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      CREATE TABLE IF NOT EXISTS memory_reflection_settings (
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'shadow'
          CHECK (mode IN ('off', 'shadow')),
        daily_call_limit INTEGER NOT NULL DEFAULT 48
          CHECK (daily_call_limit >= 0 AND daily_call_limit <= 1000),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, namespace)
      );

      CREATE TABLE IF NOT EXISTS memory_reflection_checkpoints (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        scope_type TEXT NOT NULL
          CHECK (scope_type IN ('personal', 'project', 'role', 'session')),
        scope_key TEXT NOT NULL,
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
        UNIQUE (user_id, namespace, scope_type, scope_key)
      );

      CREATE INDEX IF NOT EXISTS memory_reflection_checkpoints_lag_idx
        ON memory_reflection_checkpoints(
          user_id, namespace, last_turn_occurred_at ASC, last_turn_id ASC
        );

      CREATE TABLE IF NOT EXISTS memory_reflection_runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        scope_type TEXT NOT NULL
          CHECK (scope_type IN ('personal', 'project', 'role', 'session')),
        scope_key TEXT NOT NULL,
        run_type TEXT NOT NULL
          CHECK (run_type IN ('reextract', 'reflect')),
        trigger TEXT NOT NULL
          CHECK (trigger IN (
            'sweep', 'model_upgrade', 'manual', 'repair', 'pre_retention'
          )),
        status TEXT NOT NULL
          CHECK (status IN (
            'pending', 'running', 'completed', 'partial', 'failed',
            'dead', 'cancelled'
          )),
        window_start TEXT,
        window_end TEXT,
        turn_set_hash TEXT NOT NULL,
        input_turn_count INTEGER NOT NULL DEFAULT 0
          CHECK (input_turn_count >= 0),
        candidate_count INTEGER NOT NULL DEFAULT 0
          CHECK (candidate_count >= 0),
        accepted_count INTEGER NOT NULL DEFAULT 0
          CHECK (accepted_count >= 0),
        pending_count INTEGER NOT NULL DEFAULT 0
          CHECK (pending_count >= 0),
        rejected_count INTEGER NOT NULL DEFAULT 0
          CHECK (rejected_count >= 0),
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        extractor_id TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        implementation_version TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
        lease_owner TEXT,
        lease_until TEXT,
        last_error TEXT,
        requested_by TEXT NOT NULL,
        cancel_requested_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (
          user_id, namespace, scope_type, scope_key, run_type,
          turn_set_hash, implementation_version
        )
      );

      CREATE INDEX IF NOT EXISTS memory_reflection_runs_queue_idx
        ON memory_reflection_runs(status, created_at ASC);
      CREATE INDEX IF NOT EXISTS memory_reflection_runs_owner_idx
        ON memory_reflection_runs(
          user_id, namespace, scope_type, scope_key, created_at DESC
        );

      CREATE TABLE IF NOT EXISTS memory_candidate_evidence (
        candidate_id TEXT NOT NULL
          REFERENCES memory_candidates(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        excerpt TEXT,
        excerpt_hash TEXT NOT NULL,
        evidence_type TEXT NOT NULL
          CHECK (evidence_type IN ('direct', 'pattern_support')),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (candidate_id, turn_id, excerpt_hash)
      );

      CREATE INDEX IF NOT EXISTS memory_candidate_evidence_turn_idx
        ON memory_candidate_evidence(turn_id, candidate_id);
      `);
  addColumnIfMissing(
    database,
    'memory_candidates',
    'reflection_run_id',
    `ALTER TABLE memory_candidates
         ADD COLUMN reflection_run_id TEXT
           REFERENCES memory_reflection_runs(id) ON DELETE SET NULL`,
  );
  addColumnIfMissing(
    database,
    'memory_candidates',
    'candidate_origin',
    `ALTER TABLE memory_candidates
         ADD COLUMN candidate_origin TEXT NOT NULL DEFAULT 'turn_extraction'
           CHECK (candidate_origin IN (
             'turn_extraction', 'history_reextract', 'reflection'
           ))`,
  );
  addColumnIfMissing(
    database,
    'memory_candidates',
    'claim_fingerprint',
    `ALTER TABLE memory_candidates ADD COLUMN claim_fingerprint TEXT`,
  );
  database.exec(`
      CREATE INDEX IF NOT EXISTS memory_candidates_reflection_run_idx
        ON memory_candidates(reflection_run_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS memory_candidates_claim_fingerprint_idx
        ON memory_candidates(
          user_id, namespace, scope_type, scope_key,
          claim_fingerprint, state, created_at DESC
        )
        WHERE claim_fingerprint IS NOT NULL;

      CREATE INDEX IF NOT EXISTS conversation_turns_reflection_window_idx
        ON conversation_turns(
          user_id, namespace, occurred_at ASC, id ASC
        )
        WHERE role = 'user';

      PRAGMA user_version = 29;
      `);
}
