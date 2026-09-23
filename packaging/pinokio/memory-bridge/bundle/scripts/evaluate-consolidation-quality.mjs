import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OllamaConsolidationProvider,
} from '../dist/server/memory-consolidator.js';
import {
  OllamaSemanticRanker,
} from '../dist/server/semantic-ranker.js';

const DATASET_PATH = fileURLToPath(
  new URL(
    './fixtures/consolidation-quality-v1.json',
    import.meta.url,
  ),
);
const DATASET_ID = 'consolidation-quality-v1';
const DATASET_SHA256 =
  'f2c3b08e021df4105abb0da4705e2b1133ad1da722ce8e31f518a95331c94b3b';
const EVALUATOR_VERSION = 'consolidation-quality-evaluator-v2';
const CONSOLIDATION_MODEL = 'qwen2.5:14b';
const EMBEDDING_MODEL = 'bge-m3:latest';
const RERANK_MODEL = 'qwen2.5:14b';
const PROMPT_VERSION = 'consolidate-v6';
const DEFAULT_TIMEOUT_MS = 300_000;
const THRESHOLDS = Object.freeze({
  compressionRate: 0.6,
  recallAt10Loss: 0.01,
  severeUnsupportedSentences: 0,
  internalSourceLeakSentences: 0,
});

function usage() {
  return [
    '用法：',
    '  npm run evaluate:consolidation-quality',
    '  npm run evaluate:consolidation-quality -- --validate-fixture',
    '',
    '选项：',
    '  --ollama-url URL     默认 http://127.0.0.1:11434',
    '  --timeout-ms N       单次 Ollama 请求超时，默认 300000',
    '  --validate-fixture   只验证固定数据集，不调用模型',
    '  --help               显示帮助',
  ].join('\n');
}

function parseArgs(argv) {
  const result = {
    ollamaUrl: 'http://127.0.0.1:11434',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    validateFixture: false,
    help: false,
  };
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
    if (!['--ollama-url', '--timeout-ms'].includes(argument)) {
      throw new Error(`未知参数：${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} 缺少值`);
    }
    if (argument === '--ollama-url') result.ollamaUrl = value;
    else result.timeoutMs = Number(value);
    index += 1;
  }
  result.ollamaUrl = String(result.ollamaUrl).replace(/\/+$/u, '');
  if (!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/iu.test(
    result.ollamaUrl,
  )) {
    throw new Error('--ollama-url 只允许 loopback HTTP(S) 地址');
  }
  if (
    !Number.isInteger(result.timeoutMs) ||
    result.timeoutMs < 1_000 ||
    result.timeoutMs > 900_000
  ) {
    throw new Error('--timeout-ms 必须是 1000 到 900000 之间的整数');
  }
  return result;
}

function isRecord(value) {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value);
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.normalize('NFKC').trim()) {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value.normalize('NFKC').trim();
}

function validateDataset(dataset) {
  if (!isRecord(dataset)) throw new Error('fixture 根节点必须是对象');
  if (dataset.datasetId !== DATASET_ID || dataset.schemaVersion !== 1) {
    throw new Error('fixture 标识或 schemaVersion 不正确');
  }
  if (!Array.isArray(dataset.groups) || dataset.groups.length < 3) {
    throw new Error('fixture 至少需要三个巩固分组');
  }
  const allIds = new Set();
  let sourceCount = 0;
  let queryCount = 0;
  for (const group of dataset.groups) {
    if (!isRecord(group)) throw new Error('group 必须是对象');
    const groupId = requireText(group.id, 'group.id');
    if (allIds.has(groupId)) throw new Error(`fixture id 重复：${groupId}`);
    allIds.add(groupId);
    if (!['session', 'topic', 'person', 'project'].includes(
      group.scopeType,
    )) {
      throw new Error(`${groupId}.scopeType 无效`);
    }
    requireText(group.scopeKey, `${groupId}.scopeKey`);
    if (!Array.isArray(group.sources) || group.sources.length < 5) {
      throw new Error(`${groupId}.sources 至少需要五条`);
    }
    if (!Array.isArray(group.queries) || group.queries.length < 2) {
      throw new Error(`${groupId}.queries 至少需要两条`);
    }
    const sourceIds = new Set();
    for (const source of group.sources) {
      if (!isRecord(source)) throw new Error(`${groupId}.source 无效`);
      const sourceId = requireText(source.id, `${groupId}.source.id`);
      requireText(source.text, `${sourceId}.text`);
      if (allIds.has(sourceId)) {
        throw new Error(`fixture id 重复：${sourceId}`);
      }
      allIds.add(sourceId);
      sourceIds.add(sourceId);
      sourceCount += 1;
    }
    for (const query of group.queries) {
      if (!isRecord(query)) throw new Error(`${groupId}.query 无效`);
      const queryId = requireText(query.id, `${groupId}.query.id`);
      requireText(query.text, `${queryId}.text`);
      if (allIds.has(queryId)) {
        throw new Error(`fixture id 重复：${queryId}`);
      }
      allIds.add(queryId);
      if (
        !Array.isArray(query.goldSourceIds) ||
        query.goldSourceIds.length === 0 ||
        query.goldSourceIds.some((id) => !sourceIds.has(id))
      ) {
        throw new Error(`${queryId}.goldSourceIds 引用了无效来源`);
      }
      queryCount += 1;
    }
  }
  if (sourceCount < 30 || queryCount < 10) {
    throw new Error('fixture 规模不足：至少 30 个来源和 10 个查询');
  }
  return { sourceCount, queryCount };
}

function cosine(left, right) {
  if (left.length !== right.length || left.length === 0) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  const denominator = Math.sqrt(leftNorm * rightNorm);
  return denominator > 0 ? dot / denominator : -1;
}

function intersects(left, right) {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

async function evaluateRecall(ranker, queries, documents) {
  const texts = [
    ...queries.map((query) => query.text),
    ...documents.map((document) => document.text),
  ];
  const vectors = await ranker.embed(texts);
  const queryVectors = vectors.slice(0, queries.length);
  const documentVectors = vectors.slice(queries.length);
  const cases = [];
  let hits = 0;
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const query = queries[queryIndex];
    const ranked = documents
      .map((document, documentIndex) => ({
        ...document,
        score: cosine(
          queryVectors[queryIndex],
          documentVectors[documentIndex],
        ),
      }))
      .sort((left, right) =>
        right.score - left.score || left.id.localeCompare(right.id),
      )
      .slice(0, 20);
    const decisions = await ranker.rerank(
      query.text,
      ranked.map((document) => ({
        id: document.id,
        memory: document.text,
      })),
    );
    const relevantIds = new Set(
      decisions
        .filter((decision) => decision.relevant)
        .map((decision) => decision.id),
    );
    const top10 = ranked
      .filter((document) => relevantIds.has(document.id))
      .slice(0, 10);
    const hit = top10.some((document) =>
      intersects(document.sourceIds, query.goldSourceIds),
    );
    if (hit) hits += 1;
    cases.push({
      queryId: query.id,
      hitAt10: hit,
      resultIds: top10.map((document) => document.id),
    });
  }
  return {
    recallAt10: queries.length > 0 ? hits / queries.length : 0,
    hits,
    total: queries.length,
    cases,
  };
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage());
  process.exit(0);
}

const datasetBytes = fs.readFileSync(DATASET_PATH);
const datasetSha256 = createHash('sha256')
  .update(datasetBytes)
  .digest('hex');
if (datasetSha256 !== DATASET_SHA256) {
  throw new Error(
    `固定巩固评测集 SHA-256 不匹配：${datasetSha256}`,
  );
}
const dataset = JSON.parse(datasetBytes.toString('utf8'));
const fixtureStats = validateDataset(dataset);
if (options.validateFixture) {
  console.log(JSON.stringify({
    passed: true,
    datasetId: DATASET_ID,
    datasetSha256,
    ...fixtureStats,
  }, null, 2));
  process.exit(0);
}

const provider = new OllamaConsolidationProvider({
  baseUrl: options.ollamaUrl,
  model: CONSOLIDATION_MODEL,
  promptVersion: PROMPT_VERSION,
  timeoutMs: options.timeoutMs,
});
const ranker = new OllamaSemanticRanker({
  baseUrl: options.ollamaUrl,
  embeddingModel: EMBEDDING_MODEL,
  rerankModel: RERANK_MODEL,
  embedBatchSize: 64,
  rerankBatchSize: 20,
  timeoutMs: options.timeoutMs,
});
const baselineDocuments = [];
const consolidatedDocuments = [];
const queries = [];
const groupReports = [];
let severeUnsupportedSentences = 0;
let internalSourceLeakSentences = 0;
let sentenceCount = 0;

for (const group of dataset.groups) {
  const sources = group.sources.map((source) => ({
    memoryId: `memory-${source.id}`,
    memoryVersionId: source.id,
    kind: 'knowledge',
    title: source.id,
    content: source.text,
    updatedAt: '2026-07-29T00:00:00.000Z',
  }));
  const scope = {
    userId: 'consolidation-quality-gate',
    namespace: DATASET_ID,
    scopeType: group.scopeType,
    scopeKey: group.scopeKey,
    accessScopeType: 'personal',
    accessScopeKey: 'self',
  };
  const draft = await provider.consolidate(scope, sources);
  const sourceIds = new Set(sources.map((source) => source.memoryVersionId));
  const attributionFailures = draft.sentences.filter((sentence) =>
    !sentence.text ||
    sentence.sourceVersionIds.length === 0 ||
    sentence.sourceVersionIds.some((id) => !sourceIds.has(id)),
  ).length;
  const verdicts = attributionFailures === 0
    ? await provider.verifySupport(scope, sources, draft.sentences)
    : [];
  const unsupported = attributionFailures +
    (attributionFailures === 0
      ? draft.sentences.filter((_sentence, index) =>
          verdicts[index]?.sentenceIndex !== index ||
          verdicts[index]?.supported !== true,
        ).length
      : draft.sentences.length);
  severeUnsupportedSentences += unsupported;
  const internalLeaks = draft.sentences.filter((sentence) =>
    /(?:memoryVersionId|sourceVersionIds)/iu.test(sentence.text) ||
    [...sourceIds].some((id) =>
      sentence.text.includes(id),
    ),
  ).length;
  internalSourceLeakSentences += internalLeaks;
  sentenceCount += draft.sentences.length;
  groupReports.push({
    groupId: group.id,
    sourceCount: sources.length,
    sentenceCount: draft.sentences.length,
    unsupportedSentenceCount: unsupported,
    internalSourceLeakSentenceCount: internalLeaks,
    sentences: draft.sentences,
    supportVerdicts: verdicts,
  });
  baselineDocuments.push(...group.sources.map((source) => ({
    id: `source:${source.id}`,
    text: source.text,
    sourceIds: [source.id],
  })));
  consolidatedDocuments.push(...draft.sentences.map((sentence, index) => ({
    id: `summary:${group.id}:${index}`,
    text: sentence.text,
    sourceIds: sentence.sourceVersionIds,
  })));
  queries.push(...group.queries);
}

const baselineRecall = await evaluateRecall(
  ranker,
  queries,
  baselineDocuments,
);
const consolidatedRecall = await evaluateRecall(
  ranker,
  queries,
  consolidatedDocuments,
);
const compressionRate =
  1 - sentenceCount / fixtureStats.sourceCount;
const recallAt10Loss =
  baselineRecall.recallAt10 - consolidatedRecall.recallAt10;
const passed =
  compressionRate + Number.EPSILON >= THRESHOLDS.compressionRate &&
  recallAt10Loss <= THRESHOLDS.recallAt10Loss + Number.EPSILON &&
  severeUnsupportedSentences ===
    THRESHOLDS.severeUnsupportedSentences &&
  internalSourceLeakSentences ===
    THRESHOLDS.internalSourceLeakSentences;
const report = {
  passed,
  datasetId: DATASET_ID,
  datasetSha256,
  evaluatorVersion: EVALUATOR_VERSION,
  models: {
    consolidation: CONSOLIDATION_MODEL,
    embedding: EMBEDDING_MODEL,
    rerank: RERANK_MODEL,
  },
  thresholds: THRESHOLDS,
  metrics: {
    sourceCount: fixtureStats.sourceCount,
    sentenceCount,
    compressionRate,
    baselineRecallAt10: baselineRecall.recallAt10,
    consolidatedRecallAt10: consolidatedRecall.recallAt10,
    recallAt10Loss,
    severeUnsupportedSentences,
    internalSourceLeakSentences,
  },
  failedBaselineQueryIds: baselineRecall.cases
    .filter((item) => !item.hitAt10)
    .map((item) => item.queryId),
  failedConsolidatedQueryIds: consolidatedRecall.cases
    .filter((item) => !item.hitAt10)
    .map((item) => item.queryId),
  groups: groupReports,
};
console.log(JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;
