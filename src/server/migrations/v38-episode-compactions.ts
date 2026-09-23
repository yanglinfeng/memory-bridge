/**
 * v38 · 片段压缩表
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import {
  V32_CONVERSATION_TRIGGERS,
  V33_CONVERSATION_ROUND_TRIGGERS,
  V35_CONVERSATION_REGENERATION_TRIGGERS,
  V36_CONVERSATION_DELETION_TRIGGERS,
  V38_MEMORY_EVENT_CONSOLIDATION_TRIGGER,
} from '../schema-sql.js';
export function applyV38(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_episode_compactions (
        episode_id TEXT PRIMARY KEY
          REFERENCES conversation_episodes(id) ON DELETE CASCADE,
        memory_id TEXT NOT NULL UNIQUE
          REFERENCES memories(id) ON DELETE CASCADE,
        summary_id TEXT
          REFERENCES conversation_memory_summaries(id) ON DELETE SET NULL,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        compacted_at TEXT NOT NULL,
        last_verified_at TEXT NOT NULL,
        removed_embedding_rows INTEGER NOT NULL DEFAULT 0,
        removed_dense_rows INTEGER NOT NULL DEFAULT 0,
        removed_ann_rows INTEGER NOT NULL DEFAULT 0,
        removed_term_rows INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS conversation_episode_compactions_owner_idx
        ON conversation_episode_compactions(
          user_id, namespace, compacted_at ASC, episode_id
        );

      UPDATE memory_jobs
      SET status = 'completed',
          lease_until = NULL,
          lease_owner = NULL,
          last_error = 'reflection_run_already_terminal',
          updated_at = COALESCE(
            (
              SELECT completed_at
              FROM memory_reflection_runs run
              WHERE run.id = json_extract(
                memory_jobs.payload_json,
                '$.runId'
              )
            ),
            updated_at
          )
      WHERE job_type IN (
          'reflect_turn_window',
          'reextract_turn_window'
        )
        AND status IN ('pending', 'failed')
        AND EXISTS (
          SELECT 1
          FROM memory_reflection_runs run
          WHERE run.id = json_extract(
              memory_jobs.payload_json,
              '$.runId'
            )
            AND run.status IN ('completed', 'partial', 'cancelled')
        );

      UPDATE memory_jobs AS older
      SET status = 'completed',
          lease_until = NULL,
          lease_owner = NULL,
          last_error = 'coalesced_during_schema38_migration',
          updated_at = COALESCE(
            (
              SELECT newer.updated_at
              FROM memory_jobs newer
              WHERE newer.job_type = 'consolidate_memory_change'
                AND newer.user_id = older.user_id
                AND newer.namespace = older.namespace
                AND json_extract(newer.payload_json, '$.memoryId') =
                  json_extract(older.payload_json, '$.memoryId')
                AND newer.status IN ('pending', 'failed', 'running')
                AND (
                  newer.created_at > older.created_at
                  OR (
                    newer.created_at = older.created_at
                    AND newer.id > older.id
                  )
                )
              ORDER BY newer.created_at DESC, newer.id DESC
              LIMIT 1
            ),
            older.updated_at
          )
      WHERE older.job_type = 'consolidate_memory_change'
        AND older.status IN ('pending', 'failed')
        AND EXISTS (
          SELECT 1
          FROM memory_jobs newer
          WHERE newer.job_type = 'consolidate_memory_change'
            AND newer.user_id = older.user_id
            AND newer.namespace = older.namespace
            AND json_extract(newer.payload_json, '$.memoryId') =
              json_extract(older.payload_json, '$.memoryId')
            AND newer.status IN ('pending', 'failed', 'running')
            AND (
              newer.created_at > older.created_at
              OR (
                newer.created_at = older.created_at
                AND newer.id > older.id
              )
            )
        );
      `);
  database.exec('DROP TRIGGER IF EXISTS memory_event_consolidation_job;');
  database.exec(V38_MEMORY_EVENT_CONSOLIDATION_TRIGGER);
  for (const trigger of V32_CONVERSATION_TRIGGERS) {
    database.exec(trigger.sql);
  }
  for (const trigger of V33_CONVERSATION_ROUND_TRIGGERS) {
    database.exec(trigger.sql);
  }
  for (const trigger of V35_CONVERSATION_REGENERATION_TRIGGERS) {
    database.exec(trigger.sql);
  }
  for (const trigger of V36_CONVERSATION_DELETION_TRIGGERS) {
    database.exec(trigger.sql);
  }
  database.exec('PRAGMA user_version = 38;');
}
