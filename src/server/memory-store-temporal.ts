/**
 * 时间检索计划与多样性选择（原 memory-store.ts 1606-1927 行）。
 *
 * 由 memory-store.ts 机械搬迁而来（仅加 export 前缀），公开符号由门面 re-export。
 */

import type {
  MemoryEvidenceDigest,
  TemporalCandidateSignal,
  TemporalRetrievalKind,
  TemporalRetrievalPlan,
} from './memory-store-types.js';
import type { QueryUnderstandingResult } from './contextual-query-understanding.js';
import { cleanText } from './memory-store-utils.js';
import { config } from './config.js';
import type {
  MemoryRecord,
  RecallResult,
} from './types.js';
import { memoryText } from './memory-store-text.js';
import {
  cosineSimilarity,
  embedText,
  tokenOverlap,
} from './embedding.js';

export const TEMPORAL_DAY_MS = 86_400_000;

export const TEMPORAL_QUERY_PATTERNS: ReadonlyArray<{
  kind: TemporalRetrievalKind;
  label: string;
  pattern: RegExp;
}> = [
  {
    kind: 'history_sequence',
    label: '前后多次',
    pattern: /(?:(?:前后|先后).{0,6}(?:两|二|2)次|(?:两|二|2)次.{0,8}(?:分别|各自))/u,
  },
  { kind: 'yesterday', label: '昨天', pattern: /(?:昨天|昨日|yesterday)/iu },
  { kind: 'tomorrow', label: '明天', pattern: /(?:明天|明日|tomorrow)/iu },
  { kind: 'last_week', label: '上周', pattern: /(?:上一?周|上星期|last\s+week)/iu },
  { kind: 'next_week', label: '下周', pattern: /(?:下一?周|下星期|next\s+week)/iu },
  { kind: 'this_week', label: '本周', pattern: /(?:本周|这周|这一周|this\s+week)/iu },
  { kind: 'last_month', label: '上个月', pattern: /(?:上个月|上月|last\s+month)/iu },
  { kind: 'this_month', label: '本月', pattern: /(?:本月|这个月|this\s+month)/iu },
  { kind: 'today', label: '今天', pattern: /(?:今天|今日|today)/iu },
  {
    kind: 'recent',
    label: '最近',
    pattern: /(?:最近|近期|近来|新近|最新|刚刚|刚才|这几天|recent(?:ly)?|latest|lately)/iu,
  },
];

export function localDayStart(
  timestampMs: number,
  timezoneOffsetMinutes: number,
): number {
  const offsetMs = timezoneOffsetMinutes * 60_000;
  return Math.floor((timestampMs + offsetMs) / TEMPORAL_DAY_MS) *
      TEMPORAL_DAY_MS - offsetMs;
}

export function localWeekStart(
  timestampMs: number,
  timezoneOffsetMinutes: number,
): number {
  const dayStart = localDayStart(timestampMs, timezoneOffsetMinutes);
  const localDay = new Date(
    dayStart + timezoneOffsetMinutes * 60_000,
  ).getUTCDay();
  const daysSinceMonday = (localDay + 6) % 7;
  return dayStart - daysSinceMonday * TEMPORAL_DAY_MS;
}

export function localMonthStart(
  timestampMs: number,
  timezoneOffsetMinutes: number,
  monthDelta = 0,
): number {
  const offsetMs = timezoneOffsetMinutes * 60_000;
  const local = new Date(timestampMs + offsetMs);
  return Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth() + monthDelta,
    1,
  ) - offsetMs;
}

export function temporalRetrievalPlan(
  query: string,
  understanding: QueryUnderstandingResult | undefined,
  referenceAt: string,
): TemporalRetrievalPlan | null {
  const referenceMs = Date.parse(referenceAt);
  if (!Number.isFinite(referenceMs)) return null;
  const sources = [
    understanding?.rankingQuery,
    understanding?.standaloneQuery,
    query,
    ...(understanding?.constraints.temporal || []),
  ].map((value) => cleanText(value || '')).filter(Boolean);
  const matches = TEMPORAL_QUERY_PATTERNS.filter(({ pattern }) =>
    sources.some((source) => pattern.test(source))
  );
  const distinctKinds = [...new Set(matches.map(({ kind }) => kind))];
  if (distinctKinds.length !== 1) return null;
  const match = matches.find(({ kind }) => kind === distinctKinds[0]);
  if (!match) return null;
  const timezoneOffsetMinutes = config.summaryTimezoneOffsetMinutes;
  const dayStart = localDayStart(referenceMs, timezoneOffsetMinutes);
  const weekStart = localWeekStart(referenceMs, timezoneOffsetMinutes);
  const monthStart = localMonthStart(referenceMs, timezoneOffsetMinutes);
  let rangeStartMs: number | null = null;
  let rangeEndMs: number | null = null;
  switch (match.kind) {
    case 'history_sequence':
      break;
    case 'today':
      rangeStartMs = dayStart;
      rangeEndMs = dayStart + TEMPORAL_DAY_MS;
      break;
    case 'yesterday':
      rangeStartMs = dayStart - TEMPORAL_DAY_MS;
      rangeEndMs = dayStart;
      break;
    case 'tomorrow':
      rangeStartMs = dayStart + TEMPORAL_DAY_MS;
      rangeEndMs = dayStart + 2 * TEMPORAL_DAY_MS;
      break;
    case 'this_week':
      rangeStartMs = weekStart;
      rangeEndMs = weekStart + 7 * TEMPORAL_DAY_MS;
      break;
    case 'last_week':
      rangeStartMs = weekStart - 7 * TEMPORAL_DAY_MS;
      rangeEndMs = weekStart;
      break;
    case 'next_week':
      rangeStartMs = weekStart + 7 * TEMPORAL_DAY_MS;
      rangeEndMs = weekStart + 14 * TEMPORAL_DAY_MS;
      break;
    case 'this_month':
      rangeStartMs = monthStart;
      rangeEndMs = localMonthStart(
        referenceMs,
        timezoneOffsetMinutes,
        1,
      );
      break;
    case 'last_month':
      rangeStartMs = localMonthStart(
        referenceMs,
        timezoneOffsetMinutes,
        -1,
      );
      rangeEndMs = monthStart;
      break;
    case 'recent':
      break;
  }
  return {
    kind: match.kind,
    label: match.label,
    referenceAt,
    rangeStartMs,
    rangeEndMs,
  };
}

export function temporalCandidateSignal(
  plan: TemporalRetrievalPlan | null,
  memory: MemoryRecord,
  digest: MemoryEvidenceDigest | undefined,
): TemporalCandidateSignal | null {
  if (!plan) return null;
  const anchors: Array<[
    string | null | undefined,
    TemporalCandidateSignal['anchorSource'],
  ]> = plan.kind === 'history_sequence'
    ? [
        [memory.occurredAt, 'occurred_at'],
        [digest?.lastEvidenceAt, 'trusted_user_evidence'],
        [memory.lastSeenAt, 'last_seen_at'],
        [memory.updatedAt, 'updated_at'],
      ]
    : [
        [digest?.lastEvidenceAt, 'trusted_user_evidence'],
        [memory.occurredAt, 'occurred_at'],
        [memory.lastSeenAt, 'last_seen_at'],
        [memory.updatedAt, 'updated_at'],
      ];
  for (const [anchorAt, anchorSource] of anchors) {
    if (!anchorAt) continue;
    const anchorMs = Date.parse(anchorAt);
    if (!Number.isFinite(anchorMs)) continue;
    let score: number;
    if (plan.kind === 'history_sequence') {
      score = 1;
    } else if (plan.rangeStartMs !== null && plan.rangeEndMs !== null) {
      const distanceMs = anchorMs < plan.rangeStartMs
        ? plan.rangeStartMs - anchorMs
        : anchorMs >= plan.rangeEndMs
          ? anchorMs - plan.rangeEndMs
          : 0;
      score = distanceMs === 0
        ? 1
        : Math.exp(-distanceMs / (14 * TEMPORAL_DAY_MS));
    } else {
      const referenceMs = Date.parse(plan.referenceAt);
      const ageMs = Math.max(0, referenceMs - anchorMs);
      score = Math.exp(-ageMs / (30 * TEMPORAL_DAY_MS));
    }
    return {
      score: Math.max(0, Math.min(1, score)),
      anchorAt,
      anchorSource,
    };
  }
  return null;
}

export function temporalReason(
  plan: TemporalRetrievalPlan,
  signal: TemporalCandidateSignal,
): string {
  const source = signal.anchorSource === 'trusted_user_evidence'
    ? '当前版本用户证据时间'
    : signal.anchorSource === 'occurred_at'
      ? '事件发生时间'
      : signal.anchorSource === 'last_seen_at'
        ? '最近观察时间'
        : '记忆更新时间';
  return `时间意图“${plan.label}”参考${source}`;
}

export function orderTemporalResults(
  plan: TemporalRetrievalPlan | null,
  results: RecallResult[],
): RecallResult[] {
  if (plan?.kind !== 'history_sequence') return results;
  return [...results].sort((left, right) => {
    const leftAt = Date.parse(
      left.memory.occurredAt ||
        left.memory.lastSeenAt ||
        left.memory.updatedAt,
    );
    const rightAt = Date.parse(
      right.memory.occurredAt ||
        right.memory.lastSeenAt ||
        right.memory.updatedAt,
    );
    const chronological = leftAt - rightAt;
    return chronological || left.memory.id.localeCompare(right.memory.id);
  });
}

export function conflictState(
  status: MemoryRecord['status'],
): RecallResult['explanation']['conflictState'] {
  if (status === 'superseded') return 'superseded';
  if (status === 'archived') return 'archived';
  return 'none';
}

export const SCOPE_PRECEDENCE: Record<
  MemoryRecord['scopeType'],
  number
> = {
  personal: 0,
  project: 1,
  role: 2,
  session: 3,
  // public 文档在冲突裁决中优先级最低（最通用、最不"个人"的来源）。
  public: 4,
};

export function memorySimilarity(
  left: MemoryRecord,
  right: MemoryRecord,
): number {
  const leftText = memoryText(left);
  const rightText = memoryText(right);
  return Math.max(
    tokenOverlap(leftText, rightText),
    cosineSimilarity(embedText(leftText), embedText(rightText)),
  );
}

export function selectDiverseResults(
  ranked: RecallResult[],
  limit: number,
): RecallResult[] {
  const remaining = [...ranked];
  const selected: RecallResult[] = [];
  const relevanceWeight = 0.78;
  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = 0;
    let bestMmr = Number.NEGATIVE_INFINITY;
    let bestPenalty = 0;
    for (const [index, candidate] of remaining.entries()) {
      const maximumSimilarity = selected.reduce(
        (maximum, existing) =>
          Math.max(
            maximum,
            memorySimilarity(candidate.memory, existing.memory),
          ),
        0,
      );
      const diversityPenalty =
        (1 - relevanceWeight) * maximumSimilarity;
      const mmr =
        relevanceWeight * candidate.score - diversityPenalty;
      const best = remaining[bestIndex];
      if (
        mmr > bestMmr ||
        (
          mmr === bestMmr &&
          (
            candidate.score > best.score ||
            (
              candidate.score === best.score &&
              candidate.memory.id.localeCompare(best.memory.id) < 0
            )
          )
        )
      ) {
        bestIndex = index;
        bestMmr = mmr;
        bestPenalty = diversityPenalty;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    const roundedPenalty = Number(bestPenalty.toFixed(4));
    selected.push({
      ...chosen,
      reasons: roundedPenalty > 0
        ? [
            ...chosen.reasons,
            `MMR 多样性惩罚 ${roundedPenalty.toFixed(2)}`,
          ]
        : [...chosen.reasons],
      explanation: {
        ...chosen.explanation,
        diversityPenalty: roundedPenalty,
      },
    });
  }
  return selected;
}

