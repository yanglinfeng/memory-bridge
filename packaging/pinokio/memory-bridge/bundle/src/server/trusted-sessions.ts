// 可信会话签发服务（Trusted Sessions）：
// 服务对服务路径的部门级隔离核心。与 conversation 体系派生的
// 聊天会话并存，两者最终汇入同一个召回 scope 过滤器。
//
// 安全模型（与 docs/design/multi-tenant-isolation.md 对应）：
// ① 失败关闭——无授权矩阵时签发整体禁用；矩阵存在时未授予的
//    scope 一律拒绝；过期/吊销会话召回直接 401，绝不放大可见范围；
// ② 授权矩阵——按 principalId 声明允许签发的 scope 集
//    （project/role），配置文件驱动，mtime 变化自动热加载；
// ③ scope 绑定不可变——签发后 scopes 冻结在会话记录上，
//    权限变更 = 吊销旧会话 + 重新签发；
// ④ 写读同源——能签发某 scope 的 principal 才能向该 scope
//    写入（授权判定共用 assertScopesGranted）。

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { isClientIdentityId } from './client-identity-contract.js';
import type { MemoryClassification } from './types.js';

export const ISSUABLE_SCOPE_TYPES = ['project', 'role', 'public'] as const;

export type IssuableScopeType = (typeof ISSUABLE_SCOPE_TYPES)[number];

/** 密级从高到低；clearance 只能 ≤ 主体授权的密级。 */
const CLEARANCE_RANK: Record<MemoryClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
};

export function isMemoryClassification(
  value: unknown,
): value is MemoryClassification {
  return value === 'public' ||
    value === 'internal' ||
    value === 'confidential';
}

export interface TrustedSessionScope {
  scopeType: IssuableScopeType;
  scopeKey: string;
}

export interface TrustedSessionRecord {
  sessionId: string;
  principalId: string;
  scopes: TrustedSessionScope[];
  /** 会话密级：共享作用域内密级 ≤ clearance 的记忆可见。 */
  clearance: MemoryClassification;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface PrincipalGrants {
  scopes: string[];
  maxActiveSessions: number;
  /** 主体可获得的最高密级，缺省 internal。 */
  clearance?: MemoryClassification;
}

export interface GrantsFile {
  principals: Record<string, PrincipalGrants>;
}

export const DEFAULT_MAX_ACTIVE_SESSIONS = 32;
export const DEFAULT_SESSION_TTL_SECONDS = 3_600;
export const MAX_SESSION_TTL_SECONDS = 86_400;
export const MIN_SESSION_TTL_SECONDS = 60;
export const MAX_SCOPES_PER_SESSION = 16;

export class TrustedSessionError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * 授权矩阵：从 JSON 配置文件加载，mtime 缓存热更新。
 * 文件缺失/非法 → 返回 null（失败关闭：签发禁用、写闸关闭，
 * 回落为既有行为，零回归）。
 */
export class SessionScopeGrants {
  private cachedMtimeMs: number | null = null;
  private cachedGrants: GrantsFile | null | undefined;

  constructor(private readonly filePath: string | null) {}

  /** null = 未配置矩阵（功能整体关闭）。 */
  grants(): GrantsFile | null {
    if (!this.filePath) return null;
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(this.filePath).mtimeMs;
    } catch {
      this.cachedMtimeMs = null;
      this.cachedGrants = null;
      return null;
    }
    if (
      this.cachedGrants !== undefined &&
      this.cachedMtimeMs === mtimeMs
    ) {
      return this.cachedGrants;
    }
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.filePath, 'utf8'),
      ) as GrantsFile;
      if (
        !raw ||
        typeof raw !== 'object' ||
        typeof raw.principals !== 'object' ||
        raw.principals === null
      ) {
        throw new Error('缺少 principals 对象');
      }
      for (
        const [principalId, grants] of Object.entries(raw.principals)
      ) {
        if (!Array.isArray(grants.scopes)) {
          throw new Error(`principal ${principalId} 缺少 scopes 数组`);
        }
        for (const scope of grants.scopes) {
          parseGrantedScope(scope);
        }
        if (
          grants.maxActiveSessions !== undefined &&
          (!Number.isInteger(grants.maxActiveSessions) ||
            grants.maxActiveSessions < 1)
        ) {
          throw new Error(
            `principal ${principalId} 的 maxActiveSessions 必须是正整数`,
          );
        }
        if (
          grants.clearance !== undefined &&
          !isMemoryClassification(grants.clearance)
        ) {
          throw new Error(
            `principal ${principalId} 的 clearance 必须是 public/internal/confidential`,
          );
        }
      }
      this.cachedGrants = raw;
      this.cachedMtimeMs = mtimeMs;
      return raw;
    } catch (error) {
      // 配置坏了按"未配置"处理并清缓存，但保留错误信息便于排查
      this.cachedGrants = null;
      this.cachedMtimeMs = null;
      console.error(
        '[trusted-sessions] 授权矩阵文件加载失败，会话签发已禁用：',
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  grantsFor(principalId: string): PrincipalGrants | null {
    const grants = this.grants();
    return grants?.principals[principalId] ?? null;
  }

  /**
   * 写读同源判定：principal 是否被授予指定 scope。
   * personal/self 恒允许（不经过矩阵）。
   */
  assertScopesGranted(
    principalId: string,
    scopes: ReadonlyArray<{ scopeType: string; scopeKey: string }>,
  ): void {
    const own = this.grantsFor(principalId);
    if (!own) {
      throw new TrustedSessionError(
        403,
        `principal ${principalId} 未配置任何 scope 授权，` +
          '无法签发会话或写入受控作用域',
      );
    }
    const granted = new Set(own.scopes);
    for (const scope of scopes) {
      if (scope.scopeType === 'personal' && scope.scopeKey === 'self') {
        continue;
      }
      const key = `${scope.scopeType}:${scope.scopeKey}`;
      if (!granted.has(key)) {
        throw new TrustedSessionError(
          403,
          `scope ${key} 不在 principal ${principalId} 的授权范围内`,
        );
      }
    }
  }
}

/** 矩阵条目 "project:dept-finance" → 结构化 scope；裸 "public" 等价
 * "public:public"；非法即抛。 */
export function parseGrantedScope(
  raw: string,
): { scopeType: IssuableScopeType; scopeKey: string } {
  if (typeof raw !== 'string') {
    throw new Error(`scope 授权项必须是字符串：${String(raw)}`);
  }
  if (raw === 'public') {
    return { scopeType: 'public', scopeKey: 'public' };
  }
  const separator = raw.indexOf(':');
  if (separator <= 0) {
    throw new Error(`scope 授权项必须形如 "type:key"：${raw}`);
  }
  const scopeType = raw.slice(0, separator);
  const scopeKey = raw.slice(separator + 1);
  if (
    !(ISSUABLE_SCOPE_TYPES as readonly string[]).includes(scopeType)
  ) {
    throw new Error(
      `scope 类型必须是 ${ISSUABLE_SCOPE_TYPES.join('/')}：${raw}`,
    );
  }
  if (!isClientIdentityId(scopeKey)) {
    throw new Error(`scope key 不合法：${raw}`);
  }
  return {
    scopeType: scopeType as IssuableScopeType,
    scopeKey,
  };
}

export class TrustedSessionService {
  constructor(
    private readonly database: DatabaseSync,
    readonly grantStore: SessionScopeGrants,
  ) {}

  /**
   * 写/列侧同源闸门：授权矩阵未配置（功能整体关闭）或未指定
   * 受控 scope（默认 personal/self）时放行；否则逐项校验授权。
   */
  assertScopeAllowed(
    principalId: string,
    scopeType?: string,
    scopeKey?: string,
  ): void {
    if (!this.grantStore.grants()) return;
    if (!scopeType && !scopeKey) return;
    this.grantStore.assertScopesGranted(principalId, [
      {
        scopeType: scopeType || 'personal',
        scopeKey: scopeKey || 'self',
      },
    ]);
  }

  /**
   * 签发会话。scopes 逐项校验授权矩阵，全部通过才签发。
   * clearance 取请求值与主体授权密级的较小者（缺省 internal）。
   */
  issue(
    principalId: string,
    scopes: TrustedSessionScope[],
    ttlSeconds?: number,
    requestedClearance?: MemoryClassification,
  ): TrustedSessionRecord {
    const grants = this.grantStore.grantsFor(principalId);
    if (!grants) {
      throw new TrustedSessionError(
        403,
        `principal ${principalId} 未配置 scope 授权，禁止签发会话`,
      );
    }
    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw new TrustedSessionError(
        400,
        'scopes 必须是非空数组',
      );
    }
    // scope 类型不在此处前置校验：授权矩阵只登记 project/role/public
    // 键（加载时经 parseGrantedScope 校验），任何其他类型的 scope 在
    // assertScopesGranted 处必然 403——保持既有错误语义（零回归）。
    if (scopes.length > MAX_SCOPES_PER_SESSION) {
      throw new TrustedSessionError(
        400,
        `单个会话最多绑定 ${MAX_SCOPES_PER_SESSION} 个 scope`,
      );
    }
    this.grantStore.assertScopesGranted(principalId, scopes);
    const grantedClearance = grants.clearance ?? 'internal';
    const requested = requestedClearance ?? 'internal';
    if (!isMemoryClassification(requested)) {
      throw new TrustedSessionError(
        400,
        'clearance 必须是 public/internal/confidential',
      );
    }
    // 请求密级高于主体授权 → 取主体授权（不放大）。
    const clearance = CLEARANCE_RANK[requested] <=
        CLEARANCE_RANK[grantedClearance]
      ? requested
      : grantedClearance;
    const ttl = ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    if (
      !Number.isInteger(ttl) ||
      ttl < MIN_SESSION_TTL_SECONDS ||
      ttl > MAX_SESSION_TTL_SECONDS
    ) {
      throw new TrustedSessionError(
        400,
        `ttlSeconds 必须在 ${MIN_SESSION_TTL_SECONDS}-${MAX_SESSION_TTL_SECONDS} 之间`,
      );
    }
    const maxActive =
      grants.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS;
    const active = this.activeSessionCount(principalId);
    if (active >= maxActive) {
      throw new TrustedSessionError(
        429,
        `活跃会话数已达上限（${active}/${maxActive}），` +
          '请吊销不再使用的会话后重试',
      );
    }
    const now = new Date();
    const record: TrustedSessionRecord = {
      sessionId: randomUUID(),
      principalId,
      scopes: scopes.map((scope) => ({
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
      })),
      clearance,
      issuedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + ttl * 1_000,
      ).toISOString(),
      revokedAt: null,
    };
    this.database.prepare(`
      INSERT INTO trusted_sessions
        (session_id, principal_id, scopes_json, clearance,
         issued_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(
      record.sessionId,
      record.principalId,
      JSON.stringify(record.scopes),
      record.clearance,
      record.issuedAt,
      record.expiresAt,
    );
    return record;
  }

  revoke(sessionId: string, principalId: string): boolean {
    const existing = this.get(sessionId);
    if (!existing || existing.principalId !== principalId) {
      return false;
    }
    if (existing.revokedAt) return true;
    this.database.prepare(`
      UPDATE trusted_sessions
      SET revoked_at = ?
      WHERE session_id = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), sessionId);
    return true;
  }

  get(sessionId: string): TrustedSessionRecord | null {
    const row = this.database.prepare(`
      SELECT session_id, principal_id, scopes_json, clearance,
             issued_at, expires_at, revoked_at
      FROM trusted_sessions
      WHERE session_id = ?
    `).get(sessionId) as
      | {
          session_id: string;
          principal_id: string;
          scopes_json: string;
          clearance: string;
          issued_at: string;
          expires_at: string;
          revoked_at: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      sessionId: row.session_id,
      principalId: row.principal_id,
      scopes: JSON.parse(row.scopes_json) as TrustedSessionScope[],
      clearance: isMemoryClassification(row.clearance)
        ? row.clearance
        : 'internal',
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  }

  activeSessionCount(principalId: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM trusted_sessions
      WHERE principal_id = ?
        AND revoked_at IS NULL
        AND expires_at > ?
    `).get(principalId, new Date().toISOString()) as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  }

  /**
   * 召回侧解析：命中本服务的会话 → 返回完整记录（scopes + clearance）。
   * 非活跃（过期/吊销）→ 抛 401（显式失败，绝不放大可见范围）。
   * 未命中 → 返回 null，调用方回落 conversation 会话解析（零回归）。
   */
  resolveForRecall(
    sessionExternalId: string,
    principalId: string,
  ): TrustedSessionRecord | null {
    const record = this.get(sessionExternalId);
    if (!record) return null;
    if (record.principalId !== principalId) {
      throw new TrustedSessionError(
        401,
        '可信会话不属于当前访问主体',
      );
    }
    if (record.revokedAt) {
      throw new TrustedSessionError(401, '可信会话已吊销');
    }
    if (record.expiresAt <= new Date().toISOString()) {
      throw new TrustedSessionError(401, '可信会话已过期，请重新签发');
    }
    return record;
  }
}
