import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OllamaSemanticRanker,
  type SemanticCandidate,
  semanticOperationFailure,
} from '../src/server/semantic-ranker.js';

type RerankHandler = (
  url: string,
  body: { query: string; passages: string[] },
) => Response | Promise<Response>;

function crossEncoderRanker(
  handler: RerankHandler,
  overrides: Partial<Parameters<typeof buildRanker>[0]> = {},
) {
  return buildRanker({ handler, ...overrides });
}

function buildRanker(options: {
  handler: RerankHandler;
  batchSize?: number;
  model?: string;
  cacheTtlMs?: number;
}) {
  return new OllamaSemanticRanker({
    baseUrl: 'http://127.0.0.1:11434',
    embeddingModel: 'embed-test',
    rerankModel: 'rerank-test',
    embedBatchSize: 8,
    rerankBatchSize: 8,
    timeoutMs: 5_000,
    cacheTtlMs: options.cacheTtlMs ?? 5_000,
    crossEncoder: {
      baseUrl: 'http://127.0.0.1:3798',
      model: options.model ?? 'bge-reranker-v2-m3',
      batchSize: options.batchSize ?? 32,
      timeoutMs: 5_000,
    },
    fetchImpl: (async (input, init) => {
      const url = String(input);
      assert.equal(url, 'http://127.0.0.1:3798/rerank');
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        passages: string[];
      };
      assert.equal(typeof body.query, 'string');
      assert.ok(Array.isArray(body.passages));
      return await options.handler(url, body);
    }) as typeof fetch,
  });
}

const plainCandidates = (...texts: string[]): SemanticCandidate[] =>
  texts.map((text, index) => ({ id: `c${index}`, memory: text }));

test('cross-encoder 路径整批打分并按 sigmoid 生成决策', async () => {
  const seenBodies: Array<{ query: string; passages: string[] }> = [];
  const ranker = crossEncoderRanker((_url, body) => {
    seenBodies.push(JSON.parse(JSON.stringify(body)));
    // 5 条候选、batchSize=2 → 3 次调用
    const scores = body.passages.map((text) =>
      text.includes('报销') ? 6.5 : -11.2,
    );
    return Response.json({ scores, elapsed_ms: 12.3 });
  }, { batchSize: 2 });

  const candidates = plainCandidates(
    '员工差旅报销制度：机票全价经济舱可报销。',
    '今天天气不错，适合出行。',
    '打印机维修请联系行政部。',
    '报销单需部门主管签字后提交财务。',
    '食堂周三供应红烧肉。',
  );
  const decisions = await ranker.rerank('差旅报销流程是什么？', candidates);

  assert.equal(seenBodies.length, 3);
  assert.equal(seenBodies[0].query, '差旅报销流程是什么？');
  assert.equal(seenBodies[0].passages.length, 2);
  // 候选全文下发，无 LLM 文本预算截断
  for (const [index, passage] of seenBodies[0].passages.entries()) {
    assert.equal(passage, candidates[index].memory);
  }

  assert.equal(decisions.length, 5);
  // confidenceScale 默认 3：sigmoid(score*3)，明显相关/无关项分别饱和到 1/0
  const expectedConf = (score: number) =>
    Number((1 / (1 + Math.exp(-score * 3))).toFixed(6));
  for (const [index, decision] of decisions.entries()) {
    assert.equal(decision.id, candidates[index].id);
    const expectedScore = candidates[index].memory.includes('报销')
      ? 6.5
      : -11.2;
    assert.equal(decision.relevant, expectedScore >= 0);
    assert.equal(decision.confidence, expectedConf(expectedScore));
    assert.match(decision.reason, /^cross_encoder:-?[0-9.]+$/u);
  }
  assert.deepEqual(
    decisions.filter((decision) => decision.relevant).map((d) => d.id),
    ['c0', 'c3'],
  );
});

test('cross-encoder 空候选不发起请求，遥测计数为零', async () => {
  let calls = 0;
  const ranker = crossEncoderRanker(() => {
    calls += 1;
    return Response.json({ scores: [] });
  });
  const result = await ranker.rerankWithTelemetry('任意问题', []);
  assert.deepEqual(result.result, []);
  assert.equal(calls, 0);
  assert.equal(result.telemetry.providerCalls, 0);
  assert.equal(result.telemetry.route, 'deterministic_fast');
});

test('cross-encoder 缓存键包含 provider 模型名且命中缓存', async () => {
  let calls = 0;
  const handler: RerankHandler = (_url, body) => {
    calls += 1;
    return Response.json({
      scores: body.passages.map(() => 4.2),
    });
  };
  const ranker = crossEncoderRanker(handler);
  const candidates = plainCandidates('制度文档内容一。', '制度文档内容二。');
  const first = await ranker.rerank('查询一', candidates);
  const second = await ranker.rerank('查询一', candidates);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.equal(ranker.cacheStats().rerankHits, 1);

  // 同 query 但 provider 模型名不同 → 缓存键不同，重新请求
  const otherModelRanker = crossEncoderRanker(handler, {
    model: 'other-reranker',
  });
  await otherModelRanker.rerank('查询一', candidates);
  assert.equal(calls, 2);
});

test('cross-encoder sidecar HTTP 错误映射为 provider_http_error', async () => {
  const ranker = crossEncoderRanker(() =>
    new Response('boom', { status: 500 }),
  );
  await assert.rejects(
    () => ranker.rerank('查询', plainCandidates('候选内容。')),
    (error: unknown) => {
      const operation = semanticOperationFailure(error);
      assert.ok(operation);
      assert.equal(operation.operation, 'rerank');
      assert.equal(operation.code, 'provider_http_error');
      return true;
    },
  );
});

test('cross-encoder 分数缺失或类型无效映射为 provider_protocol_error', async () => {
  const ranker = crossEncoderRanker(() =>
    Response.json({ scores: [1.5] }),
  );
  await assert.rejects(
    () =>
      ranker.rerank('查询', plainCandidates('候选一。', '候选二。')),
    (error: unknown) => {
      const operation = semanticOperationFailure(error);
      assert.ok(operation);
      assert.equal(operation.code, 'provider_protocol_error');
      return true;
    },
  );
});
