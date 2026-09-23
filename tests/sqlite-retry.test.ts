import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSqliteBusyError,
  withSqliteBusyRetry,
} from '../src/server/sqlite-retry.js';

test('SQLite busy retry 只重试锁错误并在有限次数内成功', () => {
  let attempts = 0;
  const retries: number[] = [];
  const result = withSqliteBusyRetry(
    () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error('database is locked'), {
          errcode: 5,
        });
      }
      return 'ready';
    },
    {
      operation: 'test busy retry',
      maxAttempts: 4,
      totalBudgetMs: 100,
      initialDelayMs: 1,
      maximumDelayMs: 1,
      jitterRatio: 0,
      onRetry: (event) => retries.push(event.attempt),
    },
  );

  assert.equal(result, 'ready');
  assert.equal(attempts, 3);
  assert.deepEqual(retries, [1, 2]);
  assert.equal(isSqliteBusyError(new Error('database is busy')), true);
});

test('SQLite busy retry 对非锁错误立即抛出且不重试', () => {
  let attempts = 0;
  const failure = new Error('schema invariant failed');
  assert.throws(
    () => withSqliteBusyRetry(
      () => {
        attempts += 1;
        throw failure;
      },
      {
        operation: 'test non-busy failure',
        maxAttempts: 8,
        totalBudgetMs: 15_000,
      },
    ),
    (error: unknown) => error === failure,
  );
  assert.equal(attempts, 1);
});

test('SQLite busy retry 达到明确尝试上限后保留原始错误', () => {
  let attempts = 0;
  const failure = Object.assign(new Error('SQLITE_BUSY'), { errcode: 5 });
  assert.throws(
    () => withSqliteBusyRetry(
      () => {
        attempts += 1;
        throw failure;
      },
      {
        operation: 'test exhausted busy retry',
        maxAttempts: 2,
        totalBudgetMs: 100,
        initialDelayMs: 1,
        maximumDelayMs: 1,
        jitterRatio: 0,
      },
    ),
    (error: unknown) => error === failure,
  );
  assert.equal(attempts, 2);
});
