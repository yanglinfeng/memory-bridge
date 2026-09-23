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
import { api } from './api';
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

  const authenticationChanged = useCallback(() => {
    authenticationEpoch.current += 1;
    authenticationGate.current = false;
    setAuthenticationRequired(false);
    setAuthenticationRevision((value) => value + 1);
  }, []);

  const authenticationLost = useCallback(() => {
    api.clearAccessToken();
    setHealth(null);
    if (authenticationGate.current) return;
    authenticationEpoch.current += 1;
    authenticationGate.current = true;
    setAuthenticationRequired(true);
    setAuthenticationRevision((value) => value + 1);
  }, []);

  useEffect(
    () => api.onAuthenticationRequired(authenticationLost),
    [authenticationLost],
  );

  useEffect(() => {
    let mounted = true;
    const epoch = authenticationEpoch.current;
    const check = () =>
      api.health().then((value) => {
        if (!mounted || epoch !== authenticationEpoch.current) return;
        setHealth(value);
        authenticationGate.current = false;
        setAuthenticationRequired(false);
      }).catch(() => {
        if (!mounted || epoch !== authenticationEpoch.current) return;
        setHealth(null);
      });
    check();
    const timer = window.setInterval(check, 15_000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [authenticationRevision]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><BrainCircuit size={21} /></span>
          <strong>忆桥 <span>Memory Bridge</span></strong>
        </div>
        <div
          className={`connection-state ${health ? 'connected' : 'offline'}`}
        >
          {health ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
          {health
            ? '本地服务已连接'
            : authenticationRequired
              ? '需要账户令牌'
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
