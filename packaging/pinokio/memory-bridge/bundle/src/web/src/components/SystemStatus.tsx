import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  Layers3,
  RefreshCw,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { api } from '../api';
import type {
  ConsolidationSummary,
  PurgeJob,
  SystemHealthSnapshot,
  Tombstone,
} from '../types';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function qualityLabel(value: SystemHealthSnapshot['quality']): string {
  if (value === 'full') return '完整';
  if (value === 'degraded') return '降级';
  return '不可用';
}

function recoveryModeLabel(
  value: SystemHealthSnapshot['deadLetters'][number]['recoveryMode'],
): string {
  if (value === 'recompute') return '重新计算';
  if (value === 'repair') return '定向修复';
  if (value === 'supersede') return '人工终止';
  if (value === 'system_takeover') return '系统接管';
  return '未知方式';
}

function shortFingerprint(value: string | null): string {
  return value ? value.slice(0, 12) : '—';
}

export function SystemStatus({
  onToast,
}: {
  onToast: (message: string, error?: boolean) => void;
}) {
  const [health, setHealth] = useState<SystemHealthSnapshot | null>(null);
  const [consolidations, setConsolidations] = useState<ConsolidationSummary[]>([]);
  const [tombstones, setTombstones] = useState<Tombstone[]>([]);
  const [purgeJobs, setPurgeJobs] = useState<PurgeJob[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextHealth, nextConsolidations, nextTombstones, nextPurgeJobs] =
        await Promise.all([
          api.systemHealth(),
          api.consolidations(),
          api.tombstones(),
          api.purgeJobs(),
        ]);
      setHealth(nextHealth);
      setConsolidations(nextConsolidations);
      setTombstones(nextTombstones);
      setPurgeJobs(nextPurgeJobs);
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '读取系统状态失败',
        true,
      );
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (loading && !health) {
    return (
      <main className="page system-page">
        <div className="center-message">正在检查长期记忆系统…</div>
      </main>
    );
  }

  return (
    <main className="page system-page">
      <header className="page-header">
        <div>
          <h1>系统状态</h1>
          <p>检查自动提取、索引、模型、巩固和物理清除是否真正运行。</p>
        </div>
        <button className="button secondary" onClick={() => void load()}>
          <RefreshCw size={16} />刷新
        </button>
      </header>

      {health && (
        <>
          <section className="health-grid">
            <article className={`health-card quality-${health.quality}`}>
              <span><Activity size={18} />服务质量</span>
              <strong>{qualityLabel(health.quality)}</strong>
              <small>{formatDate(health.timestamp)}</small>
            </article>
            <article className={health.ollamaAvailable
              ? 'health-card quality-full'
              : 'health-card quality-unavailable'}
            >
              <span><Server size={18} />Ollama</span>
              <strong>{health.ollamaAvailable ? '可用' : '不可用'}</strong>
              <small>{health.availableModels.length} 个本地模型</small>
            </article>
            <article className={health.index.lag === 0
              ? 'health-card quality-full'
              : 'health-card quality-degraded'}
            >
              <span><Database size={18} />索引积压</span>
              <strong>{health.index.lag}</strong>
              <small>{health.index.activeMemories} 条有效记忆</small>
            </article>
            <article className={health.deadLetterCount === 0
              ? 'health-card quality-full'
              : 'health-card quality-unavailable'}
            >
              <span><AlertTriangle size={18} />死信任务</span>
              <strong>{health.deadLetterCount}</strong>
              <small>
                {health.deadLetterHistoryCount} 条历史 / {' '}
                {health.automation.retryingJobCount} 个重试中
              </small>
            </article>
          </section>

          <section className="status-columns">
            <article className="status-panel">
              <header><Layers3 size={18} /><h2>索引水位</h2></header>
              <dl className="metric-list">
                <div><dt>有效记忆</dt><dd>{health.index.activeMemories}</dd></div>
                <div><dt>FTS5</dt><dd>{health.index.ftsMemories}</dd></div>
                <div><dt>ANN</dt><dd>{health.index.annMemories}</dd></div>
                <div><dt>实体/概念</dt><dd>{health.index.termMemories}</dd></div>
                <div><dt>语义向量</dt><dd>{health.index.embeddingMemories}</dd></div>
                <div>
                  <dt>Dense ANN 水位</dt>
                  <dd>
                    {health.index.denseIndexed}/
                    {health.index.denseEligible}
                  </dd>
                </div>
                <div>
                  <dt>Dense 世代</dt>
                  <dd>
                    {health.index.denseIndexVersion} ·
                    {' '}{health.index.denseDimensions ?? '未探测'} 维
                  </dd>
                </div>
              </dl>
            </article>
            <article className="status-panel">
              <header><Clock3 size={18} /><h2>自动化</h2></header>
              <dl className="metric-list">
                <div>
                  <dt>平均提取延迟</dt>
                  <dd>
                    {health.automation.averageExtractionLatencyMs === null
                      ? '暂无运行'
                      : `${Math.round(
                          health.automation.averageExtractionLatencyMs,
                        )} ms`}
                  </dd>
                </div>
                <div>
                  <dt>提取失败</dt>
                  <dd>{health.automation.failedExtractionCount}</dd>
                </div>
                <div>
                  <dt>过期摘要</dt>
                  <dd>{health.automation.staleConsolidationCount}</dd>
                </div>
                <div>
                  <dt>隔离摘要</dt>
                  <dd>{health.automation.quarantinedConsolidationCount}</dd>
                </div>
                <div>
                  <dt>前台模型请求</dt>
                  <dd>{health.modelRuntime.foregroundCount}</dd>
                </div>
                <div>
                  <dt>后台模型任务</dt>
                  <dd>
                    {health.modelRuntime.backgroundWorkAllowed
                      ? '可运行'
                      : '让权中'}
                  </dd>
                </div>
                <div>
                  <dt>前台安静窗口</dt>
                  <dd>{health.modelRuntime.foregroundQuietMs} ms</dd>
                </div>
                <div>
                  <dt>模型常驻</dt>
                  <dd>{health.modelRuntime.keepAlive}</dd>
                </div>
              </dl>
            </article>
            <article className="status-panel">
              <header><Server size={18} /><h2>模型角色</h2></header>
              <dl className="metric-list model-list">
                <div><dt>AIRI 聊天</dt><dd>{health.models.chat}</dd></div>
                <div><dt>查询理解</dt><dd>{health.models.query}</dd></div>
                <div><dt>提取</dt><dd>{health.models.extraction}</dd></div>
                <div><dt>关系判断</dt><dd>{health.models.relation}</dd></div>
                <div><dt>自然意图</dt><dd>{health.models.explicitIntent}</dd></div>
                <div><dt>巩固</dt><dd>{health.models.consolidation}</dd></div>
                <div><dt>历史反思</dt><dd>{health.models.reflection}</dd></div>
                <div><dt>Embedding</dt><dd>{health.models.embedding}</dd></div>
                <div><dt>重排</dt><dd>{health.models.reranker}</dd></div>
              </dl>
              {health.missingModels.length > 0 && (
                <p className="model-missing-warning">
                  <AlertTriangle size={15} />
                  缺失模型：{health.missingModels.join('、')}
                </p>
              )}
            </article>
          </section>

          <section className="status-panel status-wide">
            <header><Activity size={18} /><h2>任务队列</h2></header>
            {health.queues.length ? (
              <div className="compact-table">
                <div className="compact-row compact-head">
                  <span>任务</span><span>状态</span><span>数量</span><span>最早可运行</span>
                </div>
                {health.queues.map((queue) => (
                  <div
                    className="compact-row"
                    key={`${queue.jobType}-${queue.status}`}
                  >
                    <code>{queue.jobType}</code>
                    <span>{queue.status}</span>
                    <strong>{queue.count}</strong>
                    <time>{formatDate(queue.oldestAvailableAt)}</time>
                  </div>
                ))}
              </div>
            ) : (
              <p className="panel-empty">当前没有积压或失败任务。</p>
            )}
          </section>

          {health.deadLetters.length > 0 && (
            <section className="status-panel status-wide">
              <header>
                <AlertTriangle size={18} />
                <h2>死信历史（恢复后仍保留）</h2>
              </header>
              <div className="compact-table">
                <div className="compact-row compact-head">
                  <span>任务</span>
                  <span>命名空间 / 次数</span>
                  <span>最后错误</span>
                  <span>失败时间</span>
                </div>
                {health.deadLetters.map((item) => (
                  <div className="compact-row" key={item.jobId}>
                    <code>{item.jobType}</code>
                    <span>
                      {item.namespace} / {item.attempts} / {' '}
                      {item.resolved
                        ? `${recoveryModeLabel(item.recoveryMode)}` +
                          `（${item.recoveryStatus}）`
                        : item.recoveryJobId
                          ? `${recoveryModeLabel(item.recoveryMode)}处理中` +
                            `（${item.recoveryStatus}）`
                          : '未处理'}
                    </span>
                    <span title={item.lastError}>{item.lastError}</span>
                    <time>{formatDate(item.failedAt)}</time>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="status-panel status-wide">
            <header>
              <Clock3 size={18} />
              <h2>最近任务尝试与补偿</h2>
            </header>
            {health.jobAttempts.length > 0 ? (
              <div className="compact-table">
                <div className="compact-row compact-head">
                  <span>任务 / 结果</span>
                  <span>Attempt / 状态</span>
                  <span>补偿 / No-op</span>
                  <span>模型耗时 / 时间</span>
                </div>
                {health.jobAttempts.map((attempt, index) => (
                  <div
                    className="compact-row"
                    key={`${attempt.jobId}-${attempt.attempt}-${index}`}
                  >
                    <span>
                      <code>{attempt.jobType}</code>
                      {' · '}
                      {attempt.outcome === 'completed' ? '完成' : '失败'}
                      {attempt.failureClass
                        ? `（${attempt.failureClass}）`
                        : ''}
                    </span>
                    <span>
                      {attempt.attempt}/{attempt.maxAttempts}
                      {' · '}{attempt.nextState || '—'}
                      {attempt.retryable === null
                        ? ''
                        : attempt.retryable ? ' · 可重试' : ' · 不再重试'}
                    </span>
                    <span className="attempt-diagnostic-cell">
                    <span>
                      {attempt.recoveryStrategy
                        ? `策略：${attempt.recoveryStrategy} · `
                        : ''}
                      {attempt.compensationAction || '无补偿'}
                        {' · '}
                        {attempt.noopReason
                          ? `No-op：${attempt.noopReason}`
                          : attempt.resultStatus || '非 No-op'}
                        {attempt.repeatedFingerprint === true
                          ? ' · 重复指纹已熔断'
                          : ''}
                      </span>
                      <code
                        title={[
                          attempt.inputFingerprint,
                          attempt.outputFingerprint,
                          attempt.errorFingerprint,
                        ].filter(Boolean).join('\n')}
                      >
                        in {shortFingerprint(attempt.inputFingerprint)} /{' '}
                        out {shortFingerprint(attempt.outputFingerprint)} /{' '}
                        err {shortFingerprint(attempt.errorFingerprint)}
                      </code>
                      {attempt.missingSourceIds.length > 0 && (
                        <small>
                          缺失来源 {attempt.missingSourceIds.length} 条
                        </small>
                      )}
                    </span>
                    <span>
                      {attempt.modelDurationMs === null
                        ? '无模型耗时'
                        : `${attempt.modelDurationMs.toFixed(1)} ms`}
                      {' · '}{formatDate(attempt.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="panel-empty">当前还没有任务 attempt 诊断记录。</p>
            )}
          </section>

          <section className="status-panel status-wide">
            <header><Layers3 size={18} /><h2>Dense 双索引世代</h2></header>
            {health.denseIndex.generations.length ? (
              <div className="compact-table">
                <div className="compact-row dense-generation-row compact-head">
                  <span>角色 / 模型</span>
                  <span>状态 / 维度</span>
                  <span>固定评测</span>
                  <span>世代</span>
                </div>
                {health.denseIndex.generations.map((generation) => (
                  <div
                    className="compact-row dense-generation-row"
                    key={`${generation.role}-${generation.generationId}`}
                  >
                    <span>
                      <strong>{generation.role}</strong>
                      {' · '}{generation.embeddingModel}
                    </span>
                    <span>
                      {generation.status} · {generation.dimensions} 维
                    </span>
                    <span>
                      {generation.evaluation
                        ? `${generation.evaluation.passed ? 'PASS' : 'FAIL'} · ` +
                          `R@20 ${(generation.evaluation.recallAt20 * 100)
                            .toFixed(1)}% · ` +
                          `MRR ${(generation.evaluation.mrrAt10 * 100)
                            .toFixed(1)}%`
                        : '等待固定评测'}
                    </span>
                    <code title={generation.generationId}>
                      {generation.generationId.slice(-12)}
                    </code>
                    {generation.failureReason && (
                      <small className="dense-generation-error">
                        {generation.failureReason}
                      </small>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="panel-empty">尚未注册 Dense generation。</p>
            )}
            {health.denseIndex.alias && (
              <p className="panel-footnote">
                alias revision {health.denseIndex.alias.revision}
                {' · '}更新于 {formatDate(health.denseIndex.alias.updatedAt)}
              </p>
            )}
          </section>
        </>
      )}

      <section className="status-panel status-wide">
        <header><Layers3 size={18} /><h2>派生巩固</h2></header>
        {consolidations.length ? (
          <div className="compact-table">
            <div className="compact-row consolidation-row compact-head">
              <span>范围</span><span>状态</span><span>来源</span><span>生成时间</span>
            </div>
            {consolidations.map((item) => (
              <div className="compact-row consolidation-row" key={item.id}>
                <span>{item.scopeType} / {item.scopeKey}</span>
                <span className={`state-${item.status}`}>{item.status}</span>
                <span>{item.sourceCount} 个版本 / {item.sentenceCount} 句</span>
                <time>{formatDate(item.generatedAt)}</time>
              </div>
            ))}
          </div>
        ) : (
          <p className="panel-empty">还没有满足条件的派生摘要。</p>
        )}
      </section>

      <section className="status-columns governance-columns">
        <article className="status-panel">
          <header><ShieldCheck size={18} /><h2>Tombstone</h2></header>
          {tombstones.length ? (
            <ul className="status-list">
              {tombstones.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.reason}</strong>
                    <span>{item.namespace} · {formatDate(item.createdAt)}</span>
                  </div>
                  {item.restoredAt
                    ? <span>已恢复</span>
                    : <CheckCircle2 size={16} />}
                </li>
              ))}
            </ul>
          ) : (
            <p className="panel-empty">没有遗忘阻断记录。</p>
          )}
        </article>
        <article className="status-panel">
          <header><Database size={18} /><h2>物理清除任务</h2></header>
          {purgeJobs.length ? (
            <ul className="status-list">
              {purgeJobs.map((job) => (
                <li key={job.id}>
                  <div>
                    <strong>{job.status} · {job.reason}</strong>
                    <span>{formatDate(job.createdAt)}</span>
                  </div>
                  <code>{job.memoryId.slice(0, 8)}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="panel-empty">没有物理清除任务。</p>
          )}
        </article>
      </section>
    </main>
  );
}
