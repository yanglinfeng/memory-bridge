import { AsyncLocalStorage } from 'node:async_hooks';

let foregroundCount = 0;
let lastForegroundActivityAt = 0;
const backgroundControllers = new Set<AbortController>();
const backgroundSignalStorage = new AsyncLocalStorage<AbortSignal>();

export class BackgroundModelPreemptedError extends Error {
  constructor() {
    super('前台请求到达，后台模型调用已让权');
    this.name = 'BackgroundModelPreemptedError';
  }
}

export interface ModelQosSnapshot {
  foregroundCount: number;
  lastForegroundActivityAt: number;
  quietForMs: number;
}

export interface ModelRuntimeStatus {
  foregroundCount: number;
  lastForegroundActivityAt: number | null;
  quietForMs: number | null;
  foregroundQuietMs: number;
  backgroundWorkAllowed: boolean;
}

export function beginForegroundActivity(
  now: () => number = Date.now,
  maxLeaseMs = 5 * 60_000,
): () => void {
  foregroundCount += 1;
  lastForegroundActivityAt = now();
  for (const controller of backgroundControllers) {
    if (!controller.signal.aborted) {
      controller.abort(new BackgroundModelPreemptedError());
    }
  }
  let released = false;
  let leaseTimer: ReturnType<typeof setTimeout> | null = null;
  const release = () => {
    if (released) return;
    released = true;
    if (leaseTimer) clearTimeout(leaseTimer);
    leaseTimer = null;
    foregroundCount = Math.max(0, foregroundCount - 1);
    lastForegroundActivityAt = now();
  };
  if (maxLeaseMs > 0) {
    leaseTimer = setTimeout(release, maxLeaseMs);
    leaseTimer.unref?.();
  }
  return release;
}

export async function runWithBackgroundModelQos<T>(
  operation: () => T | Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  backgroundControllers.add(controller);
  if (foregroundCount > 0) {
    controller.abort(new BackgroundModelPreemptedError());
  }
  try {
    return await backgroundSignalStorage.run(
      controller.signal,
      operation,
    );
  } finally {
    backgroundControllers.delete(controller);
  }
}

export function backgroundModelAbortSignal(
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(
    Math.max(1, Math.trunc(timeoutMs)),
  );
  const backgroundSignal = backgroundSignalStorage.getStore();
  return backgroundSignal
    ? AbortSignal.any([backgroundSignal, timeoutSignal])
    : timeoutSignal;
}

export function isBackgroundModelPreempted(error: unknown): boolean {
  return error instanceof BackgroundModelPreemptedError ||
    backgroundSignalStorage.getStore()?.reason instanceof
      BackgroundModelPreemptedError;
}

export function backgroundModelWorkAllowed(
  quietPeriodMs: number,
  now: () => number = Date.now,
): boolean {
  if (foregroundCount > 0) return false;
  if (lastForegroundActivityAt === 0) return true;
  return now() - lastForegroundActivityAt >= Math.max(0, quietPeriodMs);
}

export function modelQosSnapshot(
  now: () => number = Date.now,
): ModelQosSnapshot {
  return {
    foregroundCount,
    lastForegroundActivityAt,
    quietForMs: lastForegroundActivityAt === 0
      ? Number.POSITIVE_INFINITY
      : Math.max(0, now() - lastForegroundActivityAt),
  };
}

export function modelRuntimeStatus(
  quietPeriodMs: number,
  now: () => number = Date.now,
): ModelRuntimeStatus {
  const snapshot = modelQosSnapshot(now);
  return {
    foregroundCount: snapshot.foregroundCount,
    lastForegroundActivityAt:
      snapshot.lastForegroundActivityAt || null,
    quietForMs: Number.isFinite(snapshot.quietForMs)
      ? snapshot.quietForMs
      : null,
    foregroundQuietMs: Math.max(0, quietPeriodMs),
    backgroundWorkAllowed: backgroundModelWorkAllowed(
      quietPeriodMs,
      now,
    ),
  };
}

export function resetModelQosForTests(): void {
  for (const controller of backgroundControllers) {
    if (!controller.signal.aborted) {
      controller.abort(new BackgroundModelPreemptedError());
    }
  }
  backgroundControllers.clear();
  foregroundCount = 0;
  lastForegroundActivityAt = 0;
}
