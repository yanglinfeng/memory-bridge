/**
 * v7 · 全文索引 FTS 与 ANN 索引及触发器
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
export function applyV7(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
      USING fts5(
        memory_id UNINDEXED,
        user_id UNINDEXED,
        namespace UNINDEXED,
        kind UNINDEXED,
        title,
        content,
        summary,
        tags,
        tokenize = 'trigram'
      );

      CREATE TRIGGER IF NOT EXISTS memories_fts_insert
      AFTER INSERT ON memories
      BEGIN
        INSERT INTO memories_fts (
          memory_id, user_id, namespace, kind,
          title, content, summary, tags
        ) VALUES (
          new.id, new.user_id, new.namespace, new.kind,
          new.title, new.content, new.summary, new.tags_json
        );
      END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_update
      AFTER UPDATE ON memories
      BEGIN
        DELETE FROM memories_fts WHERE memory_id = old.id;
        INSERT INTO memories_fts (
          memory_id, user_id, namespace, kind,
          title, content, summary, tags
        ) VALUES (
          new.id, new.user_id, new.namespace, new.kind,
          new.title, new.content, new.summary, new.tags_json
        );
      END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_delete
      AFTER DELETE ON memories
      BEGIN
        DELETE FROM memories_fts WHERE memory_id = old.id;
      END;

      DELETE FROM memories_fts;
      INSERT INTO memories_fts (
        memory_id, user_id, namespace, kind,
        title, content, summary, tags
      )
      SELECT
        id, user_id, namespace, kind,
        title, content, summary, tags_json
      FROM memories;

      CREATE TABLE IF NOT EXISTS memory_ann_index (
        memory_id TEXT NOT NULL
          REFERENCES memories(id) ON DELETE CASCADE,
        index_model TEXT NOT NULL,
        band INTEGER NOT NULL,
        bucket TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(memory_id, index_model, band)
      );

      CREATE INDEX IF NOT EXISTS memory_ann_bucket_idx
        ON memory_ann_index(index_model, band, bucket, memory_id);

      PRAGMA user_version = 7;
      `);
}
