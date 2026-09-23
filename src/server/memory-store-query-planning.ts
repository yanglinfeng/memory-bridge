/**
 * 查询变体与个性化分面（原 memory-store.ts 660-853 行）。
 *
 * 由 memory-store.ts 机械搬迁而来（仅加 export 前缀），公开符号由门面 re-export。
 */

import { cleanText } from './memory-store-utils.js';
import type { QueryVariant } from './memory-store-types.js';
import {
  tokenOverlap,
  topicTokenOverlap,
} from './embedding.js';
import type { QueryUnderstandingResult } from './contextual-query-understanding.js';
import { deterministicAtomicProfileQueryRule } from './semantic-ranker.js';

export const PERSONALIZED_SYNTHESIS_QUERY_PATTERN =
  /(?:(?:根据|结合).{0,20}(?:长期|了解|记忆|习惯|偏好).{0,24}(?:安排|计划|建议|清单)|(?:个性化|懂我).{0,16}(?:安排|计划|建议|清单)|(?:我的|用户).{0,12}(?:习惯|偏好).{0,16}(?:安排|计划|建议|清单))/u;

export function deterministicPersonalizationQueryFacets(
  query: string,
): string[] {
  const normalized = cleanText(query);
  if (!PERSONALIZED_SYNTHESIS_QUERY_PATTERN.test(normalized)) {
    return [];
  }
  return [
    '用户当前时段的日常习惯 饮食饮品 作息',
    '用户工作习惯 工作偏好 决策方式 任务安排',
    '用户沟通偏好 回答方式 当前角色称呼',
  ];
}

export function deterministicQueryVariants(query: string): QueryVariant[] {
  const original = cleanText(query);
  const personalizationFacets =
    deterministicPersonalizationQueryFacets(original);
  if (personalizationFacets.length > 0) {
    return [
      { query: original, type: 'original' },
      ...personalizationFacets.map((facet): QueryVariant => ({
        query: facet,
        type: 'alias',
      })),
    ];
  }
  const normalized = original
    .replace(/[？?！!。.,，；;：:]+$/gu, '')
    .replace(
      /^(?:请问|我想问(?:一下)?|帮我(?:查|找|回忆)(?:一下)?|你还记得|那个)\s*/u,
      '',
    )
    .replace(/\s+/gu, ' ')
    .trim();
  const aliasRules: Array<[RegExp, string]> = [
    [/(?:第一次打开|首次打开|初次启动|首次启动)/gu, '首次启动 初次打开 第一次打开'],
    [/(?:喜欢|偏好|首选|优先选择)/gu, '喜欢 偏好 首选'],
    [/(?:叫什么|名称|名字)/gu, '名称 名字 叫什么'],
    [/(?:现在|当前|目前)/gu, '现在 当前 最新'],
    [/(?:不要|不需要|无需)/gu, '不要 不需要 无需'],
    [/(?:软件|应用|产品)/gu, '软件 应用 产品'],
    [/\b(?:first launch|initial startup|first startup)\b/giu,
      'first launch initial startup first startup'],
    [/\b(?:preference|prefer|favorite)\b/giu,
      'preference prefer favorite'],
  ];
  let alias = normalized || original;
  for (const [pattern, replacement] of aliasRules) {
    alias = alias.replace(pattern, replacement);
  }
  const variants: QueryVariant[] = [{ query: original, type: 'original' }];
  if (normalized && normalized !== original) {
    variants.push({ query: normalized, type: 'normalized' });
  }
  if (alias && !variants.some((variant) => variant.query === alias)) {
    variants.push({ query: alias, type: 'alias' });
  }
  return variants;
}

export const HIGH_ENTROPY_IDENTIFIER_PATTERN =
  /[A-Za-z0-9][A-Za-z0-9._:@+-]{7,127}/gu;

export const RERANK_COARSE_SCORE_CLIFF_RATIO = 0.65;

export const RERANK_HIGH_CONFIDENCE = 0.9;

export const NON_ATOMIC_SINGLE_VALUE_QUERY_PATTERN =
  /(清单|几个|哪些|都|分别|比较|对比|总结|概括|计划|建议|最近|过去|本周|上周|今天|昨天|时间范围|时间段|变化|趋势|有什么|包括|列出|多少|各自|综合|它|他|她|这个|那个|这些|那些)/u;

export const EXPLICIT_EXHAUSTIVE_RECALL_QUERY_PATTERN =
  /(?:列出|罗列|枚举).{0,48}(?:所有|全部|每个|分别)/u;

export const EXPLICIT_ATOMIC_SINGLE_VALUE_QUERY_PATTERN =
  /(?:(?:当前|目前|现在|首选|唯一|默认|主要).*(?:是什么|是哪一个|哪个|什么)|(?:姓名|名字|生日|邮箱|电话|地址|代号|称呼).*(?:是什么|是哪一个|哪个|什么)|叫什么|在哪里|何时|什么时候)(?:[？?。.]*)$/u;

export const ATOMIC_VALUE_VERIFICATION_QUERY_PATTERN =
  /(?:是否|是不是|还有效|仍然有效|依然有效|吗)(?:[？?。.]*)$/u;

export const EXPLICIT_VERBATIM_USER_EVIDENCE_QUERY_PATTERN =
  /^(?:我|用户|本人)(?:(?:是不是|是否)(?:曾经)?(?:要求|希望)(?:你)?|(?:有没有|是否)(?:曾经)?说过).+?(?:吗)?[？?]?$/u;

export const STABLE_ATOMIC_PROFILE_RULES = new Set([
  'favorite_drink',
  'occupation',
  'home_city',
  'food_aversion',
  'learning_goal',
  'commute_mode',
  'editor',
  'response_style',
]);

export function atomicQueryVariant(value: string): string {
  return cleanText(value).replace(
    /(?:当前|这个|该)角色/gu,
    '角色',
  );
}

export function atomicValueClearlyMatchesQuery(
  query: string,
  value: string,
): boolean {
  const normalizedQuery = cleanText(query).normalize('NFKC');
  const normalizedValue = cleanText(value).normalize('NFKC');
  return normalizedValue.length > 0 && (
    normalizedQuery.includes(normalizedValue) ||
    tokenOverlap(normalizedQuery, normalizedValue) >= 0.45 ||
    topicTokenOverlap(normalizedQuery, normalizedValue) >= 0.2
  );
}

export function atomicValuesClearlyConflictWithQuery(
  query: string,
  values: readonly string[],
): boolean {
  return values.length > 0 && values.every((value) =>
    tokenOverlap(query, value) < 0.3 &&
    topicTokenOverlap(query, value) < 0.12
  );
}

export function isExplicitAtomicSingleValueQuery(
  query: string,
  understanding?: QueryUnderstandingResult,
): boolean {
  if (
    understanding?.status === 'ambiguous' ||
    understanding?.status === 'unavailable' ||
    (understanding?.unresolvedReferences.length || 0) > 0
  ) return false;
  const variants = [
    query,
    understanding?.standaloneQuery,
    understanding?.rankingQuery,
  ].map((value) => atomicQueryVariant(value || '')).filter(Boolean);
  if (
    variants.length === 0 ||
    variants.some((value) =>
      NON_ATOMIC_SINGLE_VALUE_QUERY_PATTERN.test(cleanText(value)))
  ) return false;
  return variants.every((value) =>
    deterministicAtomicProfileQueryRule(cleanText(value)) !== null ||
    EXPLICIT_ATOMIC_SINGLE_VALUE_QUERY_PATTERN.test(cleanText(value)));
}

export function isExplicitExhaustiveRecallQuery(
  query: string,
  understanding?: QueryUnderstandingResult,
): boolean {
  return [
    query,
    understanding?.standaloneQuery,
    understanding?.rankingQuery,
  ].some((value) =>
    EXPLICIT_EXHAUSTIVE_RECALL_QUERY_PATTERN.test(cleanText(value || ''))
  );
}

export function isExplicitVerbatimUserEvidenceQuery(
  query: string,
  rankingQuery: string,
): boolean {
  return [query, rankingQuery].some((value) =>
    EXPLICIT_VERBATIM_USER_EVIDENCE_QUERY_PATTERN.test(cleanText(value))
  );
}

export function deterministicExactIdentifierCandidate<T extends {
  text: string;
  retrieval: { lexicalRank: number | null };
}>(
  query: string,
  candidates: readonly T[],
): { candidate: T; identifier: string } | null {
  const identifiers = [
    ...new Set(
      (cleanText(query).match(HIGH_ENTROPY_IDENTIFIER_PATTERN) || [])
        .map((value) => value.toLocaleLowerCase())
        .filter((value) => /[A-Za-z]/u.test(value) && /[0-9]/u.test(value)),
    ),
  ].sort((left, right) => right.length - left.length);
  if (identifiers.length === 0 || candidates.length === 0) return null;
  for (const identifier of identifiers) {
    const matched = candidates.filter((candidate) =>
      cleanText(candidate.text).toLocaleLowerCase().includes(identifier));
    if (
      matched.length === 1 &&
      matched[0].retrieval.lexicalRank !== null
    ) {
      return { candidate: matched[0], identifier };
    }
  }
  return null;
}

