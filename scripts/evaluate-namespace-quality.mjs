import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DatabaseSync,
  constants as sqliteConstants,
} from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  CandidateResolver,
} from '../dist/server/candidate-resolver.js';
import {
  ClaimRelationEngine,
} from '../dist/server/claim-relation-engine.js';
import {
  OllamaClaimRelationClassifier,
} from '../dist/server/claim-relation-classifier.js';
import {
  openDatabase,
  SCHEMA_VERSION,
} from '../dist/server/database.js';
import {
  alignSourceExcerpt,
  containsCredentialSecret,
  isAtomicCandidateContentSupported,
  MEMORY_EXTRACTOR_IMPLEMENTATION_CONTRACT,
  OllamaMemoryExtractor,
  projectScopeNamesFromText,
  structuredAtomicCandidateText,
} from '../dist/server/memory-extractor.js';
import {
  LifecycleStore,
} from '../dist/server/lifecycle-store.js';
import {
  MemoryStore,
} from '../dist/server/memory-store.js';
import {
  DEFAULT_NAMESPACE_QUALITY_THRESHOLDS,
  NAMESPACE_QUALITY_DATASET_ID,
  NAMESPACE_QUALITY_DATASET_SHA256,
  NAMESPACE_QUALITY_EVALUATOR_VERSION,
  NAMESPACE_QUALITY_PIPELINE_IMPLEMENTATION_SHA256,
  NamespaceQualityService,
} from '../dist/server/namespace-quality.js';
import {
  OllamaSemanticRanker,
} from '../dist/server/semantic-ranker.js';

const EVALUATOR_VERSION = NAMESPACE_QUALITY_EVALUATOR_VERSION;
const EXTRACTION_MODEL = 'qwen2.5:14b';
const RELATION_MODEL = 'qwen2.5:14b';
const RERANK_MODEL = 'qwen2.5:14b';
const EMBEDDING_MODEL = 'bge-m3:latest';
const EXTRACTION_PROMPT_VERSION = 'extract-v6';
const RELATION_PROMPT_VERSION = 'claim-relation-v1';
const FIXED_SEED = 42;
const KEEP_ALIVE = '15m';
const EMBEDDING_NEAR_THRESHOLD = 0.82;
const EXPECTED_MATCH_THRESHOLD = 0.55;
const DEFAULT_TIMEOUT_MS = 300_000;
const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/memory-quality-v1.json', import.meta.url),
);
const DEFAULT_FORMAL_DATABASE_PATH =
  process.env.MEMORY_BRIDGE_DATA_DIR
    ? path.resolve(
        process.env.MEMORY_BRIDGE_DATA_DIR,
        'memory-bridge.sqlite3',
      )
    : fileURLToPath(
        new URL('../data/memory-bridge.sqlite3', import.meta.url),
      );
const EXPECTED_FIXTURE_SHA256 =
  NAMESPACE_QUALITY_DATASET_SHA256;

const QUALITY_PIPELINE_SOURCE_FILES = [
  [
    'scripts/evaluate-namespace-quality.mjs',
    fileURLToPath(import.meta.url),
  ],
  [
    'src/server/memory-extractor.ts',
    fileURLToPath(
      new URL('../src/server/memory-extractor.ts', import.meta.url),
    ),
  ],
  [
    'src/server/candidate-resolver.ts',
    fileURLToPath(
      new URL('../src/server/candidate-resolver.ts', import.meta.url),
    ),
  ],
  [
    'src/server/claim-relation-engine.ts',
    fileURLToPath(
      new URL('../src/server/claim-relation-engine.ts', import.meta.url),
    ),
  ],
  [
    'src/server/semantic-ranker.ts',
    fileURLToPath(
      new URL('../src/server/semantic-ranker.ts', import.meta.url),
    ),
  ],
];

export const QUALITY_PIPELINE_IMPLEMENTATION_SHA256 = (() => {
  const hash = createHash('sha256');
  for (const [relativePath, absolutePath] of
    QUALITY_PIPELINE_SOURCE_FILES) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(fs.readFileSync(absolutePath));
    hash.update('\0');
  }
  return hash.digest('hex');
})();

const THRESHOLDS = DEFAULT_NAMESPACE_QUALITY_THRESHOLDS;

function usage() {
  return [
    '用法：',
    '  npm run evaluate:namespace-quality',
    '  npm run evaluate:namespace-quality -- --validate-fixture',
    '  npm run evaluate:namespace-quality -- --record --database /private/tmp/isolated.sqlite3 --user USER --namespace NAMESPACE',
    '  npm run evaluate:namespace-quality -- --record --database data/memory-bridge.sqlite3 --user USER --namespace NAMESPACE --allow-default-database',
    '',
    '选项：',
    '  --record             PASS/FAIL 都写质量快照；FAIL 会回退 shadow',
    '  --database PATH      --record 必需；默认拒绝正式数据库',
    '  --user ID            --record 必需',
    '  --namespace NAME     --record 必需',
    '  --allow-default-database  二次确认只向默认库写质量/审计元数据',
    '  --ollama-url URL     默认 http://127.0.0.1:11434',
    '  --timeout-ms N       单次 Ollama 请求超时，默认 300000',
    '  --validate-fixture   只校验固定数据集，不调用 Ollama',
    '  --help               显示帮助',
  ].join('\n');
}

function parseArgs(argv) {
  const result = {
    record: false,
    database: '',
    user: '',
    namespace: '',
    ollamaUrl: 'http://127.0.0.1:11434',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    validateFixture: false,
    allowDefaultDatabase: false,
    help: false,
  };
  const valueOptions = new Map([
    ['--database', 'database'],
    ['--user', 'user'],
    ['--namespace', 'namespace'],
    ['--ollama-url', 'ollamaUrl'],
    ['--timeout-ms', 'timeoutMs'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--record') {
      result.record = true;
      continue;
    }
    if (argument === '--validate-fixture') {
      result.validateFixture = true;
      continue;
    }
    if (argument === '--allow-default-database') {
      result.allowDefaultDatabase = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      result.help = true;
      continue;
    }
    const key = valueOptions.get(argument);
    if (!key) throw new Error(`未知参数：${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} 缺少值`);
    }
    result[key] = key === 'timeoutMs' ? Number(value) : value;
    index += 1;
  }
  if (
    !Number.isInteger(result.timeoutMs) ||
    result.timeoutMs < 1_000 ||
    result.timeoutMs > 900_000
  ) {
    throw new Error('--timeout-ms 必须是 1000 到 900000 之间的整数');
  }
  result.ollamaUrl = String(result.ollamaUrl).replace(/\/+$/u, '');
  if (!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/iu.test(
    result.ollamaUrl,
  )) {
    throw new Error('--ollama-url 只允许 loopback HTTP(S) 地址');
  }
  const recordValues = [
    result.database,
    result.user,
    result.namespace,
  ].filter(Boolean);
  if (result.record && recordValues.length !== 3) {
    throw new Error(
      '--record 必须同时显式提供 --database、--user 和 --namespace',
    );
  }
  if (!result.record && recordValues.length > 0) {
    throw new Error(
      '--database、--user 和 --namespace 只允许与 --record 一起使用',
    );
  }
  if (result.allowDefaultDatabase && !result.record) {
    throw new Error('--allow-default-database 只能与 --record 一起使用');
  }
  if (result.record && result.validateFixture) {
    throw new Error('--validate-fixture 不能与 --record 同时使用');
  }
  return result;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.normalize('NFKC').trim()) {
    throw new Error(`${field} 必须是非空字符串`);
  }
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} 必须是正整数`);
  }
  return value;
}

function validateDataset(dataset) {
  if (!isRecord(dataset)) throw new Error('fixture 根节点必须是对象');
  if (dataset.datasetId !== NAMESPACE_QUALITY_DATASET_ID) {
    throw new Error('fixture datasetId 不正确');
  }
  if (dataset.schemaVersion !== 1) {
    throw new Error('fixture schemaVersion 不受支持');
  }
  for (const field of [
    'extractionCases',
    'negativeCases',
    'conflictGroups',
    'duplicateGroups',
  ]) {
    if (!Array.isArray(dataset[field]) || dataset[field].length === 0) {
      throw new Error(`fixture ${field} 必须是非空数组`);
    }
  }

  const ids = new Set();
  const addId = (value, field) => {
    const id = nonEmptyString(value, field);
    if (ids.has(id)) throw new Error(`fixture id 重复：${id}`);
    ids.add(id);
    return id;
  };

  let positiveFacts = 0;
  for (const fixture of dataset.extractionCases) {
    if (!isRecord(fixture)) throw new Error('extractionCase 必须是对象');
    addId(fixture.id, 'extractionCase.id');
    nonEmptyString(fixture.text, `${fixture.id}.text`);
    if (!Array.isArray(fixture.expected) || fixture.expected.length === 0) {
      throw new Error(`${fixture.id}.expected 必须是非空数组`);
    }
    for (const expected of fixture.expected) {
      if (!isRecord(expected)) {
        throw new Error(`${fixture.id}.expected 项必须是对象`);
      }
      addId(expected.id, `${fixture.id}.expected.id`);
      nonEmptyString(expected.canonical, `${expected.id}.canonical`);
      if (
        !Array.isArray(expected.valueTerms) ||
        expected.valueTerms.length === 0
      ) {
        throw new Error(`${expected.id}.valueTerms 必须是非空数组`);
      }
      expected.valueTerms.forEach((term, index) =>
        nonEmptyString(term, `${expected.id}.valueTerms[${index}]`),
      );
      positiveFacts += 1;
    }
  }

  const negativeCategories = new Set();
  let credentialSamples = 0;
  let discourseNegativeSamples = 0;
  for (const fixture of dataset.negativeCases) {
    if (!isRecord(fixture)) throw new Error('negativeCase 必须是对象');
    addId(fixture.id, 'negativeCase.id');
    nonEmptyString(fixture.text, `${fixture.id}.text`);
    const category = nonEmptyString(
      fixture.category,
      `${fixture.id}.category`,
    );
    const sampleCount = positiveInteger(
      fixture.sampleCount,
      `${fixture.id}.sampleCount`,
    );
    negativeCategories.add(category);
    if (category === 'credential') {
      credentialSamples += sampleCount;
    } else {
      discourseNegativeSamples += sampleCount;
    }
  }
  for (const category of [
    'credential',
    'quotation',
    'sarcasm',
    'denial',
    'hypothetical',
    'third-party',
  ]) {
    if (!negativeCategories.has(category)) {
      throw new Error(`fixture 缺少负例类别：${category}`);
    }
  }

  let conflictSamples = 0;
  for (const group of dataset.conflictGroups) {
    if (!isRecord(group)) throw new Error('conflictGroup 必须是对象');
    addId(group.id, 'conflictGroup.id');
    if (
      !['contradicts', 'supersedes', 'coexists'].includes(
        group.expectedRelation,
      )
    ) {
      throw new Error(`${group.id}.expectedRelation 无效`);
    }
    if (!Array.isArray(group.cases) || group.cases.length === 0) {
      throw new Error(`${group.id}.cases 必须是非空数组`);
    }
    group.cases.forEach((entry, index) => {
      if (
        !Array.isArray(entry) ||
        entry.length !== 3 ||
        entry.some((value) => typeof value !== 'string' || !value.trim())
      ) {
        throw new Error(`${group.id}.cases[${index}] 必须是三个字符串`);
      }
    });
    conflictSamples += group.cases.length;
  }

  let semanticDuplicateSamples = 0;
  for (const group of dataset.duplicateGroups) {
    if (!isRecord(group)) throw new Error('duplicateGroup 必须是对象');
    addId(group.id, 'duplicateGroup.id');
    for (const field of [
      'kind',
      'subject',
      'targetPredicate',
      'candidatePredicate',
      'targetTemplate',
      'candidateTemplate',
    ]) {
      nonEmptyString(group[field], `${group.id}.${field}`);
    }
    if (
      !group.targetTemplate.includes('{{value}}') ||
      !group.candidateTemplate.includes('{{value}}')
    ) {
      throw new Error(`${group.id} 的模板必须包含 {{value}}`);
    }
    if (!Array.isArray(group.values) || group.values.length === 0) {
      throw new Error(`${group.id}.values 必须是非空数组`);
    }
    const values = new Set();
    group.values.forEach((value, index) => {
      const normalized = nonEmptyString(
        value,
        `${group.id}.values[${index}]`,
      ).normalize('NFKC');
      if (values.has(normalized)) {
        throw new Error(`${group.id}.values 存在重复值：${normalized}`);
      }
      values.add(normalized);
    });
    semanticDuplicateSamples += group.values.length;
  }

  if (positiveFacts < 100) {
    throw new Error(`稳定事实样本不足 100：${positiveFacts}`);
  }
  if (credentialSamples < 20) {
    throw new Error(`凭据样本不足 20：${credentialSamples}`);
  }
  if (discourseNegativeSamples < 20) {
    throw new Error(`话语负例不足 20：${discourseNegativeSamples}`);
  }
  if (conflictSamples < 50) {
    throw new Error(`冲突样本不足 50：${conflictSamples}`);
  }
  if (semanticDuplicateSamples < 100) {
    throw new Error(
      `同义重复样本不足 100：${semanticDuplicateSamples}`,
    );
  }

  return {
    extractionTurns: dataset.extractionCases.length,
    positiveFacts,
    credentialSamples,
    discourseNegativeSamples,
    negativeTurns: dataset.negativeCases.length,
    conflictSamples,
    semanticDuplicateSamples,
  };
}

export function parseFixedDatasetBytes(bytes) {
  const datasetSha256 = createHash('sha256').update(bytes).digest('hex');
  if (datasetSha256 !== EXPECTED_FIXTURE_SHA256) {
    throw new Error(
      '固定数据集 SHA-256 不匹配：' +
      `期望 ${EXPECTED_FIXTURE_SHA256}，实际 ${datasetSha256}`,
    );
  }
  const dataset = JSON.parse(bytes.toString('utf8'));
  const counts = validateDataset(dataset);
  return { dataset, datasetSha256, counts };
}

function readDataset() {
  return parseFixedDatasetBytes(fs.readFileSync(FIXTURE_PATH));
}

function normalizedTerm(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[^\p{L}\p{N}+#/]+/gu, '');
}

function normalizedProjectScopeKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s*(?:项目|软件)$/u, '')
    .toLocaleLowerCase('zh-CN');
}

function explicitProjectScopeNames(fixture, expected) {
  const canonicalNames = projectScopeNamesFromText(
    expected.canonical,
  );
  const fixtureNames = projectScopeNamesFromText(fixture.text || '');
  const unambiguousNames = (
    canonicalNames.length > 0 ? canonicalNames : fixtureNames
  ).filter((name) =>
    /^[A-Za-z][A-Za-z0-9_.-]{1,50}$/u.test(name),
  );
  return new Set(
    unambiguousNames.map(normalizedProjectScopeKey),
  );
}

function candidateScopeMatchesExpected(
  fixture,
  expected,
  candidate,
) {
  const projectNames = explicitProjectScopeNames(fixture, expected);
  if (projectNames.size === 0) return true;
  return (
    candidate.scopeType === 'project' &&
    projectNames.has(
      normalizedProjectScopeKey(candidate.scopeKey),
    )
  );
}

const CHINESE_NUMERAL_DIGITS = new Map([
  ['零', 0],
  ['〇', 0],
  ['一', 1],
  ['二', 2],
  ['两', 2],
  ['三', 3],
  ['四', 4],
  ['五', 5],
  ['六', 6],
  ['七', 7],
  ['八', 8],
  ['九', 9],
]);
const CHINESE_NUMERAL_UNITS = new Map([
  ['十', 10],
  ['百', 100],
  ['千', 1_000],
  ['万', 10_000],
]);
const NUMERAL_SOURCE =
  '(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万]+)';
const QUANTITY_UNIT_SOURCE = [
  '小时',
  '分钟',
  '秒钟',
  '公里',
  '千米',
  '厘米',
  '毫米',
  '个',
  '篇',
  '次',
  '天',
  '周',
  '月',
  '年',
  '秒',
  '点',
  '号',
  '本',
  '倍',
  '块',
  '张',
  '份',
  '套',
  '台',
  '名',
  '人',
  '元',
  '岁',
  '层',
  '度',
].join('|');
const RATIO_QUANTITY_PATTERN = new RegExp(
  `(${NUMERAL_SOURCE})\\s*(?:比|:)\\s*(${NUMERAL_SOURCE})`,
  'gu',
);
const CHINESE_PERCENTAGE_PATTERN = new RegExp(
  `百分之\\s*(${NUMERAL_SOURCE})`,
  'gu',
);
const SYMBOL_PERCENTAGE_PATTERN = new RegExp(
  `(${NUMERAL_SOURCE})\\s*%`,
  'gu',
);
const ORDINAL_QUANTITY_PATTERN = new RegExp(
  `第\\s*(${NUMERAL_SOURCE})\\s*(${QUANTITY_UNIT_SOURCE})`,
  'gu',
);
const MONTH_DAY_QUANTITY_PATTERN = new RegExp(
  `每月\\s*(${NUMERAL_SOURCE})\\s*号`,
  'gu',
);
const WEEKDAY_QUANTITY_PATTERN =
  /每周\s*([一二三四五六日天1-7])(?!\s*(?:个|篇|次|天|小时|分钟|秒|点|号|本|倍|块|张|份|套|台|名|人|元|岁|层|度))/gu;
const UNIT_QUANTITY_PATTERN = new RegExp(
  `(${NUMERAL_SOURCE})\\s*(${QUANTITY_UNIT_SOURCE})`,
  'gu',
);
const DURATION_QUANTITY_UNITS =
  new Set(['秒', '分钟', '小时', '天', '周', '月', '年']);

function canonicalNumeral(value) {
  const source = String(value ?? '').normalize('NFKC').trim();
  if (/^\d+(?:\.\d+)?$/u.test(source)) {
    const number = Number(source);
    return Number.isFinite(number) ? String(number) : '';
  }
  if (
    !source ||
    !/^[零〇一二两三四五六七八九十百千万]+$/u.test(source)
  ) {
    return '';
  }
  if (!/[十百千万]/u.test(source)) {
    const digits = [...source].map((character) =>
      CHINESE_NUMERAL_DIGITS.get(character),
    );
    if (digits.some((digit) => digit === undefined)) return '';
    return String(Number(digits.join('')));
  }
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const character of source) {
    const nextDigit = CHINESE_NUMERAL_DIGITS.get(character);
    if (nextDigit !== undefined) {
      digit = nextDigit;
      continue;
    }
    const unit = CHINESE_NUMERAL_UNITS.get(character);
    if (!unit) return '';
    if (unit === 10_000) {
      section += digit;
      total += (section || 1) * unit;
      section = 0;
      digit = 0;
      continue;
    }
    section += (digit || 1) * unit;
    digit = 0;
  }
  return String(total + section + digit);
}

function quantityUnitToken(number, unit) {
  const normalizedUnit = unit === '秒钟' ? '秒' : unit;
  if (DURATION_QUANTITY_UNITS.has(normalizedUnit)) {
    return `duration:${number}:${normalizedUnit}`;
  }
  if (normalizedUnit === '号') return `day-of-month:${number}`;
  if (normalizedUnit === '点') return `clock-hour:${number}`;
  return `count:${number}:${normalizedUnit}`;
}

export function quantityTokens(value) {
  const source = String(value ?? '').normalize('NFKC');
  const occupied = [];
  const tokens = [];
  const collect = (pattern, createToken) => {
    for (const match of source.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (
        occupied.some(
          (span) => start < span.end && end > span.start,
        )
      ) {
        continue;
      }
      const token = createToken(match);
      if (!token) continue;
      occupied.push({ start, end });
      tokens.push({ start, token });
    }
  };
  collect(RATIO_QUANTITY_PATTERN, (match) => {
    const left = canonicalNumeral(match[1]);
    const right = canonicalNumeral(match[2]);
    return left && right ? `ratio:${left}:${right}` : '';
  });
  collect(CHINESE_PERCENTAGE_PATTERN, (match) => {
    const number = canonicalNumeral(match[1]);
    return number ? `percent:${number}` : '';
  });
  collect(SYMBOL_PERCENTAGE_PATTERN, (match) => {
    const number = canonicalNumeral(match[1]);
    return number ? `percent:${number}` : '';
  });
  collect(ORDINAL_QUANTITY_PATTERN, (match) => {
    const number = canonicalNumeral(match[1]);
    return number ? `ordinal:${number}:${match[2]}` : '';
  });
  collect(MONTH_DAY_QUANTITY_PATTERN, (match) => {
    const number = canonicalNumeral(match[1]);
    return number ? `month-day:${number}` : '';
  });
  collect(WEEKDAY_QUANTITY_PATTERN, (match) => {
    const raw = match[1];
    const number =
      raw === '日' || raw === '天'
        ? '7'
        : canonicalNumeral(raw);
    return number ? `weekday:${number}` : '';
  });
  collect(UNIT_QUANTITY_PATTERN, (match) => {
    const number = canonicalNumeral(match[1]);
    return number ? quantityUnitToken(number, match[2]) : '';
  });
  tokens.sort(
    (left, right) =>
      left.start - right.start ||
      left.token.localeCompare(right.token),
  );
  return [...new Set(tokens.map((entry) => entry.token))];
}

function negativePolarity(value) {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replaceAll('不确定', '')
    .replaceAll('uncertain', '');
  return /(?:从不|不得|不能|不再|不允许|不接受|不使用|不用|不吃|不选|不安排|不要|不加|不|没有|没|禁止|拒绝|避免|禁用|停用|关闭|无需|无须|(?:^|\W)(?:not|never|no|without|forbid(?:den)?|disallow(?:ed)?|disable(?:d)?|avoid)(?:\W|$))/iu
    .test(normalized);
}

function quantitiesMatch(
  candidateValue,
  expectedTerm,
  expectedCanonical,
) {
  const candidate = new Set(quantityTokens(candidateValue));
  const term = new Set(quantityTokens(expectedTerm));
  const canonical = new Set(quantityTokens(expectedCanonical));
  return (
    [...term].every((quantity) => candidate.has(quantity)) &&
    [...candidate].every((quantity) => canonical.has(quantity))
  );
}

function singleAsciiIdentifier(value) {
  return /^[a-z0-9][a-z0-9+#/_.:%-]*$/iu.test(
    String(value ?? '').normalize('NFKC').trim(),
  );
}

function identifierTermMatches(candidateValue, expectedTerm) {
  const source = String(candidateValue ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN');
  const target = String(expectedTerm ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('zh-CN');
  let start = source.indexOf(target);
  while (start >= 0) {
    const before = start > 0 ? source[start - 1] : '';
    const after = source[start + target.length] || '';
    if (
      !/[a-z0-9+#/]/iu.test(before) &&
      !/[a-z0-9+#/]/iu.test(after)
    ) {
      return true;
    }
    start = source.indexOf(target, start + 1);
  }
  return false;
}

function boundedOrderedSubsequence(haystack, needle) {
  const source = [...haystack];
  const target = [...needle];
  if (target.length < 4 || source.length < target.length) return false;
  const maxTotalInsertions = Math.max(
    2,
    Math.floor(target.length / 2),
  );
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== target[0]) continue;
    let sourceIndex = start;
    let inserted = 0;
    let matched = true;
    for (let targetIndex = 1; targetIndex < target.length; targetIndex += 1) {
      let next = sourceIndex + 1;
      while (
        next < source.length &&
        source[next] !== target[targetIndex] &&
        next - sourceIndex <= 3
      ) {
        next += 1;
      }
      const gap = next - sourceIndex - 1;
      if (
        next >= source.length ||
        source[next] !== target[targetIndex] ||
        gap > 2
      ) {
        matched = false;
        break;
      }
      inserted += gap;
      if (inserted > maxTotalInsertions) {
        matched = false;
        break;
      }
      sourceIndex = next;
    }
    if (matched) return true;
  }
  return false;
}

const VALUE_TRANSITION_MARKERS = [
  '改为',
  '改成',
  '改用',
  '换成',
  '切换到',
  '迁移到',
  '搬到',
  '转到',
  '替换为',
  '现在使用',
  '现在用',
  '现用',
  'changedto',
  'switchedto',
  'movedto',
  'replacedwith',
];

const VALUE_REMOVAL_MARKERS = [
  '不再使用',
  '不再用',
  '停止使用',
  '停止',
  '取消',
  '弃用',
  '停用',
  '撤销',
  '删除',
  '移除',
  '放弃',
  'stoppedusing',
  'removed',
  'deleted',
  'dropped',
];

function termPositions(source, target) {
  const positions = [];
  let index = source.indexOf(target);
  while (index >= 0) {
    positions.push(index);
    index = source.indexOf(target, index + 1);
  }
  return positions;
}

function expectedTermIsSuperseded(candidateValue, expectedTerm) {
  const source = normalizedTerm(candidateValue);
  const target = normalizedTerm(expectedTerm);
  const positions = termPositions(source, target);
  if (positions.length === 0) return false;

  const transitions = VALUE_TRANSITION_MARKERS.flatMap((marker) =>
    termPositions(source, normalizedTerm(marker)).map((index) => ({
      index,
      end: index + normalizedTerm(marker).length,
    })),
  );
  if (transitions.length > 0) {
    const latest = transitions.sort(
      (left, right) => right.index - left.index,
    )[0];
    const selectedAfterTransition = positions.some(
      (position) => position >= latest.end,
    );
    if (!selectedAfterTransition) return true;
  }

  for (const marker of VALUE_REMOVAL_MARKERS) {
    const normalizedMarker = normalizedTerm(marker);
    for (const markerPosition of termPositions(
      source,
      normalizedMarker,
    )) {
      const markerEnd = markerPosition + normalizedMarker.length;
      if (
        positions.some(
          (position) => {
            if (
              position < markerEnd ||
              position - markerEnd > 8
            ) {
              return false;
            }
            const laterTransitionSelectsTerm = transitions.some(
              (transition) =>
                transition.index > markerPosition &&
                transition.end <= position,
            );
            return !laterTransitionSelectsTerm;
          },
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export function valueTermMatches(
  candidateValue,
  expectedTerm,
  expectedCanonical = expectedTerm,
  candidateNegated = false,
) {
  const candidate = normalizedTerm(candidateValue);
  const expected = normalizedTerm(expectedTerm);
  if (!candidate || !expected) return false;
  if (
    (candidateNegated === true || negativePolarity(candidateValue)) !==
    negativePolarity(expectedCanonical)
  ) {
    return false;
  }
  if (
    !quantitiesMatch(
      candidateValue,
      expectedTerm,
      expectedCanonical,
    )
  ) {
    return false;
  }
  const canonical = normalizedTerm(expectedCanonical);
  const canonicalDisambiguatesRemoval =
    canonical !== expected &&
    candidate.includes(canonical);
  if (
    expectedTermIsSuperseded(candidateValue, expectedTerm) &&
    !canonicalDisambiguatesRemoval
  ) {
    return false;
  }
  if (singleAsciiIdentifier(expectedTerm)) {
    return identifierTermMatches(candidateValue, expectedTerm);
  }
  if (candidate.includes(expected)) return true;
  return boundedOrderedSubsequence(candidate, expected);
}

function normalizedClaimPart(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('zh-CN');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function cosineSimilarity(left, right) {
  if (!left || !right || left.length !== right.length || left.length === 0) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator > 0
    ? Math.max(0, Math.min(1, dot / denominator))
    : 0;
}

function candidateText(candidate) {
  return structuredAtomicCandidateText({
    subject: String(candidate.subject ?? ''),
    predicate: String(candidate.predicate ?? ''),
    value: String(candidate.value ?? ''),
    negated: candidate.negated === true,
  });
}

function relationPredicateText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s*\[条件:[^\]]+\]\s*$/u, '')
    .trim();
}

function relationPredicateTextFromKey(value) {
  const parts = String(value ?? '').normalize('NFKC').trim().split('::');
  return relationPredicateText(
    parts.length > 1 ? parts.slice(1).join('::') : parts[0] || '',
  );
}

export function relationEmbeddingTexts(fixture) {
  return [
    fixture.candidate.content,
    fixture.target.content,
    relationPredicateText(fixture.candidate.predicate),
    relationPredicateTextFromKey(fixture.target.predicateKey),
  ];
}

export function isAutoCommitEligible(candidate, turnContent) {
  const sourceExcerpt =
    typeof candidate.sourceExcerpt === 'string'
      ? candidate.sourceExcerpt.trim()
      : '';
  return (
    sourceExcerpt.length > 0 &&
    isAtomicCandidateContentSupported({
      subject: String(candidate.subject ?? ''),
      predicate: String(candidate.predicate ?? ''),
      value: String(candidate.value ?? ''),
      content: String(candidate.content ?? ''),
      sourceExcerpt,
      negated: candidate.negated === true,
    }) &&
    alignSourceExcerpt(String(turnContent ?? ''), {
      content: structuredAtomicCandidateText({
        subject: String(candidate.subject ?? ''),
        predicate: String(candidate.predicate ?? ''),
        value: String(candidate.value ?? ''),
        negated: candidate.negated === true,
      }),
      value: String(candidate.value ?? ''),
      sourceExcerpt,
    }) === sourceExcerpt &&
    candidate.sensitivity === 'normal' &&
    candidate.sourceAuthority !== 'assistant_inference' &&
    Number(candidate.confidence) >= 0.95 &&
    Number(candidate.importance) >= 0.5 &&
    !containsCredentialSecret({
      predicate: candidate.predicate,
      value: candidate.value,
      content: candidate.content,
      sourceExcerpt,
      sensitivity: candidate.sensitivity,
    })
  );
}

function template(value, replacement) {
  return value.replaceAll('{{value}}', replacement);
}

function buildClaim({
  id,
  kind,
  subject,
  predicate,
  value,
  content,
  explicitCorrection = false,
  validFrom = null,
  validTo = null,
}) {
  const normalizedKey = [
    normalizedClaimPart(subject),
    normalizedClaimPart(predicate),
  ].join('::');
  const stableKey = [
    'personal',
    'self',
    normalizedKey,
  ].join('::');
  return {
    id,
    userId: 'namespace-quality-evaluator',
    namespace: 'isolated-evaluation',
    kind,
    subject,
    predicate,
    value,
    normalizedKey,
    normalizedHash: sha256(
      `${stableKey}\naffirmed\n${normalizedClaimPart(value)}`,
    ),
    stableKey,
    content,
    confidence: 0.99,
    importance: 0.8,
    sensitivity: 'normal',
    negated: false,
    scopeType: 'personal',
    scopeKey: 'self',
    claimOccurredAt: null,
    claimValidFrom: validFrom,
    claimValidTo: validTo,
    sourceAuthority: 'direct_user',
    explicitCorrection,
  };
}

function buildTarget({
  id,
  kind,
  subject,
  predicate,
  value,
  content,
  validFrom = null,
  validTo = null,
}) {
  const claim = buildClaim({
    id,
    kind,
    subject,
    predicate,
    value,
    content,
    validFrom,
    validTo,
  });
  return {
    id,
    revision: 1,
    status: 'active',
    memoryStatus: 'active',
    itemUpdatedAt: '2026-01-01T00:00:00.000Z',
    memoryUpdatedAt: '2026-01-01T00:00:00.000Z',
    checksum: sha256(content),
    stableKey: claim.stableKey,
    predicateKey: claim.normalizedKey,
    normalizedValueHash: claim.normalizedHash,
    normalizedValue: value,
    observationCount: 1,
    confidence: 0.99,
    importance: 0.8,
    content,
    sensitivity: 'normal',
    sourceAuthority: 'direct_user',
    scopeType: 'personal',
    scopeKey: 'self',
    occurredAt: null,
    validFrom,
    validTo,
  };
}

function expandConflictFixtures(groups) {
  return groups.flatMap((group) =>
    group.cases.map(([predicate, oldValue, newValue], index) => {
      const id = `${group.id}-${String(index + 1).padStart(2, '0')}`;
      return {
        id,
        expectedRelation: group.expectedRelation,
        candidate: buildClaim({
          id: `${id}-candidate`,
          kind: 'preference',
          subject: '用户',
          predicate,
          value: newValue,
          content: group.explicitCorrection
            ? `用户明确纠正：用户的${predicate}现在是${newValue}。`
            : `用户的${predicate}是${newValue}。`,
          explicitCorrection: group.explicitCorrection === true,
          validFrom: group.candidateValidFrom || null,
        }),
        target: buildTarget({
          id: `${id}-target`,
          kind: 'preference',
          subject: '用户',
          predicate,
          value: oldValue,
          content: `用户的${predicate}是${oldValue}。`,
          validFrom: group.targetValidFrom || null,
          validTo: group.targetValidTo || null,
        }),
      };
    }),
  );
}

function expandDuplicateFixtures(groups) {
  return groups.flatMap((group) =>
    group.values.map((value, index) => {
      const id = `${group.id}-${String(index + 1).padStart(2, '0')}`;
      return {
        id,
        candidate: buildClaim({
          id: `${id}-candidate`,
          kind: group.kind,
          subject: group.subject,
          predicate: group.candidatePredicate,
          value,
          content: template(group.candidateTemplate, value),
        }),
        target: buildTarget({
          id: `${id}-target`,
          kind: group.kind,
          subject: group.subject,
          predicate: group.targetPredicate,
          value,
          content: template(group.targetTemplate, value),
        }),
      };
    }),
  );
}

class DeterministicOllamaTracker {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.calls = {
      extractionGeneration: 0,
      relationGeneration: 0,
      embedding: 0,
    };
  }

  fetchFor(label, expectedModel) {
    return async (input, init = {}) => {
      const url = String(input);
      if (!url.startsWith(`${this.baseUrl}/api/`)) {
        throw new Error(`评测器拒绝访问非目标 Ollama 地址：${url}`);
      }
      if (typeof init.body !== 'string') {
        throw new Error(`${label} Ollama 请求缺少 JSON body`);
      }
      const body = JSON.parse(init.body);
      if (body.model !== expectedModel) {
        throw new Error(
          `${label} 模型不正确：期望 ${expectedModel}，实际 ${body.model}`,
        );
      }
      if (url.endsWith('/api/chat')) {
        body.stream = false;
        body.think = false;
        body.keep_alive = KEEP_ALIVE;
        body.options = {
          ...(isRecord(body.options) ? body.options : {}),
          temperature: 0,
          seed: FIXED_SEED,
        };
      } else if (url.endsWith('/api/embed')) {
        body.keep_alive = KEEP_ALIVE;
      } else {
        throw new Error(`评测器只允许 Ollama chat/embed：${url}`);
      }
      if (!(label in this.calls)) {
        throw new Error(`未知 Ollama 调用标签：${label}`);
      }
      this.calls[label] += 1;
      return fetch(input, {
        ...init,
        body: JSON.stringify(body),
      });
    };
  }
}

async function embedToCache(ranker, texts) {
  const unique = [...new Set(texts)];
  const vectors = await ranker.embed(unique);
  if (vectors.length !== unique.length) {
    throw new Error('embedding 缓存回填数量不正确');
  }
  return new Map(unique.map((text, index) => [text, vectors[index]]));
}

function isBetterMatching(candidate, current) {
  if (candidate.length !== current.length) {
    return candidate.length > current.length;
  }
  const candidateTotal = candidate.reduce(
    (sum, entry) => sum + entry.similarity,
    0,
  );
  const currentTotal = current.reduce(
    (sum, entry) => sum + entry.similarity,
    0,
  );
  if (Math.abs(candidateTotal - currentTotal) > 1e-12) {
    return candidateTotal > currentTotal;
  }
  for (let index = 0; index < candidate.length; index += 1) {
    if (
      candidate[index].candidateIndex !==
      current[index].candidateIndex
    ) {
      return (
        candidate[index].candidateIndex <
        current[index].candidateIndex
      );
    }
  }
  return false;
}

function maximumCardinalityMatching(scores, expectedCount) {
  const edgesByExpected = Array.from(
    { length: expectedCount },
    () => [],
  );
  for (const score of scores) {
    edgesByExpected[score.expectedIndex].push(score);
  }
  for (const edges of edgesByExpected) {
    edges.sort(
      (left, right) =>
        right.similarity - left.similarity ||
        left.candidateIndex - right.candidateIndex,
    );
  }
  let best = [];
  const visit = (
    expectedIndex,
    usedCandidates,
    selected,
  ) => {
    if (
      selected.length + expectedCount - expectedIndex <
      best.length
    ) {
      return;
    }
    if (expectedIndex === expectedCount) {
      if (isBetterMatching(selected, best)) {
        best = selected.slice();
      }
      return;
    }
    for (const edge of edgesByExpected[expectedIndex]) {
      if (usedCandidates.has(edge.candidateIndex)) continue;
      usedCandidates.add(edge.candidateIndex);
      selected.push(edge);
      visit(expectedIndex + 1, usedCandidates, selected);
      selected.pop();
      usedCandidates.delete(edge.candidateIndex);
    }
    visit(expectedIndex + 1, usedCandidates, selected);
  };
  visit(0, new Set(), []);
  return best;
}

export function matchExtractionCase(
  fixture,
  candidates,
  vectorCache,
) {
  const scores = [];
  for (
    let expectedIndex = 0;
    expectedIndex < fixture.expected.length;
    expectedIndex += 1
  ) {
    const expected = fixture.expected[expectedIndex];
    const expectedVector = vectorCache.get(expected.canonical);
    for (
      let candidateIndex = 0;
      candidateIndex < candidates.length;
      candidateIndex += 1
    ) {
      const candidate = candidates[candidateIndex];
      if (
        !candidateScopeMatchesExpected(
          fixture,
          expected,
          candidate,
        )
      ) {
        continue;
      }
      const text = candidateText(candidate);
      const termMatched = expected.valueTerms.some((term) =>
        valueTermMatches(
          candidate.value,
          term,
          expected.canonical,
          candidate.negated === true,
        ),
      );
      if (!termMatched) continue;
      const similarity = cosineSimilarity(
        expectedVector,
        vectorCache.get(text),
      );
      if (similarity < EXPECTED_MATCH_THRESHOLD) continue;
      scores.push({
        expectedIndex,
        candidateIndex,
        similarity,
      });
    }
  }
  const matches = maximumCardinalityMatching(
    scores,
    fixture.expected.length,
  );
  const usedExpected = new Set(
    matches.map((match) => match.expectedIndex),
  );
  const usedCandidates = new Set(
    matches.map((match) => match.candidateIndex),
  );
  return { matches, usedExpected, usedCandidates };
}

export function summarizeExtractionQuality({
  positiveFacts,
  matchedExpected,
  trueAutoCommits,
  falseAutoCommits,
  credentialSaves,
}) {
  const autoCommitPredictions =
    trueAutoCommits + falseAutoCommits;
  return {
    autoCommitPredictions,
    extractionPrecision:
      autoCommitPredictions > 0
        ? trueAutoCommits / autoCommitPredictions
        : 0,
    candidateRecall:
      positiveFacts > 0 ? matchedExpected / positiveFacts : 0,
    credentialSaves,
    samples: {
      extractionPrecision: autoCommitPredictions,
      candidateRecall: positiveFacts,
    },
  };
}

function round(value) {
  return Number(value.toFixed(6));
}

function progress(message) {
  process.stderr.write(`[namespace-quality] ${message}\n`);
}

const CREDENTIAL_PIPELINE_PREFLIGHT_SAMPLES = Object.freeze([
  'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature123',
  'sk-proj-abc123XYZ789',
  'token=generic-token-123456',
  'API Key: sk-proj-abc123XYZ789 must-not-log',
]);

export async function runCredentialPipelinePreflight() {
  const database = openDatabase(':memory:');
  try {
    const lifecycle = new LifecycleStore(database);
    const memoryStore = new MemoryStore(database);
    const resolver = new CandidateResolver(
      database,
      lifecycle,
      memoryStore,
      { mode: 'auto' },
    );
    for (
      let index = 0;
      index < CREDENTIAL_PIPELINE_PREFLIGHT_SAMPLES.length;
      index += 1
    ) {
      const secret = CREDENTIAL_PIPELINE_PREFLIGHT_SAMPLES[index];
      const sourceExcerpt = `${secret}。`;
      const turn = lifecycle.recordTurn({
        clientName: 'namespace-quality-safety-preflight',
        sessionExternalId: 'credential-safety-preflight',
        turnExternalId: `credential-safety-preflight-${index}`,
        role: 'user',
        content: sourceExcerpt,
      }).turn;
      const runId = lifecycle.startExtraction(
        turn.id,
        EXTRACTION_MODEL,
        EXTRACTION_PROMPT_VERSION,
      );
      const candidates = lifecycle.completeExtraction(runId, [{
        kind: 'knowledge',
        subject: '用户',
        predicate: `认证材料 ${index}`,
        value: secret,
        content: sourceExcerpt,
        confidence: 0.99,
        importance: 0.9,
        sensitivity: 'normal',
        sourceExcerpt,
        sourceAuthority: 'direct_user',
      }]);
      for (const candidate of candidates) {
        await resolver.resolve(candidate.id);
      }
    }
    const candidateCount = lifecycle.listCandidates({}).length;
    const memoryCount = memoryStore.list().total;
    if (candidateCount !== 0 || memoryCount !== 0) {
      throw new Error(
        '真实凭据 pipeline preflight 失败：' +
        `candidates=${candidateCount}, memories=${memoryCount}`,
      );
    }
    return {
      passed: true,
      samples: CREDENTIAL_PIPELINE_PREFLIGHT_SAMPLES.length,
      candidateCount,
      memoryCount,
    };
  } finally {
    database.close();
  }
}

async function runEvaluation(options, datasetInfo) {
  const { dataset, datasetSha256, counts } = datasetInfo;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  progress('运行真实凭据 LifecycleStore→CandidateResolver 预检');
  const credentialPipelinePreflight =
    await runCredentialPipelinePreflight();
  const tracker = new DeterministicOllamaTracker(options.ollamaUrl);
  const extractor = new OllamaMemoryExtractor({
    baseUrl: options.ollamaUrl,
    model: EXTRACTION_MODEL,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    timeoutMs: options.timeoutMs,
    fetchImpl: tracker.fetchFor(
      'extractionGeneration',
      EXTRACTION_MODEL,
    ),
  });
  const classifier = new OllamaClaimRelationClassifier({
    baseUrl: options.ollamaUrl,
    model: RELATION_MODEL,
    promptVersion: RELATION_PROMPT_VERSION,
    timeoutMs: options.timeoutMs,
    fetchImpl: tracker.fetchFor(
      'relationGeneration',
      RELATION_MODEL,
    ),
  });
  const ranker = new OllamaSemanticRanker({
    baseUrl: options.ollamaUrl,
    embeddingModel: EMBEDDING_MODEL,
    rerankModel: RERANK_MODEL,
    embedBatchSize: 64,
    rerankBatchSize: 16,
    timeoutMs: options.timeoutMs,
    fetchImpl: tracker.fetchFor('embedding', EMBEDDING_MODEL),
  });

  const positiveResults = [];
  progress(
    `开始真实提取：${dataset.extractionCases.length} 回合 / ` +
      `${counts.positiveFacts} 个事实`,
  );
  for (let index = 0; index < dataset.extractionCases.length; index += 1) {
    const fixture = dataset.extractionCases[index];
    const candidates = await extractor.extract({
      id: `quality-positive-turn-${index + 1}`,
      sessionId: 'quality-positive-session',
      userId: 'namespace-quality-evaluator',
      namespace: 'isolated-evaluation',
      externalId: fixture.id,
      role: 'user',
      content: fixture.text,
      occurredAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      metadata: { fixtureId: fixture.id },
    });
    positiveResults.push({ fixture, candidates });
    if ((index + 1) % 5 === 0 || index + 1 === dataset.extractionCases.length) {
      progress(`正例提取 ${index + 1}/${dataset.extractionCases.length}`);
    }
  }

  const negativeResults = [];
  progress(
    `开始真实负例提取：${dataset.negativeCases.length} 回合 / ` +
      `${counts.credentialSamples + counts.discourseNegativeSamples} 个样本`,
  );
  for (let index = 0; index < dataset.negativeCases.length; index += 1) {
    const fixture = dataset.negativeCases[index];
    const candidates = await extractor.extract({
      id: `quality-negative-turn-${index + 1}`,
      sessionId: 'quality-negative-session',
      userId: 'namespace-quality-evaluator',
      namespace: 'isolated-evaluation',
      externalId: fixture.id,
      role: 'user',
      content: fixture.text,
      occurredAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      metadata: {
        fixtureId: fixture.id,
        category: fixture.category,
      },
    });
    negativeResults.push({ fixture, candidates });
    progress(`负例提取 ${index + 1}/${dataset.negativeCases.length}`);
  }

  const conflictFixtures = expandConflictFixtures(
    dataset.conflictGroups,
  );
  const duplicateFixtures = expandDuplicateFixtures(
    dataset.duplicateGroups,
  );
  const embeddingTexts = [];
  for (const result of positiveResults) {
    embeddingTexts.push(
      ...result.fixture.expected.map((expected) => expected.canonical),
      ...result.candidates.map(candidateText),
    );
  }
  for (const fixture of duplicateFixtures) {
    embeddingTexts.push(...relationEmbeddingTexts(fixture));
  }
  progress(
    `使用 ${EMBEDDING_MODEL} 回填 ${new Set(embeddingTexts).size} 条评测向量`,
  );
  const vectorCache = await embedToCache(ranker, embeddingTexts);

  let matchedExpected = 0;
  let trueAutoCommits = 0;
  let falseAutoCommits = 0;
  const missedPositiveIds = [];
  const unmatchedPositiveCandidateIds = [];
  for (const result of positiveResults) {
    const matching = matchExtractionCase(
      result.fixture,
      result.candidates,
      vectorCache,
    );
    matchedExpected += matching.matches.length;
    for (const match of matching.matches) {
      if (
        isAutoCommitEligible(
          result.candidates[match.candidateIndex],
          result.fixture.text,
        )
      ) {
        trueAutoCommits += 1;
      }
    }
    result.fixture.expected.forEach((expected, index) => {
      if (!matching.usedExpected.has(index)) {
        missedPositiveIds.push(expected.id);
      }
    });
    result.candidates.forEach((candidate, index) => {
      if (
        isAutoCommitEligible(candidate, result.fixture.text) &&
        !matching.usedCandidates.has(index)
      ) {
        falseAutoCommits += 1;
        unmatchedPositiveCandidateIds.push(
          `${result.fixture.id}:candidate-${index + 1}`,
        );
      }
    });
  }

  const negativeAutoCommitIds = [];
  const credentialAutoCommitIds = [];
  for (const result of negativeResults) {
    result.candidates.forEach((candidate, index) => {
      if (
        !isAutoCommitEligible(candidate, result.fixture.text)
      ) return;
      const id = `${result.fixture.id}:candidate-${index + 1}`;
      falseAutoCommits += 1;
      negativeAutoCommitIds.push(id);
      if (result.fixture.category === 'credential') {
        credentialAutoCommitIds.push(id);
      }
    });
  }
  const extractionSummary = summarizeExtractionQuality({
    positiveFacts: counts.positiveFacts,
    matchedExpected,
    trueAutoCommits,
    falseAutoCommits,
    credentialSaves: credentialAutoCommitIds.length,
  });
  const {
    autoCommitPredictions,
    extractionPrecision,
    candidateRecall,
    credentialSaves,
  } = extractionSummary;

  const cachedEmbeddingProvider = {
    embeddingModel: EMBEDDING_MODEL,
    async embed(texts) {
      return texts.map((text) => {
        const vector = vectorCache.get(text);
        if (!vector) {
          throw new Error(
            `评测 embedding 缓存缺失：${sha256(text).slice(0, 12)}`,
          );
        }
        return vector;
      });
    },
  };
  const relationEngine = new ClaimRelationEngine({
    classifier,
    embeddingProvider: cachedEmbeddingProvider,
    embeddingNearThreshold: EMBEDDING_NEAR_THRESHOLD,
  });

  progress(`开始冲突评测：${conflictFixtures.length} 个样本`);
  const conflictFailures = [];
  for (let index = 0; index < conflictFixtures.length; index += 1) {
    const fixture = conflictFixtures[index];
    const assessment = await relationEngine.assess(fixture.candidate, {
      cardinality: 'single',
      predicateTargets: [fixture.target],
      semanticTargets: [fixture.target],
    });
    if (assessment.relation !== fixture.expectedRelation) {
      conflictFailures.push({
        id: fixture.id,
        expected: fixture.expectedRelation,
        actual: assessment.relation,
        method: assessment.method,
      });
    }
    if ((index + 1) % 10 === 0 || index + 1 === conflictFixtures.length) {
      progress(`冲突评测 ${index + 1}/${conflictFixtures.length}`);
    }
  }
  const conflictAccuracy =
    (conflictFixtures.length - conflictFailures.length) /
    conflictFixtures.length;

  progress(`开始语义去重评测：${duplicateFixtures.length} 个样本`);
  const duplicateFailures = [];
  const duplicateMethods = {};
  for (let index = 0; index < duplicateFixtures.length; index += 1) {
    const fixture = duplicateFixtures[index];
    const assessment = await relationEngine.assess(fixture.candidate, {
      cardinality: 'single',
      predicateTargets: [],
      semanticTargets: [fixture.target],
    });
    duplicateMethods[assessment.method] =
      (duplicateMethods[assessment.method] || 0) + 1;
    if (!['equivalent', 'reinforces'].includes(assessment.relation)) {
      duplicateFailures.push({
        id: fixture.id,
        actual: assessment.relation,
        method: assessment.method,
      });
    }
    if ((index + 1) % 10 === 0 || index + 1 === duplicateFixtures.length) {
      progress(`语义去重 ${index + 1}/${duplicateFixtures.length}`);
    }
  }
  const semanticDuplicateRate =
    duplicateFailures.length / duplicateFixtures.length;

  const rawMetrics = {
    extractionPrecision,
    candidateRecall,
    credentialSaves,
    conflictAccuracy,
    semanticDuplicateRate,
  };
  const samples = {
    ...extractionSummary.samples,
    credentialSafety: counts.credentialSamples,
    conflictResolution: counts.conflictSamples,
    semanticDuplicate: counts.semanticDuplicateSamples,
  };
  const gateResults = {
    extractionPrecision:
      extractionPrecision >= THRESHOLDS.extractionPrecision &&
      samples.extractionPrecision >=
        THRESHOLDS.minExtractionPrecisionSamples,
    candidateRecall:
      candidateRecall >= THRESHOLDS.candidateRecall &&
      samples.candidateRecall >=
        THRESHOLDS.minCandidateRecallSamples,
    credentialSafety:
      credentialSaves <= THRESHOLDS.credentialSaves &&
      samples.credentialSafety >= THRESHOLDS.minCredentialSamples,
    conflictAccuracy:
      conflictAccuracy >= THRESHOLDS.conflictAccuracy &&
      samples.conflictResolution >= THRESHOLDS.minConflictSamples,
    semanticDuplicateRate:
      semanticDuplicateRate < THRESHOLDS.semanticDuplicateRate &&
      samples.semanticDuplicate >=
        THRESHOLDS.minSemanticDuplicateSamples,
  };
  const failedMetrics = Object.entries(gateResults)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const completedAt = new Date().toISOString();
  return {
    passed: failedMetrics.length === 0,
    dryRun: !options.record,
    recorded: null,
    dataset: {
      id: dataset.datasetId,
      schemaVersion: dataset.schemaVersion,
      sha256: datasetSha256,
      fixturePath: FIXTURE_PATH,
    },
    evaluatorVersion: EVALUATOR_VERSION,
    models: {
      extraction: EXTRACTION_MODEL,
      relation: RELATION_MODEL,
      rerank: RERANK_MODEL,
      embedding: EMBEDDING_MODEL,
      extractorImplementation:
        MEMORY_EXTRACTOR_IMPLEMENTATION_CONTRACT,
      qualityPipelineImplementation:
        QUALITY_PIPELINE_IMPLEMENTATION_SHA256,
    },
    prompts: {
      extraction: EXTRACTION_PROMPT_VERSION,
      relation: RELATION_PROMPT_VERSION,
    },
    deterministicRuntime: {
      keepAlive: KEEP_ALIVE,
      temperature: 0,
      seed: FIXED_SEED,
      expectedMatchThreshold: EXPECTED_MATCH_THRESHOLD,
      embeddingNearThreshold: EMBEDDING_NEAR_THRESHOLD,
    },
    safetyPreflight: {
      credentialPipeline: credentialPipelinePreflight,
    },
    thresholds: THRESHOLDS,
    metrics: {
      extractionPrecision: round(extractionPrecision),
      candidateRecall: round(candidateRecall),
      credentialSaves,
      conflictAccuracy: round(conflictAccuracy),
      semanticDuplicateRate: round(semanticDuplicateRate),
    },
    rawMetrics,
    samples,
    counts: {
      ...counts,
      extractedPositiveCandidates: positiveResults.reduce(
        (sum, result) => sum + result.candidates.length,
        0,
      ),
      extractedNegativeCandidates: negativeResults.reduce(
        (sum, result) => sum + result.candidates.length,
        0,
      ),
      matchedExpected,
      trueAutoCommits,
      falseAutoCommits,
      autoCommitPredictions,
      duplicateMethods,
    },
    gateResults,
    failedMetrics,
    failures: {
      missedPositiveIds,
      unmatchedPositiveCandidateIds,
      negativeAutoCommitIds,
      credentialAutoCommitIds,
      conflict: conflictFailures,
      semanticDuplicate: duplicateFailures,
    },
    ollama: {
      baseUrl: options.ollamaUrl,
      calls: tracker.calls,
      generationActuallyInvoked:
        tracker.calls.extractionGeneration > 0 &&
        tracker.calls.relationGeneration > 0,
      embeddingActuallyInvoked: tracker.calls.embedding > 0,
    },
    timing: {
      startedAt,
      completedAt,
      durationMs: Date.now() - startedMs,
    },
  };
}

export function assertSafeRecordingTarget(
  databasePath,
  allowDefaultDatabase = false,
  formalDatabasePath = DEFAULT_FORMAL_DATABASE_PATH,
) {
  if (databasePath === ':memory:') {
    throw new Error('--record 必须写入持久化的隔离数据库文件');
  }
  const resolved = path.resolve(databasePath);
  const formal = path.resolve(formalDatabasePath);
  const aliasesFormalDatabase = pathsReferenceSameFile(
    resolved,
    formal,
  );
  if (aliasesFormalDatabase && !allowDefaultDatabase) {
    throw new Error(
      '拒绝把质量评测快照写入默认正式数据库；' +
      '如已确认只写质量元数据，请显式添加 --allow-default-database',
    );
  }
  if (allowDefaultDatabase && resolved !== formal) {
    throw new Error(
      '--allow-default-database 只用于精确的默认正式数据库路径',
    );
  }
  return resolved;
}

function pathsReferenceSameFile(leftPath, rightPath) {
  if (leftPath === rightPath) return true;
  if (
    ['darwin', 'win32'].includes(process.platform) &&
    leftPath.normalize('NFKC').toLocaleLowerCase('en-US') ===
      rightPath.normalize('NFKC').toLocaleLowerCase('en-US')
  ) {
    return true;
  }
  if (!fs.existsSync(leftPath) || !fs.existsSync(rightPath)) {
    return false;
  }
  const leftRealPath = fs.realpathSync.native(leftPath);
  const rightRealPath = fs.realpathSync.native(rightPath);
  if (leftRealPath === rightRealPath) return true;
  const left = fs.statSync(leftPath);
  const right = fs.statSync(rightPath);
  return left.dev === right.dev && left.ino === right.ino;
}

export function assertRecordingSchemaReady(
  databasePath,
  requireExisting = false,
) {
  const resolved = path.resolve(databasePath);
  if (!fs.existsSync(resolved)) {
    if (requireExisting) {
      throw new Error(
        '默认正式数据库不存在；质量评测器拒绝创建或迁移正式库',
      );
    }
    return;
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error('质量快照数据库路径必须是普通文件');
  }
  if (stat.size === 0) {
    if (requireExisting) {
      throw new Error(
        '默认正式数据库为空；质量评测器拒绝初始化正式库',
      );
    }
    return;
  }
  const database = new DatabaseSync(resolved, { readOnly: true });
  try {
    const observedVersion = Number(
      database
        .prepare('PRAGMA user_version')
        .get()?.user_version || 0,
    );
    if (observedVersion !== SCHEMA_VERSION) {
      throw new Error(
        `数据库 schema 版本为 ${observedVersion}，` +
        `质量写入要求 ${SCHEMA_VERSION}；拒绝由评测器迁移`,
      );
    }
  } finally {
    database.close();
  }
}

const QUALITY_METADATA_TABLES = new Set([
  'audit_log',
  'namespace_quality_snapshots',
  'namespace_rollout_state',
]);

const QUALITY_DML_ACTIONS = new Set([
  sqliteConstants.SQLITE_INSERT,
  sqliteConstants.SQLITE_UPDATE,
  sqliteConstants.SQLITE_DELETE,
]);

const SCHEMA_WRITE_ACTIONS = new Set(
  [
    sqliteConstants.SQLITE_CREATE_INDEX,
    sqliteConstants.SQLITE_CREATE_TABLE,
    sqliteConstants.SQLITE_CREATE_TEMP_INDEX,
    sqliteConstants.SQLITE_CREATE_TEMP_TABLE,
    sqliteConstants.SQLITE_CREATE_TEMP_TRIGGER,
    sqliteConstants.SQLITE_CREATE_TEMP_VIEW,
    sqliteConstants.SQLITE_CREATE_TRIGGER,
    sqliteConstants.SQLITE_CREATE_VIEW,
    sqliteConstants.SQLITE_CREATE_VTABLE,
    sqliteConstants.SQLITE_DROP_INDEX,
    sqliteConstants.SQLITE_DROP_TABLE,
    sqliteConstants.SQLITE_DROP_TEMP_INDEX,
    sqliteConstants.SQLITE_DROP_TEMP_TABLE,
    sqliteConstants.SQLITE_DROP_TEMP_TRIGGER,
    sqliteConstants.SQLITE_DROP_TEMP_VIEW,
    sqliteConstants.SQLITE_DROP_TRIGGER,
    sqliteConstants.SQLITE_DROP_VIEW,
    sqliteConstants.SQLITE_DROP_VTABLE,
    sqliteConstants.SQLITE_ALTER_TABLE,
    sqliteConstants.SQLITE_ATTACH,
    sqliteConstants.SQLITE_DETACH,
    sqliteConstants.SQLITE_REINDEX,
    sqliteConstants.SQLITE_ANALYZE,
  ].filter(Number.isInteger),
);

function installQualityOnlyAuthorizer(database) {
  database.setAuthorizer((actionCode, first, second) => {
    if (
      QUALITY_DML_ACTIONS.has(actionCode) &&
      !QUALITY_METADATA_TABLES.has(String(first))
    ) {
      return sqliteConstants.SQLITE_DENY;
    }
    if (SCHEMA_WRITE_ACTIONS.has(actionCode)) {
      return sqliteConstants.SQLITE_DENY;
    }
    if (
      actionCode === sqliteConstants.SQLITE_PRAGMA &&
      second !== null
    ) {
      return sqliteConstants.SQLITE_DENY;
    }
    return sqliteConstants.SQLITE_OK;
  });
}

function nonQualityRowCounts(database) {
  const tableNames = database
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name ASC`,
    )
    .all()
    .map((row) => String(row.name))
    .filter((name) => !QUALITY_METADATA_TABLES.has(name));
  return Object.fromEntries(tableNames.map((name) => {
    const identifier = `"${name.replaceAll('"', '""')}"`;
    const row = database
      .prepare(`SELECT COUNT(*) AS count FROM ${identifier}`)
      .get();
    return [name, Number(row?.count || 0)];
  }));
}

function changedRowCounts(before, after) {
  const names = new Set([
    ...Object.keys(before),
    ...Object.keys(after),
  ]);
  return [...names]
    .filter((name) => before[name] !== after[name])
    .sort()
    .map((name) => ({
      table: name,
      before: before[name] ?? null,
      after: after[name] ?? null,
  }));
}

function snapshotInputFromReport(report, options) {
  return {
    userId: options.user,
    namespace: options.namespace,
    metrics: report.rawMetrics,
    samples: report.samples,
    modelVersions: report.models,
    promptVersions: report.prompts,
    evaluatorVersion: report.evaluatorVersion,
    datasetId: report.dataset.id,
    datasetSha256: report.dataset.sha256,
    evaluatedAt: report.timing.completedAt,
  };
}

function assertReportExtractionAccounting(report) {
  const counts = report.counts;
  if (!isRecord(counts)) {
    throw new Error('评测报告缺少真实提取计数');
  }
  const summary = summarizeExtractionQuality({
    positiveFacts: Number(counts.positiveFacts),
    matchedExpected: Number(counts.matchedExpected),
    trueAutoCommits: Number(counts.trueAutoCommits),
    falseAutoCommits: Number(counts.falseAutoCommits),
    credentialSaves: Number(report.rawMetrics?.credentialSaves),
  });
  if (
    !Number.isFinite(summary.extractionPrecision) ||
    !Number.isFinite(summary.candidateRecall) ||
    Math.abs(
      summary.extractionPrecision -
      Number(report.rawMetrics?.extractionPrecision),
    ) > 1e-12 ||
    Math.abs(
      summary.candidateRecall -
      Number(report.rawMetrics?.candidateRecall),
    ) > 1e-12 ||
    summary.samples.extractionPrecision !==
      report.samples?.extractionPrecision ||
    summary.samples.candidateRecall !==
      report.samples?.candidateRecall ||
    summary.autoCommitPredictions !==
      Number(counts.autoCommitPredictions)
  ) {
    throw new Error('评测报告的 precision/recall 样本账目不一致');
  }
}

function validateReportBeforePersistence(report, options) {
  if (typeof report.passed !== 'boolean') {
    throw new Error('评测报告缺少布尔 passed 状态');
  }
  if (
    report.dataset?.id !== NAMESPACE_QUALITY_DATASET_ID ||
    report.dataset?.sha256 !== EXPECTED_FIXTURE_SHA256 ||
    report.evaluatorVersion !== EVALUATOR_VERSION
  ) {
    throw new Error('评测报告的数据集或 evaluator 版本不受信任');
  }
  const expectedModels = {
    extraction: EXTRACTION_MODEL,
    relation: RELATION_MODEL,
    rerank: RERANK_MODEL,
    embedding: EMBEDDING_MODEL,
    extractorImplementation:
      MEMORY_EXTRACTOR_IMPLEMENTATION_CONTRACT,
    qualityPipelineImplementation:
      NAMESPACE_QUALITY_PIPELINE_IMPLEMENTATION_SHA256,
  };
  const expectedPrompts = {
    extraction: EXTRACTION_PROMPT_VERSION,
    relation: RELATION_PROMPT_VERSION,
  };
  for (const [role, version] of Object.entries(expectedModels)) {
    if (report.models?.[role] !== version) {
      throw new Error(`评测报告的 ${role} 模型版本不受信任`);
    }
  }
  for (const [role, version] of Object.entries(expectedPrompts)) {
    if (report.prompts?.[role] !== version) {
      throw new Error(`评测报告的 ${role} 提示版本不受信任`);
    }
  }
  assertReportExtractionAccounting(report);
  const input = snapshotInputFromReport(report, options);
  const validationDatabase = openDatabase(':memory:');
  try {
    const quality = new NamespaceQualityService(validationDatabase);
    const snapshot = quality.recordSnapshot(input);
    if (snapshot.passed !== report.passed) {
      throw new Error(
        'NamespaceQualityService 的门禁结果与评测报告不一致',
      );
    }
    const rollout = quality.effectiveAutomationMode(
      options.user,
      options.namespace,
      'auto',
    );
    const expectedMode = report.passed ? 'auto' : 'shadow';
    const expectedState = report.passed ? 'passed' : 'failed';
    if (
      rollout.mode !== expectedMode ||
      rollout.qualityState !== expectedState
    ) {
      throw new Error(
        '评测报告与当前运行时版本或 rollout 门禁不一致',
      );
    }
  } finally {
    validationDatabase.close();
  }
  return input;
}

export function recordNamespaceSnapshot(
  report,
  options,
  testOptions = {},
) {
  const databasePath = assertSafeRecordingTarget(
    options.database,
    options.allowDefaultDatabase === true,
    testOptions.formalDatabasePath,
  );
  const snapshotInput = validateReportBeforePersistence(
    report,
    options,
  );
  assertRecordingSchemaReady(
    databasePath,
    options.allowDefaultDatabase === true,
  );
  const database = openDatabase(databasePath);
  try {
    const beforeRows = nonQualityRowCounts(database);
    installQualityOnlyAuthorizer(database);
    const quality = new NamespaceQualityService(database);
    const snapshot = quality.recordSnapshot(snapshotInput);
    if (snapshot.passed !== report.passed) {
      throw new Error(
        'NamespaceQualityService 的门禁结果与评测报告不一致',
      );
    }
    const persisted = quality.latestSnapshot(
      options.user,
      options.namespace,
    );
    if (
      !persisted ||
      persisted.id !== snapshot.id ||
      persisted.passed !== report.passed
    ) {
      throw new Error('质量快照写后复读失败');
    }
    const rollout = quality.effectiveAutomationMode(
      options.user,
      options.namespace,
      'auto',
    );
    const expectedMode = report.passed ? 'auto' : 'shadow';
    const expectedState = report.passed ? 'passed' : 'failed';
    if (
      rollout.mode !== expectedMode ||
      rollout.qualityState !== expectedState ||
      rollout.snapshotId !== snapshot.id
    ) {
      throw new Error(
        `质量 rollout 写后状态错误：${rollout.mode}/${rollout.qualityState}`,
      );
    }
    const afterRows = nonQualityRowCounts(database);
    const changedBusinessRows = changedRowCounts(
      beforeRows,
      afterRows,
    );
    if (changedBusinessRows.length > 0) {
      throw new Error(
        `质量评测意外修改了业务表：${JSON.stringify(changedBusinessRows)}`,
      );
    }
    return {
      database: databasePath,
      user: snapshot.userId,
      namespace: snapshot.namespace,
      snapshotId: snapshot.id,
      snapshotPassed: snapshot.passed,
      rolloutMode: rollout.mode,
      qualityState: rollout.qualityState,
      failedMetrics: snapshot.failedMetrics,
      businessRowsUnchanged: true,
      defaultDatabaseExplicitlyAllowed:
        options.allowDefaultDatabase === true,
    };
  } finally {
    database.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.record) {
    assertSafeRecordingTarget(
      options.database,
      options.allowDefaultDatabase,
    );
  }
  const datasetInfo = readDataset();
  if (options.validateFixture) {
    console.log(JSON.stringify({
      passed: true,
      validationOnly: true,
      datasetId: datasetInfo.dataset.datasetId,
      datasetSha256: datasetInfo.datasetSha256,
      counts: datasetInfo.counts,
      ollamaInvoked: false,
    }, null, 2));
    return;
  }
  const report = await runEvaluation(options, datasetInfo);
  if (options.record) {
    report.recorded = recordNamespaceSnapshot(report, options);
    report.dryRun = false;
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

const THIS_SCRIPT = path.resolve(fileURLToPath(import.meta.url));
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === THIS_SCRIPT
) {
  main().catch((error) => {
    console.error(JSON.stringify({
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      ollamaQualityPassed: false,
    }, null, 2));
    process.exitCode = 1;
  });
}
