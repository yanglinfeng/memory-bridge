import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { CandidateResolver } from './candidate-resolver.js';
import {
  alignSourceExcerpt,
  CREDENTIAL_PATTERN,
} from './memory-extractor.js';
import {
  LifecycleStore,
  type ConversationIdentityStatus,
  type MemoryCandidate,
  type MemoryCandidateInput,
} from './lifecycle-store.js';
import { MemoryStore } from './memory-store.js';
import { beginForegroundActivity } from './model-qos.js';
import {
  MEMORY_KINDS,
  type MemoryAccessScope,
  type MemoryScopeType,
} from './types.js';

type DatabaseRow = Record<string, unknown>;

export type ExplicitMemoryAction =
  | 'remember'
  | 'correct'
  | 'forget';

export type ExplicitMemoryActionStatus =
  | 'pending'
  | 'completed'
  | 'rejected'
  | 'failed';

const intentCandidateSchema = z.object({
  kind: z.enum(MEMORY_KINDS),
  subject: z.string().min(1).max(100),
  predicate: z.string().min(1).max(100),
  value: z.string().min(1).max(1000),
  content: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  importance: z.number().min(0).max(1),
  sensitivity: z.enum(['normal', 'sensitive', 'credential']),
  scopeType: z
    .enum(['personal', 'project', 'role', 'session'])
    .default('personal'),
  scopeKey: z.string().min(1).max(200).default('self'),
  sourceExcerpt: z.string().max(1000).default(''),
}).strict();

const explicitIntentSchema = z.object({
  action: z.enum(['none', 'remember', 'correct', 'forget']),
  confidence: z.number().min(0).max(1),
  sensitivity: z.enum(['normal', 'sensitive', 'credential']),
  targetQuery: z.string().max(1000).default(''),
  candidate: intentCandidateSchema.nullable(),
  rationale: z.string().max(500).default(''),
}).strict();

export type ExplicitMemoryIntentDecision = z.infer<
  typeof explicitIntentSchema
>;

export interface ExplicitMemoryIntentProvider {
  readonly model: string;
  readonly promptVersion: string;
  classify(
    userText: string,
    actionHint: ExplicitMemoryAction,
  ): Promise<ExplicitMemoryIntentDecision>;
}

export interface ExplicitMemoryIntentInput {
  userId: string;
  namespace: string;
  personaId?: string | null;
  identitySource?: string;
  identityStatus?: ConversationIdentityStatus;
  roundId?: string | null;
  trustedProjectId?: string | null;
  scopes?: MemoryAccessScope[];
  clientName: string;
  sessionExternalId: string;
  userTurnExternalId: string;
  userText: string;
}

export interface ExplicitMemoryIntentResult {
  detected: boolean;
  action: ExplicitMemoryAction | 'none';
  status: ExplicitMemoryActionStatus | 'none';
  suppressRecall: boolean;
  preRecordedUser: boolean;
  actionRequestId: string | null;
  memoryId: string | null;
  candidateId: string | null;
  reason: string;
}

export interface OllamaExplicitMemoryIntentOptions {
  baseUrl: string;
  model: string;
  promptVersion: string;
  timeoutMs: number;
  keepAlive?: string | number;
  fetchImpl?: typeof fetch;
}

const INTENT_FORMAT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['none', 'remember', 'correct', 'forget'],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    sensitivity: {
      type: 'string',
      enum: ['normal', 'sensitive', 'credential'],
    },
    targetQuery: { type: 'string' },
    candidate: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: MEMORY_KINDS },
            subject: { type: 'string' },
            predicate: { type: 'string' },
            value: { type: 'string' },
            content: { type: 'string' },
            confidence: {
              type: 'number',
              minimum: 0,
              maximum: 1,
            },
            importance: {
              type: 'number',
              minimum: 0,
              maximum: 1,
            },
            sensitivity: {
              type: 'string',
              enum: ['normal', 'sensitive', 'credential'],
            },
            scopeType: {
              type: 'string',
              enum: ['personal', 'project', 'role', 'session'],
            },
            scopeKey: { type: 'string' },
            sourceExcerpt: { type: 'string' },
          },
          required: [
            'kind',
            'subject',
            'predicate',
            'value',
            'content',
            'confidence',
            'importance',
            'sensitivity',
            'scopeType',
            'scopeKey',
            'sourceExcerpt',
          ],
        },
      ],
    },
    rationale: { type: 'string' },
  },
  required: [
    'action',
    'confidence',
    'sensitivity',
    'targetQuery',
    'candidate',
    'rationale',
  ],
} as const;

const INTENT_CANDIDATE_FORMAT =
  INTENT_FORMAT.properties.candidate.anyOf[1];

const INTENT_SYSTEM_PROMPT = `
你是本地长期记忆系统的同步意图分类器。

只处理三类用户明确动作：
- remember：用户明确要求长期保存一条事实或偏好。
- correct：用户明确表示原有事实已改变或之前的值错误。
- forget：用户明确要求删除、忘掉或以后不要再记某项信息。
- 其他情况返回 none；普通自然陈述由后台提取器处理。

actionHint 只是确定性触发提示，仍需核对原文。
remember/correct 的 candidate 绝不能为 null；forget 只返回用于查找
现有记忆的 targetQuery，candidate 必须为 null。correct 的 targetQuery
必须描述旧事实，candidate 必须只描述新事实。candidate.predicate 是
“主要编辑器”“软件首次打开数据原则”这类稳定属性，禁止使用
“变更”“纠正”“更新”等动作词作为谓词。
candidate.content 只能有一句当前事实，禁止包含旧值、变更过程、
解释、致谢或其他属性。
sourceExcerpt 必须逐字来自原文。不得推测。
密码、验证码、令牌、API Key、Cookie、私钥等标记为 credential。

纠正示例：
原文：我以前主要用 VS Code，现在改用 Cursor。
targetQuery：主要编辑器 VS Code
candidate.predicate：主要编辑器
candidate.value：Cursor
candidate.content：用户现在主要使用 Cursor。

只输出结构化 JSON，不要复述敏感值。
`.trim();

const INTENT_CANDIDATE_REPAIR_PROMPT = `
你只负责从用户明确的记住或纠正请求中补齐一个原子长期记忆候选。
输出必须是 candidate 对象，不能输出 null。

纠正时只描述新事实：
- predicate 必须是稳定属性，不能包含“变更、纠正、更新”等动作词。
- value 只写新值。
- content 写成简洁的当前事实。
- sourceExcerpt 必须逐字复制自用户原文。
- 不得把旧值写入新 content，不得补充原文没有的信息。

若原文是“项目原则变了：第一次打开不再要求空数据，今后应该自动
导入一套最小示例数据”，predicate 应是“软件首次打开数据原则”，
value 应是“自动导入最小示例数据”。
只输出结构化 JSON。
`.trim();

const FORGET_GATE =
  /(?:忘(?:记|掉)|别再记|不要再记|不许再记|清除.{0,24}(?:记忆|偏好|信息)|删除.{0,24}(?:记忆|偏好|信息))/iu;
const CORRECT_GATE =
  /(?:纠正|更正|改(?:成|为|用)|换(?:成|为|用)|不再.{0,80}|不用.{0,80}了|不是.{0,80}而是|之前.{0,80}现在|现在(?:改用|换用)|其实.{0,80}(?:是|用)|(?:原则|偏好|要求|习惯|信息|决定|配置|做法).{0,12}(?:变了|改变(?:了)?|变更(?:了)?|更新(?:了)?))/iu;
const REMEMBER_GATE =
  /(?:请?记(?:住|一下)|帮我记|长期(?:记住|保存)|以后(?:都|请|要).{0,40}(?:记住|按这个|这样做))/iu;
const SENSITIVE_CONTEXT_PATTERN =
  /(?:健康|疾病|病史|诊断|用药|复诊|怀孕|残疾|心理|住址|地址|电话|手机|邮箱|身份证|护照|银行卡|银行账户|收入|工资|财务|债务|宗教|政治|性取向|性别身份|婚姻|家庭成员|法务|诉讼|犯罪|生物识别|指纹|人脸|声纹)/iu;

function cleanText(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim()
    : '';
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeCandidateScoreFields(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const candidate = value as Record<string, unknown>;
  return {
    ...candidate,
    confidence:
      typeof candidate.confidence === 'number'
        ? clamp(candidate.confidence)
        : candidate.confidence,
    importance:
      typeof candidate.importance === 'number'
        ? clamp(candidate.importance)
        : candidate.importance,
  };
}

function normalizeIntentScoreFields(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const decision = value as Record<string, unknown>;
  return {
    ...decision,
    confidence:
      typeof decision.confidence === 'number'
        ? clamp(decision.confidence)
        : decision.confidence,
    candidate:
      decision.candidate === null
        ? null
        : normalizeCandidateScoreFields(decision.candidate),
  };
}

function atomicCorrectionContent(
  candidate: z.infer<typeof intentCandidateSchema>,
): string {
  const subject = cleanText(candidate.subject);
  const predicate = cleanText(candidate.predicate);
  const value = cleanText(candidate.value).replace(/[。.!！]+$/u, '');
  return `${subject}的${predicate}是${value}。`;
}

function candidateNormalizedKey(
  subject: string,
  predicate: string,
): string {
  return [subject, predicate]
    .map((value) => cleanText(value).toLocaleLowerCase('zh-CN'))
    .join('::');
}

function canonicalCorrectionKeyPart(
  value: string,
  stripTemporalPrefix = false,
): string {
  let normalized = cleanText(value)
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  if (stripTemporalPrefix) {
    normalized = normalized.replace(
      /^(?:(?:当前|现在|目前|最新)(?:的)?)+/u,
      '',
    );
  }
  return normalized;
}

function correctionPredicateIdentity(
  predicateKey: string,
): { subject: string; predicate: string } | null {
  const separator = predicateKey.indexOf('::');
  if (separator <= 0 || separator >= predicateKey.length - 2) {
    return null;
  }
  return {
    subject: canonicalCorrectionKeyPart(
      predicateKey.slice(0, separator),
    ),
    predicate: canonicalCorrectionKeyPart(
      predicateKey.slice(separator + 2),
      true,
    ),
  };
}

function trustedCandidateScope(
  input: ExplicitMemoryIntentInput,
  candidate: z.infer<typeof intentCandidateSchema>,
): Pick<
  z.infer<typeof intentCandidateSchema>,
  'scopeType' | 'scopeKey'
> {
  if (candidate.scopeType === 'personal') {
    return { scopeType: 'personal', scopeKey: 'self' };
  }
  if (candidate.scopeType === 'project') {
    if (
      input.identityStatus === 'complete' &&
      input.trustedProjectId
    ) {
      return {
        scopeType: 'project',
        scopeKey: input.trustedProjectId,
      };
    }
    return { scopeType: 'project', scopeKey: 'unbound' };
  }
  if (input.identityStatus === 'complete') {
    if (candidate.scopeType === 'role') {
      if (!input.personaId) {
        throw new Error('role 候选缺少可信 personaId');
      }
      return {
        scopeType: 'role',
        scopeKey: input.personaId,
      };
    }
    if (candidate.scopeType === 'session') {
      return {
        scopeType: 'session',
        scopeKey: input.sessionExternalId,
      };
    }
  }
  return {
    scopeType: candidate.scopeType,
    scopeKey: candidate.scopeKey,
  };
}

function trustedIntentScopes(
  input: ExplicitMemoryIntentInput,
): MemoryAccessScope[] {
  const scopes: MemoryAccessScope[] = [
    { scopeType: 'personal', scopeKey: 'self' },
  ];
  if (
    input.identityStatus === 'complete' &&
    input.personaId &&
    input.sessionExternalId
  ) {
    scopes.push(
      { scopeType: 'role', scopeKey: input.personaId },
      { scopeType: 'session', scopeKey: input.sessionExternalId },
    );
    if (input.trustedProjectId) {
      scopes.push({
        scopeType: 'project',
        scopeKey: input.trustedProjectId,
      });
    }
  }
  return scopes;
}

function normalizeCandidateSensitivity(
  text: string,
  decision: ExplicitMemoryIntentDecision,
  candidate: z.infer<typeof intentCandidateSchema>,
): 'normal' | 'sensitive' | 'credential' {
  if (
    decision.sensitivity === 'credential' ||
    candidate.sensitivity === 'credential'
  ) {
    return 'credential';
  }
  if (
    decision.sensitivity === 'sensitive' ||
    candidate.sensitivity === 'sensitive'
  ) {
    return SENSITIVE_CONTEXT_PATTERN.test([
      text,
      candidate.subject,
      candidate.predicate,
      candidate.value,
      candidate.content,
    ].join('\n'))
      ? 'sensitive'
      : 'normal';
  }
  return 'normal';
}

function normalizeForgetSensitivity(
  text: string,
  decision: ExplicitMemoryIntentDecision,
): 'normal' | 'sensitive' | 'credential' {
  if (decision.sensitivity === 'credential') return 'credential';
  if (
    decision.sensitivity === 'sensitive' &&
    SENSITIVE_CONTEXT_PATTERN.test([
      text,
      decision.targetQuery,
    ].join('\n'))
  ) {
    return 'sensitive';
  }
  return 'normal';
}

function gateAction(text: string): ExplicitMemoryAction | null {
  if (FORGET_GATE.test(text)) return 'forget';
  if (CORRECT_GATE.test(text)) return 'correct';
  if (REMEMBER_GATE.test(text)) return 'remember';
  return null;
}

function emptyResult(
  reason: string,
): ExplicitMemoryIntentResult {
  return {
    detected: false,
    action: 'none',
    status: 'none',
    suppressRecall: false,
    preRecordedUser: false,
    actionRequestId: null,
    memoryId: null,
    candidateId: null,
    reason,
  };
}

export class OllamaExplicitMemoryIntentProvider
implements ExplicitMemoryIntentProvider {
  readonly model: string;
  readonly promptVersion: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly keepAlive: string | number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaExplicitMemoryIntentOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.model = options.model;
    this.promptVersion = options.promptVersion;
    this.timeoutMs = Math.max(1_000, options.timeoutMs);
    this.keepAlive = options.keepAlive ?? '15m';
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async classify(
    userText: string,
    actionHint: ExplicitMemoryAction,
  ): Promise<ExplicitMemoryIntentDecision> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          stream: false,
          think: false,
          keep_alive: this.keepAlive,
          format: INTENT_FORMAT,
          options: {
            temperature: 0,
            seed: 42,
            num_predict: 900,
          },
          messages: [
            { role: 'system', content: INTENT_SYSTEM_PROMPT },
            {
              role: 'user',
              content: JSON.stringify({
                actionHint,
                message: userText,
              }),
            },
          ],
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Ollama 记忆意图分类失败：${response.status} ` +
        await response.text(),
      );
    }
    const payload = await response.json() as {
      message?: { content?: unknown };
    };
    if (typeof payload.message?.content !== 'string') {
      throw new Error('Ollama 记忆意图分类没有返回文本结果');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.message.content);
    } catch {
      throw new Error('Ollama 记忆意图分类返回的 JSON 无法解析');
    }
    const result = explicitIntentSchema.safeParse(
      normalizeIntentScoreFields(parsed),
    );
    if (!result.success) {
      throw new Error(
        `Ollama 记忆意图分类结果无效：` +
        (result.error.issues[0]?.message || '未知错误'),
      );
    }
    const decision = result.data;
    if (
      (decision.action === 'remember' ||
        decision.action === 'correct') &&
      !decision.candidate
    ) {
      try {
        const candidate = await this.repairCandidate(
          userText,
          decision.action,
          decision.targetQuery,
        );
        if (candidate) return { ...decision, candidate };
      } catch {
        // 保留原始分类结果，让服务进入待确认，而不是静默创建记忆。
      }
    }
    return decision;
  }

  private async repairCandidate(
    userText: string,
    action: 'remember' | 'correct',
    targetQuery: string,
  ): Promise<z.infer<typeof intentCandidateSchema> | null> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          stream: false,
          think: false,
          keep_alive: this.keepAlive,
          format: INTENT_CANDIDATE_FORMAT,
          options: {
            temperature: 0,
            seed: 43,
            num_predict: 700,
          },
          messages: [
            {
              role: 'system',
              content: INTENT_CANDIDATE_REPAIR_PROMPT,
            },
            {
              role: 'user',
              content: JSON.stringify({
                action,
                targetQuery,
                message: userText,
              }),
            },
          ],
        }),
      },
    );
    if (!response.ok) return null;
    const payload = await response.json() as {
      message?: { content?: unknown };
    };
    if (typeof payload.message?.content !== 'string') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.message.content);
    } catch {
      return null;
    }
    const candidate = intentCandidateSchema.safeParse(
      normalizeCandidateScoreFields(parsed),
    );
    return candidate.success ? candidate.data : null;
  }
}

export class ExplicitMemoryIntentService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly lifecycleStore: LifecycleStore,
    private readonly memoryStore: MemoryStore,
    private readonly candidateResolver: CandidateResolver,
    private readonly provider: ExplicitMemoryIntentProvider,
  ) {}

  async handle(
    input: ExplicitMemoryIntentInput,
  ): Promise<ExplicitMemoryIntentResult> {
    const releaseForeground = beginForegroundActivity();
    try {
      return await this.handleWithForegroundLease(input);
    } finally {
      releaseForeground();
    }
  }

  private async handleWithForegroundLease(
    input: ExplicitMemoryIntentInput,
  ): Promise<ExplicitMemoryIntentResult> {
    const sourceText = input.userText.trim();
    const text = cleanText(sourceText);
    const actionHint = gateAction(text);
    if (!actionHint) return emptyResult('no_explicit_intent_gate');
    const requestKey = [
      input.sessionExternalId,
      input.userTurnExternalId,
    ].join('\n');
    const existing = this.findRequest(
      input.userId,
      input.namespace,
      requestKey,
    );
    if (existing) return this.rowResult(existing);

    const actionRequestId = randomUUID();
    const createdAt = new Date().toISOString();
    const inserted = this.database
      .prepare(
        `INSERT INTO memory_action_requests (
           id, user_id, namespace, request_key, action, status,
           model, prompt_version, created_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
         ON CONFLICT(user_id, namespace, request_key) DO NOTHING`,
      )
      .run(
        actionRequestId,
        input.userId,
        input.namespace,
        requestKey,
        actionHint,
        this.provider.model,
        this.provider.promptVersion,
        createdAt,
      );
    if (Number(inserted.changes) !== 1) {
      const replayed = this.findRequest(
        input.userId,
        input.namespace,
        requestKey,
      );
      if (!replayed) throw new Error('无法读取并发记忆意图请求');
      return this.rowResult(replayed);
    }

    CREDENTIAL_PATTERN.lastIndex = 0;
    if (CREDENTIAL_PATTERN.test(text)) {
      this.finishRequest(actionRequestId, {
        status: 'rejected',
        sensitivity: 'credential',
        rationale: 'credential_content_blocked',
      });
      return {
        detected: true,
        action: actionHint,
        status: 'rejected',
        suppressRecall:
          actionHint === 'forget' || actionHint === 'correct',
        preRecordedUser: false,
        actionRequestId,
        memoryId: null,
        candidateId: null,
        reason: 'credential_content_blocked',
      };
    }

    let turnId: string | null = null;
    try {
      const turn = this.lifecycleStore.recordTurn({
        userId: input.userId,
        namespace: input.namespace,
        personaId: input.personaId,
        projectId:
          input.identityStatus === 'complete'
            ? input.trustedProjectId || null
            : null,
        identitySource: input.identitySource,
        identityStatus: input.identityStatus,
        roundId: input.roundId,
        clientName: input.clientName,
        sessionExternalId: input.sessionExternalId,
        turnExternalId: input.userTurnExternalId,
        role: 'user',
        content: sourceText,
        metadata: {
          explicitMemoryIntent: actionHint,
          explicitMemoryActionRequestId: actionRequestId,
          trustedProjectId:
            input.identityStatus === 'complete'
              ? input.trustedProjectId || null
              : null,
          skipAutoExtraction: true,
        },
      }).turn;
      turnId = turn.id;
      this.database
        .prepare(
          `UPDATE memory_action_requests
           SET turn_id = ?
           WHERE id = ?`,
        )
        .run(turnId, actionRequestId);

      const decision = await this.provider.classify(text, actionHint);
      if (
        decision.action === 'none' ||
        decision.action !== actionHint
      ) {
        const status =
          actionHint === 'forget' || actionHint === 'correct'
            ? 'pending'
            : 'rejected';
        this.finishRequest(actionRequestId, {
          status,
          confidence: decision.confidence,
          sensitivity: decision.sensitivity,
          rationale: cleanText(decision.rationale) ||
            'classifier_did_not_confirm_gate',
        });
        return {
          detected: true,
          action: actionHint,
          status,
          suppressRecall:
            actionHint === 'forget' || actionHint === 'correct',
          preRecordedUser: true,
          actionRequestId,
          memoryId: null,
          candidateId: null,
          reason: 'classifier_did_not_confirm_gate',
        };
      }

      if (actionHint === 'forget') {
        return await this.handleForget(
          input,
          actionRequestId,
          decision,
        );
      }
      return await this.handleRememberOrCorrect(
        input,
        actionRequestId,
        turnId,
        decision,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return this.rowResult(
        this.failRequestPreservingContext(
          actionRequestId,
          message,
          input.userId,
          input.namespace,
          actionHint,
        ),
      );
    }
  }

  private async handleForget(
    input: ExplicitMemoryIntentInput,
    actionRequestId: string,
    decision: ExplicitMemoryIntentDecision,
  ): Promise<ExplicitMemoryIntentResult> {
    const query = cleanText(decision.targetQuery);
    const sensitivity = normalizeForgetSensitivity(
      input.userText,
      decision,
    );
    const authorizedScopes = trustedIntentScopes(input);
    if (
      decision.confidence < 0.95 ||
      sensitivity !== 'normal' ||
      !query
    ) {
      this.finishRequest(actionRequestId, {
        status: 'pending',
        targetQuery: query,
        confidence: decision.confidence,
        sensitivity,
        rationale: cleanText(decision.rationale) ||
          'forget_requires_confirmation',
      });
      return {
        detected: true,
        action: 'forget',
        status: 'pending',
        suppressRecall: true,
        preRecordedUser: true,
        actionRequestId,
        memoryId: null,
        candidateId: null,
        reason: 'forget_requires_confirmation',
      };
    }
    const pendingMatches = this.findPendingForgetCandidates(
      input,
      query,
      authorizedScopes,
    );
    if (pendingMatches.length > 1) {
      this.finishRequest(actionRequestId, {
        status: 'pending',
        targetQuery: query,
        confidence: decision.confidence,
        sensitivity,
        rationale: 'forget_pending_candidate_ambiguous',
      });
      return {
        detected: true,
        action: 'forget',
        status: 'pending',
        suppressRecall: true,
        preRecordedUser: true,
        actionRequestId,
        memoryId: null,
        candidateId: null,
        reason: 'forget_pending_candidate_ambiguous',
      };
    }
    if (pendingMatches.length === 1) {
      const pendingCandidate = pendingMatches[0];
      const ownsTransaction = !this.database.isTransaction;
      if (ownsTransaction) this.database.exec('BEGIN IMMEDIATE');
      try {
        const current = this.lifecycleStore.getCandidate(
          pendingCandidate.id,
          input.userId,
          input.namespace,
        );
        if (!current || current.state !== 'pending') {
          throw new Error('待遗忘候选已被其他流程处理');
        }
        this.candidateResolver.rejectForReview(current.id, true);
        this.finishRequest(
          actionRequestId,
          {
            status: 'completed',
            targetQuery: query,
            targetMemoryId: null,
            candidateId: current.id,
            confidence: decision.confidence,
            sensitivity,
            rationale: 'explicit_forget_pending_candidate_completed',
          },
          {
            userId: input.userId,
            namespace: input.namespace,
            action: 'forget',
          },
        );
        if (ownsTransaction) this.database.exec('COMMIT');
      } catch (error) {
        if (ownsTransaction && this.database.isTransaction) {
          this.database.exec('ROLLBACK');
        }
        throw error;
      }
      return {
        detected: true,
        action: 'forget',
        status: 'completed',
        suppressRecall: true,
        preRecordedUser: true,
        actionRequestId,
        memoryId: null,
        candidateId: pendingCandidate.id,
        reason: 'explicit_forget_pending_candidate_completed',
      };
    }
    let recallFailure: string | null = null;
    let recalled: Awaited<
      ReturnType<MemoryStore['recallReliable']>
    >;
    try {
      recalled = await this.memoryStore.recallReliable({
        query,
        userId: input.userId,
        namespace: input.namespace,
        scopes: authorizedScopes,
        includeArchived: true,
        allowedSensitivities: ['normal', 'sensitive'],
        limit: 8,
        minScore: 0.15,
      });
    } catch (error) {
      recallFailure = error instanceof Error
        ? error.message
        : String(error);
      recalled = this.memoryStore.recall({
        query,
        userId: input.userId,
        namespace: input.namespace,
        scopes: authorizedScopes,
        includeArchived: true,
        allowedSensitivities: ['normal', 'sensitive'],
        limit: 8,
        minScore: 0.15,
      });
    }
    const viable = recalled.filter((result) => result.score >= 0.15);
    const target = viable.length === 1
      ? viable[0]
      : viable.length > 1 &&
          viable[0].score >= 0.8 &&
          viable[0].score - viable[1].score >= 0.2
        ? viable[0]
        : null;
    if (!target) {
      const targetReason = viable.length === 0
        ? 'forget_target_not_found'
        : 'forget_target_ambiguous';
      this.finishRequest(actionRequestId, {
        status: 'pending',
        targetQuery: query,
        confidence: decision.confidence,
        sensitivity,
        rationale: recallFailure
          ? `${targetReason}_local_fallback`
          : targetReason,
        error: recallFailure || undefined,
      });
      return {
        detected: true,
        action: 'forget',
        status: 'pending',
        suppressRecall: true,
        preRecordedUser: true,
        actionRequestId,
        memoryId: null,
        candidateId: null,
        reason: recallFailure
          ? `${targetReason}_local_fallback`
          : targetReason,
      };
    }
    const completion = {
      status: 'completed',
      targetQuery: query,
      confidence: decision.confidence,
      sensitivity,
      rationale: recallFailure
        ? 'explicit_forget_completed_local_fallback'
        : cleanText(decision.rationale) ||
          'explicit_forget_completed',
      error: recallFailure || undefined,
    } as const;
    const forgotten = this.memoryStore.forget(
      target.memory.id,
      '用户在自然对话中明确要求遗忘',
      input.userId,
      {
        expectedNamespace: input.namespace,
        authorizedScopes,
        beforeCommit: (deleted) => {
          this.finishRequest(
            actionRequestId,
            {
              ...completion,
              targetMemoryId: deleted.id,
            },
            {
              userId: input.userId,
              namespace: input.namespace,
              action: 'forget',
            },
          );
        },
      },
    );
    return {
      detected: true,
      action: 'forget',
      status: 'completed',
      suppressRecall: true,
      preRecordedUser: true,
      actionRequestId,
      memoryId: forgotten.id,
      candidateId: null,
      reason: recallFailure
        ? 'explicit_forget_completed_local_fallback'
        : 'explicit_forget_completed',
    };
  }

  private findPendingForgetCandidates(
    input: ExplicitMemoryIntentInput,
    query: string,
    authorizedScopes: MemoryAccessScope[],
  ): MemoryCandidate[] {
    if (authorizedScopes.length === 0) return [];
    const scopeWhere = authorizedScopes
      .map(() => '(scope_type = ? AND scope_key = ?)')
      .join(' OR ');
    const rows = this.database.prepare(
      `SELECT id
       FROM memory_candidates
       WHERE user_id = ? AND namespace = ? AND state = 'pending'
         AND (${scopeWhere})
       ORDER BY created_at ASC, id ASC`,
    ).all(
      input.userId,
      input.namespace,
      ...authorizedScopes.flatMap((scope) => [
        scope.scopeType,
        scope.scopeKey,
      ]),
    ) as DatabaseRow[];
    const explicitText = `${input.userText}\n${query}`
      .normalize('NFKC');
    return rows
      .map((row) => this.lifecycleStore.getCandidate(
        asText(row.id),
        input.userId,
        input.namespace,
      ))
      .filter((candidate): candidate is MemoryCandidate => {
        if (!candidate) return false;
        const value = candidate.value.normalize('NFKC').trim();
        return value.length > 0 && explicitText.includes(value);
      });
  }

  private async handleRememberOrCorrect(
    input: ExplicitMemoryIntentInput,
    actionRequestId: string,
    turnId: string,
    decision: ExplicitMemoryIntentDecision,
  ): Promise<ExplicitMemoryIntentResult> {
    const candidate = decision.candidate;
    if (!candidate) {
      this.finishRequest(actionRequestId, {
        status: 'pending',
        targetQuery: cleanText(decision.targetQuery),
        confidence: decision.confidence,
        sensitivity: decision.sensitivity,
        rationale: 'explicit_intent_candidate_missing',
      });
      return {
        detected: true,
        action: decision.action as ExplicitMemoryAction,
        status: 'pending',
        suppressRecall: decision.action === 'correct',
        preRecordedUser: true,
        actionRequestId,
        memoryId: null,
        candidateId: null,
        reason: 'explicit_intent_candidate_missing',
      };
    }
    CREDENTIAL_PATTERN.lastIndex = 0;
    if (
      decision.sensitivity === 'credential' ||
      candidate.sensitivity === 'credential' ||
      CREDENTIAL_PATTERN.test([
        candidate.predicate,
        candidate.value,
        candidate.content,
      ].join('\n'))
    ) {
      this.finishRequest(actionRequestId, {
        status: 'rejected',
        confidence: decision.confidence,
        sensitivity: 'credential',
        rationale: 'credential_candidate_blocked',
      });
      return {
        detected: true,
        action: decision.action as ExplicitMemoryAction,
        status: 'rejected',
        suppressRecall: decision.action === 'correct',
        preRecordedUser: true,
        actionRequestId,
        memoryId: null,
        candidateId: null,
        reason: 'credential_candidate_blocked',
      };
    }
    const candidateContent =
      decision.action === 'correct'
        ? atomicCorrectionContent(candidate)
        : candidate.content;
    const initialScope = trustedCandidateScope(input, candidate);
    let correctionTarget: Awaited<
      ReturnType<ExplicitMemoryIntentService['findCorrectionTarget']>
    > | null = null;
    let correctionLookupError: unknown = null;
    if (decision.action === 'correct') {
      try {
        correctionTarget = await this.findCorrectionTarget(
          input,
          decision,
          {
            userId: input.userId,
            namespace: input.namespace,
            ...initialScope,
            normalizedKey: candidateNormalizedKey(
              candidate.subject,
              candidate.predicate,
            ),
            subject: candidate.subject,
            predicate: candidate.predicate,
          },
        );
      } catch (error) {
        correctionLookupError = error;
      }
    }
    const effectiveScope = decision.action === 'correct' &&
        correctionTarget?.memoryId &&
        correctionTarget.scopeType &&
        correctionTarget.scopeKey
      ? {
          scopeType: correctionTarget.scopeType,
          scopeKey: correctionTarget.scopeKey,
        }
      : initialScope;
    // Small local models can omit or paraphrase sourceExcerpt even when the
    // value is copied verbatim from an explicit remember/correct request.
    // Try the model excerpt first, then retry with the candidate value. Both
    // attempts still require one unique, direct-user substring.
    const evidenceCandidate = {
      content: candidateContent,
      value: candidate.value,
      sourceExcerpt: cleanText(candidate.sourceExcerpt),
    };
    let sourceExcerpt = alignSourceExcerpt(
      input.userText,
      evidenceCandidate,
    );
    if (!sourceExcerpt) {
      sourceExcerpt = alignSourceExcerpt(input.userText, {
        ...evidenceCandidate,
        sourceExcerpt: candidate.value,
      });
    }
    const candidateInput: MemoryCandidateInput = {
      ...candidate,
      ...effectiveScope,
      content: candidateContent,
      sensitivity: normalizeCandidateSensitivity(
        input.userText,
        decision,
        candidate,
      ),
      confidence: clamp(
        Math.min(decision.confidence, candidate.confidence),
      ),
      sourceExcerpt,
      sourceAuthority: 'direct_user',
    };
    const extractionRunId = this.lifecycleStore.startExtraction(
      turnId,
      this.provider.model,
      this.provider.promptVersion,
      'explicit-memory-intent',
      'v1',
    );
    const persisted = this.lifecycleStore.completeExtraction(
      extractionRunId,
      [candidateInput],
      {
        enqueueResolution: false,
        trustedCorrectionTargetId:
          decision.action === 'correct'
            ? correctionTarget?.memoryId || undefined
            : undefined,
      },
    );
    const persistedCandidate = persisted[0];
    if (!persistedCandidate) {
      this.finishRequest(actionRequestId, {
        status: 'rejected',
        confidence: decision.confidence,
        sensitivity: candidate.sensitivity,
        rationale: 'candidate_rejected_before_persistence',
      });
      return {
        detected: true,
        action: decision.action as ExplicitMemoryAction,
        status: 'rejected',
        suppressRecall: decision.action === 'correct',
        preRecordedUser: true,
        actionRequestId,
        memoryId: null,
        candidateId: null,
        reason: 'candidate_rejected_before_persistence',
      };
    }
    if (persistedCandidate.state === 'rejected') {
      const reason = persistedCandidate.decisionReason ||
        'candidate_rejected_before_acceptance';
      this.finishRequest(actionRequestId, {
        status: 'rejected',
        targetQuery: cleanText(decision.targetQuery),
        candidateId: persistedCandidate.id,
        candidateJson: candidateInput,
        confidence: decision.confidence,
        sensitivity: persistedCandidate.sensitivity,
        rationale: reason,
      });
      return {
        detected: true,
        action: decision.action as ExplicitMemoryAction,
        status: 'rejected',
        suppressRecall: decision.action === 'correct',
        preRecordedUser: true,
        actionRequestId,
        memoryId: null,
        candidateId: persistedCandidate.id,
        reason,
      };
    }
    this.finishRequest(actionRequestId, {
      status: 'pending',
      targetQuery: cleanText(decision.targetQuery),
      candidateId: persistedCandidate.id,
      candidateJson: candidateInput,
      confidence: decision.confidence,
      sensitivity: persistedCandidate.sensitivity,
      rationale: 'explicit_intent_candidate_staged',
    });
    if (correctionLookupError) throw correctionLookupError;
    if (
      decision.action === 'correct' &&
      !correctionTarget?.memoryId
    ) {
      const reason =
        correctionTarget?.reason || 'correct_target_not_found';
      this.finishRequest(actionRequestId, {
        status: 'pending',
        targetQuery: correctionTarget?.query ||
          cleanText(decision.targetQuery),
        candidateId: persistedCandidate.id,
        candidateJson: candidateInput,
        confidence: decision.confidence,
        sensitivity: persistedCandidate.sensitivity,
        rationale: reason,
      });
      return {
        detected: true,
        action: 'correct',
        status: 'pending',
        suppressRecall: true,
        preRecordedUser: true,
        actionRequestId,
        memoryId: null,
        candidateId: persistedCandidate.id,
        reason,
      };
    }
    if (
      decision.action === 'correct' &&
      correctionTarget?.memoryId
    ) {
      this.finishRequest(actionRequestId, {
        status: 'pending',
        targetQuery: correctionTarget.query,
        targetMemoryId: correctionTarget.memoryId,
        candidateId: persistedCandidate.id,
        candidateJson: candidateInput,
        confidence: decision.confidence,
        sensitivity: persistedCandidate.sensitivity,
        rationale: 'explicit_intent_target_staged',
      });
    }
    const requiresConfirmation =
      decision.confidence < 0.95 ||
      persistedCandidate.confidence < 0.95 ||
      persistedCandidate.sensitivity !== 'normal' ||
      !cleanText(persistedCandidate.sourceExcerpt);
    if (requiresConfirmation) {
      this.finishRequest(actionRequestId, {
        status: 'pending',
        targetQuery: correctionTarget?.query ||
          cleanText(decision.targetQuery),
        targetMemoryId: correctionTarget?.memoryId,
        candidateId: persistedCandidate.id,
        candidateJson: candidateInput,
        confidence: decision.confidence,
        sensitivity: persistedCandidate.sensitivity,
        rationale: cleanText(decision.rationale) ||
          'candidate_requires_confirmation',
      });
      return {
        detected: true,
        action: decision.action as ExplicitMemoryAction,
        status: 'pending',
        suppressRecall: decision.action === 'correct',
        preRecordedUser: true,
        actionRequestId,
        memoryId: null,
        candidateId: persistedCandidate.id,
        reason: 'candidate_requires_confirmation',
      };
    }
    const resolution = decision.action === 'correct'
      ? this.candidateResolver.acceptCorrectionForReview(
          persistedCandidate.id,
          correctionTarget!.memoryId!,
          trustedIntentScopes(input),
          { context: correctionTarget!.query },
          'rule',
        )
      : this.candidateResolver.acceptForReview(
          persistedCandidate.id,
        );
    this.finishRequest(actionRequestId, {
      status: 'completed',
      targetQuery: correctionTarget?.query ||
        cleanText(decision.targetQuery),
      targetMemoryId: resolution.memoryId,
      candidateId: persistedCandidate.id,
      candidateJson: candidateInput,
      confidence: decision.confidence,
      sensitivity: persistedCandidate.sensitivity,
      rationale: cleanText(decision.rationale) ||
        'explicit_intent_completed',
    });
    return {
      detected: true,
      action: decision.action as ExplicitMemoryAction,
      status: 'completed',
      suppressRecall: false,
      preRecordedUser: true,
      actionRequestId,
      memoryId: resolution.memoryId,
      candidateId: persistedCandidate.id,
      reason: resolution.reason,
    };
  }

  private async findCorrectionTarget(
    input: ExplicitMemoryIntentInput,
    decision: ExplicitMemoryIntentDecision,
    candidate: {
      userId: string;
      namespace: string;
      scopeType: string;
      scopeKey: string;
      normalizedKey: string;
      subject: string;
      predicate: string;
    },
  ): Promise<{
    memoryId: string | null;
    query: string;
    reason: string;
    scopeType: MemoryScopeType | null;
    scopeKey: string | null;
  }> {
    const requestedQuery = cleanText(decision.targetQuery);
    const candidateIdentity = correctionPredicateIdentity(
      candidate.normalizedKey,
    );
    if (candidateIdentity) {
      const samePredicate = this.database
        .prepare(
          `SELECT i.id, i.predicate_key, m.scope_type, m.scope_key
           FROM memory_items i
           JOIN memories m ON m.id = i.id
           WHERE i.user_id = ?
             AND i.namespace = ?
             AND i.scope_type = ?
             AND i.scope_key = ?
             AND i.status = 'active'
             AND m.status = 'active'
           ORDER BY i.updated_at DESC, i.id ASC
           LIMIT 100`,
        )
        .all(
          candidate.userId,
          candidate.namespace,
          candidate.scopeType,
          candidate.scopeKey,
        )
        .filter((row) => {
          const identity = correctionPredicateIdentity(
            asText(row.predicate_key),
          );
          return identity?.subject === candidateIdentity.subject &&
            identity.predicate === candidateIdentity.predicate;
        }) as DatabaseRow[];
      if (samePredicate.length === 1) {
        return {
          memoryId: asText(samePredicate[0].id),
          query: `${candidate.subject} ${candidate.predicate}`.trim(),
          reason: 'correct_target_canonical_predicate',
          scopeType: asText(
            samePredicate[0].scope_type,
          ) as MemoryScopeType,
          scopeKey: asText(samePredicate[0].scope_key),
        };
      }
      if (samePredicate.length > 1) {
        return {
          memoryId: null,
          query: `${candidate.subject} ${candidate.predicate}`.trim(),
          reason: 'correct_target_ambiguous',
          scopeType: null,
          scopeKey: null,
        };
      }
    }

    const query = requestedQuery ||
      `${candidate.subject} ${candidate.predicate}`.trim();
    if (!query) {
      return {
        memoryId: null,
        query: '',
        reason: 'correct_target_not_found',
        scopeType: null,
        scopeKey: null,
      };
    }
    const recalled = await this.memoryStore.recallReliable({
      query,
      userId: input.userId,
      namespace: input.namespace,
      scopes: trustedIntentScopes(input),
      allowedSensitivities: ['normal', 'sensitive'],
      limit: 8,
      minScore: 0.15,
    });
    const viable = recalled.filter((result) => result.score >= 0.15);
    const target = viable.length === 1
      ? viable[0]
      : viable.length > 1 &&
          viable[0].score >= 0.8 &&
          viable[0].score - viable[1].score >= 0.2
        ? viable[0]
        : null;
    return {
      memoryId: target?.memory.id || null,
      query,
      reason: target
        ? 'correct_target_recalled'
        : viable.length === 0
          ? 'correct_target_not_found'
          : 'correct_target_ambiguous',
      scopeType: target?.memory.scopeType || null,
      scopeKey: target?.memory.scopeKey || null,
    };
  }

  private findRequest(
    userId: string,
    namespace: string,
    requestKey: string,
  ): DatabaseRow | null {
    return (
      this.database
        .prepare(
          `SELECT *
           FROM memory_action_requests
           WHERE user_id = ? AND namespace = ? AND request_key = ?`,
        )
        .get(userId, namespace, requestKey) as
          | DatabaseRow
          | undefined
    ) || null;
  }

  private rowResult(row: DatabaseRow): ExplicitMemoryIntentResult {
    const action = asText(row.action) as ExplicitMemoryAction;
    const status = asText(row.status) as ExplicitMemoryActionStatus;
    return {
      detected: true,
      action,
      status,
      suppressRecall:
        action === 'forget' ||
        (action === 'correct' && status !== 'completed'),
      preRecordedUser: Boolean(row.turn_id),
      actionRequestId: asText(row.id),
      memoryId: cleanText(row.target_memory_id) || null,
      candidateId: cleanText(row.candidate_id) || null,
      reason:
        cleanText(row.rationale) ||
        cleanText(row.error) ||
        'explicit_intent_replayed',
    };
  }

  private finishRequest(
    id: string,
    input: {
      status: ExplicitMemoryActionStatus;
      targetQuery?: string;
      targetMemoryId?: string | null;
      candidateId?: string | null;
      candidateJson?: MemoryCandidateInput;
      confidence?: number;
      sensitivity?: 'normal' | 'sensitive' | 'credential';
      rationale?: string;
      error?: string;
    },
    guard?: {
      userId: string;
      namespace: string;
      action: ExplicitMemoryAction;
    },
  ): void {
    const resolvedAt =
      input.status === 'pending' ? null : new Date().toISOString();
    const result = this.database
      .prepare(
        `UPDATE memory_action_requests
         SET status = ?, target_query = ?,
             target_memory_id = ?, candidate_id = ?,
             candidate_json = ?, confidence = ?, sensitivity = ?,
             rationale = ?, error = ?, resolved_at = ?
         WHERE id = ?
           ${guard
             ? `AND user_id = ? AND namespace = ? AND action = ?
                AND status = 'pending' AND review_token IS NULL`
             : ''}`,
      )
      .run(
        input.status,
        cleanText(input.targetQuery),
        input.targetMemoryId || null,
        input.candidateId || null,
        input.candidateJson
          ? JSON.stringify(input.candidateJson)
          : null,
        clamp(input.confidence || 0),
        input.sensitivity || 'normal',
        cleanText(input.rationale),
        cleanText(input.error) || null,
        resolvedAt,
        id,
        ...(guard
          ? [guard.userId, guard.namespace, guard.action]
          : []),
      );
    if (guard && Number(result.changes) !== 1) {
      throw new Error('记忆动作请求已被其他流程处理');
    }
  }

  private failRequestPreservingContext(
    id: string,
    error: string,
    userId: string,
    namespace: string,
    action: ExplicitMemoryAction,
  ): DatabaseRow {
    this.database
      .prepare(
        `UPDATE memory_action_requests
         SET status = 'failed',
             rationale = 'explicit_intent_processing_failed',
             error = ?, resolved_at = ?
         WHERE id = ? AND user_id = ? AND namespace = ?
           AND action = ? AND status = 'pending'
           AND review_token IS NULL`,
      )
      .run(
        cleanText(error) || '未知错误',
        new Date().toISOString(),
        id,
        userId,
        namespace,
        action,
      );
    const row = this.database
      .prepare(
        `SELECT *
         FROM memory_action_requests
         WHERE id = ? AND user_id = ? AND namespace = ?`,
      )
      .get(id, userId, namespace) as DatabaseRow | undefined;
    if (!row) throw new Error('记忆动作请求不存在');
    return row;
  }
}

export { INTENT_FORMAT, gateAction };
