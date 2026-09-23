const SQLITE_BUSY_CODE = 5;
const SQLITE_LOCKED_CODE = 6;
const SLEEP_STATE = new Int32Array(new SharedArrayBuffer(4));

export interface SqliteBusyRetryEvent {
  operation: string;
  attempt: number;
  delayMs: number;
  elapsedMs: number;
}

export interface SqliteBusyRetryOptions {
  operation: string;
  maxAttempts?: number;
  totalBudgetMs?: number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
  jitterRatio?: number;
  onRetry?: (event: SqliteBusyRetryEvent) => void;
}

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_TOTAL_BUDGET_MS = 15_000;
const DEFAULT_INITIAL_DELAY_MS = 20;
const DEFAULT_MAXIMUM_DELAY_MS = 400;
const DEFAULT_JITTER_RATIO = 0.25;

function numericErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value = (error as { errcode?: unknown }).errcode;
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

export function isSqliteBusyError(error: unknown): boolean {
  const numericCode = numericErrorCode(error);
  if (
    numericCode === SQLITE_BUSY_CODE ||
    numericCode === SQLITE_LOCKED_CODE
  ) {
    return true;
  }
  if (!(error instanceof Error)) return false;
  const symbolicCode = String(
    (error as Error & { code?: unknown }).code ?? '',
  );
  return (
    symbolicCode === 'SQLITE_BUSY' ||
    symbolicCode === 'SQLITE_LOCKED' ||
    /\bSQLITE_(?:BUSY|LOCKED)\b|database is (?:locked|busy)/iu.test(
      error.message,
    )
  );
}

function sleep(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(SLEEP_STATE, 0, 0, milliseconds);
}

export function withSqliteBusyRetry<T>(
  operation: () => T,
  options: SqliteBusyRetryOptions,
): T {
  const maxAttempts = Math.max(
    1,
    Math.min(100, Math.trunc(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)),
  );
  const totalBudgetMs = Math.max(
    0,
    Math.trunc(options.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS),
  );
  const initialDelayMs = Math.max(
    0,
    Math.trunc(options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS),
  );
  const maximumDelayMs = Math.max(
    initialDelayMs,
    Math.trunc(options.maximumDelayMs ?? DEFAULT_MAXIMUM_DELAY_MS),
  );
  const jitterRatio = Math.max(
    0,
    Math.min(1, options.jitterRatio ?? DEFAULT_JITTER_RATIO),
  );
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;
      const elapsedMs = Date.now() - startedAt;
      if (attempt >= maxAttempts || elapsedMs >= totalBudgetMs) {
        throw error;
      }
      const exponentialDelay = Math.min(
        maximumDelayMs,
        initialDelayMs * 2 ** Math.max(0, attempt - 1),
      );
      const jitter = exponentialDelay * jitterRatio *
        (Math.random() * 2 - 1);
      const delayMs = Math.max(
        0,
        Math.min(
          Math.round(exponentialDelay + jitter),
          totalBudgetMs - elapsedMs,
        ),
      );
      if (delayMs <= 0) throw error;
      options.onRetry?.({
        operation: options.operation,
        attempt,
        delayMs,
        elapsedMs,
      });
      sleep(delayMs);
    }
  }

  throw new Error(`${options.operation} SQLite busy retry 意外退出`);
}
