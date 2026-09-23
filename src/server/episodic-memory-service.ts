import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  REDACTED_ASSISTANT_CREDENTIAL,
} from './assistant-protocol.js';
import { embedText, vectorToBuffer } from './embedding.js';
import {
  containsCredentialSecret,
} from './memory-extractor.js';
import { MemoryJournal } from './memory-journal.js';
import { canonicalContentHash } from './tombstone-policy.js';
import type { MemoryRecord, MemoryScopeType } from './types.js';

type DatabaseRow = Record<string, unknown>;

export interface MaterializeEpisodeInput {
  readonly userId: string;
  readonly namespace: string;
  readonly userTurnId: string;
  readonly assistantTurnId: string;
}

export interface MaterializeEpisodeResult {
  readonly episodeId: string;
  readonly memoryId: string;
  readonly created: boolean;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function required(value: string, field: string): string {
  const normalized = value.normalize('NFKC').trim();
  if (!normalized) throw new Error(`情景物化缺少 ${field}`);
  return normalized;
}

function persistedTurnContent(row: DatabaseRow): string {
  return text(row.display_content) || text(row.content);
}

function redactCredential(value: string): {
  content: string;
  credentialRedacted: boolean;
} {
  if (!containsCredentialSecret({ content: value })) {
    return { content: value, credentialRedacted: false };
  }
  return {
    content: REDACTED_ASSISTANT_CREDENTIAL,
    credentialRedacted: true,
  };
}

function contentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function episodeScope(session: DatabaseRow): {
  scopeType: MemoryScopeType;
  scopeKey: string;
} {
  const projectId = text(session.project_id).trim();
  if (projectId) return { scopeType: 'project', scopeKey: projectId };
  const personaId = text(session.persona_id).trim();
  if (personaId) return { scopeType: 'role', scopeKey: personaId };
  return { scopeType: 'personal', scopeKey: 'self' };
}

/**
 * Materializes a completed user/assistant exchange as episodic context.
 * This service is deterministic and intentionally performs no model work.
 */
export class EpisodicMemoryService {
  private readonly journal: MemoryJournal;

  constructor(
    private readonly database: DatabaseSync,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.journal = new MemoryJournal(database);
  }

  materialize(input: MaterializeEpisodeInput): MaterializeEpisodeResult {
    const userId = required(input.userId, 'userId');
    const namespace = required(input.namespace, 'namespace');
    const userTurnId = required(input.userTurnId, 'userTurnId');
    const assistantTurnId = required(
      input.assistantTurnId,
      'assistantTurnId',
    );
    const existing = this.findExisting(
      userId,
      namespace,
      userTurnId,
      assistantTurnId,
    );
    if (existing) return { ...existing, created: false };

    const timestamp = this.clock().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const replayed = this.findExisting(
        userId,
        namespace,
        userTurnId,
        assistantTurnId,
      );
      if (replayed) {
        this.database.exec('COMMIT');
        return { ...replayed, created: false };
      }
      const exchange = this.database.prepare(
        `SELECT
           u.id AS user_turn_id,
           u.session_id,
           u.user_id,
           u.namespace,
           u.role AS user_role,
           u.content AS user_content,
           u.display_content AS user_display_content,
           u.content_hash AS user_content_hash,
           u.occurred_at AS user_occurred_at,
           u.message_status AS user_message_status,
           s.persona_id,
           s.project_id,
           a.id AS assistant_turn_id,
           a.session_id AS assistant_session_id,
           a.user_id AS assistant_user_id,
           a.namespace AS assistant_namespace,
           a.role AS assistant_role,
           a.content AS assistant_content,
           a.display_content AS assistant_display_content,
           a.content_hash AS assistant_content_hash,
           a.message_status AS assistant_message_status
         FROM conversation_turns u
         JOIN conversation_sessions s ON s.id = u.session_id
         JOIN conversation_turns a ON a.id = ?
         WHERE u.id = ?
           AND u.user_id = ? AND u.namespace = ?`,
      ).get(
        assistantTurnId,
        userTurnId,
        userId,
        namespace,
      ) as DatabaseRow | undefined;
      if (
        !exchange ||
        text(exchange.user_role) !== 'user' ||
        text(exchange.assistant_role) !== 'assistant' ||
        text(exchange.assistant_session_id) !== text(exchange.session_id) ||
        text(exchange.assistant_user_id) !== userId ||
        text(exchange.assistant_namespace) !== namespace ||
        text(exchange.user_message_status) !== 'completed' ||
        text(exchange.assistant_message_status) !== 'completed'
      ) {
        throw new Error(
          '情景物化只接受同一 principal/namespace/session 的完整 exchange',
        );
      }

      const user = redactCredential(persistedTurnContent({
        content: exchange.user_content,
        display_content: exchange.user_display_content,
      }));
      const assistant = redactCredential(persistedTurnContent({
        content: exchange.assistant_content,
        display_content: exchange.assistant_display_content,
      }));
      const sessionId = text(exchange.session_id);
      const scope = episodeScope(exchange);
      const occurredAt = text(exchange.user_occurred_at);
      const content = [
        `用户原话：${user.content}`,
        `助手回应（非用户事实）：${assistant.content}`,
      ].join('\n');
      const title = `对话情景 · ${occurredAt.slice(0, 10)}`;
      const memoryId = randomUUID();
      const episodeId = randomUUID();
      const sensitivity =
        user.credentialRedacted || assistant.credentialRedacted
          ? 'sensitive'
          : 'normal';
      const memory: MemoryRecord = {
        id: memoryId,
        userId,
        namespace,
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
        kind: 'event',
        title,
        content,
        summary: '',
        tags: ['conversation', 'episode'],
        importance: 0.45,
        confidence: 1,
        sensitivity,
        sourceAuthority: 'legacy_unknown',
        negated: false,
        status: 'active',
        source: 'conversation_episode',
        sourceRef: `conversation:${sessionId}:${userTurnId}:${assistantTurnId}`,
        occurredAt,
        validFrom: null,
        validTo: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastSeenAt: timestamp,
        lastAccessedAt: null,
        accessCount: 0,
        checksum: canonicalContentHash(content),
        deletedAt: null,
      };
      this.database.prepare(
        `INSERT INTO memories (
           id, user_id, namespace, scope_type, scope_key, kind,
           title, content, summary, tags_json, importance, confidence,
           status, source, source_ref, occurred_at, valid_from, valid_to,
           created_at, updated_at, last_seen_at, access_count, checksum,
           embedding, sensitivity, source_authority, negated
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, 0, ?, ?, ?, ?, 0
         )`,
      ).run(
        memory.id,
        memory.userId,
        memory.namespace,
        memory.scopeType,
        memory.scopeKey,
        memory.kind,
        memory.title,
        memory.content,
        memory.summary,
        JSON.stringify(memory.tags),
        memory.importance,
        memory.confidence,
        memory.status,
        memory.source,
        memory.sourceRef,
        memory.occurredAt,
        memory.validFrom,
        memory.validTo,
        memory.createdAt,
        memory.updatedAt,
        memory.lastSeenAt,
        memory.checksum,
        vectorToBuffer(embedText([
          memory.title,
          memory.content,
          memory.tags.join(' '),
        ].join('\n'))),
        memory.sensitivity,
        memory.sourceAuthority,
      );
      const stableKey = [
        scope.scopeType,
        encodeURIComponent(scope.scopeKey),
        'conversation-episode',
        userTurnId,
        assistantTurnId,
      ].join('::');
      const versionId = this.journal.recordCreate(
        memory,
        'conversation-episode-materializer',
        'created',
        stableKey,
        {
          predicateKey: stableKey,
          normalizedValueHash: canonicalContentHash(content),
          normalizedValue: content,
          predicateCardinality: 'event',
        },
      );
      this.database.prepare(
        `INSERT INTO conversation_episodes (
           id, memory_id, user_id, namespace, session_id,
           user_turn_id, assistant_turn_id, scope_type, scope_key,
           occurred_at, content_hash, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        episodeId,
        memoryId,
        userId,
        namespace,
        sessionId,
        userTurnId,
        assistantTurnId,
        scope.scopeType,
        scope.scopeKey,
        occurredAt,
        canonicalContentHash(content),
        timestamp,
        timestamp,
      );
      const insertTurn = this.database.prepare(
        `INSERT INTO conversation_episode_turns (
           episode_id, turn_id, role, ordinal, content_hash
         ) VALUES (?, ?, ?, ?, ?)`,
      );
      insertTurn.run(
        episodeId,
        userTurnId,
        'user',
        0,
        contentHash(user.content),
      );
      insertTurn.run(
        episodeId,
        assistantTurnId,
        'assistant',
        1,
        contentHash(assistant.content),
      );
      this.journal.recordEvidence(versionId, {
        turnId: userTurnId,
        evidenceType: 'user_utterance',
        excerpt: user.content,
        sourceRef: memory.sourceRef || undefined,
        sensitivity,
        sourceAuthority: 'direct_user',
        createdAt: timestamp,
      });
      this.journal.recordEvidence(versionId, {
        turnId: assistantTurnId,
        evidenceType: 'assistant_response',
        excerpt: assistant.content,
        sourceRef: memory.sourceRef || undefined,
        sensitivity,
        sourceAuthority: 'assistant_inference',
        createdAt: timestamp,
      });
      this.database.exec('COMMIT');
      return { episodeId, memoryId, created: true };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private findExisting(
    userId: string,
    namespace: string,
    userTurnId: string,
    assistantTurnId: string,
  ): Omit<MaterializeEpisodeResult, 'created'> | null {
    const row = this.database.prepare(
      `SELECT id, memory_id
       FROM conversation_episodes
       WHERE user_id = ? AND namespace = ?
         AND user_turn_id = ? AND assistant_turn_id = ?`,
    ).get(
      userId,
      namespace,
      userTurnId,
      assistantTurnId,
    ) as DatabaseRow | undefined;
    return row
      ? { episodeId: text(row.id), memoryId: text(row.memory_id) }
      : null;
  }
}
