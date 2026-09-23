export type MemoryKind =
  | 'profile'
  | 'preference'
  | 'project'
  | 'event'
  | 'knowledge'
  | 'relationship'
  | 'instruction';

export type MemoryStatus =
  | 'active'
  | 'superseded'
  | 'archived'
  | 'deleted';

export interface MemoryAccessScope {
  scopeType: 'personal' | 'project' | 'role' | 'session';
  scopeKey: string;
}

export interface AccountPrincipal {
  id: string;
  displayName: string;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
}

export interface AuthCredential {
  id: string;
  principalId: string;
  label: string;
  secretHint: string;
  status: 'active' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface IdentitySessionOverview {
  id: string;
  namespace: string;
  clientName: string;
  externalId: string;
  startedAt: string;
  endedAt: string | null;
  identitySource: string;
  identityStatus: string;
}

export interface IdentityPersonaOverview {
  id: string;
  principalId: string;
  clientType: string;
  clientInstanceId: string;
  personaId: string;
  displayName: string | null;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  latestSession: IdentitySessionOverview | null;
  roleMemoryCount: number;
}

export interface IdentityNamespaceOverview {
  namespace: string;
  activeMemoryCount: number;
  personalMemoryCount: number;
}

export interface CurrentIdentityOverview {
  principal: AccountPrincipal;
  credential: AuthCredential | null;
  personas: IdentityPersonaOverview[];
  personalMemoryCount: number;
  namespaces: IdentityNamespaceOverview[];
}

export interface ChatProfile {
  personaId: string;
  profileVersion: number;
  displayName: string;
  systemPrompt: string;
  greeting: string;
  language: string;
  capabilityIds: string[];
  updatedAt: string;
  availableVersions: Array<{
    profileVersion: number;
    updatedAt: string;
  }>;
}

export interface Conversation {
  id: string;
  personaId: string;
  projectId: string | null;
  personaProfileVersion: number;
  title: string | null;
  status: 'active' | 'archived';
  messageCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  sequence: number;
  role: 'user' | 'assistant';
  displayContent: string;
  actions: Array<{
    id: string;
    type: string;
    payload: { name: string };
  }>;
  attachments: never[];
  status: 'completed';
  generationGroupId: string | null;
  variantIndex: number;
  isActiveVariant: boolean;
  createdAt: string;
  completedAt: string;
  version: number;
}

export interface ConversationPage {
  items: Conversation[];
  nextCursor: string | null;
  hasMore: boolean;
  syncCursor: string;
}

export interface ConversationMessagePage {
  items: ConversationMessage[];
  nextCursor: string | null;
  hasMore: boolean;
  conversationVersion: number;
}

export interface ConversationStreamEvent {
  id: string;
  type:
    | 'turn.accepted'
    | 'turn.stage'
    | 'assistant.delta'
    | 'assistant.action'
    | 'turn.completed'
    | 'turn.failed'
    | 'turn.interrupted'
    | 'turn.deleted';
  data: Record<string, unknown>;
}

export interface LocalChatWorkspace {
  persona: Pick<IdentityPersonaOverview, 'personaId' | 'displayName'>;
  profile: ChatProfile;
}

export interface IssuedCredential {
  credential: AuthCredential;
  token: string;
}

export interface InitializedAccount extends IssuedCredential {
  principal: AccountPrincipal;
}

export interface CredentialListResponse {
  currentCredentialId: string | null;
  credentials: AuthCredential[];
}

export interface Memory {
  id: string;
  userId: string;
  namespace: string;
  scopeType: 'personal' | 'project' | 'role' | 'session';
  scopeKey: string;
  kind: MemoryKind;
  title: string;
  content: string;
  summary: string;
  tags: string[];
  importance: number;
  confidence: number;
  sensitivity: 'normal' | 'sensitive' | 'credential';
  sourceAuthority:
    | 'direct_user'
    | 'user_confirmed'
    | 'assistant_inference'
    | 'imported'
    | 'legacy_unknown';
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
}

export interface RestoreDecision {
  status: 'restored' | 'merged' | 'requires_confirmation';
  memory: Memory;
  conflicts: Memory[];
  tombstonesRestored: number;
  confirmationToken: string | null;
  assessment: {
    relation:
      | 'equivalent'
      | 'reinforces'
      | 'supersedes'
      | 'contradicts'
      | 'coexists';
    targetMemoryId: string | null;
    method: 'exact' | 'rule' | 'embedding' | 'model' | 'manual';
    confidence: number;
    rationale: string;
    model: string | null;
    promptVersion: string | null;
    actionPlan: 'restore' | 'merge' | 'replace';
  } | null;
}

export interface MemoryList {
  items: Memory[];
  total: number;
}

export interface Relation {
  fromMemoryId: string;
  toMemoryId: string;
  relationType: string;
  createdAt: string;
}

export interface MemoryGovernance {
  memoryId: string;
  userId: string;
  namespace: string;
  kind: MemoryKind;
  status: string;
  pinned: boolean;
  expiresAt: string | null;
  archivedAt: string | null;
  archiveReason: string | null;
  retrievedCount: number;
  usedCount: number;
  confirmedCount: number;
  rejectedCount: number;
}

export interface MemoryEvidence {
  id: string;
  evidenceType: string;
  excerpt: string | null;
  sourceRef: string | null;
  turnId: string | null;
  turnContent: string | null;
  turnOccurredAt: string | null;
  sessionId: string | null;
  sensitivity: string;
  sourceAuthority: string;
  createdAt: string;
}

export interface MemoryVersion {
  id: string;
  version: number;
  title: string;
  content: string;
  summary: string;
  importance: number;
  confidence: number;
  source: string;
  sourceRef: string | null;
  createdBy: string;
  createdAt: string;
  supersededAt: string | null;
  predicateKey: string | null;
  normalizedValue: string | null;
  scopeType: string;
  scopeKey: string;
  sensitivity: string;
  sourceAuthority: string;
  negated: boolean;
  occurredAt: string | null;
  validFrom: string | null;
  validTo: string | null;
  evidence: MemoryEvidence[];
}

export interface MemoryEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ConsolidationDetail {
  id: string;
  scopeType: string;
  scopeKey: string;
  sourceSetHash: string;
  model: string;
  promptVersion: string;
  status: string;
  generatedAt: string;
  staleAt: string | null;
  sentences: Array<{
    id: string;
    index: number;
    text: string;
    supported: boolean;
    sourceVersionIds: string[];
  }>;
}

export interface MemoryDetail {
  memory: Memory;
  relations: Relation[];
  governance: MemoryGovernance | null;
  versions: MemoryVersion[];
  events: MemoryEvent[];
  relationDecisions: Array<{
    id: string;
    candidateId: string;
    candidateContent: string;
    candidateSubject: string;
    candidatePredicate: string;
    candidateValue: string;
    targetMemoryItemId: string | null;
    relation:
      | 'equivalent'
      | 'reinforces'
      | 'supersedes'
      | 'contradicts'
      | 'coexists';
    method: 'exact' | 'rule' | 'embedding' | 'model' | 'manual';
    confidence: number;
    model: string | null;
    promptVersion: string | null;
    rationale: string;
    status: string;
    error: string | null;
    createdAt: string;
  }>;
  consolidation: ConsolidationDetail | null;
}

export interface RecallScoreExplanation {
  lexicalRank: number | null;
  annRank: number | null;
  termRank: number | null;
  semanticSimilarity: number;
  rerankConfidence: number | null;
  importance: number;
  memoryConfidence: number;
  recency: number;
  status: MemoryStatus;
  conflictState: 'none' | 'superseded' | 'archived';
  diversityPenalty: number;
}

export interface RecallResult {
  memory: Memory;
  score: number;
  reasons: string[];
  explanation?: RecallScoreExplanation;
}

export interface RecallResponse {
  traceId?: string;
  query: string;
  memories: RecallResult[];
  context: string;
  qualityState?: 'full' | 'degraded' | 'unavailable';
  queryUnderstanding?: {
    status: 'not_needed' | 'resolved' | 'ambiguous' | 'unavailable';
    originalQuery: string;
    standaloneQuery: string | null;
    rankingQuery: string;
    variants: string[];
    constraints: {
      temporal: string[];
      negative: string[];
      modal: string[];
      frequency: string[];
      conditional: string[];
      subject: string[];
      object: string[];
    };
    unresolvedReferences: string[];
    clarificationQuestion: string | null;
    confidence: number;
    contextSource: 'none' | 'trusted_ledger' | 'request_untrusted';
    model: string | null;
    promptVersion: string;
    triggerReasons: string[];
    latencyMs: number;
  };
}

export type RetrievalTraceStage =
  | 'request'
  | 'rewrite'
  | 'channels'
  | 'fusion'
  | 'semantic'
  | 'rerank'
  | 'selection'
  | 'context'
  | 'result';

export interface RetrievalTraceEvent {
  sequence: number;
  stage: RetrievalTraceStage;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface RetrievalTraceDetail {
  traceId: string;
  userId: string;
  namespace: string;
  scopes: MemoryAccessScope[];
  logMode: 'metadata' | 'diagnostic';
  queryHash: string;
  query: string | null;
  request: Record<string, unknown>;
  qualityState: 'full' | 'degraded' | 'unavailable' | null;
  resultCount: number;
  totalDurationMs: number | null;
  errorCode: string | null;
  startedAt: string;
  completedAt: string | null;
  events: RetrievalTraceEvent[];
}

export interface AuditRecord {
  id: number;
  action: string;
  memoryId: string | null;
  userId: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ServiceHealth {
  ok: boolean;
  service: string;
  version: string;
  mcpTransport: string;
}

export interface ServiceConfig {
  userId: string;
  defaultNamespace: string;
  tokenRequired: boolean;
  host: string;
  port: number;
  dataDir: string;
  projectDir: string;
  nodePath: string;
  semanticMode: 'required' | 'off';
  ollamaBaseUrl: string;
  queryModel: string;
  modelKeepAlive: string;
  foregroundQuietMs: number;
  embeddingModel: string;
  rerankModel: string;
  extractionModel: string;
  relationModel: string;
  explicitIntentModel: string;
  consolidationModel: string;
  reflectionModel: string;
  automationMode: 'off' | 'shadow' | 'auto';
  compatChatModel: string;
  compatApiBaseUrl: string;
}

export interface CandidateInboxItem {
  id: string;
  userId: string;
  namespace: string;
  scopeType: string;
  scopeKey: string;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  value: string;
  negated: boolean;
  content: string;
  confidence: number;
  importance: number;
  sensitivity: string;
  sourceAuthority: string;
  sourceExcerpt: string | null;
  claimOccurredAt: string | null;
  claimValidFrom: string | null;
  claimValidTo: string | null;
  state: string;
  decisionReason: string | null;
  explicitCorrection: boolean;
  resolvedMemoryItemId: string | null;
  turnId: string | null;
  turnContent: string | null;
  extractionModel: string | null;
  promptVersion: string | null;
  reflectionRunId: string | null;
  candidateOrigin:
    | 'turn_extraction'
    | 'history_reextract'
    | 'reflection';
  claimFingerprint: string | null;
  evidenceCount: number;
  evidenceSessionCount: number;
  evidenceStartedAt: string | null;
  evidenceEndedAt: string | null;
  evidence: Array<{
    turnId: string;
    excerpt: string | null;
    evidenceType: 'direct' | 'pattern_support';
    occurredAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export type ReflectionRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'dead'
  | 'cancelled';

export interface ReflectionCheckpoint {
  id: string;
  userId: string;
  namespace: string;
  scopeType: MemoryAccessScope['scopeType'];
  scopeKey: string;
  runType: 'reextract' | 'reflect';
  generationKey: string;
  lastIngestSeq: number;
  lastTurnOccurredAt: string | null;
  lastTurnId: string | null;
  lastSuccessAt: string | null;
}

export interface ReflectionStatus {
  mode: 'off' | 'shadow';
  dailyCallLimit: number;
  callsUsedToday: number;
  checkpoints: ReflectionCheckpoint[];
  runCounts: Record<ReflectionRunStatus, number>;
  latestIngestSeq: number;
  checkpointLag: number;
  pipelineLags: Array<{
    userId: string;
    namespace: string;
    scopeType: MemoryAccessScope['scopeType'];
    scopeKey: string;
    runType: 'reextract' | 'reflect';
    generationKey: string;
    latestIngestSeq: number;
    lastIngestSeq: number;
    lag: number;
  }>;
}

export interface ReflectionRun {
  id: string;
  userId: string;
  namespace: string;
  scopeType: MemoryAccessScope['scopeType'];
  scopeKey: string;
  runType: 'reextract' | 'reflect';
  trigger: 'sweep' | 'model_upgrade' | 'manual' | 'repair' | 'pre_retention';
  status: ReflectionRunStatus;
  windowStart: string | null;
  windowEnd: string | null;
  windowStartIngestSeq: number | null;
  windowEndIngestSeq: number | null;
  turnSetHash: string;
  inputTurnCount: number;
  candidateCount: number;
  acceptedCount: number;
  pendingCount: number;
  rejectedCount: number;
  model: string;
  promptVersion: string;
  extractorId: string;
  extractorVersion: string;
  implementationVersion: string;
  generationKey: string;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseUntil: string | null;
  lastError: string | null;
  requestedBy: string;
  cancelRequestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReflectionPreview {
  userId: string;
  namespace: string;
  scopeType: MemoryAccessScope['scopeType'];
  scopeKey: string;
  generationKeys: Record<'reextract' | 'reflect', string>;
  turnCount: number;
  estimatedTokens: number;
  callsRequired: Record<'reextract' | 'reflect', number>;
  turns: Array<{
    id: string;
    role: string;
    content: string;
    occurredAt: string;
    ingestSeq: number;
    turnAlias: string;
    contentHash: string;
  }>;
  pipelines: Record<'reextract' | 'reflect', {
    generationKey: string;
    turnCount: number;
    estimatedTokens: number;
    callsRequired: number;
    turns: ReflectionPreview['turns'];
    blockedTurn: null | {
      id: string;
      ingestSeq: number;
      estimatedTokens: number;
      reason: 'token_budget';
    };
  }>;
}

export interface ReflectionRunEvent {
  id: number;
  eventType: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ReflectionRunDetail {
  run: ReflectionRun;
  events: ReflectionRunEvent[];
  modelCalls: Array<{
    id: string;
    runId: string;
    callType: 'reextract' | 'reflect';
    model: string;
    estimatedTokens: number;
    status: 'reserved' | 'completed' | 'failed' | 'refunded';
    error: string | null;
    reservedAt: string;
    completedAt: string | null;
  }>;
}

export interface QueuedReflectionRun {
  run: ReflectionRun;
  turnIds: string[];
  created: boolean;
}

export interface CandidateResolution {
  candidateId: string;
  state: string;
  reason: string;
  memoryId: string | null;
}

export interface MemoryActionRequest {
  id: string;
  userId: string;
  namespace: string;
  action: 'remember' | 'correct' | 'forget';
  status: 'pending' | 'failed';
  targetQuery: string;
  targetMemoryId: string | null;
  candidateId: string | null;
  candidate: {
    kind?: MemoryKind;
    subject?: string;
    predicate?: string;
    value?: string;
    content?: string;
    scopeType?: string;
    scopeKey?: string;
    sourceExcerpt?: string;
  } | null;
  turnId: string | null;
  turnContent: string | null;
  confidence: number;
  sensitivity: string;
  model: string;
  promptVersion: string;
  rationale: string;
  error: string | null;
  reviewInProgress: boolean;
  createdAt: string;
  resolvedAt: string | null;
}

export interface MemoryActionReviewResult {
  requestId: string;
  action: MemoryActionRequest['action'];
  status: 'completed' | 'rejected';
  memoryId: string | null;
  candidateId: string | null;
  reason: string;
}

export interface SystemHealthSnapshot {
  quality: 'full' | 'degraded' | 'unavailable';
  ollamaAvailable: boolean;
  availableModels: string[];
  missingModels: string[];
  modelRuntime: ModelRuntimeStatus & { keepAlive: string };
  queues: Array<{
    jobType: string;
    status: string;
    count: number;
    oldestAvailableAt: string | null;
  }>;
  deadLetterCount: number;
  deadLetterHistoryCount: number;
  deadLetters: Array<{
    jobId: string;
    jobType: string;
    namespace: string;
    attempts: number;
    lastError: string;
    failedAt: string;
    resolved: boolean;
    recoveryJobId: string | null;
    recoveryStatus: string | null;
    recoveryMode:
      | 'recompute'
      | 'repair'
      | 'supersede'
      | 'system_takeover'
      | null;
  }>;
  jobAttempts: Array<{
    jobId: string;
    jobType: string;
    namespace: string;
    outcome: 'completed' | 'failed';
    attempt: number;
    maxAttempts: number;
    failureClass: string | null;
    resultStatus: string | null;
    compensationAction: string | null;
    recoveryStrategy: string | null;
    noopReason: string | null;
    retryable: boolean | null;
    repeatedFingerprint: boolean | null;
    nextState: string;
    modelDurationMs: number | null;
    inputFingerprint: string | null;
    outputFingerprint: string | null;
    errorFingerprint: string | null;
    missingSourceIds: string[];
    createdAt: string;
  }>;
  candidateCounts: Record<string, number>;
  index: {
    activeMemories: number;
    ftsMemories: number;
    annMemories: number;
    termMemories: number;
    embeddingMemories: number;
    denseEligible: number;
    denseIndexed: number;
    denseDimensions: number | null;
    denseIndexVersion: string;
    lag: number;
  };
  denseIndex: {
    alias: {
      activeGenerationId: string | null;
      buildingGenerationId: string | null;
      previousGenerationId: string | null;
      revision: number;
      updatedAt: string;
    } | null;
    generations: Array<{
      role: 'active' | 'building' | 'previous';
      generationId: string;
      modelId: string;
      embeddingModel: string;
      indexVersion: string;
      dimensions: number;
      generationKey: string;
      status: string;
      readyAt: string | null;
      failureReason: string | null;
      evaluation: {
        evaluationId: string;
        datasetId: string;
        datasetSha256: string;
        evaluatorVersion: string;
        queryCount: number;
        recallAt20: number;
        mrrAt10: number;
        passed: boolean;
        completedAt: string;
      } | null;
    }>;
  };
  automation: {
    averageExtractionLatencyMs: number | null;
    failedExtractionCount: number;
    retryingJobCount: number;
    staleConsolidationCount: number;
    quarantinedConsolidationCount: number;
  };
  models: {
    chat: string;
    query: string;
    extraction: string;
    relation: string;
    explicitIntent: string;
    consolidation: string;
    reflection: string;
    embedding: string;
    reranker: string;
  };
  timestamp: string;
}

export interface ModelRuntimeStatus {
  foregroundCount: number;
  lastForegroundActivityAt: number | null;
  quietForMs: number | null;
  foregroundQuietMs: number;
  backgroundWorkAllowed: boolean;
}

export interface ConsolidationSummary {
  id: string;
  memoryId: string | null;
  namespace: string;
  scopeType: string;
  scopeKey: string;
  sourceSetHash: string;
  model: string;
  promptVersion: string;
  status: string;
  generatedAt: string;
  staleAt: string | null;
  lastError: string | null;
  revision: number;
  title: string | null;
  memoryStatus: string | null;
  sourceCount: number;
  sentenceCount: number;
}

export interface Tombstone {
  id: string;
  namespace: string;
  stableKey: string | null;
  contentHash: string | null;
  reason: string;
  createdAt: string;
  restoredAt: string | null;
}

export interface PurgeJob {
  id: string;
  memoryId: string;
  userId: string;
  namespace: string;
  contentHash: string;
  reason: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'dead';
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseUntil: string | null;
  leaseOwner: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  purgeBoundary: {
    managedMigrationBackups: true;
    externalExportCopies: false;
    notice: string;
  };
}

export interface RetentionPolicy {
  id: string;
  userId: string;
  namespace: string;
  kind: MemoryKind | null;
  evidenceTtlDays: number | null;
  halfLifeDays: number | null;
  autoArchive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RecallExplanation {
  id: number;
  traceId?: string;
  queryHash?: string;
  query?: string | null;
  mode: string;
  candidateCount: number;
  lexicalCandidateCount?: number;
  annCandidateCount?: number;
  termCandidateCount?: number;
  rerankCandidateCount?: number;
  resultIds: string[];
  results?: Array<{
    memoryId: string;
    versionId: string | null;
    score: number;
    reasons: string[];
    explanation?: RecallScoreExplanation;
    evidence: Array<{
      evidenceType: string;
      excerpt: string | null;
      sourceRef: string | null;
      turnId: string | null;
    }>;
  }>;
  embeddingModel?: string;
  rerankModel?: string;
  denseEligible?: number;
  denseIndexed?: number;
  indexVersion?: string;
  generationId?: string;
  generationKey?: string;
  filterSummary?: Array<{
    reason: string;
    count: number;
  }>;
  qualityState?: 'full' | 'degraded' | 'unavailable';
  createdAt: string;
}

export const KIND_LABELS: Record<MemoryKind, string> = {
  profile: '用户档案',
  preference: '偏好',
  project: '项目',
  event: '事件',
  knowledge: '知识',
  relationship: '关系',
  instruction: '长期指令',
};

export const STATUS_LABELS: Record<MemoryStatus, string> = {
  active: '有效',
  superseded: '已替代',
  archived: '已归档',
  deleted: '已删除',
};
