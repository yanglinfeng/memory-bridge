import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { config } from './config.js';
import { retrievalTokens } from './embedding.js';
import { LifecycleStore } from './lifecycle-store.js';
import { MemoryStore } from './memory-store.js';
import { backgroundModelAbortSignal } from './model-qos.js';
import type {
  MemoryKind,
  MemoryScopeType,
} from './types.js';

type DatabaseRow = Record<string, unknown>;

export type ConsolidationScopeType =
  | 'session'
  | 'topic'
  | 'person'
  | 'project';

export interface ConsolidationScope {
  userId: string;
  namespace: string;
  scopeType: ConsolidationScopeType;
  scopeKey: string;
  accessScopeType?: MemoryScopeType;
  accessScopeKey?: string;
}

export interface ConsolidationSource {
  memoryId: string;
  memoryVersionId: string;
  kind: MemoryKind;
  title: string;
  content: string;
  updatedAt: string;
  predicateKey: string;
  normalizedValue?: string | null;
  normalizedValueHash?: string | null;
  negated: boolean;
  occurredAt: string | null;
  validFrom: string | null;
  validTo: string | null;
}

export interface ConsolidationSentence {
  text: string;
  sourceVersionIds: string[];
}

export interface ConsolidationDraft {
  sentences: ConsolidationSentence[];
  coverageRepaired?: boolean;
}

export interface ConsolidationSupportVerdict {
  sentenceIndex: number;
  supported: boolean;
  rationale: string;
}

export interface ConsolidationProvider {
  readonly model: string;
  readonly promptVersion: string;
  consolidate(
    scope: ConsolidationScope,
    sources: ConsolidationSource[],
  ): Promise<ConsolidationDraft>;
  verifySupport(
    scope: ConsolidationScope,
    sources: ConsolidationSource[],
    sentences: ConsolidationSentence[],
  ): Promise<ConsolidationSupportVerdict[]>;
}

export interface ConsolidationResult {
  status:
    | 'created'
    | 'rebuilt'
    | 'unchanged'
    | 'quarantined'
    | 'insufficient_sources'
    | 'completed_noop';
  consolidationId: string | null;
  memoryId: string | null;
  sourceCount: number;
  sentenceCount: number;
  unsupportedSentenceCount: number;
  noopReason?: string;
  inputFingerprint?: string;
  modelDurationMs?: number;
  missingSourceIds?: string[];
  compensationAction?: string;
}

export interface ConsolidationRunOptions {
  recoveryStrategy?:
    | 'reload_current_sources_and_recompute'
    | 'recompute_eligible_clusters_only'
    | 'single_attempt_protocol_repair';
}

export interface ConsolidationDraftValidationResult {
  sentences: ConsolidationSentence[];
  verdicts: ConsolidationSupportVerdict[];
}

export class ConsolidationProviderOutputError extends Error {
  readonly outputFingerprint: string;
  readonly missingSourceIds: string[];
  readonly modelDurationMs: number;

  constructor(
    message: string,
    rawOutput: string,
    modelDurationMs: number,
    missingSourceIds: string[] = [],
  ) {
    super(message);
    this.name = 'ConsolidationProviderOutputError';
    this.outputFingerprint = hash(rawOutput);
    this.missingSourceIds = uniqueSorted(missingSourceIds);
    this.modelDurationMs = Math.max(0, modelDurationMs);
  }
}

const sentenceSchema = z.object({
  text: z.string().min(1).max(1000),
  sourceVersionIds: z.array(z.string().min(1)).min(1).max(20),
}).strict();

const responseSchema = z.object({
  sentences: z.array(sentenceSchema).min(1).max(12),
}).strict();

const supportVerdictSchema = z.object({
  sentenceIndex: z.number().int().min(0),
  supported: z.boolean(),
  rationale: z.string().min(1).max(500),
}).strict();

const supportResponseSchema = z.object({
  verdicts: z.array(supportVerdictSchema).min(1).max(12),
}).strict();

const CONSOLIDATION_SYSTEM_PROMPT = `
你是本地长期记忆系统的证据约束巩固器。

任务是把多条不可变来源事实压缩成少量、可跨会话使用的陈述。
先按主体、谓词、值、否定和时间范围聚类同义或重复来源，再把每组重复
事实合并成一句并引用该组全部支持版本。禁止逐条改写来源或保留同义复述。
必须遵守输入 compressionPolicy.maxSentences；一句可以用清晰的并列分句
保留多个不同事实，但不得为减少句数而省略主体、否定、数值、时间或范围。
text 只能包含面向用户的自然语言事实，禁止写 memoryVersionId、UUID、
来源编号、括号引用或“根据来源”等内部标注；所有来源 ID 只能放在
sourceVersionIds 字段。
输出前逐项检查：每个输入 memoryVersionId 必须至少被一个准确表达其事实
的句子引用；如果一句包含多个并列事实，必须同时引用支持每个分句的来源，
不能只引用支持第一分句的来源。
每句话都必须只表达来源中明确存在的信息，并列出支持该句话的
memoryVersionId。禁止猜测、补充常识、合并矛盾事实或输出无来源观点。
如果来源之间冲突，只陈述“存在冲突”，并引用冲突双方。
不要输出 Markdown，不要输出来源正文之外的隐私推断。
`.trim();

const CONSOLIDATION_SUPPORT_SYSTEM_PROMPT = `
你是本地长期记忆系统的严格事实核验器。

逐句判断摘要是否完全被该句引用的来源正文语义蕴含。只允许同义改写和
不改变事实的压缩；常识补全、弱化否定、扩大范围、拼接未引用来源、
改变时间或主体、推测因果都必须判为 unsupported。
必须逐个检查输入中的 clauses；只要任一分句没有被 citedSources 明确蕴含，
整句就判 unsupported。例如“回答要简洁并使用中文”只引用“回答要简洁”
的来源时，必须判 unsupported。
引用来源按并集提供证据：每个分句只需由至少一条 citedSource 明确支持，
不要求每条来源都支持整句；但必须检查全部 citedSources，不能只读第一条。
删除不改变事实的副词、压缩语法或同义改写应判 supported。
每个 sentenceIndex 必须恰好返回一次。不要因为来源 ID 合法就判通过，
也不要使用未被该句引用的其他来源。只输出结构化 JSON。
`.trim();

const CONSOLIDATION_COVERAGE_REPAIR_SYSTEM_PROMPT = `
你是本地长期记忆系统的覆盖率修复器。

上一轮摘要遗漏了部分来源。只根据 missingSources 中提供的新证据修复
existingSentences，返回完整替代稿。不得改写或推断未提供的新事实；已有句子
只能保留、合并或增加缺失来源明确支持的分句。必须严格遵守 maxSentences，
并让 everyAllowedSourceVersionId 中每个 ID 至少出现一次。来源 ID 只能放在
sourceVersionIds，正文不得包含内部 ID。只输出结构化 JSON。
`.trim();

interface OllamaChatResponse {
  message?: {
    content?: unknown;
  };
}

export interface OllamaConsolidationProviderOptions {
  baseUrl: string;
  model: string;
  promptVersion: string;
  timeoutMs: number;
  keepAlive?: string | number;
  fetchImpl?: typeof fetch;
}

function cleanText(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim();
}

function asNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = cleanText(value);
  return text || null;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map(cleanText).filter(Boolean))].sort();
}

export function isDerivedSummarySource(source: unknown): boolean {
  const normalized = cleanText(source);
  return normalized === 'consolidation' ||
    normalized === 'hierarchical_summary';
}

// 知识库直写条目（外部知识库客户端等文档入口，source 以 kb: 开头）：
// 原文片段必须逐字可引用（kb 设计 D29），不得被治理管线当作对话记忆
// 合并、摘要或触发失效重算；文件型/流型入口分别标记 kb:file / kb:stream。
export function isKnowledgeBaseSource(source: unknown): boolean {
  return cleanText(source).startsWith('kb:');
}

export function isGovernanceExemptSource(source: unknown): boolean {
  return isDerivedSummarySource(source) || isKnowledgeBaseSource(source);
}

function consolidationSentenceBudget(sourceCount: number): number {
  return Math.max(
    1,
    Math.min(12, Math.floor(Math.max(1, sourceCount) * 0.4)),
  );
}

function sanitizeSentenceText(
  value: unknown,
  sourceVersionIds: string[],
): string {
  const ids = uniqueSorted(sourceVersionIds);
  let text = cleanText(value);
  text = text.replace(
    /[（(][^()（）]{0,2000}[)）]/gu,
    (group) =>
      /memoryVersionId/iu.test(group) ||
      ids.some((id) => group.includes(id))
        ? ''
        : group,
  );
  text = text.replace(/memoryVersionId\s*[:：]?/giu, '');
  for (const id of ids.sort(
    (left, right) => right.length - left.length,
  )) {
    text = text.replaceAll(id, '');
  }
  return cleanText(
    text
      .replace(/\s+([，。！？；：,.!?;:])/gu, '$1')
      .replace(/([,，]\s*){2,}/gu, '，')
      .replace(/\s+/gu, ' '),
  );
}

function sentenceClauses(value: string): string[] {
  return value
    .split(/[，,；;。.!！？]+/gu)
    .map((clause) => cleanText(clause))
    .filter(Boolean);
}

const SUPPORT_STOP_TOKENS = new Set([
  '用户',
  '应该',
  '需要',
  '必须',
  '使用',
  '保持',
  '要求',
  '通常',
  '默认',
  '项目',
  '系统',
]);

function semanticSupportTokens(value: string): Set<string> {
  const normalized = cleanText(value).toLocaleLowerCase('zh-CN');
  const tokens = new Set(
    retrievalTokens(value).filter((token) => {
      const normalizedToken = token.toLocaleLowerCase('zh-CN');
      return (
        normalizedToken.startsWith('concept:') ||
        (
          [...normalizedToken].length >= 2 &&
          normalizedToken !== normalized &&
          !SUPPORT_STOP_TOKENS.has(normalizedToken)
        )
      );
    }),
  );
  if (
    /(?:优先|首选|先(?:查看|考虑|选择)|\bprefer(?:s|red|ring)?\b|\bfirst choice\b)/iu
      .test(normalized)
  ) {
    tokens.add('concept:priority-preference');
  }
  if (
    /(?:简洁|简明|精炼|短而直接|不(?:要|应)?[^，,；;。.!！？]{0,8}冗长|\bconcise\b|\bbrief\b)/iu
      .test(normalized)
  ) {
    tokens.add('concept:concise-response');
  }
  return tokens;
}

function negativePolarity(value: string): boolean {
  return (
    /(?:不|无|未|没|禁止|拒绝|避免|取消|停止)/u.test(value) ||
    /\b(?:not|no|never|without|avoid)\b/iu.test(value)
  );
}

function numericTokens(value: string): string[] {
  return [
    ...value.normalize('NFKC').matchAll(
      /(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+)/gu,
    ),
  ].map((match) => match[0]);
}

const OPPOSING_SUPPORT_TERMS = [
  ['国内', '国外'],
  ['境内', '境外'],
  ['上午', '下午'],
  ['早上', '晚上'],
  ['之前', '之后'],
  ['以前', '以后'],
  ['增加', '减少'],
  ['开启', '关闭'],
  ['启用', '禁用'],
  ['允许', '禁止'],
  ['接受', '拒绝'],
] as const;

function supportComparableText(value: string): string {
  return cleanText(value)
    .toLocaleLowerCase('zh-CN')
    .replace(/[^\p{L}\p{N}+#/:]+/gu, '');
}

function hasOpposingSupportTerms(
  left: string,
  right: string,
): boolean {
  const normalizedLeft = supportComparableText(left);
  const normalizedRight = supportComparableText(right);
  return OPPOSING_SUPPORT_TERMS.some(([first, second]) => {
    const leftFirst = normalizedLeft.includes(first);
    const leftSecond = normalizedLeft.includes(second);
    const rightFirst = normalizedRight.includes(first);
    const rightSecond = normalizedRight.includes(second);
    return (
      leftFirst !== leftSecond &&
      rightFirst !== rightSecond &&
      leftFirst !== rightFirst
    );
  });
}

function removeNegationMarkers(value: string): string {
  return supportComparableText(value)
    .replace(/(?:不|未|没)(?:应|要|能|可|会|再|得)?/gu, '')
    .replace(/(?:禁止|拒绝|避免|取消|停止)/gu, '')
    .replace(/无(?=[\p{Script=Han}\p{L}\p{N}])/gu, '');
}

function hasDirectNegationConflict(
  left: string,
  right: string,
): boolean {
  if (negativePolarity(left) === negativePolarity(right)) {
    return false;
  }
  const normalizedLeft = supportComparableText(left);
  const normalizedRight = supportComparableText(right);
  const positiveLeft = removeNegationMarkers(left);
  const positiveRight = removeNegationMarkers(right);
  return (
    (
      positiveLeft.length >= 4 &&
      positiveLeft === normalizedRight
    ) ||
    (
      positiveRight.length >= 4 &&
      positiveRight === normalizedLeft
    )
  );
}

function clauseAgainstSourceLevel(
  clause: string,
  sourceClause: string,
): 'strong' | 'weak' | 'none' {
  const normalizedClause = supportComparableText(clause);
  const normalizedSource = supportComparableText(sourceClause);
  if (!normalizedClause || !normalizedSource) return 'none';
  if (
    hasOpposingSupportTerms(clause, sourceClause) ||
    hasDirectNegationConflict(clause, sourceClause)
  ) {
    return 'none';
  }
  const clauseNumbers = numericTokens(clause);
  const sourceNumbers = new Set(numericTokens(sourceClause));
  if (
    clauseNumbers.length > 0 &&
    clauseNumbers.some((number) => !sourceNumbers.has(number))
  ) {
    return 'none';
  }
  if (
    normalizedSource.includes(normalizedClause) ||
    (
      normalizedClause.length >= 6 &&
      normalizedClause.includes(normalizedSource)
    )
  ) {
    return 'strong';
  }
  const clauseTokens = semanticSupportTokens(clause);
  const sourceTokens = semanticSupportTokens(sourceClause);
  if (clauseTokens.size === 0 || sourceTokens.size === 0) {
    return 'none';
  }
  const shared = [...clauseTokens].filter(
    (token) => sourceTokens.has(token),
  );
  const ratio = shared.length / clauseTokens.size;
  const sharedConcepts = shared.filter(
    (token) => token.startsWith('concept:'),
  );
  const sharedLexical = shared.filter(
    (token) => !token.startsWith('concept:'),
  );
  const conceptMatch = sharedConcepts.length > 0;
  if (
    (shared.length >= 3 && ratio >= 0.35) ||
    (conceptMatch && shared.length >= 3 && ratio >= 0.25) ||
    (
      conceptMatch &&
      sharedLexical.length >= 1 &&
      shared.length >= 2 &&
      ratio >= 0.15
    ) ||
    (
      sharedConcepts.length >= 2 &&
      sharedLexical.length >= 2
    )
  ) {
    return 'strong';
  }
  if (
    (shared.length >= 2 && ratio >= 0.2) ||
    (conceptMatch && shared.length >= 1)
  ) {
    return 'weak';
  }
  return 'none';
}

function sourcesSemanticallyRelated(
  left: ConsolidationSource,
  right: ConsolidationSource,
): boolean {
  const leftValue = cleanText(left.normalizedValue);
  const rightValue = cleanText(right.normalizedValue);
  if (leftValue && rightValue) {
    return supportComparableText(leftValue) ===
      supportComparableText(rightValue);
  }
  const leftToRight = clauseAgainstSourceLevel(
    left.content,
    right.content,
  );
  const rightToLeft = clauseAgainstSourceLevel(
    right.content,
    left.content,
  );
  if (
    leftToRight !== 'none' &&
    rightToLeft !== 'none' &&
    (leftToRight === 'strong' || rightToLeft === 'strong')
  ) {
    return true;
  }
  const clusterTokens = (value: string): Set<string> => {
    const discriminativeText = cleanText(value)
      .toLocaleLowerCase('zh-CN')
      .replace(
        /(?:用户|本人|我|稳定|一直|长期|经常|通常|默认|偏好|喜欢|喜爱|偏爱|首选|优先|选择|使用|会|的|是|时)/gu,
        ' ',
      )
      .replace(
        /\b(?:user|i|stable|always|usually|prefer(?:s|red|ring)?|like(?:s|d)?|choose(?:s|n)?|use(?:s|d)?)\b/giu,
        ' ',
      );
    const normalized = supportComparableText(discriminativeText);
    return new Set(
      retrievalTokens(discriminativeText).filter((token) => {
        const normalizedToken = token.toLocaleLowerCase('zh-CN');
        return (
          normalizedToken !== normalized &&
          normalizedToken !== 'concept:priority-preference' &&
          (
            normalizedToken.startsWith('concept:') ||
            [...normalizedToken].length >= 2
          )
        );
      }),
    );
  };
  const leftTokens = clusterTokens(left.content);
  const rightTokens = clusterTokens(right.content);
  const sharedTokens = [...leftTokens].filter(
    (token) => rightTokens.has(token),
  );
  return sharedTokens.length >= 2;
}

function sourceSupportClauses(
  source: ConsolidationSource,
): string[] {
  return [
    source.content,
    ...sentenceClauses(source.content),
  ].filter(
    (clause, index, clauses) =>
      clause && clauses.indexOf(clause) === index,
  );
}

function sourceSupportsClauseLevel(
  clause: string,
  source: ConsolidationSource,
): 'strong' | 'weak' | 'none' {
  let best: 'strong' | 'weak' | 'none' = 'none';
  for (const sourceClause of sourceSupportClauses(source)) {
    const level = clauseAgainstSourceLevel(clause, sourceClause);
    if (level === 'strong') return 'strong';
    if (level === 'weak') best = 'weak';
  }
  return best;
}

function chineseCount(value: string): number | null {
  if (/^\d+$/u.test(value)) return Number(value);
  const direct: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (direct[value] !== undefined) return direct[value];
  const match = value.match(/^十([一二三四五六七八九])$/u);
  return match ? 10 + direct[match[1]] : null;
}

function aggregateCountSupported(
  sentence: ConsolidationSentence,
  sourceById: Map<string, ConsolidationSource>,
): boolean {
  const match = cleanText(sentence.text).match(
    /有([一二两三四五六七八九十\d]+)项(?:稳定)?(偏好|事实|决定|要求|记忆|信息)/u,
  );
  if (!match) return false;
  const count = chineseCount(match[1]);
  if (count !== sentence.sourceVersionIds.length) return false;
  const sources = sentence.sourceVersionIds.map(
    (sourceVersionId) => sourceById.get(sourceVersionId),
  );
  if (sources.some((source) => !source)) return false;
  if (match[2] === '偏好') {
    return sources.every((source) => source?.kind === 'preference');
  }
  return true;
}

function deterministicSentenceSupport(
  sentence: ConsolidationSentence,
  sourceById: Map<string, ConsolidationSource>,
): 'strong' | 'weak' | 'none' {
  if (aggregateCountSupported(sentence, sourceById)) {
    return 'weak';
  }
  const citedClauses = sentence.sourceVersionIds.flatMap(
    (sourceVersionId) => {
      const source = sourceById.get(sourceVersionId);
      return source ? sourceSupportClauses(source) : [];
    },
  );
  if (citedClauses.length === 0) return 'none';
  let sawWeak = false;
  for (const clause of sentenceClauses(sentence.text)) {
    if (
      citedClauses.some(
        (sourceClause) =>
          hasOpposingSupportTerms(clause, sourceClause) ||
          hasDirectNegationConflict(clause, sourceClause),
      )
    ) {
      return 'none';
    }
    let best: 'strong' | 'weak' | 'none' = 'none';
    for (const sourceClause of citedClauses) {
      const level = clauseAgainstSourceLevel(clause, sourceClause);
      if (level === 'strong') {
        best = 'strong';
        break;
      }
      if (level === 'weak') best = 'weak';
    }
    if (best === 'none') return 'none';
    if (best === 'weak') sawWeak = true;
  }
  return sawWeak ? 'weak' : 'strong';
}

function enrichSentenceSources(
  sentence: ConsolidationSentence,
  sources: ConsolidationSource[],
): ConsolidationSentence {
  const sourceIds = new Set(sentence.sourceVersionIds);
  const clauses = sentenceClauses(sentence.text);
  for (const source of sources) {
    if (
      sourceIds.has(source.memoryVersionId) ||
      sourceIds.size >= 20
    ) {
      continue;
    }
    if (
      clauses.some(
        (clause) =>
          sourceSupportsClauseLevel(clause, source) === 'strong',
      )
    ) {
      sourceIds.add(source.memoryVersionId);
    }
  }
  return {
    ...sentence,
    sourceVersionIds: uniqueSorted([...sourceIds]),
  };
}

function scopeIdentity(scope: ConsolidationScope): string {
  return [
    scope.userId,
    scope.namespace,
    scope.accessScopeType || 'personal',
    scope.accessScopeKey || 'self',
    scope.scopeType,
    scope.scopeKey,
  ].join('\u0000');
}

const STORED_SCOPE_KEY_PREFIX = 'access-v1:';
const ACCESS_SCOPE_TYPES: MemoryScopeType[] = [
  'personal',
  'project',
  'role',
  'session',
];

function storedScopeKey(scope: ConsolidationScope): string {
  return `${STORED_SCOPE_KEY_PREFIX}${
    Buffer.from(JSON.stringify([
      scope.accessScopeType || 'personal',
      scope.accessScopeKey || 'self',
      scope.scopeKey,
    ]), 'utf8').toString('base64url')
  }`;
}

function storedScopeKeys(scope: ConsolidationScope): string[] {
  const encoded = storedScopeKey(scope);
  return (
    (scope.accessScopeType || 'personal') === 'personal' &&
    (scope.accessScopeKey || 'self') === 'self'
  )
    ? [encoded, scope.scopeKey]
    : [encoded];
}

function scopeFromStoredRow(row: DatabaseRow): ConsolidationScope {
  const storedKey = cleanText(row.scope_key);
  if (storedKey.startsWith(STORED_SCOPE_KEY_PREFIX)) {
    try {
      const decoded = JSON.parse(
        Buffer.from(
          storedKey.slice(STORED_SCOPE_KEY_PREFIX.length),
          'base64url',
        ).toString('utf8'),
      ) as unknown;
      if (
        Array.isArray(decoded) &&
        decoded.length === 3 &&
        ACCESS_SCOPE_TYPES.includes(decoded[0] as MemoryScopeType) &&
        decoded.every((value) => typeof value === 'string') &&
        cleanText(decoded[1]) &&
        cleanText(decoded[2])
      ) {
        return {
          userId: cleanText(row.user_id),
          namespace: cleanText(row.namespace),
          scopeType: cleanText(row.scope_type) as
            ConsolidationScopeType,
          scopeKey: cleanText(decoded[2]),
          accessScopeType: decoded[0] as MemoryScopeType,
          accessScopeKey: cleanText(decoded[1]),
        };
      }
    } catch {
      // Invalid internal keys are isolated by using the full stored value.
    }
  }
  return {
    userId: cleanText(row.user_id),
    namespace: cleanText(row.namespace),
    scopeType: cleanText(row.scope_type) as ConsolidationScopeType,
    scopeKey: storedKey,
    accessScopeType: 'personal',
    accessScopeKey: 'self',
  };
}

function sourceSetHash(sources: ConsolidationSource[]): string {
  return hash(
    sources
      .map((source) => source.memoryVersionId)
      .sort()
      .join('\n'),
  );
}

function projectionSnapshot(row: DatabaseRow | null): string {
  if (!row) return 'none';
  return JSON.stringify({
    id: cleanText(row.id),
    revision: Number(row.revision || 0),
    sourceSetHash: cleanText(row.source_set_hash),
    status: cleanText(row.status),
    memoryId: asNullableText(row.memory_id),
    scopeKey: cleanText(row.scope_key),
  });
}

function derivedKind(scope: ConsolidationScope): MemoryKind {
  if (scope.scopeType === 'project') return 'project';
  if (scope.scopeType === 'person') return 'relationship';
  if (scope.scopeType === 'session') return 'event';
  const kind = scope.scopeKey.replace(/^kind:/u, '') as MemoryKind;
  return [
    'profile',
    'preference',
    'project',
    'event',
    'knowledge',
    'relationship',
    'instruction',
  ].includes(kind)
    ? kind
    : 'knowledge';
}

function scopeTitle(scope: ConsolidationScope): string {
  const labels: Record<ConsolidationScopeType, string> = {
    session: '会话摘要',
    topic: '主题摘要',
    person: '人物快照',
    project: '项目快照',
  };
  return `${labels[scope.scopeType]}：${scope.scopeKey}`;
}

function scopeFromPayload(
  payload: Record<string, unknown>,
): ConsolidationScope {
  const scopeType = cleanText(payload.scopeType) as
    ConsolidationScopeType;
  if (
    !['session', 'topic', 'person', 'project'].includes(scopeType)
  ) {
    throw new Error('巩固任务的 scopeType 无效');
  }
  const scope = {
    userId: cleanText(payload.userId),
    namespace: cleanText(payload.namespace),
    scopeType,
    scopeKey: cleanText(payload.scopeKey),
    accessScopeType:
      ACCESS_SCOPE_TYPES.includes(
        cleanText(payload.accessScopeType) as MemoryScopeType,
      )
        ? cleanText(payload.accessScopeType) as MemoryScopeType
        : 'personal' as const,
    accessScopeKey:
      cleanText(payload.accessScopeKey) || 'self',
  };
  if (!scope.userId || !scope.namespace || !scope.scopeKey) {
    throw new Error('巩固任务缺少作用域字段');
  }
  return scope;
}

export async function validateConsolidationDraftSources(
  provider: ConsolidationProvider,
  scope: ConsolidationScope,
  sources: ConsolidationSource[],
  draft: ConsolidationDraft,
): Promise<ConsolidationDraftValidationResult> {
  const allowed = new Set(
    sources.map((source) => cleanText(source.memoryVersionId)),
  );
  if (allowed.size === 0 || draft.sentences.length === 0) {
    throw new Error('摘要必须包含来源和句子');
  }
  const sentences = draft.sentences.map((sentence) => ({
    text: sanitizeSentenceText(
      sentence.text,
      sentence.sourceVersionIds,
    ),
    sourceVersionIds: uniqueSorted(sentence.sourceVersionIds),
  }));
  if (sentences.some((sentence) =>
    !sentence.text ||
    sentence.sourceVersionIds.length === 0 ||
    sentence.sourceVersionIds.some((id) => !allowed.has(id)))) {
    throw new Error('摘要包含无有效来源支持的句子');
  }
  const cited = new Set(
    sentences.flatMap((sentence) => sentence.sourceVersionIds),
  );
  if ([...allowed].some((id) => !cited.has(id))) {
    throw new Error('摘要没有覆盖全部来源');
  }
  const verdicts = await provider.verifySupport(
    scope,
    sources,
    sentences,
  );
  const byIndex = new Map<number, ConsolidationSupportVerdict>();
  for (const verdict of verdicts) {
    if (
      !Number.isInteger(verdict.sentenceIndex) ||
      verdict.sentenceIndex < 0 ||
      verdict.sentenceIndex >= sentences.length ||
      byIndex.has(verdict.sentenceIndex)
    ) {
      throw new Error('摘要证据核验索引重复或越界');
    }
    byIndex.set(verdict.sentenceIndex, verdict);
  }
  if (
    byIndex.size !== sentences.length ||
    [...byIndex.values()].some((verdict) => verdict.supported !== true)
  ) {
    throw new Error('摘要包含未被引用来源语义蕴含的句子');
  }
  return {
    sentences,
    verdicts: [...byIndex.values()].sort(
      (left, right) => left.sentenceIndex - right.sentenceIndex,
    ),
  };
}

export function withMemoryStoreTransaction<T>(
  database: DatabaseSync,
  persist: () => T,
): T {
  const execute = database.exec.bind(database);
  const originalExec = database.exec;
  const savepoints: string[] = [];
  let savepointSequence = 0;

  execute('BEGIN IMMEDIATE');
  database.exec = (sql: string): void => {
    const command = sql
      .trim()
      .replace(/;+$/u, '')
      .replace(/\s+/gu, ' ')
      .toUpperCase();
    if (
      /^BEGIN(?: (?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?: TRANSACTION)?$/u
        .test(command)
    ) {
      const savepoint = `memory_store_nested_${savepointSequence += 1}`;
      execute(`SAVEPOINT ${savepoint}`);
      savepoints.push(savepoint);
      return;
    }
    if (/^(?:COMMIT|END)(?: TRANSACTION)?$/u.test(command)) {
      const savepoint = savepoints.pop();
      if (!savepoint) {
        throw new Error('持久化遇到未配对的嵌套提交');
      }
      execute(`RELEASE SAVEPOINT ${savepoint}`);
      return;
    }
    if (/^ROLLBACK(?: TRANSACTION)?$/u.test(command)) {
      const savepoint = savepoints.pop();
      if (!savepoint) {
        throw new Error('持久化遇到未配对的嵌套回滚');
      }
      execute(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      execute(`RELEASE SAVEPOINT ${savepoint}`);
      return;
    }
    execute(sql);
  };

  try {
    const result = persist();
    if (savepoints.length > 0) {
      throw new Error('持久化存在未关闭的嵌套事务');
    }
    database.exec = originalExec;
    execute('COMMIT');
    return result;
  } catch (error) {
    database.exec = originalExec;
    if (database.isTransaction) execute('ROLLBACK');
    throw error;
  } finally {
    database.exec = originalExec;
  }
}

export class OllamaConsolidationProvider
implements ConsolidationProvider {
  readonly model: string;
  readonly promptVersion: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly keepAlive: string | number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaConsolidationProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.model = cleanText(options.model);
    this.promptVersion = cleanText(options.promptVersion);
    this.timeoutMs = Math.max(1_000, options.timeoutMs);
    this.keepAlive = options.keepAlive ?? '15m';
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async consolidate(
    scope: ConsolidationScope,
    sources: ConsolidationSource[],
  ): Promise<ConsolidationDraft> {
    const modelStartedAt = performance.now();
    const allowedIds = sources.map(
      (source) => source.memoryVersionId,
    );
    const maxSentences = consolidationSentenceBudget(
      sources.length,
    );
    const format = {
      type: 'object',
      additionalProperties: false,
      properties: {
        sentences: {
          type: 'array',
          minItems: maxSentences,
          maxItems: maxSentences,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string' },
              sourceVersionIds: {
                type: 'array',
                minItems: 1,
                maxItems: 20,
                items: {
                  type: 'string',
                  enum: allowedIds,
                },
              },
            },
            required: ['text', 'sourceVersionIds'],
          },
        },
      },
      required: ['sentences'],
    } as const;
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: backgroundModelAbortSignal(this.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          stream: false,
          think: false,
          keep_alive: this.keepAlive,
          format,
          options: {
            temperature: 0,
            seed: 42,
            num_predict: 1600,
          },
          messages: [
            {
              role: 'system',
              content: CONSOLIDATION_SYSTEM_PROMPT,
            },
            {
              role: 'user',
              content: JSON.stringify({
                scope,
                compressionPolicy: {
                  maxSentences,
                  minimumReduction: 0.6,
                  preserveDistinctFacts: true,
                  mergeSemanticDuplicates: true,
                  citeEverySourceAtLeastOnce: true,
                },
                sources: sources.map((source) => ({
                  memoryVersionId: source.memoryVersionId,
                  kind: source.kind,
                  title: source.title,
                  content: source.content,
                })),
              }),
            },
          ],
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Ollama 记忆巩固失败：${response.status} ${await response.text()}`,
      );
    }
    const payload = await response.json() as OllamaChatResponse;
    if (typeof payload.message?.content !== 'string') {
      throw new Error('Ollama 记忆巩固没有返回文本结果');
    }
    const rawOutput = payload.message.content;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawOutput);
    } catch {
      throw new ConsolidationProviderOutputError(
        'Ollama 记忆巩固返回的 JSON 无法解析',
        rawOutput,
        performance.now() - modelStartedAt,
      );
    }
    const result = responseSchema.safeParse(parsed);
    if (!result.success) {
      throw new ConsolidationProviderOutputError(
        `Ollama 记忆巩固结果无效：${result.error.issues[0]?.message || '未知错误'}`,
        rawOutput,
        performance.now() - modelStartedAt,
      );
    }
    if (result.data.sentences.length !== maxSentences) {
      throw new ConsolidationProviderOutputError(
        `Ollama 记忆巩固未遵守句数预算：` +
          `${result.data.sentences.length}/${maxSentences}`,
        rawOutput,
        performance.now() - modelStartedAt,
      );
    }
    const sentences = result.data.sentences.map((sentence) => ({
        text: sanitizeSentenceText(
          sentence.text,
          allowedIds,
        ),
        sourceVersionIds: uniqueSorted(
          sentence.sourceVersionIds,
        ),
      }))
      .map((sentence) => enrichSentenceSources(sentence, sources));
    if (sentences.some((sentence) => !sentence.text)) {
      throw new ConsolidationProviderOutputError(
        'Ollama 记忆巩固清除内部来源 ID 后正文为空',
        rawOutput,
        performance.now() - modelStartedAt,
      );
    }
    const cited = new Set(
      sentences.flatMap((sentence) => sentence.sourceVersionIds),
    );
    const uncited = allowedIds.filter((id) => !cited.has(id));
    if (uncited.length > 0) {
      const missingSources = sources.filter((source) =>
        uncited.includes(source.memoryVersionId),
      );
      const repairResponse = await this.fetchImpl(
        `${this.baseUrl}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: backgroundModelAbortSignal(this.timeoutMs),
          body: JSON.stringify({
            model: this.model,
            stream: false,
            think: false,
            keep_alive: this.keepAlive,
            format,
            options: {
              temperature: 0,
              seed: 42,
              num_predict: 1600,
            },
            messages: [
              {
                role: 'system',
                content: CONSOLIDATION_COVERAGE_REPAIR_SYSTEM_PROMPT,
              },
              {
                role: 'user',
                content: JSON.stringify({
                  scope,
                  compressionPolicy: {
                    maxSentences,
                    preserveExistingFacts: true,
                    addOnlyMissingEvidence: true,
                    citeEverySourceAtLeastOnce: true,
                  },
                  everyAllowedSourceVersionId: allowedIds,
                  existingSentences: sentences,
                  missingSources: missingSources.map((source) => ({
                    memoryVersionId: source.memoryVersionId,
                    kind: source.kind,
                    title: source.title,
                    content: source.content,
                  })),
                }),
              },
            ],
          }),
        },
      );
      if (!repairResponse.ok) {
        throw new ConsolidationProviderOutputError(
          `Ollama 记忆巩固 coverage 修复请求失败：${repairResponse.status}`,
          `${rawOutput}\n${await repairResponse.text()}`,
          performance.now() - modelStartedAt,
          uncited,
        );
      }
      const repairPayload = await repairResponse.json() as
        OllamaChatResponse;
      const repairRawOutput = typeof repairPayload.message?.content ===
        'string'
        ? repairPayload.message.content
        : JSON.stringify(repairPayload);
      let repairParsed: unknown;
      try {
        repairParsed = JSON.parse(repairRawOutput);
      } catch {
        throw new ConsolidationProviderOutputError(
          'Ollama 记忆巩固 coverage 修复返回的 JSON 无法解析',
          `${rawOutput}\n${repairRawOutput}`,
          performance.now() - modelStartedAt,
          uncited,
        );
      }
      const repairResult = responseSchema.safeParse(repairParsed);
      if (
        !repairResult.success ||
        repairResult.data.sentences.length !== maxSentences
      ) {
        throw new ConsolidationProviderOutputError(
          'Ollama 记忆巩固 coverage 修复结果无效',
          `${rawOutput}\n${repairRawOutput}`,
          performance.now() - modelStartedAt,
          uncited,
        );
      }
      const repairedSentences = repairResult.data.sentences
        .map((sentence) => ({
          text: sanitizeSentenceText(sentence.text, allowedIds),
          sourceVersionIds: uniqueSorted(
            sentence.sourceVersionIds,
          ),
        }))
        .map((sentence) => enrichSentenceSources(sentence, sources));
      const repairedCitations = new Set(
        repairedSentences.flatMap(
          (sentence) => sentence.sourceVersionIds,
        ),
      );
      const stillUncited = allowedIds.filter(
        (id) => !repairedCitations.has(id),
      );
      if (
        repairedSentences.some((sentence) => !sentence.text) ||
        stillUncited.length > 0
      ) {
        throw new ConsolidationProviderOutputError(
          `Ollama 记忆巩固 coverage 修复后仍遗漏：` +
            `${stillUncited.length} 条`,
          `${rawOutput}\n${repairRawOutput}`,
          performance.now() - modelStartedAt,
          stillUncited.length > 0 ? stillUncited : uncited,
        );
      }
      return {
        sentences: repairedSentences,
        coverageRepaired: true,
      };
    }
    return { sentences };
  }

  async verifySupport(
    scope: ConsolidationScope,
    sources: ConsolidationSource[],
    sentences: ConsolidationSentence[],
  ): Promise<ConsolidationSupportVerdict[]> {
    if (sentences.length === 0) return [];
    const sourceById = new Map(
      sources.map((source) => [
        source.memoryVersionId,
        source,
      ]),
    );
    const format = {
      type: 'object',
      additionalProperties: false,
      properties: {
        verdicts: {
          type: 'array',
          minItems: sentences.length,
          maxItems: sentences.length,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sentenceIndex: {
                type: 'integer',
                minimum: 0,
                maximum: sentences.length - 1,
              },
              supported: { type: 'boolean' },
              rationale: { type: 'string' },
            },
            required: [
              'sentenceIndex',
              'supported',
              'rationale',
            ],
          },
        },
      },
      required: ['verdicts'],
    } as const;
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: backgroundModelAbortSignal(this.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          stream: false,
          think: false,
          keep_alive: this.keepAlive,
          format,
          options: {
            temperature: 0,
            seed: 42,
            num_predict: 1200,
          },
          messages: [
            {
              role: 'system',
              content: CONSOLIDATION_SUPPORT_SYSTEM_PROMPT,
            },
            {
              role: 'user',
              content: JSON.stringify({
                scope,
                sentences: sentences.map((sentence, index) => ({
                  sentenceIndex: index,
                  text: sentence.text,
                  clauses: sentenceClauses(sentence.text),
                  citedSources: sentence.sourceVersionIds.flatMap(
                    (sourceVersionId) => {
                      const source = sourceById.get(sourceVersionId);
                      return source
                        ? [{
                            memoryVersionId: sourceVersionId,
                            content: source.content,
                          }]
                        : [];
                    },
                  ),
                })),
              }),
            },
          ],
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Ollama 摘要证据核验失败：${response.status} ${await response.text()}`,
      );
    }
    const payload = await response.json() as OllamaChatResponse;
    if (typeof payload.message?.content !== 'string') {
      throw new Error('Ollama 摘要证据核验没有返回文本结果');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.message.content);
    } catch {
      throw new Error('Ollama 摘要证据核验返回的 JSON 无法解析');
    }
    const result = supportResponseSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Ollama 摘要证据核验结果无效：${result.error.issues[0]?.message || '未知错误'}`,
      );
    }
    const byIndex = new Map<number, ConsolidationSupportVerdict>();
    for (const verdict of result.data.verdicts) {
      if (
        verdict.sentenceIndex >= sentences.length ||
        byIndex.has(verdict.sentenceIndex)
      ) {
        throw new Error('Ollama 摘要证据核验索引重复或越界');
      }
      byIndex.set(verdict.sentenceIndex, {
        sentenceIndex: verdict.sentenceIndex,
        supported: verdict.supported,
        rationale: cleanText(verdict.rationale),
      });
    }
    if (byIndex.size !== sentences.length) {
      throw new Error('Ollama 摘要证据核验未覆盖全部句子');
    }
    return [...byIndex.values()]
      .sort(
        (left, right) =>
          left.sentenceIndex - right.sentenceIndex,
      )
      .map((verdict) => {
        const level = deterministicSentenceSupport(
          sentences[verdict.sentenceIndex],
          sourceById,
        );
        return {
          ...verdict,
          supported:
            level === 'strong'
              ? true
              : level === 'none'
                ? false
                : verdict.supported,
          rationale:
            `deterministic=${level}; ${verdict.rationale}`,
        };
      });
  }
}

export class MemoryConsolidator {
  constructor(
    private readonly database: DatabaseSync,
    private readonly lifecycleStore: LifecycleStore,
    private readonly memoryStore: MemoryStore,
    private readonly provider: ConsolidationProvider,
    private readonly minimumSources = config.consolidationMinSources,
    private readonly maximumSources = config.consolidationMaxSources,
    private readonly redundancyThreshold =
      config.consolidationRedundancyThreshold,
  ) {}

  static scopeFromJobPayload(
    payload: Record<string, unknown>,
  ): ConsolidationScope {
    return scopeFromPayload(payload);
  }

  handleMemoryChange(
    memoryId: string,
    eventId: string,
  ): {
    invalidated: number;
    enqueued: number;
  } {
    const item = this.database
      .prepare(
        `SELECT
           i.id,
           i.user_id,
           i.namespace,
           i.kind,
           i.predicate_key,
           i.scope_type,
           i.scope_key,
           m.source
         FROM memory_items i
         LEFT JOIN memories m ON m.id = i.id
         WHERE i.id = ?`,
      )
      .get(cleanText(memoryId)) as DatabaseRow | undefined;
    if (!item || isGovernanceExemptSource(item.source)) {
      return { invalidated: 0, enqueued: 0 };
    }

    const staleScopes = this.invalidateBySourceMemory(
      cleanText(memoryId),
    );
    const scopes = new Map<string, ConsolidationScope>();
    const staleIdentities = new Set<string>();
    for (const scope of staleScopes) {
      const identity = scopeIdentity(scope);
      staleIdentities.add(identity);
      scopes.set(identity, scope);
    }

    const userId = cleanText(item.user_id);
    const namespace = cleanText(item.namespace);
    const kind = cleanText(item.kind) as MemoryKind;
    const predicateKey = cleanText(item.predicate_key);
    const accessScopeType =
      ACCESS_SCOPE_TYPES.includes(
        cleanText(item.scope_type) as MemoryScopeType,
      )
        ? cleanText(item.scope_type) as MemoryScopeType
        : 'personal';
    const accessScopeKey = cleanText(item.scope_key) || 'self';
    const addFreshScope = (scope: ConsolidationScope): void => {
      const identity = scopeIdentity(scope);
      if (
        staleIdentities.has(identity) ||
        this.sourceCount(scope) >= this.redundancyThreshold
      ) {
        scopes.set(identity, scope);
      }
    };
    const topicScope: ConsolidationScope = {
      userId,
      namespace,
      scopeType: 'topic',
      scopeKey: `kind:${kind}`,
      accessScopeType,
      accessScopeKey,
    };
    addFreshScope(topicScope);

    const sessionRows = this.database
      .prepare(
        `SELECT DISTINCT t.session_id
         FROM memory_versions v
         JOIN memory_items source_item
           ON source_item.id = v.memory_item_id
          AND source_item.current_version_id = v.id
         JOIN memory_evidence e ON e.memory_version_id = v.id
         JOIN conversation_turns t ON t.id = e.turn_id
         JOIN conversation_sessions s ON s.id = t.session_id
         WHERE v.memory_item_id = ?
           AND s.ended_at IS NOT NULL`,
      )
      .all(cleanText(memoryId)) as DatabaseRow[];
    for (const row of sessionRows) {
      const sessionId = cleanText(row.session_id);
      if (!sessionId) continue;
      const scope: ConsolidationScope = {
        userId,
        namespace,
        scopeType: 'session',
        scopeKey: sessionId,
        accessScopeType,
        accessScopeKey,
      };
      scopes.set(scopeIdentity(scope), scope);
    }

    const subject = predicateKey.split('::')[0]?.trim();
    if (subject && kind === 'project') {
      const scope: ConsolidationScope = {
        userId,
        namespace,
        scopeType: 'project',
        scopeKey: subject,
        accessScopeType,
        accessScopeKey,
      };
      addFreshScope(scope);
    }
    if (subject && kind === 'relationship') {
      const scope: ConsolidationScope = {
        userId,
        namespace,
        scopeType: 'person',
        scopeKey: subject,
        accessScopeType,
        accessScopeKey,
      };
      addFreshScope(scope);
    }

    let enqueued = 0;
    for (const scope of scopes.values()) {
      const jobId = [
        'consolidate-scope',
        hash(scopeIdentity(scope)),
        cleanText(eventId) || randomUUID(),
      ].join(':');
      const timestamp = new Date().toISOString();
      this.database.prepare(
        `UPDATE memory_jobs
         SET status = 'completed', lease_until = NULL,
             lease_owner = NULL, last_error = ?, updated_at = ?
         WHERE job_type = 'consolidate_scope'
           AND user_id = ? AND namespace = ?
           AND status IN ('pending', 'failed')
           AND json_type(payload_json, '$.recovery') IS NULL
           AND json_extract(payload_json, '$.scopeType') = ?
           AND json_extract(payload_json, '$.scopeKey') = ?
           AND json_extract(payload_json, '$.accessScopeType') = ?
           AND json_extract(payload_json, '$.accessScopeKey') = ?`,
      ).run(
        `coalesced_by_newer_scope_job:${jobId}`,
        timestamp,
        scope.userId,
        scope.namespace,
        scope.scopeType,
        scope.scopeKey,
        scope.accessScopeType || 'personal',
        scope.accessScopeKey || 'self',
      );
      this.lifecycleStore.enqueueJob({
        id: jobId,
        jobType: 'consolidate_scope',
        userId: scope.userId,
        namespace: scope.namespace,
        payload: { ...scope },
        priority: 2,
        maxAttempts: 5,
      });
      enqueued += 1;
    }
    return { invalidated: staleScopes.length, enqueued };
  }

  async consolidateScope(
    scope: ConsolidationScope,
    options: ConsolidationRunOptions = {},
  ): Promise<ConsolidationResult> {
    const normalizedScope = scopeFromPayload({ ...scope });
    return this.consolidateScopeAttempt(normalizedScope, 0, options);
  }

  consolidationInputFingerprint(
    scope: ConsolidationScope,
    options: ConsolidationRunOptions = {},
  ): string {
    const normalizedScope = scopeFromPayload({ ...scope });
    const loadedSources = this.loadSources(normalizedScope);
    const clusters = this.prepareSourceClusters(
      normalizedScope,
      loadedSources,
      options,
    );
    return hash(JSON.stringify({
      contract: 'consolidation-attempt-v2',
      scope: normalizedScope,
      model: this.provider.model,
      promptVersion: this.provider.promptVersion,
      minimumSources: this.minimumSources,
      maximumSources: this.maximumSources,
      redundancyThreshold: this.redundancyThreshold,
      recoveryStrategy: options.recoveryStrategy || null,
      clusters: clusters.map((cluster) =>
        cluster.map((source) => ({
          memoryId: source.memoryId,
          memoryVersionId: source.memoryVersionId,
          kind: source.kind,
          predicateKey: source.predicateKey,
          negated: source.negated,
          occurredAt: source.occurredAt,
          validFrom: source.validFrom,
          validTo: source.validTo,
          contentHash: hash(source.content),
          normalizedValueHash: source.normalizedValueHash || null,
        })),
      ),
    }));
  }

  private async consolidateScopeAttempt(
    normalizedScope: ConsolidationScope,
    sourceDriftRetries: number,
    options: ConsolidationRunOptions,
  ): Promise<ConsolidationResult> {
    const loadedSources = this.loadSources(normalizedScope);
    const inputFingerprint = this.consolidationInputFingerprint(
      normalizedScope,
      options,
    );
    if (loadedSources.length < this.minimumSources) {
      return {
        status: 'insufficient_sources',
        consolidationId: null,
        memoryId: null,
        sourceCount: loadedSources.length,
        sentenceCount: 0,
        unsupportedSentenceCount: 0,
        inputFingerprint,
        modelDurationMs: 0,
      };
    }
    const sourceClusters = this.prepareSourceClusters(
      normalizedScope,
      loadedSources,
      options,
    );
    const sources = sourceClusters.flat();
    if (sources.length < this.minimumSources) {
      return {
        status: 'completed_noop',
        consolidationId: null,
        memoryId: null,
        sourceCount: loadedSources.length,
        sentenceCount: 0,
        unsupportedSentenceCount: 0,
        inputFingerprint,
        modelDurationMs: 0,
        compensationAction:
          options.recoveryStrategy || 'preserve_atomic_sources',
        noopReason:
          new Set(loadedSources.map((source) => source.kind)).size > 1
            ? 'mixed_kinds_require_cluster_split'
            : 'not_beneficial_no_redundant_cluster',
      };
    }
    const setHash = sourceSetHash(sources);
    const existing = this.findConsolidation(
      normalizedScope,
      this.provider.model,
      this.provider.promptVersion,
    );
    if (
      existing &&
      cleanText(existing.source_set_hash) === setHash &&
      cleanText(existing.status) === 'active' &&
      this.consolidationMemoryMatchesScope(
        asNullableText(existing.memory_id),
        normalizedScope,
      )
    ) {
      return {
        status: 'unchanged',
        consolidationId: cleanText(existing.id),
        memoryId: asNullableText(existing.memory_id),
        sourceCount: sources.length,
        sentenceCount: this.sentenceCount(cleanText(existing.id)),
        unsupportedSentenceCount: 0,
        inputFingerprint,
        modelDurationMs: 0,
      };
    }

    let draft: ConsolidationDraft;
    let modelDurationMs = 0;
    try {
      const clusterDrafts: ConsolidationDraft[] = [];
      for (const cluster of sourceClusters) {
        const providerStartedAt = performance.now();
        clusterDrafts.push(
          await this.provider.consolidate(
            normalizedScope,
            cluster,
          ),
        );
        modelDurationMs += performance.now() - providerStartedAt;
      }
      draft = {
        sentences: clusterDrafts.flatMap(
          (clusterDraft) => clusterDraft.sentences,
        ),
        coverageRepaired: clusterDrafts.some(
          (clusterDraft) => clusterDraft.coverageRepaired === true,
        ),
      };
    } catch (error) {
      if (
        error instanceof ConsolidationProviderOutputError &&
        error.missingSourceIds.length > 0
      ) {
        return {
          status: 'completed_noop',
          consolidationId: null,
          memoryId: null,
          sourceCount: sources.length,
          sentenceCount: 0,
          unsupportedSentenceCount: 0,
          inputFingerprint,
          modelDurationMs: Math.max(
            modelDurationMs,
            error.modelDurationMs,
          ),
          missingSourceIds: error.missingSourceIds,
          compensationAction:
            options.recoveryStrategy || 'preserve_atomic_sources',
          noopReason: 'coverage_repair_preserved_atomic_sources',
        };
      }
      throw error;
    }
    const allowed = new Set(
      sources.map((source) => source.memoryVersionId),
    );
    const sentences = draft.sentences.map((sentence) => ({
      text: sanitizeSentenceText(
        sentence.text,
        sentence.sourceVersionIds,
      ),
      sourceVersionIds: uniqueSorted(
        sentence.sourceVersionIds,
      ),
    }));
    const unsupported = sentences.filter(
      (sentence) =>
        !sentence.text ||
        sentence.sourceVersionIds.length === 0 ||
        sentence.sourceVersionIds.some((id) => !allowed.has(id)),
    );
    if (unsupported.length > 0 || sentences.length === 0) {
      const support = sentences.map((sentence) =>
        Boolean(
          sentence.text &&
          sentence.sourceVersionIds.length > 0 &&
          sentence.sourceVersionIds.every((id) => allowed.has(id)),
        ),
      );
      const consolidationId = this.persistQuarantine(
        normalizedScope,
        setHash,
        sources,
        sentences,
        support,
        existing,
        '摘要包含无有效来源支持的句子',
      );
      if (!consolidationId) {
        return this.retryAfterPersistenceDrift(
          normalizedScope,
          sourceDriftRetries,
          options,
        );
      }
      return {
        status: 'quarantined',
        consolidationId,
        memoryId: null,
        sourceCount: sources.length,
        sentenceCount: sentences.length,
        unsupportedSentenceCount:
          unsupported.length || sentences.length,
        inputFingerprint,
        modelDurationMs,
      };
    }

    let verdicts: ConsolidationSupportVerdict[];
    try {
      const providerStartedAt = performance.now();
      verdicts = await this.provider.verifySupport(
        normalizedScope,
        sources,
        sentences,
      );
      modelDurationMs += performance.now() - providerStartedAt;
    } catch (error) {
      const consolidationId = this.persistQuarantine(
        normalizedScope,
        setHash,
        sources,
        sentences,
        sentences.map(() => false),
        existing,
        `摘要语义支持核验失败：${
          error instanceof Error ? error.message : '未知错误'
        }`,
      );
      if (!consolidationId) {
        return this.retryAfterPersistenceDrift(
          normalizedScope,
          sourceDriftRetries,
          options,
        );
      }
      return {
        status: 'quarantined',
        consolidationId,
        memoryId: null,
        sourceCount: sources.length,
        sentenceCount: sentences.length,
        unsupportedSentenceCount: sentences.length,
        inputFingerprint,
        modelDurationMs,
      };
    }
    const supportByIndex = new Map(
      verdicts.map((verdict) => [
        verdict.sentenceIndex,
        verdict.supported,
      ]),
    );
    const semanticSupport = sentences.map(
      (_sentence, index) => supportByIndex.get(index) === true,
    );
    const semanticallyUnsupported = semanticSupport.filter(
      (supported) => !supported,
    ).length;
    if (
      verdicts.length !== sentences.length ||
      semanticallyUnsupported > 0
    ) {
      const consolidationId = this.persistQuarantine(
        normalizedScope,
        setHash,
        sources,
        sentences,
        semanticSupport,
        existing,
        '摘要包含未被引用来源语义蕴含的句子',
      );
      if (!consolidationId) {
        return this.retryAfterPersistenceDrift(
          normalizedScope,
          sourceDriftRetries,
          options,
        );
      }
      return {
        status: 'quarantined',
        consolidationId,
        memoryId: null,
        sourceCount: sources.length,
        sentenceCount: sentences.length,
        unsupportedSentenceCount:
          semanticallyUnsupported || sentences.length,
        inputFingerprint,
        modelDurationMs,
      };
    }

    const persisted = this.persistAtomically<
      ConsolidationResult | null
    >(() => {
      const latestSources = this.eligibleSources(
        normalizedScope,
        this.loadSources(normalizedScope),
      );
      if (sourceSetHash(latestSources) !== setHash) {
        return null;
      }
      const current = this.findConsolidation(
        normalizedScope,
        this.provider.model,
        this.provider.promptVersion,
      );
      if (
        current &&
        cleanText(current.source_set_hash) === setHash &&
        cleanText(current.status) === 'active' &&
        this.consolidationMemoryMatchesScope(
          asNullableText(current.memory_id),
          normalizedScope,
        )
      ) {
        const currentId = cleanText(current.id);
        return {
          status: 'unchanged',
          consolidationId: currentId,
          memoryId: asNullableText(current.memory_id),
          sourceCount: sources.length,
          sentenceCount: this.sentenceCount(currentId),
          unsupportedSentenceCount: 0,
          inputFingerprint,
          modelDurationMs,
        };
      }
      const sameSourceProjection = Boolean(
        current &&
        cleanText(current.source_set_hash) === setHash,
      );
      const reuseProjection = Boolean(
        sameSourceProjection &&
        cleanText(current?.status) !== 'quarantined',
      );
      const consolidationId = reuseProjection
        ? cleanText(current?.id)
        : randomUUID();
      const effectiveSentences = reuseProjection
        ? this.storedSentences(consolidationId)
        : sentences;
      if (effectiveSentences.length === 0) {
        throw new Error('历史巩固 projection 缺少逐句来源链');
      }
      const effectiveContent = [
        `[派生摘要：${normalizedScope.scopeType}/${normalizedScope.scopeKey}]`,
        ...effectiveSentences.map((sentence) => sentence.text),
      ].join('\n');
      const generatedAt = new Date().toISOString();
      const attachedMemoryId = current
        ? asNullableText(current.memory_id)
        : null;
      const existingMemoryId =
        this.consolidationMemoryMatchesScope(
          attachedMemoryId,
          normalizedScope,
        )
          ? attachedMemoryId
          : null;
      const reusable = existingMemoryId
        ? null
        : this.findReusableConsolidationMemory(
            normalizedScope,
            effectiveContent,
          );
      const targetMemoryId =
        existingMemoryId || reusable?.memoryId || null;
      const persistedMemory = targetMemoryId
        ? this.memoryStore.update(
            targetMemoryId,
            {
              title: scopeTitle(normalizedScope),
              content: effectiveContent,
              summary: effectiveSentences
                .map((entry) => entry.text)
                .join(' '),
              kind: derivedKind(normalizedScope),
              status: 'active',
              importance: 0.7,
              confidence: 1,
              source: 'consolidation',
              sourceRef: `consolidation:${consolidationId}`,
              createdBy: `consolidator:${this.provider.model}`,
              validFrom: generatedAt,
              scopeType: normalizedScope.accessScopeType,
              scopeKey: normalizedScope.accessScopeKey,
              predicateKey: [
                'derived',
                normalizedScope.scopeType,
                hash(scopeIdentity(normalizedScope)),
              ].join('::'),
              normalizedValueHash: setHash,
              normalizedValue: setHash,
              predicateCardinality: 'single',
              idempotencyKey: [
                existingMemoryId
                  ? 'consolidation-rebuild'
                  : 'consolidation-reuse',
                consolidationId,
                setHash,
              ].join(':'),
              closePreviousVersion: true,
            },
            normalizedScope.userId,
          )
        : this.memoryStore.remember({
            userId: normalizedScope.userId,
            namespace: normalizedScope.namespace,
            kind: derivedKind(normalizedScope),
            title: scopeTitle(normalizedScope),
            content: effectiveContent,
            summary: effectiveSentences
              .map((entry) => entry.text)
              .join(' '),
            tags: [
              'derived',
              `scope:${normalizedScope.scopeType}`,
            ],
            importance: 0.7,
            confidence: 1,
            source: 'consolidation',
            sourceRef: `consolidation:${consolidationId}`,
            createdBy: `consolidator:${this.provider.model}`,
            validFrom: generatedAt,
            scopeType: normalizedScope.accessScopeType,
            scopeKey: normalizedScope.accessScopeKey,
            stableKey: [
              'derived',
              hash(scopeIdentity(normalizedScope)),
              this.provider.model,
              this.provider.promptVersion,
              ...(current
                ? ['rehome', consolidationId]
                : []),
            ].join(':'),
            idempotencyKey: [
              current
                ? 'consolidation-rehome'
                : 'consolidation-create',
              current
                ? consolidationId
                : hash(scopeIdentity(normalizedScope)),
              current ? setHash : this.provider.model,
              current ? generatedAt : this.provider.promptVersion,
            ].join(':'),
            predicateKey: [
              'derived',
              normalizedScope.scopeType,
              hash(scopeIdentity(normalizedScope)),
            ].join('::'),
            normalizedValueHash: setHash,
            normalizedValue: setHash,
            predicateCardinality: 'single',
          }).memory;

      this.persistSupported(
        consolidationId,
        persistedMemory.id,
        normalizedScope,
        setHash,
        sources,
        effectiveSentences,
        current,
        reuseProjection,
      );
      return {
        status: current ? 'rebuilt' : 'created',
        consolidationId,
        memoryId: persistedMemory.id,
        sourceCount: sources.length,
        sentenceCount: effectiveSentences.length,
        unsupportedSentenceCount: 0,
        inputFingerprint,
        modelDurationMs,
        compensationAction:
          options.recoveryStrategy ||
          (draft.coverageRepaired ? 'coverage_repaired_once' : undefined),
      };
    });
    if (persisted) return persisted;
    if (sourceDriftRetries >= 2) {
      throw new Error(
        '巩固来源在生成期间持续变化，请稍后重试',
      );
    }
    return this.consolidateScopeAttempt(
      normalizedScope,
      sourceDriftRetries + 1,
      options,
    );
  }

  private retryAfterPersistenceDrift(
    scope: ConsolidationScope,
    sourceDriftRetries: number,
    options: ConsolidationRunOptions,
  ): Promise<ConsolidationResult> {
    if (sourceDriftRetries >= 2) {
      throw new Error(
        '巩固来源或 projection 在生成期间持续变化，请稍后重试',
      );
    }
    return this.consolidateScopeAttempt(
      scope,
      sourceDriftRetries + 1,
      options,
    );
  }

  private storedSentences(
    consolidationId: string,
  ): ConsolidationSentence[] {
    const rows = this.database
      .prepare(
        `SELECT id, sentence_text
         FROM derived_consolidation_sentences
         WHERE consolidation_id = ?
         ORDER BY sentence_index ASC`,
      )
      .all(consolidationId) as DatabaseRow[];
    if (rows.length === 0) return [];
    const sourceRows = this.database
      .prepare(
        `SELECT ss.sentence_id, ss.memory_version_id
         FROM derived_sentence_sources ss
         JOIN derived_consolidation_sentences s
           ON s.id = ss.sentence_id
         WHERE s.consolidation_id = ?
         ORDER BY ss.sentence_id, ss.memory_version_id`,
      )
      .all(consolidationId) as DatabaseRow[];
    const sourcesBySentence = new Map<string, string[]>();
    for (const row of sourceRows) {
      const sentenceId = cleanText(row.sentence_id);
      const sourceVersionId = cleanText(row.memory_version_id);
      if (!sentenceId || !sourceVersionId) continue;
      const sourceIds = sourcesBySentence.get(sentenceId) || [];
      sourceIds.push(sourceVersionId);
      sourcesBySentence.set(sentenceId, sourceIds);
    }
    return rows.map((row) => ({
      text: cleanText(row.sentence_text),
      sourceVersionIds: uniqueSorted(
        sourcesBySentence.get(cleanText(row.id)) || [],
      ),
    }));
  }

  private invalidateBySourceMemory(
    memoryId: string,
  ): ConsolidationScope[] {
    const rows = this.database
      .prepare(
        `SELECT DISTINCT d.*
         FROM derived_consolidations d
         JOIN derived_consolidation_sources s
           ON s.consolidation_id = d.id
         JOIN memory_versions v ON v.id = s.memory_version_id
         WHERE v.memory_item_id = ?
           AND d.status = 'active'`,
      )
      .all(memoryId) as DatabaseRow[];
    if (rows.length === 0) return [];
    const timestamp = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const consolidationId = cleanText(row.id);
        const derivedMemoryId = asNullableText(row.memory_id);
        this.database
          .prepare(
            `UPDATE derived_consolidations
             SET status = 'stale', stale_at = ?, last_error = NULL
             WHERE id = ? AND status = 'active'`,
          )
          .run(timestamp, consolidationId);
        if (derivedMemoryId) {
          this.database
            .prepare(
              `UPDATE memories
               SET status = 'archived', updated_at = ?
               WHERE id = ?`,
            )
            .run(timestamp, derivedMemoryId);
          this.database
            .prepare(
              `UPDATE memory_items
               SET status = 'archived', archived_at = ?,
                   archive_reason = 'source_changed', updated_at = ?
               WHERE id = ?`,
            )
            .run(timestamp, timestamp, derivedMemoryId);
          this.database
            .prepare(
              'DELETE FROM memory_embeddings WHERE memory_id = ?',
            )
            .run(derivedMemoryId);
          this.database
            .prepare(
              'DELETE FROM memory_ann_index WHERE memory_id = ?',
            )
            .run(derivedMemoryId);
          this.database
            .prepare(
              'DELETE FROM memory_term_index WHERE memory_id = ?',
            )
            .run(derivedMemoryId);
          this.database
            .prepare(
              'DELETE FROM memories_fts WHERE memory_id = ?',
            )
            .run(derivedMemoryId);
        }
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return rows.map(scopeFromStoredRow);
  }

  private sourceSelection(scope: ConsolidationScope): {
    scopeFilter: string;
    values: Array<string | number>;
  } {
    const values: Array<string | number> = [
      scope.userId,
      scope.namespace,
      scope.accessScopeType || 'personal',
      scope.accessScopeKey || 'self',
    ];
    let scopeFilter = '';
    if (scope.scopeType === 'topic') {
      scopeFilter = 'AND i.kind = ?';
      values.push(scope.scopeKey.replace(/^kind:/u, ''));
    } else if (scope.scopeType === 'session') {
      scopeFilter = `
        AND EXISTS (
          SELECT 1
          FROM memory_evidence e
          JOIN conversation_turns t ON t.id = e.turn_id
          WHERE e.memory_version_id = v.id
            AND t.session_id = ?
        )`;
      values.push(scope.scopeKey);
    } else {
      scopeFilter = `
        AND (
          i.predicate_key = ?
          OR substr(i.predicate_key, 1, length(?) + 2) = ? || '::'
        )`;
      values.push(
        scope.scopeKey,
        scope.scopeKey,
        scope.scopeKey,
      );
    }
    return { scopeFilter, values };
  }

  private sourceCount(scope: ConsolidationScope): number {
    const { scopeFilter, values } = this.sourceSelection(scope);
    return Number(
      this.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_items i
           JOIN memories m ON m.id = i.id
           JOIN memory_versions v ON v.id = i.current_version_id
           WHERE i.user_id = ?
             AND i.namespace = ?
             AND i.scope_type = ?
             AND i.scope_key = ?
             AND m.scope_type = i.scope_type
             AND m.scope_key = i.scope_key
             AND v.scope_type = i.scope_type
             AND v.scope_key = i.scope_key
             AND i.status = 'active'
             AND m.status = 'active'
             AND m.source NOT IN ('consolidation', 'hierarchical_summary')
             ${scopeFilter}`,
        )
        .get(...values)?.count || 0,
    );
  }

  private eligibleSources(
    scope: ConsolidationScope,
    sources: ConsolidationSource[],
  ): ConsolidationSource[] {
    return this.eligibleSourceClusters(scope, sources).flat();
  }

  private eligibleSourceClusters(
    _scope: ConsolidationScope,
    sources: ConsolidationSource[],
  ): ConsolidationSource[][] {
    const clusters = new Map<string, ConsolidationSource[]>();
    for (const source of sources) {
      if (!source.predicateKey) continue;
      const temporalIdentity = [
        source.occurredAt || '',
        source.validFrom || '',
        source.validTo || '',
      ].join('|');
      const key = [
        source.kind,
        source.predicateKey,
        source.negated ? 'negated' : 'affirmed',
        temporalIdentity,
      ].join('\u0000');
      const cluster = clusters.get(key) || [];
      cluster.push(source);
      clusters.set(key, cluster);
    }
    const eligible: ConsolidationSource[][] = [];
    for (const hardCluster of clusters.values()) {
      const ordered = [...hardCluster].sort((left, right) =>
        [left.content, left.memoryVersionId].join('\u0000').localeCompare(
          [right.content, right.memoryVersionId].join('\u0000'),
          'zh-CN',
        ),
      );
      const parents = ordered.map((_source, index) => index);
      const root = (index: number): number => {
        let current = index;
        while (parents[current] !== current) {
          parents[current] = parents[parents[current]];
          current = parents[current];
        }
        return current;
      };
      const connect = (left: number, right: number): void => {
        const leftRoot = root(left);
        const rightRoot = root(right);
        if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
      };
      for (let left = 0; left < ordered.length; left += 1) {
        for (let right = left + 1; right < ordered.length; right += 1) {
          if (sourcesSemanticallyRelated(ordered[left], ordered[right])) {
            connect(left, right);
          }
        }
      }
      const semanticClusters = new Map<number, ConsolidationSource[]>();
      ordered.forEach((source, index) => {
        const sourceRoot = root(index);
        const cluster = semanticClusters.get(sourceRoot) || [];
        cluster.push(source);
        semanticClusters.set(sourceRoot, cluster);
      });
      eligible.push(
        ...[...semanticClusters.values()].filter(
          (cluster) => cluster.length >= this.minimumSources,
        ),
      );
    }
    return eligible;
  }

  private prepareSourceClusters(
    scope: ConsolidationScope,
    sources: ConsolidationSource[],
    options: ConsolidationRunOptions,
  ): ConsolidationSource[][] {
    const eligible = this.eligibleSourceClusters(scope, sources);
    if (options.recoveryStrategy !== 'single_attempt_protocol_repair') {
      return eligible;
    }
    const repaired: ConsolidationSource[][] = [];
    for (const cluster of eligible) {
      if (cluster.length <= this.minimumSources) {
        repaired.push(cluster);
        continue;
      }
      for (let index = 0; index < cluster.length;) {
        const remaining = cluster.length - index;
        const take = remaining < this.minimumSources * 2
          ? remaining
          : this.minimumSources;
        repaired.push(cluster.slice(index, index + take));
        index += take;
      }
    }
    return repaired;
  }

  private loadSources(
    scope: ConsolidationScope,
  ): ConsolidationSource[] {
    const { scopeFilter, values } = this.sourceSelection(scope);
    values.push(this.maximumSources);
    const rows = this.database
      .prepare(
        `SELECT
           m.id AS memory_id,
           v.id AS memory_version_id,
           m.kind,
           m.title,
           m.content,
           m.updated_at,
           i.predicate_key,
           i.normalized_value,
           i.normalized_value_hash,
           v.negated,
           v.occurred_at,
           v.valid_from,
           v.valid_to
         FROM memory_items i
         JOIN memories m ON m.id = i.id
         JOIN memory_versions v ON v.id = i.current_version_id
         WHERE i.user_id = ?
           AND i.namespace = ?
           AND i.scope_type = ?
           AND i.scope_key = ?
           AND m.scope_type = i.scope_type
           AND m.scope_key = i.scope_key
           AND v.scope_type = i.scope_type
           AND v.scope_key = i.scope_key
           AND i.status = 'active'
           AND m.status = 'active'
           AND m.source NOT IN ('consolidation', 'hierarchical_summary')
           AND m.source NOT LIKE 'kb:%'
           ${scopeFilter}
         ORDER BY m.importance DESC, m.updated_at DESC, m.id ASC
         LIMIT ?`,
      )
      .all(...values) as DatabaseRow[];
    return rows.map((row) => ({
      memoryId: cleanText(row.memory_id),
      memoryVersionId: cleanText(row.memory_version_id),
      kind: cleanText(row.kind) as MemoryKind,
      title: cleanText(row.title),
      content: cleanText(row.content),
      updatedAt: cleanText(row.updated_at),
      predicateKey: cleanText(row.predicate_key),
      normalizedValue: asNullableText(row.normalized_value),
      normalizedValueHash: asNullableText(
        row.normalized_value_hash,
      ),
      negated: Number(row.negated) === 1,
      occurredAt: asNullableText(row.occurred_at),
      validFrom: asNullableText(row.valid_from),
      validTo: asNullableText(row.valid_to),
    }));
  }

  private findConsolidation(
    scope: ConsolidationScope,
    model: string,
    promptVersion: string,
  ): DatabaseRow | null {
    const scopeKeys = storedScopeKeys(scope);
    return (
      this.database
        .prepare(
          `SELECT *
           FROM derived_consolidations
           WHERE user_id = ?
             AND namespace = ?
             AND scope_type = ?
             AND scope_key IN (${scopeKeys.map(() => '?').join(', ')})
             AND model = ?
             AND prompt_version = ?
           ORDER BY CASE status
                      WHEN 'active' THEN 0
                      WHEN 'quarantined' THEN 1
                      ELSE 2
                    END,
                    generated_at DESC, revision DESC, id DESC
           LIMIT 1`,
        )
        .get(
          scope.userId,
          scope.namespace,
          scope.scopeType,
          ...scopeKeys,
          model,
          promptVersion,
        ) as DatabaseRow | undefined
    ) || null;
  }

  private findExactConsolidation(
    scope: ConsolidationScope,
    setHash: string,
    model: string,
    promptVersion: string,
  ): DatabaseRow | null {
    const scopeKeys = storedScopeKeys(scope);
    return (
      this.database
        .prepare(
          `SELECT *
           FROM derived_consolidations
           WHERE user_id = ?
             AND namespace = ?
             AND scope_type = ?
             AND scope_key IN (${scopeKeys.map(() => '?').join(', ')})
             AND source_set_hash = ?
             AND model = ?
             AND prompt_version = ?
           ORDER BY id DESC
           LIMIT 1`,
        )
        .get(
          scope.userId,
          scope.namespace,
          scope.scopeType,
          ...scopeKeys,
          setHash,
          model,
          promptVersion,
        ) as DatabaseRow | undefined
    ) || null;
  }

  private findReusableConsolidationMemory(
    scope: ConsolidationScope,
    content: string,
  ): {
    consolidationId: string;
    memoryId: string;
  } | null {
    const scopeKeys = storedScopeKeys(scope);
    const row = this.database
      .prepare(
        `SELECT d.id AS consolidation_id, d.memory_id
         FROM derived_consolidations d
         JOIN memories m ON m.id = d.memory_id
         WHERE d.user_id = ?
           AND d.namespace = ?
           AND d.scope_type = ?
           AND d.scope_key IN (${scopeKeys.map(() => '?').join(', ')})
           AND d.status IN ('active', 'stale', 'quarantined')
           AND m.user_id = d.user_id
           AND m.namespace = d.namespace
           AND m.user_id = ?
           AND m.namespace = ?
           AND m.scope_type = ?
           AND m.scope_key = ?
           AND m.source = 'consolidation'
           AND m.status != 'deleted'
           AND m.checksum = ?
         ORDER BY CASE d.status
                    WHEN 'active' THEN 0
                    WHEN 'stale' THEN 1
                    ELSE 2
                  END,
                  d.generated_at DESC, d.revision DESC
         LIMIT 1`,
      )
      .get(
        scope.userId,
        scope.namespace,
        scope.scopeType,
        ...scopeKeys,
        scope.userId,
        scope.namespace,
        scope.accessScopeType || 'personal',
        scope.accessScopeKey || 'self',
        hash(cleanText(content).toLowerCase()),
      ) as DatabaseRow | undefined;
    const consolidationId = asNullableText(row?.consolidation_id);
    const memoryId = asNullableText(row?.memory_id);
    return consolidationId && memoryId
      ? { consolidationId, memoryId }
      : null;
  }

  private consolidationMemoryMatchesScope(
    memoryId: string | null,
    scope: ConsolidationScope,
  ): boolean {
    if (!memoryId) return false;
    return Boolean(
      this.database
        .prepare(
          `SELECT 1
           FROM memories
           WHERE id = ?
             AND user_id = ?
             AND namespace = ?
             AND scope_type = ?
             AND scope_key = ?
             AND source = 'consolidation'
             AND status != 'deleted'
           LIMIT 1`,
        )
        .get(
          memoryId,
          scope.userId,
          scope.namespace,
          scope.accessScopeType || 'personal',
          scope.accessScopeKey || 'self',
        ),
    );
  }

  private persistAtomically<T>(persist: () => T): T {
    return withMemoryStoreTransaction(this.database, persist);
  }

  private persistSupported(
    consolidationId: string,
    memoryId: string,
    scope: ConsolidationScope,
    setHash: string,
    sources: ConsolidationSource[],
    sentences: ConsolidationSentence[],
    existing: DatabaseRow | null,
    reuseProjection: boolean,
  ): void {
    const timestamp = new Date().toISOString();
    if (
      !reuseProjection &&
      existing &&
      cleanText(existing.status) === 'quarantined' &&
      cleanText(existing.source_set_hash) === setHash
    ) {
      this.database
        .prepare(
          `DELETE FROM derived_consolidations
           WHERE id = ? AND status = 'quarantined'`,
        )
        .run(cleanText(existing.id));
    }
    this.staleOtherModels(
      scope,
      consolidationId,
      timestamp,
      memoryId,
    );
    this.database
      .prepare(
        `UPDATE derived_consolidations
         SET memory_id = NULL
         WHERE memory_id = ? AND id != ?`,
      )
      .run(memoryId, consolidationId);
    if (reuseProjection) {
      const activated = this.database
        .prepare(
          `UPDATE derived_consolidations
           SET memory_id = ?,
               scope_key = ?,
               status = 'active',
               stale_at = NULL,
               last_error = NULL
           WHERE id = ?
             AND source_set_hash = ?
             AND model = ?
             AND prompt_version = ?`,
        )
        .run(
          memoryId,
          storedScopeKey(scope),
          consolidationId,
          setHash,
          this.provider.model,
          this.provider.promptVersion,
        );
      if (Number(activated.changes) !== 1) {
        throw new Error('历史巩固 projection 已变化，拒绝重新挂载');
      }
    } else {
      this.upsertConsolidation(
        consolidationId,
        memoryId,
        scope,
        setHash,
        'active',
        timestamp,
        null,
        null,
      );
      this.insertEvidence(
        consolidationId,
        sources,
        sentences,
        sentences.map(() => true),
      );
    }
    this.database
      .prepare(
        `UPDATE memories
         SET status = 'active', updated_at = ?
         WHERE id = ?`,
      )
      .run(timestamp, memoryId);
    this.database
      .prepare(
        `UPDATE memory_items
         SET status = 'active', archived_at = NULL,
             archive_reason = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(timestamp, memoryId);
  }

  private persistQuarantine(
    scope: ConsolidationScope,
    setHash: string,
    sources: ConsolidationSource[],
    sentences: ConsolidationSentence[],
    sentenceSupport: boolean[],
    expected: DatabaseRow | null,
    reason: string,
  ): string | null {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const latestSources = this.eligibleSources(
        scope,
        this.loadSources(scope),
      );
      const current = this.findConsolidation(
        scope,
        this.provider.model,
        this.provider.promptVersion,
      );
      if (
        sourceSetHash(latestSources) !== setHash ||
        projectionSnapshot(current) !== projectionSnapshot(expected)
      ) {
        this.database.exec('ROLLBACK');
        return null;
      }
      const duplicate = this.findExactConsolidation(
        scope,
        setHash,
        this.provider.model,
        this.provider.promptVersion,
      );
      if (duplicate) {
        this.database.exec('ROLLBACK');
        return cleanText(duplicate.status) === 'quarantined'
          ? cleanText(duplicate.id)
          : null;
      }
      const timestamp = new Date().toISOString();
      const consolidationId = randomUUID();
      this.upsertConsolidation(
        consolidationId,
        null,
        scope,
        setHash,
        'quarantined',
        timestamp,
        reason,
        null,
      );
      this.insertEvidence(
        consolidationId,
        sources,
        sentences,
        sentenceSupport,
      );
      this.database.exec('COMMIT');
      return consolidationId;
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  private upsertConsolidation(
    id: string,
    memoryId: string | null,
    scope: ConsolidationScope,
    setHash: string,
    status: 'active' | 'quarantined',
    timestamp: string,
    lastError: string | null,
    existing: DatabaseRow | null,
  ): void {
    if (existing) {
      this.database
        .prepare(
          `UPDATE derived_consolidations
           SET memory_id = COALESCE(?, memory_id),
               scope_key = ?,
               source_set_hash = ?,
               status = ?,
               generated_at = ?,
               stale_at = NULL,
               last_error = ?,
               revision = revision + 1
           WHERE id = ?`,
        )
        .run(
          memoryId,
          storedScopeKey(scope),
          setHash,
          status,
          timestamp,
          lastError,
          id,
        );
      return;
    }
    this.database
      .prepare(
        `INSERT INTO derived_consolidations (
           id, memory_id, user_id, namespace, scope_type, scope_key,
           source_set_hash, model, prompt_version, status,
           generated_at, last_error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        memoryId,
        scope.userId,
        scope.namespace,
        scope.scopeType,
        storedScopeKey(scope),
        setHash,
        this.provider.model,
        this.provider.promptVersion,
        status,
        timestamp,
        lastError,
      );
  }

  private insertEvidence(
    consolidationId: string,
    sources: ConsolidationSource[],
    sentences: ConsolidationSentence[],
    sentenceSupport: boolean[],
  ): void {
    const insertSource = this.database.prepare(
      `INSERT INTO derived_consolidation_sources (
         consolidation_id, memory_version_id
       ) VALUES (?, ?)`,
    );
    for (const source of sources) {
      insertSource.run(
        consolidationId,
        source.memoryVersionId,
      );
    }
    const insertSentence = this.database.prepare(
      `INSERT INTO derived_consolidation_sentences (
         id, consolidation_id, sentence_index, sentence_text, supported
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertSentenceSource = this.database.prepare(
      `INSERT INTO derived_sentence_sources (
         sentence_id, memory_version_id
       ) VALUES (?, ?)`,
    );
    for (const [index, sentence] of sentences.entries()) {
      const sentenceId = randomUUID();
      insertSentence.run(
        sentenceId,
        consolidationId,
        index,
        sentence.text || '[unsupported]',
        sentenceSupport[index] === true ? 1 : 0,
      );
      for (const versionId of sentence.sourceVersionIds) {
        if (
          sources.some(
            (source) => source.memoryVersionId === versionId,
          )
        ) {
          insertSentenceSource.run(sentenceId, versionId);
        }
      }
    }
  }

  private staleOtherModels(
    scope: ConsolidationScope,
    activeId: string,
    timestamp: string,
    targetMemoryId: string,
  ): void {
    const scopeKeys = storedScopeKeys(scope);
    const rows = this.database
      .prepare(
        `SELECT id, memory_id
         FROM derived_consolidations
         WHERE user_id = ?
           AND namespace = ?
           AND scope_type = ?
           AND scope_key IN (${scopeKeys.map(() => '?').join(', ')})
           AND id != ?
           AND status = 'active'`,
      )
      .all(
        scope.userId,
        scope.namespace,
        scope.scopeType,
        ...scopeKeys,
        activeId,
    ) as DatabaseRow[];
    for (const row of rows) {
      const consolidationId = cleanText(row.id);
      const memoryId = asNullableText(row.memory_id);
      if (memoryId === targetMemoryId) {
        this.database
          .prepare(
            `UPDATE derived_consolidations
             SET status = 'stale', stale_at = ?, memory_id = NULL
             WHERE id = ?`,
          )
          .run(timestamp, consolidationId);
        continue;
      }
      this.database
        .prepare(
          `UPDATE derived_consolidations
           SET status = 'stale', stale_at = ?
           WHERE id = ?`,
        )
        .run(timestamp, consolidationId);
      if (!memoryId) continue;
      if (!this.consolidationMemoryMatchesScope(memoryId, scope)) {
        this.database
          .prepare(
            `UPDATE derived_consolidations
             SET memory_id = NULL
             WHERE id = ? AND memory_id = ?`,
          )
          .run(consolidationId, memoryId);
        continue;
      }
      this.database
        .prepare(
          `UPDATE memories
           SET status = 'archived', updated_at = ?
           WHERE id = ?`,
        )
        .run(timestamp, memoryId);
      this.database
        .prepare(
          `UPDATE memory_items
           SET status = 'archived', archived_at = ?,
               archive_reason = 'model_replaced', updated_at = ?
           WHERE id = ?`,
        )
        .run(timestamp, timestamp, memoryId);
    }
  }

  private sentenceCount(consolidationId: string): number {
    return Number(
      this.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM derived_consolidation_sentences
           WHERE consolidation_id = ?`,
        )
        .get(consolidationId)?.count || 0,
    );
  }
}

export {
  CONSOLIDATION_SYSTEM_PROMPT,
  responseSchema as consolidationResponseSchema,
};
