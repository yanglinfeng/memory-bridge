import { useEffect, useState } from 'react';
import {
  ArchiveRestore,
  Ban,
  Clock3,
  FileText,
  History,
  Link2,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Save,
  ShieldCheck,
  Star,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api';
import {
  KIND_LABELS,
  STATUS_LABELS,
  type MemoryDetail,
} from '../types';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function toLocalDateTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function MemoryInspector({
  detail,
  loading,
  onEdit,
  onDelete,
  onRestore,
  onClose,
  onChanged,
  onToast,
}: {
  detail: MemoryDetail | null;
  loading: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onClose: () => void;
  onChanged: (memoryId: string) => Promise<void>;
  onToast: (message: string, error?: boolean) => void;
}) {
  const [ttl, setTtl] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTtl(toLocalDateTime(detail?.governance?.expiresAt || null));
  }, [detail?.governance?.expiresAt, detail?.memory.id]);

  if (loading) {
    return (
      <aside className="inspector">
        <h2>记忆详情</h2>
        <div className="inspector-empty">正在读取…</div>
      </aside>
    );
  }

  if (!detail) {
    return (
      <aside className="inspector">
        <h2>记忆详情</h2>
        <div className="inspector-empty">
          <FileText size={48} strokeWidth={1.4} />
          <strong>选择一个记忆以查看详情</strong>
          <p>在此查看内容、版本、证据、治理状态与摘要来源。</p>
        </div>
        <div className="inspector-guide">
          <h3>将显示以下信息</h3>
          <span><FileText size={16} />内容与摘要</span>
          <span><History size={16} />完整版本时间线</span>
          <span><ShieldCheck size={16} />原始证据与事件</span>
          <span><Pin size={16} />Pin、TTL 与反馈</span>
          <span><Link2 size={16} />派生摘要逐句来源</span>
        </div>
      </aside>
    );
  }

  const {
    memory,
    relations,
    governance,
    versions,
    events,
    relationDecisions,
    consolidation,
  } = detail;

  const runAction = async (
    action: () => Promise<unknown>,
    successMessage: string,
  ) => {
    setBusy(true);
    try {
      await action();
      onToast(successMessage);
      await onChanged(memory.id);
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '操作失败',
        true,
      );
    } finally {
      setBusy(false);
    }
  };

  const saveTtl = () => {
    const expiresAt = ttl ? new Date(ttl).toISOString() : null;
    return runAction(
      () => api.setMemoryTtl(memory.id, expiresAt),
      expiresAt ? 'TTL 已更新' : 'TTL 已清除',
    );
  };

  const revert = (versionId: string, version: number) => {
    if (!window.confirm(`确定撤销到 v${version} 吗？系统会追加补偿版本，不会改写历史。`)) {
      return;
    }
    void runAction(
      () => api.revertMemory(memory.id, versionId),
      `已通过补偿版本撤销到 v${version}`,
    );
  };

  const purge = () => {
    const reason = window.prompt('请输入物理清除原因：', '用户请求物理清除');
    if (!reason?.trim()) return;
    if (
      !window.confirm(
        '物理清除会擦除正文、证据、索引和依赖摘要，无法恢复。已由你自行复制的明文备份不在本机系统控制范围内。确定排队清除吗？',
      )
    ) {
      return;
    }
    void runAction(
      () => api.purgeMemory(memory.id, reason.trim()),
      '已先停止召回并写入 tombstone，物理清除任务已排队',
    );
  };

  const archive = () => {
    const reason = window.prompt('请输入归档原因：', '用户手动归档');
    if (!reason?.trim()) return;
    void runAction(
      () => api.archiveMemory(memory.id, reason.trim()),
      '已归档；默认召回将排除它，查看归档时仍可检索',
    );
  };

  const unarchive = () => {
    if (!window.confirm('确定恢复这条归档记忆吗？')) return;
    void runAction(
      () => api.unarchiveMemory(memory.id),
      '已恢复为有效记忆',
    );
  };

  return (
    <aside className="inspector inspector-detail">
      <header>
        <h2>记忆详情</h2>
        <div className="inspector-header-actions">
          <span className={`status-text status-${memory.status}`}>
            {STATUS_LABELS[memory.status]}
          </span>
          <button
            className="icon-button inspector-close"
            aria-label="关闭记忆详情"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
      </header>
      <div className="inspector-scroll">
        <h3 className="detail-title">{memory.title}</h3>
        <p className="detail-content">{memory.content}</p>
        {memory.summary && (
          <p className="detail-summary">{memory.summary}</p>
        )}

        {governance && (
          <section className="governance-card">
            <header>
              <div>
                <strong>保留与使用状态</strong>
                <span>
                  召回 {governance.retrievedCount} · 使用 {governance.usedCount}
                  {' '}· 确认 {governance.confirmedCount} ·
                  {' '}拒绝 {governance.rejectedCount}
                </span>
              </div>
              <button
                className={governance.pinned
                  ? 'button primary small'
                  : 'button secondary small'}
                disabled={busy}
                onClick={() => void runAction(
                  () => api.pinMemory(memory.id, !governance.pinned),
                  governance.pinned ? '已取消 Pin' : '已 Pin，自动衰减将跳过它',
                )}
              >
                {governance.pinned
                  ? <PinOff size={15} />
                  : <Pin size={15} />}
                {governance.pinned ? '取消 Pin' : 'Pin'}
              </button>
            </header>
            <label>
              <span>单条记忆 TTL</span>
              <div>
                <input
                  type="datetime-local"
                  value={ttl}
                  disabled={busy}
                  onChange={(event) => setTtl(event.target.value)}
                />
                <button
                  className="icon-button"
                  title="保存 TTL"
                  aria-label="保存 TTL"
                  disabled={busy}
                  onClick={() => void saveTtl()}
                >
                  <Save size={16} />
                </button>
              </div>
            </label>
            {governance.archiveReason && (
              <small>
                归档原因：{governance.archiveReason} ·
                {' '}{formatDate(governance.archivedAt)}
              </small>
            )}
            <div className="feedback-actions">
              <span>这条记忆是否有用？</span>
              <button
                disabled={busy}
                onClick={() => void runAction(
                  () => api.recordFeedback(memory.id, 'used'),
                  '已记录为本次实际使用',
                )}
              >已使用</button>
              <button
                disabled={busy}
                onClick={() => void runAction(
                  () => api.recordFeedback(memory.id, 'confirmed'),
                  '已确认这条记忆正确',
                )}
              >正确</button>
              <button
                disabled={busy}
                onClick={() => void runAction(
                  () => api.recordFeedback(memory.id, 'rejected'),
                  '已记录这条记忆不正确',
                )}
              >不正确</button>
            </div>
          </section>
        )}

        <dl className="detail-list">
          <div>
            <dt>类型</dt>
            <dd>{KIND_LABELS[memory.kind]}</dd>
          </div>
          <div>
            <dt>命名空间</dt>
            <dd>{memory.namespace}</dd>
          </div>
          <div>
            <dt>作用域</dt>
            <dd>{memory.scopeType} / {memory.scopeKey}</dd>
          </div>
          <div>
            <dt>敏感级别</dt>
            <dd>{memory.sensitivity}</dd>
          </div>
          <div>
            <dt>来源权威</dt>
            <dd>{memory.sourceAuthority}</dd>
          </div>
          <div>
            <dt>语义极性</dt>
            <dd>{memory.negated ? '否定事实' : '肯定事实'}</dd>
          </div>
          <div>
            <dt>事实发生时间</dt>
            <dd>{formatDate(memory.occurredAt)}</dd>
          </div>
          <div>
            <dt>有效期</dt>
            <dd>
              {formatDate(memory.validFrom)} —
              {' '}{formatDate(memory.validTo)}
            </dd>
          </div>
          <div>
            <dt><Star size={15} />重要度</dt>
            <dd>{memory.importance.toFixed(2)}</dd>
          </div>
          <div>
            <dt><ShieldCheck size={15} />置信度</dt>
            <dd>{memory.confidence.toFixed(2)}</dd>
          </div>
          <div>
            <dt>来源</dt>
            <dd>{memory.source}</dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{formatDate(memory.createdAt)}</dd>
          </div>
          <div>
            <dt>最后更新</dt>
            <dd>{formatDate(memory.updatedAt)}</dd>
          </div>
          <div>
            <dt>最后召回</dt>
            <dd>{formatDate(memory.lastAccessedAt)}</dd>
          </div>
        </dl>

        <section className="detail-section">
          <h4><Tag size={15} />标签</h4>
          <div className="tag-list">
            {memory.tags.length ? (
              memory.tags.map((tag) => <span key={tag}>{tag}</span>)
            ) : (
              <em>没有标签</em>
            )}
          </div>
        </section>

        <section className="detail-section">
          <h4><Link2 size={15} />关系</h4>
          {relations.length ? (
            <ul className="relation-list">
              {relations.map((relation) => (
                <li key={`${relation.fromMemoryId}-${relation.toMemoryId}`}>
                  {relation.relationType}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">没有关联记忆</p>
          )}
        </section>

        <section className="detail-section">
          <h4><ShieldCheck size={15} />五路关系决策审计</h4>
          {relationDecisions.length ? (
            <ul className="event-list">
              {relationDecisions.map((decision) => (
                <li key={decision.id}>
                  <div>
                    <strong>
                      {decision.relation} · {decision.method} ·
                      {' '}{(decision.confidence * 100).toFixed(0)}%
                    </strong>
                    <time>{formatDate(decision.createdAt)}</time>
                  </div>
                  <p>{decision.candidateContent}</p>
                  <small>
                    {decision.candidateSubject} /
                    {' '}{decision.candidatePredicate} /
                    {' '}{decision.candidateValue}
                  </small>
                  <code>
                    {decision.rationale}
                    {decision.model
                      ? ` · ${decision.model}/${decision.promptVersion || '未标记提示'}`
                      : ''}
                  </code>
                  {decision.error && (
                    <p className="candidate-warning">{decision.error}</p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">没有自动关系解析记录。</p>
          )}
        </section>

        {consolidation && (
          <section className="detail-section">
            <h4><Link2 size={15} />派生摘要来源</h4>
            <div className={`consolidation-detail state-${consolidation.status}`}>
              <header>
                <strong>{consolidation.scopeType} / {consolidation.scopeKey}</strong>
                <span>{consolidation.status}</span>
              </header>
              <small>
                {consolidation.model} · {consolidation.promptVersion} ·
                {' '}{formatDate(consolidation.generatedAt)}
              </small>
              <ol>
                {consolidation.sentences.map((sentence) => (
                  <li key={sentence.id}>
                    <p>{sentence.text}</p>
                    <span>
                      {sentence.supported ? '有来源' : '已隔离'} ·
                      {' '}{sentence.sourceVersionIds.join('、') || '无来源'}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        )}

        <section className="detail-section">
          <h4><History size={15} />版本与原始证据</h4>
          {versions.length ? (
            <div className="version-timeline">
              {versions.map((version, index) => (
                <article key={version.id}>
                  <header>
                    <div>
                      <strong>v{version.version}</strong>
                      {index === 0 && <span>当前</span>}
                      <time>{formatDate(version.createdAt)}</time>
                    </div>
                    {index > 0 && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => revert(version.id, version.version)}
                      >
                        <RotateCcw size={14} />撤销到此版本
                      </button>
                    )}
                  </header>
                  <p>{version.content}</p>
                  <small>
                    {version.createdBy} · {version.source}
                    {version.normalizedValue
                      ? ` · 规范值：${version.normalizedValue}`
                      : ''}
                  </small>
                  <small>
                    {version.scopeType}/{version.scopeKey} ·
                    {' '}{version.sensitivity} ·
                    {' '}{version.sourceAuthority} ·
                    {' '}{version.negated ? '否定' : '肯定'} ·
                    {' '}有效期 {formatDate(version.validFrom)} —
                    {' '}{formatDate(version.validTo)}
                  </small>
                  {version.evidence.length ? (
                    <div className="evidence-list">
                      {version.evidence.map((evidence) => (
                        <blockquote key={evidence.id}>
                          <p>
                            {evidence.turnContent ||
                              evidence.excerpt ||
                              '原始正文已按保留策略清除'}
                          </p>
                          <span>
                            {evidence.evidenceType} ·
                            {' '}{evidence.sourceAuthority} ·
                            {' '}{evidence.sensitivity} ·
                            {' '}{formatDate(
                              evidence.turnOccurredAt || evidence.createdAt,
                            )}
                            {evidence.sessionId
                              ? ` · 会话 ${evidence.sessionId}`
                              : ''}
                          </span>
                        </blockquote>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">此版本没有可展示的原始证据。</p>
                  )}
                  <code className="version-id">{version.id}</code>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted">这条兼容记忆还没有版本记录。</p>
          )}
        </section>

        <section className="detail-section">
          <h4><Clock3 size={15} />记忆事件</h4>
          {events.length ? (
            <ul className="event-list">
              {events.map((event) => (
                <li key={event.id}>
                  <div>
                    <strong>{event.eventType}</strong>
                    <time>{formatDate(event.createdAt)}</time>
                  </div>
                  {Object.keys(event.payload).length > 0 && (
                    <code>{JSON.stringify(event.payload)}</code>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">没有生命周期事件。</p>
          )}
        </section>
      </div>

      <footer className="inspector-actions">
        {memory.status === 'deleted' ? (
          <button className="button secondary" onClick={onRestore}>
            <ArchiveRestore size={16} />恢复记忆
          </button>
        ) : memory.status === 'archived' ? (
          <>
            <button
              className="button secondary"
              disabled={busy}
              onClick={unarchive}
            >
              <ArchiveRestore size={16} />恢复归档
            </button>
            <button
              className="button danger-text"
              disabled={busy}
              onClick={onDelete}
            >
              <Trash2 size={16} />删除
            </button>
          </>
        ) : (
          <>
            <button className="button secondary" onClick={onEdit}>
              <Pencil size={16} />编辑
            </button>
            {memory.status === 'active' && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={archive}
              >
                <ArchiveRestore size={16} />归档
              </button>
            )}
            <button className="button danger-text" onClick={onDelete}>
              <Trash2 size={16} />删除
            </button>
          </>
        )}
        <button
          className="button danger-text purge-action"
          disabled={busy}
          onClick={purge}
        >
          <Ban size={16} />物理清除
        </button>
      </footer>
    </aside>
  );
}
