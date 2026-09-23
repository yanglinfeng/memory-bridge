import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Ban,
  CheckCircle2,
  Eye,
  History,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { api } from '../api';
import type {
  MemoryAccessScope,
  ReflectionPreview,
  ReflectionRun,
  ReflectionRunDetail,
  ReflectionStatus,
} from '../types';

const STATUS_LABELS: Record<ReflectionRun['status'], string> = {
  pending: '排队中',
  running: '运行中',
  completed: '已完成',
  partial: '部分完成',
  failed: '失败',
  dead: '已终止',
  cancelled: '已取消',
};

const RUN_LABELS: Record<ReflectionRun['runType'], string> = {
  reextract: '历史事实重提取',
  reflect: '跨多轮反思',
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value));
}

export function ReflectionCenter({
  onToast,
}: {
  onToast: (message: string, error?: boolean) => void;
}) {
  const [namespace, setNamespace] = useState('personal');
  const [scopeType, setScopeType] = useState<
    MemoryAccessScope['scopeType']
  >('personal');
  const [scopeKey, setScopeKey] = useState('self');
  const [status, setStatus] = useState<ReflectionStatus | null>(null);
  const [runs, setRuns] = useState<ReflectionRun[]>([]);
  const [preview, setPreview] = useState<ReflectionPreview | null>(null);
  const [detail, setDetail] = useState<ReflectionRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const scope = useMemo(() => ({
    namespace: namespace.trim() || 'personal',
    scopeType,
    scopeKey: scopeKey.trim() || (scopeType === 'personal' ? 'self' : ''),
  }), [namespace, scopeKey, scopeType]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [nextStatus, nextRuns] = await Promise.all([
        api.reflectionStatus(namespace.trim() || 'personal'),
        api.reflectionRuns(),
      ]);
      setStatus(nextStatus);
      setRuns(nextRuns);
    } catch (error) {
      if (!silent) {
        onToast(
          error instanceof Error ? error.message : '读取历史重提炼状态失败',
          true,
        );
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [namespace, onToast]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const changeScope = (
    nextType: MemoryAccessScope['scopeType'],
  ) => {
    setScopeType(nextType);
    setScopeKey(nextType === 'personal' ? 'self' : '');
    setPreview(null);
  };

  const runPreview = async () => {
    if (!scope.scopeKey) {
      onToast('非 personal 作用域必须填写 scope key', true);
      return;
    }
    setBusy('preview');
    try {
      setPreview(await api.previewReflection(scope));
      onToast('预览完成，没有写入运行或候选');
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '预览失败',
        true,
      );
    } finally {
      setBusy(null);
    }
  };

  const queue = async (runType: 'reextract' | 'reflect') => {
    if (!preview) {
      onToast('请先预览本次历史窗口', true);
      return;
    }
    setBusy(runType);
    try {
      const queued = await api.queueReflection(runType, scope);
      onToast(
        queued.created
          ? `${RUN_LABELS[runType]}已进入队列`
          : '相同窗口和版本已有运行，已返回原运行',
      );
      setPreview(null);
      await load(true);
      setDetail(await api.reflectionRun(queued.run.id));
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '创建运行失败',
        true,
      );
    } finally {
      setBusy(null);
    }
  };

  const setMode = async (mode: 'off' | 'shadow') => {
    setBusy(`mode-${mode}`);
    try {
      setStatus(await api.setReflectionMode(scope.namespace, mode));
      onToast(mode === 'shadow' ? '自动重提炼已启用' : '自动重提炼已关闭');
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '更新运行模式失败',
        true,
      );
    } finally {
      setBusy(null);
    }
  };

  const selectRun = async (run: ReflectionRun) => {
    setBusy(`detail-${run.id}`);
    try {
      setDetail(await api.reflectionRun(run.id));
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '读取运行详情失败',
        true,
      );
    } finally {
      setBusy(null);
    }
  };

  const retry = async (run: ReflectionRun) => {
    setBusy(`retry-${run.id}`);
    try {
      const updated = await api.retryReflectionRun(run.id);
      onToast('运行已重新排队');
      await load(true);
      setDetail(await api.reflectionRun(updated.id));
    } catch (error) {
      onToast(error instanceof Error ? error.message : '重试失败', true);
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (run: ReflectionRun) => {
    setBusy(`cancel-${run.id}`);
    try {
      const updated = await api.cancelReflectionRun(run.id);
      onToast(updated.status === 'cancelled' ? '运行已取消' : '已请求取消');
      await load(true);
      setDetail(await api.reflectionRun(updated.id));
    } catch (error) {
      onToast(error instanceof Error ? error.message : '取消失败', true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="page reflection-page">
      <header className="page-header">
        <div>
          <h1>历史重提炼</h1>
          <p>重新扫描历史事实、发现跨多轮模式；所有推断只进入待确认，不会自动写入。</p>
        </div>
        <button className="button secondary" onClick={() => void load()}>
          <RefreshCw size={16} />刷新
        </button>
      </header>

      {loading ? (
        <div className="center-message">正在读取历史重提炼状态…</div>
      ) : (
        <>
          <section className="reflection-overview" aria-label="运行概览">
            <article>
              <span>运行模式</span>
              <strong>{status?.mode === 'shadow' ? '影子运行' : '已关闭'}</strong>
              <div className="inline-actions">
                <button
                  className="button secondary"
                  disabled={busy !== null || status?.mode === 'shadow'}
                  onClick={() => void setMode('shadow')}
                >启用</button>
                <button
                  className="button secondary"
                  disabled={busy !== null || status?.mode === 'off'}
                  onClick={() => void setMode('off')}
                >关闭</button>
              </div>
            </article>
            <article>
              <span>今日模型调用</span>
              <strong>{status?.callsUsedToday || 0} / {status?.dailyCallLimit || 0}</strong>
              <small>失败调用也计入真实成本</small>
            </article>
            <article>
              <span>待处理 ingest lag</span>
              <strong>{status?.checkpointLag || 0}</strong>
              <small>
                {status?.pipelineLags.filter((pipeline) => pipeline.lag > 0).length || 0}
                {' '}条 scope/pipeline 落后
              </small>
            </article>
            <article>
              <span>运行健康</span>
              <strong>
                {status
                  ? `${status.runCounts.running} 运行 / ${status.runCounts.failed + status.runCounts.dead} 异常`
                  : '—'}
              </strong>
              <small>{status?.checkpoints.length || 0} 个 checkpoint</small>
            </article>
          </section>

          <section className="panel reflection-control">
            <div className="section-heading">
              <div>
                <h2>创建运行</h2>
                <p>预览是只读操作；确认后才会固定 turn 清单并进入队列。</p>
              </div>
            </div>
            <div className="reflection-scope-grid">
              <label className="field">
                <span>Namespace</span>
                <input
                  value={namespace}
                  onChange={(event) => {
                    setNamespace(event.target.value);
                    setPreview(null);
                  }}
                />
              </label>
              <label className="field">
                <span>作用域类型</span>
                <select
                  value={scopeType}
                  onChange={(event) => changeScope(
                    event.target.value as MemoryAccessScope['scopeType'],
                  )}
                >
                  <option value="personal">personal</option>
                  <option value="project">project</option>
                  <option value="role">role</option>
                  <option value="session">session</option>
                </select>
              </label>
              <label className="field">
                <span>Scope key</span>
                <input
                  value={scopeKey}
                  disabled={scopeType === 'personal'}
                  placeholder={scopeType === 'personal' ? 'self' : '请输入可信 ID'}
                  onChange={(event) => {
                    setScopeKey(event.target.value);
                    setPreview(null);
                  }}
                />
              </label>
              <button
                className="button secondary reflection-preview-button"
                disabled={busy !== null}
                onClick={() => void runPreview()}
              >
                <Eye size={16} />预览窗口
              </button>
            </div>

            {preview && (
              <div className="reflection-preview" role="status">
                <div>
                  <strong>{preview.pipelines.reextract.turnCount}</strong>
                  <span>待事实重提取</span>
                </div>
                <div>
                  <strong>≈ {preview.pipelines.reextract.estimatedTokens}</strong>
                  <span>重提取 token</span>
                </div>
                <div>
                  <strong>{preview.pipelines.reflect.turnCount}</strong>
                  <span>待跨轮反思</span>
                </div>
                <div>
                  <strong>≈ {preview.pipelines.reflect.estimatedTokens}</strong>
                  <span>反思 token</span>
                </div>
                <small>
                  窗口：{formatDate(preview.turns[0]?.occurredAt || null)} —{' '}
                  {formatDate(preview.turns.at(-1)?.occurredAt || null)}
                </small>
                {(preview.pipelines.reextract.blockedTurn ||
                  preview.pipelines.reflect.blockedTurn) && (
                  <small className="danger-text">
                    有 turn 超过单窗口 token 预算，已停在该 turn 之前，
                    checkpoint 不会跳过它。
                  </small>
                )}
                <div className="inline-actions">
                  <button
                    className="button secondary"
                    disabled={
                      busy !== null ||
                      preview.pipelines.reextract.turnCount === 0
                    }
                    onClick={() => void queue('reextract')}
                  >
                    <History size={16} />开始事实重提取
                  </button>
                  <button
                    className="button primary"
                    disabled={
                      busy !== null || preview.pipelines.reflect.turnCount === 0
                    }
                    onClick={() => void queue('reflect')}
                  >
                    <Sparkles size={16} />开始跨多轮反思
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="section-heading">
              <div><h2>运行记录</h2><p>点击一条运行查看完整事件链。</p></div>
            </div>
            {runs.length === 0 ? (
              <div className="compact-empty">还没有历史重提炼运行。</div>
            ) : (
              <div className="reflection-run-list">
                {runs.map((run) => (
                  <article
                    key={run.id}
                    className={detail?.run.id === run.id ? 'selected' : ''}
                  >
                    <button
                      className="reflection-run-main"
                      disabled={busy === `detail-${run.id}`}
                      onClick={() => void selectRun(run)}
                    >
                      <span className={`run-status status-${run.status}`}>
                        {STATUS_LABELS[run.status]}
                      </span>
                      <strong>{RUN_LABELS[run.runType]}</strong>
                      <span>{run.scopeType} / {run.scopeKey}</span>
                      <span>{run.inputTurnCount} turns · {run.candidateCount} candidates</span>
                      <time>{formatDate(run.createdAt)}</time>
                    </button>
                    <div className="inline-actions">
                      {(run.status === 'failed' || run.status === 'dead') && (
                        <button
                          className="icon-button"
                          aria-label="重试运行"
                          title="重试运行"
                          disabled={busy !== null}
                          onClick={() => void retry(run)}
                        ><RotateCcw size={16} /></button>
                      )}
                      {(run.status === 'pending' || run.status === 'running') && (
                        <button
                          className="icon-button danger-text"
                          aria-label="取消运行"
                          title="取消运行"
                          disabled={busy !== null}
                          onClick={() => void cancel(run)}
                        ><Ban size={16} /></button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          {detail && (
            <section className="panel reflection-detail">
              <div className="section-heading">
                <div>
                  <h2>运行事件</h2>
                  <p><code>{detail.run.id}</code></p>
                </div>
                {detail.run.status === 'completed' && <CheckCircle2 size={22} />}
              </div>
              <dl className="candidate-meta">
                <div><dt>模型</dt><dd>{detail.run.model}</dd></div>
                <div><dt>Prompt</dt><dd>{detail.run.promptVersion}</dd></div>
                <div><dt>Generation</dt><dd><code>{detail.run.generationKey.slice(0, 16)}</code></dd></div>
                <div><dt>尝试</dt><dd>{detail.run.attempts} / {detail.run.maxAttempts}</dd></div>
                <div><dt>候选</dt><dd>{detail.run.pendingCount} 待确认 / {detail.run.rejectedCount} 拒绝</dd></div>
                <div><dt>错误</dt><dd>{detail.run.lastError || '—'}</dd></div>
              </dl>
              <h3>模型调用账本</h3>
              {detail.modelCalls.length === 0 ? (
                <div className="compact-empty">这条运行还没有模型调用。</div>
              ) : (
                <ol className="reflection-events">
                  {detail.modelCalls.map((call) => (
                    <li key={call.id}>
                      <Play size={13} />
                      <div>
                        <strong>{call.callType} / {call.status}</strong>
                        <time>{formatDate(call.reservedAt)}</time>
                        <pre>{JSON.stringify({
                          model: call.model,
                          estimatedTokens: call.estimatedTokens,
                          completedAt: call.completedAt,
                          error: call.error,
                        }, null, 2)}</pre>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              <h3>运行事件</h3>
              <ol className="reflection-events">
                {detail.events.map((event) => (
                  <li key={event.id}>
                    <Play size={13} />
                    <div>
                      <strong>{event.eventType}</strong>
                      <time>{formatDate(event.createdAt)}</time>
                      <pre>{JSON.stringify(event.detail, null, 2)}</pre>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </>
      )}
    </main>
  );
}
