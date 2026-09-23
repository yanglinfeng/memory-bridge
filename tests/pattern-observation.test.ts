import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import {
  MemoryReflectionService,
  type ReflectionProvider,
} from '../src/server/memory-reflection.js';
import type { MemoryExtractor } from '../src/server/memory-extractor.js';
import { PatternObservationStore } from
  '../src/server/pattern-observation-store.js';

function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-pattern-observation-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const lifecycle = new LifecycleStore(
    database,
    () => new Date('2026-08-13T12:00:00.000Z'),
  );
  const record = (
    turnExternalId: string,
    content: string,
    occurredAt: string,
    sessionExternalId = 'pattern-session',
  ) => lifecycle.recordTurn({
    userId: 'alice',
    namespace: 'personal',
    clientName: 'client',
    sessionExternalId,
    turnExternalId,
    role: 'user',
    content,
    occurredAt,
  }).turn;
  return {
    database,
    lifecycle,
    record,
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

const claim = {
  userId: 'alice',
  namespace: 'personal',
  scopeType: 'personal' as const,
  scopeKey: 'self',
  claimFingerprint: 'pattern-claim-tea',
  kind: 'preference' as const,
  subject: '用户',
  predicate: '工作日饮品',
  value: '桂花乌龙',
  negated: false,
};

test('观察按 claim+turn 幂等，两个不同 turn 不晋升，三个才返回 3-5 条证据', () => {
  const context = fixture();
  try {
    const store = new PatternObservationStore(context.database);
    const turns = [
      context.record('observe-t1', '周一工作日前喝桂花乌龙。', '2026-08-10T08:00:00.000Z'),
      context.record('observe-t2', '周三工作日前也喝桂花乌龙。', '2026-08-11T08:00:00.000Z'),
      context.record('observe-t3', '周五工作日前还是桂花乌龙。', '2026-08-12T08:00:00.000Z'),
    ];
    const observe = (index: number) => store.observe({
      ...claim,
      turnId: turns[index]!.id,
      excerpt: turns[index]!.content,
      runId: null,
      state: 'supporting',
      timestamp: '2026-08-13T12:00:00.000Z',
    });

    observe(0);
    observe(0);
    observe(1);
    assert.equal(store.evidenceForVerification(claim).length, 0);
    assert.equal(
      context.database.prepare(
        'SELECT COUNT(*) AS count FROM memory_pattern_observations',
      ).get()?.count,
      2,
    );

    observe(2);
    assert.deepEqual(
      store.evidenceForVerification(claim).map((item) => item.turnId),
      turns.map((turn) => turn.id),
    );
  } finally {
    context.close();
  }
});

test('personal 观察可跨 session 和日期累计，session scope 仍严格隔离', () => {
  const context = fixture();
  try {
    const store = new PatternObservationStore(context.database);
    const turns = [
      context.record(
        'cross-boundary-t1',
        '周一工作日前喝桂花乌龙。',
        '2026-08-01T08:00:00.000Z',
        'cross-boundary-session-a',
      ),
      context.record(
        'cross-boundary-t2',
        '周三工作日前也喝桂花乌龙。',
        '2026-08-05T08:00:00.000Z',
        'cross-boundary-session-b',
      ),
      context.record(
        'cross-boundary-t3',
        '周五工作日前还是桂花乌龙。',
        '2026-08-09T08:00:00.000Z',
        'cross-boundary-session-c',
      ),
    ];
    for (const turn of turns) {
      store.observe({
        ...claim,
        turnId: turn.id,
        excerpt: turn.content,
        runId: null,
        state: 'supporting',
        timestamp: '2026-08-13T12:00:00.000Z',
      });
    }

    const evidence = store.evidenceForVerification(claim);
    assert.equal(evidence.length, 3);
    assert.equal(new Set(evidence.map((item) => item.sessionId)).size, 3);
    assert.equal(
      new Set(evidence.map((item) => item.occurredAt.slice(0, 10))).size,
      3,
    );

    assert.throws(() => store.observe({
      ...claim,
      scopeType: 'session',
      scopeKey: 'cross-boundary-session-a',
      turnId: turns[1]!.id,
      excerpt: turns[1]!.content,
      runId: null,
      state: 'supporting',
      timestamp: '2026-08-13T12:00:00.000Z',
    }), /scope/u);
  } finally {
    context.close();
  }
});

test('可配置要求观察至少跨两个 session 或两个自然日', () => {
  const context = fixture();
  try {
    const store = new PatternObservationStore(context.database);
    const sameBoundary = [1, 2, 3].map((index) => context.record(
      `diversity-same-${index}`,
      `第 ${index} 次工作日前喝桂花乌龙。`,
      `2026-08-10T0${index}:00:00.000Z`,
      'diversity-session-a',
    ));
    for (const turn of sameBoundary) {
      store.observe({
        ...claim,
        turnId: turn.id,
        excerpt: turn.content,
        runId: null,
        state: 'supporting',
        timestamp: '2026-08-13T12:00:00.000Z',
      });
    }

    assert.equal(store.evidenceForVerification(claim).length, 3);
    assert.equal(store.evidenceForVerification(
      claim,
      3,
      5,
      { requireCrossSession: true },
    ).length, 0);
    assert.equal(store.evidenceForVerification(
      claim,
      3,
      5,
      { requireCrossDay: true },
    ).length, 0);

    const crossSession = context.record(
      'diversity-cross-session',
      '换一个会话后，工作日前仍然喝桂花乌龙。',
      '2026-08-10T08:00:00.000Z',
      'diversity-session-b',
    );
    store.observe({
      ...claim,
      turnId: crossSession.id,
      excerpt: crossSession.content,
      runId: null,
      state: 'supporting',
      timestamp: '2026-08-13T12:00:00.000Z',
    });
    assert.ok(store.evidenceForVerification(
      claim,
      3,
      5,
      { requireCrossSession: true },
    ).length >= 3);
    assert.equal(store.evidenceForVerification(
      claim,
      3,
      5,
      { requireCrossSession: true, requireCrossDay: true },
    ).length, 0);

    const crossDay = context.record(
      'diversity-cross-day',
      '第二天工作日前还是喝桂花乌龙。',
      '2026-08-11T08:00:00.000Z',
      'diversity-session-a',
    );
    store.observe({
      ...claim,
      turnId: crossDay.id,
      excerpt: crossDay.content,
      runId: null,
      state: 'supporting',
      timestamp: '2026-08-13T12:00:00.000Z',
    });
    const diversified = store.evidenceForVerification(
      claim,
      3,
      5,
      { requireCrossSession: true, requireCrossDay: true },
    );
    assert.ok(diversified.length >= 3 && diversified.length <= 5);
    assert.ok(new Set(diversified.map((item) => item.sessionId)).size >= 2);
    assert.ok(new Set(diversified.map(
      (item) => item.occurredAt.slice(0, 10),
    )).size >= 2);
  } finally {
    context.close();
  }
});

test('习惯停止后旧证据失效，只有停止后三条新证据才能恢复', () => {
  const context = fixture();
  try {
    const store = new PatternObservationStore(context.database);
    const supporting = [1, 2, 3].map((index) => context.record(
      `block-support-${index}`,
      `第 ${index} 次工作日前喝桂花乌龙。`,
      new Date(Date.UTC(2026, 7, index + 7, 8)).toISOString(),
    ));
    for (const turn of supporting) {
      store.observe({
        ...claim,
        turnId: turn.id,
        excerpt: turn.content,
        runId: null,
        state: 'supporting',
        timestamp: '2026-08-13T12:00:00.000Z',
      });
    }
    assert.equal(store.evidenceForVerification(claim).length, 3);

    const correction = context.record(
      'block-correction',
      '纠正一下，我不再喝桂花乌龙，请忘记这个偏好。',
      '2026-08-12T09:00:00.000Z',
    );
    store.observe({
      ...claim,
      negated: true,
      turnId: correction.id,
      excerpt: correction.content,
      runId: null,
      state: 'contradicting',
      timestamp: '2026-08-13T12:00:00.000Z',
    });

    assert.equal(store.evidenceForVerification(claim).length, 0);
    assert.equal(store.clusterBlocked(claim), true);

    const recovered = [1, 2, 3].map((index) => context.record(
      `recovery-support-${index}`,
      `恢复后第 ${index} 次工作日前喝桂花乌龙。`,
      new Date(Date.UTC(2026, 7, index + 12, 8)).toISOString(),
    ));
    for (const [index, turn] of recovered.entries()) {
      store.observe({
        ...claim,
        turnId: turn.id,
        excerpt: turn.content,
        runId: null,
        state: 'supporting',
        timestamp: '2026-08-16T12:00:00.000Z',
      });
      if (index < 2) {
        assert.equal(store.evidenceForVerification(claim).length, 0);
        assert.equal(store.clusterBlocked(claim), true);
      }
    }

    assert.equal(store.clusterBlocked(claim), false);
    assert.deepEqual(
      store.evidenceForVerification(claim).map((item) => item.turnId),
      recovered.map((turn) => turn.id),
      '恢复时不得重用停止前的三条旧证据',
    );
  } finally {
    context.close();
  }
});

test('blocked 观察为永久 fail-closed，后续新证据不得复活', () => {
  const context = fixture();
  try {
    const store = new PatternObservationStore(context.database);
    const blocked = context.record(
      'permanent-block',
      '请永久不要再推断我喝桂花乌龙的习惯。',
      '2026-08-12T09:00:00.000Z',
    );
    store.observe({
      ...claim,
      turnId: blocked.id,
      excerpt: blocked.content,
      runId: null,
      state: 'blocked',
      timestamp: '2026-08-12T12:00:00.000Z',
    });
    for (let index = 1; index <= 3; index += 1) {
      const turn = context.record(
        `post-block-support-${index}`,
        `阻断后第 ${index} 次喝桂花乌龙。`,
        new Date(Date.UTC(2026, 7, index + 12, 8)).toISOString(),
      );
      store.observe({
        ...claim,
        turnId: turn.id,
        excerpt: turn.content,
        runId: null,
        state: 'supporting',
        timestamp: '2026-08-16T12:00:00.000Z',
      });
    }

    assert.equal(store.clusterBlocked(claim), true);
    assert.equal(store.evidenceForVerification(claim).length, 0);
  } finally {
    context.close();
  }
});

test('助手消息不能作为用户习惯证据', () => {
  const context = fixture();
  try {
    const assistantTurn = context.lifecycle.recordTurn({
      userId: 'alice',
      namespace: 'personal',
      clientName: 'client',
      sessionExternalId: 'pattern-session',
      turnExternalId: 'assistant-cannot-testify',
      role: 'assistant',
      content: '用户每个工作日前喝桂花乌龙。',
      occurredAt: '2026-08-13T08:00:00.000Z',
    }).turn;
    assert.throws(() => new PatternObservationStore(context.database).observe({
      ...claim,
      turnId: assistantTurn.id,
      excerpt: assistantTurn.content,
      runId: null,
      state: 'supporting',
      timestamp: '2026-08-13T12:00:00.000Z',
    }), /所有权/u);
  } finally {
    context.close();
  }
});

test('150/180/210/240 的四条稀疏证据跨两个窗口累计后晋升一次', async () => {
  const context = fixture();
  try {
    const signalTurns = new Map<string, string>();
    for (let index = 1; index <= 240; index += 1) {
      const signal = [150, 180, 210, 240].includes(index);
      const content = signal
        ? `时间轴 ${index}：工作日前继续喝桂花乌龙。`
        : `时间轴 ${index}：普通无关记录。`;
      const turn = context.record(
        `timeline-${index}`,
        content,
        new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
      );
      if (signal) signalTurns.set(turn.id, content);
    }
    const providerCalls: Array<{ phase: string; evidence: number }> = [];
    const provider: ReflectionProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'cross-window-observation-v1',
      async reflect(input) {
        const evidence = input.turns.filter((turn) =>
          turn.content.includes('桂花乌龙')
        );
        providerCalls.push({
          phase: input.phase || 'discover',
          evidence: evidence.length,
        });
        return {
          candidates: evidence.length === 0 ? [] : [{
            kind: 'preference',
            subject: '用户',
            predicate: '工作日饮品',
            value: '桂花乌龙',
            confidence: 0.9,
            importance: 0.7,
            sensitivity: 'normal',
            negated: false,
            observationType: 'stable_pattern',
            evidence: evidence.map((turn) => ({
              turnAlias: turn.turnAlias,
              excerpt: turn.content,
            })),
          }],
        };
      },
    };
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'unused',
      extractorId: 'unused',
      extractorVersion: 'unused',
      async extract() { return []; },
    };
    const service = new MemoryReflectionService(
      context.database,
      context.lifecycle,
      extractor,
      provider,
      {
        maxTurns: 200,
        minNewTurns: 1,
        minPatternEvidence: 3,
        lookbackDays: 365,
        clock: () => new Date('2026-08-13T12:00:00.000Z'),
      },
    );
    const execute = async (worker: string) => {
      const queued = service.queueRun({
        userId: 'alice',
        namespace: 'personal',
        scopeType: 'personal',
        scopeKey: 'self',
        runType: 'reflect',
        trigger: 'manual',
        requestedBy: 'alice',
      });
      return service.executeRun(queued.run.id, worker);
    };

    const first = await execute('cross-window-worker-1');
    assert.equal(first.candidates.length, 0, '前两条观察不能晋升');
    const firstProviderCalls = providerCalls.slice();
    const second = await execute('cross-window-worker-2');
    assert.equal(second.candidates.length, 1);
    const secondProviderCalls = providerCalls.slice(firstProviderCalls.length);
    assert.equal(
      firstProviderCalls
        .filter((call) => call.phase === 'discover')
        .reduce((total, call) => total + call.evidence, 0),
      2,
      '首个窗口的两条稀疏证据都应进入发现阶段',
    );
    assert.equal(
      secondProviderCalls
        .filter((call) => call.phase === 'discover')
        .reduce((total, call) => total + call.evidence, 0),
      2,
      '第二个窗口的两条稀疏证据都应进入发现阶段',
    );
    assert.deepEqual(
      providerCalls.filter((call) => call.phase === 'verify'),
      [{ phase: 'verify', evidence: 4 }],
      '跨窗口累计四条证据后只应验证并晋升一次',
    );
    assert.equal(
      context.database.prepare(
        `SELECT COUNT(DISTINCT turn_id) AS count
         FROM memory_pattern_observations
         WHERE observation_state = 'supporting'`,
      ).get()?.count,
      4,
    );
    assert.equal(
      context.database.prepare(
        'SELECT COUNT(*) AS count FROM memory_candidates',
      ).get()?.count,
      1,
    );
  } finally {
    context.close();
  }
});
