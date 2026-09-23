import { createHash } from 'node:crypto';
import type {
  DatabaseSync,
  SQLInputValue,
} from 'node:sqlite';
import { retrievalTokens } from './embedding.js';
import {
  MEMORY_KINDS,
  type MemoryKind,
  type MemoryScopeType,
} from './types.js';

type DatabaseRow = Record<string, unknown>;

interface SemanticFingerprint {
  version: 1;
  predicateDigest: string;
  valueDigest: string;
  negativeValue: boolean;
  predicateConcepts: string[];
  predicateTokens: string[];
  valueConcepts: string[];
  valueTokens: string[];
}

export interface TombstoneClaimIdentity {
  userId: string;
  namespace: string;
  scopeType: MemoryScopeType;
  scopeKey: string;
  kind: MemoryKind;
  content: string;
  stableKey?: string | null;
  normalizedKey?: string | null;
  normalizedValue?: string | null;
}

export interface TombstoneIdentityFields {
  kind: MemoryKind;
  normalizedKey: string | null;
  normalizedValue: string | null;
  contentHash: string;
  semanticFingerprint: string | null;
}

export interface BlockingTombstone {
  id: string;
  reason: string;
}

export interface TombstoneFingerprintBackfillOptions {
  tombstoneIds?: readonly string[];
  ensureColumns?: boolean;
  requireComplete?: boolean;
}

export interface TombstoneFingerprintBackfillResult {
  scanned: number;
  updated: number;
  unresolvedIds: string[];
}

const NEGATIVE_VALUE_PATTERN =
  /(?:不再|不接受|不允许|不需要|不能|不要|不得|禁止|拒绝|避免|取消|移除|删除|没有|无需|无|空)/iu;
const FINGERPRINT_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_FINGERPRINT_TOKENS_PER_CHANNEL = 256;
const FINGERPRINT_KEYS = [
  'negativeValue',
  'predicateConcepts',
  'predicateDigest',
  'predicateTokens',
  'valueConcepts',
  'valueDigest',
  'valueTokens',
  'version',
] as const;
const SEMANTIC_VALUE_ALIAS_GROUPS = [
  {
    canonical: 'visual studio code',
    aliases: ['visual studio code', 'vs code', 'vscode'],
  },
  {
    canonical: 'javascript',
    aliases: ['javascript', 'java script', 'js'],
  },
  {
    canonical: 'typescript',
    aliases: ['typescript', 'type script', 'ts'],
  },
  {
    canonical: 'postgresql',
    aliases: ['postgresql', 'postgres', 'postgre sql'],
  },
  {
    canonical: 'intellij idea',
    aliases: ['intellij idea', 'intellij'],
  },
] as const;
const VALUE_CONTRAST_GROUPS = [
  [
    {
      marker: 'temperature:hot',
      aliases: ['热', '温热', 'hot', 'warm'],
    },
    {
      marker: 'temperature:cold',
      aliases: ['冰', '冰镇', '冷', 'iced', 'cold'],
    },
  ],
  [
    {
      marker: 'theme:light',
      aliases: ['浅色', '亮色', 'light'],
    },
    {
      marker: 'theme:dark',
      aliases: ['深色', '暗色', 'dark'],
    },
  ],
  [
    {
      marker: 'switch:enabled',
      aliases: ['启用', '开启功能', 'enabled', 'on'],
    },
    {
      marker: 'switch:disabled',
      aliases: ['禁用', '停用', 'disabled', 'off'],
    },
  ],
  [
    {
      marker: 'range:domestic',
      aliases: ['国内', '境内', 'domestic'],
    },
    {
      marker: 'range:international',
      aliases: ['国外', '海外', '境外', 'international'],
    },
  ],
  [
    {
      marker: 'direction:increase',
      aliases: ['增加', '提高', '上调', 'increase', 'raise'],
    },
    {
      marker: 'direction:decrease',
      aliases: ['减少', '降低', '下调', 'decrease', 'reduce'],
    },
  ],
] as const;
const VALUE_EQUIVALENCE_MARKERS = [
  'initial-data:empty-without-demo',
] as const;
const VALUE_OPERATOR_TOKENS = new Set(
  [
    '不喜欢',
    '不想',
    '不愿',
    '不接受',
    '不允许',
    '不需要',
    '不能',
    '不要',
    '不得',
    '禁止',
    '拒绝',
    '避免',
    '取消',
    '移除',
    '删除',
    '没有',
    '无需',
    '必须',
    '需要',
    '喜欢',
    '偏好',
    'prefer',
    'like',
    'dislike',
  ].flatMap((phrase) =>
    retrievalTokens(phrase).filter(
      (token) =>
        !token.startsWith('concept:') &&
        [...token].length >= 2,
    ),
  ),
);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function nullableText(value: unknown): string | null {
  const text = asText(value).trim();
  return text ? text : null;
}

function normalizeIdentityText(value: unknown): string {
  return asText(value)
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeStoredText(value: unknown): string {
  return asText(value)
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeComparableText(value: unknown): string {
  return normalizeIdentityText(value)
    .replace(/[^\p{L}\p{N}:_+#-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function replaceWholeComparableAlias(
  value: string,
  alias: string,
  canonical: string,
): string {
  const padded = ` ${value} `;
  return padded
    .replaceAll(` ${alias} `, ` ${canonical} `)
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeSemanticValue(value: unknown): string {
  let normalized = normalizeComparableText(value);
  for (const group of SEMANTIC_VALUE_ALIAS_GROUPS) {
    for (const alias of group.aliases) {
      normalized = replaceWholeComparableAlias(
        normalized,
        alias,
        group.canonical,
      );
    }
  }
  return normalized;
}

function tokenHash(channel: string, token: string): string {
  return sha256(`${channel}\0${normalizeIdentityText(token)}`);
}

function containsSemanticAlias(
  normalizedValue: string,
  alias: string,
): boolean {
  return /\p{Script=Han}/u.test(alias)
    ? normalizedValue.includes(alias)
    : ` ${normalizedValue} `.includes(` ${alias} `);
}

function valueContrastMarkers(value: string): string[] {
  const markers = new Set<string>();
  for (const group of VALUE_CONTRAST_GROUPS) {
    for (const side of group) {
      if (
        side.aliases.some((alias) =>
          containsSemanticAlias(value, alias),
        )
      ) {
        markers.add(side.marker);
      }
    }
  }
  return [...markers].sort();
}

function valueEquivalenceMarkers(value: string): string[] {
  const markers = new Set<string>();
  const isEmptyInitialData =
    /(?:空数据|没有数据|无数据|empty data)/iu.test(value);
  const rejectsDemoData =
    /(?:演示|示例|demo)/iu.test(value) &&
    NEGATIVE_VALUE_PATTERN.test(value);
  if (isEmptyInitialData || rejectsDemoData) {
    markers.add('initial-data:empty-without-demo');
  }
  return [...markers].sort();
}

function fingerprintTokens(
  value: string,
  channel: 'predicate' | 'value',
): { concepts: string[]; lexical: string[] } {
  const concepts = new Set<string>();
  const lexical = new Set<string>();
  const protectedLexical = new Set<string>();
  for (const token of retrievalTokens(value)) {
    if (token.startsWith('concept:')) {
      concepts.add(tokenHash(`${channel}:concept`, token));
      continue;
    }
    if ([...token].length >= 2) {
      if (
        channel === 'value' &&
        VALUE_OPERATOR_TOKENS.has(token)
      ) {
        continue;
      }
      lexical.add(tokenHash(`${channel}:token`, token));
    }
  }
  if (channel === 'value') {
    for (const marker of [
      ...valueContrastMarkers(value),
      ...valueEquivalenceMarkers(value),
    ]) {
      const hash = tokenHash(
        `${channel}:token`,
        `semantic:${marker}`,
      );
      lexical.add(hash);
      protectedLexical.add(hash);
    }
  }
  const sortedConcepts = [...concepts].sort().slice(
    0,
    MAX_FINGERPRINT_TOKENS_PER_CHANNEL,
  );
  const lexicalBudget = Math.max(
    0,
    MAX_FINGERPRINT_TOKENS_PER_CHANNEL -
      sortedConcepts.length,
  );
  const sortedProtectedLexical = [
    ...protectedLexical,
  ].sort();
  const sortedOtherLexical = [...lexical]
    .filter((hash) => !protectedLexical.has(hash))
    .sort();
  return {
    concepts: sortedConcepts,
    lexical: [
      ...sortedProtectedLexical,
      ...sortedOtherLexical,
    ].slice(0, lexicalBudget),
  };
}

function isFingerprintHashArray(
  value: unknown,
): value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_FINGERPRINT_TOKENS_PER_CHANNEL
  ) {
    return false;
  }
  if (
    !value.every(
      (entry) =>
        typeof entry === 'string' &&
        FINGERPRINT_HASH_PATTERN.test(entry),
    )
  ) {
    return false;
  }
  return new Set(value).size === value.length;
}

function parseFingerprint(
  value: string | null,
): SemanticFingerprint | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      Object.keys(candidate).sort().join('\0') !==
        [...FINGERPRINT_KEYS].sort().join('\0') ||
      candidate.version !== 1 ||
      typeof candidate.predicateDigest !== 'string' ||
      !FINGERPRINT_HASH_PATTERN.test(candidate.predicateDigest) ||
      typeof candidate.valueDigest !== 'string' ||
      !FINGERPRINT_HASH_PATTERN.test(candidate.valueDigest) ||
      typeof candidate.negativeValue !== 'boolean' ||
      !isFingerprintHashArray(candidate.predicateConcepts) ||
      !isFingerprintHashArray(candidate.predicateTokens) ||
      !isFingerprintHashArray(candidate.valueConcepts) ||
      !isFingerprintHashArray(candidate.valueTokens)
    ) {
      return null;
    }
    const fingerprint = candidate as unknown as SemanticFingerprint;
    if (
      fingerprint.predicateConcepts.length +
        fingerprint.predicateTokens.length >
        MAX_FINGERPRINT_TOKENS_PER_CHANNEL ||
      fingerprint.valueConcepts.length +
        fingerprint.valueTokens.length >
        MAX_FINGERPRINT_TOKENS_PER_CHANNEL
    ) {
      return null;
    }
    return fingerprint;
  } catch {
    return null;
  }
}

function intersectionSize(
  left: readonly string[],
  right: readonly string[],
): number {
  const rightSet = new Set(right);
  let count = 0;
  for (const value of left) {
    if (rightSet.has(value)) count += 1;
  }
  return count;
}

function predicateEquivalent(
  left: SemanticFingerprint,
  right: SemanticFingerprint,
): boolean {
  return left.predicateDigest === right.predicateDigest;
}

function hasContradictoryValueMarkers(
  left: SemanticFingerprint,
  right: SemanticFingerprint,
): boolean {
  for (const group of VALUE_CONTRAST_GROUPS) {
    const leftSides = group
      .map((side, index) =>
        left.valueTokens.includes(
          tokenHash(
            'value:token',
            `semantic:${side.marker}`,
          ),
        )
          ? index
          : -1,
      )
      .filter((index) => index >= 0);
    const rightSides = group
      .map((side, index) =>
        right.valueTokens.includes(
          tokenHash(
            'value:token',
            `semantic:${side.marker}`,
          ),
        )
          ? index
          : -1,
      )
      .filter((index) => index >= 0);
    if (
      leftSides.length === 1 &&
      rightSides.length === 1 &&
      leftSides[0] !== rightSides[0]
    ) {
      return true;
    }
  }
  return false;
}

function hasSharedContrastValueMarker(
  left: SemanticFingerprint,
  right: SemanticFingerprint,
): boolean {
  for (const group of VALUE_CONTRAST_GROUPS) {
    for (const side of group) {
      const hash = tokenHash(
        'value:token',
        `semantic:${side.marker}`,
      );
      if (
        left.valueTokens.includes(hash) &&
        right.valueTokens.includes(hash)
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasSharedEquivalenceValueMarker(
  left: SemanticFingerprint,
  right: SemanticFingerprint,
): boolean {
  return VALUE_EQUIVALENCE_MARKERS.some((marker) => {
    const hash = tokenHash(
      'value:token',
      `semantic:${marker}`,
    );
    return (
      left.valueTokens.includes(hash) &&
      right.valueTokens.includes(hash)
    );
  });
}

function valueEquivalent(
  left: SemanticFingerprint,
  right: SemanticFingerprint,
): boolean {
  if (left.valueDigest === right.valueDigest) return true;
  if (left.negativeValue !== right.negativeValue) return false;
  if (hasContradictoryValueMarkers(left, right)) return false;

  const lexicalIntersection = intersectionSize(
    left.valueTokens,
    right.valueTokens,
  );
  const lexicalUnion = new Set([
    ...left.valueTokens,
    ...right.valueTokens,
  ]).size;
  const lexicalJaccard =
    lexicalUnion > 0
      ? lexicalIntersection / lexicalUnion
      : 0;
  if (lexicalIntersection >= 3 && lexicalJaccard >= 0.72) {
    return true;
  }
  const sharedConcept =
    intersectionSize(
      left.valueConcepts,
      right.valueConcepts,
    ) > 0;
  if (
    sharedConcept &&
    hasSharedContrastValueMarker(left, right)
  ) {
    return true;
  }
  if (hasSharedEquivalenceValueMarker(left, right)) {
    return true;
  }
  return false;
}

function predicateFromStableKey(
  stableKey: string | null | undefined,
  scopeType: MemoryScopeType,
  scopeKey: string,
): string | null {
  const key = normalizeIdentityText(stableKey);
  if (!key) return null;
  const prefix = `${normalizeIdentityText(scopeType)}::` +
    `${normalizeIdentityText(scopeKey)}::`;
  return key.startsWith(prefix)
    ? nullableText(key.slice(prefix.length))
    : nullableText(key);
}

export function canonicalContentHash(content: string): string {
  return sha256(
    content.normalize('NFKC').trim().toLowerCase(),
  );
}

export function createSemanticFingerprint(
  normalizedKey: string,
  normalizedValue: string,
): string | null {
  const predicate = normalizeComparableText(normalizedKey);
  const value = normalizeSemanticValue(normalizedValue);
  if (!predicate || !value) return null;
  const predicateTokens = fingerprintTokens(predicate, 'predicate');
  const valueTokens = fingerprintTokens(value, 'value');
  const fingerprint: SemanticFingerprint = {
    version: 1,
    predicateDigest: sha256(`predicate\0${predicate}`),
    valueDigest: sha256(`value\0${value}`),
    negativeValue: NEGATIVE_VALUE_PATTERN.test(value),
    predicateConcepts: predicateTokens.concepts,
    predicateTokens: predicateTokens.lexical,
    valueConcepts: valueTokens.concepts,
    valueTokens: valueTokens.lexical,
  };
  return JSON.stringify(fingerprint);
}

type TombstoneSemanticColumn =
  | 'kind'
  | 'normalized_key'
  | 'normalized_value'
  | 'semantic_fingerprint';

const TOMBSTONE_SEMANTIC_COLUMNS: Record<
  TombstoneSemanticColumn,
  string
> = {
  kind: 'TEXT',
  normalized_key: 'TEXT',
  normalized_value: 'TEXT',
  semantic_fingerprint: 'TEXT',
};

const MEMORY_KIND_SET = new Set<string>(MEMORY_KINDS);

function backfillTableColumns(
  database: DatabaseSync,
  table: string,
): Set<string> {
  const exists = database
    .prepare(
      `SELECT 1
       FROM sqlite_master
       WHERE type = 'table' AND name = ?
       LIMIT 1`,
    )
    .get(table);
  if (!exists) return new Set();
  return new Set(
    (
      database
        .prepare(`PRAGMA table_info("${table}")`)
        .all() as DatabaseRow[]
    ).map((row) => asText(row.name)),
  );
}

function normalizedBackfillIds(
  values: readonly string[] | undefined,
): string[] | undefined {
  if (values === undefined) return undefined;
  return [
    ...new Set(
      values
        .map((value) => normalizeStoredText(value))
        .filter(Boolean),
    ),
  ];
}

function backfillColumnExpression(
  columns: Set<string>,
  alias: string,
  column: string,
  output: string,
): string {
  return columns.has(column)
    ? `${alias}."${column}" AS "${output}"`
    : `NULL AS "${output}"`;
}

function validMemoryKind(value: unknown): MemoryKind | null {
  const kind = nullableText(value);
  return kind && MEMORY_KIND_SET.has(kind)
    ? kind as MemoryKind
    : null;
}

function validStoredFingerprint(value: unknown): string | null {
  const fingerprint = nullableText(value);
  return fingerprint && parseFingerprint(fingerprint)
    ? fingerprint
    : null;
}

export function backfillTombstoneSemanticFingerprints(
  database: DatabaseSync,
  options: TombstoneFingerprintBackfillOptions = {},
): TombstoneFingerprintBackfillResult {
  const requestedIds = normalizedBackfillIds(
    options.tombstoneIds,
  );

  let tombstoneColumns = backfillTableColumns(
    database,
    'memory_tombstones',
  );
  if (tombstoneColumns.size === 0) {
    if (options.requireComplete && requestedIds?.length) {
      throw new Error(
        'tombstone 指纹回填失败：缺少 memory_tombstones 表',
      );
    }
    return {
      scanned: 0,
      updated: 0,
      unresolvedIds: requestedIds || [],
    };
  }
  if (options.ensureColumns) {
    for (const [column, definition] of Object.entries(
      TOMBSTONE_SEMANTIC_COLUMNS,
    )) {
      if (tombstoneColumns.has(column)) continue;
      database.exec(
        `ALTER TABLE memory_tombstones
         ADD COLUMN "${column}" ${definition}`,
      );
    }
    tombstoneColumns = backfillTableColumns(
      database,
      'memory_tombstones',
    );
  }
  if (requestedIds?.length === 0) {
    return { scanned: 0, updated: 0, unresolvedIds: [] };
  }
  const requiredColumns = Object.keys(
    TOMBSTONE_SEMANTIC_COLUMNS,
  );
  if (
    !tombstoneColumns.has('id') ||
    requiredColumns.some(
      (column) => !tombstoneColumns.has(column),
    )
  ) {
    const unresolvedIds = requestedIds || [];
    if (options.requireComplete && unresolvedIds.length > 0) {
      throw new Error(
        'tombstone 指纹回填失败：语义字段不完整',
      );
    }
    return { scanned: 0, updated: 0, unresolvedIds };
  }

  const itemColumns = backfillTableColumns(
    database,
    'memory_items',
  );
  const canJoinItem =
    tombstoneColumns.has('memory_item_id') &&
    itemColumns.has('id');
  const joinedItemColumns = canJoinItem
    ? itemColumns
    : new Set<string>();
  const memoryColumns = backfillTableColumns(
    database,
    'memories',
  );
  const canJoinMemory =
    tombstoneColumns.has('memory_item_id') &&
    memoryColumns.has('id');
  const joinedMemoryColumns = canJoinMemory
    ? memoryColumns
    : new Set<string>();
  const whereValues: SQLInputValue[] = [];
  const whereClause = requestedIds
    ? `WHERE t.id IN (${requestedIds
        .map(() => '?')
        .join(', ')})`
    : '';
  if (requestedIds) whereValues.push(...requestedIds);
  const rows = database
    .prepare(
      `SELECT
         t.id,
         ${backfillColumnExpression(
           tombstoneColumns,
           't',
           'kind',
           'tombstone_kind',
         )},
         ${backfillColumnExpression(
           tombstoneColumns,
           't',
           'normalized_key',
           'tombstone_normalized_key',
         )},
         ${backfillColumnExpression(
           tombstoneColumns,
           't',
           'normalized_value',
           'tombstone_normalized_value',
         )},
         ${backfillColumnExpression(
           tombstoneColumns,
           't',
           'semantic_fingerprint',
           'tombstone_semantic_fingerprint',
         )},
         ${backfillColumnExpression(
           tombstoneColumns,
           't',
           'stable_key',
           'tombstone_stable_key',
         )},
         ${backfillColumnExpression(
           tombstoneColumns,
           't',
           'scope_type',
           'tombstone_scope_type',
         )},
         ${backfillColumnExpression(
           tombstoneColumns,
           't',
           'scope_key',
           'tombstone_scope_key',
         )},
         ${backfillColumnExpression(
           joinedItemColumns,
           'i',
           'kind',
           'item_kind',
         )},
         ${backfillColumnExpression(
           joinedItemColumns,
           'i',
           'predicate_key',
           'item_predicate_key',
         )},
         ${backfillColumnExpression(
           joinedItemColumns,
           'i',
           'normalized_value',
           'item_normalized_value',
         )},
         ${backfillColumnExpression(
           joinedItemColumns,
           'i',
           'stable_key',
           'item_stable_key',
         )},
         ${backfillColumnExpression(
           joinedMemoryColumns,
           'm',
           'content',
           'memory_content',
         )}
       FROM memory_tombstones t
       ${canJoinItem
         ? 'LEFT JOIN memory_items i ON i.id = t.memory_item_id'
         : 'LEFT JOIN (SELECT NULL AS id) i ON 0'}
       ${canJoinMemory
         ? 'LEFT JOIN memories m ON m.id = t.memory_item_id'
         : 'LEFT JOIN (SELECT NULL AS id) m ON 0'}
       ${whereClause}
       ORDER BY t.id ASC`,
    )
    .all(...whereValues) as Array<Record<string, unknown>>;

  let updated = 0;
  const unresolvedIds: string[] = [];
  for (const row of rows) {
    const id = asText(row.id);
    const existingFingerprint = validStoredFingerprint(
      row.tombstone_semantic_fingerprint,
    );
    const kind =
      validMemoryKind(row.tombstone_kind) ||
      validMemoryKind(row.item_kind);
    const scopeType = (
      nullableText(row.tombstone_scope_type) || 'personal'
    ) as MemoryScopeType;
    const scopeKey =
      nullableText(row.tombstone_scope_key) || 'self';
    const normalizedKey =
      nullableText(row.tombstone_normalized_key) ||
      nullableText(row.item_predicate_key) ||
      predicateFromStableKey(
        nullableText(row.item_stable_key) ||
          nullableText(row.tombstone_stable_key),
        scopeType,
        scopeKey,
      );
    const normalizedValue =
      nullableText(row.tombstone_normalized_value) ||
      nullableText(row.item_normalized_value);
    const semanticValue =
      normalizedValue ||
      nullableText(row.memory_content);
    const recomputedFingerprint =
      normalizedKey && semanticValue
        ? createSemanticFingerprint(
            normalizedKey,
            semanticValue,
          )
        : null;
    const fingerprint =
      recomputedFingerprint || existingFingerprint;
    if (!kind || !fingerprint) {
      unresolvedIds.push(id);
      continue;
    }
    const result = database
      .prepare(
        `UPDATE memory_tombstones
         SET kind = ?,
             normalized_key = CASE
               WHEN normalized_key IS NULL
                 OR trim(normalized_key) = ''
               THEN ?
               ELSE normalized_key
             END,
             normalized_value = CASE
               WHEN normalized_value IS NULL
                 OR trim(normalized_value) = ''
               THEN ?
               ELSE normalized_value
             END,
             semantic_fingerprint = ?
         WHERE id = ?
           AND (
             kind IS NOT ?
             OR semantic_fingerprint IS NOT ?
             OR (
               (
                 normalized_key IS NULL
                 OR trim(normalized_key) = ''
               )
               AND ? IS NOT NULL
             )
             OR (
               (
                 normalized_value IS NULL
                 OR trim(normalized_value) = ''
               )
               AND ? IS NOT NULL
             )
           )`,
      )
      .run(
        kind,
        normalizedKey,
        normalizedValue,
        fingerprint,
        id,
        kind,
        fingerprint,
        normalizedKey,
        normalizedValue,
      );
    updated += Number(result.changes);
  }

  if (requestedIds) {
    const foundIds = new Set(rows.map((row) => asText(row.id)));
    for (const id of requestedIds) {
      if (!foundIds.has(id)) unresolvedIds.push(id);
    }
  }
  const uniqueUnresolvedIds = [...new Set(unresolvedIds)].sort();
  if (
    options.requireComplete &&
    uniqueUnresolvedIds.length > 0
  ) {
    throw new Error(
      `tombstone 指纹回填失败：${uniqueUnresolvedIds.join(', ')}`,
    );
  }
  return {
    scanned: rows.length,
    updated,
    unresolvedIds: uniqueUnresolvedIds,
  };
}

export function tombstoneIdentityFields(
  claim: Pick<
    TombstoneClaimIdentity,
    | 'kind'
    | 'content'
    | 'stableKey'
    | 'normalizedKey'
    | 'normalizedValue'
    | 'scopeType'
    | 'scopeKey'
  >,
): TombstoneIdentityFields {
  const normalizedKey =
    nullableText(normalizeStoredText(claim.normalizedKey)) ||
    predicateFromStableKey(
      claim.stableKey,
      claim.scopeType,
      claim.scopeKey,
    );
  const normalizedValue = nullableText(
    normalizeStoredText(
      claim.normalizedValue || claim.content,
    ),
  );
  return {
    kind: claim.kind,
    normalizedKey,
    normalizedValue,
    contentHash: canonicalContentHash(claim.content),
    semanticFingerprint:
      normalizedKey && normalizedValue
        ? createSemanticFingerprint(normalizedKey, normalizedValue)
        : null,
  };
}

export function findBlockingTombstone(
  database: DatabaseSync,
  claim: TombstoneClaimIdentity,
): BlockingTombstone | null {
  const identity = tombstoneIdentityFields(claim);
  const claimFingerprint = parseFingerprint(
    identity.semanticFingerprint,
  );
  const rows = database
    .prepare(
      `SELECT id, reason, kind, content_hash, normalized_key,
              normalized_value, semantic_fingerprint
       FROM memory_tombstones
       WHERE user_id = ?
         AND namespace = ?
         AND scope_type = ?
         AND scope_key = ?
         AND restored_at IS NULL
         AND (
           content_hash = ?
           OR kind = ?
         )
       ORDER BY created_at DESC, id DESC`,
    )
    .all(
      claim.userId,
      claim.namespace,
      claim.scopeType,
      claim.scopeKey,
      identity.contentHash,
      claim.kind,
    ) as DatabaseRow[];

  for (const row of rows) {
    const storedKind = nullableText(row.kind);
    const exactContent =
      nullableText(row.content_hash) === identity.contentHash;
    if (exactContent && (!storedKind || storedKind === claim.kind)) {
      return {
        id: asText(row.id),
        reason: asText(row.reason),
      };
    }
    if (
      storedKind !== claim.kind ||
      !identity.normalizedKey ||
      !identity.normalizedValue ||
      !claimFingerprint
    ) {
      continue;
    }
    const storedKey = nullableText(row.normalized_key);
    const storedValue = nullableText(row.normalized_value);
    const recomputedStoredFingerprint =
      storedKey && storedValue
        ? parseFingerprint(
            createSemanticFingerprint(storedKey, storedValue),
          )
        : null;
    const storedFingerprint =
      recomputedStoredFingerprint ||
      parseFingerprint(nullableText(row.semantic_fingerprint));
    if (
      storedFingerprint &&
      predicateEquivalent(storedFingerprint, claimFingerprint) &&
      valueEquivalent(storedFingerprint, claimFingerprint)
    ) {
      return {
        id: asText(row.id),
        reason: asText(row.reason),
      };
    }
  }
  return null;
}

export function assertNotTombstoned(
  database: DatabaseSync,
  claim: TombstoneClaimIdentity,
): void {
  const blocking = findBlockingTombstone(database, claim);
  if (blocking) {
    throw new Error(
      `该长期记忆已被遗忘规则阻止（tombstone ${blocking.id}）`,
    );
  }
}
