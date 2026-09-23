import { useState } from 'react';
import { Search, Sparkles } from 'lucide-react';
import { api } from '../api';
import {
  KIND_LABELS,
  type RecallExplanation,
  type RecallResponse,
  type RetrievalTraceDetail,
  type RetrievalTraceEvent,
} from '../types';

function valueOrZero(value: number | undefined): number {
  return typeof value === 'number' ? value : 0;
}

function decimal(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toFixed(3) : '—';
}

function rank(value: number | null | undefined): string {
  return typeof value === 'number' ? `第 ${value} 名` : '未命中';
}

function normalizedQuery(value: string | null | undefined): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim()
    : '';
}

export function selectRecallExplanation(
  explanations: RecallExplanation[],
  response: Pick<RecallResponse, 'traceId' | 'query'>,
): RecallExplanation | null {
  if (response.traceId) {
    const traceMatch = explanations.find(
      (item) => item.traceId === response.traceId,
    );
    if (traceMatch) return traceMatch;
  }
  const query = normalizedQuery(response.query);
  if (!query) return null;
  return explanations.find(
    (item) => normalizedQuery(item.query) === query,
  ) || null;
}

function detailRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberMetric(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(1)
    : '—';
}

function integerMetric(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(Math.trunc(value))
    : '—';
}

function routeLabel(value: unknown): string {
  if (value === 'deterministic_fast') return '确定性快路';
  if (value === 'model') return '模型';
  if (value === 'cache') return '缓存';
  return '未记录';
}

function stageLabel(value: RetrievalTraceEvent['stage']): string {
  if (value === 'request') return '请求';
  if (value === 'rewrite') return '查询改写';
  if (value === 'channels') return '多路召回';
  if (value === 'fusion') return '候选融合';
  if (value === 'semantic') return 'Embedding / 语义';
  if (value === 'rerank') return '相关性重排';
  if (value === 'selection') return '结果选择';
  if (value === 'context') return '上下文组装';
  if (value === 'result') return '完成';
  return value;
}

function SemanticAttemptRow({
  value,
  index,
}: {
  value: unknown;
  index: number;
}) {
  const attempt = detailRecord(value);
  const model = detailRecord(attempt.modelTelemetry);
  return (
    <div className="semantic-attempt-row">
      <b>#{index + 1} {routeLabel(attempt.route)}</b>
      <span>调用 {integerMetric(attempt.providerCalls)}</span>
      <span>
        {numberMetric(attempt.requestDurationMs)} /{' '}
        {numberMetric(attempt.providerDurationMs)} ms
      </span>
      <span>
        token {integerMetric(model.promptEvalCount)} /{' '}
        {integerMetric(model.evalCount)}
      </span>
      <span>
        {typeof model.thermalState === 'string'
          ? model.thermalState
          : 'unknown'}
      </span>
      <code>
        {typeof attempt.keyFingerprint === 'string'
          ? attempt.keyFingerprint.slice(0, 12)
          : '—'}
      </code>
    </div>
  );
}

function SemanticTraceCard({ event }: { event: RetrievalTraceEvent }) {
  const detail = event.detail;
  const model = detailRecord(detail.modelTelemetry);
  const attempts = Array.isArray(detail.attempts) ? detail.attempts : [];
  return (
    <article className="semantic-trace-card">
      <header>
        <div>
          <span>{stageLabel(event.stage)}</span>
          <strong>{routeLabel(detail.route)}</strong>
        </div>
        <code>attempt {integerMetric(detail.attempt)}</code>
      </header>
      <dl>
        <div>
          <dt>Provider 调用</dt>
          <dd>{integerMetric(detail.providerCalls)}</dd>
        </div>
        <div>
          <dt>请求 / Provider</dt>
          <dd>
            {numberMetric(detail.requestDurationMs)} /{' '}
            {numberMetric(detail.providerDurationMs)} ms
          </dd>
        </div>
        <div>
          <dt>缓存 / 合并请求</dt>
          <dd>
            {detail.cacheHit === true ? '命中' : '未命中'} /{' '}
            {detail.singleFlightShared === true ? '是' : '否'}
          </dd>
        </div>
        <div>
          <dt>冷热状态</dt>
          <dd>{typeof model.thermalState === 'string' ? model.thermalState : '—'}</dd>
        </div>
        <div>
          <dt>Prompt / 输出 token</dt>
          <dd>
            {integerMetric(model.promptEvalCount)} /{' '}
            {integerMetric(model.evalCount)}
          </dd>
        </div>
        <div>
          <dt>模型总耗时 / 加载</dt>
          <dd>
            {numberMetric(model.totalDurationMs)} /{' '}
            {numberMetric(model.loadDurationMs)} ms
          </dd>
        </div>
      </dl>
      {attempts.length > 0 && (
        <details className="semantic-attempts">
          <summary>展开 {attempts.length} 次调用明细</summary>
          <div>
            {attempts.map((attempt, index) => (
              <SemanticAttemptRow
                value={attempt}
                index={index}
                key={index}
              />
            ))}
          </div>
        </details>
      )}
      <footer>
        <code>
          {typeof detail.keyFingerprint === 'string'
            ? detail.keyFingerprint.slice(0, 16)
            : '无调用指纹'}
        </code>
        {attempts.length > 0 && <span>{attempts.length} 次子调用</span>}
        {typeof detail.failureCode === 'string' && (
          <span className="trace-failure">{detail.failureCode}</span>
        )}
      </footer>
    </article>
  );
}

export function RecallLab({
  onToast,
}: {
  onToast: (message: string, error?: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [namespace, setNamespace] = useState('');
  const [result, setResult] = useState<RecallResponse | null>(null);
  const [explanation, setExplanation] = useState<RecallExplanation | null>(null);
  const [trace, setTrace] = useState<RetrievalTraceDetail | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const runRecall = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setResult(null);
    setExplanation(null);
    setTrace(null);
    setTraceError(null);
    try {
      const response = await api.recall(query, namespace);
      setResult(response);
      const [explanationResult, traceResult] = await Promise.allSettled([
        api.recallExplanations(),
        response.traceId
          ? api.retrievalTrace(response.traceId)
          : Promise.resolve(null),
      ]);
      if (explanationResult.status === 'fulfilled') {
        setExplanation(selectRecallExplanation(
          explanationResult.value,
          response,
        ));
      }
      if (traceResult.status === 'fulfilled') {
        setTrace(traceResult.value);
        if (!response.traceId) setTraceError('本次响应没有返回 traceId');
      } else {
        setTraceError(
          traceResult.reason instanceof Error
            ? traceResult.reason.message
            : '检索日志加载失败',
        );
      }
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '召回测试失败',
        true,
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="page recall-page">
      <header className="page-header">
        <div>
          <h1>召回测试</h1>
          <p>验证 AIRI 在真实对话问题下会取回哪些长期记忆，以及为什么命中。</p>
        </div>
      </header>

      <form className="recall-form" onSubmit={runRecall}>
        <label className="field field-wide">
          <span>模拟用户消息</span>
          <div className="large-query">
            <Search size={20} />
            <textarea
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="输入与真实聊天相同的自然问题，不需要使用“请记住”等关键词"
              rows={3}
              autoFocus
            />
          </div>
        </label>
        <label className="field">
          <span>命名空间（可选）</span>
          <input
            value={namespace}
            onChange={(event) => setNamespace(event.target.value)}
            placeholder="不填写则搜索全部"
          />
        </label>
        <button
          className="button primary recall-button"
          disabled={loading || !query.trim()}
        >
          <Sparkles size={17} />
          {loading ? '正在召回…' : '运行召回'}
        </button>
      </form>

      {!result ? (
        <section className="recall-placeholder">
          <Sparkles size={42} strokeWidth={1.3} />
          <h2>等待一次真实查询</h2>
          <p>系统会显示命中通道、候选规模、综合分数和最终注入上下文。</p>
        </section>
      ) : (
        <>
          <section className="recall-explanation">
            <header>
              <div>
                <span>召回质量</span>
                <strong>
                  {result.qualityState ||
                    explanation?.qualityState ||
                    '未标记'}
                </strong>
              </div>
              <div>
                <span>候选总数</span>
                <strong>{explanation?.candidateCount ?? '—'}</strong>
              </div>
              <div>
                <span>最终注入</span>
                <strong>{result.memories.length}</strong>
              </div>
              <div>
                <span>召回模式</span>
                <strong>{explanation?.mode || '—'}</strong>
              </div>
            </header>
            <div className="channel-meter">
              <span>
                FTS5/BM25
                <b>{valueOrZero(explanation?.lexicalCandidateCount)}</b>
              </span>
              <span>
                ANN
                <b>{valueOrZero(explanation?.annCandidateCount)}</b>
              </span>
              <span>
                实体/概念
                <b>{valueOrZero(explanation?.termCandidateCount)}</b>
              </span>
              <span>
                重排
                <b>{valueOrZero(explanation?.rerankCandidateCount)}</b>
              </span>
            </div>
            {(explanation?.embeddingModel || explanation?.rerankModel) && (
              <small>
                Embedding：{explanation.embeddingModel || '—'} ·
                {' '}Reranker：{explanation.rerankModel || '—'}
                {' '}· Dense 水位：
                {explanation.denseIndexed ?? '—'}/
                {explanation.denseEligible ?? '—'}
                {' '}· {explanation.indexVersion || '未标记版本'}
                {explanation.generationId
                  ? ` · generation ${explanation.generationId.slice(-12)}`
                  : ''}
              </small>
            )}
            {explanation?.filterSummary?.length ? (
              <small>
                过滤：
                {explanation.filterSummary
                  .map((item) => `${item.reason} ${item.count}`)
                  .join(' · ')}
              </small>
            ) : null}
          </section>

          <section className="semantic-trace-panel">
            <header>
              <div>
                <span>逐调用检索日志</span>
                <strong>
                  {trace?.qualityState || result.qualityState || '未标记'}
                </strong>
              </div>
              <div>
                <span>整轮耗时</span>
                <strong>{numberMetric(trace?.totalDurationMs)} ms</strong>
              </div>
              <div>
                <span>Trace ID</span>
                <code>{trace?.traceId || result.traceId || '—'}</code>
              </div>
            </header>
            {traceError && (
              <p className="trace-load-error">
                召回结果已保留，但日志详情加载失败：{traceError}
              </p>
            )}
            {trace ? (
              <>
                <div className="semantic-trace-grid">
                  {trace.events
                    .filter((event) =>
                      event.stage === 'rewrite' ||
                      event.stage === 'semantic' ||
                      event.stage === 'rerank'
                    )
                    .map((event) => (
                      <SemanticTraceCard
                        event={event}
                        key={`${event.sequence}-${event.stage}`}
                      />
                    ))}
                </div>
                <div className="trace-stage-timeline">
                  {trace.events.map((event) => (
                    <div key={`duration-${event.sequence}`}>
                      <span>{stageLabel(event.stage)}</span>
                      <strong>{numberMetric(event.detail.durationMs)} ms</strong>
                    </div>
                  ))}
                </div>
              </>
            ) : !traceError ? (
              <p className="trace-loading">正在加载逐调用日志…</p>
            ) : null}
          </section>

          {result.queryUnderstanding && (
            <section className="query-understanding-panel">
              <header>
                <div>
                  <span>查询理解</span>
                  <strong>{result.queryUnderstanding.status}</strong>
                </div>
                <div>
                  <span>置信度</span>
                  <strong>
                    {(result.queryUnderstanding.confidence * 100).toFixed(0)}%
                  </strong>
                </div>
                <div>
                  <span>上下文来源</span>
                  <strong>{result.queryUnderstanding.contextSource}</strong>
                </div>
                <div>
                  <span>耗时</span>
                  <strong>{result.queryUnderstanding.latencyMs.toFixed(1)} ms</strong>
                </div>
              </header>
              <dl>
                <div>
                  <dt>原查询</dt>
                  <dd>{result.queryUnderstanding.originalQuery}</dd>
                </div>
                <div>
                  <dt>独立查询 / 排序查询</dt>
                  <dd>
                    {result.queryUnderstanding.standaloneQuery || '未生成'}
                    {' / '}{result.queryUnderstanding.rankingQuery}
                  </dd>
                </div>
                <div>
                  <dt>保留约束</dt>
                  <dd>
                    {Object.values(result.queryUnderstanding.constraints)
                      .flat()
                      .join(' · ') || '无显式约束'}
                  </dd>
                </div>
                <div>
                  <dt>触发 / 待澄清</dt>
                  <dd>
                    {result.queryUnderstanding.triggerReasons.join(' · ') || '未触发'}
                    {result.queryUnderstanding.clarificationQuestion
                      ? ` / ${result.queryUnderstanding.clarificationQuestion}`
                      : ''}
                  </dd>
                </div>
              </dl>
              <small>
                {result.queryUnderstanding.model || '无模型调用'} ·{' '}
                {result.queryUnderstanding.promptVersion}
              </small>
            </section>
          )}

          <div className="recall-results">
            <section className="result-column">
              <header>
                <h2>命中记忆</h2>
                <span>{result.memories.length} 条</span>
              </header>
              {result.memories.length ? (
                result.memories.map((recall) => {
                  const { memory, score, reasons } = recall;
                  const auditDetail = explanation?.results
                    ?.find((item) => item.memoryId === memory.id);
                  const detail =
                    recall.explanation || auditDetail?.explanation;
                  return (
                    <article className="recall-result" key={memory.id}>
                      <div>
                        <span>{KIND_LABELS[memory.kind]}</span>
                        <b>{score.toFixed(3)}</b>
                      </div>
                      <h3>{memory.title}</h3>
                      <p>{memory.content}</p>
                      {detail && (
                        <dl className="recall-score-grid">
                          <div>
                            <dt>词面排名</dt>
                            <dd>{rank(detail.lexicalRank)}</dd>
                          </div>
                          <div>
                            <dt>ANN 排名</dt>
                            <dd>{rank(detail.annRank)}</dd>
                          </div>
                          <div>
                            <dt>概念排名</dt>
                            <dd>{rank(detail.termRank)}</dd>
                          </div>
                          <div>
                            <dt>语义相似</dt>
                            <dd>{decimal(detail.semanticSimilarity)}</dd>
                          </div>
                          <div>
                            <dt>重排置信</dt>
                            <dd>{decimal(detail.rerankConfidence)}</dd>
                          </div>
                          <div>
                            <dt>重要度 / 置信度</dt>
                            <dd>
                              {decimal(detail.importance)} /{' '}
                              {decimal(detail.memoryConfidence)}
                            </dd>
                          </div>
                          <div>
                            <dt>时效分</dt>
                            <dd>{decimal(detail.recency)}</dd>
                          </div>
                          <div>
                            <dt>状态 / 冲突</dt>
                            <dd>
                              {detail.status} / {detail.conflictState}
                            </dd>
                          </div>
                          <div>
                            <dt>多样性惩罚</dt>
                            <dd>{decimal(detail.diversityPenalty)}</dd>
                          </div>
                        </dl>
                      )}
                      <footer>
                        <span>{reasons.join(' · ')}</span>
                        <code>{memory.id}</code>
                        {auditDetail?.versionId && (
                          <code>版本：{auditDetail.versionId}</code>
                        )}
                        {auditDetail?.evidence.map((source, index) => (
                          <code key={`${memory.id}-evidence-${index}`}>
                            证据：
                            {source.excerpt ||
                              source.sourceRef ||
                              source.turnId ||
                              source.evidenceType}
                          </code>
                        ))}
                      </footer>
                    </article>
                  );
                })
              ) : (
                <div className="no-results">
                  当前记忆库中没有足够相关的内容。
                </div>
              )}
            </section>
            <section className="context-preview">
              <header>
                <h2>实际提供给 AIRI 的上下文</h2>
              </header>
              <pre>{result.context}</pre>
            </section>
          </div>
        </>
      )}
    </main>
  );
}
