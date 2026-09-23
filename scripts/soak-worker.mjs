import { createHash } from 'node:crypto';
import { CandidateResolver } from '../dist/server/candidate-resolver.js';
import { openDatabase } from '../dist/server/database.js';
import { LifecycleStore } from '../dist/server/lifecycle-store.js';
import { MemoryReflectionService } from '../dist/server/memory-reflection.js';
import { MemoryStore } from '../dist/server/memory-store.js';
import { MemoryWorker } from '../dist/server/memory-worker.js';

const [databasePath, workerId] = process.argv.slice(2);
if (!databasePath || !workerId) {
  throw new Error('soak worker 缺少 databasePath 或 workerId');
}
const killDelayMs = Math.max(
  0,
  Number(process.env.MEMORY_BRIDGE_SOAK_KILL_DELAY_MS) || 0,
);
const reflectionMode =
  process.env.MEMORY_BRIDGE_SOAK_REFLECTION === '1';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function embedding(text) {
  const digest = createHash('sha256').update(text).digest();
  return Float32Array.from(
    { length: 96 },
    (_, index) => (digest[index % digest.length] - 127.5) / 127.5,
  );
}

const ranker = {
  embeddingModel: 'soak-deterministic-embedding-v1',
  rerankModel: 'soak-deterministic-reranker-v1',
  async embed(texts) {
    return texts.map(embedding);
  },
  async rerank(_query, candidates) {
    return candidates.map((candidate) => ({
      id: candidate.id,
      relevant: true,
      confidence: 1,
      reason: 'soak deterministic decision',
    }));
  },
};

const extractor = {
  model: 'soak-deterministic-extractor-v1',
  promptVersion: 'soak-extract-v1',
  extractorId: 'soak-extractor',
  extractorVersion: 'v1',
  async extract(turn) {
    if (
      killDelayMs > 0 &&
      turn.content.includes('SOAK_KILL_TARGET')
    ) {
      send({
        type: 'kill-point',
        workerId,
        turnId: turn.id,
      });
      await delay(killDelayMs);
    }
    await delay(2);
    const match = /soak-session-(\d+)/u.exec(turn.content);
    if (!match) return [];
    const sessionIndex = Number(match[1]);
    const sourceExcerpt =
      `soak-session-${sessionIndex}：` +
      `我长期保持偏好值${sessionIndex}。`;
    return [{
      kind: 'preference',
      subject: '用户',
      predicate: `soak稳定偏好${sessionIndex}`,
      value: `偏好值${sessionIndex}`,
      content: `用户在 soak 会话 ${sessionIndex} 中保持偏好值${sessionIndex}。`,
      confidence: 1,
      importance: 0.9,
      sensitivity: 'normal',
      negated: false,
      scopeType: 'personal',
      scopeKey: 'self',
      sourceExcerpt,
      sourceAuthority: 'direct_user',
    }];
  },
};

const consolidator = {
  handleMemoryChange() {},
  async consolidateScope() {
    return { sentenceCount: 0 };
  },
};

const reflectionProvider = {
  model: 'qwen2.5:14b',
  promptVersion: 'crash-recovery-reflection-v1',
  async reflect() {
    if (reflectionMode && killDelayMs > 0) {
      send({ type: 'reflection-kill-point', workerId });
      await delay(killDelayMs);
    }
    await delay(2);
    return { candidates: [] };
  },
};

const database = openDatabase(databasePath);
const lifecycleStore = new LifecycleStore(database);
const memoryStore = new MemoryStore(database, ranker);
const resolver = new CandidateResolver(
  database,
  lifecycleStore,
  memoryStore,
  { mode: 'auto' },
);
const reflectionService = reflectionMode
  ? new MemoryReflectionService(
      database,
      lifecycleStore,
      extractor,
      reflectionProvider,
      { minNewTurns: 1 },
    )
  : undefined;
const worker = new MemoryWorker(
  lifecycleStore,
  extractor,
  resolver,
  consolidator,
  undefined,
  true,
  memoryStore,
  undefined,
  reflectionService,
);

let stopping = false;
let processed = 0;
let errors = 0;
let candidateCount = 0;
let lastError = null;
let lastReportedActivity = 0;

function send(message) {
  if (process.connected) process.send(message);
}

process.on('message', (message) => {
  if (message?.type === 'stop') stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});

send({ type: 'ready', workerId });

try {
  while (!stopping) {
    try {
      const result = await worker.processNext(workerId);
      if (result.processed) {
        processed += 1;
        candidateCount += result.candidateCount;
      } else {
        await delay(5);
      }
      if (result.error) {
        errors += 1;
        lastError = result.error;
      }
    } catch (error) {
      errors += 1;
      lastError = error instanceof Error
        ? error.message
        : String(error);
      await delay(25);
    }
    const activity = processed + errors;
    if (activity >= lastReportedActivity + 250) {
      lastReportedActivity = activity;
      send({
        type: 'stats',
        workerId,
        processed,
        errors,
        candidateCount,
        lastError,
      });
    }
  }
} finally {
  database.close();
  send({
    type: 'stopped',
    workerId,
    processed,
    errors,
    candidateCount,
    lastError,
  });
  if (process.connected) process.disconnect();
}
