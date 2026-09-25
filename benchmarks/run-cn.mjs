// 中文知识库端到端评测（自建语料，10 篇制度文档 + 12 题）。
//
// 目的：把「中文链路未验证」变成「已验证」，并分别测出召回 / 作答 / **弃答**三项。
// 与 CMRC 的分工：CMRC 是公开语料（有官方口径、可量级、但无不可答题）；
// 本套语料是自建的，含 **2 道不可答题**与 **2 道多跳题**，专门覆盖拒答与跨文档推理。
//
// ⚠️ 自建语料**不可**与任何公开基准数值横比——它只回答「中文链路能不能跑通、卡在哪一段」。
//
// 用法：
//   node benchmarks/run-cn.mjs
//   MEMORY_BRIDGE_BENCH_SCALE=1000 node benchmarks/run-cn.mjs   # 追加 1000 篇同领域干扰
//   MEMORY_BRIDGE_BENCH_ABSTENTION_PROFILE=balanced node benchmarks/run-cn.mjs
//
// 结果：benchmarks/.work/results-cn-<tag>.jsonl（逐题）+ 同目录 progress 日志
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  answerWith, completedIds, createApi, createLogger,
  startInstance, stopInstance, waitHealthy, waitIndexReady, workRoot, writeDocuments,
} from './lib/harness.mjs';
import { cnVerdict, recallSummary } from './lib/scoring.mjs';

const PORT = Number(process.env.MEMORY_BRIDGE_BENCH_PORT || 3794);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.MEMORY_BRIDGE_BENCH_TOKEN || 'bench-local-token';
const SCALE = Number(process.env.MEMORY_BRIDGE_BENCH_SCALE || 0);
/**
 * filler 覆盖值。**默认不设** —— 不设时 filler 由弃答档案决定
 * （`strict` 0 / `balanced` 2 / `eager` 4，见 `src/server/config.ts` 的 `ABSTENTION_PROFILES`）。
 * 早先这里默认成 `'3'` 并把 `filler=3` 写进日志与逐题结果，而实际生效的是档案默认值，
 * 等于给每条结果贴了一个错的运行条件标签。
 */
const FILLER_OVERRIDE = process.env.MEMORY_BRIDGE_BENCH_FILLER;
const FILLER_LABEL = FILLER_OVERRIDE ?? 'profile';
const LIMIT = Number(process.env.MEMORY_BRIDGE_BENCH_LIMIT || 8);
const PROFILE = process.env.MEMORY_BRIDGE_BENCH_ABSTENTION_PROFILE || 'strict';
const TAG = process.env.MEMORY_BRIDGE_BENCH_TAG || `cn-s${SCALE}-f${FILLER_LABEL}-${PROFILE}`;

const WORK = workRoot();
const DATA_DIR = path.join(WORK, `memdata-${TAG}`);
const OUT = path.join(WORK, `results-${TAG}.jsonl`);
const LOG = path.join(WORK, `progress-${TAG}.log`);
const CORPUS_FILE = process.env.MEMORY_BRIDGE_BENCH_CORPUS
  || path.join(fileURLToPath(new URL('.', import.meta.url)), 'corpus', 'cn-corpus.json');

const log = createLogger(LOG);
const api = createApi(BASE, TOKEN);

/** 同领域干扰文档：与题目无关，只用来撑规模档（考"干扰下检索是否仍稳"）。 */
function noiseDocuments(count) {
  const kinds = ['机房环境检查', '办公用品领用', '客户回访', '周报提交', '资产盘点'];
  return Array.from({ length: count }, (_, i) => ({
    id: `N${i}`,
    title: `运维日常记录第 ${1000 + i} 号`,
    text: `本记录为${kinds[i % kinds.length]}事项。温度 ${18 + (i % 7)} 摄氏度，`
      + `湿度 ${40 + (i % 25)}%，环境指标正常。经办人编号 ${100000 + i}，`
      + '状态已归档，无异常事项上报。',
  }));
}

const corpus = JSON.parse(readFileSync(CORPUS_FILE, 'utf8'));
const documents = [
  ...corpus.documents.map((doc) => ({
    ...doc,
    content: `${doc.title}。${doc.text}`,
  })),
  ...noiseDocuments(SCALE).map((doc) => ({
    ...doc,
    content: `${doc.title}。${doc.text}`,
  })),
];
const questions = corpus.questions;

log(`=== 中文自建语料评测 tag=${TAG} 档案=${PROFILE} 文档 ${documents.length} 篇`
  + `（含干扰 ${SCALE}）｜题 ${questions.length} ｜limit=${LIMIT}`
  + ` ｜filler=${FILLER_OVERRIDE ?? '按档案默认（strict 0 / balanced 2 / eager 4）'} ===`);

mkdirSync(WORK, { recursive: true });
const { proc, logFd } = startInstance({
  dataDir: DATA_DIR,
  port: PORT,
  token: TOKEN,
  env: {
    MEMORY_BRIDGE_ABSTENTION_PROFILE: PROFILE,
    ...(FILLER_OVERRIDE !== undefined
      ? { MEMORY_BRIDGE_SEMANTIC_RERANK_FILLER_LIMIT: String(FILLER_OVERRIDE) }
      : {}),
  },
});
const startedAt = Date.now();
try {
  await waitHealthy(proc, BASE);
  log(`实例健康（${Math.round((Date.now() - startedAt) / 1000)}s）`);

  const done = completedIds(OUT, 'id', readFileSync);
  if (done.size > 0) log(`断点续跑：已有 ${done.size} 题完成`);

  const write = await writeDocuments(api, log, documents, {
    tag: 'cn-eval',
    idOf: (doc) => doc.id,
    sourceRefOf: (doc) => doc.title,
  });
  log(`写入完成 ${write.written} 篇（失败 ${write.failed}）耗时 ${write.writeSec}s`);

  const indexStartedAt = Date.now();
  const indexed = await waitIndexReady(DATA_DIR);
  log(`索引就绪=${indexed} 耗时 ${Math.round((Date.now() - indexStartedAt) / 1000)}s`);

  for (const question of questions) {
    if (done.has(question.id)) continue;
    const questionStartedAt = Date.now();
    let recall = null;
    let recallError = null;
    try {
      recall = await api('/api/recall', {
        query: question.question,
        limit: LIMIT,
        contextTokenBudget: 2000,
      }, 'POST', 240_000);
    } catch (error) {
      recallError = String(error).slice(0, 200);
    }
    const recalledTitles = (recall?.memories ?? []).map((m) => m.memory?.sourceRef);
    const context = recall?.context?.trim() || '';
    // 作答超时/报错**不能**让整轮评测崩掉：记为 error 行，续跑时会重试（completedIds 不含 error 行）。
    let answerError = null;
    let hypothesis = '';
    if (!recallError) {
      try {
        hypothesis = await answerWith(
          '只依据给出的文档上下文回答用户问题。必须用简体中文回答，答案要简短直接'
          + '（一个词或一句话）。如果文档上下文里没有答案，就回答：不知道。',
          question.question,
          context || '（无可用文档）',
        );
      } catch (error) {
        answerError = String(error).slice(0, 200);
      }
    }
    const goldRank = question.gold_titles.length
      ? Math.max(...question.gold_titles.map((title) => recalledTitles.indexOf(title) + 1))
      : 0;
    const row = {
      id: question.id,
      type: question.type,
      question: question.question,
      answer: question.answer,
      gold_titles: question.gold_titles,
      recalled_titles: recalledTitles,
      recalled_count: recalledTitles.length,
      gold_rank: goldRank,
      quality: recall?.qualityState,
      context_chars: context.length,
      hypothesis,
      verdict: (recallError ?? answerError)
        ? `error:${recallError ?? answerError}`
        : cnVerdict(question, hypothesis),
      elapsed_sec: Math.round((Date.now() - questionStartedAt) / 1000),
      profile: PROFILE,
      filler: FILLER_OVERRIDE ?? null,
      scale: SCALE,
    };
    appendFileSync(OUT, `${JSON.stringify(row)}\n`);
    log(`${row.id} [${row.type}] 召回${row.recalled_count}条 gold排名=${goldRank || '-'} `
      + `q=${row.quality} ${row.verdict} ${row.elapsed_sec}s | ${hypothesis.slice(0, 60)}`);
  }

  // ── 汇总：三类题分开报，混在一起会掩盖弃答问题
  const allRows = existsSync(OUT)
    ? readFileSync(OUT, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
    : [];
  const rows = allRows.filter((row) => !String(row.verdict ?? '').startsWith('error'));
  // 出错题不计入任何指标，但必须计数示人——否则「跑了一半」会被读成完整结果。
  const errorRows = allRows.filter((row) => String(row.verdict ?? '').startsWith('error'));
  const answerable = rows.filter((row) => row.type !== 'unanswerable');
  const unanswerable = rows.filter((row) => row.type === 'unanswerable');
  const tally = (list, verdict) => list.filter((row) => row.verdict === verdict).length;
  const summary = {
    tag: TAG,
    profile: PROFILE,
    documents: documents.length,
    questions: rows.length,
    errors: errorRows.length,
    error_ids: errorRows.map((row) => row.id),
    // 作答层
    correct: tally(answerable, 'correct'),
    wrong: tally(answerable, 'wrong'),
    wrong_abstain: tally(answerable, 'wrong_abstain'),
    answerable_accuracy: answerable.length
      ? Number((tally(answerable, 'correct') / answerable.length).toFixed(4)) : null,
    // 弃答层（企业场景的第一投诉点）
    correct_abstain: tally(unanswerable, 'correct_abstain'),
    overconfident: tally(unanswerable, 'overconfident'),
    abstention_accuracy: unanswerable.length
      ? Number((tally(unanswerable, 'correct_abstain') / unanswerable.length).toFixed(4)) : null,
    // 召回层
    ...recallSummary(rows.map((row) => row.gold_rank)),
    write_sec: write.writeSec,
    indexed,
    total_sec: Math.round((Date.now() - startedAt) / 1000),
  };
  writeFileSync(path.join(WORK, `summary-${TAG}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  log(`=== 汇总 ${JSON.stringify(summary)} ===`);
  log(`=== 完成，共 ${summary.total_sec}s，结果 ${OUT} ===`);
} finally {
  await stopInstance(proc, logFd);
}
