import { createHash } from 'node:crypto';
import {
  cosineSimilarity,
  embedText,
} from './embedding.js';
import type {
  CandidateRelation,
  CandidateResolutionMethod,
} from './lifecycle-store.js';
import type {
  MemoryKind,
  MemoryScopeType,
  MemorySensitivity,
  PredicateCardinality,
  SourceAuthority,
} from './types.js';

type DatabaseRow = Record<string, unknown>;

export interface ClaimRelationTarget {
  id: string;
  predicateKey: string;
  normalizedValue: string | null;
  content: string;
  sourceAuthority: SourceAuthority;
  occurredAt: string | null;
  validFrom: string | null;
  validTo: string | null;
}

export interface ClaimSubject {
  id: string;
  userId: string;
  namespace: string;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  value: string;
  normalizedKey: string;
  normalizedHash: string;
  stableKey: string;
  content: string;
  confidence: number;
  importance: number;
  sensitivity: MemorySensitivity;
  negated: boolean;
  scopeType: MemoryScopeType;
  scopeKey: string;
  claimOccurredAt: string | null;
  claimValidFrom: string | null;
  claimValidTo: string | null;
  sourceAuthority: SourceAuthority;
  explicitCorrection: boolean;
}

export interface CanonicalClaimTarget extends ClaimRelationTarget {
  revision: number;
  status: string;
  memoryStatus: string;
  itemUpdatedAt: string;
  memoryUpdatedAt: string;
  checksum: string;
  stableKey: string;
  normalizedValueHash: string | null;
  observationCount: number;
  confidence: number;
  importance: number;
  sensitivity: MemorySensitivity;
  scopeType: MemoryScopeType;
  scopeKey: string;
}

export interface ClaimRelationDecision {
  relation: CandidateRelation;
  targetMemoryId: string | null;
  confidence: number;
  rationale: string;
}

export interface ClaimRelationClassifier {
  readonly model: string;
  readonly promptVersion: string;
  classify(
    candidate: ClaimSubject,
    targets: ClaimRelationTarget[],
  ): Promise<ClaimRelationDecision>;
}

export interface ClaimEmbeddingProvider {
  readonly embeddingModel: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface ClaimRelationEngineOptions {
  classifier?: ClaimRelationClassifier;
  embeddingProvider?: ClaimEmbeddingProvider;
  embeddingNearThreshold?: number;
}

export interface ClaimAssessmentOptions {
  cardinality?: PredicateCardinality;
  predicateTargets: CanonicalClaimTarget[];
  semanticTargets: CanonicalClaimTarget[];
}

export interface ClaimRelationAssessment {
  relation: CandidateRelation;
  targetMemoryId: string | null;
  target: CanonicalClaimTarget | null;
  relatedTargets: CanonicalClaimTarget[];
  method: CandidateResolutionMethod;
  confidence: number;
  rationale: string;
  model: string | null;
  promptVersion: string | null;
  cardinality: PredicateCardinality;
  stableKey: string;
  reason: string;
  readSet: 'predicate' | 'semantic';
}

const SINGLE_VALUE_PATTERN =
  /(?:当前|现在|主要|首选|默认|住址|地址|职位|职业|工作|编辑器|ide|姓名|名字|称呼|时区|回复风格|操作系统|开发环境)/iu;
const SET_VALUE_PATTERN =
  /(?:会用|掌握|语言列表|编程语言|兴趣|爱好|技能|合作关系|朋友|家庭成员|宠物|工具集)/iu;
const STABLE_LIFE_HABIT_PATTERN = /稳定生活习惯/iu;
const STABLE_SINGLE_PREDICATE_PATTERN =
  /^(?:姓名|名字|(?:(?:当前|目前|现在|长期)?(?:职业|职位|职务|职业背景|工作身份))|(?:(?:当前|目前|长期|常住)?(?:居住|生活)(?:城市|地|地点)|常住地)|(?:(?:(?:平时|日常)?(?:最常|常|经常)喝(?:的)?(?:饮品|饮料|茶|咖啡))|(?:(?:点单时(?:的)?)?(?:首选|优先)(?:饮品|饮料|茶|咖啡))|(?:饮品|饮料|茶|咖啡)(?:偏好|首选))|回复组织方式|回复(?:格式|风格)|回答(?:组织方式|格式|风格)|(?:当前)?(?:常用|主要|默认)(?:代码|文本)?编辑器)$/iu;
const STABLE_SET_PREDICATE_PATTERN =
  /^(?:(?:饮食|餐食|食物)(?:偏好|忌口|禁忌|限制)|推荐餐食规则|(?:当前|今年|长期)?(?:学习|进修)(?:目标|计划)|与特定角色交流规则|角色专属规则|交流规则|对话规则)$/iu;
const STABLE_COMMUTE_PREDICATE_PATTERN =
  /^(?:(?:工作日|平时|日常|通常)(?:通勤|上班)(?:方式|交通方式|习惯)?|(?:通勤|上班)(?:方式|交通方式|习惯)?\s*\[条件:[^\]]*(?:工作日|平时|日常|通常)[^\]]*\])$/iu;
const SEMANTIC_PREDICATE_NEAR_THRESHOLD = 0.62;

const AUTHORITY_RANK: Record<SourceAuthority, number> = {
  legacy_unknown: 0,
  assistant_inference: 1,
  imported: 2,
  user_confirmed: 3,
  direct_user: 4,
};

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function cleanText(value: unknown): string {
  return asText(value).normalize('NFKC').trim();
}

function normalizePart(value: unknown): string {
  return cleanText(value).toLocaleLowerCase('zh-CN');
}

function predicateTextFromKey(value: string): string {
  const parts = cleanText(value).split('::');
  const predicate = parts.length > 1
    ? parts.slice(1).join('::')
    : parts[0] || '';
  return predicate.replace(/\s*\[条件:[^\]]+\]\s*$/u, '').trim();
}

function predicateSemanticText(value: string): string {
  return cleanText(value)
    .replace(/\s*\[条件:[^\]]+\]\s*$/u, '')
    .trim();
}

function asNullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : asText(value);
}

export function rowToCanonicalTarget(
  row: DatabaseRow,
): CanonicalClaimTarget {
  return {
    id: asText(row.id),
    revision: Number(row.revision),
    status: asText(row.item_status),
    memoryStatus: asText(row.memory_status),
    itemUpdatedAt: asText(row.item_updated_at),
    memoryUpdatedAt: asText(row.memory_updated_at),
    checksum: asText(row.checksum),
    stableKey: asText(row.stable_key),
    predicateKey: asText(row.predicate_key),
    normalizedValueHash: asNullableText(
      row.normalized_value_hash,
    ),
    normalizedValue: asNullableText(row.normalized_value),
    observationCount: Number(row.observation_count),
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    content: asText(row.content),
    sensitivity:
      (asText(row.sensitivity) as CanonicalClaimTarget['sensitivity']) ||
      'normal',
    sourceAuthority:
      (asText(row.source_authority) as SourceAuthority) ||
      'legacy_unknown',
    scopeType:
      (asText(row.scope_type) as CanonicalClaimTarget['scopeType']) ||
      'personal',
    scopeKey: asText(row.scope_key) || 'self',
    occurredAt: asNullableText(row.occurred_at),
    validFrom: asNullableText(row.valid_from),
    validTo: asNullableText(row.valid_to),
  };
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function authorityAtLeast(
  observed: SourceAuthority,
  current: SourceAuthority,
): boolean {
  return AUTHORITY_RANK[observed] >= AUTHORITY_RANK[current];
}

export function strongerAuthority(
  left: SourceAuthority,
  right: SourceAuthority,
): SourceAuthority {
  return AUTHORITY_RANK[left] >= AUTHORITY_RANK[right]
    ? left
    : right;
}

export function classifyPredicateCardinality(
  kind: MemoryKind,
  predicate: string,
): PredicateCardinality {
  // Reflection deliberately places different lifestyle habits under one
  // canonical predicate. They are independent set members even if a local
  // model mislabels the memory kind (including as an event).
  if (STABLE_LIFE_HABIT_PATTERN.test(predicate)) return 'set';
  const semanticPredicate = predicateTextFromKey(predicate);
  if (STABLE_SET_PREDICATE_PATTERN.test(semanticPredicate)) {
    return 'set';
  }
  if (
    STABLE_SINGLE_PREDICATE_PATTERN.test(semanticPredicate) ||
    STABLE_COMMUTE_PREDICATE_PATTERN.test(cleanText(predicate))
  ) {
    return 'single';
  }
  if (kind === 'event') return 'event';
  if (SINGLE_VALUE_PATTERN.test(predicate)) return 'single';
  if (kind === 'relationship' || SET_VALUE_PATTERN.test(predicate)) {
    return 'set';
  }
  return 'single';
}

export function canonicalStableKey(
  candidate: ClaimSubject,
  cardinality: PredicateCardinality,
  forceTemporalCoexistence = false,
): string {
  const hasClaimTime = Boolean(
    candidate.claimOccurredAt ||
    candidate.claimValidFrom ||
    candidate.claimValidTo,
  );
  if (
    cardinality === 'single' &&
    !forceTemporalCoexistence &&
    !hasClaimTime
  ) {
    return candidate.stableKey;
  }
  const temporalQualifier = [
    candidate.claimOccurredAt || '',
    candidate.claimValidFrom || '',
    candidate.claimValidTo || '',
  ].join('|');
  const qualifier = forceTemporalCoexistence || hasClaimTime
    ? cardinality === 'set'
      ? `${candidate.normalizedHash}|${temporalQualifier}`
      : temporalQualifier
    : candidate.normalizedHash;
  return [
    candidate.stableKey,
    forceTemporalCoexistence || hasClaimTime ? 'time' : cardinality,
    sha256(qualifier).slice(0, 24),
  ].join('::');
}

export function temporallyDistinct(
  candidate: ClaimSubject,
  current: CanonicalClaimTarget,
  cardinality: PredicateCardinality,
): boolean {
  const candidateOccurred = timestamp(candidate.claimOccurredAt);
  const currentOccurred = timestamp(current.occurredAt);
  if (
    cardinality === 'event' &&
    candidateOccurred !== null &&
    currentOccurred !== null &&
    candidateOccurred !== currentOccurred
  ) {
    return true;
  }
  const candidateStart =
    timestamp(candidate.claimValidFrom) ?? candidateOccurred;
  const candidateEnd = timestamp(candidate.claimValidTo);
  const currentStart =
    timestamp(current.validFrom) ?? currentOccurred;
  const currentEnd = timestamp(current.validTo);
  if (
    candidateStart !== null &&
    currentEnd !== null &&
    candidateStart >= currentEnd
  ) {
    return true;
  }
  return (
    currentStart !== null &&
    candidateEnd !== null &&
    currentStart >= candidateEnd
  );
}

function deterministicallySupersedesInTime(
  candidate: ClaimSubject,
  current: CanonicalClaimTarget,
  cardinality: PredicateCardinality,
): boolean {
  if (cardinality !== 'single' || candidate.claimValidTo) return false;
  const candidateStart =
    timestamp(candidate.claimValidFrom) ??
    timestamp(candidate.claimOccurredAt);
  const currentStart =
    timestamp(current.validFrom) ??
    timestamp(current.occurredAt);
  return (
    candidateStart !== null &&
    currentStart !== null &&
    candidateStart > currentStart &&
    timestamp(current.validTo) === null
  );
}

export class ClaimRelationEngine {
  private readonly classifier?: ClaimRelationClassifier;
  private readonly embeddingProvider?: ClaimEmbeddingProvider;
  private readonly embeddingNearThreshold: number;

  constructor(
    options: ClaimRelationEngineOptions = {},
  ) {
    this.classifier = options.classifier;
    this.embeddingProvider = options.embeddingProvider;
    this.embeddingNearThreshold = Math.max(
      0.5,
      Math.min(0.99, options.embeddingNearThreshold ?? 0.82),
    );
  }

  async assess(
    candidate: ClaimSubject,
    options: ClaimAssessmentOptions,
  ): Promise<ClaimRelationAssessment> {
    const cardinality =
      options.cardinality ||
      classifyPredicateCardinality(
        candidate.kind,
        candidate.predicate,
      );
    const predicateItems = options.predicateTargets;
    const explicitSetRemoval =
      cardinality === 'set' &&
      candidate.negated &&
      candidate.explicitCorrection
        ? predicateItems.find(
          (item) =>
            normalizePart(item.normalizedValue) ===
              normalizePart(candidate.value),
        )
        : undefined;
    if (
      explicitSetRemoval &&
      !temporallyDistinct(
        candidate,
        explicitSetRemoval,
        cardinality,
      )
    ) {
      if (
        !authorityAtLeast(
          candidate.sourceAuthority,
          explicitSetRemoval.sourceAuthority,
        )
      ) {
        return this.assessment(
          'contradicts',
          explicitSetRemoval,
          predicateItems,
          'rule',
          1,
          '较弱来源不能停止更高权威的集合事实',
          cardinality,
          canonicalStableKey(candidate, cardinality),
          'authority_insufficient_to_supersede',
          'predicate',
        );
      }
      return this.assessment(
        'supersedes',
        explicitSetRemoval,
        predicateItems,
        'rule',
        1,
        '用户明确停止同一集合事实',
        cardinality,
        canonicalStableKey(candidate, cardinality),
        'explicit_correction',
        'predicate',
      );
    }
    const exact = predicateItems.find(
      (item) =>
        item.normalizedValueHash === candidate.normalizedHash ||
        normalizePart(item.content) ===
          normalizePart(candidate.content),
    );
    if (exact) {
      if (temporallyDistinct(candidate, exact, cardinality)) {
        return this.assessment(
          'coexists',
          exact,
          predicateItems,
          'rule',
          1,
          '相同事实属于不同有效时间',
          cardinality,
          canonicalStableKey(candidate, cardinality, true),
          'different_time_coexists',
          'predicate',
        );
      }
      if (
        normalizePart(exact.content) ===
        normalizePart(candidate.content)
      ) {
        return this.assessment(
          'equivalent',
          exact,
          predicateItems,
          'exact',
          1,
          '规范值和正文完全等价',
          cardinality,
          canonicalStableKey(candidate, cardinality),
          'equivalent_observation',
          'predicate',
        );
      }
      return this.assessment(
        'reinforces',
        exact,
        predicateItems,
        'exact',
        1,
        '规范值相同且新增独立证据',
        cardinality,
        canonicalStableKey(candidate, cardinality),
        'equivalent_value_reinforced',
        'predicate',
      );
    }

    if (predicateItems.length > 0) {
      const current = predicateItems[0];
      if (temporallyDistinct(candidate, current, cardinality)) {
        return this.assessment(
          'coexists',
          current,
          predicateItems,
          'rule',
          1,
          '作用域相同但有效时间不重叠',
          cardinality,
          canonicalStableKey(candidate, cardinality, true),
          'different_time_coexists',
          'predicate',
        );
      }
      if (cardinality !== 'single') {
        return this.assessment(
          'coexists',
          current,
          predicateItems,
          'rule',
          1,
          '集合值或事件允许并存',
          cardinality,
          canonicalStableKey(candidate, cardinality),
          'coexisting_value',
          'predicate',
        );
      }
      const temporalSupersession =
        deterministicallySupersedesInTime(
          candidate,
          current,
          cardinality,
        );
      if (candidate.explicitCorrection || temporalSupersession) {
        if (
          !authorityAtLeast(
            candidate.sourceAuthority,
            current.sourceAuthority,
          )
        ) {
          return this.assessment(
            'contradicts',
            current,
            predicateItems,
            'rule',
            1,
            '较弱来源不能覆盖更高权威事实',
            cardinality,
            canonicalStableKey(candidate, cardinality),
            'authority_insufficient_to_supersede',
            'predicate',
          );
        }
        return this.assessment(
          'supersedes',
          current,
          predicateItems,
          'rule',
          1,
          candidate.explicitCorrection
            ? '用户明确纠正同一单值属性'
            : '新事实具有确定且更晚的开放有效期',
          cardinality,
          canonicalStableKey(candidate, cardinality),
          candidate.explicitCorrection
            ? 'explicit_correction'
            : 'deterministic_temporal_supersession',
          'predicate',
        );
      }
      return this.assessment(
        'contradicts',
        current,
        predicateItems,
        'rule',
        1,
        '同一作用域和时间的单值属性冲突',
        cardinality,
        canonicalStableKey(candidate, cardinality),
        'single_value_conflict_requires_confirmation',
        'predicate',
      );
    }

    const semanticItems = options.semanticTargets;
    const nearest = await this.findEmbeddingNeighbor(
      candidate,
      semanticItems,
    );
    if (nearest) {
      if (
        temporallyDistinct(candidate, nearest.item, cardinality)
      ) {
        return this.assessment(
          'coexists',
          nearest.item,
          semanticItems,
          'rule',
          1,
          '语义近邻属于不重叠的有效时间',
          cardinality,
          canonicalStableKey(candidate, cardinality, true),
          'different_time_coexists',
          'semantic',
        );
      }
      if (!this.classifier) {
        return this.assessment(
          'coexists',
          nearest.item,
          semanticItems,
          'embedding',
          nearest.score,
          '检测到语义近邻但未配置分类器，采用安全并存',
          cardinality,
          canonicalStableKey(candidate, cardinality),
          'semantic_neighbor_safe_coexistence',
          'semantic',
        );
      }
      const classifierItems = await this.predicateCompatibleItems(
        candidate,
        nearest.rankedItems.slice(0, 12),
      );
      if (classifierItems.length === 0) {
        return this.assessment(
          'coexists',
          nearest.item,
          semanticItems,
          'embedding',
          nearest.score,
          '正文存在语义近邻，但谓词相似度不足，按不同属性安全并存',
          cardinality,
          canonicalStableKey(candidate, cardinality),
          'semantic_predicate_mismatch_coexists',
          'semantic',
        );
      }
      const targets = classifierItems
        .map((item) => this.relationTarget(item));
      const decision = await this.classifier.classify(
        candidate,
        targets,
      );
      const target = classifierItems.find(
        (item) => item.id === decision.targetMemoryId,
      );
      if (!target) {
        throw new Error('关系分类器返回了未知目标记忆');
      }
      if (
        decision.relation === 'supersedes' &&
        (
          !authorityAtLeast(
            candidate.sourceAuthority,
            target.sourceAuthority,
          ) ||
          (
            !candidate.explicitCorrection &&
            !deterministicallySupersedesInTime(
              candidate,
              target,
              cardinality,
            )
          )
        )
      ) {
        return this.assessment(
          'contradicts',
          target,
          semanticItems,
          'model',
          decision.confidence,
          `${decision.rationale}; 权威或纠正意图不足，未覆盖当前事实`,
          cardinality,
          canonicalStableKey(candidate, cardinality),
          'classified_supersession_requires_confirmation',
          'semantic',
          this.classifier.model,
          this.classifier.promptVersion,
        );
      }
      return this.assessment(
        decision.relation,
        target,
        semanticItems,
        'model',
        decision.confidence,
        decision.rationale,
        cardinality,
        canonicalStableKey(
          candidate,
          cardinality,
          decision.relation === 'coexists' &&
            temporallyDistinct(candidate, target, cardinality),
        ),
        this.classifiedReason(decision.relation),
        'semantic',
        this.classifier.model,
        this.classifier.promptVersion,
      );
    }

    return this.assessment(
      'coexists',
      null,
      semanticItems,
      'rule',
      1,
      '当前作用域不存在可合并事实',
      cardinality,
      canonicalStableKey(candidate, cardinality),
      cardinality === 'single'
        ? 'new_single_value'
        : 'coexisting_value',
      'semantic',
    );
  }

  private async findEmbeddingNeighbor(
    candidate: ClaimSubject,
    items: CanonicalClaimTarget[],
  ): Promise<{
    item: CanonicalClaimTarget;
    score: number;
    rankedItems: CanonicalClaimTarget[];
  } | null> {
    if (items.length === 0) return null;
    const texts = [
      candidate.content,
      ...items.map((item) => item.content),
    ];
    const vectors = this.embeddingProvider
      ? await this.embeddingProvider.embed(texts)
      : texts.map((text) => embedText(text));
    if (
      vectors.length !== texts.length ||
      vectors.some(
        (vector) =>
          vector.length === 0 ||
          vector.length !== vectors[0].length,
      )
    ) {
      throw new Error('候选近重复 embedding 返回无效向量');
    }
    const scored = items
      .map((item, index) => ({
        item,
        score: cosineSimilarity(vectors[0], vectors[index + 1]),
      }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.item.id.localeCompare(right.item.id),
      );
    return scored[0].score >= this.embeddingNearThreshold
      ? {
          ...scored[0],
          rankedItems: scored.map((entry) => entry.item),
        }
      : null;
  }

  private async predicateCompatibleItems(
    candidate: ClaimSubject,
    items: CanonicalClaimTarget[],
  ): Promise<CanonicalClaimTarget[]> {
    if (items.length === 0) return [];
    const texts = [
      predicateSemanticText(candidate.predicate),
      ...items.map((item) =>
        predicateTextFromKey(item.predicateKey),
      ),
    ];
    const vectors = this.embeddingProvider
      ? await this.embeddingProvider.embed(texts)
      : texts.map((text) => embedText(text));
    if (
      vectors.length !== texts.length ||
      vectors.some(
        (vector) =>
          vector.length === 0 ||
          vector.length !== vectors[0].length,
      )
    ) {
      throw new Error('候选谓词 embedding 返回无效向量');
    }
    return items.filter(
      (_item, index) =>
        cosineSimilarity(vectors[0], vectors[index + 1]) >=
        SEMANTIC_PREDICATE_NEAR_THRESHOLD,
    );
  }

  private relationTarget(
    item: CanonicalClaimTarget,
  ): ClaimRelationTarget {
    return {
      id: item.id,
      predicateKey: item.predicateKey,
      normalizedValue: item.normalizedValue,
      content: item.content,
      sourceAuthority: item.sourceAuthority,
      occurredAt: item.occurredAt,
      validFrom: item.validFrom,
      validTo: item.validTo,
    };
  }

  private assessment(
    relation: CandidateRelation,
    target: CanonicalClaimTarget | null,
    relatedTargets: CanonicalClaimTarget[],
    method: CandidateResolutionMethod,
    confidence: number,
    rationale: string,
    cardinality: PredicateCardinality,
    stableKey: string,
    reason: string,
    readSet: ClaimRelationAssessment['readSet'],
    model?: string,
    promptVersion?: string,
  ): ClaimRelationAssessment {
    return {
      relation,
      targetMemoryId: target?.id || null,
      target,
      relatedTargets,
      method,
      confidence: clamp(confidence),
      rationale,
      model: model || null,
      promptVersion: promptVersion || null,
      cardinality,
      stableKey,
      reason,
      readSet,
    };
  }

  private classifiedReason(
    relation: CandidateRelation,
  ): string {
    switch (relation) {
      case 'equivalent':
        return 'semantic_equivalent';
      case 'reinforces':
        return 'semantic_reinforcement';
      case 'supersedes':
        return 'semantic_supersession';
      case 'contradicts':
        return 'semantic_contradiction_requires_confirmation';
      case 'coexists':
        return 'semantic_coexistence';
    }
  }
}
