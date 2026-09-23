import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');
const runnerPath = path.join(
  projectRoot,
  'scripts',
  'qa-conversation-long-timeline.mjs',
);
const source = fs.readFileSync(runnerPath, 'utf8');

test('长期会话合同固定为 8 用户且每用户至少 10,000 条', () => {
  assert.match(source, /const USER_COUNT = 8;/u);
  const match = source.match(/const MESSAGES_PER_USER = ([\d_]+);/u);
  assert.ok(match, 'runner 必须声明每用户消息数');
  assert.ok(
    Number(match[1].replaceAll('_', '')) >= 10_000,
    '每用户消息数不得低于 10,000',
  );
  assert.match(source, /const WRITE_CONCURRENCY = 4;/u);
  assert.match(source, /const TIMELINE_DAYS = 180;/u);
});

test('长期会话回执硬性验证角色、时间轴与实际并发', () => {
  for (const gate of [
    'observed-write-concurrency',
    'database-persona-message-counts',
    'database-role-message-counts',
    'database-timeline-coverage',
    'database-timeline-order',
  ]) {
    assert.match(source, new RegExp(`record\\('${gate}'`, 'u'));
  }
});

test('历史反思窗口上限随每用户 user turn 数扩展', () => {
  assert.match(
    source,
    /const REFLECTION_BATCH_LIMIT = Math\.ceil\(\s*USER_TURNS_PER_USER \/ REFLECTION_MAX_TURNS,\s*\) \+ 1;/u,
  );
  assert.doesNotMatch(source, /batch < 20/u);
});

test('长期会话必须通过真实 Worker 将到期 outbox 与 jobs 收敛为零', () => {
  assert.match(source, /new MemoryWorker\(/u);
  assert.match(source, /async function drainToConvergence\(/u);
  assert.match(source, /const CONVERGENCE_MAX_ITERATIONS = [\d_]+;/u);
  assert.match(source, /const CONVERGENCE_TIMEOUT_MS = [\d_]+;/u);
  assert.match(source, /const CONVERGENCE_NO_PROGRESS_TIMEOUT_MS = [\d_]+;/u);
  assert.match(source, /'database-outbox-convergence'/u);
  assert.match(source, /snapshot\.nonFutureOpenOutbox === 0/u);
  assert.doesNotMatch(source, /open outbox is retained workload/u);
  assert.doesNotMatch(
    source,
    /UPDATE\s+(?:outbox_events|memory_jobs)\s+SET\s+status\s*=\s*['"]completed/iu,
    'runner 不得用 SQL 伪造 outbox/job 完成状态',
  );
});

test('长期会话收敛门禁覆盖 episode、FTS、Dense、摘要和 observation', () => {
  for (const gate of [
    'database-episode-convergence',
    'database-fts-convergence',
    'database-dense-convergence',
    'database-summary-convergence',
    'database-observation-convergence',
  ]) {
    assert.match(source, new RegExp(`record\\('${gate}'`, 'u'));
  }
  assert.match(source, /REQUIRED_EMBEDDING_MODEL = 'bge-m3:latest'/u);
  assert.match(source, /function scalePipeline\(/u);
  assert.match(source, /const extractor = deterministicExtractor\(\)/u);
  assert.match(source, /const ranker = deterministicScaleRanker\(\)/u);
  assert.match(
    source,
    /const consolidationProvider = deterministicConsolidationProvider\(\)/u,
  );
});

test('长期会话对至少一万情景执行 FTS P95 150ms 硬门禁', () => {
  assert.match(source, /const FTS_PERFORMANCE_SAMPLES = 200;/u);
  assert.match(source, /const FTS_PERFORMANCE_P95_LIMIT_MS = 150;/u);
  assert.match(source, /function benchmarkEpisodeFts\(/u);
  assert.match(source, /snapshot\.episodeCount >= ftsPerformance\.minimumEpisodeCorpus/u);
  assert.match(source, /ftsPerformance\.latency\.p95Ms < FTS_PERFORMANCE_P95_LIMIT_MS/u);
  assert.match(source, /'database-episode-fts-p95'/u);
});

test('80K 状态机不伪装成逐条 14B，真实模型使用独立有界样本', () => {
  assert.match(source, /fullScaleGenerationProviderCalls: 0/u);
  assert.match(source, /'scale-pipeline-provenance-explicit'/u);
  assert.match(source, /'qwen2\.5-14b-real-reflection-sample'/u);
  assert.match(source, /new OllamaReflectionProvider\(/u);
  assert.doesNotMatch(source, /new OllamaMemoryExtractor\(/u);
  assert.doesNotMatch(source, /new OllamaSemanticRanker\(/u);
  assert.doesNotMatch(source, /new OllamaConsolidationProvider\(/u);
});

test('长期会话健康门禁拒绝失败反思、dead letter 和 unhealthy jobs', () => {
  assert.match(source, /snapshot\.failedReflectionRuns === 0/u);
  assert.match(source, /snapshot\.deadJobs === 0/u);
  assert.match(source, /snapshot\.unhealthyJobs === 0/u);
  assert.match(source, /snapshot\.deadLetterJobs === 0/u);
});

test('长期会话支持严格指纹 resume，并在关闭重开后复验持久一致性', () => {
  assert.match(source, /function validateResumeManifest\(/u);
  assert.match(source, /implementation\.fingerprintSha256/u);
  assert.match(source, /--resume/u);
  assert.match(source, /'database-restart-persistence'/u);
  assert.match(source, /persistenceFingerprint\(/u);
  assert.match(source, /const invokedDirectly =/u);
});

test('收敛失败证据包含状态分布、样本 ID、进度指纹与下一租约时间', () => {
  assert.match(source, /outboxByStatus/u);
  assert.match(source, /jobsByTypeAndStatus/u);
  assert.match(source, /diagnosticSamples/u);
  assert.match(source, /progressFingerprint/u);
  assert.match(source, /nextLeaseOrRetryAt/u);
});
