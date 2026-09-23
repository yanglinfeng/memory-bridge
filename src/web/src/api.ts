import type {
  AuthCredential,
  AuditRecord,
  Conversation,
  ConversationMessagePage,
  ConversationPage,
  ConversationStreamEvent,
  CandidateInboxItem,
  CandidateResolution,
  ConsolidationSummary,
  CredentialListResponse,
  CurrentIdentityOverview,
  InitializedAccount,
  IssuedCredential,
  LocalChatWorkspace,
  Memory,
  MemoryAccessScope,
  MemoryActionRequest,
  MemoryActionReviewResult,
  MemoryDetail,
  RestoreDecision,
  MemoryGovernance,
  MemoryKind,
  MemoryList,
  MemoryStatus,
  PurgeJob,
  RecallExplanation,
  RecallResponse,
  ReflectionPreview,
  ReflectionRun,
  ReflectionRunDetail,
  ReflectionStatus,
  RetrievalTraceDetail,
  QueuedReflectionRun,
  RetentionPolicy,
  ServiceConfig,
  ServiceHealth,
  SystemHealthSnapshot,
  Tombstone,
} from './types';

interface RequestOptions extends RequestInit {
  json?: unknown;
}

let accessToken: string | null = null;
let accessTokenRevision = 0;
const authenticationRequiredListeners = new Set<() => void>();

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function requestHeaders(options: RequestOptions = {}): Headers {
  const headers = new Headers(options.headers);
  if (options.json !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }
  return headers;
}

async function responseError(response: Response): Promise<ApiError> {
  const payload = await response.json().catch(() => null) as {
    error?: string;
  } | null;
  return new ApiError(
    payload?.error || `请求失败（${response.status}）`,
    response.status,
  );
}

async function requireSuccessfulResponse(
  response: Response,
  requestTokenRevision: number,
): Promise<void> {
  if (response.ok) return;
  const error = await responseError(response);
  if (
    error.status === 401 &&
    requestTokenRevision === accessTokenRevision
  ) {
    accessToken = null;
    accessTokenRevision += 1;
    for (const listener of [...authenticationRequiredListeners]) {
      listener();
    }
  }
  throw error;
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const requestTokenRevision = accessTokenRevision;
  const response = await fetch(path, {
    ...options,
    headers: requestHeaders(options),
    body:
      options.json !== undefined
        ? JSON.stringify(options.json)
        : options.body,
  });
  await requireSuccessfulResponse(response, requestTokenRevision);
  return await response.json() as T;
}

function parseSseBlock(value: string): ConversationStreamEvent | null {
  const lines = value.split(/\r?\n/u);
  let id = '';
  let type = '';
  const data: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('id:')) id = line.slice(3).trim();
    if (line.startsWith('event:')) type = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!id || !type || data.length === 0) return null;
  try {
    return {
      id,
      type: type as ConversationStreamEvent['type'],
      data: JSON.parse(data.join('\n')) as Record<string, unknown>,
    };
  } catch {
    throw new Error('服务返回的对话流格式无效');
  }
}

async function streamConversationMessage(
  conversationId: string,
  input: {
    clientMessageId: string;
    text: string;
    clientSentAt: string;
  },
  onEvent: (event: ConversationStreamEvent) => void | Promise<void>,
): Promise<void> {
  const requestTokenRevision = accessTokenRevision;
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: 'POST',
      headers: requestHeaders({
        headers: { Accept: 'text/event-stream' },
        json: input,
      }),
      body: JSON.stringify({ ...input, attachments: [] }),
    },
  );
  await requireSuccessfulResponse(response, requestTokenRevision);
  if (!response.body) throw new Error('服务未返回对话流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const blocks = pending.split(/\r?\n\r?\n/u);
    pending = blocks.pop() ?? '';
    for (const block of blocks) {
      const event = parseSseBlock(block);
      if (event) await onEvent(event);
    }
  }
  pending += decoder.decode();
  const event = parseSseBlock(pending);
  if (event) await onEvent(event);
}

export const api = {
  setAccessToken: (token: string) => {
    const value = token.trim();
    if (!value) throw new Error('访问令牌不能为空');
    accessToken = value;
    accessTokenRevision += 1;
  },
  clearAccessToken: () => {
    accessToken = null;
    accessTokenRevision += 1;
  },
  hasAccessToken: () => accessToken !== null,
  onAuthenticationRequired: (listener: () => void) => {
    authenticationRequiredListeners.add(listener);
    return () => {
      authenticationRequiredListeners.delete(listener);
    };
  },
  health: () => request<ServiceHealth>('/api/health'),
  identity: () => request<CurrentIdentityOverview>('/api/identity'),
  bootstrapIdentity: (input: {
    displayName: string;
    label: string;
    expiresAt?: string;
  }) => request<InitializedAccount>('/api/identity/bootstrap', {
    method: 'POST',
    json: input,
  }),
  credentials: () =>
    request<CredentialListResponse>('/api/identity/credentials'),
  issueCredential: (input: { label: string; expiresAt?: string }) =>
    request<IssuedCredential>('/api/identity/credentials', {
      method: 'POST',
      json: input,
    }),
  revokeCredential: (id: string, reason?: string) =>
    request<AuthCredential>(
      `/api/identity/credentials/${id}/revoke`,
      { method: 'POST', json: { reason } },
    ),
  config: () => request<ServiceConfig>('/api/config'),
  bootstrapLocalChatWorkspace: () =>
    request<LocalChatWorkspace>('/api/chat-workspace/bootstrap', {
      method: 'POST',
      json: {},
    }),
  listConversations: (personaId: string) =>
    request<ConversationPage>(
      `/api/conversations?${new URLSearchParams({
        personaId,
        status: 'active',
        limit: '100',
      })}`,
    ),
  createConversation: (input: {
    idempotencyKey: string;
    personaId: string;
    title: string;
  }) =>
    request<Conversation>('/api/conversations', {
      method: 'POST',
      json: { ...input, projectId: null },
    }),
  updateConversation: (
    id: string,
    input: { expectedVersion: number; title: string },
  ) =>
    request<Conversation>(
      `/api/conversations/${encodeURIComponent(id)}`,
      { method: 'PATCH', json: input },
    ),
  conversationMessages: (id: string) =>
    request<ConversationMessagePage>(
      `/api/conversations/${encodeURIComponent(id)}/messages?limit=100`,
    ),
  streamConversationMessage,
  listMemories: (filters: {
    query?: string;
    namespace?: string;
    scopeType?: Memory['scopeType'] | '';
    scopeKey?: string;
    kind?: MemoryKind | '';
    status?: MemoryStatus | '';
  }) => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    params.set('limit', '200');
    return request<MemoryList>(`/api/memories?${params}`);
  },
  memory: (id: string) =>
    request<MemoryDetail>(`/api/memories/${id}`),
  pinMemory: (id: string, pinned: boolean) =>
    request<MemoryGovernance>(`/api/memories/${id}/pin`, {
      method: 'POST',
      json: { pinned },
    }),
  archiveMemory: (id: string, reason: string) =>
    request<MemoryGovernance>(`/api/memories/${id}/archive`, {
      method: 'POST',
      json: { reason },
    }),
  unarchiveMemory: (id: string) =>
    request<MemoryGovernance>(`/api/memories/${id}/unarchive`, {
      method: 'POST',
    }),
  setMemoryTtl: (id: string, expiresAt: string | null) =>
    request<MemoryGovernance>(`/api/memories/${id}/ttl`, {
      method: 'POST',
      json: { expiresAt },
    }),
  revertMemory: (id: string, versionId: string) =>
    request<Memory>(`/api/memories/${id}/revert`, {
      method: 'POST',
      json: { versionId },
    }),
  purgeMemory: (id: string, reason: string) =>
    request<PurgeJob>(`/api/memories/${id}/purge`, {
      method: 'POST',
      json: { reason },
    }),
  createMemory: (input: Partial<Memory> & {
    content: string;
    kind: MemoryKind;
  }) =>
    request<{ memory: Memory; created: boolean; deduplicated: boolean }>(
      '/api/memories',
      { method: 'POST', json: input },
    ),
  updateMemory: (id: string, input: Partial<Memory>) =>
    request<Memory>(`/api/memories/${id}`, {
      method: 'PATCH',
      json: input,
    }),
  deleteMemory: (id: string, reason?: string) =>
    request<Memory>(`/api/memories/${id}`, {
      method: 'DELETE',
      json: { reason },
    }),
  restoreMemory: (
    id: string,
    confirmation?: 'replace',
    confirmationToken?: string,
  ) =>
    request<RestoreDecision>(`/api/memories/${id}/restore`, {
      method: 'POST',
      json: { confirmation, confirmationToken },
    }),
  recall: (
    query: string,
    namespace?: string,
    limit = 8,
    scopes?: MemoryAccessScope[],
  ) =>
    request<RecallResponse>('/api/recall', {
      method: 'POST',
      json: {
        query,
        namespace: namespace || undefined,
        limit,
        scopes,
      },
    }),
  recallExplanations: () =>
    request<RecallExplanation[]>('/api/recalls?limit=100'),
  retrievalTrace: (traceId: string) =>
    request<RetrievalTraceDetail>(
      `/api/retrieval-traces/${encodeURIComponent(traceId)}`,
    ),
  candidates: () =>
    request<CandidateInboxItem[]>('/api/candidates?limit=200'),
  acceptCandidate: (
    id: string,
    input: { content?: string; value?: string },
  ) =>
    request<CandidateResolution>(`/api/candidates/${id}/accept`, {
      method: 'POST',
      json: input,
    }),
  rejectCandidate: (id: string, blockFuture = false) =>
    request<CandidateResolution>(`/api/candidates/${id}/reject`, {
      method: 'POST',
      json: { blockFuture },
    }),
  reflectionStatus: (namespace = 'personal') =>
    request<ReflectionStatus>(
      `/api/reflection/status?namespace=${encodeURIComponent(namespace)}`,
    ),
  reflectionRuns: (limit = 100) =>
    request<ReflectionRun[]>(`/api/reflection/runs?limit=${limit}`),
  reflectionRun: (id: string) =>
    request<ReflectionRunDetail>(`/api/reflection/runs/${id}`),
  setReflectionMode: (namespace: string, mode: 'off' | 'shadow') =>
    request<ReflectionStatus>('/api/reflection/settings', {
      method: 'PUT',
      json: { namespace, mode },
    }),
  previewReflection: (input: {
    namespace: string;
    scopeType: MemoryAccessScope['scopeType'];
    scopeKey: string;
  }) => request<ReflectionPreview>('/api/reflection/preview', {
    method: 'POST',
    json: input,
  }),
  queueReflection: (
    runType: 'reextract' | 'reflect',
    input: {
      namespace: string;
      scopeType: MemoryAccessScope['scopeType'];
      scopeKey: string;
    },
  ) => request<QueuedReflectionRun>(
    runType === 'reflect'
      ? '/api/reflection/run'
      : '/api/reflection/reextract',
    {
      method: 'POST',
      json: { ...input, confirmed: true },
    },
  ),
  retryReflectionRun: (id: string) =>
    request<ReflectionRun>(`/api/reflection/runs/${id}/retry`, {
      method: 'POST',
    }),
  cancelReflectionRun: (id: string) =>
    request<ReflectionRun>(`/api/reflection/runs/${id}/cancel`, {
      method: 'POST',
    }),
  actionRequests: () =>
    request<MemoryActionRequest[]>(
      '/api/action-requests?limit=200',
    ),
  acceptActionRequest: (
    id: string,
    input: {
      memoryId?: string;
      content?: string;
      value?: string;
    },
  ) =>
    request<MemoryActionReviewResult>(
      `/api/action-requests/${id}/accept`,
      { method: 'POST', json: input },
    ),
  rejectActionRequest: (id: string, blockFuture = false) =>
    request<MemoryActionReviewResult>(
      `/api/action-requests/${id}/reject`,
      {
        method: 'POST',
        json: { blockFuture },
      },
    ),
  systemHealth: () =>
    request<SystemHealthSnapshot>('/api/system-health'),
  consolidations: () =>
    request<ConsolidationSummary[]>('/api/consolidations'),
  tombstones: () => request<Tombstone[]>('/api/tombstones'),
  purgeJobs: () => request<PurgeJob[]>('/api/purge-jobs'),
  retentionPolicies: () =>
    request<RetentionPolicy[]>('/api/retention-policies'),
  saveRetentionPolicy: (input: {
    namespace: string;
    kind: MemoryKind | null;
    evidenceTtlDays: number | null;
    halfLifeDays: number | null;
    autoArchive: boolean;
  }) =>
    request<RetentionPolicy>('/api/retention-policies', {
      method: 'PUT',
      json: input,
    }),
  recordFeedback: (
    memoryId: string,
    feedback: 'used' | 'confirmed' | 'rejected',
  ) =>
    request<MemoryGovernance>('/api/feedback', {
      method: 'POST',
      json: { memoryId, feedback },
    }),
  audits: () => request<AuditRecord[]>('/api/audit?limit=200'),
  downloadBackup: async () => {
    const requestTokenRevision = accessTokenRevision;
    const response = await fetch('/api/export', {
      headers: requestHeaders(),
    });
    await requireSuccessfulResponse(response, requestTokenRevision);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `memory-bridge-backup-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(objectUrl);
  },
  importBackup: (payload: unknown) =>
    request<{
      imported: number;
      deduplicated: number;
      skipped: number;
      relationCount: number;
      auditCount: number;
      idempotencyKeyCount: number;
    }>('/api/import', { method: 'POST', json: payload }),
};
