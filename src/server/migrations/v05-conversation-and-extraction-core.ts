/**
 * v5 · 会话与提取核心表（sessions/turns/extraction_runs/candidates/items/versions）
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
export function applyV5(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        client_name TEXT NOT NULL,
        external_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(user_id, client_name, external_id)
      );

      CREATE INDEX IF NOT EXISTS conversation_sessions_user_idx
        ON conversation_sessions(user_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL
          REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        external_id TEXT NOT NULL,
        role TEXT NOT NULL
          CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(session_id, external_id)
      );

      CREATE INDEX IF NOT EXISTS conversation_turns_session_idx
        ON conversation_turns(session_id, occurred_at ASC);
      CREATE INDEX IF NOT EXISTS conversation_turns_user_idx
        ON conversation_turns(user_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS conversation_turns_hash_idx
        ON conversation_turns(user_id, content_hash);

      CREATE TABLE IF NOT EXISTS extraction_runs (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        started_at TEXT,
        completed_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(turn_id, model, prompt_version)
      );

      CREATE INDEX IF NOT EXISTS extraction_runs_status_idx
        ON extraction_runs(status, created_at ASC);

      CREATE TABLE IF NOT EXISTS memory_candidates (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        turn_id TEXT
          REFERENCES conversation_turns(id) ON DELETE SET NULL,
        extraction_run_id TEXT
          REFERENCES extraction_runs(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        value_text TEXT NOT NULL,
        normalized_key TEXT NOT NULL,
        normalized_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL
          CHECK (confidence >= 0 AND confidence <= 1),
        importance REAL NOT NULL
          CHECK (importance >= 0 AND importance <= 1),
        sensitivity TEXT NOT NULL DEFAULT 'normal'
          CHECK (sensitivity IN ('normal', 'sensitive', 'credential')),
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN (
            'pending', 'accepted', 'rejected', 'conflicted'
          )),
        decision_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(extraction_run_id, normalized_hash)
      );

      CREATE INDEX IF NOT EXISTS memory_candidates_inbox_idx
        ON memory_candidates(user_id, state, created_at DESC);
      CREATE INDEX IF NOT EXISTS memory_candidates_key_idx
        ON memory_candidates(user_id, namespace, normalized_key);

      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        kind TEXT NOT NULL,
        stable_key TEXT NOT NULL,
        current_version_id TEXT,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN (
            'active', 'superseded', 'archived', 'deleted', 'conflicted'
          )),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, namespace, stable_key)
      );

      CREATE INDEX IF NOT EXISTS memory_items_scope_idx
        ON memory_items(user_id, namespace, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS memory_items_kind_idx
        ON memory_items(user_id, kind, status);

      CREATE TABLE IF NOT EXISTS memory_versions (
        id TEXT PRIMARY KEY,
        memory_item_id TEXT NOT NULL
          REFERENCES memory_items(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version > 0),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL
          CHECK (importance >= 0 AND importance <= 1),
        confidence REAL NOT NULL
          CHECK (confidence >= 0 AND confidence <= 1),
        source TEXT NOT NULL,
        source_ref TEXT,
        occurred_at TEXT,
        valid_from TEXT,
        valid_to TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(memory_item_id, version)
      );

      CREATE INDEX IF NOT EXISTS memory_versions_item_idx
        ON memory_versions(memory_item_id, version DESC);

      CREATE TABLE IF NOT EXISTS memory_evidence (
        id TEXT PRIMARY KEY,
        memory_version_id TEXT NOT NULL
          REFERENCES memory_versions(id) ON DELETE CASCADE,
        turn_id TEXT
          REFERENCES conversation_turns(id) ON DELETE SET NULL,
        evidence_type TEXT NOT NULL,
        excerpt TEXT,
        source_ref TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS memory_evidence_version_idx
        ON memory_evidence(memory_version_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS memory_evidence_turn_version_idx
        ON memory_evidence(turn_id, memory_version_id);

      CREATE TABLE IF NOT EXISTS memory_edges (
        id TEXT PRIMARY KEY,
        from_memory_item_id TEXT NOT NULL
          REFERENCES memory_items(id) ON DELETE CASCADE,
        to_memory_item_id TEXT NOT NULL
          REFERENCES memory_items(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(
          from_memory_item_id,
          to_memory_item_id,
          relation_type
        )
      );

      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        memory_item_id TEXT
          REFERENCES memory_items(id) ON DELETE SET NULL,
        user_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS memory_events_user_idx
        ON memory_events(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS outbox_events (
        id TEXT PRIMARY KEY,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at TEXT NOT NULL,
        lease_until TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        processed_at TEXT,
        UNIQUE(aggregate_type, aggregate_id, event_type)
      );

      CREATE INDEX IF NOT EXISTS outbox_events_ready_idx
        ON outbox_events(status, available_at ASC);

      CREATE TABLE IF NOT EXISTS memory_jobs (
        id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN (
            'pending', 'running', 'completed', 'failed', 'dead'
          )),
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
        available_at TEXT NOT NULL,
        lease_until TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS memory_jobs_ready_idx
        ON memory_jobs(status, priority DESC, available_at ASC);

      CREATE TABLE IF NOT EXISTS dead_letter_jobs (
        job_id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        last_error TEXT NOT NULL,
        failed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS retention_policies (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        kind TEXT,
        evidence_ttl_days INTEGER,
        half_life_days INTEGER,
        auto_archive INTEGER NOT NULL DEFAULT 1
          CHECK (auto_archive IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, namespace, kind)
      );

      CREATE TABLE IF NOT EXISTS memory_tombstones (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        stable_key TEXT,
        content_hash TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        restored_at TEXT,
        CHECK (stable_key IS NOT NULL OR content_hash IS NOT NULL)
      );

      CREATE INDEX IF NOT EXISTS memory_tombstones_lookup_idx
        ON memory_tombstones(
          user_id,
          namespace,
          stable_key,
          content_hash,
          restored_at
        );

      INSERT OR IGNORE INTO memory_items (
        id, user_id, namespace, kind, stable_key, current_version_id,
        status, revision, created_at, updated_at
      )
      SELECT
        id, user_id, namespace, kind, 'legacy:' || id, id || ':v1',
        status, 1, created_at, updated_at
      FROM memories;

      INSERT OR IGNORE INTO memory_versions (
        id, memory_item_id, version, title, content, summary, tags_json,
        importance, confidence, source, source_ref, occurred_at,
        valid_from, valid_to, created_by, created_at
      )
      SELECT
        id || ':v1', id, 1, title, content, summary, tags_json,
        importance, confidence, source, source_ref, occurred_at,
        valid_from, valid_to, 'legacy-migration', created_at
      FROM memories;

      INSERT OR IGNORE INTO memory_edges (
        id, from_memory_item_id, to_memory_item_id, relation_type,
        created_at
      )
      SELECT
        'legacy-relation:' || id,
        from_memory_id,
        to_memory_id,
        relation_type,
        created_at
      FROM memory_relations;

      INSERT OR IGNORE INTO memory_events (
        id, memory_item_id, user_id, event_type, payload_json, created_at
      )
      SELECT
        id || ':event:v1',
        id,
        user_id,
        'legacy_imported',
        '{"source":"memories"}',
        created_at
      FROM memories;

      PRAGMA user_version = 5;
      `);
}
