/**
 * v27 · 检索 trace 与反馈样本表
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
export function applyV27(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      CREATE TABLE IF NOT EXISTS retrieval_traces (
        trace_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        scope_summary_json TEXT NOT NULL DEFAULT '[]',
        log_mode TEXT NOT NULL
          CHECK (log_mode IN ('metadata', 'diagnostic')),
        query_hash TEXT NOT NULL,
        query_text TEXT,
        request_json TEXT NOT NULL DEFAULT '{}',
        quality_state TEXT
          CHECK (
            quality_state IS NULL OR
            quality_state IN ('full', 'degraded', 'unavailable')
          ),
        result_count INTEGER NOT NULL DEFAULT 0
          CHECK (result_count >= 0),
        total_duration_ms REAL,
        error_code TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS retrieval_traces_user_created_idx
        ON retrieval_traces(user_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS retrieval_traces_scope_created_idx
        ON retrieval_traces(user_id, namespace, started_at DESC);
      CREATE INDEX IF NOT EXISTS retrieval_traces_quality_idx
        ON retrieval_traces(user_id, quality_state, started_at DESC);

      CREATE TABLE IF NOT EXISTS retrieval_trace_events (
        trace_id TEXT NOT NULL
          REFERENCES retrieval_traces(trace_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        stage TEXT NOT NULL
          CHECK (stage IN (
            'request', 'rewrite', 'channels', 'fusion', 'semantic',
            'rerank', 'selection', 'context', 'result'
          )),
        event_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        PRIMARY KEY (trace_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS retrieval_trace_events_stage_idx
        ON retrieval_trace_events(stage, created_at DESC);

      CREATE TABLE IF NOT EXISTS retrieval_feedback_examples (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        trace_id TEXT
          REFERENCES retrieval_traces(trace_id) ON DELETE SET NULL,
        memory_id TEXT
          REFERENCES memory_items(id) ON DELETE SET NULL,
        feedback TEXT NOT NULL
          CHECK (feedback IN ('used', 'confirmed', 'rejected')),
        query_hash TEXT NOT NULL,
        query_text TEXT,
        candidate_rank INTEGER,
        candidate_score REAL,
        features_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS retrieval_feedback_user_created_idx
        ON retrieval_feedback_examples(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS retrieval_feedback_trace_idx
        ON retrieval_feedback_examples(user_id, trace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS retrieval_feedback_memory_idx
        ON retrieval_feedback_examples(user_id, memory_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS retrieval_log_state (
        user_id TEXT PRIMARY KEY,
        last_success_at TEXT,
        last_failure_at TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0
          CHECK (consecutive_failures >= 0),
        total_failures INTEGER NOT NULL DEFAULT 0
          CHECK (total_failures >= 0),
        last_error TEXT,
        jsonl_path TEXT
      );

      PRAGMA user_version = 27;
      `);
}
