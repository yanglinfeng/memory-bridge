import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  LogOut,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRound,
  UsersRound,
  X,
} from 'lucide-react';
import { api } from '../api';
import type {
  CredentialListResponse,
  CurrentIdentityOverview,
  MemoryAccessScope,
  RecallResponse,
  ServiceConfig,
} from '../types';

function formatDate(value: string | null): string {
  if (!value) return '从未';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function scopeLabel(scope: MemoryAccessScope): string {
  if (scope.scopeType === 'personal') return '个人共享';
  if (scope.scopeType === 'role') return '当前 persona';
  if (scope.scopeType === 'session') return '当前聊天';
  return '项目';
}

interface ScopeSelection {
  personaId: string;
  sessionId: string;
}

interface PersonaSessionChoice {
  personaId: string;
  latestSession: { externalId: string } | null;
}

export function resolveScopeSelectionAfterRefresh(
  current: ScopeSelection,
  personas: readonly PersonaSessionChoice[],
): ScopeSelection {
  if (personas.some(
    (persona) => persona.personaId === current.personaId,
  )) {
    return current;
  }
  const first = personas[0];
  return {
    personaId: first?.personaId || '',
    sessionId: first?.latestSession?.externalId || '',
  };
}

export function AccountPage({
  onToast,
  onAuthenticationChanged,
  onAuthenticationRequired,
}: {
  onToast: (message: string, error?: boolean) => void;
  onAuthenticationChanged: () => void;
  onAuthenticationRequired: () => void;
}) {
  const [overview, setOverview] =
    useState<CurrentIdentityOverview | null>(null);
  const [credentials, setCredentials] =
    useState<CredentialListResponse | null>(null);
  const [config, setConfig] = useState<ServiceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState('本机主人');
  const [bootstrapLabel, setBootstrapLabel] = useState('AIRI desktop');
  const [newCredentialLabel, setNewCredentialLabel] = useState('AIRI desktop');
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [scopeSelection, setScopeSelection] = useState({
    personaId: '',
    sessionId: '',
  });
  const [namespace, setNamespace] = useState('');
  const [query, setQuery] = useState('');
  const [recall, setRecall] = useState<RecallResponse | null>(null);
  const [recalling, setRecalling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextOverview, nextCredentials, nextConfig] =
        await Promise.all([
          api.identity(),
          api.credentials(),
          api.config(),
        ]);
      setOverview(nextOverview);
      setCredentials(nextCredentials);
      setConfig(nextConfig);
      setNamespace((current) =>
        current || nextConfig.defaultNamespace,
      );
      setScopeSelection((current) =>
        resolveScopeSelectionAfterRefresh(
          current,
          nextOverview.personas,
        )
      );
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '读取账户信息失败',
        true,
      );
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const { personaId, sessionId } = scopeSelection;

  const visibleScopes = useMemo<MemoryAccessScope[]>(() => {
    const scopes: MemoryAccessScope[] = [
      { scopeType: 'personal', scopeKey: 'self' },
    ];
    if (personaId) {
      scopes.push({ scopeType: 'role', scopeKey: personaId });
      if (sessionId.trim()) {
        scopes.push({
          scopeType: 'session',
          scopeKey: sessionId.trim(),
        });
      }
    }
    return scopes;
  }, [personaId, sessionId]);

  const initialize = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.bootstrapIdentity({
        displayName: displayName.trim(),
        label: bootstrapLabel.trim(),
      });
      api.setAccessToken(result.token);
      setIssuedToken(result.token);
      onAuthenticationChanged();
      onToast('首个本地账户与凭据已创建');
      await load();
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '账户初始化失败',
        true,
      );
    } finally {
      setBusy(false);
    }
  };

  const issueCredential = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newCredentialLabel.trim()) return;
    setBusy(true);
    try {
      const result = await api.issueCredential({
        label: newCredentialLabel.trim(),
      });
      setIssuedToken(result.token);
      setNewCredentialLabel('AIRI desktop');
      onToast('新凭据已签发；完整令牌只显示这一次');
      await load();
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '签发凭据失败',
        true,
      );
    } finally {
      setBusy(false);
    }
  };

  const revokeCredential = async (id: string) => {
    const current = credentials?.currentCredentialId === id;
    if (
      !window.confirm(
        current
          ? '这是当前页面正在使用的凭据。撤销后需要使用另一枚令牌重新进入，继续吗？'
          : '确定立即撤销这枚凭据吗？',
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.revokeCredential(id, '由管理台撤销');
      onToast('凭据已撤销');
      if (current) {
        api.clearAccessToken();
        onAuthenticationRequired();
      } else {
        await load();
      }
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '撤销凭据失败',
        true,
      );
    } finally {
      setBusy(false);
    }
  };

  const copyIssuedToken = async () => {
    if (!issuedToken) return;
    try {
      await navigator.clipboard.writeText(issuedToken);
      onToast('完整令牌已复制，请保存到密码管理器');
    } catch {
      onToast('浏览器不允许自动复制，请手动选择令牌', true);
    }
  };

  const runCombinedRecall = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return;
    setRecalling(true);
    try {
      setRecall(
        await api.recall(
          query.trim(),
          namespace.trim() || config?.defaultNamespace,
          8,
          visibleScopes,
        ),
      );
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : '组合召回失败',
        true,
      );
    } finally {
      setRecalling(false);
    }
  };

  if (loading && !overview) {
    return <main className="page"><div className="center-message">正在读取账户…</div></main>;
  }

  return (
    <main className="page account-page">
      <header className="page-header">
        <div>
          <h1>账户与 persona</h1>
          <p>账户是安全边界；个人记忆可共享，persona 与聊天记忆默认隔离。</p>
        </div>
        <button className="button secondary" onClick={() => void load()}>
          <RefreshCw size={16} />刷新
        </button>
      </header>

      {issuedToken && (
        <section className="issued-token" role="status">
          <ShieldCheck size={22} />
          <div>
            <strong>完整令牌只显示这一次</strong>
            <code>{issuedToken}</code>
            <small>忆桥不会保存可恢复的明文令牌。请复制到密码管理器。</small>
          </div>
          <button className="button primary small" onClick={copyIssuedToken}>
            <Copy size={15} />复制
          </button>
          <button
            className="icon-button"
            aria-label="隐藏完整令牌"
            onClick={() => setIssuedToken(null)}
          >
            <X size={17} />
          </button>
        </section>
      )}

      <section className="account-summary-grid">
        <article className="account-summary-card">
          <span><UserRound size={19} />当前账户</span>
          <strong>{overview?.principal.displayName || '—'}</strong>
          <code>{overview?.principal.id || '—'}</code>
          <small>
            {overview?.principal.status === 'active' ? '已启用' : '已停用'} ·
            {' '}个人共享记忆 {overview?.personalMemoryCount ?? 0} 条
          </small>
        </article>
        <article className="account-summary-card">
          <span><KeyRound size={19} />当前凭据</span>
          <strong>{overview?.credential?.label || '尚未建立持久凭据'}</strong>
          <code>{overview?.credential?.secretHint || '本机首次初始化可用'}</code>
          <small>
            {overview?.credential
              ? `${overview.credential.status} · 最近使用 ${formatDate(overview.credential.lastUsedAt)}`
              : '完成初始化后，匿名本机访问将永久关闭'}
          </small>
        </article>
        <article className="account-summary-card">
          <span><UsersRound size={19} />AIRI persona</span>
          <strong>{overview?.personas.length ?? 0} 个</strong>
          <code>{overview?.namespaces.length ?? 0} 个 namespace</code>
          <small>显示名可变，隔离始终使用稳定 persona ID。</small>
        </article>
      </section>

      {!overview?.credential && (
        <section className="account-panel bootstrap-panel">
          <header>
            <ShieldCheck size={20} />
            <div>
              <h2>初始化第一个本地账户</h2>
              <p>此操作只能成功一次；成功后匿名访问与旧全局 Token 都会关闭。</p>
            </div>
          </header>
          <form className="account-form" onSubmit={initialize}>
            <label className="field">
              <span>账户显示名</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={255}
              />
            </label>
            <label className="field">
              <span>首枚凭据标签</span>
              <input
                value={bootstrapLabel}
                onChange={(event) => setBootstrapLabel(event.target.value)}
                maxLength={255}
              />
            </label>
            <button
              className="button primary"
              disabled={busy || !displayName.trim() || !bootstrapLabel.trim()}
            >
              {busy ? '正在初始化…' : '创建账户与凭据'}
            </button>
          </form>
        </section>
      )}

      {overview?.credential && (
        <section className="account-panel">
          <header>
            <KeyRound size={20} />
            <div>
              <h2>账户凭据</h2>
              <p>列表永不返回完整令牌，只显示不可逆的末尾提示。</p>
            </div>
          </header>
          <form className="credential-issue-form" onSubmit={issueCredential}>
            <label className="field">
              <span>新凭据标签</span>
              <input
                value={newCredentialLabel}
                onChange={(event) => setNewCredentialLabel(event.target.value)}
                maxLength={255}
              />
            </label>
            <button
              className="button primary"
              disabled={busy || !newCredentialLabel.trim()}
            >
              签发新凭据
            </button>
          </form>
          <div className="credential-list">
            {credentials?.credentials.map((credential) => {
              const current =
                credential.id === credentials.currentCredentialId;
              return (
                <article key={credential.id}>
                  <div>
                    <strong>{credential.label}</strong>
                    {current && <span><Check size={13} />当前</span>}
                    <code>{credential.secretHint}</code>
                  </div>
                  <small>
                    {credential.status} · 创建 {formatDate(credential.createdAt)} ·
                    {' '}最近使用 {formatDate(credential.lastUsedAt)}
                  </small>
                  {credential.status === 'active' && (
                    <button
                      className="button danger-text small"
                      disabled={busy}
                      onClick={() => void revokeCredential(credential.id)}
                    >
                      撤销
                    </button>
                  )}
                </article>
              );
            })}
          </div>
          <button
            className="button secondary"
            onClick={() => {
              api.clearAccessToken();
              onAuthenticationRequired();
            }}
          >
            <LogOut size={16} />清除本页令牌
          </button>
        </section>
      )}

      <section className="account-panel">
        <header>
          <UsersRound size={20} />
          <div>
            <h2>已绑定 AIRI persona</h2>
            <p>persona 显示名不参与安全判断；最近会话来自可信身份契约。</p>
          </div>
        </header>
        <div className="persona-list">
          {overview?.personas.length ? overview.personas.map((persona) => (
            <article key={persona.id}>
              <div>
                <strong>{persona.displayName || '未命名 persona'}</strong>
                <span>{persona.status}</span>
              </div>
              <code>{persona.personaId}</code>
              <dl>
                <div><dt>客户端</dt><dd>{persona.clientType}</dd></div>
                <div><dt>私有记忆</dt><dd>{persona.roleMemoryCount} 条</dd></div>
                <div>
                  <dt>最近会话</dt>
                  <dd>{persona.latestSession?.externalId || '尚无'}</dd>
                </div>
                <div>
                  <dt>最近出现</dt>
                  <dd>{formatDate(persona.lastSeenAt)}</dd>
                </div>
              </dl>
            </article>
          )) : (
            <p className="panel-empty">尚未收到带稳定身份头的 AIRI 会话。</p>
          )}
        </div>
      </section>

      <section className="account-panel combined-recall-panel">
        <header>
          <Search size={20} />
          <div>
            <h2>当前组合召回</h2>
            <p>只查询当前账户，并按 session → role → personal 的就近规则遮蔽冲突。</p>
          </div>
        </header>
        <div className="scope-precedence" aria-label="召回作用域优先级">
          {visibleScopes.map((scope, index) => (
            <span key={`${scope.scopeType}:${scope.scopeKey}`}>
              <b>{index + 1}</b>{scopeLabel(scope)}
              <code>{scope.scopeKey}</code>
            </span>
          ))}
        </div>
        <form className="combined-recall-form" onSubmit={runCombinedRecall}>
          <label className="field">
            <span>Namespace</span>
            <input
              list="identity-namespaces"
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
            />
            <datalist id="identity-namespaces">
              {overview?.namespaces.map((item) => (
                <option key={item.namespace} value={item.namespace} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span>当前 persona</span>
            <select
              value={personaId}
              onChange={(event) => {
                const nextPersonaId = event.target.value;
                const persona = overview?.personas.find(
                  (item) => item.personaId === nextPersonaId,
                );
                setScopeSelection({
                  personaId: nextPersonaId,
                  sessionId: persona?.latestSession?.externalId || '',
                });
                setRecall(null);
              }}
            >
              <option value="">仅个人共享</option>
              {overview?.personas.map((persona) => (
                <option key={persona.id} value={persona.personaId}>
                  {persona.displayName || persona.personaId}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>当前 session ID</span>
            <input
              value={sessionId}
              onChange={(event) => {
                setScopeSelection((current) => ({
                  ...current,
                  sessionId: event.target.value,
                }));
                setRecall(null);
              }}
              disabled={!personaId}
              placeholder={personaId ? '稳定会话 ID' : '先选择 persona'}
            />
          </label>
          <label className="field field-wide">
            <span>自然问题</span>
            <textarea
              rows={3}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="例如：我对项目首次打开的数据有什么要求？"
            />
          </label>
          <button
            className="button primary"
            disabled={recalling || !query.trim()}
          >
            {recalling ? '正在召回…' : '运行组合召回'}
          </button>
        </form>
        {recall && (
          <div className="combined-recall-results">
            <header>
              <strong>{recall.memories.length} 条最终记忆</strong>
              <span>质量：{recall.qualityState || '未标记'}</span>
            </header>
            {recall.memories.length ? recall.memories.map((item) => (
              <article key={item.memory.id}>
                <div>
                  <strong>{item.memory.title}</strong>
                  <span>{item.score.toFixed(3)}</span>
                </div>
                <p>{item.memory.content}</p>
                <small>
                  {item.memory.scopeType}/{item.memory.scopeKey} ·
                  {' '}{item.reasons.join(' · ')}
                </small>
              </article>
            )) : (
              <p className="panel-empty">当前组合没有召回任何记忆。</p>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
