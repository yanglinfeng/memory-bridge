import { useCallback, useEffect, useState } from 'react';
import {
  Ban,
  Check,
  Inbox,
  RefreshCw,
  ShieldAlert,
  X,
} from 'lucide-react';
import { api } from '../api';
import {
  KIND_LABELS,
  type CandidateInboxItem,
  type Memory,
  type MemoryActionRequest,
} from '../types';

interface CandidateDraft {
  content: string;
  value: string;
}

interface ActionDraft {
  content: string;
  value: string;
}

const STATE_LABELS: Record<string, string> = {
  pending: '待确认',
  conflicted: '存在冲突',
  rejected: '已拒绝',
};

const ACTION_LABELS: Record<MemoryActionRequest['action'], string> = {
  remember: '记住',
  correct: '纠正',
  forget: '忘记',
};

const ORIGIN_LABELS: Record<CandidateInboxItem['candidateOrigin'], string> = {
  turn_extraction: '当前对话提取',
  history_reextract: '历史事实重提取',
  reflection: '跨多轮推断',
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function CandidateInbox({
  onToast,
}: {
  onToast: (message: string, error?: boolean) => void;
}) {
  const [items, setItems] = useState<CandidateInboxItem[]>([]);
  const [actions, setActions] = useState<MemoryActionRequest[]>([]);
  const [drafts, setDrafts] = useState<Record<string, CandidateDraft>>({});
  const [actionDrafts, setActionDrafts] = useState<
    Record<string, ActionDraft>
  >({});
  const [targetQueries, setTargetQueries] = useState<
    Record<string, string>
  >({});
  const [targetOptions, setTargetOptions] = useState<
    Record<string, Memory[]>
  >({});
  const [selectedTargets, setSelectedTargets] = useState<
    Record<string, string>
  >({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(
    null,
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [candidates, actionRequests] = await Promise.all([
        api.candidates(),
        api.actionRequests(),
      ]);
      setItems(candidates);
      setActions(actionRequests);
      setDrafts(Object.fromEntries(
        candidates.map((candidate) => [
          candidate.id,
          {
            content: candidate.content,
            value: candidate.value,
          },
        ]),
      ));
      setActionDrafts(Object.fromEntries(
        actionRequests.map((action) => [
          action.id,
          {
            content: action.candidate?.content || '',
            value: action.candidate?.value || '',
          },
        ]),
      ));
      setTargetQueries(Object.fromEntries(
        actionRequests
          .filter((action) => action.action === 'forget')
          .map((action) => [action.id, action.targetQuery]),
      ));
      const targetEntries = await Promise.all(
        actionRequests
          .filter((action) => action.action === 'forget')
          .map(async (action) => {
            const result = await api.listMemories({
              query: action.targetQuery,
              namespace: action.namespace,
              status: 'active',
            });
            return [action.id, result.items] as const;
          }),
      );
      setTargetOptions(Object.fromEntries(targetEntries));
      setSelectedTargets(Object.fromEntries(
        targetEntries
          .filter(([, memories]) => memories.length === 1)
          .map(([id, memories]) => [id, memories[0].id]),
      ));
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '读取候选记忆失败',
        true,
      );
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const accept = async (candidate: CandidateInboxItem) => {
    const draft = drafts[candidate.id];
    if (!draft?.content.trim() || !draft.value.trim()) {
      onToast('记忆内容和值不能为空', true);
      return;
    }
    setBusyId(candidate.id);
    try {
      await api.acceptCandidate(candidate.id, {
        content: draft.content.trim(),
        value: draft.value.trim(),
      });
      onToast(candidate.state === 'conflicted'
        ? '冲突候选已按人工确认生成新版本'
        : '候选记忆已接受');
      await load();
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '接受候选失败',
        true,
      );
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (
    candidate: CandidateInboxItem,
    blockFuture: boolean,
  ) => {
    if (
      blockFuture &&
      !window.confirm(
        '确定拒绝并阻止以后再次记住同一事实吗？系统会写入 tombstone。',
      )
    ) {
      return;
    }
    setBusyId(candidate.id);
    try {
      await api.rejectCandidate(candidate.id, blockFuture);
      onToast(blockFuture
        ? '已拒绝，并阻止以后再次记住'
        : '候选记忆已拒绝');
      await load();
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '拒绝候选失败',
        true,
      );
    } finally {
      setBusyId(null);
    }
  };

  const searchTargets = async (action: MemoryActionRequest) => {
    const query = targetQueries[action.id]?.trim() || '';
    setBusyActionId(action.id);
    try {
      const result = await api.listMemories({
        query,
        namespace: action.namespace,
        status: 'active',
      });
      setTargetOptions((current) => ({
        ...current,
        [action.id]: result.items,
      }));
      setSelectedTargets((current) => ({
        ...current,
        [action.id]:
          result.items.length === 1 ? result.items[0].id : '',
      }));
      if (result.items.length === 0) {
        onToast('没有找到可选的当前记忆，请修改搜索词', true);
      }
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '查找目标记忆失败',
        true,
      );
    } finally {
      setBusyActionId(null);
    }
  };

  const acceptAction = async (action: MemoryActionRequest) => {
    const draft = actionDrafts[action.id];
    const targetMemoryId = selectedTargets[action.id];
    if (action.action === 'forget' && !targetMemoryId) {
      onToast('请先选择要忘记的具体记忆', true);
      return;
    }
    if (
      action.action !== 'forget' &&
      (!draft?.content.trim() || !draft.value.trim())
    ) {
      onToast('候选记忆内容和值不能为空', true);
      return;
    }
    setBusyActionId(action.id);
    try {
      await api.acceptActionRequest(
        action.id,
        action.action === 'forget'
          ? { memoryId: targetMemoryId }
          : {
              content: draft.content.trim(),
              value: draft.value.trim(),
            },
      );
      onToast(
        action.action === 'forget'
          ? '已忘记所选记忆'
          : action.action === 'correct'
            ? '已确认纠正并生成新版本'
            : '已确认记住',
      );
      await load();
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '处理记忆动作失败',
        true,
      );
    } finally {
      setBusyActionId(null);
    }
  };

  const rejectAction = async (
    action: MemoryActionRequest,
    blockFuture = false,
  ) => {
    setBusyActionId(action.id);
    try {
      await api.rejectActionRequest(action.id, blockFuture);
      onToast(
        blockFuture
          ? '已拒绝，并阻止以后再次记住'
          : '已拒绝这次记忆动作',
      );
      await load();
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '拒绝记忆动作失败',
        true,
      );
    } finally {
      setBusyActionId(null);
    }
  };

  return (
    <main className="page inbox-page">
      <header className="page-header">
        <div>
          <h1>待确认</h1>
          <p>
            审核歧义、冲突、敏感候选和历史反思推断；跨多轮推断永远不会自动写入。
          </p>
        </div>
        <button className="button secondary" onClick={() => void load()}>
          <RefreshCw size={16} />刷新
        </button>
      </header>

      {loading ? (
        <div className="center-message">正在读取待确认候选…</div>
      ) : items.length === 0 && actions.length === 0 ? (
        <section className="page-empty">
          <Inbox size={48} strokeWidth={1.3} />
          <h2>没有待确认候选</h2>
          <p>这是实时空状态，不会为了展示界面写入演示数据。</p>
        </section>
      ) : (
        <>
        {actions.length > 0 && (
          <section
            className="candidate-list"
            aria-label="对话记忆动作待确认列表"
          >
            {actions.map((action) => {
              const draft = actionDrafts[action.id] || {
                content: action.candidate?.content || '',
                value: action.candidate?.value || '',
              };
              const options = targetOptions[action.id] || [];
              const disabled =
                busyActionId === action.id ||
                action.reviewInProgress;
              const canAccept =
                action.status === 'pending' &&
                (
                  action.action === 'forget' ||
                  action.candidate !== null
                );
              return (
                <article className="candidate-card" key={action.id}>
                  <header>
                    <div className="candidate-badges">
                      <span className={`candidate-state state-${action.status}`}>
                        {action.status === 'failed'
                          ? '处理失败'
                          : '对话动作待确认'}
                      </span>
                      <span>{ACTION_LABELS[action.action]}</span>
                      <span>{action.namespace}</span>
                      {action.sensitivity !== 'normal' && (
                        <span className="sensitivity-badge">
                          <ShieldAlert size={13} />
                          {action.sensitivity}
                        </span>
                      )}
                    </div>
                    <time>{formatDate(action.createdAt)}</time>
                  </header>

                  <blockquote>
                    <strong>用户原话</strong>
                    <p>
                      {action.turnContent ||
                        '原始正文已按保留策略清除'}
                    </p>
                    <small>
                      {action.rationale || action.error ||
                        '需要人工确认'}
                    </small>
                  </blockquote>

                  {action.action === 'forget' ? (
                    <div className="candidate-grid">
                      <label className="field field-wide">
                        <span>搜索要忘记的记忆</span>
                        <input
                          value={targetQueries[action.id] || ''}
                          disabled={disabled}
                          onChange={(event) =>
                            setTargetQueries((current) => ({
                              ...current,
                              [action.id]: event.target.value,
                            }))}
                        />
                      </label>
                      <button
                        className="button secondary"
                        disabled={disabled}
                        onClick={() => void searchTargets(action)}
                      >
                        <RefreshCw size={16} />查找
                      </button>
                      <label className="field field-wide">
                        <span>确认具体目标</span>
                        <select
                          value={selectedTargets[action.id] || ''}
                          disabled={disabled || options.length === 0}
                          onChange={(event) =>
                            setSelectedTargets((current) => ({
                              ...current,
                              [action.id]: event.target.value,
                            }))}
                        >
                          <option value="">请选择一条记忆</option>
                          {options.map((memory) => (
                            <option value={memory.id} key={memory.id}>
                              {memory.title || memory.content}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  ) : action.candidate ? (
                    <div className="candidate-grid">
                      <label className="field">
                        <span>规范值</span>
                        <input
                          value={draft.value}
                          disabled={disabled}
                          onChange={(event) =>
                            setActionDrafts((current) => ({
                              ...current,
                              [action.id]: {
                                ...draft,
                                value: event.target.value,
                              },
                            }))}
                        />
                      </label>
                      <label className="field field-wide">
                        <span>将保存的记忆内容</span>
                        <textarea
                          rows={3}
                          value={draft.content}
                          disabled={disabled}
                          onChange={(event) =>
                            setActionDrafts((current) => ({
                              ...current,
                              [action.id]: {
                                ...draft,
                                content: event.target.value,
                              },
                            }))}
                        />
                      </label>
                    </div>
                  ) : (
                    <p className="candidate-warning">
                      本次模型处理失败且没有安全候选，只能拒绝；
                      原纠正或遗忘请求在本轮已停止旧记忆召回。
                    </p>
                  )}

                  <dl className="candidate-meta">
                    <div>
                      <dt>动作模型</dt>
                      <dd>{action.model} / {action.promptVersion}</dd>
                    </div>
                    <div>
                      <dt>置信度</dt>
                      <dd>{(action.confidence * 100).toFixed(0)}%</dd>
                    </div>
                  </dl>

                  <footer>
                    <button
                      className="button secondary"
                      disabled={disabled}
                      onClick={() => void rejectAction(action)}
                    >
                      <X size={16} />拒绝
                    </button>
                    {action.action !== 'forget' && action.candidate && (
                      <button
                        className="button danger-text"
                        disabled={disabled}
                        onClick={() => void rejectAction(action, true)}
                      >
                        <Ban size={16} />以后不要再记
                      </button>
                    )}
                    <button
                      className="button primary"
                      disabled={disabled || !canAccept}
                      onClick={() => void acceptAction(action)}
                    >
                      <Check size={16} />
                      {action.action === 'forget'
                        ? '确认忘记所选目标'
                        : action.action === 'correct'
                          ? '确认纠正'
                          : '确认记住'}
                    </button>
                  </footer>
                </article>
              );
            })}
          </section>
        )}
        {items.length > 0 && (
        <section className="candidate-list" aria-label="待确认候选列表">
          {items.map((candidate) => {
            const draft = drafts[candidate.id] || {
              content: candidate.content,
              value: candidate.value,
            };
            const credential = candidate.sensitivity === 'credential';
            return (
              <article className="candidate-card" key={candidate.id}>
                <header>
                  <div className="candidate-badges">
                    <span className={`candidate-state state-${candidate.state}`}>
                      {STATE_LABELS[candidate.state] || candidate.state}
                    </span>
                    <span>{KIND_LABELS[candidate.kind]}</span>
                    <span>{candidate.namespace}</span>
                    <span>
                      {ORIGIN_LABELS[candidate.candidateOrigin] ||
                        candidate.candidateOrigin}
                    </span>
                    {candidate.sensitivity !== 'normal' && (
                      <span className="sensitivity-badge">
                        <ShieldAlert size={13} />
                        {credential ? '凭据' : candidate.sensitivity}
                      </span>
                    )}
                  </div>
                  <time>{formatDate(candidate.createdAt)}</time>
                </header>

                <div className="candidate-grid">
                  <label className="field">
                    <span>规范值</span>
                    <input
                      value={draft.value}
                      disabled={busyId === candidate.id}
                      onChange={(event) => setDrafts((current) => ({
                        ...current,
                        [candidate.id]: {
                          ...draft,
                          value: event.target.value,
                        },
                      }))}
                    />
                  </label>
                  <label className="field field-wide">
                    <span>将保存的记忆内容</span>
                    <textarea
                      rows={3}
                      value={draft.content}
                      disabled={busyId === candidate.id}
                      onChange={(event) => setDrafts((current) => ({
                        ...current,
                        [candidate.id]: {
                          ...draft,
                          content: event.target.value,
                        },
                      }))}
                    />
                  </label>
                </div>

                <dl className="candidate-meta">
                  <div><dt>主体</dt><dd>{candidate.subject || '—'}</dd></div>
                  <div><dt>谓词</dt><dd>{candidate.predicate || '—'}</dd></div>
                  <div>
                    <dt>作用域</dt>
                    <dd>{candidate.scopeType} / {candidate.scopeKey}</dd>
                  </div>
                  <div>
                    <dt>语义极性</dt>
                    <dd>{candidate.negated ? '否定事实' : '肯定事实'}</dd>
                  </div>
                  <div>
                    <dt>来源权威</dt>
                    <dd>{candidate.sourceAuthority}</dd>
                  </div>
                  <div>
                    <dt>证据覆盖</dt>
                    <dd>
                      {candidate.evidenceCount > 0
                        ? `${candidate.evidenceCount} 条 / ${candidate.evidenceSessionCount} 个会话`
                        : '单轮原始证据'}
                    </dd>
                  </div>
                  <div>
                    <dt>证据时间跨度</dt>
                    <dd>
                      {formatDate(candidate.evidenceStartedAt)} —{' '}
                      {formatDate(candidate.evidenceEndedAt)}
                    </dd>
                  </div>
                  <div>
                    <dt>有效期</dt>
                    <dd>
                      {formatDate(candidate.claimValidFrom)} —
                      {' '}{formatDate(candidate.claimValidTo)}
                    </dd>
                  </div>
                  <div>
                    <dt>置信度</dt>
                    <dd>{(candidate.confidence * 100).toFixed(0)}%</dd>
                  </div>
                  <div>
                    <dt>提取器</dt>
                    <dd>
                      {candidate.extractionModel || '规则'}
                      {candidate.promptVersion
                        ? ` / ${candidate.promptVersion}`
                        : ''}
                    </dd>
                  </div>
                </dl>

                {candidate.evidence.length > 0 ? (
                  <div className="candidate-evidence-list">
                    <strong>逐字证据摘录</strong>
                    {candidate.evidence.map((evidence) => (
                      <blockquote key={`${candidate.id}:${evidence.turnId}`}>
                        <p>
                          {evidence.excerpt || '证据正文已按保留策略清除'}
                        </p>
                        <small>
                          {evidence.evidenceType === 'pattern_support'
                            ? '模式支持'
                            : '直接事实'} · {formatDate(evidence.occurredAt)}
                        </small>
                        <code>{evidence.turnId}</code>
                      </blockquote>
                    ))}
                  </div>
                ) : (
                  <blockquote>
                    <strong>原始对话证据</strong>
                    <p>
                      {candidate.sourceExcerpt ||
                        candidate.turnContent ||
                        '原始正文已按保留策略清除'}
                    </p>
                    {candidate.turnId && <code>{candidate.turnId}</code>}
                  </blockquote>
                )}

                {candidate.candidateOrigin === 'reflection' && (
                  <p className="candidate-warning">
                    这是跨多轮归纳出的 assistant inference，必须由你确认后才能成为长期记忆。
                  </p>
                )}

                {credential && (
                  <p className="candidate-warning">
                    凭据类信息永远不能接受为长期记忆，只能拒绝或阻止再记。
                  </p>
                )}

                <footer>
                  <button
                    className="button secondary"
                    disabled={busyId === candidate.id}
                    onClick={() => void reject(candidate, false)}
                  >
                    <X size={16} />拒绝
                  </button>
                  <button
                    className="button danger-text"
                    disabled={busyId === candidate.id}
                    onClick={() => void reject(candidate, true)}
                  >
                    <Ban size={16} />以后不要再记
                  </button>
                  <button
                    className="button primary"
                    disabled={busyId === candidate.id || credential}
                    onClick={() => void accept(candidate)}
                  >
                    <Check size={16} />
                    {candidate.state === 'conflicted'
                      ? '确认并生成新版本'
                      : '接受'}
                  </button>
                </footer>
              </article>
            );
          })}
        </section>
        )}
        </>
      )}
    </main>
  );
}
