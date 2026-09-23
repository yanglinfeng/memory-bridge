import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

export const REQUIRED_RERANK_MODEL = 'qwen2.5:14b';
export const REQUIRED_EMBED_MODEL = 'bge-m3:latest';
export const REQUIRED_RERANK_MODEL_DIGEST =
  '7cdf5a0187d5c58cc5d369b255592f7841d1c4696d45a8c8a9489440385b22f6';
export const REQUIRED_EMBED_MODEL_DIGEST =
  '7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab';
export const REQUIRED_EMBED_DIMENSION = 1_024;
export const DEFAULT_RERANK_BENCH_SAMPLES = 20;
export const RERANK_THRESHOLD_P95_MS = 1_500;
export const RERANK_BENCHMARK_FIXTURE_SHA256 =
  '4fb9e079491f1117118650224577d3dd6bc4ea0cc0e36bb44eaad194f099f6c8';
export const RERANK_BENCHMARK_QUERY =
  '用户开始处理复杂开发任务前，通常怎样组织思路？' +
  '请只判断候选记忆是否能直接回答其起手流程，包括是否先画流程图、梳理整体结构、列出依赖和风险，再逐项实现；' +
  '不要把咖啡、出行、编辑器、发布窗口、测试数据或同事习惯误当成用户自己的任务组织方式。并且不要根据常识猜测。';
export const RERANK_BENCHMARK_LOAD = Object.freeze({
  candidateCount: 16,
  minimumCandidateCharacters: 600,
  maximumCandidateCharacters: 640,
  minimumAtomicCandidates: 4,
  minimumEpisodeCandidates: 8,
  queryCharacters: 128,
  minimumUniqueMeasuredPrompts: 20,
});

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_WARMUP_COUNT = 2;
const PRISTINE_FUNCTION_TO_STRING = runInNewContext(
  'Function.prototype.toString',
);
const ORIGINAL_GLOBAL_FETCH = globalThis.fetch;
const STARTUP_NODE_OPTIONS = String(process.env.NODE_OPTIONS || '');
const STARTUP_EXEC_ARGV = [...process.execArgv];
const PUBLISHABLE_GATE_ENTRYPOINTS = new Set([
  import.meta.url,
  new URL('./verify-reranker-quality.mjs', import.meta.url).href,
]);
const PRELOAD_FLAGS = new Set([
  '--import',
  '--require',
  '-r',
  '--loader',
  '--experimental-loader',
]);
let pristineNodeFetchSource;

function publishableGateEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return PUBLISHABLE_GATE_ENTRYPOINTS.has(
      pathToFileURL(path.resolve(process.argv[1])).href,
    );
  } catch {
    return false;
  }
}

function cleanNodeFetchSource() {
  if (pristineNodeFetchSource !== undefined) return pristineNodeFetchSource;
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_OPTIONS;
  const child = spawnSync(
    process.execPath,
    [
      '--eval',
      'process.stdout.write(Function.prototype.toString.call(globalThis.fetch))',
    ],
    {
      env: cleanEnv,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1_024,
    },
  );
  pristineNodeFetchSource = child.status === 0 && !child.error
    ? child.stdout
    : null;
  return pristineNodeFetchSource;
}

function originalFetchMatchesCleanNode() {
  const cleanSource = cleanNodeFetchSource();
  if (!cleanSource || typeof ORIGINAL_GLOBAL_FETCH !== 'function') return false;
  try {
    return PRISTINE_FUNCTION_TO_STRING.call(ORIGINAL_GLOBAL_FETCH) ===
      cleanSource;
  } catch {
    return false;
  }
}

function hasStartupPreload() {
  const argumentHasPreload = STARTUP_EXEC_ARGV.some((argument) =>
    PRELOAD_FLAGS.has(argument) ||
    [...PRELOAD_FLAGS].some((flag) => argument.startsWith(`${flag}=`))
  );
  const nodeOptionsHasPreload =
    /(?:^|\s)(?:--import|--require|-r|--loader|--experimental-loader)(?:=|\s|$)/u
      .test(STARTUP_NODE_OPTIONS);
  return argumentHasPreload || nodeOptionsHasPreload;
}

function benchmarkAtomicMemory(subject, predicate, value, negated = false) {
  return `atomic-memory-v1:${JSON.stringify({
    subject,
    predicate,
    value,
    negated,
  })}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

export const rerankBenchmarkCase = deepFreeze({
  query: RERANK_BENCHMARK_QUERY,
  candidates: [
    {
      id: 'plan-overview',
      memory: benchmarkAtomicMemory(
        '用户',
        '复杂任务起手方式',
        '先画流程图梳理整体结构，再开始写代码',
      ),
      relevant: true,
    },
    {
      id: 'list-risks',
      memory: '用户原话: 我处理大型需求会先列出依赖和风险，再逐项实现。',
      relevant: true,
    },
    {
      id: 'morning-coffee',
      memory: benchmarkAtomicMemory(
        '用户',
        '早晨饮品',
        '不加糖拿铁',
      ),
      relevant: false,
    },
    {
      id: 'colleague-coding',
      memory: '用户原话: 同事小周拿到任务后喜欢立刻写代码，不做前置梳理。',
      relevant: false,
    },
    {
      id: 'archived-template',
      memory: '用户原话: 需求分析模板文件已经归档到共享目录。',
      relevant: false,
    },
    {
      id: 'test-database',
      memory: '用户原话: 测试数据库保存了三条演示客户记录。',
      relevant: false,
    },
    {
      id: 'weekend-running',
      memory: '用户原话: 我周末喜欢沿江跑步。',
      relevant: false,
    },
    {
      id: 'service-stack',
      memory: '用户原话: 服务端使用 TypeScript 和 SQLite。',
      relevant: false,
    },
    {
      id: 'reply-language',
      memory: benchmarkAtomicMemory('用户', '回复语言', '中文'),
      relevant: false,
    },
    {
      id: 'release-window',
      memory: '用户原话: 下一个版本计划在周五晚上发布。',
      relevant: false,
    },
    {
      id: 'travel-choice',
      memory: benchmarkAtomicMemory('用户', '长途出行交通', '高铁'),
      relevant: false,
    },
    {
      id: 'empty-workspace',
      memory: '用户原话: 新工作区首次启动必须保持空数据。',
      relevant: false,
    },
    {
      id: 'editor-choice',
      memory: '用户原话: 我日常主要使用 VS Code。',
      relevant: false,
    },
    {
      id: 'meeting-time',
      memory: '用户原话: 团队例会固定在每周一下午三点。',
      relevant: false,
    },
    {
      id: 'worker-duty',
      memory: '用户原话: 后台 Worker 负责异步提取候选记忆。',
      relevant: false,
    },
    {
      id: 'csv-heading',
      memory: '用户原话: 导出的 CSV 文件需要包含标题行。',
      relevant: false,
    },
  ],
});

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(',')}}`;
}

export function rerankBenchmarkFixtureSha256(benchmarkCase) {
  return createHash('sha256')
    .update(canonicalJson(benchmarkCase))
    .digest('hex');
}

function isCompactAtomicBenchmarkCandidate(value) {
  const prefix = 'atomic-memory-v1:';
  if (typeof value !== 'string' || !value.startsWith(prefix)) return false;
  try {
    const parsed = JSON.parse(value.slice(prefix.length));
    return parsed && typeof parsed === 'object' &&
      typeof parsed.subject === 'string' && parsed.subject.length > 0 &&
      typeof parsed.predicate === 'string' && parsed.predicate.length > 0 &&
      typeof parsed.value === 'string' && parsed.value.length > 0 &&
      typeof parsed.negated === 'boolean' &&
      value === benchmarkAtomicMemory(
        parsed.subject,
        parsed.predicate,
        parsed.value,
        parsed.negated,
      );
  } catch {
    return false;
  }
}

export function inspectRerankBenchmarkLoad(benchmarkCase) {
  const query = typeof benchmarkCase?.query === 'string'
    ? benchmarkCase.query
    : '';
  const candidates = Array.isArray(benchmarkCase?.candidates)
    ? benchmarkCase.candidates
    : [];
  const candidateCharacters = candidates.reduce(
    (total, candidate) =>
      total + [...String(candidate?.memory || '')].length,
    0,
  );
  const atomicCandidates = candidates.filter((candidate) =>
    isCompactAtomicBenchmarkCandidate(candidate?.memory)
  ).length;
  const episodeCandidates = candidates.filter((candidate) =>
    typeof candidate?.memory === 'string' &&
    /^用户原话: \S[^\r\n]*$/u.test(candidate.memory)
  ).length;
  const profile = {
    query,
    queryCharacters: [...query].length,
    candidateCount: candidates.length,
    candidateCharacters,
    atomicCandidates,
    episodeCandidates,
    allCandidatesUseProductionShape:
      atomicCandidates + episodeCandidates === candidates.length,
  };
  return {
    ...profile,
    matchesProductionDefinition:
      profile.query === RERANK_BENCHMARK_QUERY &&
      profile.queryCharacters === RERANK_BENCHMARK_LOAD.queryCharacters &&
      !/[\r\n]/u.test(profile.query) &&
      profile.candidateCount === RERANK_BENCHMARK_LOAD.candidateCount &&
      profile.candidateCharacters >=
        RERANK_BENCHMARK_LOAD.minimumCandidateCharacters &&
      profile.candidateCharacters <=
        RERANK_BENCHMARK_LOAD.maximumCandidateCharacters &&
      profile.atomicCandidates >=
        RERANK_BENCHMARK_LOAD.minimumAtomicCandidates &&
      profile.episodeCandidates >=
        RERANK_BENCHMARK_LOAD.minimumEpisodeCandidates &&
      profile.allCandidatesUseProductionShape,
  };
}

const DEFAULT_RERANK_BENCHMARK_LOAD_PROFILE =
  inspectRerankBenchmarkLoad(rerankBenchmarkCase);
requireCondition(
  DEFAULT_RERANK_BENCHMARK_LOAD_PROFILE.matchesProductionDefinition,
  '默认真实重排 benchmark 不符合生产 640 字 mixed atomic/episode 负载定义',
);
requireCondition(
  rerankBenchmarkFixtureSha256(rerankBenchmarkCase) ===
    RERANK_BENCHMARK_FIXTURE_SHA256,
  '默认真实重排 benchmark 的 fixture SHA-256 与发布锁定值不符',
);

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.trunc(parsed))
    : Math.max(minimum, fallback);
}

function enabled(value) {
  return /^(?:1|true|yes|on)$/iu.test(String(value || '').trim());
}

export function rerankGateEvidenceMode(options, invocationArgumentCount) {
  return invocationArgumentCount === 0 &&
      Object.getPrototypeOf(options) === Object.prototype &&
      Reflect.ownKeys(options).length === 0 &&
      publishableGateEntrypoint() &&
      !hasStartupPreload() &&
      originalFetchMatchesCleanNode() &&
      globalThis.fetch === ORIGINAL_GLOBAL_FETCH
    ? 'real_ollama'
    : 'test_injected';
}

export function percentile(values, percentileValue) {
  const ordered = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (ordered.length === 0) return 0;
  const index = Math.max(
    0,
    Math.ceil(ordered.length * percentileValue) - 1,
  );
  return ordered[index];
}

export function telemetryDistribution(values) {
  const samples = values.filter(
    (value) => Number.isFinite(value) && value >= 0,
  );
  if (samples.length === 0) {
    return { count: 0, sum: 0, p50: null, p95: null, max: null };
  }
  return {
    count: samples.length,
    sum: Number(
      samples.reduce((total, value) => total + value, 0).toFixed(3),
    ),
    p50: Number(percentile(samples, 0.5).toFixed(3)),
    p95: Number(percentile(samples, 0.95).toFixed(3)),
    max: Number(Math.max(...samples).toFixed(3)),
  };
}

export function requireLocalOllamaBaseUrl(value) {
  const rawBaseUrl = String(value || '');
  const baseUrl = rawBaseUrl.endsWith('/')
    ? rawBaseUrl.slice(0, -1)
    : rawBaseUrl;
  requireCondition(
    /^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d{1,5}$/u.test(baseUrl),
    '真实 Ollama 门禁只允许带明确端口的 127.0.0.1 或 [::1] HTTP 根地址',
  );
  const parsed = new URL(baseUrl);
  const port = Number(parsed.port);
  requireCondition(
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.pathname === '/' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65_535,
    '真实 Ollama 门禁拒绝凭据、路径、查询参数或非法端口',
  );
  return baseUrl;
}

export function resolveRerankGateConfig(
  env = process.env,
  overrides = {},
) {
  const sampleCount = positiveInteger(
    overrides.sampleCount ?? env.RERANK_BENCH_SAMPLES,
    DEFAULT_RERANK_BENCH_SAMPLES,
    10,
  );
  const baseUrl = requireLocalOllamaBaseUrl(String(
      overrides.baseUrl ?? env.MEMORY_BRIDGE_OLLAMA_URL ?? DEFAULT_BASE_URL,
  ));
  return {
    baseUrl,
    rerankModel: String(
      overrides.rerankModel ??
      env.MEMORY_BRIDGE_RERANK_MODEL ??
      REQUIRED_RERANK_MODEL,
    ),
    embeddingModel: String(
      overrides.embeddingModel ??
      env.MEMORY_BRIDGE_EMBED_MODEL ??
      REQUIRED_EMBED_MODEL,
    ),
    sampleCount,
    warmupCount: positiveInteger(
      overrides.warmupCount,
      DEFAULT_WARMUP_COUNT,
      1,
    ),
    thresholdP95Ms: RERANK_THRESHOLD_P95_MS,
    cleanupRequested: overrides.cleanupRequested ?? enabled(
      env.RERANK_UNLOAD_ON_EXIT,
    ),
  };
}

function modelName(entry) {
  return typeof entry?.name === 'string'
    ? entry.name
    : typeof entry?.model === 'string' ? entry.model : '';
}

function parameterCountFromText(value) {
  const match = String(value || '').trim().match(
    /^(\d+(?:\.\d+)?)\s*([KMBT])?$/iu,
  );
  if (!match) return null;
  const multiplier = {
    K: 1_000,
    M: 1_000_000,
    B: 1_000_000_000,
    T: 1_000_000_000_000,
  }[String(match[2] || '').toUpperCase()] || 1;
  return Number(match[1]) * multiplier;
}

function modelParameterCount(tag, show) {
  const direct = Number(show?.model_info?.['general.parameter_count']);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return parameterCountFromText(
    show?.details?.parameter_size ?? tag?.details?.parameter_size,
  );
}

async function jsonResponse(fetchImpl, url, init, label) {
  const response = await fetchImpl(url, init);
  requireCondition(response && typeof response.ok === 'boolean',
    `${label} 没有返回标准 HTTP Response`);
  requireCondition(response.ok, `${label} 请求失败：HTTP ${response.status}`);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${label} 返回的 JSON 无法解析`, { cause: error });
  }
}

export async function verifyOllamaModelIdentity({
  baseUrl,
  rerankModel,
  embeddingModel,
  fetchImpl = globalThis.fetch,
}) {
  const localBaseUrl = requireLocalOllamaBaseUrl(baseUrl);
  requireCondition(
    rerankModel === REQUIRED_RERANK_MODEL,
    `真实重排门禁只接受 ${REQUIRED_RERANK_MODEL}，收到 ${rerankModel}`,
  );
  requireCondition(
    embeddingModel === REQUIRED_EMBED_MODEL,
    `真实 embedding 门禁只接受 ${REQUIRED_EMBED_MODEL}，收到 ${embeddingModel}`,
  );
  let metadataCalls = 0;
  metadataCalls += 1;
  const versionPayload = await jsonResponse(
    fetchImpl,
    `${localBaseUrl}/api/version`,
    undefined,
    'Ollama /api/version',
  );
  const version = typeof versionPayload?.version === 'string'
    ? versionPayload.version.trim()
    : '';
  requireCondition(version.length > 0, 'Ollama /api/version 缺少版本号');
  metadataCalls += 1;
  const tags = await jsonResponse(
    fetchImpl,
    `${localBaseUrl}/api/tags`,
    undefined,
    'Ollama /api/tags',
  );
  requireCondition(Array.isArray(tags?.models),
    'Ollama /api/tags 缺少 models 数组');

  const inspect = async (requested, kind) => {
    const tag = tags.models.find((entry) => modelName(entry) === requested);
    requireCondition(tag, `本机未安装精确模型 ${requested}`);
    const expectedDigest = kind === 'rerank'
      ? REQUIRED_RERANK_MODEL_DIGEST
      : REQUIRED_EMBED_MODEL_DIGEST;
    const expectedFamily = kind === 'rerank' ? 'qwen2' : 'bert';
    requireCondition(
      tag.digest === expectedDigest,
      `${requested} 的 digest 与发布锁定值不符`,
    );
    metadataCalls += 1;
    const show = await jsonResponse(
      fetchImpl,
      `${localBaseUrl}/api/show`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: requested, verbose: true }),
      },
      `Ollama /api/show ${requested}`,
    );
    requireCondition(
      show && typeof show === 'object' &&
      (show.model_info || show.details || show.modelfile || show.template),
      `${requested} 的 /api/show 缺少模型身份信息`,
    );
    const parameterCount = modelParameterCount(tag, show);
    const tagFamily = String(tag?.details?.family || '').trim().toLowerCase();
    const showFamily = String(show?.details?.family || '').trim().toLowerCase();
    requireCondition(
      tagFamily === expectedFamily && showFamily === expectedFamily,
      `${requested} 的 family 与要求不符或无法核验`,
    );
    const inExpectedRange = kind === 'rerank'
      ? Number.isFinite(parameterCount) &&
        parameterCount >= 13_000_000_000 &&
        parameterCount <= 16_500_000_000
      : Number.isFinite(parameterCount) &&
        parameterCount >= 100_000_000 &&
        parameterCount <= 2_000_000_000;
    requireCondition(
      inExpectedRange,
      `${requested} 的参数规模与要求不符或无法核验`,
    );
    return {
      requested,
      resolved: modelName(tag),
      digest: tag.digest,
      family: showFamily,
      parameterSize:
        show?.details?.parameter_size ?? tag?.details?.parameter_size ?? null,
      parameterCount: Math.trunc(parameterCount),
    };
  };

  const rerank = await inspect(rerankModel, 'rerank');
  const embedding = await inspect(embeddingModel, 'embedding');
  return { metadataCalls, ollama: { version }, rerank, embedding };
}

export function createTrackedProviderFetch({
  fetchImpl,
  rerankModel,
  embeddingModel,
}) {
  const counters = {
    rerankAttempts: 0,
    rerankSuccesses: 0,
    embeddingAttempts: 0,
    embeddingSuccesses: 0,
  };
  const trackedFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const isRerank = url.pathname === '/api/chat';
    const isEmbedding = url.pathname === '/api/embed';
    const expectedModel = isRerank
      ? rerankModel
      : isEmbedding ? embeddingModel : null;
    if (expectedModel) {
      const request = JSON.parse(String(init.body || '{}'));
      requireCondition(
        request.model === expectedModel,
        `${url.pathname} 请求模型被替换：${String(request.model)}`,
      );
      if (isRerank) counters.rerankAttempts += 1;
      if (isEmbedding) counters.embeddingAttempts += 1;
    }
    const response = await fetchImpl(input, init);
    if (expectedModel && response.ok) {
      let payload;
      try {
        payload = await response.clone().json();
      } catch (error) {
        throw new Error(`${url.pathname} 返回的 JSON 无法核验模型身份`, {
          cause: error,
        });
      }
      requireCondition(
        payload?.model === expectedModel,
        `${url.pathname} 实际返回模型与请求不一致`,
      );
      if (isRerank) counters.rerankSuccesses += 1;
      if (isEmbedding) counters.embeddingSuccesses += 1;
    }
    return response;
  };
  return {
    fetchImpl: trackedFetch,
    snapshot: () => ({ ...counters }),
  };
}

export async function createGateRanker({
  baseUrl,
  rerankModel,
  embeddingModel,
  fetchImpl,
  rankerFactory,
}) {
  const options = {
    baseUrl,
    embeddingModel,
    rerankModel,
    embedBatchSize: 64,
    rerankBatchSize: 16,
    timeoutMs: 120_000,
    cacheTtlMs: 0,
    fetchImpl,
  };
  if (rankerFactory) return rankerFactory(options);
  const { OllamaSemanticRanker } = await import(
    '../dist/server/semantic-ranker.js'
  );
  return new OllamaSemanticRanker(options);
}

export async function runEmbeddingProbe(ranker) {
  requireCondition(
    typeof ranker?.embedWithTelemetry === 'function',
    'ranker 缺少 embedWithTelemetry，不能生成真实 embedding 回执',
  );
  const started = performance.now();
  const operation = await ranker.embedWithTelemetry([
    '忆桥真实 embedding 身份与维度探针',
  ]);
  const wallDurationMs = Number((performance.now() - started).toFixed(3));
  requireCondition(operation?.result?.length === 1,
    'embedding 探针返回数量不正确');
  const vector = operation.result[0];
  requireCondition(
    vector && vector.length === REQUIRED_EMBED_DIMENSION,
    `embedding 探针维度必须为 ${REQUIRED_EMBED_DIMENSION}`,
  );
  requireCondition(
    [...vector].every((value) => Number.isFinite(Number(value))),
    'embedding 探针包含非法数值',
  );
  requireCondition(
    operation.telemetry?.route === 'model' &&
    Number(operation.telemetry.providerCalls) > 0,
    'embedding 探针没有真实 provider 遥测',
  );
  return {
    dimension: vector.length,
    wallDurationMs,
    telemetry: operation.telemetry,
  };
}

export function validateRerankDecisions(candidates, decisions) {
  if (!Array.isArray(decisions) || decisions.length !== candidates.length) {
    return false;
  }
  const expected = new Map(
    candidates.map((candidate) => [candidate.id, Boolean(candidate.relevant)]),
  );
  const seen = new Set();
  return decisions.every((decision) => {
    if (
      !expected.has(decision.id) ||
      seen.has(decision.id) ||
      expected.get(decision.id) !== decision.relevant ||
      !Number.isFinite(Number(decision.confidence)) ||
      Number(decision.confidence) < 0 ||
      Number(decision.confidence) > 1 ||
      typeof decision.reason !== 'string' ||
      decision.reason.length === 0
    ) {
      return false;
    }
    seen.add(decision.id);
    return true;
  });
}

function numericTelemetry(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) && Number(value) >= 0
    ? Number(value)
    : null;
}

export function summarizeRerankOperations(records) {
  const routeCounts = {
    deterministic_fast: 0,
    model: 0,
    cache: 0,
    unknown: 0,
  };
  const thermalStates = { cold: 0, warm: 0, unknown: 0 };
  let providerCalls = 0;
  let baseProviderCalls = 0;
  let firstCandidateConfirmationCalls = 0;
  let protocolRecoveryCalls = 0;
  let protocolRecoveryMaxDepth = 0;
  let parallelBatchCount = 0;
  let providerPeakActive = 0;
  let providerMaxConcurrency = 0;
  let completeModelTelemetry = true;
  let completeProviderConcurrencyTelemetry = true;
  let providerBreakdownMatches = true;
  const modelRows = [];
  for (const record of records) {
    const telemetry = record.operation?.telemetry || {};
    const route = Object.hasOwn(routeCounts, telemetry.route)
      ? telemetry.route
      : 'unknown';
    routeCounts[route] += 1;
    const calls = numericTelemetry(telemetry.providerCalls);
    const baseCalls = numericTelemetry(telemetry.baseProviderCalls) ?? 0;
    const confirmationCalls = numericTelemetry(
      telemetry.firstCandidateConfirmationCalls,
    ) ?? 0;
    const recoveryCalls = numericTelemetry(
      telemetry.protocolRecoveryCalls,
    ) ?? 0;
    if (calls === null) providerBreakdownMatches = false;
    providerCalls += calls ?? 0;
    baseProviderCalls += baseCalls;
    firstCandidateConfirmationCalls += confirmationCalls;
    protocolRecoveryCalls += recoveryCalls;
    protocolRecoveryMaxDepth = Math.max(
      protocolRecoveryMaxDepth,
      numericTelemetry(telemetry.protocolRecoveryMaxDepth) ?? 0,
    );
    parallelBatchCount += numericTelemetry(telemetry.parallelBatchCount) ?? 0;
    if (
      route === 'model' &&
      (calls === null || calls <= 0 ||
        baseCalls + confirmationCalls + recoveryCalls !== calls)
    ) {
      providerBreakdownMatches = false;
    }
    if (route !== 'model' && (calls ?? 0) !== 0) {
      providerBreakdownMatches = false;
    }
    if (route !== 'model') continue;
    const providerQueueWaitMs = numericTelemetry(
      telemetry.providerQueueWaitMs,
    );
    const operationPeakActive = numericTelemetry(
      telemetry.providerPeakActive,
    );
    const operationMaxConcurrency = numericTelemetry(
      telemetry.providerMaxConcurrency,
    );
    if (
      providerQueueWaitMs === null ||
      !Number.isInteger(operationPeakActive) ||
      operationPeakActive < 1 ||
      !Number.isInteger(operationMaxConcurrency) ||
      operationMaxConcurrency < 1 ||
      operationPeakActive > operationMaxConcurrency
    ) {
      completeProviderConcurrencyTelemetry = false;
    }
    providerPeakActive = Math.max(
      providerPeakActive,
      operationPeakActive ?? 0,
    );
    providerMaxConcurrency = Math.max(
      providerMaxConcurrency,
      operationMaxConcurrency ?? 0,
    );
    const model = telemetry.model;
    const state = Object.hasOwn(thermalStates, model?.thermalState)
      ? model.thermalState
      : 'unknown';
    thermalStates[state] += 1;
    const row = {
      totalDurationMs: numericTelemetry(model?.totalDurationMs),
      loadDurationMs: numericTelemetry(model?.loadDurationMs),
      promptEvalCount: numericTelemetry(model?.promptEvalCount),
      promptEvalDurationMs: numericTelemetry(model?.promptEvalDurationMs),
      evalCount: numericTelemetry(model?.evalCount),
      evalDurationMs: numericTelemetry(model?.evalDurationMs),
      providerQueueWaitMs,
      providerPeakActive: operationPeakActive,
      providerMaxConcurrency: operationMaxConcurrency,
    };
    if (
      state === 'unknown' ||
      Object.values(row).some((value) => value === null)
    ) {
      completeModelTelemetry = false;
    }
    modelRows.push(row);
  }
  const distribution = (key) => telemetryDistribution(
    modelRows.map((row) => row[key]).filter((value) => value !== null),
  );
  return {
    operationCount: records.length,
    routeCounts,
    providerCalls,
    baseProviderCalls,
    firstCandidateConfirmationCalls,
    protocolRecoveryCalls,
    protocolRecoveryMaxDepth,
    parallelBatchCount,
    providerQueueWaitMs: telemetryDistribution(
      modelRows.map((row) => row.providerQueueWaitMs),
    ),
    providerPeakActive,
    providerMaxConcurrency,
    providerPeakActiveDistribution: telemetryDistribution(
      modelRows.map((row) => row.providerPeakActive),
    ),
    providerMaxConcurrencyDistribution: telemetryDistribution(
      modelRows.map((row) => row.providerMaxConcurrency),
    ),
    providerBreakdownMatches,
    completeModelTelemetry,
    completeProviderConcurrencyTelemetry,
    thermalStates,
    requestDurationMs: telemetryDistribution(
      records.map((record) =>
        numericTelemetry(record.operation?.telemetry?.requestDurationMs)),
    ),
    providerDurationMs: telemetryDistribution(
      records.map((record) =>
        numericTelemetry(record.operation?.telemetry?.providerDurationMs)),
    ),
    modelTelemetry: {
      totalDurationMs: distribution('totalDurationMs'),
      loadDurationMs: distribution('loadDurationMs'),
      promptTokens: distribution('promptEvalCount'),
      promptEvalDurationMs: distribution('promptEvalDurationMs'),
      outputTokens: distribution('evalCount'),
      outputEvalDurationMs: distribution('evalDurationMs'),
    },
  };
}

export function benchmarkCaseVariant(baseCase, phase, index) {
  const variantId = `${phase}-${String(index + 1).padStart(2, '0')}`;
  const candidates = [...baseCase.candidates];
  const permutationIndex = phase === 'measured' ? index + 2 : index;
  const reverse = Math.floor(permutationIndex / candidates.length) % 2 === 1;
  const ordered = reverse ? candidates.reverse() : candidates;
  const offset = permutationIndex % ordered.length;
  return {
    variantId,
    query: baseCase.query,
    candidates: [...ordered.slice(offset), ...ordered.slice(0, offset)],
  };
}

export async function cleanupRerankModel({
  requested,
  baseUrl,
  rerankModel,
  fetchImpl,
}) {
  if (!requested) {
    return {
      requested: false,
      attempted: false,
      succeeded: null,
      status: 'not_requested',
    };
  }
  try {
    const response = await fetchImpl(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: rerankModel,
        prompt: '',
        stream: false,
        keep_alive: 0,
      }),
    });
    return {
      requested: true,
      attempted: true,
      succeeded: Boolean(response?.ok),
      status: response?.ok ? 'succeeded' : `http_${response?.status || 0}`,
    };
  } catch (error) {
    return {
      requested: true,
      attempted: true,
      succeeded: false,
      status: 'transport_error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function falseChecks(checks) {
  return Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
}

export async function runRerankBenchmark(options = {}) {
  const config = resolveRerankGateConfig(
    options.env ?? process.env,
    options,
  );
  const evidenceMode = rerankGateEvidenceMode(options, arguments.length);
  const rawFetch = options.fetchImpl ?? globalThis.fetch;
  const identity = await verifyOllamaModelIdentity({
    ...config,
    fetchImpl: rawFetch,
  });
  const tracker = createTrackedProviderFetch({
    fetchImpl: rawFetch,
    rerankModel: config.rerankModel,
    embeddingModel: config.embeddingModel,
  });
  const ranker = await createGateRanker({
    ...config,
    fetchImpl: tracker.fetchImpl,
    rankerFactory: options.rankerFactory,
  });
  requireCondition(typeof ranker?.rerankWithTelemetry === 'function',
    'ranker 缺少 rerankWithTelemetry');
  const embeddingProbe = await runEmbeddingProbe(ranker);
  const selectedCase = options.benchmarkCase ?? rerankBenchmarkCase;
  const warmupRecords = [];
  const measuredRecords = [];
  const correctnessFailures = [];
  const execute = async (phase, index) => {
    const variant = benchmarkCaseVariant(selectedCase, phase, index);
    const started = performance.now();
    const operation = await ranker.rerankWithTelemetry(
      variant.query,
      variant.candidates.map(({ id, memory }) => ({ id, memory })),
    );
    const elapsedMs = Number((performance.now() - started).toFixed(3));
    if (!validateRerankDecisions(variant.candidates, operation.result)) {
      correctnessFailures.push({ phase, index, decisions: operation.result });
    }
    return {
      phase,
      index,
      variantId: variant.variantId,
      promptIdentity: JSON.stringify({
        query: variant.query,
        candidates: variant.candidates.map(({ id, memory }) => ({
          id,
          memory,
        })),
      }),
      elapsedMs,
      operation,
    };
  };
  for (let index = 0; index < config.warmupCount; index += 1) {
    warmupRecords.push(await execute('warmup', index));
  }
  for (let index = 0; index < config.sampleCount; index += 1) {
    measuredRecords.push(await execute('measured', index));
  }
  const warmupTelemetry = summarizeRerankOperations(warmupRecords);
  const measuredTelemetry = summarizeRerankOperations(measuredRecords);
  const combinedTelemetry = summarizeRerankOperations([
    ...warmupRecords,
    ...measuredRecords,
  ]);
  const providerObservation = tracker.snapshot();
  const measurements = telemetryDistribution(
    measuredRecords.map((record) => record.elapsedMs),
  );
  const uniqueMeasuredVariants = new Set(
    measuredRecords.map((record) => record.promptIdentity),
  ).size;
  const benchmarkLoad = inspectRerankBenchmarkLoad(selectedCase);
  const benchmarkFixtureSha256 = rerankBenchmarkFixtureSha256(selectedCase);
  const benchmarkFixtureLocked =
    benchmarkFixtureSha256 === RERANK_BENCHMARK_FIXTURE_SHA256;
  const checks = {
    defaultBenchmarkProfile:
      selectedCase === rerankBenchmarkCase &&
      config.sampleCount === DEFAULT_RERANK_BENCH_SAMPLES &&
      config.warmupCount === DEFAULT_WARMUP_COUNT &&
      benchmarkLoad.matchesProductionDefinition &&
      benchmarkFixtureLocked,
    benchmarkFixtureLocked,
    exactRerankModel: identity.rerank.resolved === REQUIRED_RERANK_MODEL,
    exactEmbeddingModel:
      identity.embedding.resolved === REQUIRED_EMBED_MODEL,
    embeddingProbeUsedProvider:
      embeddingProbe.telemetry.providerCalls > 0 &&
      providerObservation.embeddingSuccesses ===
        embeddingProbe.telemetry.providerCalls,
    embeddingDimensionExact:
      embeddingProbe.dimension === REQUIRED_EMBED_DIMENSION,
    measuredPromptsAreUnique:
      uniqueMeasuredVariants === config.sampleCount,
    atLeastTwentyUniqueMeasuredPrompts:
      config.sampleCount >=
        RERANK_BENCHMARK_LOAD.minimumUniqueMeasuredPrompts &&
      uniqueMeasuredVariants >=
        RERANK_BENCHMARK_LOAD.minimumUniqueMeasuredPrompts,
    allDecisionsCorrect: correctnessFailures.length === 0,
    allMeasuredRequestsUsedModel:
      measuredTelemetry.routeCounts.model === config.sampleCount &&
      measuredTelemetry.routeCounts.deterministic_fast === 0 &&
      measuredTelemetry.routeCounts.cache === 0,
    providerTelemetryComplete:
      measuredTelemetry.completeModelTelemetry &&
      measuredTelemetry.completeProviderConcurrencyTelemetry &&
      measuredTelemetry.providerBreakdownMatches,
    physicalProviderCallsMatchTelemetry:
      providerObservation.rerankAttempts === combinedTelemetry.providerCalls &&
      providerObservation.rerankSuccesses === combinedTelemetry.providerCalls,
    p95WithinThreshold:
      measurements.p95 !== null &&
      measurements.p95 <= config.thresholdP95Ms,
  };
  const cleanup = await cleanupRerankModel({
    requested: config.cleanupRequested,
    ...config,
    fetchImpl: rawFetch,
  });
  const checksPassed = falseChecks(checks).length === 0;
  const passed = checksPassed && evidenceMode === 'real_ollama';
  return {
    format: 'memory-bridge-rerank-benchmark:v3',
    passed,
    checksPassed,
    evidenceMode,
    failureReasons: [
      ...falseChecks(checks),
      ...(evidenceMode === 'real_ollama'
        ? []
        : ['test_injected_evidence_not_publishable']),
    ],
    checks,
    modelIdentity: identity,
    embeddingProbe,
    benchmarkLoad,
    benchmarkFixtureSha256,
    candidateCount: selectedCase.candidates.length,
    warmupCount: config.warmupCount,
    sampleCount: config.sampleCount,
    thresholdP95Ms: config.thresholdP95Ms,
    measurements: {
      ...measurements,
      samplesMs: measuredRecords.map((record) => record.elapsedMs),
      uniquePromptVariants: uniqueMeasuredVariants,
    },
    telemetry: {
      warmup: warmupTelemetry,
      measured: measuredTelemetry,
      combined: combinedTelemetry,
    },
    providerObservation,
    correctnessFailures,
    cacheEnabled: false,
    cleanup,
  };
}

function failureReport(error) {
  return {
    format: 'memory-bridge-rerank-benchmark:v3',
    passed: false,
    checksPassed: false,
    evidenceMode: rerankGateEvidenceMode({}, 0),
    failureReasons: ['gate_execution_error'],
    error: error instanceof Error ? error.message : String(error),
  };
}

const directExecution = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (directExecution) {
  try {
    const report = await runRerankBenchmark();
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify(failureReport(error), null, 2));
    process.exitCode = 1;
  }
}
