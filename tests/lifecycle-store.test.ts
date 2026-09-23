import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/server/database.js';
import {
  deadLetterRecoveryJobId,
  LifecycleStore,
} from '../src/server/lifecycle-store.js';
import { MemoryStore } from '../src/server/memory-store.js';

function createFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-lifecycle-'),
  );
  let current = new Date('2026-07-29T00:00:00.000Z');
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new LifecycleStore(database, () => current);
  return {
    database,
    store,
    advance(milliseconds: number) {
      current = new Date(current.getTime() + milliseconds);
    },
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('会话回合只同步写 outbox，dispatcher 幂等生成提取任务', () => {
  const fixture = createFixture();
  try {
    const input = {
      clientName: 'client',
      sessionExternalId: 'session-1',
      turnExternalId: 'turn-1',
      role: 'user' as const,
      content: '我做应用时不喜欢内置演示数据。',
    };
    const first = fixture.store.recordTurn(input);
    const replayed = fixture.store.recordTurn(input);

    assert.equal(first.created, true);
    assert.equal(replayed.created, false);
    assert.equal(replayed.turn.id, first.turn.id);
    assert.equal(
      fixture.store.listTurns(first.sessionId).length,
      1,
    );
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM outbox_events')
        .get()?.count,
      1,
    );
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM memory_jobs')
        .get()?.count,
      0,
    );
    const dispatched = fixture.store.dispatchNextOutbox('dispatcher-a');
    assert.equal(dispatched.event?.status, 'completed');
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM memory_jobs')
        .get()?.count,
      1,
    );
    fixture.database
      .prepare(
        `UPDATE outbox_events
         SET status = 'failed', available_at = ?, processed_at = NULL`,
      )
      .run('2026-07-29T00:00:00.000Z');
    fixture.store.dispatchNextOutbox('dispatcher-b');
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM memory_jobs')
        .get()?.count,
      1,
    );
    assert.throws(
      () =>
        fixture.store.recordTurn({
          ...input,
          content: '同一个外部 ID 不允许换成另一段内容。',
        }),
      /不同内容/,
    );
  } finally {
    fixture.close();
  }
});

test('会话证据保留原始 Unicode 且 NFKC 等价摘录映射回原文', () => {
  const fixture = createFixture();
  try {
    const content =
      '项目原则变了：新软件第一次打开不再要求空数据，' +
      '今后应该自动导入一套最小示例数据。';
    const recorded = fixture.store.recordTurn({
      clientName: 'client',
      sessionExternalId: 'raw-evidence-session',
      turnExternalId: 'raw-evidence-turn',
      role: 'user',
      content,
    });
    assert.equal(recorded.turn.content, content);

    const runId = fixture.store.startExtraction(
      recorded.turn.id,
      'qwen2.5:14b',
      'extract-v6',
    );
    const candidates = fixture.store.completeExtraction(runId, [{
      kind: 'project',
      subject: '新软件首次打开数据要求',
      predicate: '数据要求',
      value: '自动导入一套最小示例数据',
      content: '新软件首次打开时自动导入一套最小示例数据。',
      confidence: 1,
      importance: 1,
      sensitivity: 'normal',
      scopeType: 'project',
      scopeKey: '新软件首次打开数据要求',
      sourceExcerpt:
        '项目原则变了:新软件第一次打开不再要求空数据,' +
        '今后应该自动导入一套最小示例数据。',
    }]);

    assert.equal(candidates.length, 1);
    assert.equal(
      candidates[0]?.sourceExcerpt,
      '项目原则变了：新软件第一次打开不再要求空数据，' +
        '今后应该自动导入一套最小示例数据。',
    );
    assert.ok(content.includes(candidates[0]?.sourceExcerpt || ''));
  } finally {
    fixture.close();
  }
});

test('任务支持租约、重试和 dead letter', () => {
  const fixture = createFixture();
  try {
    const queued = fixture.store.enqueueJob({
      id: 'job-test',
      jobType: 'extract_turn',
      payload: { turnId: 'turn-test' },
      maxAttempts: 2,
    });
    assert.equal(queued.status, 'pending');

    const first = fixture.store.claimJob('worker-a', 30);
    assert.equal(first?.id, 'job-test');
    assert.equal(first?.attempts, 1);
    assert.equal(first?.leaseOwner, 'worker-a');
    assert.throws(
      () => fixture.store.completeJob('job-test', 'worker-b'),
      /持有租约/,
    );
    assert.equal(
      fixture.store.failJob(
        'job-test',
        'worker-a',
        '模型暂时不可用',
        1000,
      ).status,
      'failed',
    );
    assert.equal(fixture.store.claimJob('worker-b', 30), null);

    fixture.advance(1000);
    const second = fixture.store.claimJob('worker-b', 30);
    assert.equal(second?.attempts, 2);
    const dead = fixture.store.failJob(
      'job-test',
      'worker-b',
      '第二次仍然失败',
    );
    assert.equal(dead.status, 'dead');
    assert.equal(
      fixture.database
        .prepare(
          `SELECT last_error
           FROM dead_letter_jobs
           WHERE job_id = 'job-test'`,
        )
        .get()?.last_error,
      '第二次仍然失败',
    );
  } finally {
    fixture.close();
  }
});

test('不可重试任务首次失败即停止并记录结构化 attempt 审计', () => {
  const fixture = createFixture();
  try {
    fixture.store.enqueueJob({
      id: 'job-non-retryable',
      jobType: 'consolidate_scope',
      payload: { scopeType: 'session', scopeKey: 'session-a' },
      maxAttempts: 5,
    });
    const claimed = fixture.store.claimJob('worker-a', 30)!;
    assert.equal(claimed.attempts, 1);
    const failed = fixture.store.failJob(
      claimed.id,
      'worker-a',
      'Ollama 记忆巩固未覆盖全部来源：1 条',
      1_000,
      {
        retryable: false,
        failureClass: 'coverage',
        compensationAction: 'stop_duplicate_retry',
      },
    );

    assert.equal(failed.status, 'dead');
    assert.equal(failed.attempts, 1);
    const audit = fixture.database.prepare(
      `SELECT detail_json
       FROM audit_log
       WHERE action = 'job_attempt_failed'
       ORDER BY id DESC LIMIT 1`,
    ).get() as { detail_json?: string } | undefined;
    const detail = JSON.parse(audit?.detail_json || '{}') as
      Record<string, unknown>;
    assert.equal(detail.failureClass, 'coverage');
    assert.equal(detail.nextState, 'dead');
    assert.equal(detail.compensationAction, 'stop_duplicate_retry');
    assert.match(String(detail.inputFingerprint), /^[a-f0-9]{64}$/u);
    assert.match(String(detail.errorFingerprint), /^[a-f0-9]{64}$/u);
  } finally {
    fixture.close();
  }
});

test('成功任务也原子记录结构化 attempt 审计', () => {
  const fixture = createFixture();
  try {
    fixture.store.enqueueJob({
      id: 'job-success-audit',
      jobType: 'consolidate_scope',
      userId: 'alice',
      namespace: 'personal',
      payload: { scopeType: 'topic', scopeKey: 'kind:preference' },
      maxAttempts: 3,
    });
    const claimed = fixture.store.claimJob('worker-success', 30)!;
    const completed = fixture.store.completeJob(
      claimed.id,
      'worker-success',
      {
        inputFingerprint: 'a'.repeat(64),
        outputFingerprint: 'b'.repeat(64),
        modelDurationMs: 12.5,
        missingSourceIds: [],
        compensationAction: 'coverage_repaired_once',
        resultStatus: 'created',
        noopReason: null,
      },
    );

    assert.equal(completed.status, 'completed');
    const audit = fixture.database.prepare(
      `SELECT detail_json
       FROM audit_log
       WHERE user_id = 'alice'
         AND action = 'job_attempt_completed'
       ORDER BY id DESC LIMIT 1`,
    ).get() as { detail_json?: string } | undefined;
    const detail = JSON.parse(audit?.detail_json || '{}') as
      Record<string, unknown>;
    assert.equal(detail.jobId, claimed.id);
    assert.equal(detail.attempt, 1);
    assert.equal(detail.inputFingerprint, 'a'.repeat(64));
    assert.equal(detail.outputFingerprint, 'b'.repeat(64));
    assert.equal(detail.modelDurationMs, 12.5);
    assert.deepEqual(detail.missingSourceIds, []);
    assert.equal(detail.compensationAction, 'coverage_repaired_once');
    assert.equal(detail.resultStatus, 'created');
    assert.equal(detail.noopReason, null);
    assert.equal(detail.nextState, 'completed');
  } finally {
    fixture.close();
  }
});

test('任意 dead letter 可创建幂等后继任务且保留原始失败证据', () => {
  const fixture = createFixture();
  try {
    fixture.store.enqueueJob({
      id: 'job-generic-dead-letter',
      jobType: 'extract_turn',
      userId: 'alice',
      namespace: 'acceptance',
      payload: { turnId: 'turn-generic-recovery' },
      priority: 10,
      maxAttempts: 1,
    });
    assert.equal(
      fixture.store.claimJob('worker-dead', 30)?.id,
      'job-generic-dead-letter',
    );
    assert.equal(
      fixture.store.failJob(
        'job-generic-dead-letter',
        'worker-dead',
        '旧提取器无法解析输出',
        1_000,
        { failureClass: 'transient' },
      ).status,
      'dead',
    );

    assert.throws(
      () => fixture.store.recoverDeadLetterJob(
        'job-generic-dead-letter',
        'alice',
        'other-namespace',
        'recompute',
      ),
      /dead letter 不存在/u,
    );
    assert.equal(
      fixture.store.getJob(
        deadLetterRecoveryJobId('job-generic-dead-letter'),
      ),
      null,
    );
    const recovered = fixture.store.recoverDeadLetterJob(
      'job-generic-dead-letter',
      'alice',
      'acceptance',
      'recompute',
      'operator retry',
    );
    const replayed = fixture.store.recoverDeadLetterJob(
      'job-generic-dead-letter',
      'alice',
      'acceptance',
      'recompute',
      'operator retry',
    );

    assert.equal(
      recovered.id,
      deadLetterRecoveryJobId('job-generic-dead-letter'),
    );
    assert.equal(recovered.status, 'pending');
    assert.equal(recovered.jobType, 'extract_turn');
    assert.equal(recovered.userId, 'alice');
    assert.equal(recovered.namespace, 'acceptance');
    assert.deepEqual(recovered.payload, {
      turnId: 'turn-generic-recovery',
      recovery: {
        mode: 'recompute',
        failedJobId: 'job-generic-dead-letter',
        failureClass: 'transient',
        requestedAt: '2026-07-29T00:00:00.000Z',
        reason: 'operator retry',
        strategy: 'reload_current_sources_and_recompute',
      },
    });
    assert.equal(replayed.id, recovered.id);
    assert.equal(
      fixture.store.getJob('job-generic-dead-letter')?.status,
      'dead',
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM dead_letter_jobs
           WHERE job_id = 'job-generic-dead-letter'`,
        )
        .get()?.count,
      1,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count FROM audit_log
           WHERE action = 'dead_letter_recovery_requested'`,
        )
        .get()?.count,
      1,
    );
    assert.throws(
      () => fixture.store.recoverDeadLetterJob(
        'job-generic-dead-letter',
        'bob',
        'acceptance',
        'recompute',
      ),
      /dead letter 不存在/u,
    );
  } finally {
    fixture.close();
  }
});

test('dead letter 恢复请求跨时间保持幂等且后继再次死亡可生成下一代', () => {
  const fixture = createFixture();
  try {
    fixture.store.enqueueJob({
      id: 'job-recovery-generation-root',
      jobType: 'extract_turn',
      userId: 'alice',
      namespace: 'acceptance',
      payload: { turnId: 'turn-recovery-generation' },
      maxAttempts: 1,
    });
    fixture.store.claimJob('worker-root', 30);
    fixture.store.failJob(
      'job-recovery-generation-root',
      'worker-root',
      'temporary provider failure',
      1_000,
      { retryable: false, failureClass: 'transient' },
    );

    fixture.advance(5_000);
    const first = fixture.store.recoverDeadLetterJob(
      'job-recovery-generation-root',
      'alice',
      'acceptance',
      'recompute',
      'first operator request',
    );
    fixture.advance(7_000);
    const replayed = fixture.store.recoverDeadLetterJob(
      'job-recovery-generation-root',
      'alice',
      'acceptance',
      'recompute',
      'late duplicate request must not rewrite evidence',
    );
    assert.equal(replayed.id, first.id);
    assert.deepEqual(replayed.payload, first.payload);
    assert.equal(
      (first.payload.recovery as Record<string, unknown>).requestedAt,
      '2026-07-29T00:00:05.000Z',
    );
    assert.equal(
      (first.payload.recovery as Record<string, unknown>).reason,
      'first operator request',
    );

    const claimedFirst = fixture.store.claimJob('worker-generation-1', 30)!;
    assert.equal(claimedFirst.id, first.id);
    fixture.store.failJob(
      claimedFirst.id,
      'worker-generation-1',
      'recovery provider failed again',
      1_000,
      { retryable: false, failureClass: 'transient' },
    );
    fixture.advance(3_000);
    const second = fixture.store.recoverDeadLetterJob(
      first.id,
      'alice',
      'acceptance',
      'recompute',
      'second generation',
    );
    assert.notEqual(second.id, first.id);
    assert.equal(
      second.id,
      deadLetterRecoveryJobId(first.id, 'recompute'),
    );
    assert.equal(
      (second.payload.recovery as Record<string, unknown>).failedJobId,
      first.id,
    );
    assert.equal(
      (second.payload.recovery as Record<string, unknown>).requestedAt,
      '2026-07-29T00:00:15.000Z',
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM audit_log
         WHERE action = 'dead_letter_recovery_requested'`,
      ).get()?.count,
      2,
    );
  } finally {
    fixture.close();
  }
});

test('dead letter 按 failure class 限制 repair，并允许 supersede 不支持任务', () => {
  const fixture = createFixture();
  try {
    for (const item of [
      {
        id: 'job-coverage-dead-letter',
        message: '记忆巩固未覆盖全部来源',
        failureClass: 'coverage' as const,
      },
      {
        id: 'job-unsupported-dead-letter',
        message: '不支持的记忆任务',
        failureClass: 'unsupported' as const,
      },
    ]) {
      fixture.store.enqueueJob({
        id: item.id,
        jobType: 'consolidate_scope',
        userId: 'alice',
        namespace: 'acceptance',
        payload: {
          userId: 'alice',
          namespace: 'acceptance',
          scopeType: 'session',
          scopeKey: item.id,
        },
        maxAttempts: 1,
      });
      assert.equal(fixture.store.claimJob('worker-dead', 30)?.id, item.id);
      fixture.store.failJob(
        item.id,
        'worker-dead',
        item.message,
        1_000,
        { retryable: false, failureClass: item.failureClass },
      );
    }

    const repair = fixture.store.recoverDeadLetterJob(
      'job-coverage-dead-letter',
      'alice',
      'acceptance',
      'repair',
    );
    assert.equal(
      repair.id,
      deadLetterRecoveryJobId('job-coverage-dead-letter', 'repair'),
    );
    assert.equal(repair.maxAttempts, 1);
    assert.equal(
      (repair.payload.recovery as Record<string, unknown>).strategy,
      'recompute_eligible_clusters_only',
    );
    assert.throws(
      () => fixture.store.recoverDeadLetterJob(
        'job-unsupported-dead-letter',
        'alice',
        'acceptance',
        'recompute',
      ),
      /只能 supersede/u,
    );
    const superseded = fixture.store.recoverDeadLetterJob(
      'job-unsupported-dead-letter',
      'alice',
      'acceptance',
      'supersede',
      'operator acknowledged unsupported legacy job',
    );
    assert.equal(superseded.jobType, 'dead_letter_supersede');
    assert.equal(superseded.status, 'completed');
    assert.equal(superseded.requiredModelId, null);
    assert.equal(superseded.requiredGenerationId, null);
  } finally {
    fixture.close();
  }
});

test('确定性失败连续产生相同指纹时停止盲重试', () => {
  const fixture = createFixture();
  try {
    fixture.store.enqueueJob({
      id: 'job-repeated-fingerprint',
      jobType: 'extract_turn',
      userId: 'alice',
      namespace: 'acceptance',
      payload: { turnId: 'turn-repeat' },
      maxAttempts: 5,
    });
    const first = fixture.store.claimJob('worker-repeat', 30)!;
    const firstFailure = fixture.store.failJob(
      first.id,
      'worker-repeat',
      '模型返回未知确定性错误',
      1_000,
      {
        failureClass: 'unknown',
        outputFingerprint: 'a'.repeat(64),
        compensationAction: 'retry_with_backoff',
      },
    );
    assert.equal(firstFailure.status, 'failed');

    fixture.advance(1_000);
    const second = fixture.store.claimJob('worker-repeat', 30)!;
    const secondFailure = fixture.store.failJob(
      second.id,
      'worker-repeat',
      '模型返回未知确定性错误',
      1_000,
      {
        failureClass: 'unknown',
        outputFingerprint: 'a'.repeat(64),
        compensationAction: 'retry_with_backoff',
      },
    );
    assert.equal(secondFailure.status, 'dead');
    assert.equal(secondFailure.attempts, 2);
    const audit = fixture.database.prepare(
      `SELECT detail_json FROM audit_log
       WHERE action = 'job_attempt_failed'
       ORDER BY id DESC LIMIT 1`,
    ).get() as { detail_json?: string } | undefined;
    const detail = JSON.parse(audit?.detail_json || '{}') as
      Record<string, unknown>;
    assert.equal(detail.repeatedFingerprint, true);
    assert.equal(detail.retryable, false);
    assert.equal(
      detail.compensationAction,
      'stop_repeated_fingerprint',
    );
  } finally {
    fixture.close();
  }
});

test('最后一次尝试中崩溃的任务在租约过期后进入 dead letter', () => {
  const fixture = createFixture();
  try {
    fixture.store.enqueueJob({
      id: 'job-final-lease-crash',
      jobType: 'extract_turn',
      payload: { turnId: 'turn-test' },
      maxAttempts: 1,
    });
    const claimed = fixture.store.claimJob('worker-crashed', 30);
    assert.equal(claimed?.attempts, 1);
    assert.equal(claimed?.status, 'running');

    fixture.advance(30_001);
    assert.equal(fixture.store.claimJob('worker-recovery', 30), null);
    const dead = fixture.store.getJob('job-final-lease-crash');
    assert.equal(dead?.status, 'dead');
    assert.equal(dead?.leaseOwner, null);
    assert.match(dead?.lastError || '', /租约过期/);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT attempts, last_error
           FROM dead_letter_jobs
           WHERE job_id = 'job-final-lease-crash'`,
        )
        .get()?.attempts,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('启动时用稳定系统所有权接管 legacy consolidation sweep 且不重复排队', () => {
  const fixture = createFixture();
  try {
    const root = fixture.store.enqueueJob({
      id: 'consolidation-sweep:root',
      jobType: 'consolidation_sweep',
      userId: 'legacy-default-owner',
      namespace: 'legacy-default-namespace',
      payload: { scheduledAt: '2026-07-31T00:00:00.000Z' },
      priority: -10,
      maxAttempts: 5,
    });
    fixture.database
      .prepare(
        `UPDATE memory_jobs
         SET status = 'dead', attempts = max_attempts,
             last_error = '旧进程默认所有权配置错误'
         WHERE id = ?`,
      )
      .run(root.id);
    fixture.database
      .prepare(
        `INSERT INTO dead_letter_jobs (
           job_id, job_type, user_id, namespace, payload_json,
           attempts, last_error, failed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        root.id,
        root.jobType,
        root.userId,
        root.namespace,
        JSON.stringify(root.payload),
        root.maxAttempts,
        '旧进程默认所有权配置错误',
        root.updatedAt,
      );

    const recovered = fixture.store.ensureConsolidationSweep();
    const replayed = fixture.store.ensureConsolidationSweep();

    assert.notEqual(recovered.id, root.id);
    assert.equal(recovered.status, 'pending');
    assert.equal(recovered.userId, '__memory_bridge_system__');
    assert.equal(recovered.namespace, '__global__');
    assert.equal(replayed.id, recovered.id);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE job_type = 'consolidation_sweep'
             AND status = 'pending'`,
        )
        .get()?.count,
      1,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM dead_letter_jobs
           WHERE job_id = ?`,
        )
        .get(root.id)?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('稳定系统 sweep 启动时退役仍可执行的 legacy 用户链', () => {
  const fixture = createFixture();
  try {
    const legacy = fixture.store.enqueueJob({
      id: 'consolidation-sweep:root',
      jobType: 'consolidation_sweep',
      userId: 'legacy-default-owner',
      namespace: 'legacy-default-namespace',
      payload: { scheduledAt: '2026-07-31T00:00:00.000Z' },
      priority: -10,
      maxAttempts: 5,
    });

    const takeover = fixture.store.ensureConsolidationSweep();
    const replayed = fixture.store.ensureConsolidationSweep();
    const retiredLegacy = fixture.store.getJob(legacy.id);

    assert.equal(takeover.userId, '__memory_bridge_system__');
    assert.equal(takeover.namespace, '__global__');
    assert.equal(replayed.id, takeover.id);
    assert.equal(retiredLegacy?.status, 'completed');
    assert.match(
      retiredLegacy?.lastError || '',
      /稳定系统 consolidation sweep 链接管/u,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE job_type = 'consolidation_sweep'
             AND status IN ('pending', 'failed', 'running')`,
        )
        .get()?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('过期 outbox 租约可被其他 Worker 接管，旧 Worker 不能确认', () => {
  const fixture = createFixture();
  try {
    const recorded = fixture.store.recordTurn({
      clientName: 'client',
      sessionExternalId: 'outbox-lease-session',
      turnExternalId: 'outbox-lease-turn',
      role: 'user',
      content: '验证 outbox 租约。',
    });
    const eventId = `turn:${recorded.turn.id}:recorded`;
    const first = fixture.store.claimOutbox('worker-a', 30);
    assert.equal(first?.id, eventId);
    assert.equal(first?.leaseOwner, 'worker-a');
    assert.throws(
      () => fixture.store.completeOutbox(eventId, 'worker-b'),
      /持有租约/,
    );

    fixture.advance(30_000);
    const reclaimed = fixture.store.claimOutbox('worker-b', 30);
    assert.equal(reclaimed?.id, eventId);
    assert.equal(reclaimed?.leaseOwner, 'worker-b');
    assert.throws(
      () => fixture.store.completeOutbox(eventId, 'worker-a'),
      /持有租约/,
    );
    assert.equal(
      fixture.store.completeOutbox(eventId, 'worker-b').status,
      'completed',
    );
  } finally {
    fixture.close();
  }
});

test('dispatcher 以 outbox principal 为边界拒绝跨账户 payload turn', () => {
  const fixture = createFixture();
  try {
    const alice = fixture.store.recordTurn({
      userId: 'alice',
      namespace: 'shared-fixture',
      clientName: 'client',
      sessionExternalId: 'alice-outbox-security-session',
      turnExternalId: 'alice-outbox-security-turn',
      role: 'user',
      content: 'Alice 的私密回合。',
    }).turn;
    const bob = fixture.store.recordTurn({
      userId: 'bob',
      namespace: 'shared-fixture',
      clientName: 'client',
      sessionExternalId: 'bob-outbox-security-session',
      turnExternalId: 'bob-outbox-security-turn',
      role: 'user',
      content: 'Bob 的私密回合。',
    }).turn;
    fixture.database
      .prepare(
        `DELETE FROM outbox_events
         WHERE aggregate_id = ?`,
      )
      .run(bob.id);
    fixture.database
      .prepare(
        `UPDATE outbox_events
         SET payload_json = ?
         WHERE aggregate_id = ?`,
      )
      .run(JSON.stringify({ turnId: bob.id }), alice.id);

    const dispatched =
      fixture.store.dispatchNextOutbox('security-dispatcher');
    assert.equal(dispatched.processed, true);
    assert.equal(dispatched.event?.status, 'failed');
    assert.match(
      dispatched.error || '',
      /outbox.*(?:principal|作用域|账户|turn)/u,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE user_id IN ('alice', 'bob')`,
        )
        .get()?.count,
      0,
    );
    assert.equal(
      fixture.store.getTurn(
        bob.id,
        'bob',
        'shared-fixture',
      )?.content,
      'Bob 的私密回合。',
    );
  } finally {
    fixture.close();
  }
});

test('dispatcher 拒绝同时携带冲突 turn alias 的 outbox payload', () => {
  const fixture = createFixture();
  try {
    const alice = fixture.store.recordTurn({
      userId: 'alice',
      namespace: 'shared-fixture',
      clientName: 'client',
      sessionExternalId: 'alice-outbox-alias-session',
      turnExternalId: 'alice-outbox-alias-turn',
      role: 'user',
      content: 'Alice 的可信回合。',
    }).turn;
    const bob = fixture.store.recordTurn({
      userId: 'bob',
      namespace: 'shared-fixture',
      clientName: 'client',
      sessionExternalId: 'bob-outbox-alias-session',
      turnExternalId: 'bob-outbox-alias-turn',
      role: 'user',
      content: 'Bob 的私密回合。',
    }).turn;
    fixture.database
      .prepare('DELETE FROM outbox_events WHERE aggregate_id = ?')
      .run(bob.id);
    fixture.database
      .prepare(
        `UPDATE outbox_events
         SET payload_json = ?
         WHERE aggregate_id = ?`,
      )
      .run(
        JSON.stringify({
          userTurnId: alice.id,
          turnId: bob.id,
        }),
        alice.id,
      );

    const dispatched =
      fixture.store.dispatchNextOutbox('alias-security-dispatcher');
    assert.equal(dispatched.processed, true);
    assert.equal(dispatched.event?.status, 'failed');
    assert.match(
      dispatched.error || '',
      /outbox.*(?:principal|作用域|账户|turn)/u,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE user_id IN ('alice', 'bob')`,
        )
        .get()?.count,
      0,
    );
    assert.equal(
      fixture.store.getTurn(
        bob.id,
        'bob',
        'shared-fixture',
      )?.content,
      'Bob 的私密回合。',
    );
  } finally {
    fixture.close();
  }
});

test('提取结果形成完整结构化候选且凭据不落库', () => {
  const fixture = createFixture();
  try {
    const recorded = fixture.store.recordTurn({
      personaId: 'persona-A',
      projectId: 'airi-trusted',
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: 'round-project-candidate',
      clientName: 'client',
      sessionExternalId: 'session-candidate',
      turnExternalId: 'turn-candidate',
      role: 'user',
      content: '我主要使用 VS Code。我的验证码是 123456。',
      metadata: { trustedProjectId: 'airi-trusted' },
    });
    const runId = fixture.store.startExtraction(
      recorded.turn.id,
      'qwen2.5:14b',
      'extract-v1',
    );
    const candidates = fixture.store.completeExtraction(runId, [
      {
        kind: 'preference',
        subject: '用户',
        predicate: '主要编辑器',
        value: 'VS Code',
        content: '用户主要使用 VS Code。',
        confidence: 0.98,
        importance: 0.7,
        scopeType: 'project',
        scopeKey: 'model-guessed-airi',
        claimValidFrom: '2026-07-29T00:00:00.000Z',
        sourceExcerpt: '我主要使用 VS Code',
      },
      {
        kind: 'knowledge',
        subject: '用户',
        predicate: '验证码',
        value: '123456',
        content: '用户验证码是 123456。',
        confidence: 1,
        importance: 1,
        sensitivity: 'credential',
      },
    ]);

    assert.equal(candidates.length, 1);
    const editor = candidates.find(
      (candidate) => candidate.predicate === '主要编辑器',
    );
    assert.equal(editor?.state, 'pending');
    assert.equal(editor?.normalizedKey, '用户::主要编辑器');
    assert.equal(
      editor?.stableKey,
      'project::airi-trusted::用户::主要编辑器',
    );
    assert.equal(editor?.scopeType, 'project');
    assert.equal(editor?.scopeKey, 'airi-trusted');
    assert.equal(editor?.sourceAuthority, 'direct_user');
    assert.equal(editor?.extractionModel, 'qwen2.5:14b');
    assert.equal(editor?.extractionPromptVersion, 'extract-v1');
    assert.equal(editor?.sourceExcerpt, '我主要使用 VS Code');
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_candidates
           WHERE predicate = '验证码'
              OR content LIKE '%123456%'
              OR value_text LIKE '%123456%'`,
        )
        .get()?.count,
      0,
    );

    const replayed = fixture.store.completeExtraction(runId, [
      {
        kind: 'preference',
        subject: '用户',
        predicate: '主要编辑器',
        value: 'VS Code',
        content: '用户主要使用 VS Code。',
        confidence: 0.98,
        importance: 0.7,
        scopeType: 'project',
        scopeKey: 'another-model-guess',
      },
    ]);
    assert.equal(replayed.length, 1);
    assert.equal(
      fixture.store.listCandidates({ extractionRunId: runId }).length,
      1,
    );
    const resolutionJob = fixture.database
      .prepare(
        `SELECT job_type, payload_json
         FROM memory_jobs
         WHERE job_type = 'resolve_candidate'`,
      )
      .get();
    assert.equal(resolutionJob?.job_type, 'resolve_candidate');
    assert.match(
      String(resolutionJob?.payload_json),
      new RegExp(editor?.id || 'missing-candidate'),
    );
  } finally {
    fixture.close();
  }
});

test('候选持久化会将夹带第二事实的 content 规范化为单原子陈述', () => {
  const fixture = createFixture();
  try {
    const recorded = fixture.store.recordTurn({
      clientName: 'client',
      sessionExternalId: 'session-content-smuggling',
      turnExternalId: 'turn-content-smuggling',
      role: 'user',
      content:
        '我默认使用深色模式。我的协作工具是飞书。',
    });
    const runId = fixture.store.startExtraction(
      recorded.turn.id,
      'qwen2.5:14b',
      'extract-v5',
    );
    const candidates = fixture.store.completeExtraction(runId, [{
      kind: 'preference',
      subject: '用户',
      predicate: '界面偏好',
      value: '深色模式',
      content:
        '用户默认使用深色模式。用户的协作工具是飞书。',
      confidence: 0.99,
      importance: 0.8,
      sourceExcerpt: '我默认使用深色模式。',
    }]);

    assert.equal(candidates.length, 1);
    assert.equal(
      candidates[0]?.content,
      'atomic-memory-v1:' +
        '{"subject":"用户","predicate":"界面偏好",' +
        '"value":"深色模式","negated":false}',
    );
    assert.doesNotMatch(candidates[0]?.content || '', /飞书/u);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_candidates
           WHERE content LIKE '%飞书%'`,
        )
        .get()?.count,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('安全规则可落候选但真实凭据值仍然零写入', () => {
  const fixture = createFixture();
  try {
    const secretSamples = [
      'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature123',
      'sk-proj-abc123XYZ789',
      'token=generic-token-123456',
      'API Key: sk-proj-abc123XYZ789 must-not-log',
    ];
    const recorded = fixture.store.recordTurn({
      clientName: 'client',
      sessionExternalId: 'session-credential-policy',
      turnExternalId: 'turn-credential-policy',
      role: 'user',
      content:
        '所有服务密钥必须从环境变量读取。' +
        secretSamples.map((secret) => `${secret}。`).join(''),
    });
    const runId = fixture.store.startExtraction(
      recorded.turn.id,
      'qwen2.5:14b',
      'extract-v4',
    );
    const candidates = fixture.store.completeExtraction(runId, [
      {
        kind: 'instruction',
        subject: '所有服务',
        predicate: '密钥读取规则',
        value: '所有服务密钥必须从环境变量读取',
        content: '所有服务密钥必须从环境变量读取。',
        confidence: 0.99,
        importance: 0.9,
        sensitivity: 'credential',
        sourceExcerpt: '所有服务密钥必须从环境变量读取。',
      },
      ...secretSamples.map((secret, index) => ({
        kind: 'knowledge' as const,
        subject: '用户',
        predicate: `认证材料 ${index + 1}`,
        value: secret,
        content: `${secret}。`,
        confidence: 1,
        importance: 1,
        sensitivity: 'normal' as const,
        sourceExcerpt: `${secret}。`,
      })),
    ]);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.predicate, '密钥读取规则');
    assert.equal(candidates[0]?.sensitivity, 'normal');
    assert.equal(
      candidates[0]?.sourceExcerpt,
      '所有服务密钥必须从环境变量读取。',
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_candidates
           WHERE predicate LIKE '认证材料 %'`,
        )
        .get()?.count,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('同一回合的不同提取器版本各自产生运行且候选保留真实提示版本', () => {
  const fixture = createFixture();
  try {
    const turn = fixture.store.recordTurn({
      clientName: 'client',
      sessionExternalId: 'session-extractor-version',
      turnExternalId: 'turn-extractor-version',
      role: 'user',
      content: '我做应用时不喜欢内置演示数据。',
    }).turn;
    const firstRunId = fixture.store.startExtraction(
      turn.id,
      'qwen2.5:14b',
      'extract-v1',
      'memory-extractor',
      'v1',
    );
    const secondRunId = fixture.store.startExtraction(
      turn.id,
      'qwen2.5:14b',
      'extract-v1',
      'memory-extractor',
      'v2',
    );

    assert.notEqual(firstRunId, secondRunId);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM extraction_runs
           WHERE turn_id = ? AND model = ?`,
        )
        .get(turn.id, 'qwen2.5:14b')?.count,
      2,
    );

    const [candidate] = fixture.store.completeExtraction(
      secondRunId,
      [{
        kind: 'preference',
        subject: '用户',
        predicate: '演示数据偏好',
        value: '不内置演示数据',
        content: '用户不希望应用内置演示数据。',
        confidence: 0.99,
        importance: 0.9,
        sourceExcerpt: '我做应用时不喜欢内置演示数据',
      }],
    );
    assert.equal(candidate.extractorVersion, 'v2');
    assert.equal(candidate.extractionPromptVersion, 'extract-v1');
    assert.doesNotMatch(candidate.extractionPromptVersion, /#/);
  } finally {
    fixture.close();
  }
});

test('空闲会话在 14:59 不触发、15:00 触发且继续聊天产生新水位', () => {
  const fixture = createFixture();
  try {
    const memoryStore = new MemoryStore(fixture.database);
    const personaId = 'ChXvr-B7s8qFvnyrlNYhP';
    const sessionExternalId = 'z6e2a07YMRX6pY-p4TUy-';
    const first = fixture.store.recordCompletedExchange({
      userId: 'default',
      namespace: 'personal',
      personaId,
      projectId: 'client-a',
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: 'idle-round-1',
      clientName: 'client',
      sessionExternalId,
      userTurnExternalId: 'idle-user-1',
      userContent: '记录四个访问范围的事实。',
      assistantTurnExternalId: 'idle-assistant-1',
      assistantContent: '好的。',
    });
    const scopes = [
      ['personal', 'self'],
      ['project', 'client-a'],
      ['role', personaId],
      ['session', sessionExternalId],
    ] as const;
    for (const [scopeType, scopeKey] of scopes) {
      memoryStore.remember({
        kind: 'preference',
        content: `${scopeType}/${scopeKey} 的会话事实。`,
        stableKey: `${scopeType}::${scopeKey}::会话事实`,
        predicateKey: `用户::${scopeType}会话事实`,
        source: 'automatic-extraction',
        evidenceTurnId: first.userTurn.id,
        evidenceExcerpt: `${scopeType}/${scopeKey}`,
        scopeType,
        scopeKey,
      });
    }

    const before = fixture.store.runConsolidationSweep({
      at: '2026-07-29T00:14:59.000Z',
      idleMinutes: 15,
    });
    assert.equal(before.scannedSessions, 0);
    assert.equal(before.enqueued, 0);

    const boundary = fixture.store.runConsolidationSweep({
      at: '2026-07-29T00:15:00.000Z',
      idleMinutes: 15,
    });
    assert.equal(boundary.scannedSessions, 1);
    assert.equal(boundary.enqueued, 4);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT ended_at
           FROM conversation_sessions
           WHERE id = ?`,
        )
        .get(first.sessionId)?.ended_at,
      null,
    );
    const firstJobs = fixture.database
      .prepare(
        `SELECT payload_json
         FROM memory_jobs
         WHERE job_type = 'consolidate_scope'`,
      )
      .all() as Array<Record<string, unknown>>;
    assert.deepEqual(
      firstJobs.map((row) => {
        const payload = JSON.parse(String(row.payload_json));
        return [
          payload.accessScopeType,
          payload.accessScopeKey,
        ];
      }).sort(),
      scopes.map(([scopeType, scopeKey]) =>
        [scopeType, scopeKey]).sort(),
    );
    assert.equal(
      fixture.store.runConsolidationSweep({
        at: '2026-07-29T00:15:00.000Z',
        idleMinutes: 15,
      }).enqueued,
      0,
    );

    fixture.advance(15 * 60_000);
    const continued = fixture.store.recordCompletedExchange({
      userId: 'default',
      namespace: 'personal',
      personaId,
      projectId: 'client-a',
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: 'idle-round-2',
      clientName: 'client',
      sessionExternalId,
      userTurnExternalId: 'idle-user-2',
      userContent: '继续同一个会话。',
      assistantTurnExternalId: 'idle-assistant-2',
      assistantContent: '继续。',
    });
    assert.equal(continued.sessionId, first.sessionId);
    assert.equal(
      fixture.store.runConsolidationSweep({
        at: '2026-07-29T00:29:59.000Z',
        idleMinutes: 15,
      }).enqueued,
      0,
    );
    assert.equal(
      fixture.store.runConsolidationSweep({
        at: '2026-07-29T00:30:00.000Z',
        idleMinutes: 15,
      }).enqueued,
      4,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE job_type = 'consolidate_scope'`,
        )
        .get()?.count,
      8,
    );
  } finally {
    fixture.close();
  }
});

test('显式结束会话立即触发且重复结束保持同一水位幂等', () => {
  const fixture = createFixture();
  try {
    const memoryStore = new MemoryStore(fixture.database);
    const exchange = fixture.store.recordCompletedExchange({
      clientName: 'client',
      sessionExternalId: 'ended-session',
      userTurnExternalId: 'ended-user-1',
      userContent: '会话结束时立即巩固。',
      assistantTurnExternalId: 'ended-assistant-1',
      assistantContent: '好的。',
    });
    for (let index = 1; index <= 2; index += 1) {
      memoryStore.remember({
        kind: 'event',
        content: `显式结束来源 ${index}。`,
        stableKey: `用户::显式结束来源${index}`,
        predicateKey: `用户::显式结束来源${index}`,
        source: 'automatic-extraction',
        evidenceTurnId: exchange.userTurn.id,
      });
    }
    fixture.store.endSession('default', 'client', 'ended-session');
    fixture.store.endSession('default', 'client', 'ended-session');

    assert.ok(
      fixture.database
        .prepare(
          `SELECT ended_at
           FROM conversation_sessions
           WHERE id = ?`,
        )
        .get(exchange.sessionId)?.ended_at,
    );
    const jobs = fixture.database
      .prepare(
        `SELECT payload_json
         FROM memory_jobs
         WHERE job_type = 'consolidate_scope'`,
      )
      .all() as Array<Record<string, unknown>>;
    assert.equal(jobs.length, 1);
    const payload = JSON.parse(String(jobs[0].payload_json));
    assert.equal(payload.trigger, 'ended');
    assert.equal(payload.scopeType, 'session');
    assert.equal(payload.scopeKey, exchange.sessionId);
    assert.equal(payload.accessScopeType, 'personal');
    assert.equal(payload.accessScopeKey, 'self');
  } finally {
    fixture.close();
  }
});

test('可信会话固定 persona/round 并强制候选使用可信 scope key', () => {
  const fixture = createFixture();
  try {
    const exchange = fixture.store.recordCompletedExchange({
      userId: 'alice',
      namespace: 'personal',
      personaId: 'persona-A',
      projectId: 'project-A',
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: 'round-1',
      clientName: 'ollama-compat',
      sessionExternalId: 'chat-A1',
      userTurnExternalId: 'user:round-1',
      userContent: '这是三个不同层级的记忆。',
      assistantTurnExternalId: 'assistant:round-1',
      assistantContent: '好的。',
      userMetadata: { trustedProjectId: 'project-A' },
    });
    assert.deepEqual(
      fixture.store.boundConversationScopes({
        userId: 'alice',
        namespace: 'personal',
        clientName: 'ollama-compat',
        sessionExternalId: 'chat-A1',
      }),
      [
        { scopeType: 'personal', scopeKey: 'self' },
        { scopeType: 'role', scopeKey: 'persona-A' },
        { scopeType: 'session', scopeKey: 'chat-A1' },
        { scopeType: 'project', scopeKey: 'project-A' },
      ],
    );
    for (const override of [
      { userId: 'bob' },
      { namespace: 'other' },
      { clientName: 'other-client' },
      { sessionExternalId: 'chat-B1' },
    ]) {
      assert.equal(
        fixture.store.boundConversationScopes({
          userId: 'alice',
          namespace: 'personal',
          clientName: 'ollama-compat',
          sessionExternalId: 'chat-A1',
          ...override,
        }),
        null,
      );
    }
    const extractionRunId = fixture.store.startExtraction(
      exchange.userTurn.id,
      'qwen2.5:14b',
      'scope-test-v1',
    );
    const candidates = fixture.store.completeExtraction(
      extractionRunId,
      [
        {
          kind: 'preference',
          subject: '用户',
          predicate: '个人偏好',
          value: '简洁',
          content: '用户偏好简洁。',
          confidence: 0.99,
          importance: 0.8,
          scopeType: 'personal',
          scopeKey: 'attacker-personal-key',
        },
        {
          kind: 'project',
          subject: 'A 项目',
          predicate: '项目约定',
          value: '仅本项目可见',
          content: 'A 项目有仅本项目可见的约定。',
          confidence: 0.99,
          importance: 0.8,
          scopeType: 'project',
          scopeKey: 'model-guessed-project-B',
        },
        {
          kind: 'relationship',
          subject: '用户',
          predicate: '角色约定',
          value: '私有',
          content: '用户与当前角色有私有约定。',
          confidence: 0.99,
          importance: 0.8,
          scopeType: 'role',
          scopeKey: 'persona-B',
        },
        {
          kind: 'event',
          subject: '用户',
          predicate: '会话事项',
          value: '临时',
          content: '用户当前会话有临时事项。',
          confidence: 0.99,
          importance: 0.8,
          scopeType: 'session',
          scopeKey: 'chat-B1',
        },
      ],
      { enqueueResolution: false },
    );
    assert.deepEqual(
      candidates
        .map((candidate) => [
          candidate.scopeType,
          candidate.scopeKey,
        ])
        .sort(),
      [
        ['personal', 'self'],
        ['project', 'project-A'],
        ['role', 'persona-A'],
        ['session', 'chat-A1'],
      ],
    );
    assert.throws(
      () => fixture.store.recordCompletedExchange({
        userId: 'alice',
        namespace: 'personal',
        personaId: 'persona-B',
        identitySource: 'credential',
        identityStatus: 'complete',
        roundId: 'round-2',
        clientName: 'ollama-compat',
        sessionExternalId: 'chat-A1',
        userTurnExternalId: 'user:round-2',
        userContent: '试图切换角色。',
        assistantTurnExternalId: 'assistant:round-2',
        assistantContent: '不允许。',
      }),
      /不能切换 persona/,
    );
    assert.throws(
      () => fixture.store.recordCompletedExchange({
        userId: 'alice',
        namespace: 'personal',
        identitySource: 'credential',
        identityStatus: 'degraded',
        clientName: 'ollama-compat',
        sessionExternalId: 'chat-degraded',
        userTurnExternalId: 'user:degraded',
        userContent: '身份不完整。',
        assistantTurnExternalId: 'assistant:degraded',
        assistantContent: '不应保存。',
      }),
      /禁止写入会话/,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM conversation_sessions`,
        )
        .get()?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('当前角色独有措辞在可信边界强制绑定当前 persona', () => {
  const fixture = createFixture();
  try {
    const personaId = 'ChXvr-B7s8qFvnyrlNYhP';
    const exchange = fixture.store.recordCompletedExchange({
      userId: 'alice',
      namespace: 'personal',
      personaId,
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: 'round-role-exclusive',
      clientName: 'ollama-compat',
      sessionExternalId: 'z6e2a07YMRX6pY-p4TUy-',
      userTurnExternalId: 'user:round-role-exclusive',
      userContent: '当前角色独有的幸运数字是47，其他角色不用沿用。',
      assistantTurnExternalId: 'assistant:round-role-exclusive',
      assistantContent: '好的。',
    });
    const extractionRunId = fixture.store.startExtraction(
      exchange.userTurn.id,
      'qwen2.5:14b',
      'role-scope-boundary-v1',
    );
    const [candidate] = fixture.store.completeExtraction(
      extractionRunId,
      [{
        kind: 'preference',
        subject: '当前角色',
        predicate: '幸运数字',
        value: '47',
        content: '当前角色独有的幸运数字是47。',
        confidence: 0.99,
        importance: 0.9,
        negated: false,
        scopeType: 'personal',
        scopeKey: 'self',
        sourceExcerpt:
          '当前角色独有的幸运数字是47，其他角色不用沿用。',
      }],
      { enqueueResolution: false },
    );

    assert.equal(candidate?.scopeType, 'role');
    assert.equal(candidate?.scopeKey, personaId);
    assert.equal(candidate?.negated, false);
  } finally {
    fixture.close();
  }
});

test('所有角色共享措辞在可信边界强制绑定 personal self', () => {
  const fixture = createFixture();
  try {
    const exchange = fixture.store.recordCompletedExchange({
      userId: 'alice',
      namespace: 'personal',
      personaId: 'ChXvr-B7s8qFvnyrlNYhP',
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: 'round-personal-shared',
      clientName: 'ollama-compat',
      sessionExternalId: 'shared-memory-session',
      userTurnExternalId: 'user:round-personal-shared',
      userContent:
        '我的通用饮品偏好是桂花乌龙，' +
        '这个偏好在所有角色中都一样。请长期记住。',
      assistantTurnExternalId: 'assistant:round-personal-shared',
      assistantContent: '好的。',
    });
    const extractionRunId = fixture.store.startExtraction(
      exchange.userTurn.id,
      'qwen2.5:14b',
      'personal-scope-boundary-v1',
    );
    const [candidate] = fixture.store.completeExtraction(
      extractionRunId,
      [{
        kind: 'preference',
        subject: '所有角色',
        predicate: '通用饮品偏好',
        value: '桂花乌龙',
        content: '所有角色的通用饮品偏好是桂花乌龙。',
        confidence: 0.99,
        importance: 0.9,
        negated: false,
        scopeType: 'role',
        scopeKey: 'ChXvr-B7s8qFvnyrlNYhP',
        sourceExcerpt:
          '我的通用饮品偏好是桂花乌龙，' +
          '这个偏好在所有角色中都一样。请长期记住。',
      }],
      { enqueueResolution: false },
    );

    assert.equal(candidate?.scopeType, 'personal');
    assert.equal(candidate?.scopeKey, 'self');
  } finally {
    fixture.close();
  }
});

test('完整身份缺失可信 project 绑定时隔离并拒绝模型项目 key', () => {
  const fixture = createFixture();
  try {
    const exchange = fixture.store.recordCompletedExchange({
      userId: 'alice',
      namespace: 'personal',
      personaId: 'persona-A',
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: 'round-no-project',
      clientName: 'ollama-compat',
      sessionExternalId: 'chat-no-project',
      userTurnExternalId: 'user:round-no-project',
      userContent: '模型声称这一事实属于 guessed-project。',
      assistantTurnExternalId: 'assistant:round-no-project',
      assistantContent: '好的。',
    });
    const extractionRunId = fixture.store.startExtraction(
      exchange.userTurn.id,
      'qwen2.5:14b',
      'missing-project-scope-v1',
    );
    const [candidate] = fixture.store.completeExtraction(
      extractionRunId,
      [{
        kind: 'project',
        subject: '猜测项目',
        predicate: '项目约定',
        value: '不可信',
        content: '猜测项目有一条不可信约定。',
        confidence: 0.99,
        importance: 0.8,
        scopeType: 'project',
        scopeKey: 'guessed-project',
      }],
    );

    assert.equal(candidate.state, 'rejected');
    assert.equal(
      candidate.decisionReason,
      'trusted_project_scope_required',
    );
    assert.notEqual(candidate.scopeKey, 'guessed-project');
    assert.match(candidate.scopeKey, /^unbound:/u);
    assert.doesNotMatch(candidate.stableKey, /guessed-project/u);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE job_type = 'resolve_candidate'`,
        )
        .get()?.count,
      0,
    );
    assert.throws(
      () => fixture.store.updateCandidateState(
        candidate.id,
        'accepted',
        '不得人工越权接受',
      ),
      /已完成其他决策/,
    );
  } finally {
    fixture.close();
  }
});

test('legacy 提取隔离 project/role 模型 key 并固定 session scope key', () => {
  const fixture = createFixture();
  try {
    const exchange = fixture.store.recordCompletedExchange({
      clientName: 'legacy-client',
      sessionExternalId: 'legacy-chat-A1',
      userTurnExternalId: 'legacy-user-1',
      userContent: '这一轮包含项目、角色约定和临时事项。',
      assistantTurnExternalId: 'legacy-assistant-1',
      assistantContent: '好的。',
    });
    const extractionRunId = fixture.store.startExtraction(
      exchange.userTurn.id,
      'qwen2.5:14b',
      'legacy-scope-test-v1',
    );
    const candidates = fixture.store.completeExtraction(
      extractionRunId,
      [
        {
          kind: 'project',
          subject: '猜测项目',
          predicate: '项目约定',
          value: '仅 guessed-project 可见',
          content: '猜测项目有一条私有约定。',
          confidence: 0.99,
          importance: 0.8,
          scopeType: 'project',
          scopeKey: 'guessed-project',
        },
        {
          kind: 'relationship',
          subject: '用户',
          predicate: '角色私有约定',
          value: '仅 persona-B 可见',
          content: '用户与 persona-B 有私有约定。',
          confidence: 0.99,
          importance: 0.8,
          scopeType: 'role',
          scopeKey: 'persona-B',
        },
        {
          kind: 'event',
          subject: '用户',
          predicate: '当前聊天临时事项',
          value: '只在本聊天有效',
          content: '该事项只在当前聊天有效。',
          confidence: 0.99,
          importance: 0.8,
          scopeType: 'session',
          scopeKey: 'attacker-chosen-session',
        },
      ],
      { enqueueResolution: false },
    );

    assert.equal(candidates.length, 3);
    const project = candidates.find(
      (candidate) => candidate.scopeType === 'project',
    );
    const role = candidates.find(
      (candidate) => candidate.scopeType === 'role',
    );
    const session = candidates.find(
      (candidate) => candidate.scopeType === 'session',
    );
    assert.equal(project?.state, 'rejected');
    assert.equal(
      project?.decisionReason,
      'trusted_project_scope_required',
    );
    assert.notEqual(project?.scopeKey, 'guessed-project');
    assert.match(project?.scopeKey || '', /^unbound:/u);
    assert.equal(role?.state, 'rejected');
    assert.equal(
      role?.decisionReason,
      'trusted_role_scope_required',
    );
    assert.notEqual(role?.scopeKey, 'persona-B');
    assert.match(role?.scopeKey || '', /^unbound:/u);
    assert.equal(session?.scopeKey, 'legacy-chat-A1');
    assert.notEqual(session?.scopeKey, 'attacker-chosen-session');
  } finally {
    fixture.close();
  }
});
