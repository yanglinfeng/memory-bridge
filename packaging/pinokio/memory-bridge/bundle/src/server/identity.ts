import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withSqliteBusyRetry } from './sqlite-retry.js';

const TOKEN_PREFIX = 'mb1';
const TOKEN_SECRET_BYTES = 32;
const TOKEN_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CREDENTIAL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DUMMY_SECRET_HASH = createHash('sha256')
  .update('memory-bridge:identity:dummy-secret:v1')
  .digest();
const authenticatedPrincipalInstances = new WeakSet<object>();

type DatabaseRow = Record<string, unknown>;

export type PrincipalStatus = 'active' | 'disabled';
export type CredentialStatus = 'active' | 'revoked' | 'expired';
export type IdentitySource =
  | 'credential'
  | 'legacy_token'
  | 'anonymous_loopback'
  | 'mcp_trusted'
  | 'internal_job';

export interface AccountPrincipal {
  readonly id: string;
  readonly displayName: string;
  readonly status: PrincipalStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly disabledAt: string | null;
}

export interface AuthCredential {
  readonly id: string;
  readonly principalId: string;
  readonly label: string;
  readonly secretHint: string;
  readonly status: CredentialStatus;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
}

export interface IssuedCredential {
  readonly credential: AuthCredential;
  readonly token: string;
}

export interface InitializedAccount extends IssuedCredential {
  readonly principal: AccountPrincipal;
}

export interface AuthenticatedPrincipal {
  readonly principalId: string;
  readonly credentialId: string | null;
  readonly source: IdentitySource;
  readonly authenticatedAt: string;
}

export interface IdentityContext extends AuthenticatedPrincipal {
  readonly namespace: string;
  readonly personaId: string | null;
  readonly sessionId: string | null;
}

export interface ClientPersonaBinding {
  readonly id: string;
  readonly principalId: string;
  readonly clientType: string;
  readonly clientInstanceId: string;
  readonly personaId: string;
  readonly displayName: string | null;
  readonly status: PrincipalStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSeenAt: string;
}

export interface IdentitySessionOverview {
  readonly id: string;
  readonly namespace: string;
  readonly clientName: string;
  readonly externalId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly identitySource: string;
  readonly identityStatus: string;
}

export interface IdentityPersonaOverview extends ClientPersonaBinding {
  readonly latestSession: IdentitySessionOverview | null;
  readonly roleMemoryCount: number;
}

export interface IdentityNamespaceOverview {
  readonly namespace: string;
  readonly activeMemoryCount: number;
  readonly personalMemoryCount: number;
}

export interface CurrentIdentityOverview {
  readonly principal: AccountPrincipal;
  readonly credential: AuthCredential | null;
  readonly personas: readonly IdentityPersonaOverview[];
  readonly personalMemoryCount: number;
  readonly namespaces: readonly IdentityNamespaceOverview[];
}

export interface IdentityServiceOptions {
  defaultPrincipalId?: string;
  legacyToken?: string;
  now?: () => string;
}

export interface AuthenticateIdentityInput {
  token?: string | null;
  isLoopback: boolean;
}

export type IdentityAuthenticationErrorCode =
  | 'authentication_required'
  | 'invalid_credentials';

export class IdentityAuthenticationError extends Error {
  override readonly name = 'IdentityAuthenticationError';

  constructor(
    readonly code: IdentityAuthenticationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class IdentityBindingConflictError extends Error {
  override readonly name = 'IdentityBindingConflictError';
}

export class IdentityBootstrapConflictError extends Error {
  override readonly name = 'IdentityBootstrapConflictError';
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function cleanRequired(
  value: string,
  field: string,
  maximumLength = 255,
): string {
  const cleaned = value.trim();
  if (
    !cleaned ||
    cleaned.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(cleaned)
  ) {
    throw new Error(`${field} 无效`);
  }
  return cleaned;
}

function cleanOptional(
  value: string | null | undefined,
  field: string,
  maximumLength = 255,
): string | null {
  if (value === null || value === undefined) return null;
  return cleanRequired(value, field, maximumLength);
}

function normalizeTimestamp(value: string, field: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`${field} 无效`);
  }
  return timestamp.toISOString();
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text || null;
}

function principalFromRow(row: DatabaseRow): AccountPrincipal {
  return Object.freeze({
    id: String(row.id),
    displayName: String(row.display_name),
    status: String(row.status) as PrincipalStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    disabledAt: nullableText(row.disabled_at),
  });
}

function credentialFromRow(row: DatabaseRow): AuthCredential {
  return Object.freeze({
    id: String(row.id),
    principalId: String(row.principal_id),
    label: String(row.label),
    secretHint: String(row.secret_hint),
    status: String(row.status) as CredentialStatus,
    createdAt: String(row.created_at),
    expiresAt: nullableText(row.expires_at),
    revokedAt: nullableText(row.revoked_at),
    lastUsedAt: nullableText(row.last_used_at),
  });
}

function personaBindingFromRow(
  row: DatabaseRow,
): ClientPersonaBinding {
  return Object.freeze({
    id: String(row.id),
    principalId: String(row.principal_id),
    clientType: String(row.client_type),
    clientInstanceId: String(row.client_instance_id),
    personaId: String(row.persona_id),
    displayName: nullableText(row.display_name),
    status: String(row.status) as PrincipalStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastSeenAt: String(row.last_seen_at),
  });
}

function parsedStoredToken(
  token: string,
): { credentialId: string; secret: string } | null {
  if (token.length > 512) return null;
  const parts = token.split('.');
  if (
    parts.length !== 3 ||
    parts[0] !== TOKEN_PREFIX ||
    !CREDENTIAL_ID_PATTERN.test(parts[1]) ||
    !TOKEN_SECRET_PATTERN.test(parts[2])
  ) {
    return null;
  }
  return {
    credentialId: parts[1],
    secret: parts[2],
  };
}

function readonlyAuthenticatedPrincipal(
  input: AuthenticatedPrincipal,
): AuthenticatedPrincipal {
  const principal = Object.freeze({ ...input });
  authenticatedPrincipalInstances.add(principal);
  return principal;
}

export class IdentityService {
  private readonly defaultPrincipalId: string;
  private readonly legacyTokenHash: Buffer | null;
  private readonly now: () => string;

  constructor(
    private readonly database: DatabaseSync,
    options: IdentityServiceOptions = {},
  ) {
    this.defaultPrincipalId = cleanRequired(
      options.defaultPrincipalId || 'default',
      'defaultPrincipalId',
    );
    this.legacyTokenHash = options.legacyToken
      ? sha256(options.legacyToken)
      : null;
    this.now = options.now || (() => new Date().toISOString());
    const timestamp = normalizeTimestamp(this.now(), 'now');
    withSqliteBusyRetry(
      () =>
        this.database
          .prepare(
            `INSERT OR IGNORE INTO account_principals (
               id, display_name, status, created_at, updated_at
             ) VALUES (?, ?, 'active', ?, ?)`,
          )
          .run(
            this.defaultPrincipalId,
            this.defaultPrincipalId,
            timestamp,
            timestamp,
          ),
      {
        operation: 'initialize startup principal',
        maxAttempts: 8,
        totalBudgetMs: 15_000,
      },
    );
  }

  createPrincipal(input: {
    id?: string;
    displayName: string;
  }): AccountPrincipal {
    const id = input.id
      ? cleanRequired(input.id, 'principalId')
      : randomUUID();
    const displayName = cleanRequired(
      input.displayName,
      'displayName',
    );
    if (this.principalRow(id)) {
      throw new Error('账户 principal 已存在');
    }
    const timestamp = normalizeTimestamp(this.now(), 'now');
    this.database
      .prepare(
        `INSERT INTO account_principals (
           id, display_name, status, created_at, updated_at
         ) VALUES (?, ?, 'active', ?, ?)`,
      )
      .run(id, displayName, timestamp, timestamp);
    this.audit({
      action: 'principal_created',
      outcome: 'success',
      principalId: id,
      source: 'internal_job',
      createdAt: timestamp,
    });
    return this.requirePrincipal(id);
  }

  listPrincipals(): readonly AccountPrincipal[] {
    const rows = this.database
      .prepare(
        `SELECT id, display_name, status, created_at, updated_at,
                disabled_at
         FROM account_principals
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as DatabaseRow[];
    return Object.freeze(rows.map(principalFromRow));
  }

  initializeFirstAccount(input: {
    principalId?: string;
    displayName: string;
    label: string;
    expiresAt?: string | null;
  }): InitializedAccount {
    const principalId = input.principalId
      ? cleanRequired(input.principalId, 'principalId')
      : this.defaultPrincipalId;
    const displayName = cleanRequired(
      input.displayName,
      'displayName',
    );
    const label = cleanRequired(input.label, 'label');
    const expiresAt = input.expiresAt
      ? normalizeTimestamp(input.expiresAt, 'expiresAt')
      : null;
    const timestamp = normalizeTimestamp(this.now(), 'now');
    if (expiresAt && expiresAt <= timestamp) {
      throw new Error('expiresAt 必须晚于当前时间');
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (this.hasCredentialHistory()) {
        throw new IdentityBootstrapConflictError(
          '首个账户初始化已经永久关闭',
        );
      }

      const existing = this.principalRow(principalId);
      if (existing && principalId !== this.defaultPrincipalId) {
        throw new Error('账户 principal 已存在');
      }
      if (existing) {
        if (String(existing.status) !== 'active') {
          throw new IdentityAuthenticationError(
            'invalid_credentials',
            '身份凭据无效',
          );
        }
        this.database
          .prepare(
            `UPDATE account_principals
             SET display_name = ?, updated_at = ?
             WHERE id = ? AND status = 'active'`,
          )
          .run(displayName, timestamp, principalId);
        this.audit({
          action: 'principal_initialized',
          outcome: 'success',
          principalId,
          source: 'internal_job',
          createdAt: timestamp,
        });
      } else {
        this.database
          .prepare(
            `INSERT INTO account_principals (
               id, display_name, status, created_at, updated_at
             ) VALUES (?, ?, 'active', ?, ?)`,
          )
          .run(
            principalId,
            displayName,
            timestamp,
            timestamp,
          );
        this.audit({
          action: 'principal_created',
          outcome: 'success',
          principalId,
          source: 'internal_job',
          detail: { bootstrap: true },
          createdAt: timestamp,
        });
      }

      const issued = this.issueCredential({
        principalId,
        label,
        expiresAt,
      });
      const principal = this.requirePrincipal(principalId);
      this.database.exec('COMMIT');
      return Object.freeze({
        principal,
        credential: issued.credential,
        token: issued.token,
      });
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  issueCredential(input: {
    principalId: string;
    label: string;
    expiresAt?: string | null;
  }): IssuedCredential {
    const principalId = cleanRequired(
      input.principalId,
      'principalId',
    );
    const label = cleanRequired(input.label, 'label');
    const principal = this.requireActivePrincipal(principalId);
    const timestamp = normalizeTimestamp(this.now(), 'now');
    const expiresAt = input.expiresAt
      ? normalizeTimestamp(input.expiresAt, 'expiresAt')
      : null;
    if (expiresAt && expiresAt <= timestamp) {
      throw new Error('expiresAt 必须晚于当前时间');
    }

    const id = randomUUID();
    const secret = randomBytes(TOKEN_SECRET_BYTES).toString(
      'base64url',
    );
    const secretHash = sha256(secret);
    const secretHint = `…${secret.slice(-6)}`;
    this.database
      .prepare(
        `INSERT INTO auth_credentials (
           id, principal_id, label, secret_hash, secret_hint,
           status, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        id,
        principal.id,
        label,
        secretHash,
        secretHint,
        timestamp,
        expiresAt,
      );
    this.audit({
      action: 'credential_issued',
      outcome: 'success',
      principalId: principal.id,
      credentialId: id,
      source: 'internal_job',
      detail: {
        hasExpiry: Boolean(expiresAt),
      },
      createdAt: timestamp,
    });
    return Object.freeze({
      credential: this.requireCredential(id),
      token: `${TOKEN_PREFIX}.${id}.${secret}`,
    });
  }

  listCredentials(principalId: string): readonly AuthCredential[] {
    const ownerId = cleanRequired(principalId, 'principalId');
    this.requirePrincipal(ownerId);
    this.expireDueCredentials(ownerId);
    const rows = this.database
      .prepare(
        `SELECT id, principal_id, label, secret_hint, status,
                created_at, expires_at, revoked_at, last_used_at
         FROM auth_credentials
         WHERE principal_id = ?
         ORDER BY created_at DESC, id ASC`,
      )
      .all(ownerId) as DatabaseRow[];
    return Object.freeze(rows.map(credentialFromRow));
  }

  revokeCredential(
    credentialId: string,
    reason?: string,
  ): AuthCredential {
    const id = cleanRequired(credentialId, 'credentialId');
    const existing = this.requireCredential(id);
    if (existing.status === 'revoked') return existing;
    const timestamp = normalizeTimestamp(this.now(), 'now');
    this.database
      .prepare(
        `UPDATE auth_credentials
         SET status = 'revoked',
             revoked_at = ?
         WHERE id = ?`,
      )
      .run(timestamp, id);
    this.audit({
      action: 'credential_revoked',
      outcome: 'success',
      principalId: existing.principalId,
      credentialId: id,
      source: 'internal_job',
      detail: reason
        ? {
            reasonSha256: sha256(reason).toString('hex'),
            reasonLength: reason.length,
          }
        : {},
      createdAt: timestamp,
    });
    return this.requireCredential(id);
  }

  revokeCredentialForPrincipal(
    principalId: string,
    credentialId: string,
    reason?: string,
  ): AuthCredential {
    const ownerId = cleanRequired(principalId, 'principalId');
    this.requirePrincipal(ownerId);
    const id = cleanRequired(credentialId, 'credentialId');
    const credential = this.requireCredential(id);
    if (credential.principalId !== ownerId) {
      throw new Error('身份凭据不存在');
    }
    return this.revokeCredential(id, reason);
  }

  expireCredential(credentialId: string): AuthCredential {
    const id = cleanRequired(credentialId, 'credentialId');
    const existing = this.requireCredential(id);
    if (existing.status !== 'active') return existing;
    const timestamp = normalizeTimestamp(this.now(), 'now');
    withSqliteBusyRetry(
      () =>
        this.database
          .prepare(
            `UPDATE auth_credentials
             SET status = 'expired',
                 expires_at = COALESCE(expires_at, ?)
             WHERE id = ?`,
          )
          .run(timestamp, id),
      {
        operation: 'expire startup credential',
        maxAttempts: 8,
        totalBudgetMs: 15_000,
      },
    );
    this.audit({
      action: 'credential_expired',
      outcome: 'success',
      principalId: existing.principalId,
      credentialId: id,
      source: 'internal_job',
      createdAt: timestamp,
    });
    return this.requireCredential(id);
  }

  authenticate(
    input: AuthenticateIdentityInput,
  ): AuthenticatedPrincipal {
    const timestamp = normalizeTimestamp(this.now(), 'now');
    const token =
      typeof input.token === 'string' && input.token.length > 0
        ? input.token
        : null;

    if (!token) {
      const anonymousAllowed =
        input.isLoopback &&
        this.legacyTokenHash === null &&
        !this.hasCredentialHistory();
      if (!anonymousAllowed) {
        this.audit({
          action: 'authentication_failed',
          outcome: 'denied',
          source: 'anonymous_loopback',
          detail: { reason: 'authentication_required' },
          createdAt: timestamp,
        });
        throw new IdentityAuthenticationError(
          'authentication_required',
          '需要身份凭据',
        );
      }
      const principal = this.requireActivePrincipal(
        this.defaultPrincipalId,
      );
      const authenticated = readonlyAuthenticatedPrincipal({
        principalId: principal.id,
        credentialId: null,
        source: 'anonymous_loopback',
        authenticatedAt: timestamp,
      });
      this.audit({
        action: 'authentication_succeeded',
        outcome: 'success',
        principalId: principal.id,
        source: authenticated.source,
        createdAt: timestamp,
      });
      return authenticated;
    }

    const suppliedTokenHash = sha256(token);
    if (
      this.legacyTokenHash &&
      !this.hasCredentialHistory() &&
      timingSafeEqual(suppliedTokenHash, this.legacyTokenHash)
    ) {
      const principal = this.requireActivePrincipal(
        this.defaultPrincipalId,
      );
      const authenticated = readonlyAuthenticatedPrincipal({
        principalId: principal.id,
        credentialId: null,
        source: 'legacy_token',
        authenticatedAt: timestamp,
      });
      this.audit({
        action: 'authentication_succeeded',
        outcome: 'success',
        principalId: principal.id,
        source: authenticated.source,
        createdAt: timestamp,
      });
      return authenticated;
    }

    const parsed = parsedStoredToken(token);
    const row = parsed
      ? this.database
          .prepare(
            `SELECT
               c.*,
               p.status AS principal_status
             FROM auth_credentials c
             JOIN account_principals p ON p.id = c.principal_id
             WHERE c.id = ?`,
          )
          .get(parsed.credentialId) as DatabaseRow | undefined
      : undefined;
    const candidateHash = sha256(parsed?.secret || token);
    const storedHash = row?.secret_hash
      ? Buffer.from(row.secret_hash as Uint8Array)
      : DUMMY_SECRET_HASH;
    const comparableHash =
      storedHash.byteLength === DUMMY_SECRET_HASH.byteLength
        ? storedHash
        : DUMMY_SECRET_HASH;
    const secretMatches = timingSafeEqual(
      candidateHash,
      comparableHash,
    );

    const expiresAt = nullableText(row?.expires_at);
    if (
      row &&
      row.status === 'active' &&
      expiresAt &&
      expiresAt <= timestamp
    ) {
      this.expireCredential(String(row.id));
      row.status = 'expired';
    }
    const credentialIsActive =
      parsed !== null &&
      row !== undefined &&
      secretMatches &&
      row.status === 'active' &&
      row.principal_status === 'active';
    if (!credentialIsActive) {
      this.audit({
        action: 'authentication_failed',
        outcome: 'denied',
        principalId: row ? String(row.principal_id) : null,
        credentialId: row ? String(row.id) : null,
        source: 'credential',
        detail: { reason: 'invalid_credentials' },
        createdAt: timestamp,
      });
      throw new IdentityAuthenticationError(
        'invalid_credentials',
        '身份凭据无效',
      );
    }

    withSqliteBusyRetry(
      () =>
        this.database
          .prepare(
            `UPDATE auth_credentials
             SET last_used_at = ?
             WHERE id = ?`,
          )
          .run(timestamp, String(row.id)),
      {
        operation: 'record startup credential use',
        maxAttempts: 8,
        totalBudgetMs: 15_000,
      },
    );
    const authenticated = readonlyAuthenticatedPrincipal({
      principalId: String(row.principal_id),
      credentialId: String(row.id),
      source: 'credential',
      authenticatedAt: timestamp,
    });
    this.audit({
      action: 'authentication_succeeded',
      outcome: 'success',
      principalId: authenticated.principalId,
      credentialId: authenticated.credentialId,
      source: authenticated.source,
      createdAt: timestamp,
    });
    return authenticated;
  }

  authenticateAuthorizationHeader(
    authorization: string | null | undefined,
    isLoopback: boolean,
  ): AuthenticatedPrincipal {
    if (!authorization) {
      return this.authenticate({ token: null, isLoopback });
    }
    const match = /^Bearer ([^\s]+)$/iu.exec(authorization);
    return this.authenticate({
      token: match?.[1] || authorization,
      isLoopback,
    });
  }

  trustPrincipal(
    principalId: string,
    source: Extract<
      IdentitySource,
      'mcp_trusted' | 'internal_job'
    > = 'mcp_trusted',
  ): AuthenticatedPrincipal {
    const principal = this.requireActivePrincipal(
      cleanRequired(principalId, 'principalId'),
    );
    const timestamp = normalizeTimestamp(this.now(), 'now');
    return readonlyAuthenticatedPrincipal({
      principalId: principal.id,
      credentialId: null,
      source,
      authenticatedAt: timestamp,
    });
  }

  createContext(
    principal: AuthenticatedPrincipal,
    input: {
      namespace: string;
      personaId?: string | null;
      sessionId?: string | null;
    },
  ): IdentityContext {
    if (!authenticatedPrincipalInstances.has(principal)) {
      throw new Error('principal 不是由可信身份解析器创建的');
    }
    return Object.freeze({
      ...principal,
      namespace: cleanRequired(input.namespace, 'namespace'),
      personaId: cleanOptional(input.personaId, 'personaId'),
      sessionId: cleanOptional(input.sessionId, 'sessionId'),
    });
  }

  currentOverview(
    principal: AuthenticatedPrincipal,
  ): CurrentIdentityOverview {
    if (!authenticatedPrincipalInstances.has(principal)) {
      throw new Error('principal 不是由可信身份解析器创建的');
    }
    const principalId = cleanRequired(
      principal.principalId,
      'principalId',
    );
    const account = this.requirePrincipal(principalId);
    let credential: AuthCredential | null = null;
    if (principal.credentialId) {
      const credentialRow = this.database
        .prepare(
          `SELECT id, principal_id, label, secret_hint, status,
                  created_at, expires_at, revoked_at, last_used_at
           FROM auth_credentials
           WHERE id = ? AND principal_id = ?`,
        )
        .get(
          cleanRequired(principal.credentialId, 'credentialId'),
          principalId,
        ) as DatabaseRow | undefined;
      if (!credentialRow) {
        throw new IdentityAuthenticationError(
          'invalid_credentials',
          '身份凭据无效',
        );
      }
      credential = credentialFromRow(credentialRow);
    }

    const bindingRows = this.database
      .prepare(
        `SELECT *
         FROM client_persona_bindings
         WHERE principal_id = ?
         ORDER BY updated_at DESC, id ASC`,
      )
      .all(principalId) as DatabaseRow[];
    const latestSession = this.database.prepare(
      `SELECT id, namespace, client_name, external_id, started_at,
              ended_at, identity_source, identity_status
       FROM conversation_sessions
       WHERE user_id = ? AND persona_id = ?
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
    );
    const roleMemoryCount = this.database.prepare(
      `SELECT COUNT(*) AS count
       FROM memories
       WHERE user_id = ?
         AND scope_type = 'role'
         AND scope_key = ?
         AND status = 'active'`,
    );
    const personas = bindingRows.map((row) => {
      const binding = personaBindingFromRow(row);
      const session = latestSession.get(
        principalId,
        binding.personaId,
      ) as DatabaseRow | undefined;
      return Object.freeze({
        ...binding,
        latestSession: session
          ? Object.freeze({
              id: String(session.id),
              namespace: String(session.namespace),
              clientName: String(session.client_name),
              externalId: String(session.external_id),
              startedAt: String(session.started_at),
              endedAt: nullableText(session.ended_at),
              identitySource: String(session.identity_source),
              identityStatus: String(session.identity_status),
            })
          : null,
        roleMemoryCount: Number(
          roleMemoryCount.get(
            principalId,
            binding.personaId,
          )?.count ?? 0,
        ),
      });
    });
    const namespaceRows = this.database
      .prepare(
        `SELECT
           namespace,
           COUNT(*) AS active_memory_count,
           SUM(CASE WHEN scope_type = 'personal' THEN 1 ELSE 0 END)
             AS personal_memory_count
         FROM memories
         WHERE user_id = ? AND status = 'active'
         GROUP BY namespace
         ORDER BY namespace ASC`,
      )
      .all(principalId) as DatabaseRow[];
    const namespaces = namespaceRows.map((row) =>
      Object.freeze({
        namespace: String(row.namespace),
        activeMemoryCount: Number(row.active_memory_count),
        personalMemoryCount: Number(row.personal_memory_count),
      })
    );
    return Object.freeze({
      principal: account,
      credential,
      personas: Object.freeze(personas),
      personalMemoryCount: namespaces.reduce(
        (total, namespace) =>
          total + namespace.personalMemoryCount,
        0,
      ),
      namespaces: Object.freeze(namespaces),
    });
  }

  bindPersona(
    principal: AuthenticatedPrincipal,
    input: {
      clientType: string;
      clientInstanceId: string;
      personaId: string;
      displayName?: string | null;
    },
  ): ClientPersonaBinding {
    if (!authenticatedPrincipalInstances.has(principal)) {
      throw new Error('principal 不是由可信身份解析器创建的');
    }
    const clientType = cleanRequired(
      input.clientType,
      'clientType',
    );
    const clientInstanceId = cleanRequired(
      input.clientInstanceId,
      'clientInstanceId',
    );
    const personaId = cleanRequired(input.personaId, 'personaId');
    const displayNameProvided = input.displayName !== undefined;
    const displayName = cleanOptional(
      input.displayName,
      'displayName',
    );
    const timestamp = normalizeTimestamp(this.now(), 'now');
    const existing = this.database
      .prepare(
        `SELECT *
         FROM client_persona_bindings
         WHERE principal_id = ?
           AND client_type = ?
           AND client_instance_id = ?
           AND persona_id = ?`,
      )
      .get(
        principal.principalId,
        clientType,
        clientInstanceId,
        personaId,
      ) as DatabaseRow | undefined;

    let id = existing ? String(existing.id) : randomUUID();
    if (existing) {
      this.database
        .prepare(
          `UPDATE client_persona_bindings
           SET display_name = CASE WHEN ? = 1 THEN ? ELSE display_name END,
               status = 'active',
               updated_at = ?,
               last_seen_at = ?
           WHERE id = ?
             AND principal_id = ?`,
        )
        .run(
          displayNameProvided ? 1 : 0,
          displayName,
          timestamp,
          timestamp,
          id,
          principal.principalId,
        );
    } else {
      this.database
        .prepare(
          `INSERT INTO client_persona_bindings (
             id, principal_id, client_type, client_instance_id,
             persona_id, display_name, status, created_at,
             updated_at, last_seen_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?
           )`,
        )
        .run(
          id,
          principal.principalId,
          clientType,
          clientInstanceId,
          personaId,
          displayName,
          timestamp,
          timestamp,
          timestamp,
        );
    }
    this.audit({
      action: existing ? 'persona_binding_seen' : 'persona_bound',
      outcome: 'success',
      principalId: principal.principalId,
      source: principal.source,
      detail: { bindingId: id },
      createdAt: timestamp,
    });
    const row = this.database
      .prepare(
        `SELECT *
         FROM client_persona_bindings
         WHERE id = ?
           AND principal_id = ?`,
      )
      .get(id, principal.principalId) as DatabaseRow | undefined;
    if (!row) {
      throw new Error('persona 绑定写入失败');
    }
    return personaBindingFromRow(row);
  }

  listPersonaBindings(
    principalId: string,
  ): readonly ClientPersonaBinding[] {
    const ownerId = cleanRequired(principalId, 'principalId');
    this.requirePrincipal(ownerId);
    const rows = this.database
      .prepare(
        `SELECT *
         FROM client_persona_bindings
         WHERE principal_id = ?
         ORDER BY updated_at DESC, id ASC`,
      )
      .all(ownerId) as DatabaseRow[];
    return Object.freeze(rows.map(personaBindingFromRow));
  }

  private hasCredentialHistory(): boolean {
    return (
      Number(
        this.database
          .prepare(
            'SELECT COUNT(*) AS count FROM auth_credentials',
          )
          .get()?.count ?? 0,
      ) > 0
    );
  }

  private expireDueCredentials(principalId: string): void {
    const timestamp = normalizeTimestamp(this.now(), 'now');
    const rows = this.database
      .prepare(
        `SELECT id
         FROM auth_credentials
         WHERE principal_id = ?
           AND status = 'active'
           AND expires_at IS NOT NULL
           AND expires_at <= ?
         ORDER BY id ASC`,
      )
      .all(principalId, timestamp) as DatabaseRow[];
    for (const row of rows) {
      this.expireCredential(String(row.id));
    }
  }

  private principalRow(id: string): DatabaseRow | undefined {
    return this.database
      .prepare('SELECT * FROM account_principals WHERE id = ?')
      .get(id) as DatabaseRow | undefined;
  }

  private requirePrincipal(id: string): AccountPrincipal {
    const row = this.principalRow(id);
    if (!row) throw new Error('账户 principal 不存在');
    return principalFromRow(row);
  }

  private requireActivePrincipal(id: string): AccountPrincipal {
    const principal = this.requirePrincipal(id);
    if (principal.status !== 'active') {
      throw new IdentityAuthenticationError(
        'invalid_credentials',
        '身份凭据无效',
      );
    }
    return principal;
  }

  private requireCredential(id: string): AuthCredential {
    const row = this.database
      .prepare('SELECT * FROM auth_credentials WHERE id = ?')
      .get(id) as DatabaseRow | undefined;
    if (!row) throw new Error('身份凭据不存在');
    return credentialFromRow(row);
  }

  private audit(input: {
    action: string;
    outcome: 'success' | 'denied' | 'failure';
    principalId?: string | null;
    credentialId?: string | null;
    source: IdentitySource;
    detail?: Record<string, unknown>;
    createdAt: string;
  }): void {
    withSqliteBusyRetry(
      () =>
        this.database
          .prepare(
            `INSERT INTO identity_audit_log (
               action, outcome, principal_id, credential_id,
               source, detail_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.action,
            input.outcome,
            input.principalId || null,
            input.credentialId || null,
            input.source,
            JSON.stringify(input.detail || {}),
            input.createdAt,
          ),
      {
        operation: 'write identity audit event',
        maxAttempts: 8,
        totalBudgetMs: 15_000,
      },
    );
  }
}
