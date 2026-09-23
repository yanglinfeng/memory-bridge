import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_RERANK_BENCH_SAMPLES,
  REQUIRED_EMBED_DIMENSION,
  REQUIRED_EMBED_MODEL,
  REQUIRED_EMBED_MODEL_DIGEST,
  REQUIRED_RERANK_MODEL,
  REQUIRED_RERANK_MODEL_DIGEST,
  RERANK_BENCHMARK_FIXTURE_SHA256,
  RERANK_BENCHMARK_LOAD,
  RERANK_BENCHMARK_QUERY,
  RERANK_THRESHOLD_P95_MS,
  benchmarkCaseVariant,
  inspectRerankBenchmarkLoad,
  rerankBenchmarkCase,
  rerankBenchmarkFixtureSha256,
  rerankGateEvidenceMode,
  resolveRerankGateConfig,
  runRerankBenchmark,
  verifyOllamaModelIdentity,
} from '../scripts/benchmark-rerank.mjs';
import {
  RERANK_QUALITY_FIXTURE_SHA256,
  RERANK_QUALITY_PROFILE,
  runRerankerQualityGate,
} from '../scripts/verify-reranker-quality.mjs';

const EXPECTED_RERANK_BENCHMARK_FIXTURE_SHA256 =
  '4fb9e079491f1117118650224577d3dd6bc4ea0cc0e36bb44eaad194f099f6c8';
const EXPECTED_RERANK_QUALITY_FIXTURE_SHA256 = Object.freeze({
  fixed: 'f08fe0f03d7f2d0ac1c149530f8c5149866e139383fcfe6c79dca2fbc3a3fef9',
  coverage: 'c2add7d939e49db58378f2f85f1c3cc0c9060075ea47a3593a3ad6c0bf508d42',
  holdout: '817160caa212df3a2870bb8db42f4d89ec54ecfab01c36b70dbdf5575f4ae5de',
  setCalibration:
    '53db659afe38d3588cd29e1dc7036c68625591261f297a0fcf7d47d0d6f4e3b3',
});

const embeddingFixtureVector = Array.from(
  { length: REQUIRED_EMBED_DIMENSION },
  (_, index) => (index + 1) / REQUIRED_EMBED_DIMENSION,
);

function parseRerankProviderPayload(content) {
  const payload = JSON.parse(content);
  assert.deepEqual(Object.keys(payload), ['q', 'm']);
  assert.equal(typeof payload.q, 'string');
  assert.ok(Array.isArray(payload.m));
  for (const [position, tuple] of payload.m.entries()) {
    assert.ok(Array.isArray(tuple));
    assert.equal(tuple.length, 2);
    assert.equal(tuple[0], position);
    assert.equal(typeof tuple[1], 'string');
  }
  return payload;
}

function ollamaFixture({
  rerankDigest = REQUIRED_RERANK_MODEL_DIGEST,
  embeddingDigest = REQUIRED_EMBED_MODEL_DIGEST,
  rerankFamily = 'qwen2',
  embeddingFamily = 'bert',
} = {}) {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ pathname: url.pathname, body });
    if (url.pathname === '/api/version') {
      return Response.json({ version: '0.31.1-test' });
    }
    if (url.pathname === '/api/tags') {
      return Response.json({
        models: [
          {
            name: REQUIRED_RERANK_MODEL,
            model: REQUIRED_RERANK_MODEL,
            digest: rerankDigest,
            details: { family: rerankFamily, parameter_size: '14.8B' },
          },
          {
            name: REQUIRED_EMBED_MODEL,
            model: REQUIRED_EMBED_MODEL,
            digest: embeddingDigest,
            details: { family: embeddingFamily, parameter_size: '566.7M' },
          },
        ],
      });
    }
    if (url.pathname === '/api/show') {
      const parameterCount = body.model === REQUIRED_RERANK_MODEL
        ? 14_800_000_000
        : 566_700_000;
      return Response.json({
        details: {
          family: body.model === REQUIRED_RERANK_MODEL
            ? rerankFamily
            : embeddingFamily,
          parameter_size:
            body.model === REQUIRED_RERANK_MODEL ? '14.8B' : '566.7M',
        },
        model_info: { 'general.parameter_count': parameterCount },
      });
    }
    if (url.pathname === '/api/embed') {
      return Response.json({
        model: REQUIRED_EMBED_MODEL,
        embeddings: [embeddingFixtureVector],
      });
    }
    if (url.pathname === '/api/chat') {
      const userPayload = body.messages?.[1]?.content
        ? parseRerankProviderPayload(body.messages[1].content)
        : null;
      const relevantIndexes = Array.isArray(userPayload?.m)
        ? userPayload.m
          .filter(([, memory]) =>
            /(?:流程图|列出依赖和风险)/u.test(memory)
          )
          .map(([index]) => index)
        : [];
      return Response.json({
        model: REQUIRED_RERANK_MODEL,
        message: {
          content: JSON.stringify(relevantIndexes),
        },
        total_duration: 750_000,
        load_duration: 10_000,
        prompt_eval_count: 64,
        prompt_eval_duration: 400_000,
        eval_count: 8,
        eval_duration: 200_000,
      });
    }
    if (url.pathname === '/api/generate') {
      return Response.json({ model: REQUIRED_RERANK_MODEL, done: true });
    }
    return new Response('not found', { status: 404 });
  };
  return { requests, fetchImpl };
}

function modelTelemetry({ providerCalls = 1 } = {}) {
  return {
    route: 'model',
    providerCalls,
    baseProviderCalls: providerCalls,
    firstCandidateConfirmationCalls: 0,
    protocolRecoveryCalls: 0,
    protocolRecoveryMaxDepth: 0,
    parallelBatchCount: 1,
    providerQueueWaitMs: 0.05,
    providerPeakActive: 1,
    providerMaxConcurrency: 1,
    cacheHit: false,
    singleFlightShared: false,
    keyFingerprint: 'fixture',
    requestDurationMs: 1,
    providerDurationMs: 0.8,
    model: {
      totalDurationMs: 0.75,
      loadDurationMs: 0.01,
      promptEvalCount: 64,
      promptEvalDurationMs: 0.4,
      evalCount: 8,
      evalDurationMs: 0.2,
      thermalState: 'warm',
    },
  };
}

function fakeRankerFactory({
  callRerankProvider = true,
  deterministic = false,
  embeddingDimension = REQUIRED_EMBED_DIMENSION,
  omitProviderConcurrencyTelemetry = false,
} = {}) {
  const relevantIds = new Set([
    'relevant',
    'relevant-0',
    'plan-overview',
    'list-risks',
    'three-sentences',
    'one-hundred-characters',
    'user-pet',
    'user-job',
    'user-fruit',
    'team-meeting',
    'user-editor',
  ]);
  return (options) => ({
    async embedWithTelemetry() {
      await options.fetchImpl(`${options.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.embeddingModel,
          input: ['probe'],
        }),
      });
      return {
        result: [Float32Array.from(
          embeddingFixtureVector.slice(0, embeddingDimension),
        )],
        telemetry: {
          ...modelTelemetry(),
          baseProviderCalls: undefined,
          parallelBatchCount: undefined,
        },
      };
    },
    async rerankWithTelemetry(...args) {
      assert.equal(args.length, 2);
      const [_query, candidates] = args;
      assert.equal(typeof _query, 'string');
      for (const candidate of candidates) {
        assert.deepEqual(Object.keys(candidate).sort(), ['id', 'memory']);
      }
      if (callRerankProvider) {
        await options.fetchImpl(`${options.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: options.rerankModel,
            messages: [],
          }),
        });
      }
      const telemetry = deterministic
        ? {
          route: 'deterministic_fast',
          providerCalls: 0,
          baseProviderCalls: 0,
          firstCandidateConfirmationCalls: 0,
          protocolRecoveryCalls: 0,
          protocolRecoveryMaxDepth: 0,
          parallelBatchCount: 0,
          cacheHit: false,
          singleFlightShared: false,
          keyFingerprint: 'deterministic-fixture',
          requestDurationMs: 0.1,
          providerDurationMs: null,
          model: null,
        }
        : modelTelemetry();
      if (omitProviderConcurrencyTelemetry) {
        delete telemetry.providerQueueWaitMs;
        delete telemetry.providerPeakActive;
        delete telemetry.providerMaxConcurrency;
      }
      return {
        result: candidates.map((candidate) => ({
          id: candidate.id,
          relevant: relevantIds.has(candidate.id),
          confidence: 0.95,
          reason: deterministic ? 'deterministic_fixture' : 'model_fixture',
        })),
        telemetry,
      };
    },
  });
}

test('20 个性能样本只改变候选顺序而不污染查询或记忆正文', () => {
  const load = inspectRerankBenchmarkLoad(rerankBenchmarkCase);
  assert.equal(rerankBenchmarkCase.query, RERANK_BENCHMARK_QUERY);
  assert.equal(load.queryCharacters, RERANK_BENCHMARK_LOAD.queryCharacters);
  assert.equal(load.queryCharacters, 128);
  assert.equal(load.candidateCount, 16);
  assert.equal(load.candidateCharacters, 640);
  assert.equal(load.atomicCandidates, 4);
  assert.equal(load.episodeCandidates, 12);
  assert.equal(load.allCandidatesUseProductionShape, true);
  assert.equal(load.matchesProductionDefinition, true);
  assert.equal(
    rerankBenchmarkFixtureSha256(rerankBenchmarkCase),
    EXPECTED_RERANK_BENCHMARK_FIXTURE_SHA256,
  );
  assert.equal(
    RERANK_BENCHMARK_FIXTURE_SHA256,
    EXPECTED_RERANK_BENCHMARK_FIXTURE_SHA256,
  );
  assert.equal(Object.isFrozen(rerankBenchmarkCase), true);
  assert.equal(Object.isFrozen(rerankBenchmarkCase.candidates), true);
  assert.equal(Object.isFrozen(rerankBenchmarkCase.candidates[0]), true);
  assert.throws(() => {
    rerankBenchmarkCase.candidates[0].relevant = false;
  }, TypeError);
  const tampered = structuredClone(rerankBenchmarkCase);
  tampered.candidates[0].relevant = false;
  assert.equal(
    inspectRerankBenchmarkLoad(tampered).matchesProductionDefinition,
    true,
  );
  assert.notEqual(
    rerankBenchmarkFixtureSha256(tampered),
    RERANK_BENCHMARK_FIXTURE_SHA256,
  );
  const warmups = Array.from({ length: 2 }, (_, index) =>
    benchmarkCaseVariant(rerankBenchmarkCase, 'warmup', index)
  );
  const variants = Array.from({ length: 20 }, (_, index) =>
    benchmarkCaseVariant(rerankBenchmarkCase, 'measured', index)
  );
  assert.equal(
    new Set([...warmups, ...variants].map((variant) =>
      JSON.stringify(variant.candidates)
    ))
      .size,
    22,
  );
  for (const variant of variants) {
    assert.equal(variant.query, rerankBenchmarkCase.query);
    assert.deepEqual(
      [...variant.candidates].sort((left, right) =>
        left.id.localeCompare(right.id)
      ).map(({ id, memory, relevant }) => ({ id, memory, relevant })),
      [...rerankBenchmarkCase.candidates].sort((left, right) =>
        left.id.localeCompare(right.id)
      ).map(({ id, memory, relevant }) => ({ id, memory, relevant })),
    );
  }
});

test('默认 benchmark 的 query、字符范围或候选形态变化会失去生产负载资格', () => {
  const wrongQuery = inspectRerankBenchmarkLoad({
    ...rerankBenchmarkCase,
    query: `${rerankBenchmarkCase.query}额外提示`,
  });
  const lightPayload = inspectRerankBenchmarkLoad({
    ...rerankBenchmarkCase,
    candidates: rerankBenchmarkCase.candidates.map((candidate) => ({
      ...candidate,
      memory: '过短候选',
    })),
  });
  assert.equal(wrongQuery.matchesProductionDefinition, false);
  assert.equal(lightPayload.matchesProductionDefinition, false);
  assert.equal(lightPayload.allCandidatesUseProductionShape, false);
});

test('真实重排门禁默认固定 14B、bge-m3、20 样本且不卸载', () => {
  const config = resolveRerankGateConfig({});
  assert.equal(config.rerankModel, REQUIRED_RERANK_MODEL);
  assert.equal(config.embeddingModel, REQUIRED_EMBED_MODEL);
  assert.equal(config.sampleCount, DEFAULT_RERANK_BENCH_SAMPLES);
  assert.equal(config.sampleCount >= 10, true);
  assert.equal(config.thresholdP95Ms, 1_500);
  assert.equal(RERANK_THRESHOLD_P95_MS, 1_500);
  assert.equal(
    resolveRerankGateConfig({}, { thresholdP95Ms: 99_999 })
      .thresholdP95Ms,
    1_500,
  );
  assert.equal(config.cleanupRequested, false);
  assert.equal(rerankGateEvidenceMode({}, 0), 'test_injected');
  assert.equal(rerankGateEvidenceMode({}, 1), 'test_injected');
  assert.equal(
    rerankGateEvidenceMode({ sampleCount: 20 }, 1),
    'test_injected',
  );
});

test('启动 preload 无法把注入 fetch 冒充为真实门禁证据', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rerank-preload-'));
  try {
    const preloadMjs = path.join(directory, 'preload.mjs');
    const preloadCjs = path.join(directory, 'preload.cjs');
    const scrubPreloadMjs = path.join(directory, 'scrub-preload.mjs');
    const spoofToStringPreloadMjs = path.join(
      directory,
      'spoof-to-string-preload.mjs',
    );
    const loaderMjs = path.join(directory, 'loader.mjs');
    const transformingLoaderMjs = path.join(
      directory,
      'transforming-loader.mjs',
    );
    const probeMjs = path.join(directory, 'probe.mjs');
    const dynamicProbeMjs = path.join(directory, 'dynamic-probe.mjs');
    const positiveProbeMjs = path.join(directory, 'positive-probe.mjs');
    const benchmarkUrl = new URL(
      '../scripts/benchmark-rerank.mjs',
      import.meta.url,
    );
    const publishableProbePath = fileURLToPath(new URL(
      '../scripts/verify-reranker-quality.mjs',
      import.meta.url,
    ));
    fs.writeFileSync(preloadMjs, 'globalThis.fetch = async () => new Response();\n');
    fs.writeFileSync(preloadCjs, 'globalThis.fetch = async () => new Response();\n');
    fs.writeFileSync(scrubPreloadMjs,
      `process.execArgv.length = 0;\n` +
      `delete process.env.NODE_OPTIONS;\n` +
      `process.argv[1] = ${JSON.stringify(publishableProbePath)};\n` +
      'globalThis.fetch = async () => new Response();\n');
    fs.writeFileSync(spoofToStringPreloadMjs,
      'const nativeFetchSource = Function.prototype.toString.call(globalThis.fetch);\n' +
      'const fakeFetch = async () => new Response();\n' +
      'const originalToString = Function.prototype.toString;\n' +
      'globalThis.fetch = fakeFetch;\n' +
      'Function.prototype.toString = function () {\n' +
      '  return this === fakeFetch\n' +
      '    ? nativeFetchSource\n' +
      '    : originalToString.call(this);\n' +
      '};\n' +
      'process.execArgv.length = 0;\n' +
      'delete process.env.NODE_OPTIONS;\n' +
      `process.argv[1] = ${JSON.stringify(publishableProbePath)};\n`);
    fs.writeFileSync(loaderMjs,
      'export async function resolve(s,c,n){return n(s,c);}\n');
    fs.writeFileSync(transformingLoaderMjs,
      'export async function load(url, context, nextLoad) {\n' +
      '  const loaded = await nextLoad(url, context);\n' +
      `  if (url !== ${JSON.stringify(benchmarkUrl.href)}) return loaded;\n` +
      `  const publishablePath = ${JSON.stringify(publishableProbePath)};\n` +
      '  const prefix =\n' +
      '    "const __nativeFetchSource = Function.prototype.toString.call(globalThis.fetch);\\n" +\n' +
      '    "const __fakeFetch = async () => new Response();\\n" +\n' +
      '    "const __originalToString = Function.prototype.toString;\\n" +\n' +
      '    "globalThis.fetch = __fakeFetch;\\n" +\n' +
      '    "Function.prototype.toString = function () { return this === __fakeFetch ? __nativeFetchSource : __originalToString.call(this); };\\n" +\n' +
      '    "process.execArgv.length = 0;\\n" +\n' +
      '    "delete process.env.NODE_OPTIONS;\\n" +\n' +
      '    `process.argv[1] = ${JSON.stringify(publishablePath)};\\n`;\n' +
      '  return { ...loaded, source: prefix + String(loaded.source) };\n' +
      '}\n');
    fs.writeFileSync(probeMjs,
      `import { rerankGateEvidenceMode } from ${JSON.stringify(
        benchmarkUrl.href,
      )};\nconsole.log(rerankGateEvidenceMode({}, 0));\n`);
    fs.writeFileSync(dynamicProbeMjs,
      'globalThis.fetch = async () => new Response();\n' +
      `process.argv[1] = ${JSON.stringify(publishableProbePath)};\n` +
      `const gate = await import(${JSON.stringify(benchmarkUrl.href)});\n` +
      'console.log(gate.rerankGateEvidenceMode({}, 0));\n');
    fs.writeFileSync(positiveProbeMjs,
      `process.argv[1] = ${JSON.stringify(publishableProbePath)};\n` +
      `const gate = await import(${JSON.stringify(benchmarkUrl.href)});\n` +
      'console.log(gate.rerankGateEvidenceMode({}, 0));\n');
    const baseEnv = { ...process.env };
    delete baseEnv.NODE_OPTIONS;
    const positive = spawnSync(process.execPath, [positiveProbeMjs], {
      env: baseEnv,
      encoding: 'utf8',
    });
    assert.equal(positive.status, 0, positive.stderr);
    assert.equal(positive.stdout.trim(), 'real_ollama');
    const cases = [
      { args: [probeMjs], env: baseEnv },
      {
        args: ['--import', preloadMjs, probeMjs],
        env: baseEnv,
      },
      {
        args: ['--require', preloadCjs, probeMjs],
        env: baseEnv,
      },
      {
        args: ['--loader', loaderMjs, probeMjs],
        env: baseEnv,
      },
      {
        args: [probeMjs],
        env: { ...baseEnv, NODE_OPTIONS: `--import=${preloadMjs}` },
      },
      { args: ['--import', scrubPreloadMjs, probeMjs], env: baseEnv },
      {
        args: ['--import', spoofToStringPreloadMjs, probeMjs],
        env: baseEnv,
      },
      {
        args: ['--loader', transformingLoaderMjs, probeMjs],
        env: baseEnv,
      },
      { args: [dynamicProbeMjs], env: baseEnv },
    ];
    for (const current of cases) {
      const child = spawnSync(process.execPath, current.args, {
        env: current.env,
        encoding: 'utf8',
      });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout.trim(), 'test_injected');
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('真实门禁只接受无凭据、无路径的数字 loopback Ollama 地址', async () => {
  assert.equal(
    resolveRerankGateConfig({
      MEMORY_BRIDGE_OLLAMA_URL: 'http://127.0.0.1:11434/',
    }).baseUrl,
    'http://127.0.0.1:11434',
  );
  assert.equal(
    resolveRerankGateConfig({
      MEMORY_BRIDGE_OLLAMA_URL: 'http://[::1]:11434',
    }).baseUrl,
    'http://[::1]:11434',
  );
  for (const baseUrl of [
    'https://127.0.0.1:11434',
    'http://localhost:11434',
    'http://example.com:11434',
    'http://user:pass@127.0.0.1:11434',
    'http://127.0.0.1:11434/ollama',
    'http://127.0.0.1:11434//',
    'http://127.0.0.1',
  ]) {
    assert.throws(
      () => resolveRerankGateConfig({
        MEMORY_BRIDGE_OLLAMA_URL: baseUrl,
      }),
      /只允许|拒绝/u,
      baseUrl,
    );
  }
  let calls = 0;
  await assert.rejects(
    verifyOllamaModelIdentity({
      baseUrl: 'http://example.com:11434',
      rerankModel: REQUIRED_RERANK_MODEL,
      embeddingModel: REQUIRED_EMBED_MODEL,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('不应请求远端');
      },
    }),
    /只允许/u,
  );
  assert.equal(calls, 0);
});

test('模型身份预检拒绝未知重排模型，且在发出网络请求前 fail closed', async () => {
  let calls = 0;
  await assert.rejects(
    verifyOllamaModelIdentity({
      baseUrl: 'http://127.0.0.1:11434',
      rerankModel: 'invalid-rerank-model',
      embeddingModel: REQUIRED_EMBED_MODEL,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('不应执行');
      },
    }),
    /只接受 qwen2\.5:14b/u,
  );
  assert.equal(calls, 0);
});

test('模型身份预检强制核验 Ollama 版本', async () => {
  const ollama = ollamaFixture();
  await assert.rejects(
    verifyOllamaModelIdentity({
      baseUrl: 'http://127.0.0.1:11434',
      rerankModel: REQUIRED_RERANK_MODEL,
      embeddingModel: REQUIRED_EMBED_MODEL,
      fetchImpl: async (input, init) => {
        if (new URL(String(input)).pathname === '/api/version') {
          return Response.json({});
        }
        return ollama.fetchImpl(input, init);
      },
    }),
    /缺少版本号/u,
  );
  assert.equal(
    ollama.requests.some((request) => request.pathname === '/api/tags'),
    false,
  );
});

test('模型身份预检锁定正式 digest 与 family', async () => {
  for (const fixture of [
    ollamaFixture({ rerankDigest: 'a'.repeat(64) }),
    ollamaFixture({ embeddingDigest: 'b'.repeat(64) }),
  ]) {
    await assert.rejects(
      verifyOllamaModelIdentity({
        baseUrl: 'http://127.0.0.1:11434',
        rerankModel: REQUIRED_RERANK_MODEL,
        embeddingModel: REQUIRED_EMBED_MODEL,
        fetchImpl: fixture.fetchImpl,
      }),
      /digest/u,
    );
  }
  for (const fixture of [
    ollamaFixture({ rerankFamily: 'qwen3' }),
    ollamaFixture({ embeddingFamily: 'nomic-bert' }),
  ]) {
    await assert.rejects(
      verifyOllamaModelIdentity({
        baseUrl: 'http://127.0.0.1:11434',
        rerankModel: REQUIRED_RERANK_MODEL,
        embeddingModel: REQUIRED_EMBED_MODEL,
        fetchImpl: fixture.fetchImpl,
      }),
      /family/u,
    );
  }
});

test('embedding 探针拒绝非 1024 维向量', async () => {
  const ollama = ollamaFixture();
  await assert.rejects(
    runRerankBenchmark({
      env: {},
      sampleCount: 10,
      warmupCount: 1,
      fetchImpl: ollama.fetchImpl,
      rankerFactory: fakeRankerFactory({ embeddingDimension: 3 }),
    }),
    /维度必须为 1024/u,
  );
});

test('benchmark 回执包含真实路线遥测、embedding 维度且默认不卸载', async () => {
  const ollama = ollamaFixture();
  const report = await runRerankBenchmark({
    env: {},
    sampleCount: 10,
    warmupCount: 1,
    fetchImpl: ollama.fetchImpl,
    rankerFactory: fakeRankerFactory(),
  });

  assert.equal(report.checksPassed, false);
  assert.equal(report.passed, false);
  assert.equal(report.evidenceMode, 'test_injected');
  assert.deepEqual(report.failureReasons, [
    'defaultBenchmarkProfile',
    'atLeastTwentyUniqueMeasuredPrompts',
    'test_injected_evidence_not_publishable',
  ]);
  assert.equal(report.modelIdentity.metadataCalls, 4);
  assert.equal(report.modelIdentity.ollama.version, '0.31.1-test');
  assert.equal(report.embeddingProbe.dimension, REQUIRED_EMBED_DIMENSION);
  assert.equal(report.benchmarkLoad.candidateCharacters, 640);
  assert.equal(report.benchmarkLoad.matchesProductionDefinition, true);
  assert.equal(report.providerObservation.embeddingSuccesses, 1);
  assert.equal(report.telemetry.measured.routeCounts.model, 10);
  assert.equal(report.telemetry.measured.providerCalls, 10);
  assert.equal(report.telemetry.measured.baseProviderCalls, 10);
  assert.equal(
    report.telemetry.measured.firstCandidateConfirmationCalls,
    0,
  );
  assert.equal(report.telemetry.measured.protocolRecoveryCalls, 0);
  assert.equal(report.telemetry.measured.providerQueueWaitMs.p95, 0.05);
  assert.equal(report.telemetry.measured.providerPeakActive, 1);
  assert.equal(report.telemetry.measured.providerMaxConcurrency, 1);
  assert.equal(
    report.telemetry.measured.completeProviderConcurrencyTelemetry,
    true,
  );
  assert.equal(report.telemetry.measured.thermalStates.warm, 10);
  assert.equal(report.telemetry.measured.modelTelemetry.promptTokens.sum, 640);
  assert.equal(report.telemetry.measured.modelTelemetry.outputTokens.sum, 80);
  assert.equal(report.providerObservation.rerankSuccesses, 11);
  assert.equal(report.cleanup.status, 'not_requested');
  assert.equal(
    ollama.requests.some((request) => request.pathname === '/api/generate'),
    false,
  );
});

test('benchmark 不把伪造 providerCalls 遥测当成真实调用', async () => {
  const ollama = ollamaFixture();
  const report = await runRerankBenchmark({
    env: {},
    sampleCount: 10,
    warmupCount: 1,
    fetchImpl: ollama.fetchImpl,
    rankerFactory: fakeRankerFactory({ callRerankProvider: false }),
  });

  assert.equal(report.telemetry.combined.providerCalls, 11);
  assert.equal(report.providerObservation.rerankAttempts, 0);
  assert.equal(report.checks.physicalProviderCallsMatchTelemetry, false);
  assert.equal(report.checksPassed, false);
});

test('benchmark 缺少 provider 排队与并发遥测时硬失败', async () => {
  const ollama = ollamaFixture();
  const report = await runRerankBenchmark({
    env: {},
    sampleCount: 10,
    warmupCount: 1,
    fetchImpl: ollama.fetchImpl,
    rankerFactory: fakeRankerFactory({
      omitProviderConcurrencyTelemetry: true,
    }),
  });

  assert.equal(
    report.telemetry.measured.completeProviderConcurrencyTelemetry,
    false,
  );
  assert.equal(report.checks.providerTelemetryComplete, false);
  assert.equal(report.checksPassed, false);
});

test('benchmark 可直接消费真实 OllamaSemanticRanker 遥测接口', async () => {
  const ollama = ollamaFixture();
  const report = await runRerankBenchmark({
    env: {},
    sampleCount: 10,
    warmupCount: 1,
    fetchImpl: ollama.fetchImpl,
  });

  assert.equal(report.checksPassed, false);
  assert.equal(report.evidenceMode, 'test_injected');
  assert.equal(report.telemetry.measured.routeCounts.model, 10);
  assert.equal(report.telemetry.measured.providerBreakdownMatches, true);
  assert.equal(report.telemetry.measured.completeModelTelemetry, true);
  assert.equal(
    report.telemetry.measured.completeProviderConcurrencyTelemetry,
    true,
  );
  assert.equal(report.measurements.uniquePromptVariants, 10);
  const promptBodies = ollama.requests
    .filter((request) => request.pathname === '/api/chat')
    .map((request) => request.body.messages[1].content);
  assert.equal(promptBodies.length, 11);
  assert.equal(new Set(promptBodies).size, 11);
  for (const request of ollama.requests.filter((item) =>
    item.pathname === '/api/chat'
  )) {
    const payload = parseRerankProviderPayload(
      request.body.messages[1].content,
    );
    const batchSize = payload.m.length;
    assert.deepEqual(request.body.format, {
      type: 'array',
      items: {
        type: 'integer',
        minimum: 0,
        maximum: batchSize - 1,
      },
      uniqueItems: true,
      maxItems: batchSize,
    });
  }
  assert.equal(
    report.providerObservation.rerankSuccesses,
    report.telemetry.combined.providerCalls,
  );
});

test('monkeypatch global fetch 与自定义 case 都不能生成真实 PASS', async () => {
  const originalFetch = globalThis.fetch;
  const ollama = ollamaFixture();
  globalThis.fetch = ollama.fetchImpl;
  try {
    const defaultRun = await runRerankBenchmark();
    assert.equal(defaultRun.checks.defaultBenchmarkProfile, true);
    assert.equal(defaultRun.checksPassed, true);
    assert.equal(defaultRun.evidenceMode, 'test_injected');
    assert.equal(defaultRun.passed, false);
    assert.deepEqual(defaultRun.failureReasons, [
      'test_injected_evidence_not_publishable',
    ]);

    const customRun = await runRerankBenchmark({
      benchmarkCase: {
        query: '小林开始任务前会做什么？',
        candidates: [
          {
            id: 'relevant',
            memory: '小林开始任务前会先画流程图。',
            relevant: true,
          },
          {
            id: 'irrelevant',
            memory: '小林完成任务后会散步。',
            relevant: false,
          },
        ],
      },
      sampleCount: 10,
      warmupCount: 1,
    });
    assert.equal(customRun.checks.defaultBenchmarkProfile, false);
    assert.equal(customRun.checks.benchmarkFixtureLocked, false);
    assert.equal(customRun.evidenceMode, 'test_injected');
    assert.equal(customRun.passed, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('质量门禁聚合模型遥测并要求专用 model-route 覆盖', async () => {
  const ollama = ollamaFixture();
  const fixture = {
    id: 'coverage',
    query: '小林开始任务前做什么？',
    relevant: '小林开始任务前会先画流程图。',
    irrelevant: '小林完成任务后会散步。',
  };
  const report = await runRerankerQualityGate({
    env: {},
    rounds: 1,
    fixedCases: [fixture],
    coverageCases: [fixture],
    holdout: { cases: [], setCalibration: [] },
    minimumModelRouteRequests: 1,
    fetchImpl: ollama.fetchImpl,
  });

  assert.equal(report.checksPassed, false);
  assert.equal(report.passed, false);
  assert.equal(report.evidenceMode, 'test_injected');
  assert.equal(report.checks.defaultQualityProfile, false);
  assert.equal(report.telemetry.routeCounts.model, 2);
  assert.equal(report.providerCallsMeasured, 2);
  assert.equal(report.telemetry.baseProviderCalls, 2);
  assert.equal(report.telemetry.completeModelTelemetry, true);
  assert.equal(report.telemetry.completeProviderConcurrencyTelemetry, true);
  assert.equal(report.telemetry.providerQueueWaitMs.count, 2);
  assert.equal(report.telemetry.providerPeakActive, 1);
  assert.equal(report.telemetry.providerMaxConcurrency, 1);
  assert.equal(report.measurements.modelRoute.count, 2);
  assert.equal(report.providerObservation.rerankSuccesses, 2);
  assert.equal(report.embeddingProbe.dimension, REQUIRED_EMBED_DIMENSION);
});

test('质量门禁拒绝全部走 deterministic 的伪质量通过', async () => {
  const ollama = ollamaFixture();
  const fixture = {
    id: 'coverage',
    query: '小林开始任务前做什么？',
    relevant: '小林开始任务前会先画流程图。',
    irrelevant: '小林完成任务后会散步。',
  };
  const report = await runRerankerQualityGate({
    env: {},
    rounds: 1,
    fixedCases: [],
    coverageCases: [fixture],
    holdout: { cases: [], setCalibration: [] },
    minimumModelRouteRequests: 1,
    fetchImpl: ollama.fetchImpl,
    rankerFactory: fakeRankerFactory({
      callRerankProvider: false,
      deterministic: true,
    }),
  });

  assert.equal(report.failures.length, 0);
  assert.equal(report.telemetry.routeCounts.deterministic_fast, 1);
  assert.equal(report.telemetry.providerCalls, 0);
  assert.equal(report.checks.everyCoverageCaseUsedModel, false);
  assert.equal(report.checks.sufficientModelRouteCoverage, false);
  assert.equal(report.checks.modelRouteP95WithinThreshold, false);
  assert.equal(report.checksPassed, false);
});

test('默认质量门禁锁定四组 fixture、171 请求和至少 30 条模型路线', async () => {
  const ollama = ollamaFixture();
  const report = await runRerankerQualityGate({
    fetchImpl: ollama.fetchImpl,
    rankerFactory: fakeRankerFactory(),
  });
  assert.deepEqual(RERANK_QUALITY_PROFILE, {
    fixedCases: 18,
    coverageCases: 10,
    holdoutCases: 20,
    setCalibrationCases: 9,
    rounds: 3,
    evaluatedRequests: 171,
    minimumModelRouteRequests: 30,
  });
  assert.deepEqual(
    RERANK_QUALITY_FIXTURE_SHA256,
    EXPECTED_RERANK_QUALITY_FIXTURE_SHA256,
  );
  assert.deepEqual(
    report.fixtureSha256,
    EXPECTED_RERANK_QUALITY_FIXTURE_SHA256,
  );
  assert.equal(report.evaluatedRequests, 171);
  assert.equal(report.minimumModelRouteRequests, 30);
  assert.ok(report.telemetry.routeCounts.model >= 30);
  assert.equal(report.checks.defaultQualityProfile, true);
  assert.equal(report.checksPassed, true);
  assert.equal(report.passed, false);

  const duplicateCoverage = Array.from(
    { length: 10 },
    (_, index) => ({
      id: index < 2 ? 'duplicate' : `id-${index}`,
      query: `问题 ${index}`,
      relevant: `相关 ${index}`,
      irrelevant: `无关 ${index}`,
    }),
  );
  const reduced = await runRerankerQualityGate({
    rounds: 1,
    fixedCases: [],
    coverageCases: duplicateCoverage,
    holdout: { cases: [], setCalibration: [] },
    minimumModelRouteRequests: 1,
    fetchImpl: ollama.fetchImpl,
    rankerFactory: fakeRankerFactory(),
  });
  assert.equal(reduced.checks.fixtureIdsUnique, false);
  assert.equal(reduced.checks.exactFixtureCounts, false);
  assert.equal(reduced.checks.defaultQualityProfile, false);
});
