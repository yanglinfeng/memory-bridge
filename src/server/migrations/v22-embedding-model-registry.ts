/**
 * v22 · 向量模型登记表与稠密索引代际/别名重建
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
export function applyV22(context: MigrationContext): void {
  const { database } = context;

  let embeddingsHaveGeneration = hasColumn(
    database,
    'memory_embeddings',
    'generation_id',
  );
  let denseRowsHaveGeneration = hasColumn(
    database,
    'memory_dense_lsh',
    'generation_id',
  );
  if (embeddingsHaveGeneration !== denseRowsHaveGeneration) {
    if (
      embeddingsHaveGeneration &&
      Number(
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM memory_embeddings',
          )
          .get()?.count || 0,
      ) === 0
    ) {
      database.exec(`
          DROP TABLE memory_embeddings;
          CREATE TABLE memory_embeddings (
            memory_id TEXT NOT NULL
              REFERENCES memories(id) ON DELETE CASCADE,
            model TEXT NOT NULL,
            text_hash TEXT NOT NULL,
            dimensions INTEGER NOT NULL CHECK (dimensions > 0),
            generation_key TEXT,
            memory_revision INTEGER NOT NULL DEFAULT 1
              CHECK (memory_revision > 0),
            embedding BLOB NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(memory_id, model)
          );
          `);
      embeddingsHaveGeneration = false;
    }
    if (
      denseRowsHaveGeneration &&
      Number(
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM memory_dense_lsh',
          )
          .get()?.count || 0,
      ) === 0
    ) {
      database.exec(`
          DROP TABLE memory_dense_lsh;
          CREATE TABLE memory_dense_lsh (
            memory_id TEXT NOT NULL
              REFERENCES memories(id) ON DELETE CASCADE,
            embedding_model TEXT NOT NULL,
            index_version TEXT NOT NULL,
            band INTEGER NOT NULL CHECK (band >= 0),
            bucket TEXT NOT NULL,
            text_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            dimensions INTEGER,
            generation_key TEXT,
            memory_revision INTEGER NOT NULL DEFAULT 1
              CHECK (memory_revision > 0),
            PRIMARY KEY(
              memory_id, embedding_model, index_version, band
            )
          );
          `);
      denseRowsHaveGeneration = false;
    }
    if (embeddingsHaveGeneration !== denseRowsHaveGeneration) {
      throw new Error(
        'Dense v22 迁移检测到不完整的 generation_id 表结构',
      );
    }
  }

  database.exec(`
      CREATE TABLE IF NOT EXISTS embedding_model_registry (
        model_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL
          CHECK (length(trim(provider)) > 0),
        model_name TEXT NOT NULL
          CHECK (length(trim(model_name)) > 0),
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
          CHECK (json_valid(metadata_json))
      );

      CREATE INDEX IF NOT EXISTS embedding_model_registry_name_idx
        ON embedding_model_registry(
          provider, model_name, created_at DESC, model_id
        );

      CREATE TABLE IF NOT EXISTS dense_index_generations (
        generation_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL
          REFERENCES embedding_model_registry(model_id)
          ON DELETE RESTRICT,
        embedding_model TEXT NOT NULL
          CHECK (length(trim(embedding_model)) > 0),
        index_version TEXT NOT NULL
          CHECK (length(trim(index_version)) > 0),
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        generation_key TEXT NOT NULL
          CHECK (length(trim(generation_key)) > 0),
        status TEXT NOT NULL
          CHECK (status IN (
            'building', 'ready', 'active', 'retired', 'failed'
          )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ready_at TEXT,
        failure_reason TEXT,
        UNIQUE(model_id, index_version, generation_key)
      );

      CREATE INDEX IF NOT EXISTS dense_index_generations_status_idx
        ON dense_index_generations(
          status, updated_at DESC, generation_id
        );

      CREATE INDEX IF NOT EXISTS dense_index_generations_model_idx
        ON dense_index_generations(
          model_id, index_version, generation_key
        );

      CREATE TABLE IF NOT EXISTS dense_index_aliases (
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        active_generation_id TEXT NOT NULL
          REFERENCES dense_index_generations(generation_id)
          ON DELETE RESTRICT,
        building_generation_id TEXT
          REFERENCES dense_index_generations(generation_id)
          ON DELETE RESTRICT,
        previous_generation_id TEXT
          REFERENCES dense_index_generations(generation_id)
          ON DELETE RESTRICT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, namespace),
        CHECK (
          building_generation_id IS NULL
          OR building_generation_id != active_generation_id
        ),
        CHECK (
          previous_generation_id IS NULL
          OR previous_generation_id != active_generation_id
        ),
        CHECK (
          building_generation_id IS NULL
          OR previous_generation_id IS NULL
          OR building_generation_id != previous_generation_id
        )
      );

      CREATE INDEX IF NOT EXISTS dense_index_aliases_generation_idx
        ON dense_index_aliases(
          active_generation_id,
          building_generation_id,
          previous_generation_id
        );
      `);

  addColumnIfMissing(
    database,
    'memory_jobs',
    'required_model_id',
    `ALTER TABLE memory_jobs
         ADD COLUMN required_model_id TEXT
           REFERENCES embedding_model_registry(model_id)
           ON DELETE RESTRICT`,
  );
  addColumnIfMissing(
    database,
    'memory_jobs',
    'required_generation_id',
    `ALTER TABLE memory_jobs
         ADD COLUMN required_generation_id TEXT
           REFERENCES dense_index_generations(generation_id)
           ON DELETE RESTRICT`,
  );

  if (!embeddingsHaveGeneration) {
    database.exec(`
        INSERT OR IGNORE INTO embedding_model_registry (
          model_id, provider, model_name, created_at, metadata_json
        )
        SELECT
          'legacy-model:' || lower(hex(model_name)),
          'legacy',
          model_name,
          MIN(observed_at),
          '{"migratedFromSchema":21}'
        FROM (
          SELECT
            CASE
              WHEN trim(model) = '' THEN 'legacy-unknown'
              ELSE model
            END AS model_name,
            updated_at AS observed_at
          FROM memory_embeddings
          UNION ALL
          SELECT
            CASE
              WHEN trim(embedding_model) = '' THEN 'legacy-unknown'
              ELSE embedding_model
            END AS model_name,
            updated_at AS observed_at
          FROM memory_dense_lsh
          UNION ALL
          SELECT
            CASE
              WHEN trim(embedding_model) = '' THEN 'legacy-unknown'
              ELSE embedding_model
            END AS model_name,
            probed_at AS observed_at
          FROM dense_index_state
        )
        GROUP BY model_name;

        INSERT OR IGNORE INTO dense_index_generations (
          generation_id, model_id, embedding_model, index_version,
          dimensions, generation_key, status, created_at, updated_at,
          ready_at, failure_reason
        )
        SELECT
          'legacy-generation:' ||
            lower(hex(model_name)) || ':' ||
            lower(hex(index_version)) || ':' ||
            lower(hex(generation_key)),
          'legacy-model:' || lower(hex(model_name)),
          model_name,
          index_version,
          MAX(dimensions),
          generation_key,
          'ready',
          MIN(observed_at),
          MAX(observed_at),
          MAX(observed_at),
          NULL
        FROM (
          SELECT
            CASE
              WHEN trim(embedding_model) = ''
                THEN 'legacy-unknown'
              ELSE embedding_model
            END AS model_name,
            index_version,
            CASE
              WHEN dimensions > 0 THEN dimensions
              ELSE 1
            END AS dimensions,
            COALESCE(NULLIF(generation_key, ''), 'legacy-unknown')
              AS generation_key,
            probed_at AS observed_at
          FROM dense_index_state
          UNION ALL
          SELECT
            CASE
              WHEN trim(embedding_model) = ''
                THEN 'legacy-unknown'
              ELSE embedding_model
            END AS model_name,
            index_version,
            CASE
              WHEN dimensions > 0 THEN dimensions
              ELSE 1
            END AS dimensions,
            COALESCE(NULLIF(generation_key, ''), 'legacy-unknown')
              AS generation_key,
            updated_at AS observed_at
          FROM memory_dense_lsh
          UNION ALL
          SELECT
            CASE
              WHEN trim(e.model) = '' THEN 'legacy-unknown'
              ELSE e.model
            END AS model_name,
            COALESCE(
              (
                SELECT s.index_version
                FROM dense_index_state s
                WHERE s.embedding_model = e.model
                  AND COALESCE(
                    NULLIF(s.generation_key, ''),
                    'legacy-unknown'
                  ) = COALESCE(
                    NULLIF(e.generation_key, ''),
                    'legacy-unknown'
                  )
                ORDER BY s.probed_at DESC, s.index_version ASC
                LIMIT 1
              ),
              'dense-sign-lsh-v1'
            ) AS index_version,
            CASE
              WHEN e.dimensions > 0 THEN e.dimensions
              ELSE 1
            END AS dimensions,
            COALESCE(
              NULLIF(e.generation_key, ''),
              'legacy-unknown'
            ) AS generation_key,
            e.updated_at AS observed_at
          FROM memory_embeddings e
        )
        GROUP BY model_name, index_version, generation_key;

        CREATE TABLE memory_embeddings_v22 (
          memory_id TEXT NOT NULL
            REFERENCES memories(id) ON DELETE CASCADE,
          generation_id TEXT NOT NULL
            REFERENCES dense_index_generations(generation_id)
            ON DELETE CASCADE,
          model TEXT NOT NULL,
          text_hash TEXT NOT NULL,
          dimensions INTEGER NOT NULL CHECK (dimensions > 0),
          generation_key TEXT NOT NULL,
          memory_revision INTEGER NOT NULL DEFAULT 1
            CHECK (memory_revision > 0),
          embedding BLOB NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(memory_id, generation_id)
        );

        INSERT INTO memory_embeddings_v22 (
          memory_id, generation_id, model, text_hash, dimensions,
          generation_key, memory_revision, embedding, updated_at
        )
        SELECT
          e.memory_id,
          'legacy-generation:' ||
            lower(hex(
              CASE
                WHEN trim(e.model) = '' THEN 'legacy-unknown'
                ELSE e.model
              END
            )) || ':' ||
            lower(hex(
              COALESCE(
                (
                  SELECT s.index_version
                  FROM dense_index_state s
                  WHERE s.embedding_model = e.model
                    AND COALESCE(
                      NULLIF(s.generation_key, ''),
                      'legacy-unknown'
                    ) = COALESCE(
                      NULLIF(e.generation_key, ''),
                      'legacy-unknown'
                    )
                  ORDER BY s.probed_at DESC, s.index_version ASC
                  LIMIT 1
                ),
                'dense-sign-lsh-v1'
              )
            )) || ':' ||
            lower(hex(
              COALESCE(
                NULLIF(e.generation_key, ''),
                'legacy-unknown'
              )
            )),
          e.model,
          e.text_hash,
          e.dimensions,
          COALESCE(
            NULLIF(e.generation_key, ''),
            'legacy-unknown'
          ),
          e.memory_revision,
          e.embedding,
          e.updated_at
        FROM memory_embeddings e;

        DROP TABLE memory_embeddings;
        ALTER TABLE memory_embeddings_v22 RENAME TO memory_embeddings;

        CREATE INDEX memory_embeddings_model_idx
          ON memory_embeddings(
            model, generation_id, updated_at DESC, memory_id
          );
        CREATE INDEX memory_embeddings_generation_idx
          ON memory_embeddings(
            generation_id, memory_revision, updated_at, memory_id
          );

        CREATE TABLE memory_dense_lsh_v22 (
          memory_id TEXT NOT NULL
            REFERENCES memories(id) ON DELETE CASCADE,
          generation_id TEXT NOT NULL
            REFERENCES dense_index_generations(generation_id)
            ON DELETE CASCADE,
          embedding_model TEXT NOT NULL,
          index_version TEXT NOT NULL,
          band INTEGER NOT NULL CHECK (band >= 0),
          bucket TEXT NOT NULL,
          text_hash TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          dimensions INTEGER NOT NULL CHECK (dimensions > 0),
          generation_key TEXT NOT NULL,
          memory_revision INTEGER NOT NULL DEFAULT 1
            CHECK (memory_revision > 0),
          PRIMARY KEY(memory_id, generation_id, band)
        );

        INSERT INTO memory_dense_lsh_v22 (
          memory_id, generation_id, embedding_model, index_version,
          band, bucket, text_hash, updated_at, dimensions,
          generation_key, memory_revision
        )
        SELECT
          d.memory_id,
          'legacy-generation:' ||
            lower(hex(
              CASE
                WHEN trim(d.embedding_model) = ''
                  THEN 'legacy-unknown'
                ELSE d.embedding_model
              END
            )) || ':' ||
            lower(hex(d.index_version)) || ':' ||
            lower(hex(
              COALESCE(
                NULLIF(d.generation_key, ''),
                'legacy-unknown'
              )
            )),
          d.embedding_model,
          d.index_version,
          d.band,
          d.bucket,
          d.text_hash,
          d.updated_at,
          CASE
            WHEN d.dimensions > 0 THEN d.dimensions
            ELSE 1
          END,
          COALESCE(
            NULLIF(d.generation_key, ''),
            'legacy-unknown'
          ),
          d.memory_revision
        FROM memory_dense_lsh d;

        DROP TABLE memory_dense_lsh;
        ALTER TABLE memory_dense_lsh_v22 RENAME TO memory_dense_lsh;

        CREATE INDEX memory_dense_lsh_bucket_idx
          ON memory_dense_lsh(
            generation_id, band, bucket, memory_id
          );
        CREATE INDEX memory_dense_lsh_watermark_idx
          ON memory_dense_lsh(
            generation_id, updated_at, memory_id
          );
        CREATE INDEX memory_dense_lsh_generation_idx
          ON memory_dense_lsh(
            embedding_model, index_version, generation_id,
            dimensions, updated_at, memory_id
          );
        CREATE INDEX memory_dense_lsh_generation_key_idx
          ON memory_dense_lsh(
            embedding_model, index_version, generation_key,
            generation_id, dimensions, band, bucket, memory_id
          );
        CREATE INDEX memory_dense_lsh_revision_idx
          ON memory_dense_lsh(
            memory_id, generation_id, memory_revision, band
          );

        WITH indexed_generations AS (
          SELECT
            memory_id, generation_id, MAX(updated_at) AS updated_at
          FROM memory_dense_lsh
          GROUP BY memory_id, generation_id
          UNION
          SELECT
            memory_id, generation_id, updated_at
          FROM memory_embeddings
        ),
        scoped_generations AS (
          SELECT
            m.user_id,
            m.namespace,
            i.generation_id,
            COUNT(DISTINCT i.memory_id) AS covered,
            MAX(i.updated_at) AS indexed_at
          FROM indexed_generations i
          JOIN memories m ON m.id = i.memory_id
          GROUP BY m.user_id, m.namespace, i.generation_id
        ),
        ranked_generations AS (
          SELECT
            user_id,
            namespace,
            generation_id,
            indexed_at,
            ROW_NUMBER() OVER (
              PARTITION BY user_id, namespace
              ORDER BY
                covered DESC,
                indexed_at DESC,
                generation_id ASC
            ) AS rank
          FROM scoped_generations
        )
        INSERT OR IGNORE INTO dense_index_aliases (
          user_id, namespace, active_generation_id,
          building_generation_id, previous_generation_id,
          revision, updated_at
        )
        SELECT
          user_id,
          namespace,
          generation_id,
          NULL,
          NULL,
          1,
          indexed_at
        FROM ranked_generations
        WHERE rank = 1;

        UPDATE dense_index_generations
        SET status = 'active',
            updated_at = COALESCE(ready_at, updated_at)
        WHERE generation_id IN (
          SELECT active_generation_id
          FROM dense_index_aliases
        );
        `);
  } else {
    database.exec(`
        CREATE INDEX IF NOT EXISTS memory_embeddings_model_idx
          ON memory_embeddings(
            model, generation_id, updated_at DESC, memory_id
          );
        CREATE INDEX IF NOT EXISTS memory_embeddings_generation_idx
          ON memory_embeddings(
            generation_id, memory_revision, updated_at, memory_id
          );
        CREATE INDEX IF NOT EXISTS memory_dense_lsh_bucket_idx
          ON memory_dense_lsh(
            generation_id, band, bucket, memory_id
          );
        CREATE INDEX IF NOT EXISTS memory_dense_lsh_watermark_idx
          ON memory_dense_lsh(
            generation_id, updated_at, memory_id
          );
        CREATE INDEX IF NOT EXISTS memory_dense_lsh_generation_idx
          ON memory_dense_lsh(
            embedding_model, index_version, generation_id,
            dimensions, updated_at, memory_id
          );
        CREATE INDEX IF NOT EXISTS memory_dense_lsh_generation_key_idx
          ON memory_dense_lsh(
            embedding_model, index_version, generation_key,
            generation_id, dimensions, band, bucket, memory_id
          );
        CREATE INDEX IF NOT EXISTS memory_dense_lsh_revision_idx
          ON memory_dense_lsh(
            memory_id, generation_id, memory_revision, band
          );
        `);
  }

  database.exec(`
      CREATE INDEX IF NOT EXISTS memory_jobs_affinity_idx
        ON memory_jobs(
          status, job_type, required_model_id,
          required_generation_id, priority DESC, available_at ASC
        );

      PRAGMA user_version = 22;
      `);
}
