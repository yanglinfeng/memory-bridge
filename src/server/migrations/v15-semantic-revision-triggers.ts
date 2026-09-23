/**
 * v15 · 语义修订戳触发器
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import { addColumnIfMissing } from '../sqlite-schema-helpers.js';
export function applyV15(context: MigrationContext): void {
  const { database } = context;

  addColumnIfMissing(
    database,
    'memories',
    'semantic_revision',
    `ALTER TABLE memories
         ADD COLUMN semantic_revision INTEGER NOT NULL DEFAULT 1
           CHECK (semantic_revision > 0)`,
  );
  addColumnIfMissing(
    database,
    'memory_embeddings',
    'memory_revision',
    `ALTER TABLE memory_embeddings
         ADD COLUMN memory_revision INTEGER NOT NULL DEFAULT 1
           CHECK (memory_revision > 0)`,
  );
  addColumnIfMissing(
    database,
    'memory_dense_lsh',
    'memory_revision',
    `ALTER TABLE memory_dense_lsh
         ADD COLUMN memory_revision INTEGER NOT NULL DEFAULT 1
           CHECK (memory_revision > 0)`,
  );
  database.exec(`
      UPDATE memory_embeddings
      SET memory_revision = COALESCE(
        (
          SELECT m.semantic_revision
          FROM memories m
          WHERE m.id = memory_embeddings.memory_id
        ),
        1
      );

      UPDATE memory_dense_lsh
      SET memory_revision = COALESCE(
        (
          SELECT m.semantic_revision
          FROM memories m
          WHERE m.id = memory_dense_lsh.memory_id
        ),
        1
      );

      DROP TRIGGER IF EXISTS memories_semantic_revision_au;
      CREATE TRIGGER memories_semantic_revision_au
      AFTER UPDATE OF title, content, summary, tags_json ON memories
      FOR EACH ROW
      BEGIN
        UPDATE memories
        SET semantic_revision = OLD.semantic_revision + 1
        WHERE id = NEW.id;
      END;

      CREATE INDEX IF NOT EXISTS memory_dense_lsh_revision_idx
        ON memory_dense_lsh(
          memory_id,
          embedding_model,
          index_version,
          dimensions,
          generation_key,
          memory_revision,
          band
        );

      PRAGMA user_version = 15;
      `);
}
