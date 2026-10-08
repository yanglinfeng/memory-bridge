/**
 * 备份/状态 zod schema 簇（原 memory-store.ts 309-470 行）。
 *
 * 由 memory-store.ts 机械搬迁而来（仅加 export 前缀），公开符号由门面 re-export。
 */

import { z } from 'zod';
import { MEMORY_KINDS } from './types.js';
import { SCHEMA_VERSION } from './database.js';

export const memoryStatusSchema = z.enum([
  'active',
  'superseded',
  'archived',
  'deleted',
]);

export const isoDateSchema = z.string().datetime({ offset: true });

export const nullableIsoDateSchema = isoDateSchema.nullable();

export const DENSE_GENERATION_PROBE =
  'memory-bridge dense generation probe';

export const backupMemorySchema = z.object({
  id: z.string().uuid(),
  userId: z.string().min(1),
  namespace: z.string().min(1),
  scopeType: z.enum([
    'personal',
    'project',
    'role',
    'session',
    'public',
  ]).default('personal'),
  scopeKey: z.string().min(1).default('self'),
  kind: z.enum(MEMORY_KINDS),
  title: z.string().min(1),
  content: z.string().min(1),
  summary: z.string(),
  tags: z.array(z.string()),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  sensitivity: z.enum([
    'normal',
    'sensitive',
    'credential',
  ]).default('normal'),
  sourceAuthority: z.enum([
    'direct_user',
    'user_confirmed',
    'assistant_inference',
    'imported',
    'legacy_unknown',
  ]).default('legacy_unknown'),
  negated: z.boolean().default(false),
  status: memoryStatusSchema,
  source: z.string().min(1),
  sourceRef: z.string().nullable(),
  /** 旧备份无此字段（v44 之前未导出），导入时落 null。 */
  stableKey: z.string().nullable().optional(),
  occurredAt: nullableIsoDateSchema,
  validFrom: nullableIsoDateSchema,
  validTo: nullableIsoDateSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  lastSeenAt: isoDateSchema,
  lastAccessedAt: nullableIsoDateSchema,
  accessCount: z.number().int().nonnegative(),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  deletedAt: nullableIsoDateSchema,
  origin: z.enum(['pipeline', 'api']).optional(),
  corpusDomain: z.enum(['policy', 'open', 'chat']).optional(),
  classification: z.enum(['public', 'internal', 'confidential']).optional(),
}).strict();

export const backupRelationSchema = z.object({
  fromMemoryId: z.string().uuid(),
  toMemoryId: z.string().uuid(),
  relationType: z.string().min(1),
  createdAt: isoDateSchema,
}).strict();

export const backupAuditSchema = z.object({
  id: z.number().int().positive(),
  action: z.string().min(1),
  memoryId: z.string().uuid().nullable(),
  userId: z.string().min(1),
  detail: z.record(z.unknown()),
  createdAt: isoDateSchema,
}).strict();

export const backupIdempotencyKeySchema = z.object({
  userId: z.string().min(1),
  namespace: z.string().min(1),
  scopeType: z.string().min(1).optional(),
  scopeKey: z.string().min(1).optional(),
  key: z.string().min(1),
  memoryId: z.string().uuid(),
  createdAt: isoDateSchema,
}).strict();

export const backupScalarSchema = z.union([
  z.string(),
  z.number(),
  z.null(),
]);

export const backupRowSchema = z.record(backupScalarSchema);

export const fullBackupStateSchema = z.object({
  sessions: z.array(backupRowSchema),
  turns: z.array(backupRowSchema),
  extractionRuns: z.array(backupRowSchema),
  candidates: z.array(backupRowSchema),
  actionRequests: z.array(backupRowSchema).default([]),
  candidateResolutionRuns: z.array(backupRowSchema).default([]),
  items: z.array(backupRowSchema),
  versions: z.array(backupRowSchema),
  evidence: z.array(backupRowSchema),
  edges: z.array(backupRowSchema),
  events: z.array(backupRowSchema),
  outbox: z.array(backupRowSchema),
  jobs: z.array(backupRowSchema),
  deadLetters: z.array(backupRowSchema),
  retentionPolicies: z.array(backupRowSchema),
  tombstones: z.array(backupRowSchema),
  consolidations: z.array(backupRowSchema),
  consolidationSources: z.array(backupRowSchema),
  consolidationSentences: z.array(backupRowSchema),
  sentenceSources: z.array(backupRowSchema),
  purgeJobs: z.array(backupRowSchema),
  namespaceQualitySnapshots: z.array(backupRowSchema).default([]),
  namespaceRolloutState: z.array(backupRowSchema).default([]),
  namespaceRecallShadowComparisons:
    z.array(backupRowSchema).default([]),
  turnIngestOrder: z.array(backupRowSchema).default([]),
  reflectionSettings: z.array(backupRowSchema).default([]),
  reflectionCheckpoints: z.array(backupRowSchema).default([]),
  reflectionRuns: z.array(backupRowSchema).default([]),
  reflectionRunTurns: z.array(backupRowSchema).default([]),
  reflectionModelCalls: z.array(backupRowSchema).default([]),
  reflectionClaims: z.array(backupRowSchema).default([]),
  reflectionEvents: z.array(backupRowSchema).default([]),
  candidateEvidence: z.array(backupRowSchema).default([]),
  episodes: z.array(backupRowSchema).default([]),
  episodeTurns: z.array(backupRowSchema).default([]),
  patternObservations: z.array(backupRowSchema).default([]),
  hierarchicalSummaries: z.array(backupRowSchema).default([]),
  hierarchicalSummarySources: z.array(backupRowSchema).default([]),
}).strict();

export const memoryBackupSchema = z.object({
  version: z.union([z.literal(2), z.literal(3)]),
  schemaVersion: z.number().int().min(9).max(SCHEMA_VERSION).optional(),
  exportedAt: isoDateSchema,
  userId: z.string().min(1),
  memories: z.array(backupMemorySchema),
  relations: z.array(backupRelationSchema),
  auditLog: z.array(backupAuditSchema),
  idempotencyKeys: z.array(backupIdempotencyKeySchema),
  state: fullBackupStateSchema.optional(),
}).strict().superRefine((backup, context) => {
  if (
    backup.version === 3 &&
    (!backup.schemaVersion || !backup.state)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'v3 备份缺少 schemaVersion 或完整 state',
    });
  }
  if (
    backup.version === 2 &&
    (backup.schemaVersion !== undefined || backup.state !== undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'v2 备份不能包含 v3 状态字段',
    });
  }
});

export type MemoryBackup = z.infer<typeof memoryBackupSchema>;

export type FullBackupState = z.infer<typeof fullBackupStateSchema>;

