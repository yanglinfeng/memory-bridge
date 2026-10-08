/**
 * 登录门状态机。
 *
 * 回归背景（发布前修复）：登录门的判据一度是"任何请求拿到 401"+"健康探针拿到 200"，
 * 而 /api/health 是匿名端点，于是形成
 *   health 200 → 撤登录门 → 受保护组件无令牌请求 401 → 挂登录门 → health 200 → …
 * 的反复重挂载循环，用户刚输入的令牌也会被逐次清掉。
 *
 * 这里把信号与状态收敛成一个显式 reducer，使"连通性探针不参与登录态判定"
 * 成为结构性保证，而不是靠调用点自律。
 */
export type AuthenticationGateSignal =
  | { type: 'identity-ok' }
  | { type: 'identity-unauthorized' }
  | { type: 'identity-service-absent' }
  | { type: 'authentication-lost' }
  | { type: 'health-ok' }
  | { type: 'health-unreachable' };

export function reduceAuthenticationGate(
  required: boolean,
  signal: AuthenticationGateSignal,
): boolean {
  switch (signal.type) {
    case 'identity-ok':
    // 该实例未启用身份服务（503）：管理台按匿名可用处理，不该拦人。
    case 'identity-service-absent':
      return false;
    case 'identity-unauthorized':
    case 'authentication-lost':
      return true;
    // 连通性信号：服务可达与否与"是否需要令牌"无关，状态原样保留。
    case 'health-ok':
    case 'health-unreachable':
      return required;
  }
}

/**
 * 身份探针的 HTTP 状态 → 登录门信号。
 * 返回 null 表示"这次探测没有取得关于登录态的信息"（网络不可达），调用方应保持原状态。
 */
export function authenticationGateSignalFromProbeStatus(
  status: number | null,
): AuthenticationGateSignal | null {
  if (status === 401) return { type: 'identity-unauthorized' };
  if (status === 503) return { type: 'identity-service-absent' };
  if (status === null) return null;
  return { type: 'identity-ok' };
}
