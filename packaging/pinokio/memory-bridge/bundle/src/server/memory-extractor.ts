import { z } from 'zod';
import type {
  ConversationTurn,
  MemoryCandidateInput,
  Sensitivity,
} from './lifecycle-store.js';
import { MEMORY_KINDS, type MemoryKind } from './types.js';
import { backgroundModelAbortSignal } from './model-qos.js';

export const MEMORY_EXTRACTOR_IMPLEMENTATION_ID =
  'ollama-structured-memory-extractor';
export const MEMORY_EXTRACTOR_IMPLEMENTATION_VERSION = 'v22';
export const MEMORY_EXTRACTOR_IMPLEMENTATION_CONTRACT =
  `${MEMORY_EXTRACTOR_IMPLEMENTATION_ID}-` +
  MEMORY_EXTRACTOR_IMPLEMENTATION_VERSION;
export const ATOMIC_CANDIDATE_CONTENT_VERSION = 'v1';
export const ATOMIC_CANDIDATE_CONTENT_PREFIX =
  `atomic-memory-${ATOMIC_CANDIDATE_CONTENT_VERSION}:`;
const MAX_ATOMIC_CANDIDATE_CONTENT_LENGTH = 8_192;

// 对话提取链路不得产出 document_chunk（那是知识库直写条目专用 kind）
const EXTRACTION_KINDS = MEMORY_KINDS.filter(
  (kind) => kind !== 'document_chunk',
) as [MemoryKind, ...MemoryKind[]];

const extractionCandidateSchema = z.object({
  kind: z.enum(EXTRACTION_KINDS),
  subject: z.string().min(1).max(100),
  predicate: z.string().min(1).max(100),
  value: z.string().min(1).max(1000),
  content: z.string().max(2000).default(''),
  confidence: z.number().min(0).max(1),
  importance: z.number().min(0).max(1),
  sensitivity: z.enum(['normal', 'sensitive', 'credential']),
  negated: z.boolean().default(false),
  scopeType: z
    .enum(['personal', 'project', 'role', 'session'])
    .default('personal'),
  scopeKey: z.string().min(1).max(200).default('self'),
  claimOccurredAt: z.string().datetime({ offset: true }).nullable().default(null),
  claimValidFrom: z.string().datetime({ offset: true }).nullable().default(null),
  claimValidTo: z.string().datetime({ offset: true }).nullable().default(null),
  sourceExcerpt: z.string().min(1).max(1000),
  sourceAuthority: z
    .enum([
      'direct_user',
      'user_confirmed',
      'assistant_inference',
      'imported',
      'legacy_unknown',
    ])
    .default('direct_user'),
}).strict();

const extractionResponseSchema = z.object({
  candidates: z.array(z.unknown()).max(12),
}).strict();

function normalizeCandidateScores(value: unknown): unknown {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return value;
  }
  const response = value as Record<string, unknown>;
  if (!Array.isArray(response.candidates)) return value;
  const normalizeScore = (score: unknown): unknown => {
    if (
      typeof score !== 'number' ||
      !Number.isFinite(score) ||
      score <= 1
    ) {
      return score;
    }
    if (score <= 10) return score / 10;
    if (score <= 100) return score / 100;
    return score;
  };
  return {
    ...response,
    candidates: response.candidates.map((candidate) => {
      if (
        typeof candidate !== 'object' ||
        candidate === null ||
        Array.isArray(candidate)
      ) {
        return candidate;
      }
      const record = candidate as Record<string, unknown>;
      return {
        ...record,
        confidence: normalizeScore(record.confidence),
        importance: normalizeScore(record.importance),
      };
    }),
  };
}

function parseExtractionCandidates(
  value: unknown,
): Array<z.infer<typeof extractionCandidateSchema>> {
  const response = extractionResponseSchema.safeParse(
    normalizeCandidateScores(value),
  );
  if (!response.success) {
    throw new Error(
      `Ollama 记忆提取结果无效：${response.error.issues[0]?.message || '未知错误'}`,
    );
  }
  const candidates: Array<
    z.infer<typeof extractionCandidateSchema>
  > = [];
  for (const rawCandidate of response.data.candidates) {
    const candidate =
      extractionCandidateSchema.safeParse(rawCandidate);
    if (!candidate.success) continue;
    if (
      [
        candidate.data.subject,
        candidate.data.predicate,
        candidate.data.value,
        candidate.data.sourceExcerpt,
      ].some(
        (field) =>
          field.normalize('NFKC').trim().length === 0,
      )
    ) {
      continue;
    }
    candidates.push(candidate.data);
  }
  return candidates;
}

const MIN_EXCERPT_ALIGNMENT_SCORE = 0.45;
const MIN_EXCERPT_ALIGNMENT_MARGIN = 0.08;
const MIN_VALUE_EVIDENCE_COVERAGE = 0.6;
const ALIGNMENT_SCORE_EPSILON = 1e-12;
const MAX_EXTRACTION_CANDIDATES = 64;

interface SourceExcerptCandidate {
  content: string;
  value: string;
  sourceExcerpt?: string;
}

export interface AtomicCandidateContent {
  subject: string;
  predicate: string;
  value: string;
  content: string;
  sourceExcerpt?: string | null;
  negated?: boolean;
}

function splitEvidenceSentences(value: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    let boundaryEnd = index;
    let nextIndex = index + 1;
    while (
      nextIndex < value.length &&
      /["'”’）)\]}]/u.test(value[nextIndex])
    ) {
      boundaryEnd = nextIndex;
      nextIndex += 1;
    }
    const boundary =
      /[。！？；\n\r!?;]/u.test(character) ||
      (
        character === '.' &&
        (
          nextIndex === value.length ||
          /\s/u.test(value[nextIndex])
        )
      );
    if (!boundary) continue;
    const sentence = value.slice(start, boundaryEnd + 1).trim();
    if (sentence) sentences.push(sentence);
    start = boundaryEnd + 1;
    index = boundaryEnd;
  }
  const tail = value.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

const LONG_TERM_RESPONSE_DIRECTIVE_PATTERN =
  /(?:(?:以后|今后|从现在起|每次|任何时候|始终|一直|永久|长期(?!记忆|依据))[^。！？]{0,32}(?:回答|回复|称呼|使用|用)|(?:默认|固定)[^。！？]{0,20}(?:回答|回复语言|称呼))/u;

const TEMPORARY_RESPONSE_REQUEST_PATTERN =
  /(?:(?:请|麻烦)(?:只|直接|简短地?)?(?:回答|回复|告诉|解释|总结|列出)|(?:不要|别|无需|不用)(?:回答|回复|引用|猜测|猜))/u;

function shouldSkipExtractionTarget(value: string): boolean {
  const target = value.normalize('NFKC').trim();
  if (!target) return true;
  if (/[?？]\s*$/u.test(target)) return true;
  return (
    TEMPORARY_RESPONSE_REQUEST_PATTERN.test(target) &&
    !LONG_TERM_RESPONSE_DIRECTIVE_PATTERN.test(target)
  );
}

export type ExtractionTargetDisposition =
  | 'extract_now'
  | 'episode_only_non_durable'
  | 'episode_only_pattern_evidence'
  | 'not_direct_user';

const EXPLICIT_NON_DURABLE_EVIDENCE_PATTERN =
  /(?:只是(?:今天|这次|当下|临时|随口|碰巧|顺手|路过)|一次性|当天就已经结束|过后没有继续|没有参与后续|没有延续到第二天|暂时没有打算|还没有形成明确看法|目前不需要.{0,12}(?:偏好|习惯|计划)|(?:不是|并非|不代表).{0,16}(?:长期|偏好|习惯|计划|选择|喜欢)|不用根据.{0,24}(?:推断|判断)|没有由此改变.{0,16}计划|不影响.{0,16}长期安排|和当前项目没有直接关系)/u;

const EXPLICIT_DURABLE_EVIDENCE_PATTERN =
  /(?:我(?:平时|通常|一直|长期|每天|每周|每月|固定|默认|最常|更喜欢|偏好)|我的[^。！？；;]{0,24}(?:习惯|偏好|目标|规则|原则|职业|名字)(?:是|为)|(?:^|[，,；;。！？!?])(?:以后|今后|从现在起)(?:可以|请|会|要|默认|始终|一直|每次|提到|推荐|回答|回复|称呼|不要|不再)|固定|默认|始终|永久|必须|不允许|目标是|计划在)/u;

const QUESTION_EMBEDDED_DURABLE_ASSERTION_PATTERN =
  /(?:我(?:平时|通常|一直|长期|每天|每周|每月|固定|默认|最常|更喜欢|偏好)|我的[^。！？；;]{0,24}(?:习惯|偏好|目标|规则|原则|职业|名字)(?:是|为)|(?:^|[，,；;。！？!?])(?:以后|今后|从现在起)(?:可以|请|会|要|默认|始终|一直|每次|提到|推荐|回答|回复|称呼|不要|不再))/u;

const IMPLICIT_REPEATED_BEHAVIOR_PATTERN =
  /(?:今天照常|今天也照常(?:做|完成)?|这周又|最近没有中断|这两天[^。！？；;]{0,24}继续保持|今天继续|仍然坚持|依旧会|照例|忙完[^。！？；;]{0,24}还是|我还是去|又坚持了)/u;

/**
 * Decide which memory layer should receive one evidence clause before an LLM
 * call. This deliberately recognizes only explicit low-risk language. Unknown
 * wording still goes to the structured extractor instead of being discarded.
 */
export function extractionTargetDisposition(
  turnContent: string,
  targetSentence: string,
): ExtractionTargetDisposition {
  const target = targetSentence.normalize('NFKC').trim();
  if (
    !target ||
    shouldSkipExtractionTarget(target) ||
    !directUserEvidenceContext(turnContent, targetSentence)
  ) {
    return 'not_direct_user';
  }
  const normalizedTurn = turnContent.normalize('NFKC');
  if (
    EXPLICIT_NON_DURABLE_EVIDENCE_PATTERN.test(normalizedTurn) &&
    !EXPLICIT_DURABLE_EVIDENCE_PATTERN.test(normalizedTurn)
  ) {
    return 'episode_only_non_durable';
  }
  if (
    IMPLICIT_REPEATED_BEHAVIOR_PATTERN.test(target) &&
    !EXPLICIT_DURABLE_EVIDENCE_PATTERN.test(target)
  ) {
    return 'episode_only_pattern_evidence';
  }
  return 'extract_now';
}

function evidenceTokens(value: string): Set<string> {
  const normalized = value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN');
  const tokens = new Set<string>();
  for (
    const segment of
    normalized.match(
      /[\p{Script=Han}]+|(?:(?![\p{Script=Han}])[\p{L}\p{N}+#/])+/gu,
    ) || []
  ) {
    if (/^\p{Script=Han}+$/u.test(segment)) {
      if (segment.length === 1) tokens.add(segment);
      for (let index = 0; index < segment.length - 1; index += 1) {
        tokens.add(segment.slice(index, index + 2));
      }
    } else if (segment.length > 1) {
      tokens.add(segment);
    }
  }
  return tokens;
}

function tokenIntersection(
  left: Set<string>,
  right: Set<string>,
): number {
  let count = 0;
  for (const token of left) {
    if (right.has(token)) count += 1;
  }
  return count;
}

const HAN_TOKEN_PATTERN = /\p{Script=Han}/u;

function hasHanToken(tokens: Set<string>): boolean {
  for (const token of tokens) {
    if (HAN_TOKEN_PATTERN.test(token)) return true;
  }
  return false;
}

function scriptAgnosticTokens(tokens: Set<string>): Set<string> {
  const filtered = new Set<string>();
  for (const token of tokens) {
    if (!HAN_TOKEN_PATTERN.test(token)) filtered.add(token);
  }
  return filtered;
}

/**
 * Dice over comparable tokens. When the two sides live in different scripts
 * (e.g. a Chinese summary content for an English source sentence), Han
 * bigrams can never intersect and the plain Dice collapses to ~0, silently
 * rejecting well-grounded cross-language candidates. In that case compare
 * only the script-agnostic (non-Han) tokens both sides could plausibly
 * share: names, numbers, times, product and place names in Latin script.
 */
function comparableTokenDice(
  left: Set<string>,
  right: Set<string>,
): number {
  if (left.size === 0 || right.size === 0) return 0;
  if (hasHanToken(left) !== hasHanToken(right)) {
    left = scriptAgnosticTokens(left);
    right = scriptAgnosticTokens(right);
    if (left.size === 0 || right.size === 0) return 0;
  }
  return (2 * tokenIntersection(left, right)) /
    (left.size + right.size);
}

const NON_USER_DISCOURSE_PATTERN =
  /(?:我只是引用|并?不代表我(?:自己)?|请识别这些否认|(?:以下|这些|下面|后面|接下来)[^。！？\n\r]{0,32}(?:引用|第三方|别人的事实|假设|反话|反讽|虚构|假数据)|(?:都是|都只是|都只是假设)[^。！？\n\r]{0,16}(?:别人|第三方|假设|反话|虚构))/iu;

const HYPOTHETICAL_DISCOURSE_PATTERN =
  /(?:假设(?:场景)?(?:如下|为|是)?|以下[^。！？\n\r]{0,24}假设|虚构场景|模拟场景|(?:如果|假如|倘若)[^。！？\n\r]{0,64}(?:也许|可能|或许|说不定)|只是[^。！？\n\r]{0,16}假设)/iu;

const THIRD_PARTY_DISCOURSE_PATTERN =
  /(?:[\p{Script=Han}A-Za-z0-9]{1,20}(?:资料|档案|信息)(?:如下|是)|(?:下面|以下|接下来)[^。！？\n\r]{0,24}(?:引用|第三方|别人的资料|他人资料)|引用(?:内容)?如下)/iu;

const SARCASM_DISCOURSE_PATTERN =
  /(?:开启|进入|以下是|接下来是)[^。！？\n\r]{0,16}(?:反讽|反话|讽刺)(?:模式)?/iu;

const ROLEPLAY_DISCOURSE_PATTERN =
  /(?:我(?:现在|接下来)?(?:要)?扮演|角色扮演|假装我是|进入[^。！？\n\r]{0,16}角色)/iu;

const DIRECT_USER_RESET_PATTERN =
  /(?:我的真实|我本人(?:的)?(?:真实)?|本人真实|真实情况(?:是|如下)|回到本人|退出(?:假设|反讽|反话|讽刺|角色扮演|扮演)模式?)/iu;

const NEGATED_DIRECT_USER_RESET_PATTERN =
  /(?:不是|并非|不代表|并不代表)[^。！？；;\n\r]{0,12}(?:我的真实|我本人(?:的)?(?:真实)?|本人真实|真实情况)/iu;

const ATTRIBUTION_PATTERN =
  /^(?:据\s*)?(?<speaker>[\p{Script=Han}A-Za-z0-9]{1,20}?)(?:一直|总是|总|曾经|刚刚)?(?:说|表示|认为|声称|提到|告诉我|写道|建议|断言)\s*(?:[：:,，]\s*)?(?:[“‘"'「『]\s*)?$/u;

const SENTENCE_ATTRIBUTION_PATTERN =
  /^(?:据\s*)?(?<speaker>[\p{Script=Han}A-Za-z0-9]{1,20}?)(?:一直|总是|总|曾经|刚刚)?(?:说|表示|认为|声称|提到|告诉我|写道|建议|断言)(?=\s*(?:[：:,，]|[“‘"'「『]|我|本人|你|您|他|她|它|他们|她们|它们|其|自己))/u;

function excerptInsideQuotation(
  turnContent: string,
  start: number,
  end: number,
): boolean {
  for (const [open, close] of [
    ['“', '”'],
    ['‘', '’'],
    ['「', '」'],
    ['『', '』'],
  ]) {
    const openBefore = turnContent.lastIndexOf(open, start);
    const closeBefore = turnContent.lastIndexOf(close, start);
    const closeAfter = turnContent.indexOf(close, end);
    if (
      openBefore >= 0 &&
      openBefore > closeBefore &&
      closeAfter >= end
    ) {
      return true;
    }
  }
  const doubleQuotesBefore = (
    turnContent.slice(0, start).match(/"/gu) || []
  ).length;
  return (
    doubleQuotesBefore % 2 === 1 &&
    turnContent.indexOf('"', end) >= end
  );
}

function directUserEvidenceContext(
  turnContent: string,
  sourceExcerpt: string,
): boolean {
  const start = turnContent.indexOf(sourceExcerpt);
  if (
    start < 0 ||
    start !== turnContent.lastIndexOf(sourceExcerpt)
  ) {
    return false;
  }
  let directUserDiscourse = true;
  let sentenceCursor = 0;
  for (const discourseSentence of splitEvidenceSentences(
    turnContent,
  )) {
    const discourseStart = turnContent.indexOf(
      discourseSentence,
      sentenceCursor,
    );
    const discourseEnd =
      discourseStart + discourseSentence.length;
    sentenceCursor = discourseEnd;
    if (
      DIRECT_USER_RESET_PATTERN.test(discourseSentence) &&
      !NEGATED_DIRECT_USER_RESET_PATTERN.test(discourseSentence)
    ) {
      directUserDiscourse = true;
    } else if (
      NON_USER_DISCOURSE_PATTERN.test(discourseSentence) ||
      HYPOTHETICAL_DISCOURSE_PATTERN.test(discourseSentence) ||
      THIRD_PARTY_DISCOURSE_PATTERN.test(discourseSentence) ||
      SARCASM_DISCOURSE_PATTERN.test(discourseSentence) ||
      ROLEPLAY_DISCOURSE_PATTERN.test(discourseSentence)
    ) {
      directUserDiscourse = false;
    }
    if (start >= discourseStart && start < discourseEnd) {
      if (!directUserDiscourse) return false;
      break;
    }
  }
  const end = start + sourceExcerpt.length;
  if (excerptInsideQuotation(turnContent, start, end)) return false;
  const sentenceStart = Math.max(
    turnContent.lastIndexOf('。', start - 1),
    turnContent.lastIndexOf('！', start - 1),
    turnContent.lastIndexOf('？', start - 1),
    turnContent.lastIndexOf(';', start - 1),
    turnContent.lastIndexOf('；', start - 1),
    turnContent.lastIndexOf('\n', start - 1),
  ) + 1;
  const sentenceEndCandidates = [
    turnContent.indexOf('。', end),
    turnContent.indexOf('！', end),
    turnContent.indexOf('？', end),
    turnContent.indexOf(';', end),
    turnContent.indexOf('；', end),
    turnContent.indexOf('\n', end),
  ].filter((index) => index >= 0);
  const sentenceEnd =
    sentenceEndCandidates.length > 0
      ? Math.min(...sentenceEndCandidates) + 1
      : turnContent.length;
  const sentence = turnContent
    .slice(sentenceStart, sentenceEnd)
    .trim();
  const sentenceAttribution = sentence.match(
    SENTENCE_ATTRIBUTION_PATTERN,
  );
  if (sentenceAttribution) {
    const speaker = sentenceAttribution.groups?.speaker
      ?.normalize('NFKC')
      .trim();
    if (speaker !== '我' && speaker !== '本人') return false;
  }
  const prefix = turnContent.slice(sentenceStart, start).trim();
  const attribution = prefix.match(ATTRIBUTION_PATTERN);
  if (!attribution) return true;
  const speaker = attribution.groups?.speaker
    ?.normalize('NFKC')
    .trim();
  return speaker === '我' || speaker === '本人';
}

function excerptAlignmentScore(
  candidate: SourceExcerptCandidate,
  sentence: string,
): number {
  const contentTokens = evidenceTokens(candidate.content);
  const sentenceTokens = evidenceTokens(sentence);
  if (sentenceTokens.size === 0) return 0;
  const contentDice = comparableTokenDice(
    contentTokens,
    sentenceTokens,
  );
  const valueCoverage = excerptValueEvidenceCoverage(
    candidate,
    sentence,
  );
  const normalizedSentence = sentence
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN');
  const normalizedValue = candidate.value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .trim();
  const exactValueBonus =
    normalizedValue.length >= 2 &&
    normalizedSentence.includes(normalizedValue)
      ? 0.2
      : 0;
  return (
    contentDice * 0.65 +
    valueCoverage * 0.35 +
    exactValueBonus
  );
}

function excerptValueEvidenceCoverage(
  candidate: SourceExcerptCandidate,
  sentence: string,
): number {
  const valueTokens = evidenceTokens(candidate.value);
  const sentenceTokens = evidenceTokens(sentence);
  if (valueTokens.size === 0) return 0;
  let comparableValue = valueTokens;
  let comparableSentence = sentenceTokens;
  if (hasHanToken(valueTokens) !== hasHanToken(sentenceTokens)) {
    comparableValue = scriptAgnosticTokens(valueTokens);
    comparableSentence = scriptAgnosticTokens(sentenceTokens);
    if (comparableValue.size === 0) return 0;
  }
  return tokenIntersection(comparableValue, comparableSentence) /
    comparableValue.size;
}

function sentenceEvidenceSimilarity(
  left: string,
  right: string,
): number {
  const leftTokens = evidenceTokens(left);
  const rightTokens = evidenceTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  return (
    2 * tokenIntersection(leftTokens, rightTokens) /
    (leftTokens.size + rightTokens.size)
  );
}

function alignNfkcEquivalentExcerpt(
  text: string,
  requestedExcerpt: string,
): string {
  const normalizedRequested = requestedExcerpt.normalize('NFKC');
  if (!normalizedRequested) return '';

  const segments = Array.from(
    new Intl.Segmenter('zh-CN', {
      granularity: 'grapheme',
    }).segment(text),
  );
  const normalizedSegments = segments.map((segment) => ({
    rawStart: segment.index,
    rawEnd: segment.index + segment.segment.length,
    normalized: segment.segment.normalize('NFKC'),
  }));
  const normalizedText = normalizedSegments
    .map((segment) => segment.normalized)
    .join('');
  if (normalizedText !== text.normalize('NFKC')) return '';

  const matchStart = normalizedText.indexOf(normalizedRequested);
  if (
    matchStart < 0 ||
    matchStart !== normalizedText.lastIndexOf(normalizedRequested)
  ) {
    return '';
  }
  const matchEnd = matchStart + normalizedRequested.length;
  let normalizedCursor = 0;
  let rawStart = -1;
  let rawEnd = -1;
  for (const segment of normalizedSegments) {
    const segmentStart = normalizedCursor;
    const segmentEnd =
      segmentStart + segment.normalized.length;
    if (segmentStart === matchStart) {
      rawStart = segment.rawStart;
    }
    if (segmentEnd === matchEnd) {
      rawEnd = segment.rawEnd;
    }
    normalizedCursor = segmentEnd;
  }
  if (rawStart < 0 || rawEnd <= rawStart) return '';
  const aligned = text.slice(rawStart, rawEnd);
  return aligned.normalize('NFKC') === normalizedRequested
    ? aligned
    : '';
}

export function alignSourceExcerpt(
  turnContent: string,
  candidate: SourceExcerptCandidate,
): string {
  const sentences = splitEvidenceSentences(turnContent);
  const requestedExcerpt = candidate.sourceExcerpt?.trim() || '';
  if (!requestedExcerpt || sentences.length === 0) return '';
  const containingSentences = sentences
    .map((sentence, index) => ({
      sentence,
      index,
      alignedExcerpt: alignNfkcEquivalentExcerpt(
        sentence,
        requestedExcerpt,
      ),
    }))
    .filter(({ alignedExcerpt }) => alignedExcerpt);
  if (containingSentences.length !== 1) return '';
  const alignedExcerpt =
    containingSentences[0].alignedExcerpt;
  if (!directUserEvidenceContext(turnContent, alignedExcerpt)) {
    return '';
  }
  const containingSentence = containingSentences[0];
  const requestedIsCompleteSentence =
    containingSentence.sentence === alignedExcerpt;
  const requestedScore = excerptAlignmentScore(
    candidate,
    alignedExcerpt,
  );
  if (
    requestedScore + ALIGNMENT_SCORE_EPSILON <
      MIN_EXCERPT_ALIGNMENT_SCORE ||
    excerptValueEvidenceCoverage(candidate, alignedExcerpt) <
      MIN_VALUE_EVIDENCE_COVERAGE
  ) {
    return '';
  }
  if (requestedIsCompleteSentence) {
    const nearDuplicate = sentences.some(
      (sentence, index) =>
        index !== containingSentence.index &&
        sentenceEvidenceSimilarity(
          containingSentence.sentence,
          sentence,
        ) >= 0.82 &&
        excerptValueEvidenceCoverage(candidate, sentence) >=
          MIN_VALUE_EVIDENCE_COVERAGE,
    );
    return nearDuplicate ? '' : alignedExcerpt;
  }
  const ranked = sentences
    .map((sentence, index) => ({
      sentence,
      index,
      score: excerptAlignmentScore(candidate, sentence),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.index - right.index,
    );
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (
    best.score + ALIGNMENT_SCORE_EPSILON <
      MIN_EXCERPT_ALIGNMENT_SCORE ||
    (
      runnerUp &&
      best.score - runnerUp.score <
        MIN_EXCERPT_ALIGNMENT_MARGIN
    ) ||
    containingSentence.index !== best.index
  ) {
    return '';
  }
  return alignedExcerpt;
}

const EXTRACTION_FORMAT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    candidates: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: EXTRACTION_KINDS },
          subject: { type: 'string' },
          predicate: { type: 'string' },
          value: { type: 'string' },
          content: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          importance: { type: 'number', minimum: 0, maximum: 1 },
          sensitivity: {
            type: 'string',
            enum: ['normal', 'sensitive', 'credential'],
          },
          negated: { type: 'boolean' },
          scopeType: {
            type: 'string',
            enum: ['personal', 'project', 'role', 'session'],
          },
          scopeKey: { type: 'string' },
          claimOccurredAt: {
            type: ['string', 'null'],
            format: 'date-time',
          },
          claimValidFrom: {
            type: ['string', 'null'],
            format: 'date-time',
          },
          claimValidTo: {
            type: ['string', 'null'],
            format: 'date-time',
          },
          sourceExcerpt: { type: 'string' },
          sourceAuthority: {
            type: 'string',
            enum: [
              'direct_user',
              'user_confirmed',
              'assistant_inference',
              'imported',
              'legacy_unknown',
            ],
          },
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
          'negated',
          'scopeType',
          'scopeKey',
          'claimOccurredAt',
          'claimValidFrom',
          'claimValidTo',
          'sourceExcerpt',
          'sourceAuthority',
        ],
      },
    },
  },
  required: ['candidates'],
} as const;

const EXTRACTION_SYSTEM_PROMPT = `
你是本地长期记忆系统的高精度事实提取器。

输入包含 fullMessage（完整用户消息）和 targetSentence（当前目标句）。
只从 targetSentence 中“用户本人的明确陈述”提取值得跨会话保存的原子记忆。
fullMessage 只用于判断上下文、指代和语用归属，严禁从其他句子提取候选。
同一句中的“但、但是、不过、然而、并且、同时”等连接词分隔的独立分句，也必须按原子事实分别处理。
宁可漏掉，也不要猜测。没有合格内容时返回 {"candidates":[]}。

执行顺序：
1. 先结合 fullMessage 判断 targetSentence 是用户事实、第三方引述、假设、反讽、否认传言还是临时请求。
2. 只检查 targetSentence；不得输出 fullMessage 中其他句子的事实。
3. targetSentence 含多个独立事实时继续拆成多个候选，每个合格事实或规则恰好对应一个候选。
4. 返回前核对每个候选都由 targetSentence 逐字证据支持，且动作对象、否定、数量和条件没有丢失。

输出 JSON 的硬约束：
- scopeType="personal" 时 scopeKey 必须精确为 "self"。
- 只有 fullMessage 中逐字出现明确项目、角色或会话名称时才允许 project/role/session；同一个名称出现多次仍是同一 scope。scopeKey 必须逐字复制该名称，不得翻译、缩写、slug 化或编造；同一事实涉及两个不同项目、只有“项目/产品”等泛称或无法判断归属时，一律返回 personal/self。
- 每个 content 和 sourceExcerpt 只能包含 targetSentence 中当前候选的支持内容，不能包含 fullMessage 的其他句子。
- content 必须改写为独立陈述，不能保留“我/我的”等依赖原消息说话者的指代；sourceExcerpt 才保留原文。
- 语言一致性（硬约束）：content、subject、predicate、value 必须与 targetSentence 保持同一语言——targetSentence 是英文时全部用英文输出，是中文时用中文，严禁翻译成另一种语言；sourceExcerpt 始终逐字复制原文。例如 targetSentence 为 "I drive a Toyota Camry and my sister Emily lives in Boston." 时，content 必须是 "The user drives a Toyota Camry." 这样的英文陈述，绝不允许输出 "用户开丰田凯美瑞。" 之类的中文改写。

原子化校准：
- fullMessage 是“我默认用深色模式。提交前必须运行测试。”且 targetSentence 是“我默认用深色模式。”时，只能输出深色模式候选。
- 另一次调用的 targetSentence 是“提交前必须运行测试。”时，只能输出测试规则候选。
- 任一调用输出另一个句子的候选都属于错误输出。
- “我不使用 Chrome，但我使用 Firefox。”必须拆为两个候选：Chrome 候选 negated=true，Firefox 候选 negated=false；每个 sourceExcerpt 只能包含自己对应的原子分句。

允许：
- 稳定身份、长期偏好、长期目标、项目决定、关系、重要事件和长期指令。
- 用户亲自制定的产品、项目和工作流规则。即使句子省略“我/我的”，只要以“必须、默认、不允许、统一、固定”等方式明确制定并具有跨会话价值，也属于 direct_user。
- 同一条消息中的多条合格规则必须逐条输出，不能把后续规则省略或合并进第一条。
- 每个候选只能表达一个可以独立理解的事实。
- content 只改写当前一个原子事实，使用第三人称完整陈述；不得复制整条消息或夹带其他句子的事实。
- sourceExcerpt 必须逐字复制 targetSentence 中支持当前候选的完整、最小句子或短片段；单一事实句优先逐字复制完整 targetSentence。
- 关于密码、密钥、令牌的长期安全政策本身可以保存。例如“所有服务密钥必须从环境变量读取”是 normal instruction，不是凭据值。

禁止：
- 临时请求、闲聊、一次性状态。
- 助手生成的结论、第三方观点、引用、假设、反讽、角色扮演。
- “这是我们一直遵守的原则”“这是之前的决定”等只指向前文、却没有在 targetSentence 中写出具体事实的元描述。
- “以下是引用/假数据/别人的事实/假设”等引导语后的列表继续继承该禁止属性，不能因为拆句而冒充用户事实。
- 用户明确否认的传言不是 negated 用户事实，不创建候选。
- 例如“我妈妈总说：‘你出生在杭州。’”是第三方引述，不得创建“用户出生在杭州”的候选。
- 否定陈述必须设置 negated=true，不能反转成肯定事实。
- 真实密码值、验证码值、令牌值、API Key 值、Cookie 值、私钥正文和其他 secret 值。不得把真实值伪装成安全政策。

字段：
- subject、predicate、value、content 和 sourceExcerpt 都必须是非空字符串。
- subject：事实主体，例如“用户”或具体项目。
- predicate：只写稳定属性或关系名称，例如“主要编辑器”或“提交信息格式”；不能吸走动作对象、否定、数量或条件。
- value：规范化值，并完整保留动作对象、否定、数量和条件。规则候选不能只写“必须可用”“不用”“不允许收集”或“遮蔽”。
- 中文例子：“断网时核心功能必须可用”应使用 value="断网时核心功能必须可用"，不能只写“核心功能必须可用”；“跟进到期前二十四小时必须提醒”必须保留“到期前二十四小时”；“产品不允许收集匿名遥测”必须保留“匿名遥测”；“日志中必须遮蔽个人信息”必须保留“个人信息”。
- English example: "Backups must run every day before 03:00" must keep the action, object, frequency, and time condition in value; "must run" alone is invalid.
- confidence：仅表示原文支持强度；逐字明确且无歧义的 direct_user 事实或规则通常应不低于 0.95。
- importance：跨会话价值；明确的长期“必须、默认、不允许、统一、固定”规则不得仅因它是规则而低于 0.5，一次性命令仍不提取。
- sensitivity：normal、sensitive 或 credential。
- scopeType/scopeKey：两个字段都不得为空，并严格服从上面的 JSON 硬约束。
- 时间未知时 claimOccurredAt、claimValidFrom、claimValidTo 返回 null。
- sourceAuthority：用户直接陈述固定为 direct_user。
`.trim();

const CREDENTIAL_PATTERN =
  /(?:密码|口令|验证码|api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|bearer|cookie|私钥|private[\s_-]*key|secret)/iu;

const CREDENTIAL_LABEL_PATTERN =
  /(?:密码|口令|验证码|服务密钥|密钥|api[\s_-]*keys?|access[\s_-]*tokens?|refresh[\s_-]*tokens?|tokens?|bearer|cookies?|私钥|private[\s_-]*keys?|client[\s_-]*secret|passwords?|passcodes?|otp|secret)/iu;

const CREDENTIAL_POLICY_VALUE_PATTERN =
  /(?:环境变量|密钥管理|密码管理|管理器|不得|不应|不要|不能|禁止|必须|应该|只允许|读取|加载|保存|存储|提交|写入|记录|日志|遮蔽|脱敏|轮换|删除|共享|泄露|硬编码|长度|至少|最多|最少|规则|政策|策略|\b(?:env(?:ironment)?[\s_-]*var(?:iable)?s?|vault|manager|never|must|should|do\s+not|don't|load|read|store|save|commit|log|redact|mask|rotate|delete|share|leak|hard[\s_-]*code|minimum|maximum|policy|rule)\b)/iu;

const CREDENTIAL_SAFETY_POLICY_PATTERN =
  /(?:从环境变量(?:中)?(?:读取|加载)|不得.{0,24}(?:日志|提交|存储|保存|硬编码|共享)|(?:日志|输出).{0,16}(?:遮蔽|脱敏)|(?:密钥|密码|令牌|token|password|secret).{0,20}(?:轮换|管理器|管理系统)|\b(?:load|read).{0,20}\benv(?:ironment)?[\s_-]*var(?:iable)?s?\b|\bnever\s+(?:commit|log|store|share)\b|\b(?:redact|mask|rotate)\b)/iu;

const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/u;

const KNOWN_SECRET_VALUE_PATTERN =
  /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})/u;

const PERSONAL_ADDRESS_LABEL_PATTERN =
  /(?:(?:收件|收货|邮寄|快递|家庭|住宅|居住|联系|长期)?地址|住址|居住地)/iu;

const PHYSICAL_ADDRESS_MARKER_PATTERN =
  /(?:特别行政区|自治区|街道|大道|单元|省|市|区|县|旗|镇|乡|路|街|巷|弄|号|栋|幢|室)/gu;

interface CredentialCandidateLike {
  predicate?: unknown;
  value?: unknown;
  content?: unknown;
  sourceExcerpt?: unknown;
  sensitivity?: unknown;
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function looksLikeCredentialLiteral(value: string): boolean {
  const cleaned = value
    .trim()
    .replace(/^[是为=:："'“‘「『\s]+/u, '')
    .replace(/["'”’」』。；;，,!?！？]+$/u, '')
    .trim();
  if (!cleaned) return false;
  if (KNOWN_SECRET_VALUE_PATTERN.test(cleaned)) return true;
  if (PEM_PRIVATE_KEY_PATTERN.test(cleaned)) return true;
  const firstToken = cleaned.split(/\s+/u)[0] || '';
  if (
    !firstToken ||
    CREDENTIAL_POLICY_VALUE_PATTERN.test(firstToken)
  ) {
    return false;
  }
  if (/^\d{4,8}$/u.test(firstToken)) return true;
  if (
    /^(?:sk-|gh[pousr]_|xox[baprs]-|demo[_-]|eyJ)[\p{L}\p{N}_.=+/-]+$/iu
      .test(firstToken)
  ) {
    return true;
  }
  if (CREDENTIAL_POLICY_VALUE_PATTERN.test(cleaned)) return false;
  return (
    firstToken.length >= 4 &&
    /^[\p{L}\p{N}_.=+/@#$%^&*!?-]+$/u.test(firstToken)
  );
}

function lineContainsCredentialSecret(line: string): boolean {
  if (KNOWN_SECRET_VALUE_PATTERN.test(line)) return true;
  if (PEM_PRIVATE_KEY_PATTERN.test(line)) return true;
  const labelMatch = line.match(CREDENTIAL_LABEL_PATTERN);
  if (!labelMatch || labelMatch.index === undefined) return false;
  const tail = line.slice(
    labelMatch.index + labelMatch[0].length,
  );
  const explicitValue = tail.match(
    /^\s*(?:(?:必须|应该|现在)?(?:是|为)|must\s+be|is|equals?|[:：=])\s*(.+)$/iu,
  );
  if (
    explicitValue?.[1] &&
    looksLikeCredentialLiteral(explicitValue[1])
  ) {
    return true;
  }
  return looksLikeCredentialLiteral(tail);
}

export function containsCredentialSecret(
  input: string | CredentialCandidateLike,
): boolean {
  const fields =
    typeof input === 'string'
      ? [input]
      : [
          textField(input.predicate),
          textField(input.value),
          textField(input.content),
          textField(input.sourceExcerpt),
        ];
  if (
    fields.some((field) =>
      field
        .split(/\r?\n/u)
        .some((line) => lineContainsCredentialSecret(line)),
    )
  ) {
    return true;
  }
  if (typeof input === 'string') return false;
  const predicate = textField(input.predicate);
  const value = textField(input.value);
  return (
    CREDENTIAL_LABEL_PATTERN.test(predicate) &&
    looksLikeCredentialLiteral(value)
  );
}

function containsSensitivePhysicalAddress(
  input: CredentialCandidateLike,
): boolean {
  const labelText = [
    textField(input.predicate),
    textField(input.content),
    textField(input.sourceExcerpt),
  ].join('\n');
  const value = textField(input.value);
  if (
    value.normalize('NFKC').length < 6 ||
    !PERSONAL_ADDRESS_LABEL_PATTERN.test(labelText)
  ) {
    return false;
  }
  return (
    value.normalize('NFKC').match(
      PHYSICAL_ADDRESS_MARKER_PATTERN,
    ) || []
  ).length >= 2;
}

export function protectedCredentialSensitivity(
  input: CredentialCandidateLike,
): Sensitivity {
  if (containsCredentialSecret(input)) return 'credential';
  const declared = textField(input.sensitivity);
  if (
    declared === 'credential' &&
    CREDENTIAL_SAFETY_POLICY_PATTERN.test(
      [
        textField(input.predicate),
        textField(input.value),
        textField(input.content),
        textField(input.sourceExcerpt),
      ].join('\n'),
    )
  ) {
    return 'normal';
  }
  if (declared === 'credential') return 'credential';
  if (containsSensitivePhysicalAddress(input)) return 'sensitive';
  return declared === 'sensitive' ? declared : 'normal';
}

interface OllamaChatResponse {
  message?: {
    content?: unknown;
  };
}

export interface MemoryExtractor {
  readonly model: string;
  readonly promptVersion: string;
  readonly extractorId?: string;
  readonly extractorVersion?: string;
  extract(turn: ConversationTurn): Promise<MemoryCandidateInput[]>;
}

export interface OllamaMemoryExtractorOptions {
  baseUrl: string;
  model: string;
  promptVersion: string;
  timeoutMs: number;
  keepAlive?: string | number;
  fetchImpl?: typeof fetch;
}

function protectCredential(
  candidate: z.infer<typeof extractionCandidateSchema>,
): Sensitivity {
  return protectedCredentialSensitivity(candidate);
}

const GENERIC_SCOPE_KEY_PATTERN =
  /^(?:self|用户|客户|产品|项目|软件|应用|系统|服务|角色|会话|新项目|开发项目|嵌入式项目|当前项目|这个项目|当前角色|当前会话|this project|this role|this session)$/iu;

const GENERIC_PROJECT_NAME_PATTERN =
  /^(?:新|开发|嵌入式|当前|这个|该|软件|应用|系统|服务|产品)$/u;

const PROJECT_ANAPHORA_PATTERN =
  /(?:本项目|该项目|这个项目)/u;

function normalizedProjectScopeKey(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s*(?:项目|软件)$/u, '')
    .toLocaleLowerCase('zh-CN');
}

export function projectScopeNamesFromText(
  value: string,
): string[] {
  const names = new Set<string>();
  for (const match of value.matchAll(
    /([A-Za-z][A-Za-z0-9_.-]{1,50})\s*(?:项目|软件)/gu,
  )) {
    names.add(match[1]);
  }
  for (const match of value.matchAll(
    /([\p{Script=Han}]{1,20})项目/gu,
  )) {
    const name = match[1];
    if (!GENERIC_PROJECT_NAME_PATTERN.test(name)) {
      names.add(name);
    }
  }
  return [...names];
}

const NAMED_ROLE_SCOPE_PATTERN =
  /(?:只|仅)?(?:在)?(?:和|与|跟)([\p{Script=Han}\p{L}\p{N}_.-]{1,40}?)(?:这个|该|此)?角色(?:聊天|交流|对话|聊工作|工作)?时/gu;

export function namedRoleScopeNamesFromText(
  value: string,
): string[] {
  const names = new Set<string>();
  for (const match of value.matchAll(NAMED_ROLE_SCOPE_PATTERN)) {
    const name = match[1]?.normalize('NFKC').trim();
    if (name) names.add(name);
  }
  return [...names];
}

export function hasNamedRoleScopeConstraint(value: string): boolean {
  return namedRoleScopeNamesFromText(value).length > 0;
}

function normalizeScope(
  candidate: z.infer<typeof extractionCandidateSchema>,
  turnContent: string,
  sourceExcerpt: string,
): Pick<
  z.infer<typeof extractionCandidateSchema>,
  'scopeType' | 'scopeKey'
> | null {
  const namedRoles = namedRoleScopeNamesFromText(sourceExcerpt);
  if (namedRoles.length > 0) {
    return namedRoles.length === 1
      ? { scopeType: 'role', scopeKey: namedRoles[0] }
      : null;
  }
  if (candidate.scopeType === 'personal') {
    return { scopeType: 'personal', scopeKey: 'self' };
  }
  if (
    candidate.scopeType === 'project' &&
    PROJECT_ANAPHORA_PATTERN.test(sourceExcerpt) &&
    projectScopeNamesFromText(sourceExcerpt).length === 0
  ) {
    const uniqueMessageNames = new Map<string, string>();
    for (const name of projectScopeNamesFromText(turnContent)) {
      uniqueMessageNames.set(normalizedProjectScopeKey(name), name);
    }
    if (uniqueMessageNames.size === 1) {
      return {
        scopeType: 'project',
        scopeKey: [...uniqueMessageNames.values()][0],
      };
    }
  }
  const scopeKey = candidate.scopeKey.trim();
  if (
    !scopeKey ||
    GENERIC_SCOPE_KEY_PATTERN.test(scopeKey) ||
    !turnContent.includes(scopeKey)
  ) {
    return null;
  }
  if (candidate.scopeType === 'project') {
    const normalizedKey = normalizedProjectScopeKey(scopeKey);
    const sourceNames = projectScopeNamesFromText(sourceExcerpt)
      .map(normalizedProjectScopeKey);
    const messageNames = projectScopeNamesFromText(turnContent)
      .map(normalizedProjectScopeKey);
    const uniqueSourceNames = new Set(sourceNames);
    const uniqueMessageNames = new Set(messageNames);
    if (
      uniqueSourceNames.size > 1 ||
      (
        uniqueSourceNames.size === 1 &&
        !uniqueSourceNames.has(normalizedKey)
      ) ||
      (
        uniqueSourceNames.size === 0 &&
        uniqueMessageNames.size > 1
      ) ||
      (
        uniqueMessageNames.size > 0 &&
        !uniqueMessageNames.has(normalizedKey)
      )
    ) {
      return null;
    }
  }
  return {
    scopeType: candidate.scopeType,
    scopeKey,
  };
}

const NEGATED_EVIDENCE_PATTERN =
  /(?:不允许|不接受|不使用|不用|不要|不得|不能|不会|不再|从不|禁止|拒绝|避免|没有|未(?:曾|再)?|无(?:需|法)?|\b(?:never|not|no longer|do not|don't|does not|doesn't|must not|without|forbid(?:den)?|disallow(?:ed)?)\b)/iu;

const ROLE_SCOPE_EXCLUSION_CLAUSE_PATTERN =
  /(?:[，,；;]\s*)?(?:(?:其他|别的|其余)角色(?:不应|不能|不要|不用|无需|不必)(?:看到|可见|使用|沿用|继承|共享)|不(?:向|给)(?:其他|别的|其余)角色(?:共享|公开|沿用))(?:这条|该条|此条|这个|该|此)?(?:记忆|信息|设定|偏好|事实)?/gu;

const CORRECTION_EVIDENCE_PATTERN =
  /(?:不是.{0,80}而是|不再.{0,40}(?:今后|以后|现在|改|换|迁移|切换|使用)|从.{0,40}(?:改|换|迁移|切换)到?|弃用.{0,40}(?:改|换|迁移|切换)|停止使用.{0,40}(?:改|换|迁移|切换|使用)|\b(?:instead of|switch(?:ed)? from|replace(?:d)? .{0,40} with)\b)/iu;

const DIRECTIVE_EVIDENCE_PATTERN =
  /(?:必须|不允许|不得|不能|不要|不用|默认|固定|统一|始终|一直|长期|每天|每周|每月|每年|\b(?:must|never|always|default|every (?:day|week|month|year))\b)/iu;

const CONDITION_EVIDENCE_PATTERN =
  /(?:如果|若|当.{0,12}时|在.{0,12}(?:时|前|后)|断网时|离线时|到期前|之前|之后|每天|每周|每月|每年|第[零〇一二两三四五六七八九十百千万\d.]+(?:个|篇|次|天|周|月|年|小时|分钟|秒|点|号|本|倍|块|张|份|套|台|名|人|元|岁|层|度)|百分之[零〇一二两三四五六七八九十百千万\d.]+|[零〇一二两三四五六七八九十百千万\d.]+(?:比[零〇一二两三四五六七八九十百千万\d.]+|个|篇|次|天|周|月|年|小时|分钟|秒|点|号|本|倍|块|张|份|套|台|名|人|元|岁|层|度|%|％)|\b(?:if|when|before|after|offline|daily|weekly|monthly|yearly|every)\b)/iu;

const CONDITION_QUALIFIER_RULES: ReadonlyArray<
  readonly [string, RegExp]
> = [
  ['工作日', /(?:工作日|平日|周一至周五)/u],
  ['周末', /(?:周末|星期六(?:和|及|、)?星期日|周六(?:和|及|、)?周日)/u],
  ['每天', /每天/u],
  ['每周', /每周/u],
  ['每月', /每月/u],
  ['每年', /每年/u],
  ['清晨', /清晨/u],
  ['早上', /(?:早上|早晨)/u],
  ['上午', /上午/u],
  ['中午', /中午/u],
  ['下午', /下午/u],
  ['晚上', /(?:晚上|晚间)/u],
  ['夜间', /(?:夜间|深夜)/u],
  ['weekday', /\b(?:weekday|weekdays)\b/iu],
  ['weekend', /\b(?:weekend|weekends)\b/iu],
  ['morning', /\bmorning\b/iu],
  ['afternoon', /\bafternoon\b/iu],
  ['evening', /\bevening\b/iu],
  ['night', /\bnight\b/iu],
];

export function conditionQualifiersFromText(value: string): string[] {
  const normalized = value.normalize('NFKC');
  return CONDITION_QUALIFIER_RULES.flatMap(([qualifier, pattern]) =>
    pattern.test(normalized) ? [qualifier] : [],
  );
}

const QUANTITY_EVIDENCE_PATTERN =
  /(?:每天|每周(?:[一二三四五六日天]|末)?(?:上午|下午|晚上)?|每月|每年|第[零〇一二两三四五六七八九十百千万\d.]+(?:个|篇|次|天|周|月|年|小时|分钟|秒|点|号|本|倍|块|张|份|套|台|名|人|元|岁|层|度)|百分之[零〇一二两三四五六七八九十百千万\d.]+|[零〇一二两三四五六七八九十百千万\d.]+(?:比[零〇一二两三四五六七八九十百千万\d.]+|个|篇|次|天|周|月|年|小时|分钟|秒|点|号|本|倍|块|张|份|套|台|名|人|元|岁|层|度|%|％)|\b\d+(?:\.\d+)?\s*(?:times?|days?|hours?|minutes?|seconds?|percent|%)\b)/giu;

const UNDERSPECIFIED_ACTION_VALUE_PATTERN =
  /^(?:(?:在|当|如果|若)?.{1,40}(?:前|后|时))?(?:必须|应当|应该|需要|不得|不能|不要|不用|不允许)?(?:完成|可用|执行|运行|提醒|收集|保存|存储|读取|加载|遮蔽|脱敏|备份|导出|删除|确认|支持)$/u;

const ANAPHORIC_META_FRAME_PATTERN =
  /^(?:这|这个|这项|这条|此|该项|该条|上述|前述|它)(?:是|属于|作为)?.{0,64}(?:原则|规则|要求|决定|偏好|做法|标准|约定|方针)(?:之一)?$/u;

const CONCRETE_ANAPHORIC_CLAIM_PATTERN =
  /(?:必须|不得|不能|不允许|不要|不接受|不使用|不用|从不|默认|固定|统一|采用|使用|导入|保留|运行|执行|保存|存储|删除|归档|提醒|备份|发送|发布|选择|切换|迁移|启用|禁用)/u;

function withoutTerminalPunctuation(value: string): string {
  return value.replace(/[。！？!?；;]+$/u, '').trim();
}

function normalizedEvidenceText(value: string): string {
  return withoutTerminalPunctuation(value)
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/\s+/gu, '');
}

function isUnderspecifiedAnaphoricMetaEvidence(
  value: string,
): boolean {
  const normalized = normalizedEvidenceText(value);
  return (
    ANAPHORIC_META_FRAME_PATTERN.test(normalized) &&
    !CONCRETE_ANAPHORIC_CLAIM_PATTERN.test(normalized)
  );
}

function normalizeCandidateEvidence(
  candidate: z.infer<typeof extractionCandidateSchema>,
  sourceExcerpt: string,
): z.infer<typeof extractionCandidateSchema> {
  const evidence = withoutTerminalPunctuation(sourceExcerpt);
  if (!evidence) return candidate;
  const claimEvidence = evidence
    .replace(ROLE_SCOPE_EXCLUSION_CLAUSE_PATTERN, '')
    .trim() || evidence;
  const removedRoleScopeExclusion = claimEvidence !== evidence;
  const correction = CORRECTION_EVIDENCE_PATTERN.test(claimEvidence);
  const evidenceNegated =
    !correction && NEGATED_EVIDENCE_PATTERN.test(claimEvidence);
  const normalizedValue = normalizedEvidenceText(candidate.value);
  const conditionAnchor = claimEvidence.match(
    CONDITION_EVIDENCE_PATTERN,
  )?.[0];
  const conditionQualifiers = conditionQualifiersFromText(
    claimEvidence,
  );
  const missingCondition =
    (
      Boolean(conditionAnchor) &&
      !normalizedValue.includes(
        normalizedEvidenceText(conditionAnchor || ''),
      )
    ) ||
    conditionQualifiers.some(
      (qualifier) =>
        !normalizedValue.includes(normalizedEvidenceText(qualifier)),
    );
  const quantityAnchors = claimEvidence.match(
    QUANTITY_EVIDENCE_PATTERN,
  ) || [];
  const missingQuantity = quantityAnchors.some(
    (anchor) =>
      !normalizedValue.includes(normalizedEvidenceText(anchor)),
  );
  const missingObject =
    DIRECTIVE_EVIDENCE_PATTERN.test(claimEvidence) &&
    UNDERSPECIFIED_ACTION_VALUE_PATTERN.test(
      withoutTerminalPunctuation(candidate.value),
    );
  const missingDirectiveEvidenceCoverage =
    DIRECTIVE_EVIDENCE_PATTERN.test(claimEvidence) &&
    excerptValueEvidenceCoverage(candidate, claimEvidence) <=
      MIN_VALUE_EVIDENCE_COVERAGE +
        ALIGNMENT_SCORE_EPSILON;
  const missingNegatedDirective =
    evidenceNegated &&
    NEGATED_EVIDENCE_PATTERN.test(candidate.predicate) &&
    !NEGATED_EVIDENCE_PATTERN.test(candidate.value);
  const value =
    (
      !correction &&
      (
        missingCondition ||
        missingQuantity ||
        missingObject ||
        missingDirectiveEvidenceCoverage ||
        missingNegatedDirective
      )
    )
      ? claimEvidence
      : candidate.value;
  return {
    ...candidate,
    predicate: conditionQualifiers.length > 0
      ? `${candidate.predicate.replace(
        /\s*\[条件:[^\]]+\]\s*$/u,
        '',
      )} [条件:${conditionQualifiers.join('+')}]`
      : candidate.predicate,
    value,
    negated: evidenceNegated
      ? true
      : removedRoleScopeExclusion
        ? false
        : candidate.negated,
  };
}

const PREDICATE_CONDITION_SUFFIX_PATTERN =
  /\s*\[条件:[^\]]+\]\s*$/u;

const STABLE_EDITOR_PREDICATE_PATTERN =
  /^(?:当前)?(?:常用|主要|默认)(?:代码|文本)?编辑器$/u;

const STABLE_NAME_PREDICATE_PATTERN = /^(?:姓名|名字)$/u;

const STABLE_DRINK_PREDICATE_PATTERN =
  /^(?:(?:(?:平时|日常)?(?:最常|常|经常)喝(?:的)?(?:饮品|饮料|茶|咖啡))|(?:(?:点单时(?:的)?)?(?:首选|优先)(?:饮品|饮料|茶|咖啡))|(?:饮品|饮料|茶|咖啡)(?:偏好|首选))$/u;

const STABLE_OCCUPATION_PREDICATE_PATTERN =
  /^(?:(?:当前|目前|现在|长期)?(?:职业|职位|职务|职业背景|工作身份))$/u;

const STABLE_HOME_CITY_PREDICATE_PATTERN =
  /^(?:(?:当前|目前|长期|常住)?(?:居住|生活)(?:城市|地|地点)|常住地)$/u;

const STABLE_COMMUTE_PREDICATE_PATTERN =
  /^(?:(?:工作日|平时|日常|通常)?(?:通勤|上班)(?:方式|交通方式|习惯)?)$/u;

const STABLE_DIET_PREDICATE_PATTERN =
  /^(?:(?:饮食|餐食|食物)(?:偏好|忌口|禁忌|限制)|推荐餐食规则)$/u;

const STABLE_LEARNING_GOAL_PREDICATE_PATTERN =
  /^(?:(?:当前|今年|长期)?(?:学习|进修)(?:目标|计划))$/u;

const STABLE_ROLE_RESPONSE_PREDICATE_PATTERN =
  /^(?:回复组织方式|回复(?:格式|风格|规则|要求)|回答(?:组织方式|格式|风格|规则|要求)|与特定角色交流规则|角色专属规则|交流规则|对话规则)$/u;

const STABLE_NAME_EVIDENCE_PATTERN =
  /(?:我的名字|我的姓名|以后.{0,16}称呼|一直这样称呼)/u;
const STABLE_DRINK_EVIDENCE_PATTERN =
  /(?:平时|通常|一直|长期|最常喝|常喝|点单时.{0,12}(?:首选|优先)|饮品偏好)/u;
const STABLE_OCCUPATION_EVIDENCE_PATTERN =
  /(?:目前|现在|长期|职业(?:是|为)|是一名|从事.{0,16}(?:职业|工作))/u;
const STABLE_HOME_CITY_EVIDENCE_PATTERN =
  /(?:长期.{0,12}(?:生活|居住|住在)|一直住|目前住|现在住|常住|居住城市|生活在)/u;
const STABLE_COMMUTE_EVIDENCE_PATTERN =
  /(?:工作日|平时|通常|日常|通勤习惯|每天.{0,16}(?:通勤|上班))/u;
const STABLE_DIET_EVIDENCE_PATTERN =
  /(?:一直|通常|不吃|不喝|忌口|饮食禁忌|以后.{0,20}推荐餐食|推荐餐食时|请避开)/u;
const STABLE_LEARNING_GOAL_EVIDENCE_PATTERN =
  /(?:(?:长期|今年).{0,12}(?:学习|进修)(?:目标|计划)|(?:学习|进修)目标|目标是.{0,16}(?:学习|掌握))/u;
const STABLE_ROLE_RESPONSE_EVIDENCE_PATTERN =
  /(?:角色专属|只在和.{1,24}(?:角色)?聊天时|和.{1,24}角色(?:聊天|交流|对话)时|其他角色.{0,12}(?:不要|不再|不沿用))/u;

const EXPLICIT_TEMPORAL_CLAIM_PATTERN =
  /(?:\b\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?\b|\d{4}年\d{1,2}月(?:\d{1,2}日)?|(?:从|自|截至|截止|有效期|到期)(?:今天|明天|后天|昨天|\d{4}|\d{1,2}[月日号]))/u;

function calibrateStablePredicateCandidate(
  candidate: z.infer<typeof extractionCandidateSchema>,
  sourceExcerpt: string,
): z.infer<typeof extractionCandidateSchema> {
  const predicate = candidate.predicate
    .normalize('NFKC')
    .trim()
    .replace(PREDICATE_CONDITION_SUFFIX_PATTERN, '')
    .trim();
  const evidence = sourceExcerpt.normalize('NFKC');
  let stableKind: z.infer<
    typeof extractionCandidateSchema
  >['kind'] | null = null;
  if (
    STABLE_EDITOR_PREDICATE_PATTERN.test(predicate) ||
    (
      STABLE_DRINK_PREDICATE_PATTERN.test(predicate) &&
      STABLE_DRINK_EVIDENCE_PATTERN.test(evidence)
    ) ||
    (
      STABLE_COMMUTE_PREDICATE_PATTERN.test(predicate) &&
      STABLE_COMMUTE_EVIDENCE_PATTERN.test(evidence)
    ) ||
    (
      STABLE_DIET_PREDICATE_PATTERN.test(predicate) &&
      predicate !== '推荐餐食规则' &&
      STABLE_DIET_EVIDENCE_PATTERN.test(evidence)
    )
  ) {
    stableKind = 'preference';
  } else if (
    (
      STABLE_NAME_PREDICATE_PATTERN.test(predicate) &&
      STABLE_NAME_EVIDENCE_PATTERN.test(evidence)
    ) ||
    (
      STABLE_OCCUPATION_PREDICATE_PATTERN.test(predicate) &&
      STABLE_OCCUPATION_EVIDENCE_PATTERN.test(evidence)
    ) ||
    (
      STABLE_HOME_CITY_PREDICATE_PATTERN.test(predicate) &&
      STABLE_HOME_CITY_EVIDENCE_PATTERN.test(evidence)
    ) ||
    (
      STABLE_LEARNING_GOAL_PREDICATE_PATTERN.test(predicate) &&
      STABLE_LEARNING_GOAL_EVIDENCE_PATTERN.test(evidence)
    )
  ) {
    stableKind = 'profile';
  } else if (
    (
      predicate === '推荐餐食规则' &&
      STABLE_DIET_EVIDENCE_PATTERN.test(evidence)
    ) ||
    (
      STABLE_ROLE_RESPONSE_PREDICATE_PATTERN.test(predicate) &&
      STABLE_ROLE_RESPONSE_EVIDENCE_PATTERN.test(evidence)
    )
  ) {
    stableKind = 'instruction';
  }
  if (!stableKind) return candidate;
  const hasExplicitTemporalEvidence =
    EXPLICIT_TEMPORAL_CLAIM_PATTERN.test(evidence);
  return {
    ...candidate,
    kind: stableKind,
    importance: Math.max(0.6, candidate.importance),
    claimOccurredAt: hasExplicitTemporalEvidence
      ? candidate.claimOccurredAt
      : null,
    claimValidFrom: hasExplicitTemporalEvidence
      ? candidate.claimValidFrom
      : null,
    claimValidTo: hasExplicitTemporalEvidence
      ? candidate.claimValidTo
      : null,
  };
}

function splitAtomicEvidenceClauses(value: string): string[] {
  const clauses = value
    .split(
      /(?:[，,]\s*)?(?:但是|但|不过|然而|与此同时|同时|并且|而且|另外)\s*|\s+\b(?:but|however|while|meanwhile|and also)\b\s*/iu,
    )
    .map((clause) =>
      clause.replace(/^[，,\s]+|[，,\s]+$/gu, '').trim(),
    )
    .filter(Boolean);
  return clauses
    .flatMap((clause) =>
      clause.split(
        /[，,]\s*(?=(?!(?:这个|这项|这条|该项|该条|此项|此条|同样|也))[^，,；;。！？!?]{0,24}(?:是|为|固定|默认|计划|安排|预计|定于|必须|应该|需要))/u,
      ),
    )
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function extractionTargetClauses(sentence: string): string[] {
  if (!/[?？]\s*$/u.test(sentence)) {
    const clauses = splitAtomicEvidenceClauses(sentence);
    const merged: string[] = [];
    for (let index = 0; index < clauses.length; index += 1) {
      const clause = clauses[index];
      const next = clauses[index + 1];
      if (
        next &&
        hasNamedRoleScopeConstraint(clause) &&
        /角色(?:聊天|交流|对话|聊工作|工作)?时$/u.test(clause)
      ) {
        merged.push(`${clause}，${next}`);
        index += 1;
        continue;
      }
      merged.push(clause);
    }
    return merged;
  }
  if (!QUESTION_EMBEDDED_DURABLE_ASSERTION_PATTERN.test(sentence)) {
    return [];
  }
  return sentence
    .split(/[，,]|(?:但是|但|不过|然而|与此同时|同时|并且|而且|另外)/u)
    .map((clause) => clause.replace(/[?？]\s*$/u, '').trim())
    .filter((clause) =>
      QUESTION_EMBEDDED_DURABLE_ASSERTION_PATTERN.test(clause))
    .flatMap((clause) => splitAtomicEvidenceClauses(clause));
}

function normalizedAtomicField(value: string): string {
  return value.normalize('NFKC').trim();
}

export function deterministicAtomicCandidateContent(
  candidate: AtomicCandidateContent,
): string {
  const subject = normalizedAtomicField(candidate.subject);
  const predicate = normalizedAtomicField(candidate.predicate);
  const value = normalizedAtomicField(candidate.value);
  if (!subject || !predicate || !value) return '';
  const content =
    ATOMIC_CANDIDATE_CONTENT_PREFIX +
    JSON.stringify({
      subject,
      predicate,
      value,
      negated: candidate.negated === true,
    });
  return content.length <= MAX_ATOMIC_CANDIDATE_CONTENT_LENGTH
    ? content
    : '';
}

export function structuredAtomicCandidateText(
  candidate: Pick<
    AtomicCandidateContent,
    'subject' | 'predicate' | 'value' | 'negated'
  >,
): string {
  const subject = normalizedAtomicField(candidate.subject);
  const predicate = normalizedAtomicField(candidate.predicate);
  const value = normalizedAtomicField(candidate.value);
  if (!subject || !predicate || !value) return '';
  return [
    subject,
    predicate,
    value,
    candidate.negated === true ? '否定' : '肯定',
  ].join('\n');
}

export function normalizeAtomicCandidateContent(
  candidate: AtomicCandidateContent,
): string {
  return deterministicAtomicCandidateContent(candidate);
}

export function isAtomicCandidateContentSupported(
  candidate: AtomicCandidateContent,
): boolean {
  const deterministic =
    deterministicAtomicCandidateContent(candidate);
  return (
    deterministic.length > 0 &&
    normalizedAtomicField(candidate.content) === deterministic
  );
}

function atomicSourceExcerpt(
  targetSentence: string,
  candidate: SourceExcerptCandidate,
): string {
  const requested = candidate.sourceExcerpt?.trim() || '';
  const clauses = splitAtomicEvidenceClauses(targetSentence);
  if (clauses.length <= 1) {
    if (
      requested &&
      normalizedEvidenceText(requested) ===
        normalizedEvidenceText(targetSentence)
    ) {
      return targetSentence.trim();
    }
    return requested;
  }
  const directlyContaining = clauses.filter((clause) =>
    clause.includes(requested),
  );
  if (
    requested &&
    requested !== targetSentence &&
    directlyContaining.length === 1
  ) {
    return requested;
  }
  const ranked = clauses
    .map((clause, index) => ({
      clause,
      index,
      valueCoverage: excerptValueEvidenceCoverage(
        candidate,
        clause,
      ),
      score: excerptAlignmentScore(candidate, clause),
    }))
    .sort(
      (left, right) =>
        right.valueCoverage - left.valueCoverage ||
        right.score - left.score ||
        left.index - right.index,
    );
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (
    !best ||
    best.valueCoverage < MIN_VALUE_EVIDENCE_COVERAGE ||
    best.score + ALIGNMENT_SCORE_EPSILON <
      MIN_EXCERPT_ALIGNMENT_SCORE ||
    (
      runnerUp &&
      Math.abs(best.valueCoverage - runnerUp.valueCoverage) <
        1e-12 &&
      best.score - runnerUp.score <
        MIN_EXCERPT_ALIGNMENT_MARGIN
    )
  ) {
    return '';
  }
  return best.clause;
}

function candidateDeduplicationKey(
  candidate: z.infer<typeof extractionCandidateSchema>,
): string {
  return [
    candidate.kind,
    candidate.subject,
    candidate.predicate,
    candidate.value,
    candidate.negated ? 'negated' : 'affirmed',
    candidate.scopeType,
    candidate.scopeKey,
  ]
    .map((part) =>
      part.normalize('NFKC').trim().toLocaleLowerCase('zh-CN'),
    )
    .join('\n');
}

const EXPLICIT_PROJECT_SCOPE_SUFFIX_PATTERN =
  /[，,]\s*(?:只|仅)(?:能)?(?:属于|用于|限于|在)(?:当前|这个|该|本)项目(?:里|中)?(?:使用|生效|可见)?$/u;

const EXPLICIT_PROJECT_SUBJECT_PATTERN =
  /(?:项目|软件|应用|系统|产品)/u;

const NON_ASSERTIVE_PROJECT_SUBJECT_PATTERN =
  /(?:聊到|聊起|讨论|提到|说到|听说|看到|读到|举例|例如|比如|假设)/u;

function removeMatchingOuterQuotes(value: string): string {
  const pairs = new Map([
    ['“', '”'],
    ['‘', '’'],
    ['「', '」'],
    ['『', '』'],
    ['"', '"'],
    ["'", "'"],
  ]);
  const first = value[0] || '';
  const last = value[value.length - 1] || '';
  return pairs.get(first) === last
    ? value.slice(1, -1).trim()
    : value;
}

function deterministicExplicitProjectCandidate(
  turnContent: string,
  targetSentence: string,
): z.infer<typeof extractionCandidateSchema> | null {
  const sourceExcerpt = targetSentence.trim();
  if (
    !sourceExcerpt ||
    !directUserEvidenceContext(turnContent, sourceExcerpt)
  ) {
    return null;
  }
  const evidence = withoutTerminalPunctuation(sourceExcerpt);
  const scopeSuffix = evidence.match(
    EXPLICIT_PROJECT_SCOPE_SUFFIX_PATTERN,
  );
  if (!scopeSuffix || scopeSuffix.index === undefined) return null;
  const claim = evidence.slice(0, scopeSuffix.index).trim();
  const marker = '项目专属';
  const markerIndex = claim.indexOf(marker);
  if (
    markerIndex < 0 ||
    markerIndex !== claim.lastIndexOf(marker)
  ) {
    return null;
  }
  const rawSubject = claim
    .slice(0, markerIndex)
    .replace(/的$/u, '')
    .trim();
  const subject = rawSubject || '当前项目';
  if (
    rawSubject &&
    (
      !EXPLICIT_PROJECT_SUBJECT_PATTERN.test(rawSubject) ||
      NON_ASSERTIVE_PROJECT_SUBJECT_PATTERN.test(rawSubject)
    )
  ) {
    return null;
  }
  const relation = claim.slice(markerIndex + marker.length).trim();
  const copulaIndex = relation.indexOf('是');
  if (
    copulaIndex <= 0 ||
    copulaIndex !== relation.lastIndexOf('是') ||
    /(?:不是|并非|不再)/u.test(relation)
  ) {
    return null;
  }
  const predicateTail = relation.slice(0, copulaIndex).trim();
  const value = removeMatchingOuterQuotes(
    relation.slice(copulaIndex + 1).trim(),
  );
  const predicate = `${marker}${predicateTail}`;
  if (
    predicateTail.length < 2 ||
    predicateTail.length > 40 ||
    value.length < 1 ||
    value.length > 100 ||
    subject.length > 80 ||
    /[，,；;。！？!?]/u.test(predicateTail) ||
    /[，,；;。！？!?]/u.test(value)
  ) {
    return null;
  }
  const candidate = {
    kind: 'project' as const,
    subject,
    predicate,
    value,
    content: '',
    confidence: 1,
    importance: 0.95,
    sensitivity: 'normal' as const,
    negated: false,
    scopeType: 'project' as const,
    scopeKey: '当前项目',
    claimOccurredAt: null,
    claimValidFrom: null,
    claimValidTo: null,
    sourceExcerpt,
    sourceAuthority: 'direct_user' as const,
  };
  const sensitivity = protectedCredentialSensitivity(candidate);
  if (sensitivity !== 'normal') return null;
  const content = deterministicAtomicCandidateContent(candidate);
  if (!content) return null;
  return { ...candidate, content, sensitivity };
}

const DETERMINISTIC_PROJECT_IDENTIFIER_PATTERN =
  /^([^，,；;。！？!?]{1,80}?(?:项目|软件|应用|系统|产品))(?:的)?(代号|编号|代码名称)是([^，,；;。！？!?]{1,100})$/u;

function deterministicProjectIdentifierCandidate(
  turnContent: string,
  targetSentence: string,
): z.infer<typeof extractionCandidateSchema> | null {
  const sourceExcerpt = targetSentence.trim();
  if (
    !sourceExcerpt ||
    !directUserEvidenceContext(turnContent, sourceExcerpt)
  ) {
    return null;
  }
  const match = withoutTerminalPunctuation(sourceExcerpt).match(
    DETERMINISTIC_PROJECT_IDENTIFIER_PATTERN,
  );
  if (!match) return null;
  const subject = match[1].trim();
  const predicate = match[2].trim();
  const value = removeMatchingOuterQuotes(match[3].trim());
  if (
    NON_ASSERTIVE_PROJECT_SUBJECT_PATTERN.test(subject) ||
    !value ||
    /(?:什么|多少|哪个|是否)/u.test(value)
  ) {
    return null;
  }
  const candidate = {
    kind: 'project' as const,
    subject,
    predicate,
    value,
    content: '',
    confidence: 1,
    importance: 0.95,
    sensitivity: 'normal' as const,
    negated: false,
    scopeType: 'project' as const,
    scopeKey: '当前项目',
    claimOccurredAt: null,
    claimValidFrom: null,
    claimValidTo: null,
    sourceExcerpt,
    sourceAuthority: 'direct_user' as const,
  };
  const sensitivity = protectedCredentialSensitivity(candidate);
  if (sensitivity !== 'normal') return null;
  const content = deterministicAtomicCandidateContent(candidate);
  if (!content) return null;
  return { ...candidate, content, sensitivity };
}

const DETERMINISTIC_PROJECT_SCHEDULE_ATTRIBUTE_PATTERN =
  /^(固定发布窗口|发布窗口|发布时间|上线时间|验收时间|验收窗口)是([^，,；;。！？!?]{1,100})$/u;

const DETERMINISTIC_PROJECT_SCHEDULE_PLAN_PATTERN =
  /^(?:计划|安排|预计|定于)(?:在)?([^，,；;。！？!?]{1,100}?)(发布|上线|验收)$/u;

function deterministicProjectSubjectFromTurn(
  turnContent: string,
): string | null {
  const subjects = new Set<string>();
  for (const sentence of splitEvidenceSentences(turnContent)) {
    for (const clause of splitAtomicEvidenceClauses(sentence)) {
      const match = withoutTerminalPunctuation(clause).match(
        DETERMINISTIC_PROJECT_IDENTIFIER_PATTERN,
      );
      const subject = match?.[1]?.trim();
      if (
        subject &&
        !NON_ASSERTIVE_PROJECT_SUBJECT_PATTERN.test(subject)
      ) {
        subjects.add(subject);
      }
    }
  }
  return subjects.size === 1 ? [...subjects][0] : null;
}

function deterministicProjectScheduleCandidate(
  turnContent: string,
  targetSentence: string,
): z.infer<typeof extractionCandidateSchema> | null {
  const sourceExcerpt = targetSentence.trim();
  if (
    !sourceExcerpt ||
    !directUserEvidenceContext(turnContent, sourceExcerpt)
  ) {
    return null;
  }
  const evidence = withoutTerminalPunctuation(sourceExcerpt);
  const attributeMatch = evidence.match(
    DETERMINISTIC_PROJECT_SCHEDULE_ATTRIBUTE_PATTERN,
  );
  const planMatch = evidence.match(
    DETERMINISTIC_PROJECT_SCHEDULE_PLAN_PATTERN,
  );
  if (!attributeMatch && !planMatch) return null;
  const subject = deterministicProjectSubjectFromTurn(turnContent);
  if (!subject) return null;
  const predicate = attributeMatch
    ? attributeMatch[1].trim()
    : `${planMatch![2].trim()}时间`;
  const value = removeMatchingOuterQuotes(
    (attributeMatch ? attributeMatch[2] : planMatch![1]).trim(),
  );
  if (
    !value ||
    /(?:什么|多少|哪个|是否|吗|么)$/u.test(value)
  ) {
    return null;
  }
  const normalizedCandidate = normalizeCandidateEvidence({
    kind: 'project' as const,
    subject,
    predicate,
    value,
    content: '',
    confidence: 1,
    importance: 0.9,
    sensitivity: 'normal' as const,
    negated: false,
    scopeType: 'project' as const,
    scopeKey: '当前项目',
    claimOccurredAt: null,
    claimValidFrom: null,
    claimValidTo: null,
    sourceExcerpt,
    sourceAuthority: 'direct_user' as const,
  }, sourceExcerpt);
  const sensitivity = protectedCredentialSensitivity(
    normalizedCandidate,
  );
  if (sensitivity !== 'normal') return null;
  const content = deterministicAtomicCandidateContent(
    normalizedCandidate,
  );
  if (!content) return null;
  return { ...normalizedCandidate, content, sensitivity };
}

const DETERMINISTIC_EDITOR_CORRECTION_PATTERN =
  /我现在常用的编辑器(?:已经)?(?:改成|改为|换成|换为|改用|换用)(?<value>[^，,；;。！？!?]{1,80})[，,]\s*之前的(?<previous>[^，,；;。！？!?]{1,80}?)(?:已经)?(?:不用了|不再使用了|停用了)$/u;

function deterministicEditorCorrectionCandidate(
  turnContent: string,
  targetSentence: string,
): z.infer<typeof extractionCandidateSchema> | null {
  const sourceExcerpt = targetSentence.trim();
  if (
    !sourceExcerpt ||
    !directUserEvidenceContext(turnContent, sourceExcerpt)
  ) {
    return null;
  }
  const match = withoutTerminalPunctuation(sourceExcerpt).match(
    DETERMINISTIC_EDITOR_CORRECTION_PATTERN,
  );
  const value = match?.groups?.value?.trim() || '';
  const previous = match?.groups?.previous?.trim() || '';
  if (
    !value ||
    !previous ||
    value.normalize('NFKC').toLocaleLowerCase('zh-CN') ===
      previous.normalize('NFKC').toLocaleLowerCase('zh-CN')
  ) {
    return null;
  }
  const namedRoles = namedRoleScopeNamesFromText(sourceExcerpt);
  if (namedRoles.length > 1) return null;
  const candidate = {
    kind: 'preference' as const,
    subject: '用户',
    predicate: '常用编辑器',
    value,
    content: '',
    confidence: 1,
    importance: 0.9,
    sensitivity: 'normal' as const,
    negated: false,
    scopeType: namedRoles.length === 1
      ? 'role' as const
      : 'personal' as const,
    scopeKey: namedRoles[0] || 'self',
    claimOccurredAt: null,
    claimValidFrom: null,
    claimValidTo: null,
    sourceExcerpt,
    sourceAuthority: 'direct_user' as const,
  };
  const sensitivity = protectedCredentialSensitivity(candidate);
  if (sensitivity !== 'normal') return null;
  const content = deterministicAtomicCandidateContent(candidate);
  return content ? { ...candidate, content, sensitivity } : null;
}

const DETERMINISTIC_DIRECT_RELATIONSHIP_PATTERN =
  /^(?<name>[\p{Script=Han}A-Za-z0-9·]{1,20})是我的(?<relationship>父亲|爸爸|母亲|妈妈|哥哥|姐姐|弟弟|妹妹|儿子|女儿|伴侣|丈夫|妻子|男朋友|女朋友|同事|朋友|老师|导师|表哥|表姐|表弟|表妹|堂哥|堂姐|堂弟|堂妹)(?:[，,。！？!?]|$)/u;

function deterministicDirectRelationshipCandidate(
  turnContent: string,
  targetSentence: string,
): z.infer<typeof extractionCandidateSchema> | null {
  const sourceExcerpt = targetSentence.trim();
  if (
    !sourceExcerpt ||
    !directUserEvidenceContext(turnContent, sourceExcerpt)
  ) {
    return null;
  }
  const match = sourceExcerpt.match(
    DETERMINISTIC_DIRECT_RELATIONSHIP_PATTERN,
  );
  const name = match?.groups?.name?.trim() || '';
  const relationship = match?.groups?.relationship?.trim() || '';
  if (!name || !relationship) return null;
  const candidate = {
    kind: 'relationship' as const,
    subject: name,
    predicate: '与用户的关系',
    value: relationship,
    content: '',
    confidence: 1,
    importance: 0.85,
    sensitivity: 'normal' as const,
    negated: false,
    scopeType: 'personal' as const,
    scopeKey: 'self',
    claimOccurredAt: null,
    claimValidFrom: null,
    claimValidTo: null,
    sourceExcerpt,
    sourceAuthority: 'direct_user' as const,
  };
  const content = deterministicAtomicCandidateContent(candidate);
  return content ? { ...candidate, content } : null;
}

export class OllamaMemoryExtractor implements MemoryExtractor {
  readonly extractorId = MEMORY_EXTRACTOR_IMPLEMENTATION_ID;
  readonly extractorVersion =
    MEMORY_EXTRACTOR_IMPLEMENTATION_VERSION;
  readonly model: string;
  readonly promptVersion: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly keepAlive: string | number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaMemoryExtractorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.model = options.model;
    this.promptVersion = options.promptVersion;
    this.timeoutMs = Math.max(1_000, options.timeoutMs);
    this.keepAlive = options.keepAlive ?? '15m';
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async extract(
    turn: ConversationTurn,
  ): Promise<MemoryCandidateInput[]> {
    if (turn.role !== 'user') return [];
    const targetSentences = splitEvidenceSentences(turn.content)
      .flatMap((sentence) => extractionTargetClauses(sentence))
      .filter((sentence) =>
        extractionTargetDisposition(turn.content, sentence) ===
          'extract_now');
    const candidateGroups: Array<Array<
      z.infer<typeof extractionCandidateSchema>
    >> = [];
    for (
      let targetIndex = 0;
      targetIndex < targetSentences.length;
      targetIndex += 1
    ) {
      const targetSentence = targetSentences[targetIndex];
      const targetCandidates: Array<
        z.infer<typeof extractionCandidateSchema>
      > = [];
      const deterministicCorrection =
        deterministicEditorCorrectionCandidate(
          turn.content,
          targetSentence,
        );
      const deterministicCandidate =
        deterministicCorrection ||
        deterministicDirectRelationshipCandidate(
          turn.content,
          targetSentence,
        );
      if (deterministicCandidate) {
        candidateGroups.push([deterministicCandidate]);
        continue;
      }
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
            format: EXTRACTION_FORMAT,
            options: {
              temperature: 0,
              seed: 42,
              num_predict: 1200,
            },
            messages: [
              {
                role: 'system',
                content: EXTRACTION_SYSTEM_PROMPT,
              },
              {
                role: 'user',
                content: JSON.stringify({
                  occurredAt: turn.occurredAt,
                  fullMessage: turn.content,
                  targetSentence,
                  targetSentenceIndex: targetIndex,
                  targetSentenceCount: targetSentences.length,
                }),
              },
            ],
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          `Ollama 记忆提取失败：${response.status} ${await response.text()}`,
        );
      }
      const payload = await response.json() as OllamaChatResponse;
      if (typeof payload.message?.content !== 'string') {
        throw new Error('Ollama 记忆提取没有返回文本结果');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.message.content);
      } catch {
        throw new Error('Ollama 记忆提取返回的 JSON 无法解析');
      }
      const parsedCandidates = parseExtractionCandidates(parsed);
      for (const rawCandidate of parsedCandidates) {
        const requestedExcerpt = atomicSourceExcerpt(
          targetSentence,
          {
            ...rawCandidate,
            content: structuredAtomicCandidateText(rawCandidate),
          },
        );
        const trustedRequestedExcerpt =
          requestedExcerpt &&
          targetSentence.includes(requestedExcerpt)
            ? requestedExcerpt
            : '';
        const candidateForAlignment =
          trustedRequestedExcerpt &&
          DIRECTIVE_EVIDENCE_PATTERN.test(
            trustedRequestedExcerpt,
          )
            ? normalizeCandidateEvidence(
              rawCandidate,
              trustedRequestedExcerpt,
            )
            : rawCandidate;
        const alignmentContent =
          structuredAtomicCandidateText(candidateForAlignment);
        if (!alignmentContent) continue;
        const alignmentCandidate = {
          ...candidateForAlignment,
          content: alignmentContent,
        };
        const sourceExcerpt = alignSourceExcerpt(
          turn.content,
          {
            ...alignmentCandidate,
            sourceExcerpt: requestedExcerpt,
          },
        );
        if (
          !sourceExcerpt ||
          !targetSentence.includes(sourceExcerpt)
        ) {
          continue;
        }
        if (
          isUnderspecifiedAnaphoricMetaEvidence(sourceExcerpt)
        ) {
          continue;
        }
        const evidenceCandidate = calibrateStablePredicateCandidate(
          normalizeCandidateEvidence(
            candidateForAlignment,
            sourceExcerpt,
          ),
          sourceExcerpt,
        );
        const scope = normalizeScope(
          evidenceCandidate,
          turn.content,
          sourceExcerpt,
        );
        if (!scope) continue;
        const content = normalizeAtomicCandidateContent({
          ...evidenceCandidate,
          sourceExcerpt,
        });
        if (!content) continue;
        const candidate = {
          ...evidenceCandidate,
          ...scope,
          content,
          sensitivity: protectCredential(evidenceCandidate),
          sourceExcerpt,
          sourceAuthority: 'direct_user' as const,
        };
        targetCandidates.push(candidate);
      }
      if (targetCandidates.length === 0) {
        const deterministicCandidate =
          deterministicExplicitProjectCandidate(
            turn.content,
            targetSentence,
          ) || deterministicProjectIdentifierCandidate(
            turn.content,
            targetSentence,
          ) || deterministicProjectScheduleCandidate(
            turn.content,
            targetSentence,
          );
        if (deterministicCandidate) {
          targetCandidates.push(deterministicCandidate);
        }
      }
      candidateGroups.push(targetCandidates);
    }
    const candidates: Array<
      z.infer<typeof extractionCandidateSchema>
    > = [];
    const seen = new Set<string>();
    for (
      let candidateIndex = 0;
      candidateIndex < MAX_EXTRACTION_CANDIDATES + 1;
      candidateIndex += 1
    ) {
      let foundCandidate = false;
      for (const group of candidateGroups) {
        const candidate = group[candidateIndex];
        if (!candidate) continue;
        foundCandidate = true;
        const deduplicationKey =
          candidateDeduplicationKey(candidate);
        if (seen.has(deduplicationKey)) continue;
        seen.add(deduplicationKey);
        if (candidates.length >= MAX_EXTRACTION_CANDIDATES) {
          throw new Error(
            `单回合候选超过 ${MAX_EXTRACTION_CANDIDATES} 条，` +
            '请将消息分批后重试，系统不会静默丢弃后句候选',
          );
        }
        candidates.push(candidate);
      }
      if (!foundCandidate) break;
    }
    return candidates;
  }
}

export { CREDENTIAL_PATTERN, EXTRACTION_FORMAT };
