/**
 * v37 · 会话片段、模式观察与摘要表
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
export function applyV37(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_episodes (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL UNIQUE
          REFERENCES memories(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        session_id TEXT NOT NULL
          REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        user_turn_id TEXT NOT NULL UNIQUE
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        assistant_turn_id TEXT NOT NULL UNIQUE
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        scope_type TEXT NOT NULL
          CHECK (scope_type IN ('personal', 'project', 'role', 'session')),
        scope_key TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'archived', 'deleted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, namespace, user_turn_id, assistant_turn_id)
      );

      CREATE INDEX IF NOT EXISTS conversation_episodes_owner_time_idx
        ON conversation_episodes(
          user_id, namespace, scope_type, scope_key,
          status, occurred_at DESC
        );
      CREATE INDEX IF NOT EXISTS conversation_episodes_session_idx
        ON conversation_episodes(session_id, occurred_at ASC);

      CREATE TABLE IF NOT EXISTS conversation_episode_turns (
        episode_id TEXT NOT NULL
          REFERENCES conversation_episodes(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        ordinal INTEGER NOT NULL CHECK (ordinal IN (0, 1)),
        content_hash TEXT NOT NULL,
        PRIMARY KEY(episode_id, turn_id),
        UNIQUE(episode_id, ordinal)
      );

      CREATE INDEX IF NOT EXISTS conversation_episode_turns_turn_idx
        ON conversation_episode_turns(turn_id, episode_id);

      CREATE TABLE IF NOT EXISTS memory_pattern_observations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        scope_type TEXT NOT NULL
          CHECK (scope_type IN ('personal', 'project', 'role', 'session')),
        scope_key TEXT NOT NULL,
        claim_fingerprint TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        value_text TEXT NOT NULL,
        negated INTEGER NOT NULL DEFAULT 0 CHECK (negated IN (0, 1)),
        turn_id TEXT NOT NULL
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL
          REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        excerpt TEXT NOT NULL,
        excerpt_hash TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        observation_state TEXT NOT NULL DEFAULT 'supporting'
          CHECK (observation_state IN (
            'supporting', 'contradicting', 'superseded', 'blocked'
          )),
        first_run_id TEXT
          REFERENCES memory_reflection_runs(id) ON DELETE SET NULL,
        last_run_id TEXT
          REFERENCES memory_reflection_runs(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(
          user_id, namespace, scope_type, scope_key,
          claim_fingerprint, turn_id
        )
      );

      CREATE INDEX IF NOT EXISTS memory_pattern_observations_claim_idx
        ON memory_pattern_observations(
          user_id, namespace, scope_type, scope_key,
          claim_fingerprint, observation_state, occurred_at ASC
        );
      CREATE INDEX IF NOT EXISTS memory_pattern_observations_turn_idx
        ON memory_pattern_observations(turn_id, claim_fingerprint);

      CREATE TABLE IF NOT EXISTS conversation_memory_summaries (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL UNIQUE
          REFERENCES memories(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        summary_type TEXT NOT NULL
          CHECK (summary_type IN ('session', 'day', 'week')),
        bucket_key TEXT NOT NULL,
        scope_type TEXT NOT NULL
          CHECK (scope_type IN ('personal', 'project', 'role', 'session')),
        scope_key TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        source_count INTEGER NOT NULL CHECK (source_count > 0),
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'superseded', 'quarantined', 'deleted')),
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(
          user_id, namespace, summary_type, bucket_key,
          scope_type, scope_key, source_fingerprint
        )
      );

      CREATE INDEX IF NOT EXISTS conversation_memory_summaries_scope_idx
        ON conversation_memory_summaries(
          user_id, namespace, summary_type, scope_type,
          scope_key, bucket_key DESC, status
        );

      CREATE TABLE IF NOT EXISTS conversation_memory_summary_sources (
        summary_id TEXT NOT NULL
          REFERENCES conversation_memory_summaries(id) ON DELETE CASCADE,
        episode_id TEXT NOT NULL
          REFERENCES conversation_episodes(id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        PRIMARY KEY(summary_id, episode_id),
        UNIQUE(summary_id, ordinal)
      );

      CREATE INDEX IF NOT EXISTS conversation_memory_summary_sources_source_idx
        ON conversation_memory_summary_sources(episode_id, summary_id);

      CREATE INDEX IF NOT EXISTS memory_evidence_turn_version_idx
        ON memory_evidence(turn_id, memory_version_id);

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
  database.exec('PRAGMA user_version = 37;');
}
