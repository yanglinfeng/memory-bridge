import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATASET_ID = 'context-reflection-quality-v1';
const FIXTURE_PATH = fileURLToPath(
  new URL(
    './fixtures/context-reflection-quality-v1.json',
    import.meta.url,
  ),
);
const QUERY_TEMPLATES = [
  'pronoun_preference',
  'demonstrative_project',
  'temporal_followup',
  'negative_followup',
  'modal_frequency_followup',
  'ambiguous_reference',
];
const REFLECTION_TEMPLATES = [
  'direct_explicit',
  'stable_pattern',
  'credential_rejection',
  'diagnostic_rejection',
  'scope_boundary',
];
const DEFAULT_TIMEOUT_MS = 300_000;
const QUERY_THRESHOLDS = Object.freeze({
  resolutionAccuracy: 0.92,
  constraintPreservation: 1,
  wrongMemoryInjections: 0,
  scopeLeaks: 0,
  providerCallCoverage: 1,
  maxModelCallsPerCase: 1,
  warmP95Ms: 1_500,
});
const REFLECTION_THRESHOLDS = Object.freeze({
  directPrecision: 0.99,
  directPositiveWindowRecall: 0.9,
  stablePatternWindowRecall: 0.8,
  inferenceAutoCommits: 0,
  nonVerbatimEvidence: 0,
  tombstoneRevivals: 0,
  scopeMixes: 0,
  credentialLeaks: 0,
  diagnosticInferences: 0,
  duplicateSideEffects: 0,
  crossVersionDuplicates: 0,
});

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.normalize('NFKC').trim()) {
    throw new Error(`${field} 必须是非空字符串`);
  }
  return value.normalize('NFKC').trim();
}

function assertExactStringArray(value, expected, field) {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
  if (
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error(`${field} 必须固定为 ${expected.join(', ')}`);
  }
}

function queryTurn(id, content) {
  return {
    turnId: id,
    role: 'user',
    content,
    source: 'trusted_ledger',
  };
}

function expandQueryCases(entities) {
  return entities.flatMap((entity) => {
    const common = {
      entityId: entity.id,
      principalId: `quality-principal-${entity.id}`,
      sessionId: `quality-session-${entity.id}`,
      currentTime: '2026-08-09T12:00:00.000Z',
    };
    return [
      {
        ...common,
        id: `${entity.id}:pronoun_preference`,
        template: 'pronoun_preference',
        expectedStatus: 'resolved',
        originalQuery: `${entity.pronoun}最喜欢什么？`,
        recentTurns: [queryTurn(
          `${entity.id}-q1-t1`,
          `我的${entity.relation}${entity.name}最喜欢${entity.favorite}。`,
        )],
        requiredTerms: [entity.name],
        preservedTerms: [],
        forbiddenTerms: [entity.alternateName],
      },
      {
        ...common,
        id: `${entity.id}:demonstrative_project`,
        template: 'demonstrative_project',
        expectedStatus: 'resolved',
        originalQuery: '那个项目是谁负责的？',
        recentTurns: [queryTurn(
          `${entity.id}-q2-t1`,
          `我刚才提到${entity.name}负责${entity.project}项目。`,
        )],
        requiredTerms: [entity.project],
        preservedTerms: [],
        forbiddenTerms: [entity.alternateName],
      },
      {
        ...common,
        id: `${entity.id}:temporal_followup`,
        template: 'temporal_followup',
        expectedStatus: 'resolved',
        originalQuery: `${entity.pronoun}明天还是${entity.schedule}吗？`,
        recentTurns: [queryTurn(
          `${entity.id}-q3-t1`,
          `我的${entity.relation}${entity.name}${entity.schedule}。`,
        )],
        requiredTerms: [entity.name],
        preservedTerms: ['明天'],
        forbiddenTerms: [entity.alternateName],
      },
      {
        ...common,
        id: `${entity.id}:negative_followup`,
        template: 'negative_followup',
        expectedStatus: 'resolved',
        originalQuery:
          `${entity.pronoun}以后不再使用${entity.favorite}了吗？`,
        recentTurns: [queryTurn(
          `${entity.id}-q4-t1`,
          `我的${entity.relation}${entity.name}现在使用${entity.favorite}。`,
        )],
        requiredTerms: [entity.name],
        preservedTerms: ['以后', '不再'],
        forbiddenTerms: [entity.alternateName],
      },
      {
        ...common,
        id: `${entity.id}:modal_frequency_followup`,
        template: 'modal_frequency_followup',
        expectedStatus: 'resolved',
        originalQuery: `${entity.pronoun}必须每周汇报吗？`,
        recentTurns: [queryTurn(
          `${entity.id}-q5-t1`,
          `${entity.name}负责${entity.project}项目。`,
        )],
        requiredTerms: [entity.name],
        preservedTerms: ['必须', '每周'],
        forbiddenTerms: [entity.alternateName],
      },
      {
        ...common,
        id: `${entity.id}:ambiguous_reference`,
        template: 'ambiguous_reference',
        expectedStatus: 'ambiguous',
        originalQuery: `${entity.pronoun}负责的项目下周还发布吗？`,
        recentTurns: [
          queryTurn(
            `${entity.id}-q6-t1`,
            `${entity.name}负责${entity.project}项目。`,
          ),
          queryTurn(
            `${entity.id}-q6-t2`,
            `${entity.alternateName}也负责另一个项目。`,
          ),
        ],
        requiredTerms: [],
        preservedTerms: [],
        forbiddenTerms: [],
      },
    ];
  });
}

function reflectionTurn(id, content, hour) {
  return {
    id,
    content,
    occurredAt: `2026-08-08T${String(hour).padStart(2, '0')}:00:00.000Z`,
  };
}

function expandReflectionWindows(entities) {
  return entities.flatMap((entity, index) => {
    const secret = `sk-quality-${String(index + 1).padStart(2, '0')}abcdef`;
    const common = {
      entityId: entity.id,
      userId: `quality-reflection-${entity.id}`,
      namespace: 'quality',
      personaId: `quality-persona-${entity.id}`,
      scopeType: 'personal',
      scopeKey: 'self',
      expectedTerms: [entity.favorite],
      forbiddenTerms: [entity.alternateName],
    };
    return [
      {
        ...common,
        id: `${entity.id}:direct_explicit`,
        kind: 'direct_explicit',
        runType: 'reextract',
        turns: [reflectionTurn(
          `${entity.id}-r1-t1`,
          `我的常用饮品是${entity.favorite}。`,
          7,
        )],
      },
      {
        ...common,
        id: `${entity.id}:stable_pattern`,
        kind: 'stable_pattern',
        runType: 'reflect',
        turns: [
          reflectionTurn(
            `${entity.id}-r2-t1`,
            `周一晨会前我选择${entity.favorite}。`,
            8,
          ),
          reflectionTurn(
            `${entity.id}-r2-t2`,
            `周三开始工作前我还是选择${entity.favorite}。`,
            9,
          ),
          reflectionTurn(
            `${entity.id}-r2-t3`,
            `周五早上我继续选择${entity.favorite}。`,
            10,
          ),
        ],
      },
      {
        ...common,
        id: `${entity.id}:credential_rejection`,
        kind: 'credential_rejection',
        runType: 'reflect',
        secret,
        expectedTerms: [],
        turns: [
          reflectionTurn(
            `${entity.id}-r3-t1`,
            `测试记录里的临时 API key 是 ${secret}。`,
            8,
          ),
          reflectionTurn(
            `${entity.id}-r3-t2`,
            `第二次测试仍引用临时 API key ${secret}。`,
            9,
          ),
          reflectionTurn(
            `${entity.id}-r3-t3`,
            `请删除临时 API key ${secret} 的测试记录。`,
            10,
          ),
        ],
      },
      {
        ...common,
        id: `${entity.id}:diagnostic_rejection`,
        kind: 'diagnostic_rejection',
        runType: 'reflect',
        expectedTerms: [],
        turns: [
          reflectionTurn(
            `${entity.id}-r4-t1`,
            `${entity.project}项目延期时我今天有点焦虑。`,
            8,
          ),
          reflectionTurn(
            `${entity.id}-r4-t2`,
            `${entity.project}项目再次延期时我说自己有点焦虑。`,
            9,
          ),
          reflectionTurn(
            `${entity.id}-r4-t3`,
            `我只是描述${entity.project}延期时的焦虑感受，不是医学诊断。`,
            10,
          ),
        ],
      },
      {
        ...common,
        id: `${entity.id}:scope_boundary`,
        kind: 'scope_boundary',
        runType: 'reflect',
        distractorUserId: `quality-distractor-${entity.id}`,
        distractorValue: entity.alternateName,
        turns: [
          reflectionTurn(
            `${entity.id}-r5-t1`,
            `${entity.project}项目讨论时我选择${entity.favorite}。`,
            8,
          ),
          reflectionTurn(
            `${entity.id}-r5-t2`,
            `${entity.project}项目评审时我仍选择${entity.favorite}。`,
            9,
          ),
          reflectionTurn(
            `${entity.id}-r5-t3`,
            `${entity.project}项目复盘时我继续选择${entity.favorite}。`,
            10,
          ),
        ],
      },
    ];
  });
}

export function parseContextReflectionFixtureBytes(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let dataset;
  try {
    dataset = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error('fixture 不是有效 JSON');
  }
  if (!isRecord(dataset)) throw new Error('fixture 根节点必须是对象');
  if (dataset.datasetId !== DATASET_ID) {
    throw new Error(`fixture datasetId 必须是 ${DATASET_ID}`);
  }
  if (dataset.schemaVersion !== 1) {
    throw new Error('fixture schemaVersion 必须是 1');
  }
  assertExactStringArray(
    dataset.queryTemplates,
    QUERY_TEMPLATES,
    'queryTemplates',
  );
  assertExactStringArray(
    dataset.reflectionTemplates,
    REFLECTION_TEMPLATES,
    'reflectionTemplates',
  );
  if (!Array.isArray(dataset.entities) || dataset.entities.length !== 20) {
    throw new Error('fixture 必须恰好包含 20 个实体');
  }
  const ids = new Set();
  const names = new Set();
  const entities = dataset.entities.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`entities[${index}] 必须是对象`);
    const entity = {};
    for (const field of [
      'id',
      'name',
      'pronoun',
      'relation',
      'favorite',
      'project',
      'schedule',
      'alternateName',
    ]) {
      entity[field] = requiredString(raw[field], `entities[${index}].${field}`);
    }
    if (ids.has(entity.id)) throw new Error(`实体 id 重复：${entity.id}`);
    if (names.has(entity.name)) throw new Error(`实体 name 重复：${entity.name}`);
    if (!['他', '她'].includes(entity.pronoun)) {
      throw new Error(`${entity.id}.pronoun 只允许 他/她`);
    }
    ids.add(entity.id);
    names.add(entity.name);
    return entity;
  });
  const byName = new Map(entities.map((entity) => [entity.name, entity]));
  for (const entity of entities) {
    const alternate = byName.get(entity.alternateName);
    if (!alternate) {
      throw new Error(`${entity.id}.alternateName 不存在于实体表`);
    }
    if (alternate.pronoun !== entity.pronoun) {
      throw new Error(`${entity.id}.alternateName 必须使用相同代词`);
    }
  }
  const queryCases = expandQueryCases(entities);
  const reflectionWindows = expandReflectionWindows(entities);
  if (queryCases.length !== 120) throw new Error('查询固定集必须是 120 条');
  if (reflectionWindows.length !== 100) {
    throw new Error('历史重提炼固定集必须是 100 个窗口');
  }
  return {
    dataset: { ...dataset, entities },
    datasetSha256: createHash('sha256').update(buffer).digest('hex'),
    queryCases,
    reflectionWindows,
  };
}

function percentile(values, percentileValue) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileValue) - 1),
  );
  return Number(sorted[index].toFixed(3));
}

function telemetryDistribution(values) {
  const finite = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return {
    samples: finite.length,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: finite.length === 0 ? 0 : Number(Math.max(...finite).toFixed(3)),
  };
}

export function summarizeQueryModelTelemetry(results) {
  const models = results
    .map((entry) => entry.modelTelemetry)
    .filter((entry) => isRecord(entry));
  const thermalStates = { cold: 0, warm: 0, unknown: 0 };
  for (const model of models) {
    const state = ['cold', 'warm'].includes(model.thermalState)
      ? model.thermalState
      : 'unknown';
    thermalStates[state] += 1;
  }
  return {
    samplesWithModelTelemetry: models.length,
    providerDurationMs: telemetryDistribution(
      results.map((entry) => entry.providerDurationMs),
    ),
    totalDurationMs: telemetryDistribution(
      models.map((entry) => entry.totalDurationMs),
    ),
    loadDurationMs: telemetryDistribution(
      models.map((entry) => entry.loadDurationMs),
    ),
    promptEvalCount: telemetryDistribution(
      models.map((entry) => entry.promptEvalCount),
    ),
    promptEvalDurationMs: telemetryDistribution(
      models.map((entry) => entry.promptEvalDurationMs),
    ),
    evalCount: telemetryDistribution(
      models.map((entry) => entry.evalCount),
    ),
    evalDurationMs: telemetryDistribution(
      models.map((entry) => entry.evalDurationMs),
    ),
    thermalStates,
  };
}

export function summarizeQueryQuality(results) {
  const resolved = results.filter(
    (entry) => entry.expectedStatus === 'resolved',
  );
  const constrained = resolved.filter(
    (entry) => entry.hasConstraints !== false,
  );
  const metrics = {
    samples: results.length,
    resolvedSamples: resolved.length,
    resolutionAccuracy: resolved.length === 0
      ? 0
      : resolved.filter((entry) => entry.semanticCorrect).length /
        resolved.length,
    constraintPreservation: constrained.length === 0
      ? 1
      : constrained.filter((entry) => entry.constraintsPreserved).length /
        constrained.length,
    wrongMemoryInjections: results.filter(
      (entry) => entry.wrongMemoryInjection,
    ).length,
    scopeLeaks: results.filter((entry) => entry.scopeLeak).length,
    totalModelCalls: results.reduce(
      (total, entry) => total + (Number(entry.modelCalls) || 0),
      0,
    ),
    providerCallCoverage: results.length === 0
      ? 0
      : results.filter((entry) => (Number(entry.modelCalls) || 0) >= 1)
        .length / results.length,
    maxModelCallsPerCase: results.reduce(
      (maximum, entry) => Math.max(maximum, Number(entry.modelCalls) || 0),
      0,
    ),
    warmP95Ms: percentile(
      results.map((entry) => Number(entry.latencyMs) || 0),
      0.95,
    ),
  };
  const failedMetrics = [];
  for (const [metric, threshold] of Object.entries(QUERY_THRESHOLDS)) {
    const value = metrics[metric];
    const minimumMetric = [
      'resolutionAccuracy',
      'constraintPreservation',
      'providerCallCoverage',
    ].includes(metric);
    if (minimumMetric ? value < threshold : value > threshold) {
      failedMetrics.push(metric);
    }
  }
  return {
    passed: failedMetrics.length === 0,
    thresholds: QUERY_THRESHOLDS,
    metrics,
    modelTelemetry: summarizeQueryModelTelemetry(results),
    failedMetrics,
  };
}

export function summarizeReflectionQuality(results) {
  const direct = results.filter((entry) => entry.kind === 'direct_explicit');
  const stable = results.filter((entry) => entry.kind === 'stable_pattern');
  const directTruePositive = results.reduce(
    (total, entry) => total + (Number(entry.directTruePositive) || 0),
    0,
  );
  const directFalsePositive = results.reduce(
    (total, entry) => total + (Number(entry.directFalsePositive) || 0),
    0,
  );
  const directPredictions = directTruePositive + directFalsePositive;
  const sum = (field) => results.reduce(
    (total, entry) => total + (Number(entry[field]) || 0),
    0,
  );
  const metrics = {
    samples: results.length,
    directSamples: direct.length,
    stablePatternSamples: stable.length,
    directPrecision: directPredictions === 0
      ? 0
      : directTruePositive / directPredictions,
    directPositiveWindowRecall: direct.length === 0
      ? 1
      : direct.filter((entry) => Number(entry.directTruePositive) > 0).length /
        direct.length,
    stablePatternWindowRecall: stable.length === 0
      ? 1
      : stable.filter((entry) => entry.patternWindowHit === true).length /
        stable.length,
    inferenceAutoCommits: sum('inferenceAutoCommits'),
    nonVerbatimEvidence: sum('nonVerbatimEvidence'),
    tombstoneRevivals: sum('tombstoneRevivals'),
    scopeMixes: sum('scopeMixes'),
    credentialLeaks: sum('credentialLeaks'),
    diagnosticInferences: sum('diagnosticInferences'),
    duplicateSideEffects: sum('duplicateSideEffects'),
    crossVersionDuplicates: sum('crossVersionDuplicates'),
  };
  const failedMetrics = [];
  for (const [metric, threshold] of Object.entries(REFLECTION_THRESHOLDS)) {
    const value = metrics[metric];
    const minimumMetric = [
      'directPrecision',
      'directPositiveWindowRecall',
      'stablePatternWindowRecall',
    ].includes(metric);
    if (minimumMetric ? value < threshold : value > threshold) {
      failedMetrics.push(metric);
    }
  }
  return {
    passed: failedMetrics.length === 0,
    thresholds: REFLECTION_THRESHOLDS,
    metrics,
    failedMetrics,
  };
}

function parseArgs(argv) {
  const result = {
    validateFixture: false,
    section: 'all',
    ollamaUrl: 'http://127.0.0.1:11434',
    queryModel: 'qwen2.5:14b',
    extractModel: 'qwen2.5:14b',
    reflectionModel: 'qwen2.5:14b',
    embeddingModel: 'bge-m3:latest',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    receipt: '',
    help: false,
  };
  const valueOptions = new Map([
    ['--section', 'section'],
    ['--ollama-url', 'ollamaUrl'],
    ['--query-model', 'queryModel'],
    ['--extract-model', 'extractModel'],
    ['--reflection-model', 'reflectionModel'],
    ['--embedding-model', 'embeddingModel'],
    ['--timeout-ms', 'timeoutMs'],
    ['--receipt', 'receipt'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--validate-fixture') {
      result.validateFixture = true;
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
  if (!['all', 'query', 'reflection'].includes(result.section)) {
    throw new Error('--section 只允许 all/query/reflection');
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
  if (result.validateFixture && result.receipt) {
    throw new Error('--validate-fixture 不写 receipt');
  }
  return result;
}

function usage() {
  return [
    '用法：',
    '  npm run evaluate:context-reflection -- --validate-fixture',
    '  npm run evaluate:context-reflection -- --receipt /private/tmp/context-reflection.json',
    '',
    '选项：',
    '  --section all|query|reflection   默认 all',
    '  --ollama-url URL                仅允许 loopback，默认 http://127.0.0.1:11434',
    '  --query-model MODEL             默认 qwen2.5:14b',
    '  --extract-model MODEL           默认 qwen2.5:14b',
    '  --reflection-model MODEL        默认 qwen2.5:14b',
    '  --embedding-model MODEL         默认 bge-m3:latest',
    '  --timeout-ms N                  单次调用超时，默认 300000',
    '  --receipt PATH                  写入去正文的 JSON 回执',
    '  --validate-fixture              只校验 120+100 固定集，不调用模型',
  ].join('\n');
}

function normalizedIncludes(value, term) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .includes(
      String(term || '').normalize('NFKC').toLocaleLowerCase('zh-CN'),
    );
}

function redactError(value) {
  return String(value || '')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/gu, '[credential-redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}\b/giu, 'Bearer [credential-redacted]')
    .slice(0, 1_000);
}

export function requiredPreflightModels(options) {
  const models = options.section === 'query'
    ? [options.queryModel]
    : options.section === 'reflection'
      ? [options.extractModel, options.reflectionModel, options.embeddingModel]
      : [
          options.queryModel,
          options.extractModel,
          options.reflectionModel,
          options.embeddingModel,
        ];
  return {
    models: [...new Set(models)],
    checkEmbedding: options.section !== 'query',
  };
}

async function preflightOllama(options) {
  const requirement = requiredPreflightModels(options);
  const requested = new Set(requirement.models);
  const tagsResponse = await fetch(`${options.ollamaUrl}/api/tags`, {
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!tagsResponse.ok) {
    throw new Error(`Ollama 模型列表失败：HTTP ${tagsResponse.status}`);
  }
  const tags = await tagsResponse.json();
  const available = new Set(
    Array.isArray(tags.models)
      ? tags.models.flatMap((entry) => isRecord(entry) && typeof entry.name === 'string'
        ? [entry.name]
        : [])
      : [],
  );
  const missing = [...requested].filter((model) => !available.has(model));
  if (missing.length > 0) {
    throw new Error(`Ollama 缺少模型：${missing.join(', ')}`);
  }
  if (!requirement.checkEmbedding) {
    return {
      availableModels: [...requested],
      embeddingChecked: false,
      embeddingDimensions: null,
    };
  }
  const embedResponse = await fetch(`${options.ollamaUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(options.timeoutMs),
    body: JSON.stringify({
      model: options.embeddingModel,
      input: ['Memory Bridge quality preflight'],
      keep_alive: '15m',
    }),
  });
  if (!embedResponse.ok) {
    throw new Error(`Ollama embedding 预检失败：HTTP ${embedResponse.status}`);
  }
  const embedPayload = await embedResponse.json();
  const vector = Array.isArray(embedPayload.embeddings)
    ? embedPayload.embeddings[0]
    : null;
  if (!Array.isArray(vector) || vector.length === 0 || vector.some(
    (entry) => typeof entry !== 'number' || !Number.isFinite(entry),
  )) {
    throw new Error('Ollama embedding 预检未返回有效向量');
  }
  return {
    availableModels: [...requested],
    embeddingChecked: true,
    embeddingDimensions: vector.length,
  };
}

async function runQueryEvaluation(parsed, options) {
  const module = await import('../dist/server/contextual-query-understanding.js');
  const baseProvider = new module.OllamaContextualQueryUnderstandingProvider({
    baseUrl: options.ollamaUrl,
    model: options.queryModel,
    timeoutMs: options.timeoutMs,
    promptVersion: 'context-query-v3-compact-wire',
  });
  const warmupCase = parsed.queryCases[0];
  await baseProvider.understand({
    principalId: warmupCase.principalId,
    sessionId: `${warmupCase.sessionId}-warmup`,
    roundId: `${warmupCase.id}-warmup`,
    originalQuery: warmupCase.originalQuery,
    recentTurns: warmupCase.recentTurns,
    currentTime: warmupCase.currentTime,
  });
  const results = [];
  for (const fixture of parsed.queryCases) {
    let modelCalls = 0;
    const provider = {
      model: baseProvider.model,
      promptVersion: baseProvider.promptVersion,
      async understand(input) {
        modelCalls += 1;
        return await baseProvider.understand(input);
      },
    };
    const service = new module.ContextualQueryUnderstandingService(provider, {
      mode: 'always',
      minConfidence: 0.78,
      maxMessages: 6,
      tokenBudget: 1_600,
      replayTtlMs: 1_000,
    });
    const started = performance.now();
    let result;
    let error = null;
    try {
      result = await service.understand({
        principalId: fixture.principalId,
        sessionId: fixture.sessionId,
        roundId: fixture.id,
        originalQuery: fixture.originalQuery,
        recentTurns: fixture.recentTurns,
        currentTime: fixture.currentTime,
      });
    } catch (failure) {
      error = redactError(failure instanceof Error ? failure.message : failure);
      result = {
        status: 'unavailable',
        standaloneQuery: null,
        rankingQuery: fixture.originalQuery,
        variants: [],
        resolvedReferences: [],
        clarificationQuestion: null,
      };
    }
    const latencyMs = Number((performance.now() - started).toFixed(3));
    const searchable = [
      result.standaloneQuery,
      result.rankingQuery,
      ...(Array.isArray(result.variants) ? result.variants : []),
    ].filter(Boolean).join('\n');
    const semanticCorrect = fixture.expectedStatus === 'resolved'
      ? result.status === 'resolved' && fixture.requiredTerms.every(
          (term) => normalizedIncludes(result.standaloneQuery, term),
        )
      : result.status === 'ambiguous';
    const constraintsPreserved = fixture.preservedTerms.every(
      (term) => normalizedIncludes(result.standaloneQuery, term),
    );
    const wrongMemoryInjection = fixture.expectedStatus === 'ambiguous' && (
      result.status === 'resolved' ||
      Boolean(result.standaloneQuery) ||
      (Array.isArray(result.variants) && result.variants.length > 0) ||
      (Array.isArray(result.resolvedReferences) &&
        result.resolvedReferences.length > 0)
    );
    const scopeLeak = fixture.forbiddenTerms.some(
      (term) => normalizedIncludes(searchable, term),
    );
    results.push({
      id: fixture.id,
      template: fixture.template,
      expectedStatus: fixture.expectedStatus,
      actualStatus: result.status,
      semanticCorrect,
      constraintsPreserved,
      hasConstraints: fixture.preservedTerms.length > 0,
      wrongMemoryInjection,
      scopeLeak,
      modelCalls,
      latencyMs,
      providerDurationMs: result.telemetry?.providerDurationMs ?? null,
      modelTelemetry: result.telemetry?.model ?? null,
      error,
    });
  }
  return {
    ...summarizeQueryQuality(results),
    cases: results,
  };
}

function candidateText(candidate) {
  return [
    candidate.subject,
    candidate.predicate,
    candidate.value,
    candidate.content,
    candidate.sourceExcerpt,
  ].filter(Boolean).join('\n');
}

export function countNonVerbatimEvidence(
  evidenceEntries,
  turnContentById,
) {
  return evidenceEntries.filter((evidence) => {
    const sourceContent = turnContentById.get(evidence.turnId);
    return !sourceContent || !evidence.excerpt ||
      !sourceContent.includes(evidence.excerpt);
  }).length;
}

export function loadEvidenceTurnContent(database, evidenceEntries) {
  const contentById = new Map();
  const select = database.prepare(
    'SELECT content FROM conversation_turns WHERE id = ?',
  );
  for (const evidence of evidenceEntries) {
    const turnId = String(evidence?.turnId || '');
    if (!turnId || contentById.has(turnId)) continue;
    const row = select.get(turnId);
    if (row && typeof row.content === 'string') {
      contentById.set(turnId, row.content);
    }
  }
  return contentById;
}

async function runReflectionEvaluation(parsed, options) {
  const [databaseModule, lifecycleModule, extractorModule, reflectionModule,
    memoryStoreModule, resolverModule] = await Promise.all([
    import('../dist/server/database.js'),
    import('../dist/server/lifecycle-store.js'),
    import('../dist/server/memory-extractor.js'),
    import('../dist/server/memory-reflection.js'),
    import('../dist/server/memory-store.js'),
    import('../dist/server/candidate-resolver.js'),
  ]);
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-quality-v1-'),
  );
  const database = databaseModule.openDatabase(
    path.join(temporaryDirectory, 'quality.sqlite3'),
  );
  const clock = () => new Date('2026-08-09T12:00:00.000Z');
  const lifecycle = new lifecycleModule.LifecycleStore(database, clock);
  const extractor = new extractorModule.OllamaMemoryExtractor({
    baseUrl: options.ollamaUrl,
    model: options.extractModel,
    promptVersion: 'memory-extraction-v1',
    timeoutMs: options.timeoutMs,
  });
  const provider = new reflectionModule.OllamaReflectionProvider({
    baseUrl: options.ollamaUrl,
    model: options.reflectionModel,
    promptVersion: 'history-reflection-v1',
    timeoutMs: options.timeoutMs,
  });
  const service = new reflectionModule.MemoryReflectionService(
    database,
    lifecycle,
    extractor,
    provider,
    {
      mode: 'shadow',
      minNewTurns: 1,
      minPatternEvidence: 3,
      maxTurns: 10,
      tokenBudget: 4_000,
      lookbackDays: 30,
      maxDailyCalls: 500,
      concurrency: 1,
      clock,
    },
  );
  const memoryStore = new memoryStoreModule.MemoryStore(database);
  const resolver = new resolverModule.CandidateResolver(
    database,
    lifecycle,
    memoryStore,
    { mode: 'shadow' },
  );
  const results = [];
  let replayContractsExecuted = false;
  try {
    for (const fixture of parsed.reflectionWindows) {
      for (const turn of fixture.turns) {
        lifecycle.recordTurn({
          userId: fixture.userId,
          namespace: fixture.namespace,
          personaId: fixture.personaId,
          projectId: null,
          identitySource: 'fixed-quality-evaluation',
          identityStatus: 'complete',
          roundId: turn.id,
          clientName: 'quality-evaluator',
          sessionExternalId: `session-${fixture.id}`,
          turnExternalId: turn.id,
          role: 'user',
          content: turn.content,
          occurredAt: turn.occurredAt,
        });
      }
      if (fixture.distractorUserId) {
        for (const [index, turn] of fixture.turns.entries()) {
          lifecycle.recordTurn({
            userId: fixture.distractorUserId,
            namespace: fixture.namespace,
            personaId: `quality-distractor-persona-${fixture.entityId}`,
            projectId: null,
            identitySource: 'fixed-quality-evaluation',
            identityStatus: 'complete',
            roundId: `${turn.id}-distractor`,
            clientName: 'quality-evaluator',
            sessionExternalId: `distractor-${fixture.id}`,
            turnExternalId: `${turn.id}-distractor`,
            role: 'user',
            content: `其他账户第${index + 1}次只讨论${fixture.distractorValue}。`,
            occurredAt: turn.occurredAt,
          });
        }
      }
      const queueInput = {
        userId: fixture.userId,
        namespace: fixture.namespace,
        scopeType: fixture.scopeType,
        scopeKey: fixture.scopeKey,
        runType: fixture.runType,
        trigger: 'manual',
        requestedBy: 'fixed-quality-evaluator',
      };
      const firstQueue = service.queueRun(queueInput);
      const duplicateQueue = service.queueRun(queueInput);
      let duplicateSideEffects = duplicateQueue.created ||
        duplicateQueue.run.id !== firstQueue.run.id ? 1 : 0;
      let execution;
      let error = null;
      const started = performance.now();
      try {
        execution = await service.executeRun(
          firstQueue.run.id,
          `quality-worker-${fixture.entityId}`,
        );
      } catch (failure) {
        error = redactError(failure instanceof Error ? failure.message : failure);
        execution = {
          run: service.getRun(firstQueue.run.id),
          candidates: [],
        };
      }
      const latencyMs = Number((performance.now() - started).toFixed(3));
      const candidates = execution.candidates || [];
      let directTruePositive = 0;
      let directFalsePositive = 0;
      if (fixture.kind === 'direct_explicit') {
        for (const candidate of candidates) {
          const text = candidateText(candidate);
          const supported = fixture.expectedTerms.every(
            (term) => normalizedIncludes(text, term),
          ) && fixture.turns.some(
            (turn) => turn.content.includes(candidate.sourceExcerpt || ''),
          );
          if (supported) directTruePositive += 1;
          else directFalsePositive += 1;
        }
      }
      let nonVerbatimEvidence = 0;
      let scopeMixes = 0;
      let credentialLeaks = 0;
      let diagnosticInferences = 0;
      for (const candidate of candidates) {
        const text = candidateText(candidate);
        if (
          candidate.userId !== fixture.userId ||
          candidate.namespace !== fixture.namespace ||
          candidate.scopeType !== fixture.scopeType ||
          candidate.scopeKey !== fixture.scopeKey ||
          fixture.forbiddenTerms.some((term) => normalizedIncludes(text, term))
        ) {
          scopeMixes += 1;
        }
        if (
          candidate.sensitivity === 'credential' ||
          (fixture.secret && normalizedIncludes(text, fixture.secret))
        ) {
          credentialLeaks += 1;
        }
        if (/(?:确诊|患有|焦虑症|抑郁症|人格障碍|医学诊断)/u.test(text)) {
          diagnosticInferences += 1;
        }
        const evidenceEntries = service.candidateEvidence(
          candidate.id,
          fixture.userId,
        );
        nonVerbatimEvidence += countNonVerbatimEvidence(
          evidenceEntries,
          loadEvidenceTurnContent(database, evidenceEntries),
        );
      }
      const canonicalCount = Number(
        database.prepare(
          `SELECT COUNT(*) AS count FROM memory_items WHERE user_id = ?`,
        ).get(fixture.userId)?.count || 0,
      );
      let crossVersionDuplicates = 0;
      let tombstoneRevivals = 0;
      if (
        !replayContractsExecuted &&
        fixture.kind === 'stable_pattern' &&
        candidates.length > 0
      ) {
        replayContractsExecuted = true;
        const beforeReplay = Number(
          database.prepare(
            `SELECT COUNT(*) AS count FROM memory_candidates WHERE user_id = ?`,
          ).get(fixture.userId)?.count || 0,
        );
        const replay = service.queueRun({
          ...queueInput,
          implementationVersion: 'fixed-quality-replay-v2',
        });
        await service.executeRun(replay.run.id, 'quality-replay-worker-v2');
        const afterReplay = Number(
          database.prepare(
            `SELECT COUNT(*) AS count FROM memory_candidates WHERE user_id = ?`,
          ).get(fixture.userId)?.count || 0,
        );
        crossVersionDuplicates += Math.max(0, afterReplay - beforeReplay);
        const canonicalCandidate = candidates[0];
        resolver.rejectForReview(canonicalCandidate.id, true);
        const beforeBlockedReplay = Number(
          database.prepare(
            `SELECT COUNT(*) AS count FROM memory_candidates WHERE user_id = ?`,
          ).get(fixture.userId)?.count || 0,
        );
        const blockedReplay = service.queueRun({
          ...queueInput,
          implementationVersion: 'fixed-quality-replay-v3',
        });
        await service.executeRun(
          blockedReplay.run.id,
          'quality-replay-worker-v3',
        );
        const afterBlockedReplay = Number(
          database.prepare(
            `SELECT COUNT(*) AS count FROM memory_candidates WHERE user_id = ?`,
          ).get(fixture.userId)?.count || 0,
        );
        tombstoneRevivals += Math.max(
          0,
          afterBlockedReplay - beforeBlockedReplay,
        );
      }
      const patternWindowHit = fixture.kind === 'stable_pattern' &&
        candidates.some((candidate) => {
          const text = candidateText(candidate);
          return fixture.expectedTerms.every(
            (term) => normalizedIncludes(text, term),
          ) && service.candidateEvidence(candidate.id, fixture.userId).length >= 3;
        });
      results.push({
        id: fixture.id,
        kind: fixture.kind,
        status: execution.run?.status || 'failed',
        directTruePositive,
        directFalsePositive,
        patternWindowHit,
        inferenceAutoCommits:
          fixture.runType === 'reflect' ? canonicalCount : 0,
        nonVerbatimEvidence,
        tombstoneRevivals,
        scopeMixes,
        credentialLeaks,
        diagnosticInferences,
        duplicateSideEffects,
        crossVersionDuplicates,
        latencyMs,
        error,
      });
    }
  } finally {
    database.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  if (!replayContractsExecuted) {
    results.push({
      id: 'contract:replay-not-executed',
      kind: 'contract_failure',
      directTruePositive: 0,
      directFalsePositive: 0,
      inferenceAutoCommits: 0,
      nonVerbatimEvidence: 0,
      tombstoneRevivals: 1,
      scopeMixes: 0,
      credentialLeaks: 0,
      diagnosticInferences: 0,
      duplicateSideEffects: 0,
      crossVersionDuplicates: 1,
      error: '没有稳定模式候选，无法执行跨版本去重和 tombstone 回放合同',
    });
  }
  return {
    ...summarizeReflectionQuality(results),
    windows: results,
  };
}

function writeReceipt(receiptPath, payload) {
  const absolutePath = path.resolve(receiptPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return absolutePath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const parsed = parseContextReflectionFixtureBytes(
    fs.readFileSync(FIXTURE_PATH),
  );
  if (options.validateFixture) {
    process.stdout.write(`${JSON.stringify({
      status: 'valid',
      datasetId: parsed.dataset.datasetId,
      datasetSha256: parsed.datasetSha256,
      queryCases: parsed.queryCases.length,
      reflectionWindows: parsed.reflectionWindows.length,
    })}\n`);
    return;
  }
  const startedAt = new Date().toISOString();
  const preflight = await preflightOllama(options);
  const query = options.section === 'reflection'
    ? null
    : await runQueryEvaluation(parsed, options);
  const reflection = options.section === 'query'
    ? null
    : await runReflectionEvaluation(parsed, options);
  const passed = (query?.passed ?? true) && (reflection?.passed ?? true);
  const receipt = {
    evaluatorVersion: 'context-reflection-quality-evaluator-v1',
    datasetId: parsed.dataset.datasetId,
    datasetSha256: parsed.datasetSha256,
    queryCases: parsed.queryCases.length,
    reflectionWindows: parsed.reflectionWindows.length,
    models: {
      query: options.queryModel,
      extraction: options.extractModel,
      reflection: options.reflectionModel,
      embedding: options.embeddingModel,
    },
    preflight,
    startedAt,
    completedAt: new Date().toISOString(),
    section: options.section,
    passed,
    query,
    reflection,
  };
  const receiptPath = options.receipt
    ? writeReceipt(options.receipt, receipt)
    : null;
  process.stdout.write(`${JSON.stringify({
    status: passed ? 'pass' : 'fail',
    datasetId: receipt.datasetId,
    datasetSha256: receipt.datasetSha256,
    query: query ? {
      passed: query.passed,
      metrics: query.metrics,
      failedMetrics: query.failedMetrics,
    } : null,
    reflection: reflection ? {
      passed: reflection.passed,
      metrics: reflection.metrics,
      failedMetrics: reflection.failedMetrics,
    } : null,
    receiptPath,
  }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

const isDirectExecution = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${redactError(
      error instanceof Error ? error.message : error,
    )}\n`);
    process.exitCode = 1;
  });
}
