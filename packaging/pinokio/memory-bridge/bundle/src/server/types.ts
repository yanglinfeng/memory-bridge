export const MEMORY_KINDS = [
  'profile',
  'preference',
  'project',
  'event',
  'knowledge',
  'relationship',
  'instruction',
  // 知识库直写条目专用：仅由外部知识库客户端等文档入口写入（source 以 kb: 开头），
  // 对话提取链路不得产出；治理管线（合并/层级摘要）会按来源豁免，防止误伤原文片段。
  'document_chunk',
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryStatus = 'active' | 'superseded' | 'archived' | 'deleted';
export type PredicateCardinality = 'single' | 'set' | 'event';
export type MemorySensitivity = 'normal' | 'sensitive' | 'credential';
export type MemoryScopeType =
  | 'personal'
  | 'project'
  | 'role'
  | 'session'
  | 'public';
/**
 * 密级（classification）：文档/知识的纵向可见分级，与 scope（横向）正交。
 * public=可匿名公开；internal=内部（登录后默认可见）；confidential=机密
 * （需会话 clearance=confidential）。与 sensitivity（内容保护语义）无关。
 */
export type MemoryClassification = 'public' | 'internal' | 'confidential';
export const MEMORY_CLASSIFICATIONS: readonly MemoryClassification[] = [
  'public',
  'internal',
  'confidential',
];
/** 密级序：public < internal < confidential。 */
export const CLASSIFICATION_RANK: Record<MemoryClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
};
/** 密级不高于 clearance 的文档对读者可见。 */
export function classificationsVisibleAt(
  clearance: MemoryClassification,
): MemoryClassification[] {
  return MEMORY_CLASSIFICATIONS.filter(
    (level) => CLASSIFICATION_RANK[level] <= CLASSIFICATION_RANK[clearance],
  );
}
export interface MemoryAccessScope {
  scopeType: MemoryScopeType;
  scopeKey: string;
}
export type SourceAuthority =
  | 'direct_user'
  | 'user_confirmed'
  | 'assistant_inference'
  | 'imported'
  | 'legacy_unknown';

/** 内容出生通道：pipeline = 内核提取/治理管线产物；api = 经认证 API 直写的一手内容。 */
export type MemoryOrigin = 'pipeline' | 'api';

export type CorpusDomain = 'policy' | 'open' | 'chat';

export interface MemoryRecord {
  id: string;
  userId: string;
  namespace: string;
  scopeType: MemoryScopeType;
  scopeKey: string;
  kind: MemoryKind;
  title: string;
  content: string;
  summary: string;
  tags: string[];
  importance: number;
  confidence: number;
  sensitivity: MemorySensitivity;
  sourceAuthority: SourceAuthority;
  negated: boolean;
  status: MemoryStatus;
  source: string;
  sourceRef: string | null;
  occurredAt: string | null;
  validFrom: string | null;
  validTo: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
  checksum: string;
  deletedAt: string | null;
  origin?: MemoryOrigin;
  corpusDomain?: CorpusDomain;
  classification?: MemoryClassification;
}

export interface RememberInput {
  userId?: string;
  namespace?: string;
  kind: MemoryKind;
  title?: string;
  content: string;
  summary?: string;
  tags?: string[];
  importance?: number;
  confidence?: number;
  source?: string;
  sourceRef?: string;
  occurredAt?: string;
  validFrom?: string;
  validTo?: string;
  supersedesId?: string;
  idempotencyKey?: string;
  stableKey?: string;
  evidenceTurnId?: string;
  evidenceExcerpt?: string;
  createdBy?: string;
  predicateKey?: string;
  normalizedValueHash?: string;
  normalizedValue?: string;
  predicateCardinality?: PredicateCardinality;
  scopeType?: MemoryScopeType;
  scopeKey?: string;
  corpusDomain?: CorpusDomain;
  classification?: MemoryClassification;
  sensitivity?: MemorySensitivity;
  sourceAuthority?: SourceAuthority;
  negated?: boolean;
}

export interface UpdateMemoryInput {
  title?: string;
  content?: string;
  summary?: string;
  namespace?: string;
  kind?: MemoryKind;
  tags?: string[];
  importance?: number;
  confidence?: number;
  status?: Exclude<MemoryStatus, 'deleted'>;
  source?: string;
  sourceRef?: string | null;
  occurredAt?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  evidenceTurnId?: string;
  evidenceExcerpt?: string;
  createdBy?: string;
  idempotencyKey?: string;
  expectedRevision?: number;
  closePreviousVersion?: boolean;
  resolutionType?: 'reinforcement' | 'correction' | 'revert';
  predicateKey?: string;
  normalizedValueHash?: string;
  normalizedValue?: string;
  predicateCardinality?: PredicateCardinality;
  scopeType?: MemoryScopeType;
  scopeKey?: string;
  classification?: MemoryClassification;
  sensitivity?: MemorySensitivity;
  sourceAuthority?: SourceAuthority;
  negated?: boolean;
}

export interface RecallInput {
  query: string;
  userId?: string;
  namespace?: string;
  kinds?: MemoryKind[];
  tags?: string[];
  limit?: number;
  minScore?: number;
  includeArchived?: boolean;
  /** bi-temporal as-of 查询时间（ISO）：省略=查"现在"；传过去时间可召回当时仍有效、后被取代（superseded）的事实 */
  timestamp?: string;
  scopes?: MemoryAccessScope[];
  scopeType?: MemoryScopeType;
  scopeKey?: string;
  /** 会话/读者的密级 clearance：密级 ≤ clearance 的共享文档可见。缺省 internal。 */
  clearance?: MemoryClassification;
  allowedSensitivities?: MemorySensitivity[];
  contextTokenBudget?: number;
  recentTurns?: Array<{
    role: 'user' | 'assistant';
    content: string;
    occurredAt?: string;
  }>;
}

export interface RecallResult {
  memory: MemoryRecord;
  score: number;
  reasons: string[];
  traceId?: string;
  explanation: {
    lexicalRank: number | null;
    annRank: number | null;
    termRank: number | null;
    graphRank: number | null;
    semanticSimilarity: number;
    rerankConfidence: number | null;
    feedbackPrior: number;
    importance: number;
    memoryConfidence: number;
    recency: number;
    status: MemoryStatus;
    conflictState: 'none' | 'superseded' | 'archived';
    diversityPenalty: number;
  };
}

export interface MemoryListInput {
  userId?: string;
  query?: string;
  namespace?: string;
  scopeType?: MemoryScopeType;
  scopeKey?: string;
  kind?: MemoryKind;
  status?: MemoryStatus;
  tag?: string;
  limit?: number;
  offset?: number;
}

export interface MemoryListResult {
  items: MemoryRecord[];
  total: number;
}

export interface AuditRecord {
  id: number;
  action: string;
  memoryId: string | null;
  userId: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface MemoryStats {
  total: number;
  active: number;
  archived: number;
  superseded: number;
  deleted: number;
  byKind: Record<string, number>;
  byNamespace: Record<string, number>;
}
