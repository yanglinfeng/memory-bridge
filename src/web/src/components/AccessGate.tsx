import { useState } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { api } from '../api';

export function AccessGate({
  onAuthenticated,
  onToast,
}: {
  onAuthenticated: () => void;
  onToast: (message: string, error?: boolean) => void;
}) {
  const [token, setToken] = useState('');
  const [checking, setChecking] = useState(false);

  const authenticate = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = token.trim();
    if (!value) return;
    setChecking(true);
    api.setAccessToken(value);
    try {
      await api.identity();
      setToken('');
      onAuthenticated();
      onToast('账户凭据已验证');
    } catch (error) {
      api.clearAccessToken();
      onToast(
        error instanceof Error ? error.message : '凭据验证失败',
        true,
      );
    } finally {
      setChecking(false);
    }
  };

  return (
    <main className="access-gate">
      <section>
        <span className="access-gate-icon"><ShieldCheck size={28} /></span>
        <div>
          <h1>连接你的本地账户</h1>
          <p>
            当前记忆库已经启用账户凭据。令牌只保存在这个页面的内存中，
            不会写入浏览器存储；刷新或关闭页面后需要重新输入。
          </p>
        </div>
        <form onSubmit={authenticate}>
          <label className="field">
            <span>Memory Bridge 访问令牌</span>
            <div className="token-input">
              <KeyRound size={18} />
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="mb1.…"
                autoFocus
              />
            </div>
          </label>
          <button
            className="button primary"
            disabled={checking || !token.trim()}
          >
            {checking ? '正在验证…' : '验证并进入'}
          </button>
        </form>
        <small>
          忘记令牌时，旧令牌无法恢复。先在本机终端运行
          {' '}<code>npm run identity -- list-principals</code> 找到账户 ID，
          再运行
          {' '}<code>
            npm run identity -- issue-token --principal ACCOUNT_ID --label 管理台恢复
          </code>
          。完整新令牌只在签发当次输出。
        </small>
      </section>
    </main>
  );
}
