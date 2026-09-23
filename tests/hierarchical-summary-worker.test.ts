import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { EpisodicMemoryService } from '../src/server/episodic-memory-service.js';
import type {
  HierarchicalSummaryService,
} from '../src/server/hierarchical-summary-service.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import type { MemoryExtractor } from '../src/server/memory-extractor.js';
import { MemoryWorker } from '../src/server/memory-worker.js';
import { resetModelQosForTests } from '../src/server/model-qos.js';

function createFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-summary-worker-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const lifecycle = new LifecycleStore(
    database,
    () => new Date('2026-08-13T00:00:00.000Z'),
  );
  const extractor: MemoryExtractor = {
    extractorId: 'summary-worker-test',
    extractorVersion: '1',
    model: 'qwen2.5:14b',
    promptVersion: 'summary-worker-test-v1',
    async extract() {
      throw new Error('摘要任务不得调用记忆提取器');
    },
  };
  return {
    database,
    lifecycle,
    extractor,
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
      resetModelQosForTests();
    },
  };
}

function enqueueSummary(lifecycle: LifecycleStore, id: string) {
  return lifecycle.enqueueJob({
    id,
    jobType: 'summarize_memory_bucket',
    userId: 'alice',
    namespace: 'personal',
    payload: {
      userId: 'alice',
      namespace: 'personal',
      summaryType: 'day',
      bucketKey: '2026-08-13',
      scopeType: 'role',
      scopeKey: 'role-a',
      timezoneOffsetMinutes: 480,
    },
    maxAttempts: 5,
  });
}

function worker(
  fixture: ReturnType<typeof createFixture>,
  service: Pick<HierarchicalSummaryService, 'summarizeBucket'>,
) {
  return new MemoryWorker(
    fixture.lifecycle,
    fixture.extractor,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    service as HierarchicalSummaryService,
  );
}

test('层级摘要遵守后台 QoS，完成时记录 fingerprint、耗时与状态', async () => {
  resetModelQosForTests();
  const fixture = createFixture();
  let calls = 0;
  try {
    enqueueSummary(fixture.lifecycle, 'summary-day-success');
    const summaryWorker = worker(fixture, {
      async summarizeBucket(input) {
        calls += 1;
        assert.deepEqual(input, {
          userId: 'alice',
          namespace: 'personal',
          summaryType: 'day',
          bucketKey: '2026-08-13',
          scopeType: 'role',
          scopeKey: 'role-a',
          timezoneOffsetMinutes: 480,
        });
        return {
          status: 'created',
          summaryId: 'summary-a',
          memoryId: 'memory-a',
          sourceCount: 3,
          sentenceCount: 2,
          sourceFingerprint: 'source-fingerprint-a',
        };
      },
    });

    const deferred = await summaryWorker.processNext('summary-worker', {
      backgroundModelAllowed: false,
    });
    assert.equal(deferred.job, null);
    assert.equal(calls, 0);
    assert.equal(
      fixture.lifecycle.getJob('summary-day-success')?.status,
      'pending',
    );

    const completed = await summaryWorker.processNext('summary-worker', {
      backgroundModelAllowed: true,
    });
    assert.equal(completed.job?.jobType, 'summarize_memory_bucket');
    assert.equal(completed.job?.status, 'completed');
    assert.equal(completed.candidateCount, 2);
    assert.equal(calls, 1);

    const row = fixture.database.prepare(
      `SELECT detail_json FROM audit_log
       WHERE action = 'job_attempt_completed'
         AND json_extract(detail_json, '$.jobId') = ?
       ORDER BY id DESC LIMIT 1`,
    ).get('summary-day-success') as { detail_json?: string } | undefined;
    const detail = JSON.parse(row?.detail_json || '{}') as
      Record<string, unknown>;
    assert.match(String(detail.inputFingerprint), /^[a-f0-9]{64}$/u);
    assert.match(String(detail.outputFingerprint), /^[a-f0-9]{64}$/u);
    assert.equal(detail.resultStatus, 'created');
    assert.ok(Number(detail.modelDurationMs) >= 0);
  } finally {
    fixture.close();
  }
});

test('层级摘要 provider 失败进入可重试 failed，不被误记为完成', async () => {
  resetModelQosForTests();
  const fixture = createFixture();
  try {
    enqueueSummary(fixture.lifecycle, 'summary-day-failed');
    const result = await worker(fixture, {
      async summarizeBucket() {
        return {
          status: 'failed',
          summaryId: null,
          memoryId: null,
          sourceCount: 3,
          sentenceCount: 0,
          sourceFingerprint: 'source-fingerprint-failed',
          errorCode: 'provider_failed',
        };
      },
    }).processNext('summary-worker-failure', {
      backgroundModelAllowed: true,
    });

    assert.equal(result.job?.status, 'failed');
    assert.equal(result.job?.attempts, 1);
    assert.match(result.error || '', /provider 暂时不可用/u);
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM audit_log
         WHERE action = 'job_attempt_completed'
           AND json_extract(detail_json, '$.jobId') = ?`,
      ).get('summary-day-failed')?.count,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('会话先结束、episode 后物化时补排 session/day/week 且重放幂等', async () => {
  resetModelQosForTests();
  const fixture = createFixture();
  try {
    const exchange = fixture.lifecycle.recordCompletedExchange({
      userId: 'alice',
      namespace: 'personal',
      clientName: 'client',
      sessionExternalId: 'ended-before-episode',
      userTurnExternalId: 'ended-before-episode-user',
      userContent: '这是一段跨越本地午夜边界的长期对话。',
      assistantTurnExternalId: 'ended-before-episode-assistant',
      assistantContent: '我会按本地日期整理。',
      occurredAt: '2026-08-12T16:30:00.000Z',
    });
    fixture.lifecycle.endSession(
      'alice',
      'client',
      'ended-before-episode',
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memory_jobs
         WHERE job_type = 'summarize_memory_bucket'`,
      ).get()?.count,
      0,
    );

    const episodic = new EpisodicMemoryService(
      fixture.database,
      () => new Date('2026-08-13T00:00:00.000Z'),
    );
    const episodeWorker = new MemoryWorker(
      fixture.lifecycle,
      fixture.extractor,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      episodic,
    );
    const materialized = await episodeWorker.processNext('episode-worker', {
      backgroundModelAllowed: false,
    });
    assert.equal(materialized.job?.jobType, 'materialize_episode');
    assert.equal(materialized.job?.status, 'completed');

    const jobs = fixture.database.prepare(
      `SELECT payload_json FROM memory_jobs
       WHERE job_type = 'summarize_memory_bucket'
       ORDER BY json_extract(payload_json, '$.summaryType')`,
    ).all() as Array<{ payload_json?: string }>;
    assert.equal(jobs.length, 3);
    const payloads = jobs.map((row) => JSON.parse(row.payload_json || '{}'));
    assert.deepEqual(
      payloads.map((payload) => [payload.summaryType, payload.bucketKey]),
      [
        ['day', '2026-08-13'],
        ['session', exchange.sessionId],
        ['week', '2026-W33'],
      ],
    );
    assert.ok(payloads.every((payload) =>
      payload.timezoneOffsetMinutes === 480 &&
      payload.trigger === 'episode_materialized' &&
      payload.scopeType === 'personal' &&
      payload.scopeKey === 'self',
    ));

    fixture.lifecycle.endSession(
      'alice',
      'client',
      'ended-before-episode',
    );
    fixture.database.prepare(
      `UPDATE memory_jobs
       SET status = 'failed', lease_owner = NULL, lease_until = NULL,
           available_at = '2000-01-01T00:00:00.000Z'
       WHERE job_type = 'materialize_episode'`,
    ).run();
    await episodeWorker.processNext('episode-replay-worker', {
      backgroundModelAllowed: false,
    });
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memory_jobs
         WHERE job_type = 'summarize_memory_bucket'`,
      ).get()?.count,
      3,
    );
  } finally {
    fixture.close();
  }
});

test('空闲边界按 episode scope 排 session/day/week，重复 sweep 幂等', () => {
  const fixture = createFixture();
  try {
    const exchange = fixture.lifecycle.recordCompletedExchange({
      userId: 'alice',
      namespace: 'personal',
      clientName: 'client',
      sessionExternalId: 'idle-summary-session',
      userTurnExternalId: 'idle-summary-user',
      userContent: '空闲后请生成长期摘要。',
      assistantTurnExternalId: 'idle-summary-assistant',
      assistantContent: '好的。',
      occurredAt: '2026-08-13T00:00:00.000Z',
    });
    new EpisodicMemoryService(
      fixture.database,
      () => new Date('2026-08-13T00:00:00.000Z'),
    ).materialize({
      userId: 'alice',
      namespace: 'personal',
      userTurnId: exchange.userTurn.id,
      assistantTurnId: exchange.assistantTurn.id,
    });

    const boundary = fixture.lifecycle.runConsolidationSweep({
      at: '2026-08-13T00:15:00.000Z',
      idleMinutes: 15,
    });
    assert.equal(boundary.enqueued, 0);
    assert.equal(boundary.summaryEnqueued, 3);
    assert.equal(
      fixture.lifecycle.runConsolidationSweep({
        at: '2026-08-13T00:15:00.000Z',
        idleMinutes: 15,
      }).summaryEnqueued,
      0,
    );
  } finally {
    fixture.close();
  }
});
