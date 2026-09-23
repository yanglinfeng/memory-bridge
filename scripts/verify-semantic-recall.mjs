import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../dist/server/database.js';
import { MemoryStore } from '../dist/server/memory-store.js';
import { OllamaSemanticRanker } from '../dist/server/semantic-ranker.js';
import { semanticQualityCases as cases } from './semantic-quality-cases.mjs';

const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'memory-bridge-real-semantic-'),
);
const database = openDatabase(
  path.join(directory, 'memory-bridge.sqlite3'),
);
const semanticClient = new OllamaSemanticRanker({
  baseUrl:
    process.env.MEMORY_BRIDGE_OLLAMA_URL ||
    'http://127.0.0.1:11434',
  embeddingModel:
    process.env.MEMORY_BRIDGE_EMBED_MODEL || 'bge-m3:latest',
  rerankModel:
    process.env.MEMORY_BRIDGE_RERANK_MODEL || 'qwen2.5:14b',
  embedBatchSize: 64,
  rerankBatchSize: 16,
  timeoutMs: 120_000,
});
let lastDecisions = [];
const ranker = {
  embeddingModel: semanticClient.embeddingModel,
  rerankModel: semanticClient.rerankModel,
  embed: (texts) => semanticClient.embed(texts),
  async rerank(query, candidates) {
    lastDecisions = await semanticClient.rerank(query, candidates);
    return lastDecisions;
  },
};
const store = new MemoryStore(database, ranker);

try {
  let executed = 0;
  for (let index = 0; index < cases.length; index += 1) {
    if (
      process.env.CASE_INDEX !== undefined &&
      Number(process.env.CASE_INDEX) !== index
    ) {
      continue;
    }
    executed += 1;
    const fixture = cases[index];
    const namespace = `qa:${index}`;
    const relevant = store.remember({
      namespace,
      kind: 'preference',
      content: fixture.relevant,
    }).memory;
    const irrelevant = store.remember({
      namespace,
      kind: 'knowledge',
      content: fixture.irrelevant,
      importance: 1,
      confidence: 1,
    }).memory;
    const backfill = await store.backfillDenseIndex(
      64,
      undefined,
      undefined,
      namespace,
    );
    assert.equal(
      backfill.complete,
      true,
      `case ${index} dense precondition failed`,
    );
    lastDecisions = [];
    const recalled = await store.recallReliable({
      namespace,
      query: fixture.query,
      limit: 5,
    });
    assert.deepEqual(
      recalled.map((result) => result.memory.id),
      [relevant.id],
      `case ${index} failed; irrelevant=${irrelevant.id}; decisions=${JSON.stringify(lastDecisions)}`,
    );
    console.log(
      JSON.stringify({
        case: index,
        passed: true,
        query: fixture.query,
        score: recalled[0].score,
      }),
    );
  }
  const cached = database
    .prepare('SELECT COUNT(*) AS count FROM memory_embeddings')
    .get();
  assert.equal(Number(cached?.count), executed * 2);
  console.log(
    JSON.stringify({
      passed: true,
      cases: executed,
      cachedEmbeddings: Number(cached?.count),
    }),
  );
} finally {
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
