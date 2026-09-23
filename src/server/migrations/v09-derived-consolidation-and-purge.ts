/**
 * v9 · 派生合并句与物理清除任务
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import { addColumnIfMissing } from '../sqlite-schema-helpers.js';
export function applyV9(context: MigrationContext): void {
  const { database } = context;

  addColumnIfMissing(
    database,
    'memory_items',
    'pinned',
    `ALTER TABLE memory_items
         ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0
           CHECK (pinned IN (0, 1))`,
  );
  addColumnIfMissing(
    database,
    'memory_items',
    'expires_at',
    `ALTER TABLE memory_items
         ADD COLUMN expires_at TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_items',
    'archived_at',
    `ALTER TABLE memory_items
         ADD COLUMN archived_at TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_items',
    'archive_reason',
    `ALTER TABLE memory_items
         ADD COLUMN archive_reason TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_items',
    'retrieved_count',
    `ALTER TABLE memory_items
         ADD COLUMN retrieved_count INTEGER NOT NULL DEFAULT 0
           CHECK (retrieved_count >= 0)`,
  );
  addColumnIfMissing(
    database,
    'memory_items',
    'used_count',
    `ALTER TABLE memory_items
         ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0
           CHECK (used_count >= 0)`,
  );
  addColumnIfMissing(
    database,
    'memory_items',
    'confirmed_count',
    `ALTER TABLE memory_items
         ADD COLUMN confirmed_count INTEGER NOT NULL DEFAULT 0
           CHECK (confirmed_count >= 0)`,
  );
  addColumnIfMissing(
    database,
    'memory_items',
    'rejected_count',
    `ALTER TABLE memory_items
         ADD COLUMN rejected_count INTEGER NOT NULL DEFAULT 0
           CHECK (rejected_count >= 0)`,
  );
  database.exec(`
      CREATE INDEX IF NOT EXISTS memory_items_retention_idx
        ON memory_items(
          user_id,
          namespace,
          status,
          pinned,
          expires_at,
          updated_at
        );

      CREATE TABLE IF NOT EXISTS derived_consolidations (
        id TEXT PRIMARY KEY,
        memory_id TEXT
          REFERENCES memories(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        scope_type TEXT NOT NULL
          CHECK (scope_type IN ('session', 'topic', 'person', 'project')),
        scope_key TEXT NOT NULL,
        source_set_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('active', 'stale', 'quarantined')),
        generated_at TEXT NOT NULL,
        stale_at TEXT,
        last_error TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        UNIQUE(memory_id),
        UNIQUE(
          user_id,
          namespace,
          scope_type,
          scope_key,
          source_set_hash,
          model,
          prompt_version
        )
      );

      CREATE INDEX IF NOT EXISTS derived_consolidations_scope_idx
        ON derived_consolidations(
          user_id,
          namespace,
          scope_type,
          scope_key,
          status,
          generated_at DESC
        );

      CREATE TABLE IF NOT EXISTS derived_consolidation_sources (
        consolidation_id TEXT NOT NULL
          REFERENCES derived_consolidations(id) ON DELETE CASCADE,
        memory_version_id TEXT NOT NULL
          REFERENCES memory_versions(id) ON DELETE CASCADE,
        PRIMARY KEY(consolidation_id, memory_version_id)
      );

      CREATE INDEX IF NOT EXISTS derived_sources_version_idx
        ON derived_consolidation_sources(
          memory_version_id,
          consolidation_id
        );

      CREATE TABLE IF NOT EXISTS derived_consolidation_sentences (
        id TEXT PRIMARY KEY,
        consolidation_id TEXT NOT NULL
          REFERENCES derived_consolidations(id) ON DELETE CASCADE,
        sentence_index INTEGER NOT NULL CHECK (sentence_index >= 0),
        sentence_text TEXT NOT NULL,
        supported INTEGER NOT NULL DEFAULT 1
          CHECK (supported IN (0, 1)),
        UNIQUE(consolidation_id, sentence_index)
      );

      CREATE TABLE IF NOT EXISTS derived_sentence_sources (
        sentence_id TEXT NOT NULL
          REFERENCES derived_consolidation_sentences(id)
          ON DELETE CASCADE,
        memory_version_id TEXT NOT NULL
          REFERENCES memory_versions(id) ON DELETE CASCADE,
        PRIMARY KEY(sentence_id, memory_version_id)
      );

      CREATE INDEX IF NOT EXISTS derived_sentence_source_version_idx
        ON derived_sentence_sources(memory_version_id, sentence_id);

      CREATE TABLE IF NOT EXISTS purge_jobs (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN (
            'pending', 'running', 'completed', 'failed', 'dead'
          )),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
        available_at TEXT NOT NULL,
        lease_until TEXT,
        lease_owner TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS purge_jobs_ready_idx
        ON purge_jobs(status, available_at ASC);

      CREATE TRIGGER IF NOT EXISTS memory_event_consolidation_job
      AFTER INSERT ON memory_events
      WHEN new.memory_item_id IS NOT NULL
        AND new.event_type IN (
          'created',
          'reinforced',
          'corrected',
          'updated',
          'reverted',
          'forgotten',
          'restored',
          'superseded',
          'conflicted'
        )
      BEGIN
        INSERT INTO memory_jobs (
          id,
          job_type,
          user_id,
          namespace,
          payload_json,
          priority,
          max_attempts,
          available_at,
          created_at,
          updated_at
        ) VALUES (
          'consolidate-change:' || new.id,
          'consolidate_memory_change',
          new.user_id,
          COALESCE(
            (
              SELECT namespace
              FROM memory_items
              WHERE id = new.memory_item_id
            ),
            'personal'
          ),
          json_object(
            'memoryId',
            new.memory_item_id,
            'eventId',
            new.id,
            'eventType',
            new.event_type
          ),
          4,
          5,
          new.created_at,
          new.created_at,
          new.created_at
        )
        ON CONFLICT(id) DO NOTHING;
      END;

      PRAGMA user_version = 9;
      `);
}
