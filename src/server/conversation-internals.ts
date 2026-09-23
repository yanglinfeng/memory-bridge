/**
 * 会话服务的模块私有地基层。
 *
 * 从 conversation-service.ts 原样搬出（零逻辑改写）。
 * 仅 conversation-service.ts 内部使用，不属于公开契约。
 */
import { createHash } from 'node:crypto';
import { ConversationServiceErrorCode, ConversationServiceError, Conversation, ProjectBinding } from './conversation-types.js';
import { AssistantActionType } from './assistant-protocol.js';

export type DatabaseRow = Record<string, unknown>;
export type SqlValue = string | number | bigint | Uint8Array | null;

export interface CursorPayload {
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

export interface ConversationCursorPoint {
  readonly sortAt: string;
  readonly id: string;
}

export interface NormalizedImportMessage {
  readonly externalMessageId: string;
  readonly externalRoundId: string;
  readonly role: 'user' | 'assistant';
  readonly displayContent: string;
  readonly occurredAt: string;
  readonly payloadHash: string;
}

export interface NormalizedImportConversation {
  readonly externalSessionId: string;
  readonly personaId: string;
  readonly projectId: string | null;
  readonly title: string | null;
  readonly payloadHash: string;
  readonly messages: readonly NormalizedImportMessage[];
}

export interface MutableImportCounter {
  created: number;
  matched: number;
  conflicted: number;
  skipped: number;
}

export const CURSOR_TTL_MS = 24 * 60 * 60 * 1_000;
export const CHANGE_CURSOR_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const CHANGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const ROUND_LEASE_MS = 120 * 1_000;
export const ROUND_EVENT_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const ALLOWED_CAPABILITIES = new Set([
  'emotion.basic',
  'motion.basic',
]);
export const ACTION_CAPABILITY: Readonly<Record<AssistantActionType, string>> = {
  emotion: 'emotion.basic',
  motion: 'motion.basic',
};

export function serviceError(code: ConversationServiceErrorCode): never {
  throw new ConversationServiceError(code);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasOnlyFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const fields = new Set(allowed);
  return Object.keys(value).every((field) => fields.has(field));
}

export function cleanRequired(
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

export function cleanText(
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

export function cleanNullableTitle(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const title = cleanText(value, 500).trim();
  return title || null;
}

export function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

export function integer(
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

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function parseStringArray(value: unknown): readonly string[] {
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

export function conversationFromRow(row: DatabaseRow): Conversation {
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

export function projectFromRow(row: DatabaseRow): ProjectBinding {
  return Object.freeze({
    projectId: String(row.external_project_id),
    displayName: String(row.display_name),
    status: String(row.status) as ProjectBinding['status'],
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
}
