import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  BookOpen,
  BrainCircuit,
  CheckCircle2,
  CircleAlert,
  ClipboardList,
  Database,
  Inbox,
  MessageCircle,
  Plug,
  Search,
  Settings,
  Sparkles,
  UserRound,
} from 'lucide-react';
import { api, ApiError } from './api';
import {
  authenticationGateSignalFromProbeStatus,
  reduceAuthenticationGate,
  type AuthenticationGateSignal,
} from './authentication-gate';
import { AccessGate } from './components/AccessGate';
import { AccountPage } from './components/AccountPage';
import { AiriSetup } from './components/AiriSetup';
import { AuditLog } from './components/AuditLog';
import { CandidateInbox } from './components/CandidateInbox';
import { ChatWorkspace } from './components/ChatWorkspace';
import { MemoryLibrary } from './components/MemoryLibrary';
import { RecallLab } from './components/RecallLab';
import { ReflectionCenter } from './components/ReflectionCenter';
import { SettingsPage } from './components/SettingsPage';
import { SystemStatus } from './components/SystemStatus';
import type { ServiceHealth } from './types';

type Page =
  | 'chat'
  | 'memories'
  | 'candidates'
  | 'recall'
  | 'reflection'
  | 'system'
  | 'audit'
  | 'airi'
  | 'account'
  | 'settings';

const NAVIGATION: Array<{
  id: Page;
  label: string;
  icon: typeof Database;
}> = [
  { id: 'chat', label: '对话', icon: MessageCircle },
  { id: 'memories', label: '记忆库', icon: Database },
  { id: 'candidates', label: '待确认', icon: Inbox },
  { id: 'recall', label: '召回测试', icon: Search },
  { id: 'reflection', label: '历史重提炼', icon: Sparkles },
  { id: 'system', label: '系统状态', icon: Activity },
  { id: 'audit', label: '审计日志', icon: ClipboardList },
  { id: 'airi', label: 'AIRI 接入', icon: Plug },
  { id: 'account', label: '账户', icon: UserRound },
  { id: 'settings', label: '设置', icon: Settings },
];

export default function App() {
  const [page, setPage] = useState<Page>('chat');
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [authenticationRequired, setAuthenticationRequired] =
    useState(false);
  const [authenticationRevision, setAuthenticationRevision] = useState(0);
  const authenticationEpoch = useRef(0);
  const authenticationGate = useRef(false);
  const [toast, setToast] = useState<{
    message: string;
    error: boolean;
  } | null>(null);

  const showToast = useCallback((message: string, error = false) => {
    setToast({ message, error });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const applyGateSignal = useCallback((signal: AuthenticationGateSignal) => {
    const next = reduceAuthenticationGate(authenticationGate.current, signal);
    const changed = next !== authenticationGate.current;
    authenticationGate.current = next;
    setAuthenticationRequired(next);
    // 只在"挂门/撤门"的边沿重挂载页面级组件：401 洪峰不会引发反复重挂载。
    if (changed) {
      authenticationEpoch.current += 1;
      setAuthenticationRevision((value) => value + 1);
    }
  }, []);

  const authenticationChanged = useCallback(() => {
    applyGateSignal({ type: 'identity-ok' });
  }, [applyGateSignal]);

  const authenticationLost = useCallback(() => {
    api.clearAccessToken();
    setHealth(null);
    applyGateSignal({ type: 'authentication-lost' });
  }, [applyGateSignal]);

  useEffect(
    () => api.onAuthenticationRequired(authenticationLost),
    [authenticationLost],
  );

  // 登录门的唯一判据是 /api/identity 是否 401。
  // 曾经的实现让 health 探针（匿名 200）去撤登录门，于是形成
  // "health 200 → 撤门 → 受保护组件无令牌请求 401 → 挂门 → health 200 → …"
  // 的反复重挂载循环，用户刚输入的令牌也会被每次 401 清掉。
  useEffect(() => {
    let mounted = true;
    const epoch = authenticationEpoch.current;
    api
      .identity()
      .then(() => {
        if (!mounted || epoch !== authenticationEpoch.current) return;
        applyGateSignal({ type: 'identity-ok' });
      })
      .catch((error: unknown) => {
        if (!mounted || epoch !== authenticationEpoch.current) return;
        const status = error instanceof ApiError ? error.status : null;
        const signal = authenticationGateSignalFromProbeStatus(status);
        if (signal) applyGateSignal(signal);
      });
    return () => {
      mounted = false;
    };
  }, [authenticationRevision, applyGateSignal]);

  useEffect(() => {
    let mounted = true;
    const epoch = authenticationEpoch.current;
    const check = () =>
      api.health().then((value) => {
        if (!mounted || epoch !== authenticationEpoch.current) return;
        // 连通性信号：只更新状态指示，不改登录门
        setHealth(value);
        applyGateSignal({ type: 'health-ok' });
      }).catch(() => {
        if (!mounted || epoch !== authenticationEpoch.current) return;
        setHealth(null);
        applyGateSignal({ type: 'health-unreachable' });
      });
    check();
    const timer = window.setInterval(check, 15_000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [authenticationRevision, applyGateSignal]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><BrainCircuit size={21} /></span>
          <strong>忆桥 <span>Memory Bridge</span></strong>
        </div>
        <div
          className={`connection-state ${
            authenticationRequired
              ? 'offline'
              : health
                ? 'connected'
                : 'offline'
          }`}
        >
          {authenticationRequired || !health
            ? <CircleAlert size={16} />
            : <CheckCircle2 size={16} />}
          {authenticationRequired
            ? '需要账户令牌'
            : health
              ? '本地服务已连接'
              : '本地服务未连接'}
        </div>
      </header>

      <aside className="sidebar">
        <nav aria-label="主导航">
          {NAVIGATION.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={page === item.id ? 'active' : ''}
                aria-label={item.label}
                onClick={() => setPage(item.id)}
              >
                <Icon size={20} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-note">
          <BookOpen size={17} />
          <div>
            <strong>本地优先</strong>
            <span>记忆默认不离开这台电脑</span>
          </div>
        </div>
      </aside>

      <section className="app-content">
        {authenticationRequired ? (
          <AccessGate
            onAuthenticated={authenticationChanged}
            onToast={showToast}
          />
        ) : (
          <>
            {page === 'chat' && <ChatWorkspace onToast={showToast} />}
            {page === 'memories' && <MemoryLibrary onToast={showToast} />}
            {page === 'candidates' && <CandidateInbox onToast={showToast} />}
            {page === 'recall' && <RecallLab onToast={showToast} />}
            {page === 'reflection' && (
              <ReflectionCenter onToast={showToast} />
            )}
            {page === 'system' && <SystemStatus onToast={showToast} />}
            {page === 'audit' && <AuditLog onToast={showToast} />}
            {page === 'airi' && <AiriSetup onToast={showToast} />}
            {page === 'account' && (
              <AccountPage
                onToast={showToast}
                onAuthenticationChanged={authenticationChanged}
                onAuthenticationRequired={authenticationLost}
              />
            )}
            {page === 'settings' && <SettingsPage onToast={showToast} />}
          </>
        )}
      </section>

      <footer className="statusbar">
        <span className={health ? 'ok' : 'error'}>
          <i />
          {health
            ? 'HTTP 已连接'
            : authenticationRequired
              ? '等待账户验证'
              : 'HTTP 未连接'}
        </span>
        <span className="separator" />
        <span>MCP stdio 已就绪</span>
        <span className="separator" />
        <code>{window.location.host || '127.0.0.1:3789'}</code>
      </footer>

      {toast && (
        <div className={`toast ${toast.error ? 'toast-error' : ''}`}>
          {toast.error ? <CircleAlert size={17} /> : <CheckCircle2 size={17} />}
          {toast.message}
        </div>
      )}
    </div>
  );
}
