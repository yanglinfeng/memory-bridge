import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  REQUIRED_EMBED_MODEL,
  REQUIRED_EMBED_DIMENSION,
  REQUIRED_RERANK_MODEL,
  RERANK_THRESHOLD_P95_MS,
  cleanupRerankModel,
  createGateRanker,
  createTrackedProviderFetch,
  resolveRerankGateConfig,
  rerankGateEvidenceMode,
  runEmbeddingProbe,
  summarizeRerankOperations,
  telemetryDistribution,
  validateRerankDecisions,
  verifyOllamaModelIdentity,
} from './benchmark-rerank.mjs';
import { semanticQualityCases } from './semantic-quality-cases.mjs';

const defaultHoldout = JSON.parse(fs.readFileSync(
  new URL(
    './fixtures/semantic-reranker-holdout-v1.json',
    import.meta.url,
  ),
  'utf8',
));

export const modelRouteCoverageCases = [
  {
    id: 'pre-task-map',
    query: '小林开始复杂任务前会先做什么？',
    relevant: '小林开始复杂任务前会先画一张流程图。',
    irrelevant: '小林完成复杂任务后会出门散步。',
  },
  {
    id: 'offline-ideas',
    query: '阿青断网时怎样记录突然想到的灵感？',
    relevant: '阿青断网时会把灵感写进随身的纸质本。',
    irrelevant: '阿青联网后会更新手机里的天气应用。',
  },
  {
    id: 'team-disagreement',
    query: '陈禾遇到团队分歧时首先做什么？',
    relevant: '陈禾遇到团队分歧时会先复述双方的观点。',
    irrelevant: '陈禾会在会议结束后归档会议室照片。',
  },
  {
    id: 'changed-trip',
    query: '小陆的行程临时改变后会怎样重新安排？',
    relevant: '行程临时改变后，小陆会按地点距离重新排序。',
    irrelevant: '出发前，小陆会把车票打印出来。',
  },
  {
    id: 'book-review',
    query: '周宁读完专业书后怎样巩固内容？',
    relevant: '周宁读完专业书后会写一页摘要来巩固内容。',
    irrelevant: '周宁买专业书时通常使用电子支付。',
  },
  {
    id: 'speech-practice',
    query: '林岚准备公开演讲时怎样检查表达？',
    relevant: '林岚准备公开演讲时会录音并回听自己的表达。',
    irrelevant: '林岚演讲结束后会把胸卡交还给主办方。',
  },
  {
    id: 'incident-first-step',
    query: '贺明定位线上故障时先检查什么？',
    relevant: '贺明定位线上故障时会先检查最近一次变更。',
    irrelevant: '贺明在故障恢复后会补充值班文档。',
  },
  {
    id: 'unclear-requirement',
    query: '夏禾收到模糊需求后怎样确认边界？',
    relevant: '夏禾收到模糊需求后会先写出反例确认边界。',
    irrelevant: '夏禾交付需求后会整理工时记录。',
  },
  {
    id: 'new-framework',
    query: '顾南学习新框架时怎样验证自己真的理解了？',
    relevant: '顾南学习新框架时会做一个最小项目验证理解。',
    irrelevant: '顾南给代码编辑器下载了新的配色主题。',
  },
  {
    id: 'focus-break',
    query: '江晨安排高强度工作时怎样穿插休息？',
    relevant: '江晨高强度工作时每九十分钟会离开屏幕休息。',
    irrelevant: '江晨周末会去公园慢跑。',
  },
];

export const RERANK_QUALITY_PROFILE = Object.freeze({
  fixedCases: 18,
  coverageCases: 10,
  holdoutCases: 20,
  setCalibrationCases: 9,
  rounds: 3,
  evaluatedRequests: 171,
  minimumModelRouteRequests: 30,
});

export const RERANK_QUALITY_FIXTURE_SHA256 = Object.freeze({
  fixed: 'f08fe0f03d7f2d0ac1c149530f8c5149866e139383fcfe6c79dca2fbc3a3fef9',
  coverage: 'c2add7d939e49db58378f2f85f1c3cc0c9060075ea47a3593a3ad6c0bf508d42',
  holdout: '817160caa212df3a2870bb8db42f4d89ec54ecfab01c36b70dbdf5575f4ae5de',
  setCalibration:
    '53db659afe38d3588cd29e1dc7036c68625591261f297a0fcf7d47d0d6f4e3b3',
});

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function qualityRounds(env, override) {
  const parsed = Number(override ?? env.RERANK_QUALITY_ROUNDS);
  return override === undefined
    ? Math.max(3, Number.isFinite(parsed) ? Math.trunc(parsed) : 3)
    : Math.max(1, Number.isFinite(parsed) ? Math.trunc(parsed) : 1);
}

function falseChecks(checks) {
  return Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
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

function fixtureSha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function uniqueNonEmpty(values) {
  return values.every((value) =>
    typeof value === 'string' && value.length > 0
  ) && new Set(values).size === values.length;
}

function orderedCandidates(fixture, permutation) {
  const candidates = [
    { id: 'relevant', memory: fixture.relevant, relevant: true },
    { id: 'irrelevant', memory: fixture.irrelevant, relevant: false },
  ];
  return permutation === 'forward' ? candidates : [...candidates].reverse();
}

function holdoutCandidates(fixture, permutation) {
  const candidates = [
    ...fixture.relevant.map((memory, index) => ({
      id: `relevant-${index}`,
      memory,
      relevant: true,
    })),
    ...fixture.irrelevant.map((memory, index) => ({
      id: `irrelevant-${index}`,
      memory,
      relevant: false,
    })),
  ];
  return permutation === 'forward' ? candidates : [...candidates].reverse();
}

export async function runRerankerQualityGate(options = {}) {
  const env = options.env ?? process.env;
  const rounds = qualityRounds(env, options.rounds);
  const config = resolveRerankGateConfig(env, options);
  const evidenceMode = rerankGateEvidenceMode(options, arguments.length);
  const rawFetch = options.fetchImpl ?? globalThis.fetch;
  const fixedCases = options.fixedCases ?? semanticQualityCases;
  const holdout = options.holdout ?? defaultHoldout;
  const coverageCases = options.coverageCases ?? modelRouteCoverageCases;
  const fixtureSha256s = {
    fixed: fixtureSha256(fixedCases),
    coverage: fixtureSha256(coverageCases),
    holdout: fixtureSha256(holdout.cases),
    setCalibration: fixtureSha256(holdout.setCalibration),
  };
  const exactFixtureCounts =
    fixedCases.length === RERANK_QUALITY_PROFILE.fixedCases &&
    coverageCases.length === RERANK_QUALITY_PROFILE.coverageCases &&
    holdout.cases.length === RERANK_QUALITY_PROFILE.holdoutCases &&
    holdout.setCalibration.length ===
      RERANK_QUALITY_PROFILE.setCalibrationCases;
  const fixtureDigestsLocked = Object.entries(
    RERANK_QUALITY_FIXTURE_SHA256,
  ).every(([name, digest]) => fixtureSha256s[name] === digest);
  const fixtureIdsUnique =
    uniqueNonEmpty(fixedCases.map((fixture) => fixture.query)) &&
    uniqueNonEmpty(coverageCases.map((fixture) => fixture.id)) &&
    uniqueNonEmpty(holdout.cases.map((fixture) => fixture.query)) &&
    uniqueNonEmpty(holdout.setCalibration.map((fixture) => fixture.id)) &&
    holdout.setCalibration.every((fixture) =>
      uniqueNonEmpty(fixture.candidates.map((candidate) => candidate.id))
    );
  const minimumModelRouteRequests = Math.max(
    1,
    Number.isFinite(Number(options.minimumModelRouteRequests))
      ? Math.trunc(Number(options.minimumModelRouteRequests))
      : coverageCases.length * rounds,
  );
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
  const records = [];
  const failures = [];

  const verifyCandidates = async ({ suite, caseId, query, candidates }) => {
    const started = performance.now();
    const operation = await ranker.rerankWithTelemetry(
      query,
      candidates.map(({ id, memory }) => ({ id, memory })),
    );
    const elapsedMs = Number((performance.now() - started).toFixed(3));
    const passed = validateRerankDecisions(candidates, operation.result);
    const record = { suite, caseId, elapsedMs, operation };
    records.push(record);
    if (!passed) {
      failures.push({
        suite,
        case: caseId,
        route: operation.telemetry?.route ?? 'unknown',
        decisions: operation.result,
      });
    }
  };

  for (let round = 0; round < rounds; round += 1) {
    const permutation = round % 2 === 0 ? 'forward' : 'reverse';
    for (let index = 0; index < fixedCases.length; index += 1) {
      const fixture = fixedCases[index];
      await verifyCandidates({
        suite: 'fixed',
        caseId: `${round}:${index}:${permutation}`,
        query: fixture.query,
        candidates: orderedCandidates(fixture, permutation),
      });
    }
    for (let index = 0; index < coverageCases.length; index += 1) {
      const fixture = coverageCases[index];
      await verifyCandidates({
        suite: 'model-route-coverage',
        caseId: `${round}:${fixture.id}:${permutation}`,
        query: fixture.query,
        candidates: orderedCandidates(fixture, permutation),
      });
    }
  }

  for (let index = 0; index < holdout.cases.length; index += 1) {
    const fixture = holdout.cases[index];
    for (let round = 0; round < rounds; round += 1) {
      const permutation = round % 2 === 0 ? 'forward' : 'reverse';
      await verifyCandidates({
        suite: 'holdout',
        caseId: `${round}:${index}:${permutation}`,
        query: fixture.query,
        candidates: holdoutCandidates(fixture, permutation),
      });
    }
  }

  for (const fixture of holdout.setCalibration) {
    for (let round = 0; round < rounds; round += 1) {
      const permutation = round % 2 === 0 ? 'forward' : 'reverse';
      const candidates = permutation === 'forward'
        ? fixture.candidates
        : [...fixture.candidates].reverse();
      await verifyCandidates({
        suite: 'set-calibration',
        caseId: `${round}:${fixture.id}:${permutation}`,
        query: fixture.query,
        candidates,
      });
    }
  }

  const telemetry = summarizeRerankOperations(records);
  const modelRouteRecords = records.filter(
    (record) => record.operation.telemetry?.route === 'model',
  );
  const coverageRecords = records.filter(
    (record) => record.suite === 'model-route-coverage',
  );
  const measurements = {
    allRequests: telemetryDistribution(
      records.map((record) => record.elapsedMs),
    ),
    modelRoute: telemetryDistribution(
      modelRouteRecords.map((record) => record.elapsedMs),
    ),
  };
  const providerObservation = tracker.snapshot();
  const suiteNames = [
    'fixed',
    'model-route-coverage',
    'holdout',
    'set-calibration',
  ];
  const suiteFailures = Object.fromEntries(
    suiteNames.map((suite) => [
      suite,
      failures.filter((failure) => failure.suite === suite).length,
    ]),
  );
  const checks = {
    defaultQualityProfile:
      rounds === RERANK_QUALITY_PROFILE.rounds &&
      exactFixtureCounts &&
      fixtureDigestsLocked &&
      fixtureIdsUnique &&
      records.length === RERANK_QUALITY_PROFILE.evaluatedRequests &&
      minimumModelRouteRequests ===
        RERANK_QUALITY_PROFILE.minimumModelRouteRequests,
    exactFixtureCounts,
    fixtureDigestsLocked,
    fixtureIdsUnique,
    exactEvaluatedRequests:
      records.length === RERANK_QUALITY_PROFILE.evaluatedRequests,
    exactRerankModel: identity.rerank.resolved === REQUIRED_RERANK_MODEL,
    exactEmbeddingModel:
      identity.embedding.resolved === REQUIRED_EMBED_MODEL,
    embeddingProbeUsedProvider:
      embeddingProbe.telemetry.providerCalls > 0 &&
      providerObservation.embeddingSuccesses ===
        embeddingProbe.telemetry.providerCalls,
    embeddingDimensionExact:
      embeddingProbe.dimension === REQUIRED_EMBED_DIMENSION,
    allDecisionsCorrect: failures.length === 0,
    everyCoverageCaseUsedModel:
      coverageRecords.length === coverageCases.length * rounds &&
      coverageRecords.every(
        (record) => record.operation.telemetry?.route === 'model',
      ),
    sufficientModelRouteCoverage:
      minimumModelRouteRequests ===
        RERANK_QUALITY_PROFILE.minimumModelRouteRequests &&
      telemetry.routeCounts.model >= minimumModelRouteRequests &&
      telemetry.providerCalls >= minimumModelRouteRequests,
    cacheDidNotMaskProvider: telemetry.routeCounts.cache === 0,
    providerTelemetryComplete:
      telemetry.completeModelTelemetry &&
      telemetry.completeProviderConcurrencyTelemetry &&
      telemetry.providerBreakdownMatches,
    physicalProviderCallsMatchTelemetry:
      providerObservation.rerankAttempts === telemetry.providerCalls &&
      providerObservation.rerankSuccesses === telemetry.providerCalls,
    modelRouteP95WithinThreshold:
      measurements.modelRoute.p95 !== null &&
      measurements.modelRoute.p95 <= RERANK_THRESHOLD_P95_MS,
  };
  const cleanup = await cleanupRerankModel({
    requested: config.cleanupRequested,
    ...config,
    fetchImpl: rawFetch,
  });
  const checksPassed = falseChecks(checks).length === 0;
  const passed = checksPassed && evidenceMode === 'real_ollama';
  return {
    format: 'memory-bridge-reranker-quality:v3',
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
    rounds,
    casesPerRound: fixedCases.length,
    modelRouteCoverageCases: coverageCases.length,
    holdoutCases: holdout.cases.length,
    setCalibrationCases: holdout.setCalibration.length,
    fixtureSha256: fixtureSha256s,
    evaluatedRequests: records.length,
    minimumModelRouteRequests,
    providerCallsMeasured: telemetry.providerCalls,
    expectedPasses: records.length,
    actualPasses: records.length - failures.length,
    suiteFailures,
    failures,
    thresholdP95Ms: RERANK_THRESHOLD_P95_MS,
    measurements,
    telemetry,
    providerObservation,
    cacheEnabled: false,
    cleanup,
  };
}

function failureReport(error) {
  return {
    format: 'memory-bridge-reranker-quality:v3',
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
    const report = await runRerankerQualityGate();
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify(failureReport(error), null, 2));
    process.exitCode = 1;
  }
}
