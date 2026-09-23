import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  AssistantProtocolQuarantineError,
  REDACTED_ASSISTANT_CREDENTIAL,
  sanitizeAssistantProtocol,
  type AssistantAction,
  type AssistantActionType,
} from './assistant-protocol.js';
import { containsCredentialSecret } from './memory-extractor.js';
import { tombstoneIdentityFields } from './tombstone-policy.js';

type DatabaseRow = Record<string, unknown>;
type SqlValue = string | number | bigint | Uint8Array | null;

import { ConversationServiceError } from './conversation-types.js';
import type {
  ConversationTenant,
  ConversationServiceErrorCode,
  ChatProfileInput,
  ChatProfile,
  ProjectBinding,
  Conversation,
  MessageAction,
  ConversationMessage,
  ConversationRoundStatus,
  ConversationRoundEventType,
  ConversationRoundAttempt,
  ConversationRound,
  ConversationRoundEvent,
  AcceptedConversationRound,
  ConversationRoundExecutionContext,
  ConversationPage,
  MessagePage,
  ConversationChangeType,
  ConversationChange,
  ConversationChangePage,
  ConversationMemoryPolicy,
  ConversationDeletionReceipt,
  ConversationDoctorReport,
  ConversationAuditInput,
  ConversationImportInput,
  ConversationImportStats,
  ConversationImportReceipt,
  ConversationServiceOptions,
} from './conversation-types.js';

export * from './conversation-types.js';

interface CursorPayload {
  readonly v: 1;
  readonly k: number;
  readonly p: string;
  readonly n: string;
  readonly r:
    | 'conversation-list'
    | 'message-list'
    | 'change-list'
    | 'import-batch';
  readonly f: string;
  readonly c: string | null;
  readonly a: unknown;
  readonly s: unknown;
  readonly e: number;
}

interface ConversationCursorPoint {
  readonly sortAt: string;
  readonly id: string;
}

interface NormalizedImportMessage {
  readonly externalMessageId: string;
  readonly externalRoundId: string;
  readonly role: 'user' | 'assistant';
  readonly displayContent: string;
  readonly occurredAt: string;
  readonly payloadHash: string;
}

interface NormalizedImportConversation {
  readonly externalSessionId: string;
  readonly personaId: string;
  readonly projectId: string | null;
  readonly title: string | null;
  readonly payloadHash: string;
  readonly messages: readonly NormalizedImportMessage[];
}

interface MutableImportCounter {
  created: number;
  matched: number;
  conflicted: number;
  skipped: number;
}

const CURSOR_TTL_MS = 24 * 60 * 60 * 1_000;
const CHANGE_CURSOR_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const CHANGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const ROUND_LEASE_MS = 120 * 1_000;
const ROUND_EVENT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const ALLOWED_CAPABILITIES = new Set([
  'emotion.basic',
  'motion.basic',
]);
const ACTION_CAPABILITY: Readonly<Record<AssistantActionType, string>> = {
  emotion: 'emotion.basic',
  motion: 'motion.basic',
};

function serviceError(code: ConversationServiceErrorCode): never {
  throw new ConversationServiceError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const fields = new Set(allowed);
  return Object.keys(value).every((field) => fields.has(field));
}

function cleanRequired(
  value: unknown,
  maximumLength = 255,
): string {
  if (typeof value !== 'string') serviceError('INVALID_REQUEST');
  const cleaned = value.trim();
  if (
    !cleaned ||
    cleaned.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(cleaned)
  ) {
    serviceError('INVALID_REQUEST');
  }
  return cleaned;
}

function cleanText(
  value: unknown,
  maximumLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length > maximumLength ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    serviceError('INVALID_REQUEST');
  }
  return value;
}

function cleanNullableTitle(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const title = cleanText(value, 500).trim();
  return title || null;
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function integer(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    serviceError('INVALID_REQUEST');
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseStringArray(value: unknown): readonly string[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]')) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => typeof item !== 'string')
    ) {
      return Object.freeze([]);
    }
    return Object.freeze([...parsed]);
  } catch {
    return Object.freeze([]);
  }
}

function conversationFromRow(row: DatabaseRow): Conversation {
  return Object.freeze({
    id: String(row.id),
    personaId: String(row.persona_id),
    projectId: nullableText(row.project_id),
    personaProfileVersion: Number(row.persona_profile_version),
    title: nullableText(row.title),
    status: String(row.status) as Conversation['status'],
    messageCount: Number(row.message_count),
    lastMessageAt: nullableText(row.last_message_at),
    lastMessagePreview: nullableText(row.last_message_preview),
    createdAt: String(row.started_at),
    updatedAt: String(row.updated_at || row.started_at),
    version: Number(row.version),
  });
}

function projectFromRow(row: DatabaseRow): ProjectBinding {
  return Object.freeze({
    projectId: String(row.external_project_id),
    displayName: String(row.display_name),
    status: String(row.status) as ProjectBinding['status'],
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
}

export class ConversationService {
  private readonly now: () => Date | string;
  private readonly cursorTtlMs: number;
  private readonly roundLeaseMs: number;
  private readonly roundEventRetentionMs: number;
  readonly instanceId: string;

  constructor(
    private readonly database: DatabaseSync,
    options: ConversationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.cursorTtlMs = options.cursorTtlMs ?? CURSOR_TTL_MS;
    this.roundLeaseMs = options.roundLeaseMs ?? ROUND_LEASE_MS;
    this.roundEventRetentionMs =
      options.roundEventRetentionMs ?? ROUND_EVENT_RETENTION_MS;
    this.instanceId = cleanRequired(
      options.instanceId ?? `conversation-${randomUUID()}`,
      255,
    );
    if (
      !Number.isSafeInteger(this.cursorTtlMs) ||
      this.cursorTtlMs <= 0 ||
      !Number.isSafeInteger(this.roundLeaseMs) ||
      this.roundLeaseMs <= 0 ||
      !Number.isSafeInteger(this.roundEventRetentionMs) ||
      this.roundEventRetentionMs <= 0
    ) {
      serviceError('INVALID_REQUEST');
    }
    this.ensureCursorKey();
    this.reconcileExpiredRounds();
  }

  putChatProfile(
    tenantInput: ConversationTenant,
    personaIdInput: string,
    input: ChatProfileInput,
  ): ChatProfile {
    const tenant = this.cleanTenant(tenantInput);
    const personaId = cleanRequired(personaIdInput);
    const expectedVersion = integer(input.expectedVersion, 0);
    const displayName = cleanRequired(input.displayName);
    const systemPrompt = cleanText(input.systemPrompt, 20_000);
    const greeting = cleanText(input.greeting, 4_000);
    const language = cleanRequired(input.language, 64);
    if (!Array.isArray(input.capabilityIds)) {
      serviceError('INVALID_REQUEST');
    }
    const capabilityIds = [...new Set(input.capabilityIds)].map((item) =>
      cleanRequired(item, 128),
    );
    if (
      capabilityIds.length !== input.capabilityIds.length ||
      capabilityIds.some((item) => !ALLOWED_CAPABILITIES.has(item))
    ) {
      serviceError('INVALID_REQUEST');
    }
    const timestamp = this.timestamp();
    this.inImmediate(() => {
      this.requirePersona(tenant, personaId);
      const currentVersion = Number(
        this.database
          .prepare(
            `SELECT COALESCE(MAX(profile_version), 0) AS version
             FROM persona_chat_profiles
             WHERE principal_id = ? AND persona_id = ?`,
          )
          .get(tenant.principalId, personaId)?.version ?? 0,
      );
      if (currentVersion !== expectedVersion) {
        serviceError('VERSION_CONFLICT');
      }
      this.database
        .prepare(
          `INSERT INTO persona_chat_profiles (
             id, principal_id, persona_id, profile_version,
             display_name, system_prompt, greeting, language,
             capability_ids_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          tenant.principalId,
          personaId,
          currentVersion + 1,
          displayName,
          systemPrompt,
          greeting,
          language,
          JSON.stringify(capabilityIds),
          timestamp,
          timestamp,
        );
    });
    return this.getChatProfile(tenant, personaId);
  }

  getChatProfile(
    tenantInput: ConversationTenant,
    personaIdInput: string,
    version?: number,
  ): ChatProfile {
    const tenant = this.cleanTenant(tenantInput);
    const personaId = cleanRequired(personaIdInput);
    this.requirePersona(tenant, personaId);
    if (version !== undefined) integer(version, 1);
    const row = this.database
      .prepare(
        `SELECT * FROM persona_chat_profiles
         WHERE principal_id = ? AND persona_id = ?
           AND (? IS NULL OR profile_version = ?)
         ORDER BY profile_version DESC LIMIT 1`,
      )
      .get(
        tenant.principalId,
        personaId,
        version ?? null,
        version ?? null,
      ) as DatabaseRow | undefined;
    if (!row) serviceError('PERSONA_PROFILE_NOT_FOUND');
    const versions = this.database
      .prepare(
        `SELECT profile_version, updated_at
         FROM persona_chat_profiles
         WHERE principal_id = ? AND persona_id = ?
         ORDER BY profile_version ASC`,
      )
      .all(tenant.principalId, personaId) as DatabaseRow[];
    return Object.freeze({
      personaId,
      profileVersion: Number(row.profile_version),
      displayName: String(row.display_name),
      systemPrompt: String(row.system_prompt),
      greeting: String(row.greeting),
      language: String(row.language),
      capabilityIds: parseStringArray(row.capability_ids_json),
      updatedAt: String(row.updated_at),
      availableVersions: Object.freeze(
        versions.map((item) =>
          Object.freeze({
            profileVersion: Number(item.profile_version),
            updatedAt: String(item.updated_at),
          }),
        ),
      ),
    });
  }

  bindProject(
    tenantInput: ConversationTenant,
    projectIdInput: string,
    input: { readonly expectedVersion: number; readonly displayName: string },
  ): ProjectBinding {
    const tenant = this.cleanTenant(tenantInput);
    const projectId = cleanRequired(projectIdInput);
    const expectedVersion = integer(input.expectedVersion, 0);
    const displayName = cleanRequired(input.displayName);
    const timestamp = this.timestamp();
    this.inImmediate(() => {
      this.requirePrincipal(tenant.principalId);
      const row = this.database
        .prepare(
          `SELECT * FROM conversation_project_bindings
           WHERE principal_id = ? AND namespace = ?
             AND external_project_id = ?`,
        )
        .get(
          tenant.principalId,
          tenant.namespace,
          projectId,
        ) as DatabaseRow | undefined;
      const currentVersion = row ? Number(row.version) : 0;
      if (currentVersion !== expectedVersion) {
        serviceError('VERSION_CONFLICT');
      }
      if (!row) {
        this.database
          .prepare(
            `INSERT INTO conversation_project_bindings (
               principal_id, namespace, external_project_id,
               display_name, status, version, created_at,
               updated_at, last_seen_at
             ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
          )
          .run(
            tenant.principalId,
            tenant.namespace,
            projectId,
            displayName,
            timestamp,
            timestamp,
            timestamp,
          );
      } else {
        this.database
          .prepare(
            `UPDATE conversation_project_bindings
             SET display_name = ?, status = 'active', version = version + 1,
                 updated_at = ?, last_seen_at = ?
             WHERE principal_id = ? AND namespace = ?
               AND external_project_id = ?`,
          )
          .run(
            displayName,
            timestamp,
            timestamp,
            tenant.principalId,
            tenant.namespace,
            projectId,
          );
      }
    });
    return this.requireProject(tenant, projectId);
  }

  putProjectBinding(
    tenant: ConversationTenant,
    projectId: string,
    input: { readonly expectedVersion: number; readonly displayName: string },
  ): ProjectBinding {
    return this.bindProject(tenant, projectId, input);
  }

  listProjects(tenantInput: ConversationTenant): readonly ProjectBinding[] {
    const tenant = this.cleanTenant(tenantInput);
    this.requirePrincipal(tenant.principalId);
    const rows = this.database
      .prepare(
        `SELECT * FROM conversation_project_bindings
         WHERE principal_id = ? AND namespace = ? AND status = 'active'
         ORDER BY last_seen_at DESC, external_project_id ASC`,
      )
      .all(tenant.principalId, tenant.namespace) as DatabaseRow[];
    return Object.freeze(rows.map(projectFromRow));
  }

  createConversation(
    tenantInput: ConversationTenant,
    input: {
      readonly idempotencyKey: string;
      readonly personaId: string;
      readonly projectId: string | null;
      readonly title: string | null;
    },
  ): Conversation {
    const tenant = this.cleanTenant(tenantInput);
    const idempotencyKey = cleanRequired(input.idempotencyKey);
    const personaId = cleanRequired(input.personaId);
    const projectId =
      input.projectId === null ? null : cleanRequired(input.projectId);
    const title = cleanNullableTitle(input.title);
    const payloadHash = digest({
      namespace: tenant.namespace,
      personaId,
      projectId,
      title,
    });
    const timestamp = this.timestamp();
    let conversationId = '';
    this.inImmediate(() => {
      const existing = this.database
        .prepare(
          `SELECT * FROM conversation_sessions
           WHERE user_id = ? AND create_idempotency_key = ?`,
        )
        .get(tenant.principalId, idempotencyKey) as
        | DatabaseRow
        | undefined;
      if (existing) {
        if (
          existing.create_payload_hash !== payloadHash ||
          existing.namespace !== tenant.namespace ||
          existing.status === 'deleted'
        ) {
          serviceError('IDEMPOTENCY_CONFLICT');
        }
        conversationId = String(existing.id);
        return;
      }
      this.requirePersona(tenant, personaId);
      const profile = this.database
        .prepare(
          `SELECT profile_version FROM persona_chat_profiles
           WHERE principal_id = ? AND persona_id = ?
           ORDER BY profile_version DESC LIMIT 1`,
        )
        .get(tenant.principalId, personaId);
      if (!profile) serviceError('PERSONA_PROFILE_NOT_FOUND');
      if (projectId !== null) this.requireProject(tenant, projectId);
      conversationId = randomUUID();
      this.database
        .prepare(
          `INSERT INTO conversation_sessions (
             id, user_id, namespace, client_name, external_id,
             started_at, ended_at, metadata_json, persona_id,
             identity_source, identity_status, project_id, title,
             status, version, last_message_at, last_message_preview,
             message_count, persona_profile_version, updated_at,
             create_idempotency_key, create_payload_hash
           ) VALUES (
             ?, ?, ?, 'conversation-api', ?, ?, NULL, '{}', ?,
             'credential', 'complete', ?, ?, 'active', 1,
             NULL, NULL, 0, ?, ?, ?, ?
           )`,
        )
        .run(
          conversationId,
          tenant.principalId,
          tenant.namespace,
          conversationId,
          timestamp,
          personaId,
          projectId,
          title,
          Number(profile.profile_version),
          timestamp,
          idempotencyKey,
          payloadHash,
        );
      const created = conversationFromRow(
        this.requireConversationRow(tenant, conversationId),
      );
      this.insertChange({
        tenant,
        type: 'conversation.upsert',
        conversationId,
        resourceId: conversationId,
        resourceVersion: created.version,
        resource: Object.freeze({ ...created }),
        timestamp,
      });
    });
    return this.getConversation(tenant, conversationId);
  }

  getConversation(
    tenantInput: ConversationTenant,
    conversationIdInput: string,
  ): Conversation {
    const tenant = this.cleanTenant(tenantInput);
    const conversationId = cleanRequired(conversationIdInput);
    return conversationFromRow(
      this.requireConversationRow(tenant, conversationId),
    );
  }

  updateConversation(
    tenantInput: ConversationTenant,
    conversationIdInput: string,
    input: {
      readonly expectedVersion: number;
      readonly title?: string | null;
      readonly status?: 'active' | 'archived';
      readonly personaProfileVersion?: number;
    },
  ): Conversation {
    const tenant = this.cleanTenant(tenantInput);
    const conversationId = cleanRequired(conversationIdInput);
    const expectedVersion = integer(input.expectedVersion, 1);
    const titleProvided = Object.hasOwn(input, 'title');
    const title = titleProvided ? cleanNullableTitle(input.title) : null;
    if (
      input.status !== undefined &&
      input.status !== 'active' &&
      input.status !== 'archived'
    ) {
      serviceError('INVALID_REQUEST');
    }
    if (input.personaProfileVersion !== undefined) {
      integer(input.personaProfileVersion, 1);
    }
    const timestamp = this.timestamp();
    this.inImmediate(() => {
      const current = this.requireConversationRow(tenant, conversationId);
      if (Number(current.version) !== expectedVersion) {
        serviceError('VERSION_CONFLICT');
      }
      if (input.personaProfileVersion !== undefined) {
        const profile = this.database
          .prepare(
            `SELECT 1 FROM persona_chat_profiles
             WHERE principal_id = ? AND persona_id = ?
               AND profile_version = ?`,
          )
          .get(
            tenant.principalId,
            String(current.persona_id),
            input.personaProfileVersion,
          );
        if (!profile) serviceError('PERSONA_PROFILE_NOT_FOUND');
      }
      this.database
        .prepare(
          `UPDATE conversation_sessions
           SET title = CASE WHEN ? = 1 THEN ? ELSE title END,
               status = COALESCE(?, status),
               persona_profile_version = COALESCE(?, persona_profile_version),
               ended_at = CASE
                 WHEN ? = 'archived' THEN ?
                 WHEN ? = 'active' THEN NULL
                 ELSE ended_at
               END,
               updated_at = ?, version = version + 1
           WHERE id = ? AND user_id = ? AND namespace = ?
             AND version = ?`,
        )
        .run(
          titleProvided ? 1 : 0,
          title,
          input.status ?? null,
          input.personaProfileVersion ?? null,
          input.status ?? null,
          timestamp,
          input.status ?? null,
          timestamp,
          conversationId,
          tenant.principalId,
          tenant.namespace,
          expectedVersion,
        );
      const updated = conversationFromRow(
        this.requireConversationRow(tenant, conversationId),
      );
      this.insertChange({
        tenant,
        type: 'conversation.upsert',
        conversationId,
        resourceId: conversationId,
        resourceVersion: updated.version,
        resource: Object.freeze({ ...updated }),
        timestamp,
      });
    });
    return this.getConversation(tenant, conversationId);
  }

  listConversations(
    tenantInput: ConversationTenant,
    options: {
      readonly personaId?: string;
      readonly projectId?: string | null;
      readonly status?: 'active' | 'archived';
      readonly cursor?: string | null;
      readonly limit?: number;
    } = {},
  ): ConversationPage {
    const tenant = this.cleanTenant(tenantInput);
    const limit = options.limit === undefined
      ? 30
      : integer(options.limit, 1, 100);
    const personaId = options.personaId === undefined
      ? null
      : cleanRequired(options.personaId);
    const projectMode = !Object.hasOwn(options, 'projectId')
      ? 'any'
      : options.projectId === null
        ? 'null'
        : 'value';
    const projectId = projectMode === 'value'
      ? cleanRequired(options.projectId)
      : null;
    if (
      options.status !== undefined &&
      options.status !== 'active' &&
      options.status !== 'archived'
    ) {
      serviceError('INVALID_REQUEST');
    }
    const filters = JSON.stringify({
      personaId,
      projectMode,
      projectId,
      status: options.status ?? null,
    });
    return this.inReadTransaction(() => {
    const newest = this.database
      .prepare(
        `SELECT COALESCE(last_message_at, started_at) AS sort_at, id
         FROM conversation_sessions
         WHERE user_id = ? AND namespace = ? AND status != 'deleted'
         ORDER BY sort_at DESC, id DESC LIMIT 1`,
      )
      .get(tenant.principalId, tenant.namespace);
    let snapshot: ConversationCursorPoint = newest
      ? { sortAt: String(newest.sort_at), id: String(newest.id) }
      : { sortAt: this.timestamp(), id: '\uffff' };
    let anchor: ConversationCursorPoint | null = null;
    if (options.cursor) {
      const cursor = this.decodeCursor(options.cursor, {
        tenant,
        route: 'conversation-list',
        filters,
        conversationId: null,
      });
      snapshot = this.cursorPoint(cursor.s);
      anchor = this.cursorPoint(cursor.a);
    }
    const conditions = [
      'user_id = ?',
      'namespace = ?',
      "status != 'deleted'",
      `(COALESCE(last_message_at, started_at) < ? OR
        (COALESCE(last_message_at, started_at) = ? AND id <= ?))`,
    ];
    const parameters: SqlValue[] = [
      tenant.principalId,
      tenant.namespace,
      snapshot.sortAt,
      snapshot.sortAt,
      snapshot.id,
    ];
    if (anchor) {
      conditions.push(
        `(COALESCE(last_message_at, started_at) < ? OR
          (COALESCE(last_message_at, started_at) = ? AND id < ?))`,
      );
      parameters.push(anchor.sortAt, anchor.sortAt, anchor.id);
    }
    if (personaId !== null) {
      conditions.push('persona_id = ?');
      parameters.push(personaId);
    }
    if (projectMode === 'null') conditions.push('project_id IS NULL');
    if (projectMode === 'value') {
      conditions.push('project_id = ?');
      parameters.push(projectId);
    }
    if (options.status !== undefined) {
      conditions.push('status = ?');
      parameters.push(options.status);
    }
    parameters.push(limit + 1);
    const rows = this.database
      .prepare(
        `SELECT *, COALESCE(last_message_at, started_at) AS sort_at
         FROM conversation_sessions
         WHERE ${conditions.join(' AND ')}
         ORDER BY sort_at DESC, id DESC LIMIT ?`,
      )
      .all(...parameters) as DatabaseRow[];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    const nextCursor = hasMore && last
      ? this.encodeCursor({
          tenant,
          route: 'conversation-list',
          filters,
          conversationId: null,
          anchor: {
            sortAt: String(last.sort_at),
            id: String(last.id),
          },
          snapshot,
        })
      : null;
    const changeSequence = this.currentChangeSequence(tenant);
    const syncCursor = this.encodeCursor({
      tenant,
      route: 'change-list',
      filters: '{}',
      conversationId: null,
      anchor: changeSequence,
      snapshot: changeSequence,
      ttlMs: CHANGE_CURSOR_TTL_MS,
    });
    return Object.freeze({
      items: Object.freeze(pageRows.map(conversationFromRow)),
      nextCursor,
      hasMore,
      syncCursor,
    });
    });
  }

  appendMessage(
    tenantInput: ConversationTenant,
    conversationIdInput: string,
    input: {
      readonly clientMessageId: string;
      readonly role: 'user' | 'assistant';
      readonly content: string;
      readonly normalizedContent?: string | null;
    },
  ): ConversationMessage {
    const tenant = this.cleanTenant(tenantInput);
    const conversationId = cleanRequired(conversationIdInput);
    const clientMessageId = cleanRequired(input.clientMessageId);
    if (input.role !== 'user' && input.role !== 'assistant') {
      serviceError('INVALID_REQUEST');
    }
    const rawContent = cleanText(input.content, 1_000_000);
    let normalizedContent = input.normalizedContent === undefined ||
      input.normalizedContent === null
      ? null
      : cleanText(input.normalizedContent, 1_000_000);
    let displayContent = rawContent;
    let actions: readonly AssistantAction[] = Object.freeze([]);
    if (input.role === 'assistant') {
      const sanitized = sanitizeAssistantProtocol(rawContent);
      displayContent = sanitized.displayContent;
      actions = sanitized.actions;
    }
    if (
      containsCredentialSecret({
        content: rawContent,
        value: normalizedContent ?? '',
      })
    ) {
      displayContent = REDACTED_ASSISTANT_CREDENTIAL;
      normalizedContent = REDACTED_ASSISTANT_CREDENTIAL;
    }
    const payloadHash = digest({
      role: input.role,
      content: displayContent,
      normalizedContent,
    });
    const existing = this.findMessageByClientId(
      tenant,
      conversationId,
      clientMessageId,
    );
    if (existing) {
      if (existing.message_payload_hash !== payloadHash) {
        serviceError('IDEMPOTENCY_CONFLICT');
      }
      return this.messageFromRow(existing);
    }
    const preflightConversation = this.requireConversationRow(
      tenant,
      conversationId,
    );
    if (preflightConversation.status === 'archived') {
      serviceError('CONVERSATION_ARCHIVED');
    }
    if (input.role === 'assistant') {
      this.authorizeActions(preflightConversation, actions);
    }
    const timestamp = this.timestamp();
    const messageId = randomUUID();
    this.inImmediate(() => {
      const replay = this.findMessageByClientId(
        tenant,
        conversationId,
        clientMessageId,
      );
      if (replay) {
        if (replay.message_payload_hash !== payloadHash) {
          serviceError('IDEMPOTENCY_CONFLICT');
        }
        return;
      }
      const conversation = this.requireConversationRow(
        tenant,
        conversationId,
      );
      if (conversation.status === 'archived') {
        serviceError('CONVERSATION_ARCHIVED');
      }
      if (
        Number(conversation.persona_profile_version) !==
        Number(preflightConversation.persona_profile_version)
      ) {
        serviceError('VERSION_CONFLICT');
      }
      const sequence = Number(
        this.database
          .prepare(
            `SELECT COALESCE(MAX(message_sequence), 0) + 1 AS sequence
             FROM conversation_turns WHERE session_id = ?`,
          )
          .get(conversationId)?.sequence ?? 1,
      );
      const generationGroupId = input.role === 'assistant'
        ? randomUUID()
        : null;
      this.database
        .prepare(
          `INSERT INTO conversation_turns (
             id, session_id, user_id, namespace, external_id, role,
             content, content_hash, occurred_at, created_at,
             metadata_json, round_id, message_sequence, display_content,
             normalized_content, message_status, client_message_id,
             message_payload_hash, generation_group_id, variant_index,
             is_active_variant, completed_at, message_version
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', NULL, ?, ?, ?,
             'completed', ?, ?, ?, 1, 1, ?, 1
           )`,
        )
        .run(
          messageId,
          conversationId,
          tenant.principalId,
          tenant.namespace,
          clientMessageId,
          input.role,
          displayContent,
          digest(displayContent),
          timestamp,
          timestamp,
          sequence,
          displayContent,
          normalizedContent,
          clientMessageId,
          payloadHash,
          generationGroupId,
          timestamp,
        );
      for (const [index, action] of actions.entries()) {
        this.database
          .prepare(
            `INSERT INTO conversation_message_actions (
               id, message_id, action_index, action_type,
               payload_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            messageId,
            index,
            action.type,
            JSON.stringify(action.payload),
            timestamp,
          );
      }
      if (input.role === 'assistant') {
        const userTurn = this.database
          .prepare(
            `SELECT id
             FROM conversation_turns
             WHERE session_id = ? AND user_id = ? AND namespace = ?
               AND role = 'user' AND message_status = 'completed'
               AND is_active_variant = 1 AND message_sequence = ?
             LIMIT 1`,
          )
          .get(
            conversationId,
            tenant.principalId,
            tenant.namespace,
            sequence - 1,
          ) as DatabaseRow | undefined;
        if (userTurn) {
          const userTurnId = String(userTurn.id);
          this.database
            .prepare(
              `INSERT INTO outbox_events (
                 id, aggregate_type, aggregate_id, event_type,
                 payload_json, available_at, created_at, user_id, namespace
               ) VALUES (?, 'turn', ?, 'turn.completed', ?, ?, ?, ?, ?)
               ON CONFLICT(aggregate_type, aggregate_id, event_type)
               DO NOTHING`,
            )
            .run(
              `turn:${userTurnId}:completed`,
              userTurnId,
              JSON.stringify({
                userTurnId,
                assistantTurnId: messageId,
              }),
              timestamp,
              timestamp,
              tenant.principalId,
              tenant.namespace,
            );
        }
      }
      const createdMessage = this.messageFromRow(
        this.requireMessageRowById(tenant, conversationId, messageId),
      );
      this.insertChange({
        tenant,
        type: 'message.upsert',
        conversationId,
        resourceId: messageId,
        resourceVersion: createdMessage.version,
        resource: Object.freeze({ ...createdMessage }),
        timestamp,
      });
      this.insertConversationUpsert(tenant, conversationId, timestamp);
    });
    const row = this.findMessageByClientId(
      tenant,
      conversationId,
      clientMessageId,
    );
    if (!row) serviceError('CONVERSATION_NOT_FOUND');
    return this.messageFromRow(row);
  }

  listMessages(
    tenantInput: ConversationTenant,
    conversationIdInput: string,
    options: {
      readonly before?: string | null;
      readonly afterSequence?: number;
      readonly limit?: number;
    } = {},
  ): MessagePage {
    const tenant = this.cleanTenant(tenantInput);
    const conversationId = cleanRequired(conversationIdInput);
    const conversation = this.requireConversationRow(tenant, conversationId);
    const limit = options.limit === undefined
      ? 50
      : integer(options.limit, 1, 100);
    if (options.before && options.afterSequence !== undefined) {
      serviceError('INVALID_REQUEST');
    }
    if (options.afterSequence !== undefined) {
      const afterSequence = integer(options.afterSequence, 0);
      const rows = this.database
        .prepare(
          `SELECT * FROM conversation_turns
           WHERE session_id = ? AND user_id = ? AND namespace = ?
             AND message_sequence > ? AND message_status != 'deleted'
             AND is_active_variant = 1
           ORDER BY message_sequence ASC LIMIT ?`,
        )
        .all(
          conversationId,
          tenant.principalId,
          tenant.namespace,
          afterSequence,
          limit + 1,
        ) as DatabaseRow[];
      const hasMore = rows.length > limit;
      return Object.freeze({
        items: Object.freeze(
          rows.slice(0, limit).map((row) => this.messageFromRow(row)),
        ),
        nextCursor: null,
        hasMore,
        conversationVersion: Number(conversation.version),
      });
    }
    const filters = JSON.stringify({ activeVariant: true });
    let snapshot = Number(
      this.database
        .prepare(
          `SELECT COALESCE(MAX(message_sequence), 0) AS sequence
           FROM conversation_turns
           WHERE session_id = ? AND message_status != 'deleted'
             AND is_active_variant = 1`,
        )
        .get(conversationId)?.sequence ?? 0,
    );
    let anchor = snapshot + 1;
    if (options.before) {
      const cursor = this.decodeCursor(options.before, {
        tenant,
        route: 'message-list',
        filters,
        conversationId,
      });
      if (
        typeof cursor.s !== 'number' ||
        typeof cursor.a !== 'number' ||
        !Number.isSafeInteger(cursor.s) ||
        !Number.isSafeInteger(cursor.a) ||
        cursor.s < 0 ||
        cursor.a < 1
      ) {
        serviceError('INVALID_CURSOR');
      }
      snapshot = cursor.s;
      anchor = cursor.a;
    }
    const rows = this.database
      .prepare(
        `SELECT * FROM conversation_turns
         WHERE session_id = ? AND user_id = ? AND namespace = ?
           AND message_sequence <= ? AND message_sequence < ?
           AND message_status != 'deleted' AND is_active_variant = 1
         ORDER BY message_sequence DESC LIMIT ?`,
      )
      .all(
        conversationId,
        tenant.principalId,
        tenant.namespace,
        snapshot,
        anchor,
        limit + 1,
      ) as DatabaseRow[];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const oldest = pageRows.at(-1);
    const nextCursor = hasMore && oldest
      ? this.encodeCursor({
          tenant,
          route: 'message-list',
          filters,
          conversationId,
          anchor: Number(oldest.message_sequence),
          snapshot,
        })
      : null;
    pageRows.reverse();
    return Object.freeze({
      items: Object.freeze(pageRows.map((row) => this.messageFromRow(row))),
      nextCursor,
      hasMore,
      conversationVersion: Number(conversation.version),
    });
  }

  listChanges(
    tenantInput: ConversationTenant,
    options: {
      readonly cursor?: string | null;
      readonly limit?: number;
    } = {},
  ): ConversationChangePage {
    const tenant = this.cleanTenant(tenantInput);
    const limit = options.limit === undefined
      ? 100
      : integer(options.limit, 1, 500);
    return this.inReadTransaction(() => {
      let anchor = 0;
      let snapshot = this.currentChangeSequence(tenant);
      if (options.cursor) {
        const cursor = this.decodeCursor(options.cursor, {
          tenant,
          route: 'change-list',
          filters: '{}',
          conversationId: null,
        });
        if (
          typeof cursor.a !== 'number' ||
          typeof cursor.s !== 'number' ||
          !Number.isSafeInteger(cursor.a) ||
          !Number.isSafeInteger(cursor.s) ||
          cursor.a < 0 ||
          cursor.s < cursor.a
        ) {
          serviceError('INVALID_CURSOR');
        }
        anchor = cursor.a;
        snapshot = cursor.a === cursor.s
          ? this.currentChangeSequence(tenant)
          : cursor.s;
      }
      const rows = this.database
        .prepare(
          `SELECT * FROM conversation_changes
           WHERE user_id = ? AND namespace = ?
             AND sequence > ? AND sequence <= ?
           ORDER BY sequence ASC LIMIT ?`,
        )
        .all(
          tenant.principalId,
          tenant.namespace,
          anchor,
          snapshot,
          limit + 1,
        ) as DatabaseRow[];
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const nextAnchor = pageRows.length > 0
        ? Number(pageRows.at(-1)?.sequence)
        : anchor;
      return Object.freeze({
        items: Object.freeze(
          pageRows.map((row) => this.changeFromRow(row)),
        ),
        nextCursor: this.encodeCursor({
          tenant,
          route: 'change-list',
          filters: '{}',
          conversationId: null,
          anchor: nextAnchor,
          snapshot: hasMore ? snapshot : nextAnchor,
          ttlMs: CHANGE_CURSOR_TTL_MS,
        }),
        hasMore,
        serverTime: this.timestamp(),
      });
    });
  }

  importConversations(
    tenantInput: ConversationTenant,
    input: ConversationImportInput,
  ): ConversationImportReceipt {
    const tenant = this.cleanTenant(tenantInput);
    const normalized = this.normalizeImportInput(input);
    const lane = input.dryRun ? 'dry_run' : 'commit';
    const filters = JSON.stringify({ importId: normalized.importId, lane });
    const payloadHash = digest({
      isLastBatch: normalized.isLastBatch,
      conversations: normalized.conversations,
    });
    let batchIndex = 0;
    let previousPayloadHash: string | null = null;
    if (normalized.batchCursor !== null) {
      const cursor = this.decodeCursor(normalized.batchCursor, {
        tenant,
        route: 'import-batch',
        filters,
        conversationId: null,
      });
      if (
        typeof cursor.a !== 'number' ||
        !Number.isSafeInteger(cursor.a) ||
        cursor.a < 1 ||
        typeof cursor.s !== 'string' ||
        !cursor.s
      ) {
        serviceError('INVALID_CURSOR');
      }
      batchIndex = cursor.a;
      previousPayloadHash = cursor.s;
    }
    let result: ConversationImportReceipt | undefined;
    this.inImmediate(() => {
      const replay = this.database
        .prepare(
          `SELECT * FROM conversation_import_receipts
           WHERE user_id = ? AND namespace = ? AND import_id = ?
             AND lane = ? AND batch_index = ?`,
        )
        .get(
          tenant.principalId,
          tenant.namespace,
          normalized.importId,
          lane,
          batchIndex,
        ) as DatabaseRow | undefined;
      if (replay) {
        if (
          replay.payload_hash !== payloadHash ||
          nullableText(replay.batch_cursor_in) !== normalized.batchCursor
        ) {
          serviceError('IDEMPOTENCY_CONFLICT');
        }
        result = this.importReceiptFromRow(replay, true);
        return;
      }
      let state = this.database
        .prepare(
          `SELECT * FROM conversation_import_states
           WHERE user_id = ? AND namespace = ? AND import_id = ?
             AND lane = ?`,
        )
        .get(
          tenant.principalId,
          tenant.namespace,
          normalized.importId,
          lane,
        ) as DatabaseRow | undefined;
      const timestamp = this.timestamp();
      if (!state) {
        if (batchIndex !== 0 || normalized.batchCursor !== null) {
          serviceError('INVALID_CURSOR');
        }
        this.database
          .prepare(
            `INSERT INTO conversation_import_states (
               user_id, namespace, import_id, lane, next_batch_index,
               previous_payload_hash, completed, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 0, NULL, 0, ?, ?)`,
          )
          .run(
            tenant.principalId,
            tenant.namespace,
            normalized.importId,
            lane,
            timestamp,
            timestamp,
          );
        state = this.database
          .prepare(
            `SELECT * FROM conversation_import_states
             WHERE user_id = ? AND namespace = ? AND import_id = ?
               AND lane = ?`,
          )
          .get(
            tenant.principalId,
            tenant.namespace,
            normalized.importId,
            lane,
          ) as DatabaseRow;
      }
      if (
        Number(state.completed) === 1 ||
        Number(state.next_batch_index) !== batchIndex ||
        nullableText(state.previous_payload_hash) !== previousPayloadHash
      ) {
        serviceError('INVALID_CURSOR');
      }

      const counters = {
        conversations: this.newImportCounter(),
        messages: this.newImportCounter(),
      };
      for (const conversation of normalized.conversations) {
        this.importConversationBatchItem({
          tenant,
          importId: normalized.importId,
          conversation,
          dryRun: input.dryRun,
          counters,
          timestamp,
        });
      }
      const stats = this.freezeImportStats(counters);
      const batchCursorOut = this.encodeCursor({
        tenant,
        route: 'import-batch',
        filters,
        conversationId: null,
        anchor: batchIndex + 1,
        snapshot: payloadHash,
        ttlMs: CHANGE_CURSOR_TTL_MS,
      });
      this.database
        .prepare(
          `INSERT INTO conversation_import_receipts (
             id, user_id, namespace, import_id, lane, batch_index,
             batch_cursor_in, payload_hash, batch_cursor_out,
             is_last_batch, stats_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          tenant.principalId,
          tenant.namespace,
          normalized.importId,
          lane,
          batchIndex,
          normalized.batchCursor,
          payloadHash,
          batchCursorOut,
          normalized.isLastBatch ? 1 : 0,
          JSON.stringify(stats),
          timestamp,
        );
      this.database
        .prepare(
          `UPDATE conversation_import_states
           SET next_batch_index = ?, previous_payload_hash = ?,
               completed = ?, updated_at = ?
           WHERE user_id = ? AND namespace = ? AND import_id = ?
             AND lane = ?`,
        )
        .run(
          batchIndex + 1,
          payloadHash,
          normalized.isLastBatch ? 1 : 0,
          timestamp,
          tenant.principalId,
          tenant.namespace,
          normalized.importId,
          lane,
        );
      result = Object.freeze({
        importId: normalized.importId,
        lane,
        batchIndex,
        batchCursor: batchCursorOut,
        isLastBatch: normalized.isLastBatch,
        replayed: false,
        stats,
      });
    });
    if (!result) serviceError('INVALID_REQUEST');
    return result;
  }

  deleteMessage(
    tenantInput: ConversationTenant,
    messageIdInput: string,
    input: {
      readonly clientRequestId: string;
      readonly reason: string;
      readonly memoryPolicy: ConversationMemoryPolicy;
    },
  ): ConversationDeletionReceipt {
    return this.deleteResource(
      this.cleanTenant(tenantInput),
      'message',
      cleanRequired(messageIdInput),
      input,
    );
  }

  deleteConversation(
    tenantInput: ConversationTenant,
    conversationIdInput: string,
    input: {
      readonly clientRequestId: string;
      readonly reason: string;
      readonly memoryPolicy: ConversationMemoryPolicy;
    },
  ): ConversationDeletionReceipt {
    return this.deleteResource(
      this.cleanTenant(tenantInput),
      'conversation',
      cleanRequired(conversationIdInput),
      input,
    );
  }

  processConversationMaintenanceJobs(limitInput = 25): number {
    const limit = integer(limitInput, 1, 100);
    const timestamp = this.timestamp();
    let processed = 0;
    const jobs = this.database
      .prepare(
        `SELECT * FROM conversation_maintenance_jobs
         WHERE status IN ('pending', 'failed') AND available_at <= ?
           AND attempts < max_attempts
         ORDER BY available_at ASC, id ASC LIMIT ?`,
      )
      .all(timestamp, limit) as DatabaseRow[];
    for (const job of jobs) {
      try {
        this.inImmediate(() => this.processMaintenanceJob(job, timestamp));
        processed += 1;
      } catch {
        this.inImmediate(() => {
          const current = this.database
            .prepare(
              `SELECT attempts, max_attempts
               FROM conversation_maintenance_jobs WHERE id = ?`,
            )
            .get(String(job.id));
          if (!current) return;
          const nextAttempts = Number(current.attempts) + 1;
          const terminal = nextAttempts >= Number(current.max_attempts);
          this.database
            .prepare(
              `UPDATE conversation_maintenance_jobs
               SET status = ?, attempts = ?, last_error_code = ?,
                   lease_until = NULL, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              terminal ? 'dead' : 'failed',
              nextAttempts,
              'MAINTENANCE_JOB_FAILED',
              timestamp,
              String(job.id),
            );
        });
      }
    }
    return processed;
  }

  recordConversationAudit(
    tenantInput: ConversationTenant,
    input: ConversationAuditInput,
  ): void {
    const tenant = this.cleanTenant(tenantInput);
    const duration = (value: number | undefined): number | undefined => {
      if (value === undefined) return undefined;
      if (!Number.isFinite(value) || value < 0) {
        serviceError('INVALID_REQUEST');
      }
      return Math.round(value * 1_000) / 1_000;
    };
    const timestamp = this.timestamp();
    const detail = {
      namespace: tenant.namespace,
      conversationId: cleanRequired(input.conversationId),
      roundId: cleanRequired(input.roundId),
      requestId: cleanRequired(input.requestId),
      ...(input.attemptId
        ? { attemptId: cleanRequired(input.attemptId) }
        : {}),
      ...(input.code ? { code: cleanRequired(input.code, 255) } : {}),
      ...(input.model ? { model: cleanRequired(input.model, 255) } : {}),
      ...(input.durationMs === undefined
        ? {}
        : { durationMs: duration(input.durationMs) }),
      ...(input.recallDurationMs === undefined
        ? {}
        : { recallDurationMs: duration(input.recallDurationMs) }),
      ...(input.providerDurationMs === undefined
        ? {}
        : { providerDurationMs: duration(input.providerDurationMs) }),
      ...(input.firstTokenMs === undefined
        ? {}
        : { firstTokenMs: duration(input.firstTokenMs) }),
    };
    this.database
      .prepare(
        `INSERT INTO audit_log (
           id, action, memory_id, user_id, detail_json, created_at
         )
         SELECT COALESCE(MAX(id), 0) + 1, ?, NULL, ?, ?, ?
         FROM audit_log WHERE user_id = ?`,
      )
      .run(
        `conversation_chat_${input.action}`,
        tenant.principalId,
        JSON.stringify(detail),
        timestamp,
        tenant.principalId,
      );
  }

  runConversationDoctor(
    tenantInput: ConversationTenant,
  ): ConversationDoctorReport {
    const tenant = this.cleanTenant(tenantInput);
    const timestamp = this.timestamp();
    const scalar = (sql: string, ...values: SqlValue[]): number => Number(
      this.database.prepare(sql).get(...values)?.count ?? 0,
    );
    const owner = [tenant.principalId, tenant.namespace] as const;
    const checks = Object.freeze({
      stuckRounds: scalar(
        `SELECT COUNT(*) AS count FROM conversation_rounds
         WHERE user_id = ? AND namespace = ?
           AND status IN ('accepted','understanding','recalling','generating')
           AND updated_at < ?`,
        ...owner,
        this.timestampAfter(timestamp, -this.roundLeaseMs),
      ),
      regenerationMismatches: scalar(
        `SELECT COUNT(*) AS count
         FROM conversation_regeneration_requests g
         LEFT JOIN conversation_round_attempts a ON a.id = g.attempt_id
         WHERE g.user_id = ? AND g.namespace = ?
           AND (a.id IS NULL OR a.round_id != g.round_id
             OR (g.status = 'running' AND a.status != 'running'))`,
        ...owner,
      ),
      orphanMessages: scalar(
        `SELECT COUNT(*) AS count FROM conversation_turns t
         LEFT JOIN conversation_sessions s ON s.id = t.session_id
         WHERE t.user_id = ? AND t.namespace = ? AND s.id IS NULL`,
        ...owner,
      ),
      orphanActions: scalar(
        `SELECT COUNT(*) AS count FROM conversation_message_actions a
         LEFT JOIN conversation_turns t ON t.id = a.message_id
         WHERE t.id IS NULL`,
      ),
      orphanEvidence: scalar(
        `SELECT COUNT(*) AS count FROM memory_evidence e
         LEFT JOIN memory_versions v ON v.id = e.memory_version_id
         WHERE v.id IS NULL`,
      ),
      protocolContamination: scalar(
        `SELECT COUNT(*) AS count FROM conversation_turns
         WHERE user_id = ? AND namespace = ? AND role = 'assistant'
           AND message_status != 'deleted'
           AND (INSTR(content, '<|') > 0 OR INSTR(content, '|>') > 0
             OR INSTR(LOWER(content), '<tool_call') > 0
             OR INSTR(content, '_memoryContext') > 0)`,
        ...owner,
      ),
      extractionZeroCandidateWithoutReason: scalar(
        `SELECT COUNT(*) AS count FROM extraction_runs r
         JOIN conversation_turns t ON t.id = r.turn_id
         WHERE t.user_id = ? AND t.namespace = ? AND r.status = 'completed'
           AND NOT EXISTS (
             SELECT 1 FROM memory_candidates c
             WHERE c.extraction_run_id = r.id
           )
           AND (r.error IS NULL OR TRIM(r.error) = '')`,
        ...owner,
      ),
      pendingMaintenanceJobs: scalar(
        `SELECT COUNT(*) AS count FROM conversation_maintenance_jobs
         WHERE user_id = ? AND namespace = ?
           AND status IN ('pending','running','failed')`,
        ...owner,
      ),
      deadMaintenanceJobs: scalar(
        `SELECT COUNT(*) AS count FROM conversation_maintenance_jobs
         WHERE user_id = ? AND namespace = ? AND status = 'dead'`,
        ...owner,
      ),
      importConflicts: scalar(
        `SELECT COUNT(*) AS count FROM conversation_import_receipts
         WHERE user_id = ? AND namespace = ?
           AND CAST(json_extract(stats_json, '$.conflicted') AS INTEGER) > 0`,
        ...owner,
      ),
      unmatchedImportSessions: scalar(
        `SELECT COUNT(*) AS count FROM conversation_import_sessions m
         LEFT JOIN conversation_sessions s ON s.id = m.conversation_id
         WHERE m.user_id = ? AND m.namespace = ? AND s.id IS NULL`,
        ...owner,
      ),
      changeLag: scalar(
        `SELECT COUNT(*) AS count FROM conversation_sessions s
         WHERE s.user_id = ? AND s.namespace = ? AND s.status != 'deleted'
           AND NOT EXISTS (
             SELECT 1 FROM conversation_changes c
             WHERE c.user_id = s.user_id AND c.namespace = s.namespace
               AND c.conversation_id = s.id
               AND c.event_type = 'conversation.upsert'
               AND c.resource_version = s.version
           )`,
        ...owner,
      ),
    });
    return Object.freeze({
      checkedAt: timestamp,
      healthy: Object.values(checks).every((value) => value === 0),
      checks,
    });
  }

  regenerate(
    tenantInput: ConversationTenant,
    conversationIdInput: string,
    input: {
      readonly clientRequestId: string;
      readonly sourceAssistantMessageId: string;
    },
  ): AcceptedConversationRound {
    const tenant = this.cleanTenant(tenantInput);
    const conversationId = cleanRequired(conversationIdInput);
    const clientRequestId = cleanRequired(input.clientRequestId, 255);
    const sourceAssistantMessageId = cleanRequired(
      input.sourceAssistantMessageId,
    );
    const payloadHash = digest({
      conversationId,
      sourceAssistantMessageId,
    });
    let roundId = '';
    let shouldExecute = false;
    let replayed = false;
    this.inImmediate(() => {
      const existing = this.database
        .prepare(
          `SELECT * FROM conversation_regeneration_requests
           WHERE user_id = ? AND namespace = ? AND client_request_id = ?`,
        )
        .get(
          tenant.principalId,
          tenant.namespace,
          clientRequestId,
        ) as DatabaseRow | undefined;
      if (existing) {
        if (
          existing.conversation_id !== conversationId ||
          existing.source_assistant_message_id !== sourceAssistantMessageId ||
          existing.request_payload_hash !== payloadHash
        ) {
          serviceError('IDEMPOTENCY_CONFLICT');
        }
        roundId = String(existing.round_id);
        replayed = true;
        return;
      }

      const conversation = this.requireConversationRow(
        tenant,
        conversationId,
      );
      if (conversation.status === 'archived') {
        serviceError('CONVERSATION_ARCHIVED');
      }
      this.assertNoOtherRoundInProgress(conversationId, null);
      const source = this.database
        .prepare(
          `SELECT * FROM conversation_turns
           WHERE id = ? AND session_id = ? AND user_id = ? AND namespace = ?
             AND role = 'assistant' AND message_status = 'completed'`,
        )
        .get(
          sourceAssistantMessageId,
          conversationId,
          tenant.principalId,
          tenant.namespace,
        ) as DatabaseRow | undefined;
      if (!source) serviceError('MESSAGE_NOT_FOUND');
      const latest = this.database
        .prepare(
          `SELECT r.id, r.active_assistant_message_id
           FROM conversation_rounds r
           JOIN conversation_turns user_turn ON user_turn.id = r.user_message_id
           WHERE r.conversation_id = ? AND r.user_id = ? AND r.namespace = ?
             AND r.status = 'completed'
             AND r.active_assistant_message_id IS NOT NULL
           ORDER BY user_turn.message_sequence DESC, r.id DESC
           LIMIT 1`,
        )
        .get(
          conversationId,
          tenant.principalId,
          tenant.namespace,
        ) as DatabaseRow | undefined;
      if (
        !latest ||
        latest.active_assistant_message_id !== sourceAssistantMessageId ||
        Number(source.is_active_variant) !== 1
      ) {
        serviceError('REGENERATION_NOT_LATEST');
      }
      roundId = String(latest.id);
      const round = this.requireRoundRow(tenant, conversationId, roundId);
      const generation = Number(round.generation) + 1;
      const attemptNumber = Number(
        this.database
          .prepare(
            `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
             FROM conversation_round_attempts WHERE round_id = ?`,
          )
          .get(roundId)?.attempt_number ?? 1,
      );
      const attemptId = randomUUID();
      const timestamp = this.timestamp();
      this.database
        .prepare(
          `UPDATE conversation_rounds
           SET status = 'accepted', generation = ?, current_attempt_id = NULL,
               failure_code = NULL, failure_message = NULL,
               failure_retryable = NULL, failure_stage = NULL,
               request_id = ?, updated_at = ?
           WHERE id = ? AND status = 'completed'`
        )
        .run(generation, clientRequestId, timestamp, roundId);
      this.insertRoundAttempt({
        id: attemptId,
        roundId,
        attemptNumber,
        attemptType: 'regenerate',
        requestId: clientRequestId,
        generation,
        timestamp,
      });
      this.database
        .prepare(
          `UPDATE conversation_rounds SET current_attempt_id = ?
           WHERE id = ? AND generation = ?`,
        )
        .run(attemptId, roundId, generation);
      this.database
        .prepare(
          `INSERT INTO conversation_regeneration_requests (
             id, user_id, namespace, conversation_id, round_id,
             client_request_id, source_assistant_message_id,
             request_payload_hash, attempt_id, status,
             new_assistant_message_id, failure_code, failure_message,
             created_at, updated_at, completed_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted',
             NULL, NULL, NULL, ?, ?, NULL
           )`,
        )
        .run(
          randomUUID(),
          tenant.principalId,
          tenant.namespace,
          conversationId,
          roundId,
          clientRequestId,
          sourceAssistantMessageId,
          payloadHash,
          attemptId,
          timestamp,
          timestamp,
        );
      const userMessage = this.messageFromRow(
        this.requireMessageRowById(
          tenant,
          conversationId,
          String(round.user_message_id),
        ),
      );
      this.insertRoundEvent({
        roundId,
        attemptId,
        requestId: clientRequestId,
        type: 'turn.accepted',
        data: {
          roundId,
          attemptId,
          requestId: clientRequestId,
          retry: false,
          regenerate: true,
          sourceAssistantMessageId,
          userMessage,
        },
        containsBody: true,
        timestamp,
      });
      shouldExecute = true;
    });
    return Object.freeze({
      round: this.getRound(tenant, conversationId, roundId),
      shouldExecute,
      replayed,
    });
  }

  acceptRound(
    tenantInput: ConversationTenant,
    conversationIdInput: string,
    input: {
      readonly clientMessageId: string;
      readonly text: string;
      readonly attachments: readonly unknown[];
      readonly clientSentAt?: string | null;
      readonly requestId?: string;
    },
  ): AcceptedConversationRound {
    const tenant = this.cleanTenant(tenantInput);
    const conversationId = cleanRequired(conversationIdInput);
    const clientMessageId = cleanRequired(input.clientMessageId, 255);
    if (!Array.isArray(input.attachments)) serviceError('INVALID_REQUEST');
    if (input.attachments.length > 0) serviceError('VL_SERVICE_DISABLED');
    const rawText = cleanText(input.text, 1_000_000);
    if (!rawText.normalize('NFKC').trim()) serviceError('INVALID_REQUEST');
    const clientSentAt = input.clientSentAt === undefined ||
      input.clientSentAt === null
      ? null
      : this.isoTimestamp(input.clientSentAt);
    const requestId = input.requestId === undefined
      ? randomUUID()
      : cleanRequired(input.requestId, 255);
    const credentialRedacted = containsCredentialSecret({ content: rawText });
    const persistedText = credentialRedacted
      ? REDACTED_ASSISTANT_CREDENTIAL
      : rawText;
    const payloadHash = digest({
      text: rawText,
      attachments: [],
      clientSentAt,
    });
    let roundId = '';
    let shouldExecute = false;
    let replayed = false;
    this.inImmediate(() => {
      const conversation = this.requireConversationRow(tenant, conversationId);
      if (conversation.status === 'archived') {
        serviceError('CONVERSATION_ARCHIVED');
      }
      const existing = this.database
        .prepare(
          `SELECT * FROM conversation_rounds
           WHERE conversation_id = ? AND user_id = ? AND namespace = ?
             AND client_message_id = ?`,
        )
        .get(
          conversationId,
          tenant.principalId,
          tenant.namespace,
          clientMessageId,
        ) as DatabaseRow | undefined;
      if (existing) {
        if (String(existing.request_payload_hash) !== payloadHash) {
          serviceError('IDEMPOTENCY_CONFLICT');
        }
        roundId = String(existing.id);
        replayed = true;
        if (existing.status !== 'interrupted') return;
        this.assertNoOtherRoundInProgress(conversationId, roundId);
        const timestamp = this.timestamp();
        const generation = Number(existing.generation) + 1;
        const attemptNumber = Number(
          this.database
            .prepare(
              `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS number
               FROM conversation_round_attempts WHERE round_id = ?`,
            )
            .get(roundId)?.number ?? 1,
        );
        const attemptId = randomUUID();
        this.database
          .prepare(
            `UPDATE conversation_rounds
             SET status = 'accepted', generation = ?,
                 current_attempt_id = NULL, failure_code = NULL,
                 failure_message = NULL, failure_retryable = NULL,
                 failure_stage = NULL, request_id = ?, updated_at = ?,
                 completed_at = NULL
             WHERE id = ? AND status = 'interrupted'`,
          )
          .run(generation, requestId, timestamp, roundId);
        this.insertRoundAttempt({
          id: attemptId,
          roundId,
          attemptNumber,
          attemptType: 'retry',
          requestId,
          generation,
          timestamp,
        });
        this.database
          .prepare(
            `UPDATE conversation_rounds SET current_attempt_id = ?
             WHERE id = ? AND generation = ?`,
          )
          .run(attemptId, roundId, generation);
        const userRow = this.requireMessageRowById(
          tenant,
          conversationId,
          String(existing.user_message_id),
        );
        this.insertRoundEvent({
          roundId,
          attemptId,
          requestId,
          type: 'turn.accepted',
          data: {
            roundId,
            attemptId,
            requestId,
            retry: true,
            userMessage: this.messageFromRow(userRow),
          },
          containsBody: true,
          timestamp,
        });
        shouldExecute = true;
        return;
      }

      this.assertNoOtherRoundInProgress(conversationId, null);
      if (
        this.findMessageByClientId(
          tenant,
          conversationId,
          clientMessageId,
        )
      ) {
        serviceError('IDEMPOTENCY_CONFLICT');
      }
      const profileVersion = Number(conversation.persona_profile_version);
      if (!Number.isSafeInteger(profileVersion) || profileVersion < 1) {
        serviceError('PERSONA_PROFILE_NOT_FOUND');
      }
      const profile = this.database
        .prepare(
          `SELECT 1 FROM persona_chat_profiles
           WHERE principal_id = ? AND persona_id = ?
             AND profile_version = ?`,
        )
        .get(
          tenant.principalId,
          String(conversation.persona_id),
          profileVersion,
        );
      if (!profile) serviceError('PERSONA_PROFILE_NOT_FOUND');
      const timestamp = this.timestamp();
      roundId = randomUUID();
      const attemptId = randomUUID();
      const messageId = randomUUID();
      const sequence = this.nextMessageSequence(conversationId);
      this.database
        .prepare(
          `INSERT INTO conversation_turns (
             id, session_id, user_id, namespace, external_id, role,
             content, content_hash, occurred_at, created_at,
             metadata_json, round_id, message_sequence, display_content,
             normalized_content, message_status, client_message_id,
             message_payload_hash, generation_group_id, variant_index,
             is_active_variant, completed_at, message_version
           ) VALUES (
             ?, ?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?,
             'completed', ?, ?, NULL, 1, 1, ?, 1
           )`,
        )
        .run(
          messageId,
          conversationId,
          tenant.principalId,
          tenant.namespace,
          `user:${roundId}`,
          persistedText,
          digest(persistedText),
          clientSentAt ?? timestamp,
          timestamp,
          JSON.stringify({
            source: 'conversation-api',
            clientSentAt,
            credentialRedacted,
            skipAutoExtraction: false,
          }),
          roundId,
          sequence,
          persistedText,
          persistedText.normalize('NFKC'),
          clientMessageId,
          payloadHash,
          timestamp,
        );
      this.database
        .prepare(
          `INSERT INTO conversation_rounds (
             id, conversation_id, user_id, namespace, client_message_id,
             request_payload_hash, user_message_id, status,
             persona_profile_version_used, active_assistant_message_id,
             current_attempt_id, generation, request_id, created_at,
             updated_at, completed_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, NULL, NULL, 1,
             ?, ?, ?, NULL
           )`,
        )
        .run(
          roundId,
          conversationId,
          tenant.principalId,
          tenant.namespace,
          clientMessageId,
          payloadHash,
          messageId,
          profileVersion,
          requestId,
          timestamp,
          timestamp,
        );
      this.insertRoundAttempt({
        id: attemptId,
        roundId,
        attemptNumber: 1,
        attemptType: 'initial',
        requestId,
        generation: 1,
        timestamp,
      });
      this.database
        .prepare(
          `UPDATE conversation_rounds SET current_attempt_id = ?
           WHERE id = ? AND generation = 1`,
        )
        .run(attemptId, roundId);
      const userRow = this.requireMessageRowById(
        tenant,
        conversationId,
        messageId,
      );
      const userMessage = this.messageFromRow(userRow);
      this.insertRoundEvent({
        roundId,
        attemptId,
        requestId,
        type: 'turn.accepted',
        data: {
          roundId,
          attemptId,
          requestId,
          retry: false,
          userMessage,
        },
        containsBody: true,
        timestamp,
      });
      this.insertChange({
        tenant,
        type: 'message.upsert',
        conversationId,
        resourceId: messageId,
        resourceVersion: userMessage.version,
        resource: Object.freeze({ ...userMessage }),
        timestamp,
      });
      this.insertConversationUpsert(tenant, conversationId, timestamp);
      shouldExecute = true;
    });
    return Object.freeze({
      round: this.getRound(tenant, conversationId, roundId),
      shouldExecute,
      replayed,
    });
  }

  getRound(
    tenantInput: ConversationTenant,
    conversationIdInput: string,
    roundIdInput: string,
  ): ConversationRound {
    const tenant = this.cleanTenant(tenantInput);
    const conversationId = cleanRequired(conversationIdInput);
    const roundId = cleanRequired(roundIdInput);
    return this.roundFromRow(
      tenant,
      this.requireRoundRow(tenant, conversationId, roundId),
    );
  }

  listRoundEvents(
    tenantInput: ConversationTenant,
    conversationIdInput: string,
    roundIdInput: string,
    options: {
      readonly afterEventId?: string | null;
      readonly limit?: number;
    } = {},
  ): readonly ConversationRoundEvent[] {
    const tenant = this.cleanTenant(tenantInput);
    const conversationId = cleanRequired(conversationIdInput);
    const roundId = cleanRequired(roundIdInput);
    this.requireRoundRow(tenant, conversationId, roundId);
    const limit = options.limit === undefined
      ? 256
      : integer(options.limit, 1, 1_000);
    let afterSequence = 0;
    if (options.afterEventId) {
      const match = options.afterEventId.match(/^(.+):(\d+)$/u);
      if (!match || match[1] !== roundId) {
        serviceError('INVALID_EVENT_CURSOR');
      }
      afterSequence = Number(match[2]);
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 1) {
        serviceError('INVALID_EVENT_CURSOR');
      }
      const cursorEvent = this.database
        .prepare(
          `SELECT sequence FROM conversation_round_events
           WHERE round_id = ? AND sequence = ? AND event_id = ?`,
        )
        .get(roundId, afterSequence, options.afterEventId);
      if (!cursorEvent) {
        const bounds = this.database
          .prepare(
            `SELECT MIN(sequence) AS minimum, MAX(sequence) AS maximum
             FROM conversation_round_events WHERE round_id = ?`,
          )
          .get(roundId);
        const minimum = Number(bounds?.minimum ?? 0);
        const maximum = Number(bounds?.maximum ?? 0);
        if (minimum > 0 && afterSequence < minimum) {
          serviceError('EVENT_HISTORY_EXPIRED');
        }
        if (afterSequence > maximum || maximum === 0) {
          serviceError('INVALID_EVENT_CURSOR');
        }
        serviceError('EVENT_HISTORY_EXPIRED');
      }
    }
    const rows = this.database
      .prepare(
        `SELECT * FROM conversation_round_events
         WHERE round_id = ? AND sequence > ?
         ORDER BY sequence ASC LIMIT ?`,
      )
      .all(roundId, afterSequence, limit) as DatabaseRow[];
    return Object.freeze(rows.map((row) => this.roundEventFromRow(row)));
  }

  beginRoundExecution(
    tenantInput: ConversationTenant,
    conversationIdInput: string,
    roundIdInput: string,
  ): ConversationRoundExecutionContext {
    const tenant = this.cleanTenant(tenantInput);
    const conversationId = cleanRequired(conversationIdInput);
    const roundId = cleanRequired(roundIdInput);
    this.inImmediate(() => {
      const round = this.requireRoundRow(tenant, conversationId, roundId);
      if (round.status !== 'accepted') serviceError('ROUND_IN_PROGRESS');
      const attempt = this.requireCurrentAttempt(round);
      if (
        attempt.status !== 'accepted' ||
        attempt.lease_owner !== this.instanceId ||
        Number(attempt.generation) !== Number(round.generation)
      ) {
        serviceError('ROUND_IN_PROGRESS');
      }
      const timestamp = this.timestamp();
      const leaseExpiresAt = this.timestampAfter(timestamp, this.roundLeaseMs);
      this.database
        .prepare(
          `UPDATE conversation_round_attempts
           SET status = 'running', heartbeat_at = ?, lease_expires_at = ?,
               updated_at = ?
           WHERE id = ? AND status = 'accepted' AND lease_owner = ?`,
        )
        .run(
          timestamp,
          leaseExpiresAt,
          timestamp,
          String(attempt.id),
          this.instanceId,
        );
      this.database
        .prepare(
          `UPDATE conversation_rounds
           SET status = 'understanding', updated_at = ?
           WHERE id = ? AND generation = ? AND status = 'accepted'`,
        )
        .run(timestamp, roundId, Number(round.generation));
      if (attempt.attempt_type === 'regenerate') {
        this.database
          .prepare(
            `UPDATE conversation_regeneration_requests
             SET status = 'running', updated_at = ?
             WHERE attempt_id = ? AND status = 'accepted'`,
          )
          .run(timestamp, String(attempt.id));
      }
      this.insertRoundEvent({
        roundId,
        attemptId: String(attempt.id),
        requestId: String(attempt.request_id),
        type: 'turn.stage',
        data: {
          roundId,
          attemptId: String(attempt.id),
          requestId: String(attempt.request_id),
          stage: 'understanding',
        },
        containsBody: false,
        timestamp,
      });
    });
    return this.roundExecutionContext(tenant, conversationId, roundId);
  }

  advanceRoundStage(
    tenantInput: ConversationTenant,
    conversationIdInput: string,
    roundIdInput: string,
    stage: 'recalling' | 'generating',
  ): boolean {
    const tenant = this.cleanTenant(tenantInput);
    const conversationId = cleanRequired(conversationIdInput);
    const roundId = cleanRequired(roundIdInput);
    let advanced = false;
    this.inImmediate(() => {
      const round = this.requireRoundRow(tenant, conversationId, roundId);
      const attempt = this.requireCurrentAttempt(round);
      if (
        !['understanding', 'recalling', 'generating'].includes(
          String(round.status),
        ) ||
        attempt.status !== 'running' ||
        attempt.lease_owner !== this.instanceId ||
        Number(attempt.generation) !== Number(round.generation)
      ) {
        return;
      }
      const timestamp = this.timestamp();
      this.database
        .prepare(
          `UPDATE conversation_round_attempts
           SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND status = 'running' AND lease_owner = ?`,
        )
        .run(
          timestamp,
          this.timestampAfter(timestamp, this.roundLeaseMs),
          timestamp,
          String(attempt.id),
          this.instanceId,
        );
      this.database
        .prepare(
          `UPDATE conversation_rounds SET status = ?, updated_at = ?
           WHERE id = ? AND generation = ?`,
        )
        .run(stage, timestamp, roundId, Number(round.generation));
      this.insertRoundEvent({
        roundId,
        attemptId: String(attempt.id),
        requestId: String(attempt.request_id),
        type: 'turn.stage',
        data: {
          roundId,
          attemptId: String(attempt.id),
          requestId: String(attempt.request_id),
          stage,
        },
        containsBody: false,
        timestamp,
      });
      advanced = true;
    });
    return advanced;
  }

  heartbeatRound(
    tenantInput: ConversationTenant,
    conversationIdInput: string,
    roundIdInput: string,
  ): boolean {
    const tenant = this.cleanTenant(tenantInput);
    const conversationId = cleanRequired(conversationIdInput);
    const roundId = cleanRequired(roundIdInput);
    const timestamp = this.timestamp();
    const result = this.database
      .prepare(
        `UPDATE conversation_round_attempts
         SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = (
           SELECT current_attempt_id FROM conversation_rounds
           WHERE id = ? AND conversation_id = ? AND user_id = ?
             AND namespace = ?
             AND status IN (
               'accepted', 'understanding', 'recalling', 'generating'
             )
         )
           AND status IN ('accepted', 'running')
           AND lease_owner = ?`,
      )
      .run(
        timestamp,
        this.timestampAfter(timestamp, this.roundLeaseMs),
        timestamp,
        roundId,
        conversationId,
        tenant.principalId,
        tenant.namespace,
        this.instanceId,
      );
    return Number(result.changes) === 1;
  }

  appendRoundDelta(
    tenantInput: ConversationTenant,
    conversationIdInput: string,
    roundIdInput: string,
    displayDeltaInput: string,
  ): boolean {
    const tenant = this.cleanTenant(tenantInput);
    const conversationId = cleanRequired(conversationIdInput);
    const roundId = cleanRequired(roundIdInput);
    const displayDelta = cleanText(displayDeltaInput, 1_000_000);
    if (!displayDelta) return false;
    const sanitized = sanitizeAssistantProtocol(displayDelta);
    if (
      sanitized.actions.length > 0 ||
      sanitized.displayContent !== displayDelta
    ) {
      serviceError('ASSISTANT_PROTOCOL_INVALID');
    }
    let appended = false;
    this.inImmediate(() => {
      const round = this.requireRoundRow(tenant, conversationId, roundId);
      const attempt = this.requireCurrentAttempt(round);
      if (
        round.status !== 'generating' ||
        attempt.status !== 'running' ||
        attempt.lease_owner !== this.instanceId ||
        Number(attempt.generation) !== Number(round.generation)
      ) {
        return;
      }
      const timestamp = this.timestamp();
      this.insertRoundEvent({
        roundId,
        attemptId: String(attempt.id),
        requestId: String(attempt.request_id),
        type: 'assistant.delta',
        data: {
          roundId,
          attemptId: String(attempt.id),
          requestId: String(attempt.request_id),
          delta: displayDelta,
        },
        containsBody: true,
        timestamp,
      });
      appended = true;
    });
    return appended;
  }

  completeRound(
    tenantInput: ConversationTenant,
    conversationIdInput: string,
    roundIdInput: string,
    rawAssistantContentInput: string,
  ): ConversationRound | null {
    const tenant = this.cleanTenant(tenantInput);
    const conversationId = cleanRequired(conversationIdInput);
    const roundId = cleanRequired(roundIdInput);
    const rawAssistantContent = cleanText(
      rawAssistantContentInput,
      1_000_000,
    );
    const sanitized = sanitizeAssistantProtocol(rawAssistantContent);
    let displayContent = sanitized.displayContent;
    if (containsCredentialSecret({ content: rawAssistantContent })) {
      displayContent = REDACTED_ASSISTANT_CREDENTIAL;
    }
    if (!displayContent && sanitized.actions.length === 0) {
      serviceError('ASSISTANT_PROTOCOL_INVALID');
    }
    let completed = false;
    this.inImmediate(() => {
      const round = this.requireRoundRow(tenant, conversationId, roundId);
      const attempt = this.requireCurrentAttempt(round);
      if (
        !['understanding', 'recalling', 'generating'].includes(
          String(round.status),
        ) ||
        attempt.status !== 'running' ||
        attempt.lease_owner !== this.instanceId ||
        Number(attempt.generation) !== Number(round.generation)
      ) {
        return;
      }
      const conversation = this.requireConversationRow(tenant, conversationId);
      this.authorizeActionsForProfile(
        tenant.principalId,
        String(conversation.persona_id),
        Number(round.persona_profile_version_used),
        sanitized.actions,
      );
      const isRegenerate = attempt.attempt_type === 'regenerate';
      const regeneration = isRegenerate
        ? this.database
            .prepare(
              `SELECT * FROM conversation_regeneration_requests
               WHERE attempt_id = ? AND round_id = ?
                 AND status IN ('accepted', 'running')`,
            )
            .get(String(attempt.id), roundId) as DatabaseRow | undefined
        : undefined;
      if (isRegenerate && !regeneration) {
        serviceError('ROUND_NOT_FOUND');
      }
      const timestamp = this.timestamp();
      const emittedDisplayContent = (
        this.database
          .prepare(
            `SELECT data_json FROM conversation_round_events
             WHERE round_id = ? AND attempt_id = ?
               AND event_type = 'assistant.delta'
             ORDER BY sequence ASC`,
          )
          .all(roundId, String(attempt.id)) as DatabaseRow[]
      ).map((event) => {
        let data: unknown;
        try {
          data = JSON.parse(String(event.data_json));
        } catch {
          serviceError('ASSISTANT_PROTOCOL_INVALID');
        }
        if (!isRecord(data) || typeof data.delta !== 'string') {
          serviceError('ASSISTANT_PROTOCOL_INVALID');
        }
        return data.delta;
      }).join('');
      if (!displayContent.startsWith(emittedDisplayContent)) {
        serviceError('ASSISTANT_PROTOCOL_INVALID');
      }
      const remainingDisplayContent = displayContent.slice(
        emittedDisplayContent.length,
      );
      const messageId = randomUUID();
      const sequence = this.nextMessageSequence(conversationId);
      let generationGroupId = roundId;
      let variantIndex = 1;
      if (regeneration) {
        const source = this.requireMessageRowById(
          tenant,
          conversationId,
          String(regeneration.source_assistant_message_id),
        );
        generationGroupId = String(source.generation_group_id || roundId);
        variantIndex = Number(
          this.database
            .prepare(
              `SELECT COALESCE(MAX(variant_index), 0) + 1 AS variant_index
               FROM conversation_turns
               WHERE session_id = ? AND generation_group_id = ?
                 AND role = 'assistant'`,
            )
            .get(conversationId, generationGroupId)?.variant_index ?? 1,
        );
        const deactivated = this.database
          .prepare(
            `UPDATE conversation_turns
             SET is_active_variant = 0, message_version = message_version + 1
             WHERE id = ? AND session_id = ? AND is_active_variant = 1
               AND message_status = 'completed'`,
          )
          .run(
            String(regeneration.source_assistant_message_id),
            conversationId,
          );
        if (Number(deactivated.changes) !== 1) {
          serviceError('REGENERATION_NOT_LATEST');
        }
      }
      this.database
        .prepare(
          `INSERT INTO conversation_turns (
             id, session_id, user_id, namespace, external_id, role,
             content, content_hash, occurred_at, created_at,
             metadata_json, round_id, message_sequence, display_content,
             normalized_content, message_status, client_message_id,
             message_payload_hash, generation_group_id, variant_index,
             is_active_variant, completed_at, message_version
           ) VALUES (
             ?, ?, ?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, NULL,
             'completed', ?, ?, ?, ?, 1, ?, 1
           )`,
        )
        .run(
          messageId,
          conversationId,
          tenant.principalId,
          tenant.namespace,
          `assistant:${roundId}:${String(attempt.id)}`,
          displayContent,
          digest(displayContent),
          timestamp,
          timestamp,
          JSON.stringify({
            source: 'conversation-api',
            roundId,
            attemptId: String(attempt.id),
            respondsTo: String(round.user_message_id),
            regenerate: isRegenerate,
          }),
          roundId,
          sequence,
          displayContent,
          `assistant:${String(attempt.id)}`,
          digest({ role: 'assistant', content: displayContent }),
          generationGroupId,
          variantIndex,
          timestamp,
        );
      for (const [index, action] of sanitized.actions.entries()) {
        this.database
          .prepare(
            `INSERT INTO conversation_message_actions (
               id, message_id, action_index, action_type,
               payload_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            messageId,
            index,
            action.type,
            JSON.stringify(action.payload),
            timestamp,
          );
      }
      if (!isRegenerate) {
        const outboxId = `turn:${String(round.user_message_id)}:completed`;
        this.database
          .prepare(
            `INSERT INTO outbox_events (
               id, aggregate_type, aggregate_id, event_type,
               payload_json, available_at, created_at, user_id, namespace
             ) VALUES (?, 'turn', ?, 'turn.completed', ?, ?, ?, ?, ?)
             ON CONFLICT(aggregate_type, aggregate_id, event_type) DO NOTHING`,
          )
          .run(
            outboxId,
            String(round.user_message_id),
            JSON.stringify({
              userTurnId: String(round.user_message_id),
              assistantTurnId: messageId,
            }),
            timestamp,
            timestamp,
            tenant.principalId,
            tenant.namespace,
          );
      }
      this.database
        .prepare(
          `UPDATE conversation_round_attempts
           SET status = 'completed', lease_owner = NULL,
               lease_expires_at = NULL, heartbeat_at = ?, updated_at = ?,
               ended_at = ?
           WHERE id = ? AND status = 'running' AND lease_owner = ?
             AND generation = ?`,
        )
        .run(
          timestamp,
          timestamp,
          timestamp,
          String(attempt.id),
          this.instanceId,
          Number(round.generation),
        );
      this.database
        .prepare(
          `UPDATE conversation_rounds
           SET status = 'completed', active_assistant_message_id = ?,
               failure_code = NULL, failure_message = NULL,
               failure_retryable = NULL, failure_stage = NULL,
               updated_at = ?, completed_at = ?
           WHERE id = ? AND generation = ?
             AND current_attempt_id = ?`,
        )
        .run(
          messageId,
          timestamp,
          timestamp,
          roundId,
          Number(round.generation),
          String(attempt.id),
        );
      if (regeneration) {
        this.database
          .prepare(
            `UPDATE conversation_regeneration_requests
             SET status = 'completed', new_assistant_message_id = ?,
                 failure_code = NULL, failure_message = NULL,
                 updated_at = ?, completed_at = ?
             WHERE attempt_id = ? AND status IN ('accepted', 'running')`,
          )
          .run(
            messageId,
            timestamp,
            timestamp,
            String(attempt.id),
          );
      }
      if (remainingDisplayContent) {
        this.insertRoundEvent({
          roundId,
          attemptId: String(attempt.id),
          requestId: String(attempt.request_id),
          type: 'assistant.delta',
          data: {
            roundId,
            attemptId: String(attempt.id),
            requestId: String(attempt.request_id),
            delta: remainingDisplayContent,
          },
          containsBody: true,
          timestamp,
        });
      }
      const assistantRow = this.requireMessageRowById(
        tenant,
        conversationId,
        messageId,
      );
      const assistantMessage = this.messageFromRow(assistantRow);
      this.insertChange({
        tenant,
        type: 'message.upsert',
        conversationId,
        resourceId: messageId,
        resourceVersion: assistantMessage.version,
        resource: Object.freeze({ ...assistantMessage }),
        timestamp,
      });
      if (regeneration) {
        this.insertChange({
          tenant,
          type: 'message.active_variant',
          conversationId,
          resourceId: messageId,
          resourceVersion: assistantMessage.version,
          resource: Object.freeze({
            conversationId,
            generationGroupId,
            activeMessageId: messageId,
            previousActiveMessageId: String(
              regeneration.source_assistant_message_id,
            ),
          }),
          timestamp,
        });
      }
      for (const action of assistantMessage.actions) {
        this.insertRoundEvent({
          roundId,
          attemptId: String(attempt.id),
          requestId: String(attempt.request_id),
          type: 'assistant.action',
          data: {
            roundId,
            attemptId: String(attempt.id),
            requestId: String(attempt.request_id),
            action,
          },
          containsBody: true,
          timestamp,
        });
      }
      if (regeneration) {
        this.database
          .prepare(
            `UPDATE conversation_sessions
             SET message_count = (
                   SELECT COUNT(*) FROM conversation_turns t
                   WHERE t.session_id = conversation_sessions.id
                     AND t.message_status != 'deleted'
                     AND t.is_active_variant = 1
                 ),
                 last_message_at = (
                   SELECT t.occurred_at FROM conversation_turns t
                   WHERE t.session_id = conversation_sessions.id
                     AND t.message_status != 'deleted'
                     AND t.is_active_variant = 1
                   ORDER BY t.message_sequence DESC LIMIT 1
                 ),
                 last_message_preview = (
                   SELECT SUBSTR(t.display_content, 1, 160)
                   FROM conversation_turns t
                   WHERE t.session_id = conversation_sessions.id
                     AND t.message_status != 'deleted'
                     AND t.is_active_variant = 1
                   ORDER BY t.message_sequence DESC LIMIT 1
                 )
             WHERE id = ?`,
          )
          .run(conversationId);
      }
      this.insertConversationUpsert(tenant, conversationId, timestamp);
      const conversationVersion = Number(
        this.database
          .prepare(
            'SELECT version FROM conversation_sessions WHERE id = ?',
          )
          .get(conversationId)?.version ?? 0,
      );
      this.insertRoundEvent({
        roundId,
        attemptId: String(attempt.id),
        requestId: String(attempt.request_id),
        type: 'turn.completed',
        data: {
          roundId,
          attemptId: String(attempt.id),
          requestId: String(attempt.request_id),
          assistantMessage,
          conversationVersion,
          memory: isRegenerate
            ? {
                queued: false,
                reason: 'assistant_inference_not_auto_committed',
              }
            : { queued: true },
        },
        containsBody: true,
        timestamp,
      });
      completed = true;
    });
    return completed
      ? this.getRound(tenant, conversationId, roundId)
      : null;
  }

  failRound(
    tenantInput: ConversationTenant,
    conversationIdInput: string,
    roundIdInput: string,
    input: {
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly stage: string;
      readonly interrupted?: boolean;
    },
  ): boolean {
    const tenant = this.cleanTenant(tenantInput);
    const conversationId = cleanRequired(conversationIdInput);
    const roundId = cleanRequired(roundIdInput);
    const code = cleanRequired(input.code, 128);
    const message = cleanRequired(input.message, 500);
    const stage = cleanRequired(input.stage, 64);
    let failed = false;
    this.inImmediate(() => {
      const round = this.requireRoundRow(tenant, conversationId, roundId);
      const attempt = this.requireCurrentAttempt(round);
      if (
        !['accepted', 'understanding', 'recalling', 'generating'].includes(
          String(round.status),
        ) ||
        !['accepted', 'running'].includes(String(attempt.status)) ||
        attempt.lease_owner !== this.instanceId ||
        Number(attempt.generation) !== Number(round.generation)
      ) {
        return;
      }
      const timestamp = this.timestamp();
      const terminalStatus = input.interrupted ? 'interrupted' : 'failed';
      this.database
        .prepare(
          `UPDATE conversation_round_attempts
           SET status = ?, failure_code = ?, failure_message = ?,
               failure_retryable = ?, failure_stage = ?, lease_owner = NULL,
               lease_expires_at = NULL, heartbeat_at = ?, updated_at = ?,
               ended_at = ?
           WHERE id = ? AND generation = ?`,
        )
        .run(
          terminalStatus,
          code,
          message,
          input.retryable ? 1 : 0,
          stage,
          timestamp,
          timestamp,
          timestamp,
          String(attempt.id),
          Number(round.generation),
        );
      const isRegenerate = attempt.attempt_type === 'regenerate';
      if (isRegenerate) {
        this.database
          .prepare(
            `UPDATE conversation_regeneration_requests
             SET status = ?, failure_code = ?, failure_message = ?,
                 updated_at = ?, completed_at = ?
             WHERE attempt_id = ? AND status IN ('accepted', 'running')`,
          )
          .run(
            terminalStatus,
            code,
            message,
            timestamp,
            timestamp,
            String(attempt.id),
          );
        this.database
          .prepare(
            `UPDATE conversation_rounds
             SET status = 'completed', failure_code = NULL,
                 failure_message = NULL, failure_retryable = NULL,
                 failure_stage = NULL, updated_at = ?
             WHERE id = ? AND generation = ? AND current_attempt_id = ?`,
          )
          .run(
            timestamp,
            roundId,
            Number(round.generation),
            String(attempt.id),
          );
      } else {
        this.database
          .prepare(
            `UPDATE conversation_rounds
             SET status = ?, failure_code = ?, failure_message = ?,
                 failure_retryable = ?, failure_stage = ?, updated_at = ?,
                 completed_at = ?
             WHERE id = ? AND generation = ? AND current_attempt_id = ?`,
          )
          .run(
            terminalStatus,
            code,
            message,
            input.retryable ? 1 : 0,
            stage,
            timestamp,
            timestamp,
            roundId,
            Number(round.generation),
            String(attempt.id),
          );
      }
      const type: ConversationRoundEventType = input.interrupted
        ? 'turn.interrupted'
        : 'turn.failed';
      this.insertRoundEvent({
        roundId,
        attemptId: String(attempt.id),
        requestId: String(attempt.request_id),
        type,
        data: {
          roundId,
          attemptId: String(attempt.id),
          requestId: String(attempt.request_id),
          code,
          message,
          retryable: input.retryable,
          stage,
          regenerate: isRegenerate,
        },
        containsBody: false,
        timestamp,
      });
      failed = true;
    });
    return failed;
  }

  reconcileExpiredRounds(): number {
    const timestamp = this.timestamp();
    let reconciled = 0;
    this.inImmediate(() => {
      const rows = this.database
        .prepare(
          `SELECT r.*, a.id AS attempt_id, a.request_id AS attempt_request_id,
                  a.attempt_type AS attempt_type
           FROM conversation_rounds r
           JOIN conversation_round_attempts a ON a.id = r.current_attempt_id
           WHERE r.status IN (
               'accepted', 'understanding', 'recalling', 'generating'
             )
             AND a.status IN ('accepted', 'running')
             AND a.lease_expires_at IS NOT NULL
             AND a.lease_expires_at <= ?`,
        )
        .all(timestamp) as DatabaseRow[];
      for (const row of rows) {
        const roundId = String(row.id);
        const attemptId = String(row.attempt_id);
        const stage = String(row.status);
        const code = 'ROUND_LEASE_EXPIRED';
        const message = '服务重启或执行租约过期，本轮已中断';
        this.database
          .prepare(
            `UPDATE conversation_round_attempts
             SET status = 'interrupted', failure_code = ?,
                 failure_message = ?, failure_retryable = 1,
                 failure_stage = ?, lease_owner = NULL,
                 lease_expires_at = NULL, updated_at = ?, ended_at = ?
             WHERE id = ? AND status IN ('accepted', 'running')`,
          )
          .run(code, message, stage, timestamp, timestamp, attemptId);
        const isRegenerate = row.attempt_type === 'regenerate';
        if (isRegenerate) {
          this.database
            .prepare(
              `UPDATE conversation_regeneration_requests
               SET status = 'interrupted', failure_code = ?,
                   failure_message = ?, updated_at = ?, completed_at = ?
               WHERE attempt_id = ? AND status IN ('accepted', 'running')`,
            )
            .run(code, message, timestamp, timestamp, attemptId);
          this.database
            .prepare(
              `UPDATE conversation_rounds
               SET status = 'completed', failure_code = NULL,
                   failure_message = NULL, failure_retryable = NULL,
                   failure_stage = NULL, updated_at = ?
               WHERE id = ? AND current_attempt_id = ?
                 AND status IN (
                   'accepted', 'understanding', 'recalling', 'generating'
                 )`,
            )
            .run(timestamp, roundId, attemptId);
        } else {
          this.database
            .prepare(
              `UPDATE conversation_rounds
               SET status = 'interrupted', failure_code = ?,
                   failure_message = ?, failure_retryable = 1,
                   failure_stage = ?, updated_at = ?, completed_at = ?
               WHERE id = ? AND current_attempt_id = ?
                 AND status IN (
                   'accepted', 'understanding', 'recalling', 'generating'
                 )`,
            )
            .run(
              code,
              message,
              stage,
              timestamp,
              timestamp,
              roundId,
              attemptId,
            );
        }
        this.insertRoundEvent({
          roundId,
          attemptId,
          requestId: String(row.attempt_request_id),
          type: 'turn.interrupted',
          data: {
            roundId,
            attemptId,
            requestId: String(row.attempt_request_id),
            code,
            message,
            retryable: true,
            stage,
            regenerate: isRegenerate,
          },
          containsBody: false,
          timestamp,
        });
        reconciled += 1;
      }
    });
    this.processConversationMaintenanceJobs(10);
    return reconciled;
  }

  isRoundTerminal(status: ConversationRoundStatus): boolean {
    return ['completed', 'failed', 'interrupted', 'deleted'].includes(status);
  }

  rotateCursorKey(): number {
    const timestamp = this.timestamp();
    let keyVersion = 0;
    this.inImmediate(() => {
      this.database
        .prepare(
          `DELETE FROM conversation_cursor_keys WHERE status = 'previous'`,
        )
        .run();
      this.database
        .prepare(
          `UPDATE conversation_cursor_keys
           SET status = 'previous', retired_at = ?
           WHERE status = 'current'`,
        )
        .run(timestamp);
      const result = this.database
        .prepare(
          `INSERT INTO conversation_cursor_keys (
             secret, status, created_at, retired_at
           ) VALUES (?, 'current', ?, NULL)`,
        )
        .run(randomBytes(32), timestamp);
      keyVersion = Number(result.lastInsertRowid);
    });
    return keyVersion;
  }

  private normalizeImportInput(input: ConversationImportInput): {
    readonly importId: string;
    readonly batchCursor: string | null;
    readonly isLastBatch: boolean;
    readonly conversations: readonly NormalizedImportConversation[];
  } {
    if (
      typeof input.dryRun !== 'boolean' ||
      typeof input.isLastBatch !== 'boolean' ||
      (input.batchCursor !== null && typeof input.batchCursor !== 'string') ||
      !Array.isArray(input.conversations) ||
      input.conversations.length > 100
    ) {
      serviceError('INVALID_REQUEST');
    }
    const importId = cleanRequired(input.importId, 255);
    const batchCursor = input.batchCursor === null
      ? null
      : cleanRequired(input.batchCursor, 16_384);
    let serializedSize = 0;
    try {
      serializedSize = Buffer.byteLength(JSON.stringify(input), 'utf8');
    } catch {
      serviceError('INVALID_REQUEST');
    }
    if (serializedSize > 10 * 1024 * 1024) {
      serviceError('INVALID_REQUEST');
    }
    const sessionIds = new Set<string>();
    let messageCount = 0;
    const conversations = input.conversations.map((conversation) => {
      if (!isRecord(conversation) || !Array.isArray(conversation.messages)) {
        serviceError('INVALID_REQUEST');
      }
      if (!hasOnlyFields(conversation, [
        'externalSessionId',
        'personaId',
        'projectId',
        'title',
        'messages',
      ])) {
        serviceError('INVALID_REQUEST');
      }
      const externalSessionId = cleanRequired(
        conversation.externalSessionId,
        255,
      );
      if (sessionIds.has(externalSessionId)) serviceError('INVALID_REQUEST');
      sessionIds.add(externalSessionId);
      const personaId = cleanRequired(conversation.personaId, 255);
      const projectId = conversation.projectId === null
        ? null
        : cleanRequired(conversation.projectId, 255);
      const title = cleanNullableTitle(conversation.title);
      const messageIds = new Set<string>();
      const roundRoles = new Map<string, Set<string>>();
      const messages = conversation.messages.map((message) => {
        if (!isRecord(message)) serviceError('INVALID_REQUEST');
        if (!hasOnlyFields(message, [
          'externalMessageId',
          'externalRoundId',
          'role',
          'displayContent',
          'occurredAt',
        ])) {
          serviceError('INVALID_REQUEST');
        }
        const externalMessageId = cleanRequired(
          message.externalMessageId,
          255,
        );
        if (messageIds.has(externalMessageId)) serviceError('INVALID_REQUEST');
        messageIds.add(externalMessageId);
        const externalRoundId = cleanRequired(message.externalRoundId, 255);
        if (message.role !== 'user' && message.role !== 'assistant') {
          serviceError('INVALID_REQUEST');
        }
        const rawContent = cleanText(message.displayContent, 1_000_000);
        let displayContent = rawContent;
        if (message.role === 'assistant') {
          displayContent = sanitizeAssistantProtocol(rawContent).displayContent;
        }
        if (containsCredentialSecret({ content: rawContent })) {
          displayContent = REDACTED_ASSISTANT_CREDENTIAL;
        }
        if (message.role === 'user' && !displayContent.normalize('NFKC').trim()) {
          serviceError('INVALID_REQUEST');
        }
        const occurredAt = this.isoTimestamp(message.occurredAt);
        const roles = roundRoles.get(externalRoundId) ?? new Set<string>();
        if (roles.has(message.role)) serviceError('INVALID_REQUEST');
        roles.add(message.role);
        roundRoles.set(externalRoundId, roles);
        return Object.freeze({
          externalMessageId,
          externalRoundId,
          role: message.role,
          displayContent,
          occurredAt,
          payloadHash: digest({
            role: message.role,
            displayContent,
          }),
        });
      });
      messageCount += messages.length;
      if (messageCount > 2_000) serviceError('INVALID_REQUEST');
      for (const roles of roundRoles.values()) {
        if (!roles.has('user')) serviceError('INVALID_REQUEST');
      }
      return Object.freeze({
        externalSessionId,
        personaId,
        projectId,
        title,
        payloadHash: digest({ personaId, projectId, title }),
        messages: Object.freeze(messages),
      });
    });
    return Object.freeze({
      importId,
      batchCursor,
      isLastBatch: input.isLastBatch,
      conversations: Object.freeze(conversations),
    });
  }

  private newImportCounter(): MutableImportCounter {
    return { created: 0, matched: 0, conflicted: 0, skipped: 0 };
  }

  private freezeImportStats(counters: {
    readonly conversations: MutableImportCounter;
    readonly messages: MutableImportCounter;
  }): ConversationImportStats {
    const conversations = Object.freeze({ ...counters.conversations });
    const messages = Object.freeze({ ...counters.messages });
    return Object.freeze({
      created: conversations.created + messages.created,
      matched: conversations.matched + messages.matched,
      conflicted: conversations.conflicted + messages.conflicted,
      skipped: conversations.skipped + messages.skipped,
      conversations,
      messages,
    });
  }

  private importReceiptFromRow(
    row: DatabaseRow,
    replayed: boolean,
  ): ConversationImportReceipt {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(row.stats_json));
    } catch {
      serviceError('INVALID_REQUEST');
    }
    if (!isRecord(parsed) ||
        !isRecord(parsed.conversations) ||
        !isRecord(parsed.messages)) {
      serviceError('INVALID_REQUEST');
    }
    const counter = (value: Record<string, unknown>) => Object.freeze({
      created: Number(value.created ?? 0),
      matched: Number(value.matched ?? 0),
      conflicted: Number(value.conflicted ?? 0),
      skipped: Number(value.skipped ?? 0),
    });
    const stats = Object.freeze({
      created: Number(parsed.created ?? 0),
      matched: Number(parsed.matched ?? 0),
      conflicted: Number(parsed.conflicted ?? 0),
      skipped: Number(parsed.skipped ?? 0),
      conversations: counter(parsed.conversations),
      messages: counter(parsed.messages),
    });
    return Object.freeze({
      importId: String(row.import_id),
      lane: String(row.lane) as 'dry_run' | 'commit',
      batchIndex: Number(row.batch_index),
      batchCursor: String(row.batch_cursor_out),
      isLastBatch: Number(row.is_last_batch) === 1,
      replayed,
      stats,
    });
  }

  private importConversationBatchItem(input: {
    readonly tenant: ConversationTenant;
    readonly importId: string;
    readonly conversation: NormalizedImportConversation;
    readonly dryRun: boolean;
    readonly counters: {
      readonly conversations: MutableImportCounter;
      readonly messages: MutableImportCounter;
    };
    readonly timestamp: string;
  }): void {
    const value = input.conversation;
    this.requirePersona(input.tenant, value.personaId);
    const profile = this.database
      .prepare(
        `SELECT profile_version FROM persona_chat_profiles
         WHERE principal_id = ? AND persona_id = ?
         ORDER BY profile_version DESC LIMIT 1`,
      )
      .get(input.tenant.principalId, value.personaId);
    if (!profile) serviceError('PERSONA_PROFILE_NOT_FOUND');
    if (value.projectId !== null) {
      this.requireProject(input.tenant, value.projectId);
    }
    const mapping = this.database
      .prepare(
        `SELECT * FROM conversation_import_sessions
         WHERE user_id = ? AND namespace = ? AND external_session_id = ?`,
      )
      .get(
        input.tenant.principalId,
        input.tenant.namespace,
        value.externalSessionId,
      ) as DatabaseRow | undefined;
    let session = mapping
      ? this.database
          .prepare(
            `SELECT * FROM conversation_sessions
             WHERE id = ? AND user_id = ? AND namespace = ?`,
          )
          .get(
            String(mapping.conversation_id),
            input.tenant.principalId,
            input.tenant.namespace,
          ) as DatabaseRow | undefined
      : this.database
          .prepare(
            `SELECT * FROM conversation_sessions
             WHERE user_id = ? AND namespace = ? AND external_id = ?
             ORDER BY started_at ASC, id ASC LIMIT 1`,
          )
          .get(
            input.tenant.principalId,
            input.tenant.namespace,
            value.externalSessionId,
          ) as DatabaseRow | undefined;
    const identityConflict = session && (
      session.status === 'deleted' ||
      session.persona_id !== value.personaId ||
      nullableText(session.project_id) !== value.projectId ||
      (mapping && mapping.payload_hash !== value.payloadHash)
    );
    if (identityConflict) {
      input.counters.conversations.conflicted += 1;
      input.counters.messages.skipped += value.messages.length;
      return;
    }
    let conversationId: string;
    if (session) {
      conversationId = String(session.id);
      input.counters.conversations.matched += 1;
    } else {
      conversationId = randomUUID();
      input.counters.conversations.created += 1;
      if (!input.dryRun) {
        this.database
          .prepare(
            `INSERT INTO conversation_sessions (
               id, user_id, namespace, client_name, external_id,
               started_at, ended_at, metadata_json, persona_id,
               identity_source, identity_status, project_id, title,
               status, version, last_message_at, last_message_preview,
               message_count, persona_profile_version, updated_at,
               create_idempotency_key, create_payload_hash,
               deletion_generation, deleted_at
             ) VALUES (
               ?, ?, ?, 'client-import', ?, ?, NULL, ?, ?, 'credential',
               'complete', ?, ?, 'active', 1, NULL, NULL, 0, ?, ?, ?, ?,
               1, NULL
             )`,
          )
          .run(
            conversationId,
            input.tenant.principalId,
            input.tenant.namespace,
            value.externalSessionId,
            input.timestamp,
            JSON.stringify({
              source: 'client-import',
              importId: input.importId,
              lifecycleSuppressed: true,
            }),
            value.personaId,
            value.projectId,
            value.title,
            Number(profile.profile_version),
            input.timestamp,
            `import:${input.importId}:${value.externalSessionId}`,
            value.payloadHash,
          );
        session = this.database
          .prepare('SELECT * FROM conversation_sessions WHERE id = ?')
          .get(conversationId) as DatabaseRow;
      }
    }
    if (!input.dryRun) {
      this.database
        .prepare(
          `INSERT OR IGNORE INTO conversation_import_sessions (
             user_id, namespace, import_id, external_session_id,
             conversation_id, payload_hash, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.tenant.principalId,
          input.tenant.namespace,
          input.importId,
          value.externalSessionId,
          conversationId,
          value.payloadHash,
          input.timestamp,
        );
      if (session && !session.title && value.title) {
        this.database
          .prepare(
            `UPDATE conversation_sessions
             SET title = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND title IS NULL`,
          )
          .run(value.title, input.timestamp, conversationId);
      }
    }

    const groups = new Map<string, NormalizedImportMessage[]>();
    for (const message of value.messages) {
      const group = groups.get(message.externalRoundId) ?? [];
      group.push(message);
      groups.set(message.externalRoundId, group);
    }
    const orderedGroups = [...groups.entries()].sort((left, right) => {
      const leftAt = left[1][0]?.occurredAt ?? '';
      const rightAt = right[1][0]?.occurredAt ?? '';
      return leftAt.localeCompare(rightAt) || left[0].localeCompare(right[0]);
    });
    for (const [externalRoundId, messages] of orderedGroups) {
      this.importConversationRound({
        tenant: input.tenant,
        importId: input.importId,
        externalSessionId: value.externalSessionId,
        conversationId,
        personaProfileVersion: Number(profile.profile_version),
        externalRoundId,
        messages: Object.freeze([...messages].sort((left, right) =>
          left.occurredAt.localeCompare(right.occurredAt) ||
          (left.role === right.role ? 0 : left.role === 'user' ? -1 : 1),
        )),
        dryRun: input.dryRun,
        counter: input.counters.messages,
        timestamp: input.timestamp,
      });
    }
    if (!input.dryRun) {
      this.database
        .prepare(
          `UPDATE conversation_sessions
           SET message_count = (
                 SELECT COUNT(*) FROM conversation_turns t
                 WHERE t.session_id = conversation_sessions.id
                   AND t.message_status != 'deleted'
                   AND t.is_active_variant = 1
               ),
               last_message_at = (
                 SELECT t.occurred_at FROM conversation_turns t
                 WHERE t.session_id = conversation_sessions.id
                   AND t.message_status != 'deleted'
                   AND t.is_active_variant = 1
                 ORDER BY t.message_sequence DESC LIMIT 1
               ),
               last_message_preview = (
                 SELECT SUBSTR(t.display_content, 1, 160)
                 FROM conversation_turns t
                 WHERE t.session_id = conversation_sessions.id
                   AND t.message_status != 'deleted'
                   AND t.is_active_variant = 1
                 ORDER BY t.message_sequence DESC LIMIT 1
               ),
               updated_at = ?, version = version + 1
           WHERE id = ?`,
        )
        .run(input.timestamp, conversationId);
      this.insertConversationUpsert(
        input.tenant,
        conversationId,
        input.timestamp,
      );
    }
  }

  private importConversationRound(input: {
    readonly tenant: ConversationTenant;
    readonly importId: string;
    readonly externalSessionId: string;
    readonly conversationId: string;
    readonly personaProfileVersion: number;
    readonly externalRoundId: string;
    readonly messages: readonly NormalizedImportMessage[];
    readonly dryRun: boolean;
    readonly counter: MutableImportCounter;
    readonly timestamp: string;
  }): void {
    const descriptors = input.messages.map((message) => {
      const mapping = this.database
        .prepare(
          `SELECT * FROM conversation_import_messages
           WHERE user_id = ? AND namespace = ?
             AND external_session_id = ? AND external_message_id = ?`,
        )
        .get(
          input.tenant.principalId,
          input.tenant.namespace,
          input.externalSessionId,
          message.externalMessageId,
        ) as DatabaseRow | undefined;
      const row = mapping
        ? this.database
            .prepare(
              `SELECT * FROM conversation_turns
               WHERE id = ? AND session_id = ? AND user_id = ?
                 AND namespace = ?`,
            )
            .get(
              String(mapping.message_id),
              input.conversationId,
              input.tenant.principalId,
              input.tenant.namespace,
            ) as DatabaseRow | undefined
        : this.database
            .prepare(
              `SELECT * FROM conversation_turns
               WHERE session_id = ? AND user_id = ? AND namespace = ?
                 AND external_id = ?`,
            )
            .get(
              input.conversationId,
              input.tenant.principalId,
              input.tenant.namespace,
              message.externalMessageId,
            ) as DatabaseRow | undefined;
      const conflict = Boolean(mapping && (
        mapping.payload_hash !== message.payloadHash ||
        mapping.external_round_id !== input.externalRoundId
      )) || Boolean(row && (
        row.role !== message.role ||
        String(row.display_content ?? row.content) !== message.displayContent ||
        row.message_status === 'deleted'
      ));
      return { message, mapping, row, conflict };
    });
    const existingRoundIds = [...new Set(
      descriptors
        .map((descriptor) => nullableText(descriptor.row?.round_id))
        .filter((value): value is string => value !== null),
    )];
    let groupConflict = descriptors.some((descriptor) => descriptor.conflict) ||
      existingRoundIds.length > 1;
    if (!groupConflict && existingRoundIds.length === 1) {
      const round = this.database
        .prepare(
          `SELECT * FROM conversation_rounds
           WHERE id = ? AND conversation_id = ? AND user_id = ?
             AND namespace = ?`,
        )
        .get(
          existingRoundIds[0],
          input.conversationId,
          input.tenant.principalId,
          input.tenant.namespace,
        ) as DatabaseRow | undefined;
      const user = descriptors.find(
        (descriptor) => descriptor.message.role === 'user',
      )?.row;
      if (round && user && round.user_message_id !== user.id) {
        groupConflict = true;
      }
    }
    if (groupConflict) {
      for (const descriptor of descriptors) {
        if (descriptor.conflict) input.counter.conflicted += 1;
        else if (descriptor.row) input.counter.matched += 1;
        else input.counter.skipped += 1;
      }
      return;
    }
    for (const descriptor of descriptors) {
      if (descriptor.row) input.counter.matched += 1;
      else input.counter.created += 1;
    }
    if (input.dryRun) return;

    const roundId = existingRoundIds[0] ?? randomUUID();
    const persistedRows = new Map<'user' | 'assistant', DatabaseRow>();
    for (const descriptor of descriptors) {
      const message = descriptor.message;
      let row = descriptor.row;
      if (!row) {
        const messageId = randomUUID();
        const sequence = this.nextMessageSequence(input.conversationId);
        this.database
          .prepare(
            `INSERT INTO conversation_turns (
               id, session_id, user_id, namespace, external_id, role,
               content, content_hash, occurred_at, created_at,
               metadata_json, round_id, message_sequence, display_content,
               normalized_content, message_status, client_message_id,
               message_payload_hash, generation_group_id, variant_index,
               is_active_variant, completed_at, message_version
             ) VALUES (
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed',
               ?, ?, ?, 1, 1, ?, 1
             )`,
          )
          .run(
            messageId,
            input.conversationId,
            input.tenant.principalId,
            input.tenant.namespace,
            message.externalMessageId,
            message.role,
            message.displayContent,
            digest(message.displayContent),
            message.occurredAt,
            input.timestamp,
            JSON.stringify({
              source: 'client-import',
              importId: input.importId,
              externalRoundId: input.externalRoundId,
              lifecycleSuppressed: true,
              skipAutoExtraction: true,
            }),
            roundId,
            sequence,
            message.displayContent,
            message.role === 'user'
              ? message.displayContent.normalize('NFKC')
              : null,
            `import:${digest(
              `${input.externalSessionId}:${message.externalMessageId}`,
            ).slice(0, 48)}`,
            message.payloadHash,
            message.role === 'assistant' ? roundId : null,
            message.occurredAt,
          );
        row = this.database
          .prepare('SELECT * FROM conversation_turns WHERE id = ?')
          .get(messageId) as DatabaseRow;
      } else if (!row.round_id) {
        this.database
          .prepare(
            `UPDATE conversation_turns
             SET round_id = ?, generation_group_id = CASE
                   WHEN role = 'assistant'
                     THEN COALESCE(generation_group_id, ?)
                   ELSE generation_group_id
                 END,
                 message_status = 'completed', is_active_variant = 1,
                 message_version = message_version + 1,
                 metadata_json = json_set(
                   metadata_json,
                   '$.importId', ?,
                   '$.externalRoundId', ?,
                   '$.lifecycleSuppressed', json('true'),
                   '$.skipAutoExtraction', json('true')
                 )
             WHERE id = ? AND round_id IS NULL`,
          )
          .run(
            roundId,
            roundId,
            input.importId,
            input.externalRoundId,
            String(row.id),
          );
        row = this.database
          .prepare('SELECT * FROM conversation_turns WHERE id = ?')
          .get(String(row.id)) as DatabaseRow;
      }
      persistedRows.set(message.role, row);
      this.database
        .prepare(
          `INSERT OR IGNORE INTO conversation_import_messages (
             user_id, namespace, import_id, external_session_id,
             external_message_id, external_round_id, message_id,
             payload_hash, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.tenant.principalId,
          input.tenant.namespace,
          input.importId,
          input.externalSessionId,
          message.externalMessageId,
          input.externalRoundId,
          String(row.id),
          message.payloadHash,
          input.timestamp,
        );
      const publicMessage = this.messageFromRow(row);
      this.insertChange({
        tenant: input.tenant,
        type: 'message.upsert',
        conversationId: input.conversationId,
        resourceId: publicMessage.id,
        resourceVersion: publicMessage.version,
        resource: Object.freeze({ ...publicMessage }),
        timestamp: input.timestamp,
      });
    }
    const user = persistedRows.get('user');
    if (!user) serviceError('INVALID_REQUEST');
    const assistant = persistedRows.get('assistant');
    const terminalStatus = assistant ? 'completed' : 'interrupted';
    const existingRound = this.database
      .prepare(
        `SELECT * FROM conversation_rounds
         WHERE id = ? AND conversation_id = ?`,
      )
      .get(roundId, input.conversationId) as DatabaseRow | undefined;
    if (!existingRound) {
      const requestId = `import:${digest(
        `${input.importId}:${input.externalSessionId}:${input.externalRoundId}`,
      ).slice(0, 48)}`;
      this.database
        .prepare(
          `INSERT INTO conversation_rounds (
             id, conversation_id, user_id, namespace, client_message_id,
             request_payload_hash, user_message_id, status,
             persona_profile_version_used, active_assistant_message_id,
             current_attempt_id, generation, failure_code, failure_message,
             failure_retryable, failure_stage, request_id, created_at,
             updated_at, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?,
             ?, ?, ?, ?)`,
        )
        .run(
          roundId,
          input.conversationId,
          input.tenant.principalId,
          input.tenant.namespace,
          String(user.client_message_id),
          digest(input.messages),
          String(user.id),
          terminalStatus,
          input.personaProfileVersion,
          assistant ? String(assistant.id) : null,
          assistant ? null : 'IMPORTED_USER_ONLY',
          assistant ? null : 'imported user turn has no assistant reply',
          assistant ? null : 0,
          assistant ? null : 'import',
          requestId,
          String(user.occurred_at),
          input.timestamp,
          input.timestamp,
        );
      const attemptId = randomUUID();
      this.database
        .prepare(
          `INSERT INTO conversation_round_attempts (
             id, round_id, attempt_number, attempt_type, status,
             lease_owner, lease_expires_at, heartbeat_at, request_id,
             generation, failure_code, failure_message, failure_retryable,
             failure_stage, started_at, updated_at, ended_at
           ) VALUES (?, ?, 1, 'initial', ?, NULL, NULL, ?, ?, 1,
             ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attemptId,
          roundId,
          terminalStatus,
          input.timestamp,
          requestId,
          assistant ? null : 'IMPORTED_USER_ONLY',
          assistant ? null : 'imported user turn has no assistant reply',
          assistant ? null : 0,
          assistant ? null : 'import',
          String(user.occurred_at),
          input.timestamp,
          input.timestamp,
        );
      this.database
        .prepare(
          `UPDATE conversation_rounds SET current_attempt_id = ?
           WHERE id = ?`,
        )
        .run(attemptId, roundId);
      this.insertRoundEvent({
        roundId,
        attemptId,
        requestId,
        type: assistant ? 'turn.completed' : 'turn.interrupted',
        data: {
          roundId,
          attemptId,
          requestId,
          imported: true,
          lifecycleSuppressed: true,
        },
        containsBody: false,
        timestamp: input.timestamp,
      });
    }
  }

  private deleteResource(
    tenant: ConversationTenant,
    resourceType: 'message' | 'conversation',
    resourceId: string,
    input: {
      readonly clientRequestId: string;
      readonly reason: string;
      readonly memoryPolicy: ConversationMemoryPolicy;
    },
  ): ConversationDeletionReceipt {
    const clientRequestId = cleanRequired(input.clientRequestId, 255);
    const reason = cleanRequired(input.reason, 1_000);
    if (
      input.memoryPolicy !== 'retain_derived_memories' &&
      input.memoryPolicy !== 'forget_derived_memories'
    ) {
      serviceError('INVALID_REQUEST');
    }
    const requestPayloadHash = digest({
      resourceType,
      resourceId,
      memoryPolicy: input.memoryPolicy,
      reason,
    });
    let receipt: DatabaseRow | undefined;
    this.inImmediate(() => {
      const replay = this.database
        .prepare(
          `SELECT * FROM conversation_deletion_receipts
           WHERE user_id = ? AND namespace = ? AND client_request_id = ?`,
        )
        .get(
          tenant.principalId,
          tenant.namespace,
          clientRequestId,
        ) as DatabaseRow | undefined;
      if (replay) {
        if (String(replay.request_payload_hash) !== requestPayloadHash) {
          serviceError('IDEMPOTENCY_CONFLICT');
        }
        receipt = replay;
        return;
      }
      const previous = this.database
        .prepare(
          `SELECT * FROM conversation_deletion_receipts
           WHERE user_id = ? AND namespace = ?
             AND resource_type = ? AND resource_id = ?`,
        )
        .get(
          tenant.principalId,
          tenant.namespace,
          resourceType,
          resourceId,
        ) as DatabaseRow | undefined;
      if (previous) {
        if (previous.memory_policy !== input.memoryPolicy) {
          serviceError('DELETE_POLICY_CONFLICT');
        }
        receipt = previous;
        return;
      }

      let conversationId = resourceId;
      let affectedRows: DatabaseRow[];
      if (resourceType === 'message') {
        const message = this.database
          .prepare(
            `SELECT t.* FROM conversation_turns t
             JOIN conversation_sessions s ON s.id = t.session_id
             WHERE t.id = ? AND t.user_id = ? AND t.namespace = ?
               AND s.user_id = t.user_id AND s.namespace = t.namespace
               AND s.status != 'deleted' AND t.message_status != 'deleted'`,
          )
          .get(
            resourceId,
            tenant.principalId,
            tenant.namespace,
          ) as DatabaseRow | undefined;
        if (!message) serviceError('MESSAGE_NOT_FOUND');
        conversationId = String(message.session_id);
        affectedRows = message.round_id
          ? this.database
              .prepare(
                `SELECT * FROM conversation_turns
                 WHERE session_id = ? AND round_id = ?
                   AND user_id = ? AND namespace = ?
                   AND message_status != 'deleted'
                 ORDER BY message_sequence ASC`,
              )
              .all(
                conversationId,
                String(message.round_id),
                tenant.principalId,
                tenant.namespace,
              ) as DatabaseRow[]
          : [message];
      } else {
        const conversation = this.database
          .prepare(
            `SELECT * FROM conversation_sessions
             WHERE id = ? AND user_id = ? AND namespace = ?
               AND status != 'deleted'`,
          )
          .get(
            conversationId,
            tenant.principalId,
            tenant.namespace,
          ) as DatabaseRow | undefined;
        if (!conversation) serviceError('CONVERSATION_NOT_FOUND');
        affectedRows = this.database
          .prepare(
            `SELECT * FROM conversation_turns
             WHERE session_id = ? AND user_id = ? AND namespace = ?
               AND message_status != 'deleted'
             ORDER BY message_sequence ASC`,
          )
          .all(
            conversationId,
            tenant.principalId,
            tenant.namespace,
          ) as DatabaseRow[];
      }
      const affectedMessageIds = affectedRows.map((row) => String(row.id));
      const roundIds = [...new Set(
        affectedRows
          .map((row) => nullableText(row.round_id))
          .filter((value): value is string => value !== null),
      )];
      const roundRows = roundIds.length === 0
        ? []
        : this.rowsByIds(
            `SELECT * FROM conversation_rounds
             WHERE id IN (__IDS__) AND user_id = ? AND namespace = ?`,
            roundIds,
            tenant,
          );
      const cancelledRoundIds = roundRows
        .filter((row) => [
          'accepted',
          'understanding',
          'recalling',
          'generating',
        ].includes(String(row.status)))
        .map((row) => String(row.id));
      const timestamp = this.timestamp();
      const receiptId = randomUUID();
      const purgeJobId = randomUUID();
      this.database
        .prepare(
          `INSERT INTO conversation_deletion_receipts (
             id, user_id, namespace, client_request_id, resource_type,
             resource_id, conversation_id, memory_policy, reason_hash,
             request_payload_hash, affected_message_ids_json,
             memory_action_request_ids_json, cancelled_round_ids_json,
             purge_job_id, created_at, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
        )
        .run(
          receiptId,
          tenant.principalId,
          tenant.namespace,
          clientRequestId,
          resourceType,
          resourceId,
          conversationId,
          input.memoryPolicy,
          digest(reason),
          requestPayloadHash,
          JSON.stringify(affectedMessageIds),
          JSON.stringify(cancelledRoundIds),
          purgeJobId,
          timestamp,
          timestamp,
        );

      const memoryActionRequestIds = this.applyDeletionMemoryPolicy({
        tenant,
        receiptId,
        turnRows: affectedRows,
        memoryPolicy: input.memoryPolicy,
        timestamp,
      });
      this.database
        .prepare(
          `UPDATE conversation_deletion_receipts
           SET memory_action_request_ids_json = ? WHERE id = ?`,
        )
        .run(JSON.stringify(memoryActionRequestIds), receiptId);

      const barrierExpiry = this.timestampAfter(
        timestamp,
        CHANGE_RETENTION_MS,
      );
      if (resourceType === 'conversation') {
        const generation = Number(
          this.database
            .prepare(
              `SELECT deletion_generation FROM conversation_sessions
               WHERE id = ?`,
            )
            .get(conversationId)?.deletion_generation ?? 1,
        ) + 1;
        this.database
          .prepare(
            `INSERT INTO conversation_deletion_barriers (
               id, user_id, namespace, conversation_id, round_id,
               resource_type, resource_id, generation, created_at, expires_at
             ) VALUES (?, ?, ?, ?, NULL, 'conversation', ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            tenant.principalId,
            tenant.namespace,
            conversationId,
            conversationId,
            generation,
            timestamp,
            barrierExpiry,
          );
      }
      for (const round of roundRows) {
        const roundId = String(round.id);
        const generation = Number(round.generation) + 1;
        this.database
          .prepare(
            `INSERT INTO conversation_deletion_barriers (
               id, user_id, namespace, conversation_id, round_id,
               resource_type, resource_id, generation, created_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, 'round', ?, ?, ?, ?)` ,
          )
          .run(
            randomUUID(),
            tenant.principalId,
            tenant.namespace,
            conversationId,
            roundId,
            roundId,
            generation,
            timestamp,
            barrierExpiry,
          );
        this.database
          .prepare(
            `UPDATE conversation_round_events
             SET data_json = json_object(
                   'roundId', round_id, 'deleted', json('true')
                 ), contains_body = 0
             WHERE round_id = ?`,
          )
          .run(roundId);
        const attemptId = nullableText(round.current_attempt_id);
        const requestId = String(round.request_id);
        this.database
          .prepare(
            `UPDATE conversation_round_attempts
             SET status = 'deleted', lease_owner = NULL,
                 lease_expires_at = NULL, heartbeat_at = ?,
                 failure_code = 'SOURCE_DELETED',
                 failure_message = 'source deleted',
                 failure_retryable = 0, failure_stage = 'deleted',
                 updated_at = ?, ended_at = ?
             WHERE round_id = ? AND status != 'deleted'`,
          )
          .run(timestamp, timestamp, timestamp, roundId);
        this.database
          .prepare(
            `UPDATE conversation_regeneration_requests
             SET status = 'deleted', failure_code = 'SOURCE_DELETED',
                 failure_message = 'source deleted', updated_at = ?,
                 completed_at = ?
             WHERE round_id = ? AND status != 'deleted'`,
          )
          .run(timestamp, timestamp, roundId);
        this.database
          .prepare(
            `UPDATE conversation_rounds
             SET status = 'deleted', active_assistant_message_id = NULL,
                 generation = ?, failure_code = 'SOURCE_DELETED',
                 failure_message = 'source deleted', failure_retryable = 0,
                 failure_stage = 'deleted', updated_at = ?, completed_at = ?
             WHERE id = ?`,
          )
          .run(generation, timestamp, timestamp, roundId);
        this.insertRoundEvent({
          roundId,
          attemptId,
          requestId,
          type: 'turn.deleted',
          data: {
            roundId,
            attemptId,
            requestId,
            deleted: true,
          },
          containsBody: false,
          timestamp,
        });
      }

      this.forIdChunks(affectedMessageIds, (ids, placeholders) => {
        this.database
          .prepare(
            `DELETE FROM conversation_message_actions
             WHERE message_id IN (${placeholders})`,
          )
          .run(...ids);
        this.database
          .prepare(
            `UPDATE conversation_turns
             SET content = '[deleted]', content_hash = ?,
                 display_content = '[deleted]', normalized_content = NULL,
                 metadata_json = json_object(
                   'source', 'conversation-api',
                   'deletionReceiptId', ?,
                   'memoryPolicy', ?,
                   'deleted', json('true')
                 ), message_status = 'deleted', is_active_variant = 0,
                 message_version = message_version + 1
             WHERE id IN (${placeholders})`,
          )
          .run(
            digest('[deleted]'),
            receiptId,
            input.memoryPolicy,
            ...ids,
          );
        this.database
          .prepare(
            `UPDATE conversation_changes
             SET tombstone = 1, resource_json = NULL
             WHERE user_id = ? AND namespace = ?
               AND resource_id IN (${placeholders})`,
          )
          .run(tenant.principalId, tenant.namespace, ...ids);
      });
      this.cancelDeletedTurnWork(
        tenant,
        affectedMessageIds,
        timestamp,
      );
      this.invalidateLayeredMemoriesForDeletedTurns(
        tenant,
        affectedMessageIds,
        timestamp,
      );

      if (resourceType === 'conversation') {
        this.database
          .prepare(
            `UPDATE conversation_sessions
             SET status = 'deleted', deletion_generation = deletion_generation + 1,
                 deleted_at = ?, ended_at = COALESCE(ended_at, ?),
                 message_count = 0, last_message_at = NULL,
                 last_message_preview = NULL, updated_at = ?,
                 version = version + 1
             WHERE id = ?`,
          )
          .run(timestamp, timestamp, timestamp, conversationId);
        this.database
          .prepare(
            `UPDATE conversation_changes
             SET tombstone = 1, resource_json = NULL
             WHERE user_id = ? AND namespace = ? AND conversation_id = ?`,
          )
          .run(tenant.principalId, tenant.namespace, conversationId);
      } else {
        this.database
          .prepare(
            `UPDATE conversation_sessions
             SET message_count = (
                   SELECT COUNT(*) FROM conversation_turns t
                   WHERE t.session_id = conversation_sessions.id
                     AND t.message_status != 'deleted'
                     AND t.is_active_variant = 1
                 ),
                 last_message_at = (
                   SELECT t.occurred_at FROM conversation_turns t
                   WHERE t.session_id = conversation_sessions.id
                     AND t.message_status != 'deleted'
                     AND t.is_active_variant = 1
                   ORDER BY t.message_sequence DESC LIMIT 1
                 ),
                 last_message_preview = (
                   SELECT SUBSTR(t.display_content, 1, 160)
                   FROM conversation_turns t
                   WHERE t.session_id = conversation_sessions.id
                     AND t.message_status != 'deleted'
                     AND t.is_active_variant = 1
                   ORDER BY t.message_sequence DESC LIMIT 1
                 ),
                 updated_at = ?, version = version + 1
             WHERE id = ?`,
          )
          .run(timestamp, conversationId);
        const safeConversation = conversationFromRow(
          this.requireConversationRow(tenant, conversationId),
        );
        this.database
          .prepare(
            `UPDATE conversation_changes
             SET resource_json = ?, tombstone = 0
             WHERE user_id = ? AND namespace = ?
               AND conversation_id = ?
               AND event_type = 'conversation.upsert'`,
          )
          .run(
            JSON.stringify(safeConversation),
            tenant.principalId,
            tenant.namespace,
            conversationId,
          );
      }

      for (const messageId of affectedMessageIds) {
        const version = Number(
          this.database
            .prepare(
              'SELECT message_version FROM conversation_turns WHERE id = ?',
            )
            .get(messageId)?.message_version ?? 1,
        );
        this.insertChange({
          tenant,
          type: 'message.delete',
          conversationId,
          resourceId: messageId,
          resourceVersion: version,
          resource: null,
          tombstone: true,
          timestamp,
        });
      }
      if (resourceType === 'conversation') {
        const version = Number(
          this.database
            .prepare(
              'SELECT version FROM conversation_sessions WHERE id = ?',
            )
            .get(conversationId)?.version ?? 1,
        );
        this.insertChange({
          tenant,
          type: 'conversation.delete',
          conversationId,
          resourceId: conversationId,
          resourceVersion: version,
          resource: null,
          tombstone: true,
          timestamp,
        });
      } else {
        this.insertConversationUpsert(tenant, conversationId, timestamp);
      }

      const recomputeJobId = randomUUID();
      this.database
        .prepare(
          `INSERT INTO conversation_maintenance_jobs (
             id, user_id, namespace, job_type, deletion_receipt_id,
             payload_json, status, attempts, max_attempts, available_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, 'memory_recompute', ?, ?, 'pending', 0, 5,
             ?, ?, ?)`,
        )
        .run(
          recomputeJobId,
          tenant.principalId,
          tenant.namespace,
          receiptId,
          JSON.stringify({ receiptId }),
          timestamp,
          timestamp,
          timestamp,
        );
      this.database
        .prepare(
          `INSERT INTO conversation_maintenance_jobs (
             id, user_id, namespace, job_type, deletion_receipt_id,
             payload_json, status, attempts, max_attempts, available_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, 'chat_purge', ?, ?, 'pending', 0, 5,
             ?, ?, ?)`,
        )
        .run(
          purgeJobId,
          tenant.principalId,
          tenant.namespace,
          receiptId,
          JSON.stringify({ receiptId, conversationId }),
          barrierExpiry,
          timestamp,
          timestamp,
        );
      receipt = this.database
        .prepare('SELECT * FROM conversation_deletion_receipts WHERE id = ?')
        .get(receiptId) as DatabaseRow;
    });
    if (!receipt) serviceError('CONVERSATION_NOT_FOUND');
    return this.deletionReceiptFromRow(receipt);
  }

  private invalidateLayeredMemoriesForDeletedTurns(
    tenant: ConversationTenant,
    turnIds: string[],
    timestamp: string,
  ): void {
    if (turnIds.length === 0) return;
    this.forIdChunks(turnIds, (ids, placeholders) => {
      this.database.prepare(
        `UPDATE memory_pattern_observations
         SET observation_state = CASE
               WHEN observation_state IN ('supporting', 'contradicting')
                 THEN 'superseded'
               ELSE observation_state
             END,
             excerpt = '[deleted]', updated_at = ?
         WHERE user_id = ? AND namespace = ?
           AND turn_id IN (${placeholders})`,
      ).run(
        timestamp,
        tenant.principalId,
        tenant.namespace,
        ...ids,
      );
      const episodes = this.database.prepare(
        `SELECT DISTINCT e.id, e.memory_id
         FROM conversation_episodes e
         WHERE e.user_id = ? AND e.namespace = ?
           AND e.status = 'active'
           AND (
             e.user_turn_id IN (${placeholders})
             OR e.assistant_turn_id IN (${placeholders})
           )`,
      ).all(
        tenant.principalId,
        tenant.namespace,
        ...ids,
        ...ids,
      ) as DatabaseRow[];
      if (episodes.length === 0) return;
      const episodeIds = episodes.map((row) => String(row.id));
      const episodeMemoryIds = episodes.map((row) => String(row.memory_id));
      const episodePlaceholders = episodeIds.map(() => '?').join(', ');
      const summaryRows = this.database.prepare(
        `SELECT DISTINCT summary.id, summary.memory_id
         FROM conversation_memory_summaries summary
         JOIN conversation_memory_summary_sources source
           ON source.summary_id = summary.id
         WHERE summary.user_id = ? AND summary.namespace = ?
           AND summary.status = 'active'
           AND source.episode_id IN (${episodePlaceholders})`,
      ).all(
        tenant.principalId,
        tenant.namespace,
        ...episodeIds,
      ) as DatabaseRow[];
      const summaryIds = summaryRows.map((row) => String(row.id));
      const summaryMemoryIds = summaryRows.map(
        (row) => String(row.memory_id),
      );

      this.database.prepare(
        `UPDATE conversation_episodes
         SET status = 'deleted', updated_at = ?
         WHERE id IN (${episodePlaceholders})`,
      ).run(timestamp, ...episodeIds);
      if (summaryIds.length > 0) {
        this.database.prepare(
          `UPDATE conversation_memory_summaries
           SET status = 'quarantined', updated_at = ?
           WHERE id IN (${summaryIds.map(() => '?').join(', ')})`,
        ).run(timestamp, ...summaryIds);
      }
      const allMemoryIds = [...new Set([
        ...episodeMemoryIds,
        ...summaryMemoryIds,
      ])];
      const memoryPlaceholders = allMemoryIds.map(() => '?').join(', ');
      this.database.prepare(
        `UPDATE memories
         SET status = 'archived', updated_at = ?
         WHERE user_id = ? AND namespace = ?
           AND id IN (${memoryPlaceholders})
           AND status = 'active'`,
      ).run(
        timestamp,
        tenant.principalId,
        tenant.namespace,
        ...allMemoryIds,
      );
      this.database.prepare(
        `UPDATE memory_items
         SET status = 'archived', archived_at = ?,
             archive_reason = 'conversation_source_deleted', updated_at = ?
         WHERE user_id = ? AND namespace = ?
           AND id IN (${memoryPlaceholders})
           AND status = 'active'`,
      ).run(
        timestamp,
        timestamp,
        tenant.principalId,
        tenant.namespace,
        ...allMemoryIds,
      );
      for (const [table, column] of [
        ['memory_embeddings', 'memory_id'],
        ['memory_ann_index', 'memory_id'],
        ['memory_term_index', 'memory_id'],
        ['memory_dense_lsh', 'memory_id'],
        ['memories_fts', 'memory_id'],
      ] as const) {
        this.database.prepare(
          `DELETE FROM ${table}
           WHERE ${column} IN (${memoryPlaceholders})`,
        ).run(...allMemoryIds);
      }
    });
  }

  private deletionReceiptFromRow(
    row: DatabaseRow,
  ): ConversationDeletionReceipt {
    return Object.freeze({
      id: String(row.id),
      resourceType: String(row.resource_type) as 'message' | 'conversation',
      resourceId: String(row.resource_id),
      conversationId: String(row.conversation_id),
      memoryPolicy: String(row.memory_policy) as ConversationMemoryPolicy,
      affectedMessageIds: parseStringArray(row.affected_message_ids_json),
      memoryActionRequestIds: parseStringArray(
        row.memory_action_request_ids_json,
      ),
      cancelledRoundIds: parseStringArray(row.cancelled_round_ids_json),
      purgeJobId: String(row.purge_job_id),
      status: 'accepted',
      createdAt: String(row.created_at),
    });
  }

  private rowsByIds(
    sqlTemplate: string,
    ids: readonly string[],
    tenant: ConversationTenant,
  ): DatabaseRow[] {
    const rows: DatabaseRow[] = [];
    this.forIdChunks(ids, (chunk, placeholders) => {
      rows.push(...this.database
        .prepare(sqlTemplate.replace('__IDS__', placeholders))
        .all(
          ...chunk,
          tenant.principalId,
          tenant.namespace,
        ) as DatabaseRow[]);
    });
    return rows;
  }

  private forIdChunks(
    ids: readonly string[],
    action: (chunk: readonly string[], placeholders: string) => void,
  ): void {
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      action(chunk, chunk.map(() => '?').join(', '));
    }
  }

  private applyDeletionMemoryPolicy(input: {
    readonly tenant: ConversationTenant;
    readonly receiptId: string;
    readonly turnRows: readonly DatabaseRow[];
    readonly memoryPolicy: ConversationMemoryPolicy;
    readonly timestamp: string;
  }): readonly string[] {
    const turnIds = input.turnRows.map((row) => String(row.id));
    if (turnIds.length === 0) return Object.freeze([]);
    const turnHashById = new Map(
      input.turnRows.map((row) => [
        String(row.id),
        String(row.content_hash ?? digest(String(row.content ?? ''))),
      ]),
    );
    const evidenceRows: DatabaseRow[] = [];
    this.forIdChunks(turnIds, (ids, placeholders) => {
      evidenceRows.push(...this.database
        .prepare(
          `SELECT e.*, v.memory_item_id, i.current_version_id
           FROM memory_evidence e
           JOIN memory_versions v ON v.id = e.memory_version_id
           JOIN memory_items i ON i.id = v.memory_item_id
           WHERE e.turn_id IN (${placeholders})
             AND i.user_id = ? AND i.namespace = ?`,
        )
        .all(
          ...ids,
          input.tenant.principalId,
          input.tenant.namespace,
        ) as DatabaseRow[]);
    });
    const proofType = input.memoryPolicy === 'retain_derived_memories'
      ? 'retained'
      : 'revoked';
    for (const evidence of evidenceRows) {
      const turnId = String(evidence.turn_id);
      this.database
        .prepare(
          `INSERT OR IGNORE INTO conversation_deleted_evidence_proofs (
             id, deletion_receipt_id, memory_version_id,
             former_turn_hash, proof_type, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.receiptId,
          String(evidence.memory_version_id),
          digest(`${turnId}:${turnHashById.get(turnId) ?? ''}`),
          proofType,
          input.timestamp,
        );
    }
    const affectedCurrentItemIds = [...new Set(
      evidenceRows
        .filter(
          (row) => row.memory_version_id === row.current_version_id,
        )
        .map((row) => String(row.memory_item_id)),
    )];

    this.forIdChunks(turnIds, (ids, placeholders) => {
      this.database
        .prepare(
          `DELETE FROM memory_candidates
           WHERE user_id = ? AND namespace = ?
             AND turn_id IN (${placeholders})`,
        )
        .run(
          input.tenant.principalId,
          input.tenant.namespace,
          ...ids,
        );
    });

    if (input.memoryPolicy === 'retain_derived_memories') {
      for (const evidence of evidenceRows) {
        this.database
          .prepare(
            `UPDATE memory_evidence
             SET turn_id = NULL, excerpt = NULL,
                 source_ref = ?, sensitivity = 'normal',
                 source_authority = 'direct_user'
             WHERE id = ?`,
          )
          .run(
            `deleted-proof:${input.receiptId}:${String(evidence.id)}`,
            String(evidence.id),
          );
      }
      return Object.freeze(affectedCurrentItemIds.map((memoryItemId) => {
        const actionId = randomUUID();
        const remainingEvidenceCount = Number(
          this.database
            .prepare(
              `SELECT COUNT(*) AS count FROM memory_evidence e
               JOIN memory_items i ON i.current_version_id = e.memory_version_id
               WHERE i.id = ?`,
            )
            .get(memoryItemId)?.count ?? 0,
        );
        this.database
          .prepare(
            `INSERT INTO conversation_memory_recomputations (
               id, deletion_receipt_id, memory_item_id, action, status,
               remaining_evidence_count, new_memory_version_id,
               created_at, updated_at, completed_at
             ) VALUES (?, ?, ?, 'retained', 'completed', ?, NULL, ?, ?, ?)`,
          )
          .run(
            actionId,
            input.receiptId,
            memoryItemId,
            remainingEvidenceCount,
            input.timestamp,
            input.timestamp,
            input.timestamp,
          );
        return actionId;
      }));
    }

    for (const evidence of evidenceRows) {
      this.database
        .prepare('DELETE FROM memory_evidence WHERE id = ?')
        .run(String(evidence.id));
    }
    return Object.freeze(affectedCurrentItemIds.map((memoryItemId) =>
      this.recomputeMemoryAfterEvidenceDeletion({
        tenant: input.tenant,
        receiptId: input.receiptId,
        memoryItemId,
        timestamp: input.timestamp,
      }),
    ));
  }

  private recomputeMemoryAfterEvidenceDeletion(input: {
    readonly tenant: ConversationTenant;
    readonly receiptId: string;
    readonly memoryItemId: string;
    readonly timestamp: string;
  }): string {
    const item = this.database
      .prepare(
        `SELECT i.*, m.content AS legacy_content,
                m.checksum AS legacy_checksum
         FROM memory_items i
         LEFT JOIN memories m ON m.id = i.id
         WHERE i.id = ? AND i.user_id = ? AND i.namespace = ?`,
      )
      .get(
        input.memoryItemId,
        input.tenant.principalId,
        input.tenant.namespace,
      ) as DatabaseRow | undefined;
    if (!item || !item.current_version_id) {
      throw new Error('MEMORY_RECOMPUTE_ITEM_MISSING');
    }
    const evidence = this.database
      .prepare(
        `SELECT * FROM memory_evidence
         WHERE memory_version_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(String(item.current_version_id)) as DatabaseRow[];
    const actionId = randomUUID();
    if (evidence.length === 0) {
      this.tombstoneMemoryItem(item, input.receiptId, input.timestamp);
      this.database
        .prepare(
          `INSERT INTO conversation_memory_recomputations (
             id, deletion_receipt_id, memory_item_id, action, status,
             remaining_evidence_count, new_memory_version_id,
             created_at, updated_at, completed_at
           ) VALUES (?, ?, ?, 'tombstoned', 'completed', 0, NULL, ?, ?, ?)`,
        )
        .run(
          actionId,
          input.receiptId,
          input.memoryItemId,
          input.timestamp,
          input.timestamp,
          input.timestamp,
        );
      return actionId;
    }

    const current = this.database
      .prepare('SELECT * FROM memory_versions WHERE id = ?')
      .get(String(item.current_version_id)) as DatabaseRow | undefined;
    if (!current) throw new Error('MEMORY_RECOMPUTE_VERSION_MISSING');
    const nextVersion = Number(
      this.database
        .prepare(
          `SELECT COALESCE(MAX(version), 0) + 1 AS version
           FROM memory_versions WHERE memory_item_id = ?`,
        )
        .get(input.memoryItemId)?.version ?? 1,
    );
    const newVersionId = randomUUID();
    this.database
      .prepare(
        `UPDATE memory_versions SET superseded_at = ? WHERE id = ?`,
      )
      .run(input.timestamp, String(current.id));
    this.database
      .prepare(
        `INSERT INTO memory_versions (
           id, memory_item_id, version, title, content, summary, tags_json,
           importance, confidence, source, source_ref, occurred_at,
           valid_from, valid_to, created_by, created_at, superseded_at,
           predicate_key, namespace, kind, normalized_value_hash,
           normalized_value, predicate_cardinality, scope_type, scope_key,
           sensitivity, source_authority, negated
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, 'conversation_delete_recompute', ?,
           ?, ?, ?, 'conversation-delete', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?
         )`,
      )
      .run(
        newVersionId,
        input.memoryItemId,
        nextVersion,
        String(current.title),
        String(current.content),
        String(current.summary ?? ''),
        String(current.tags_json ?? '[]'),
        Number(current.importance),
        Number(current.confidence),
        input.receiptId,
        nullableText(current.occurred_at),
        nullableText(current.valid_from),
        nullableText(current.valid_to),
        input.timestamp,
        nullableText(current.predicate_key),
        nullableText(current.namespace) ?? input.tenant.namespace,
        nullableText(current.kind) ?? String(item.kind),
        nullableText(current.normalized_value_hash),
        nullableText(current.normalized_value),
        nullableText(current.predicate_cardinality),
        nullableText(current.scope_type) ?? String(item.scope_type),
        nullableText(current.scope_key) ?? String(item.scope_key),
        nullableText(current.sensitivity) ?? 'normal',
        nullableText(current.source_authority) ?? 'legacy_unknown',
        Number(current.negated ?? 0),
      );
    for (const source of evidence) {
      this.database
        .prepare(
          `INSERT INTO memory_evidence (
             id, memory_version_id, turn_id, evidence_type, excerpt,
             source_ref, created_at, sensitivity, source_authority
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          newVersionId,
          nullableText(source.turn_id),
          String(source.evidence_type),
          nullableText(source.excerpt),
          nullableText(source.source_ref),
          input.timestamp,
          nullableText(source.sensitivity) ?? 'normal',
          nullableText(source.source_authority) ?? 'legacy_unknown',
        );
    }
    this.database
      .prepare(
        `UPDATE memory_items
         SET current_version_id = ?, revision = revision + 1,
             status = 'active', updated_at = ?
         WHERE id = ?`,
      )
      .run(newVersionId, input.timestamp, input.memoryItemId);
    this.database
      .prepare(
        `UPDATE memories SET status = 'active', updated_at = ?
         WHERE id = ?`,
      )
      .run(input.timestamp, input.memoryItemId);
    this.database
      .prepare(
        `INSERT INTO memory_events (
           id, memory_item_id, user_id, event_type, payload_json, created_at
         ) VALUES (?, ?, ?, 'evidence_recomputed', ?, ?)`,
      )
      .run(
        randomUUID(),
        input.memoryItemId,
        input.tenant.principalId,
        JSON.stringify({ deletionReceiptId: input.receiptId }),
        input.timestamp,
      );
    this.database
      .prepare(
        `INSERT INTO conversation_memory_recomputations (
           id, deletion_receipt_id, memory_item_id, action, status,
           remaining_evidence_count, new_memory_version_id,
           created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, 'recomputed', 'completed', ?, ?, ?, ?, ?)`,
      )
      .run(
        actionId,
        input.receiptId,
        input.memoryItemId,
        evidence.length,
        newVersionId,
        input.timestamp,
        input.timestamp,
        input.timestamp,
      );
    return actionId;
  }

  private tombstoneMemoryItem(
    item: DatabaseRow,
    receiptId: string,
    timestamp: string,
  ): void {
    const content = String(item.legacy_content ?? '');
    const identity = tombstoneIdentityFields({
      kind: String(item.kind) as Parameters<
        typeof tombstoneIdentityFields
      >[0]['kind'],
      content,
      stableKey: nullableText(item.stable_key),
      normalizedKey: nullableText(item.predicate_key),
      normalizedValue: nullableText(item.normalized_value),
      scopeType: String(item.scope_type) as Parameters<
        typeof tombstoneIdentityFields
      >[0]['scopeType'],
      scopeKey: String(item.scope_key),
    });
    const existing = this.database
      .prepare(
        `SELECT id FROM memory_tombstones
         WHERE user_id = ? AND namespace = ? AND memory_item_id = ?
           AND restored_at IS NULL
         ORDER BY deletion_generation DESC LIMIT 1`,
      )
      .get(String(item.user_id), String(item.namespace), String(item.id));
    if (!existing) {
      const generation = Number(
        this.database
          .prepare(
            `SELECT COALESCE(MAX(deletion_generation), 0) + 1 AS generation
             FROM memory_tombstones
             WHERE user_id = ? AND memory_item_id = ?`,
          )
          .get(String(item.user_id), String(item.id))?.generation ?? 1,
      );
      this.database
        .prepare(
          `INSERT INTO memory_tombstones (
             id, user_id, namespace, stable_key, content_hash, reason,
             created_at, scope_type, scope_key, memory_item_id,
             deletion_generation, kind, normalized_key, normalized_value,
             semantic_fingerprint
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          String(item.user_id),
          String(item.namespace),
          nullableText(item.stable_key),
          identity.contentHash,
          `conversation-delete:${receiptId}`,
          timestamp,
          String(item.scope_type),
          String(item.scope_key),
          String(item.id),
          generation,
          identity.kind,
          identity.normalizedKey,
          identity.normalizedValue,
          identity.semanticFingerprint,
        );
    }
    this.database
      .prepare(
        `UPDATE memory_items
         SET status = 'deleted', revision = revision + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(timestamp, String(item.id));
    this.database
      .prepare(
        `UPDATE memories
         SET status = 'deleted', deleted_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(timestamp, timestamp, String(item.id));
  }

  private cancelDeletedTurnWork(
    tenant: ConversationTenant,
    turnIds: readonly string[],
    timestamp: string,
  ): void {
    this.forIdChunks(turnIds, (ids, placeholders) => {
      this.database
        .prepare(
          `UPDATE outbox_events
           SET status = 'completed', payload_json = ?, lease_until = NULL,
               last_error = NULL, processed_at = ?
           WHERE user_id = ? AND namespace = ?
             AND aggregate_id IN (${placeholders})
             AND status IN ('pending', 'processing', 'failed')`,
        )
        .run(
          JSON.stringify({ cancelled: 'source_deleted' }),
          timestamp,
          tenant.principalId,
          tenant.namespace,
          ...ids,
        );
      this.database
        .prepare(
          `UPDATE extraction_runs
           SET status = 'failed', completed_at = ?, error = 'source_deleted'
           WHERE turn_id IN (${placeholders})
             AND status IN ('queued', 'running')`,
        )
        .run(timestamp, ...ids);
      this.database
        .prepare(
          `UPDATE memory_jobs
           SET status = 'completed', lease_owner = NULL, lease_until = NULL,
               last_error = NULL, updated_at = ?
           WHERE user_id = ? AND namespace = ?
             AND status IN ('pending', 'running', 'failed')
             AND json_extract(payload_json, '$.turnId')
               IN (${placeholders})`,
        )
        .run(
          timestamp,
          tenant.principalId,
          tenant.namespace,
          ...ids,
        );
    });
  }

  private processMaintenanceJob(
    job: DatabaseRow,
    timestamp: string,
  ): void {
    const jobId = String(job.id);
    const claimed = this.database
      .prepare(
        `UPDATE conversation_maintenance_jobs
         SET status = 'running', attempts = attempts + 1,
             lease_until = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'failed')
           AND attempts < max_attempts`,
      )
      .run(
        this.timestampAfter(timestamp, this.roundLeaseMs),
        timestamp,
        jobId,
      );
    if (Number(claimed.changes) !== 1) return;
    if (job.job_type === 'memory_recompute') {
      const rows = this.database
        .prepare(
          `SELECT r.*, i.status AS item_status, m.status AS memory_status
           FROM conversation_memory_recomputations r
           JOIN memory_items i ON i.id = r.memory_item_id
           LEFT JOIN memories m ON m.id = i.id
           WHERE r.deletion_receipt_id = ?`,
        )
        .all(String(job.deletion_receipt_id)) as DatabaseRow[];
      const invalid = rows.some((row) =>
        (row.action === 'tombstoned' &&
          (row.item_status !== 'deleted' || row.memory_status !== 'deleted')) ||
        (row.action === 'recomputed' && row.item_status !== 'active'),
      );
      if (invalid) throw new Error('MEMORY_RECOMPUTE_INVARIANT_FAILED');
      const deletedIds = rows
        .filter((row) => row.action === 'tombstoned')
        .map((row) => String(row.memory_item_id));
      this.forIdChunks(deletedIds, (ids, placeholders) => {
        this.database
          .prepare(
            `DELETE FROM memory_edges
             WHERE from_memory_item_id IN (${placeholders})
                OR to_memory_item_id IN (${placeholders})`,
          )
          .run(...ids, ...ids);
        this.database
          .prepare(
            `DELETE FROM memory_relations
             WHERE from_memory_id IN (${placeholders})
                OR to_memory_id IN (${placeholders})`,
          )
          .run(...ids, ...ids);
        for (const table of [
          'memories_fts',
          'memory_ann_index',
          'memory_term_index',
          'memory_dense_lsh',
        ]) {
          this.database
            .prepare(
              `DELETE FROM ${table} WHERE memory_id IN (${placeholders})`,
            )
            .run(...ids);
        }
      });
    } else if (job.job_type === 'chat_purge') {
      const receipt = this.database
        .prepare(
          `SELECT * FROM conversation_deletion_receipts WHERE id = ?`,
        )
        .get(String(job.deletion_receipt_id)) as DatabaseRow | undefined;
      if (!receipt) throw new Error('CHAT_PURGE_RECEIPT_MISSING');
      const messageIds = parseStringArray(receipt.affected_message_ids_json);
      this.forIdChunks(messageIds, (ids, placeholders) => {
        this.database
          .prepare(
            `DELETE FROM conversation_message_actions
             WHERE message_id IN (${placeholders})`,
          )
          .run(...ids);
        this.database
          .prepare(
            `UPDATE conversation_turns
             SET content = '[deleted]', display_content = '[deleted]',
                 normalized_content = NULL
             WHERE id IN (${placeholders}) AND message_status = 'deleted'`,
          )
          .run(...ids);
      });
    } else {
      throw new Error('UNSUPPORTED_CONVERSATION_MAINTENANCE_JOB');
    }
    this.database
      .prepare(
        `UPDATE conversation_maintenance_jobs
         SET status = 'completed', lease_until = NULL,
             last_error_code = NULL, updated_at = ?, completed_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(timestamp, timestamp, jobId);
  }

  private cleanTenant(input: ConversationTenant): ConversationTenant {
    return Object.freeze({
      principalId: cleanRequired(input.principalId),
      namespace: cleanRequired(input.namespace),
    });
  }

  private timestamp(): string {
    const value = this.now();
    const timestamp = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(timestamp.getTime())) serviceError('INVALID_REQUEST');
    return timestamp.toISOString();
  }

  private nowMilliseconds(): number {
    return new Date(this.timestamp()).getTime();
  }

  private inImmediate<T>(action: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private inReadTransaction<T>(action: () => T): T {
    if (this.database.isTransaction) return action();
    this.database.exec('BEGIN DEFERRED');
    try {
      const result = action();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private currentChangeSequence(tenant: ConversationTenant): number {
    return Number(
      this.database
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) AS sequence
           FROM conversation_changes
           WHERE user_id = ? AND namespace = ?`,
        )
        .get(tenant.principalId, tenant.namespace)?.sequence ?? 0,
    );
  }

  private insertChange(input: {
    readonly tenant: ConversationTenant;
    readonly type: ConversationChangeType;
    readonly conversationId: string;
    readonly resourceId: string;
    readonly resourceVersion: number;
    readonly resource: Readonly<Record<string, unknown>> | null;
    readonly tombstone?: boolean;
    readonly timestamp: string;
  }): number {
    const tombstone = input.tombstone === true;
    const result = this.database
      .prepare(
        `INSERT INTO conversation_changes (
           user_id, namespace, event_type, conversation_id,
           resource_id, resource_version, occurred_at, tombstone,
           resource_json, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tenant.principalId,
        input.tenant.namespace,
        input.type,
        input.conversationId,
        input.resourceId,
        input.resourceVersion,
        input.timestamp,
        tombstone ? 1 : 0,
        tombstone ? null : JSON.stringify(input.resource),
        this.timestampAfter(input.timestamp, CHANGE_RETENTION_MS),
      );
    return Number(result.lastInsertRowid);
  }

  private insertConversationUpsert(
    tenant: ConversationTenant,
    conversationId: string,
    timestamp: string,
  ): void {
    const conversation = conversationFromRow(
      this.requireConversationRow(tenant, conversationId),
    );
    this.insertChange({
      tenant,
      type: 'conversation.upsert',
      conversationId,
      resourceId: conversationId,
      resourceVersion: conversation.version,
      resource: Object.freeze({ ...conversation }),
      timestamp,
    });
  }

  private changeFromRow(row: DatabaseRow): ConversationChange {
    const tombstone = Number(row.tombstone) === 1;
    let resource: Readonly<Record<string, unknown>> | null = null;
    if (!tombstone) {
      try {
        const parsed = JSON.parse(String(row.resource_json)) as unknown;
        if (!isRecord(parsed)) serviceError('INVALID_CURSOR');
        resource = Object.freeze({ ...parsed });
      } catch {
        serviceError('INVALID_CURSOR');
      }
    }
    return Object.freeze({
      sequence: Number(row.sequence),
      type: String(row.event_type) as ConversationChangeType,
      conversationId: String(row.conversation_id),
      resourceId: String(row.resource_id),
      resourceVersion: Number(row.resource_version),
      occurredAt: String(row.occurred_at),
      tombstone,
      resource,
    });
  }

  private isoTimestamp(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
      serviceError('INVALID_REQUEST');
    }
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) serviceError('INVALID_REQUEST');
    return parsed.toISOString();
  }

  private timestampAfter(timestamp: string, durationMs: number): string {
    const value = new Date(timestamp).getTime() + durationMs;
    if (!Number.isFinite(value)) serviceError('INVALID_REQUEST');
    return new Date(value).toISOString();
  }

  private nextMessageSequence(conversationId: string): number {
    return Number(
      this.database
        .prepare(
          `SELECT COALESCE(MAX(message_sequence), 0) + 1 AS sequence
           FROM conversation_turns WHERE session_id = ?`,
        )
        .get(conversationId)?.sequence ?? 1,
    );
  }

  private assertNoOtherRoundInProgress(
    conversationId: string,
    excludedRoundId: string | null,
  ): void {
    const row = this.database
      .prepare(
        `SELECT id FROM conversation_rounds
         WHERE conversation_id = ?
           AND status IN (
             'accepted', 'understanding', 'recalling', 'generating'
           )
           AND (? IS NULL OR id != ?)
         LIMIT 1`,
      )
      .get(conversationId, excludedRoundId, excludedRoundId);
    if (row) serviceError('ROUND_IN_PROGRESS');
  }

  private insertRoundAttempt(input: {
    readonly id: string;
    readonly roundId: string;
    readonly attemptNumber: number;
    readonly attemptType: 'initial' | 'retry' | 'regenerate';
    readonly requestId: string;
    readonly generation: number;
    readonly timestamp: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO conversation_round_attempts (
           id, round_id, attempt_number, attempt_type, status,
           lease_owner, lease_expires_at, heartbeat_at, request_id,
           generation, started_at, updated_at, ended_at
         ) VALUES (
           ?, ?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?, ?, NULL
         )`,
      )
      .run(
        input.id,
        input.roundId,
        input.attemptNumber,
        input.attemptType,
        this.instanceId,
        this.timestampAfter(input.timestamp, this.roundLeaseMs),
        input.timestamp,
        input.requestId,
        input.generation,
        input.timestamp,
        input.timestamp,
      );
  }

  private insertRoundEvent(input: {
    readonly roundId: string;
    readonly attemptId: string | null;
    readonly requestId: string;
    readonly type: ConversationRoundEventType;
    readonly data: Readonly<Record<string, unknown>>;
    readonly containsBody: boolean;
    readonly timestamp: string;
  }): void {
    const sequence = Number(
      this.database
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
           FROM conversation_round_events WHERE round_id = ?`,
        )
        .get(input.roundId)?.sequence ?? 1,
    );
    this.database
      .prepare(
        `INSERT INTO conversation_round_events (
           round_id, sequence, event_id, attempt_id, request_id,
           event_type, data_json, contains_body, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.roundId,
        sequence,
        `${input.roundId}:${sequence}`,
        input.attemptId,
        input.requestId,
        input.type,
        JSON.stringify(input.data),
        input.containsBody ? 1 : 0,
        input.timestamp,
        this.timestampAfter(input.timestamp, this.roundEventRetentionMs),
      );
  }

  private requireMessageRowById(
    tenant: ConversationTenant,
    conversationId: string,
    messageId: string,
  ): DatabaseRow {
    const row = this.database
      .prepare(
        `SELECT t.* FROM conversation_turns t
         JOIN conversation_sessions s ON s.id = t.session_id
         WHERE t.id = ? AND t.session_id = ?
           AND t.user_id = ? AND t.namespace = ?
           AND s.user_id = t.user_id AND s.namespace = t.namespace
           AND s.status != 'deleted'`,
      )
      .get(
        messageId,
        conversationId,
        tenant.principalId,
        tenant.namespace,
      ) as DatabaseRow | undefined;
    if (!row) serviceError('ROUND_NOT_FOUND');
    return row;
  }

  private requireRoundRow(
    tenant: ConversationTenant,
    conversationId: string,
    roundId: string,
  ): DatabaseRow {
    const row = this.database
      .prepare(
        `SELECT r.* FROM conversation_rounds r
         JOIN conversation_sessions s ON s.id = r.conversation_id
         WHERE r.id = ? AND r.conversation_id = ?
           AND r.user_id = ? AND r.namespace = ?
           AND s.user_id = r.user_id AND s.namespace = r.namespace
           AND s.status != 'deleted' AND r.status != 'deleted'`,
      )
      .get(
        roundId,
        conversationId,
        tenant.principalId,
        tenant.namespace,
      ) as DatabaseRow | undefined;
    if (!row) serviceError('ROUND_NOT_FOUND');
    return row;
  }

  private requireCurrentAttempt(round: DatabaseRow): DatabaseRow {
    if (!round.current_attempt_id) serviceError('ROUND_NOT_FOUND');
    const row = this.database
      .prepare(
        `SELECT * FROM conversation_round_attempts
         WHERE id = ? AND round_id = ?`,
      )
      .get(String(round.current_attempt_id), String(round.id)) as
      | DatabaseRow
      | undefined;
    if (!row) serviceError('ROUND_NOT_FOUND');
    return row;
  }

  private roundFromRow(
    tenant: ConversationTenant,
    row: DatabaseRow,
  ): ConversationRound {
    const conversationId = String(row.conversation_id);
    const userMessage = this.messageFromRow(
      this.requireMessageRowById(
        tenant,
        conversationId,
        String(row.user_message_id),
      ),
    );
    const assistantMessage = row.active_assistant_message_id
      ? this.messageFromRow(
          this.requireMessageRowById(
            tenant,
            conversationId,
            String(row.active_assistant_message_id),
          ),
        )
      : null;
    const attemptRow = row.current_attempt_id
      ? this.requireCurrentAttempt(row)
      : null;
    const currentAttempt = attemptRow
      ? Object.freeze({
          id: String(attemptRow.id),
          attemptNumber: Number(attemptRow.attempt_number),
          type: String(attemptRow.attempt_type) as
            ConversationRoundAttempt['type'],
          status: String(attemptRow.status) as
            ConversationRoundAttempt['status'],
          requestId: String(attemptRow.request_id),
          generation: Number(attemptRow.generation),
          startedAt: String(attemptRow.started_at),
          updatedAt: String(attemptRow.updated_at),
          endedAt: nullableText(attemptRow.ended_at),
        })
      : null;
    const failure = row.failure_code
      ? Object.freeze({
          code: String(row.failure_code),
          message: String(row.failure_message ?? ''),
          retryable: Number(row.failure_retryable) === 1,
          stage: String(row.failure_stage ?? ''),
        })
      : null;
    return Object.freeze({
      id: String(row.id),
      conversationId,
      clientMessageId: String(row.client_message_id),
      status: String(row.status) as ConversationRoundStatus,
      personaProfileVersionUsed: Number(row.persona_profile_version_used),
      generation: Number(row.generation),
      userMessage,
      assistantMessage,
      currentAttempt,
      failure,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: nullableText(row.completed_at),
    });
  }

  private roundEventFromRow(row: DatabaseRow): ConversationRoundEvent {
    let data: unknown;
    try {
      data = JSON.parse(String(row.data_json));
    } catch {
      serviceError('INVALID_EVENT_CURSOR');
    }
    if (!isRecord(data)) serviceError('INVALID_EVENT_CURSOR');
    return Object.freeze({
      id: String(row.event_id),
      sequence: Number(row.sequence),
      type: String(row.event_type) as ConversationRoundEventType,
      data: Object.freeze({ ...data }),
      createdAt: String(row.created_at),
    });
  }

  private roundExecutionContext(
    tenant: ConversationTenant,
    conversationId: string,
    roundId: string,
  ): ConversationRoundExecutionContext {
    const round = this.requireRoundRow(tenant, conversationId, roundId);
    const attempt = this.requireCurrentAttempt(round);
    if (
      attempt.status !== 'running' ||
      attempt.lease_owner !== this.instanceId ||
      Number(attempt.generation) !== Number(round.generation)
    ) {
      serviceError('ROUND_IN_PROGRESS');
    }
    const conversationRow = this.requireConversationRow(
      tenant,
      conversationId,
    );
    const profile = this.getChatProfile(
      tenant,
      String(conversationRow.persona_id),
      Number(round.persona_profile_version_used),
    );
    const userRow = this.requireMessageRowById(
      tenant,
      conversationId,
      String(round.user_message_id),
    );
    const rows = this.database
      .prepare(
        `SELECT * FROM conversation_turns
         WHERE session_id = ? AND user_id = ? AND namespace = ?
           AND message_sequence <= ? AND message_status = 'completed'
           AND is_active_variant = 1 AND role IN ('user', 'assistant')
         ORDER BY message_sequence ASC`,
      )
      .all(
        conversationId,
        tenant.principalId,
        tenant.namespace,
        Number(userRow.message_sequence),
      ) as DatabaseRow[];
    const messages: Array<Readonly<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }>> = [];
    if (profile.systemPrompt.trim()) {
      messages.push(Object.freeze({
        role: 'system',
        content: profile.systemPrompt,
      }));
    }
    for (const message of rows) {
      messages.push(Object.freeze({
        role: String(message.role) as 'user' | 'assistant',
        content: String(message.display_content ?? message.content),
      }));
    }
    return Object.freeze({
      roundId,
      attemptId: String(attempt.id),
      requestId: String(attempt.request_id),
      generation: Number(round.generation),
      tenant,
      conversation: conversationFromRow(conversationRow),
      personaId: String(conversationRow.persona_id),
      projectId: nullableText(conversationRow.project_id),
      profile,
      messages: Object.freeze(messages),
    });
  }

  private requirePrincipal(principalId: string): void {
    if (
      !this.database
        .prepare(
          `SELECT 1 FROM account_principals
           WHERE id = ? AND status = 'active'`,
        )
        .get(principalId)
    ) {
      serviceError('PERSONA_NOT_FOUND');
    }
  }

  private requirePersona(
    tenant: ConversationTenant,
    personaId: string,
  ): void {
    if (
      !this.database
        .prepare(
          `SELECT 1 FROM client_persona_bindings b
           JOIN account_principals p ON p.id = b.principal_id
           WHERE b.principal_id = ? AND b.persona_id = ?
             AND b.status = 'active' AND p.status = 'active'
           LIMIT 1`,
        )
        .get(tenant.principalId, personaId)
    ) {
      serviceError('PERSONA_NOT_FOUND');
    }
  }

  private requireProject(
    tenant: ConversationTenant,
    projectId: string,
  ): ProjectBinding {
    const row = this.database
      .prepare(
        `SELECT * FROM conversation_project_bindings
         WHERE principal_id = ? AND namespace = ?
           AND external_project_id = ? AND status = 'active'`,
      )
      .get(
        tenant.principalId,
        tenant.namespace,
        projectId,
      ) as DatabaseRow | undefined;
    if (!row) serviceError('PROJECT_NOT_FOUND');
    return projectFromRow(row);
  }

  private requireConversationRow(
    tenant: ConversationTenant,
    conversationId: string,
  ): DatabaseRow {
    const row = this.database
      .prepare(
        `SELECT * FROM conversation_sessions
         WHERE id = ? AND user_id = ? AND namespace = ?
           AND status != 'deleted'`,
      )
      .get(
        conversationId,
        tenant.principalId,
        tenant.namespace,
      ) as DatabaseRow | undefined;
    if (!row) serviceError('CONVERSATION_NOT_FOUND');
    return row;
  }

  private findMessageByClientId(
    tenant: ConversationTenant,
    conversationId: string,
    clientMessageId: string,
  ): DatabaseRow | undefined {
    return this.database
      .prepare(
        `SELECT t.* FROM conversation_turns t
         JOIN conversation_sessions s ON s.id = t.session_id
         WHERE t.session_id = ? AND t.client_message_id = ?
           AND t.user_id = ? AND t.namespace = ?
           AND s.user_id = t.user_id AND s.namespace = t.namespace
           AND s.status != 'deleted'`,
      )
      .get(
        conversationId,
        clientMessageId,
        tenant.principalId,
        tenant.namespace,
      ) as DatabaseRow | undefined;
  }

  private authorizeActions(
    conversation: DatabaseRow,
    actions: readonly AssistantAction[],
  ): void {
    this.authorizeActionsForProfile(
      String(conversation.user_id),
      String(conversation.persona_id),
      Number(conversation.persona_profile_version),
      actions,
    );
  }

  private authorizeActionsForProfile(
    principalId: string,
    personaId: string,
    profileVersion: number,
    actions: readonly AssistantAction[],
  ): void {
    if (actions.length === 0) return;
    const profile = this.database
      .prepare(
        `SELECT capability_ids_json FROM persona_chat_profiles
         WHERE principal_id = ? AND persona_id = ?
           AND profile_version = ?`,
      )
      .get(
        principalId,
        personaId,
        profileVersion,
      );
    if (!profile) serviceError('PERSONA_PROFILE_NOT_FOUND');
    const capabilities = new Set(
      parseStringArray(profile.capability_ids_json),
    );
    if (
      actions.some(
        (action) => !capabilities.has(ACTION_CAPABILITY[action.type]),
      )
    ) {
      throw new AssistantProtocolQuarantineError('unauthorized_action');
    }
  }

  private messageFromRow(row: DatabaseRow): ConversationMessage {
    const actionRows = this.database
      .prepare(
        `SELECT * FROM conversation_message_actions
         WHERE message_id = ? ORDER BY action_index ASC`,
      )
      .all(String(row.id)) as DatabaseRow[];
    const actions = actionRows.map((action): MessageAction => {
      const payload = JSON.parse(String(action.payload_json)) as {
        name: string;
      };
      return Object.freeze({
        id: String(action.id),
        type: String(action.action_type) as AssistantActionType,
        payload: Object.freeze({ name: String(payload.name) }),
      });
    });
    return Object.freeze({
      id: String(row.id),
      conversationId: String(row.session_id),
      sequence: Number(row.message_sequence),
      role: String(row.role) as ConversationMessage['role'],
      displayContent: String(row.display_content ?? row.content),
      actions: Object.freeze(actions),
      attachments: Object.freeze([]),
      status: 'completed',
      generationGroupId: nullableText(row.generation_group_id),
      variantIndex: Number(row.variant_index),
      isActiveVariant: Number(row.is_active_variant) === 1,
      createdAt: String(row.created_at),
      completedAt: String(row.completed_at ?? row.created_at),
      version: Number(row.message_version),
    });
  }

  private ensureCursorKey(): void {
    if (
      this.database
        .prepare(
          `SELECT 1 FROM conversation_cursor_keys
           WHERE status = 'current'`,
        )
        .get()
    ) {
      return;
    }
    const timestamp = this.timestamp();
    this.inImmediate(() => {
      if (
        !this.database
          .prepare(
            `SELECT 1 FROM conversation_cursor_keys
             WHERE status = 'current'`,
          )
          .get()
      ) {
        this.database
          .prepare(
            `INSERT INTO conversation_cursor_keys (
               secret, status, created_at, retired_at
             ) VALUES (?, 'current', ?, NULL)`,
          )
          .run(randomBytes(32), timestamp);
      }
    });
  }

  private encodeCursor(input: {
    readonly tenant: ConversationTenant;
    readonly route: CursorPayload['r'];
    readonly filters: string;
    readonly conversationId: string | null;
    readonly anchor: unknown;
    readonly snapshot: unknown;
    readonly ttlMs?: number;
  }): string {
    const key = this.database
      .prepare(
        `SELECT key_version, secret FROM conversation_cursor_keys
         WHERE status = 'current'`,
      )
      .get() as DatabaseRow | undefined;
    if (!key) serviceError('INVALID_CURSOR');
    const payload: CursorPayload = {
      v: 1,
      k: Number(key.key_version),
      p: input.tenant.principalId,
      n: input.tenant.namespace,
      r: input.route,
      f: input.filters,
      c: input.conversationId,
      a: input.anchor,
      s: input.snapshot,
      e: this.nowMilliseconds() + (input.ttlMs ?? this.cursorTtlMs),
    };
    const encodedPayload = Buffer.from(
      JSON.stringify(payload),
      'utf8',
    ).toString('base64url');
    const mac = createHmac('sha256', Buffer.from(key.secret as Uint8Array))
      .update(encodedPayload)
      .digest('base64url');
    return `${encodedPayload}.${mac}`;
  }

  private decodeCursor(
    cursor: string,
    expected: {
      readonly tenant: ConversationTenant;
      readonly route: CursorPayload['r'];
      readonly filters: string;
      readonly conversationId: string | null;
    },
  ): CursorPayload {
    try {
      const segments = cursor.split('.');
      if (
        segments.length !== 2 ||
        !segments[0] ||
        !segments[1] ||
        !/^[A-Za-z0-9_-]+$/u.test(segments[0]) ||
        !/^[A-Za-z0-9_-]+$/u.test(segments[1])
      ) {
        serviceError('INVALID_CURSOR');
      }
      const payloadBuffer = Buffer.from(segments[0], 'base64url');
      const mac = Buffer.from(segments[1], 'base64url');
      if (
        payloadBuffer.toString('base64url') !== segments[0] ||
        mac.toString('base64url') !== segments[1] ||
        mac.length !== 32
      ) {
        serviceError('INVALID_CURSOR');
      }
      const parsed = JSON.parse(payloadBuffer.toString('utf8')) as unknown;
      if (!isRecord(parsed) || parsed.v !== 1) {
        serviceError('INVALID_CURSOR');
      }
      const keyVersion = parsed.k;
      if (
        typeof keyVersion !== 'number' ||
        !Number.isSafeInteger(keyVersion) ||
        keyVersion < 1
      ) {
        serviceError('INVALID_CURSOR');
      }
      const key = this.database
        .prepare(
          `SELECT secret FROM conversation_cursor_keys
           WHERE key_version = ? AND status IN ('current', 'previous')`,
        )
        .get(keyVersion) as DatabaseRow | undefined;
      const secret = key?.secret
        ? Buffer.from(key.secret as Uint8Array)
        : Buffer.alloc(32);
      const expectedMac = createHmac('sha256', secret)
        .update(segments[0])
        .digest();
      const signatureMatches = timingSafeEqual(expectedMac, mac);
      if (!key || !signatureMatches) serviceError('INVALID_CURSOR');
      if (
        parsed.p !== expected.tenant.principalId ||
        parsed.n !== expected.tenant.namespace ||
        parsed.r !== expected.route ||
        parsed.f !== expected.filters ||
        parsed.c !== expected.conversationId ||
        typeof parsed.e !== 'number' ||
        !Number.isSafeInteger(parsed.e)
      ) {
        serviceError('INVALID_CURSOR');
      }
      if (parsed.e <= this.nowMilliseconds()) {
        if (expected.route === 'change-list') {
          serviceError('SYNC_CURSOR_EXPIRED');
        }
        serviceError('INVALID_CURSOR');
      }
      return parsed as unknown as CursorPayload;
    } catch (error) {
      if (
        error instanceof ConversationServiceError &&
        error.code === 'SYNC_CURSOR_EXPIRED'
      ) {
        throw error;
      }
      serviceError('INVALID_CURSOR');
    }
  }

  private cursorPoint(value: unknown): ConversationCursorPoint {
    if (
      !isRecord(value) ||
      typeof value.sortAt !== 'string' ||
      !Number.isFinite(Date.parse(value.sortAt)) ||
      typeof value.id !== 'string' ||
      !value.id
    ) {
      serviceError('INVALID_CURSOR');
    }
    return { sortAt: value.sortAt, id: value.id };
  }
}
