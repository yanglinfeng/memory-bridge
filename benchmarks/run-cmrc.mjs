// CMRC 2018 中文抽取式问答评测：考"1000 篇库里找得到 + 原文答得出"。
//
// 数据：hfl/cmrc2018（中文维基，官方 EM/F1 口径，**字符级**）。
//   100 题（validation 抽样）+ 1000 篇文档库（96 金 + 904 train 干扰）。
//
// 与自建 cn-eval 的分工：
//   - CMRC 有官方口径与量级，但没有不可答题，所以**测不出弃答**；
//   - 弃答能力由 `run-cn.mjs` 的 2 道不可答题覆盖。
//   **两者数值不可横比。**
//
// content 逐字直写 context：抽取式答案对原文位置敏感，改写会直接毁掉分数。
//
// 用法：
//   node benchmarks/run-cmrc.mjs
//   MEMORY_BRIDGE_BENCH_PROFILE=eager MEMORY_BRIDGE_BENCH_LIMIT=8 node benchmarks/run-cmrc.mjs
//   MEMORY_BRIDGE_BENCH_EXTRACT=1 node benchmarks/run-cmrc.mjs   # 抽取式约束作答（对齐官方口径的对照）
//
// 断点续跑：重跑时跳过结果文件里已完成且非 error 的题。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  answerWith, completedIds, createApi, createLogger, startInstance,
  stopInstance, waitHealthy, waitIndexReady, workRoot,
} from './lib/harness.mjs';
import { cmrcEm, cmrcF1, recallSummary } from './lib/scoring.mjs';

const PORT = Number(process.env.MEMORY_BRIDGE_BENCH_PORT || 3792);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.MEMORY_BRIDGE_BENCH_TOKEN || 'bench-local-token';
const N_Q = Number(process.env.MEMORY_BRIDGE_BENCH_N || 100);
const LIMIT = Number(process.env.MEMORY_BRIDGE_BENCH_LIMIT || 8);
const PROFILE = process.env.MEMORY_BRIDGE_BENCH_PROFILE || 'balanced';
const EXTRACT = process.env.MEMORY_BRIDGE_BENCH_EXTRACT || '';
const TAG = process.env.MEMORY_BRIDGE_BENCH_TAG || `cmrc-n${N_Q}-${PROFILE}`;

const WORK = workRoot();
const DATA_DIR = path.join(WORK, `memdata-${TAG}`);
const OUT = path.join(WORK, `results-${TAG}.jsonl`);
const LOG = path.join(WORK, `progress-${TAG}.log`);
const HERE = fileURLToPath(new URL('.', import.meta.url));
const CORPUS_FILE = process.env.MEMORY_BRIDGE_BENCH_CORPUS
  || path.join(WORK, 'corpus', `cmrc-corpus-${N_Q}.json`);
const QUESTIONS_FILE = process.env.MEMORY_BRIDGE_BENCH_QUESTIONS
  || path.join(WORK, 'corpus', `cmrc-questions-${N_Q}.json`);

const log = createLogger(LOG);
const api = createApi(BASE, TOKEN);

/**
 * 作答口径三档，与原始评测保持一致（`EXTRACT=1/2` 用于对照实验，默认对话式）：
 * 生产作答按业务需要选，基准默认取对话式，避免"抽取式约束"把分数抬高到不可比。
 */
function systemPrompt() {
  if (EXTRACT === '2') {
    return '只依据给出的文档上下文回答用户问题，必须用简体中文回答。'
      + '答案必须是上下文中出现的一段原文，但只保留直接回答问题的最少文字：'
      + '去掉主语、谓语和一切与答案无关的前后文（例如问长度只答距离数字本身）。'
      + '如果文档上下文里没有答案，才回答：不知道。';
  }
  if (EXTRACT === '1') {
    return '只依据给出的文档上下文回答用户问题。必须用简体中文回答。'
      + '答案必须直接摘抄上下文中的原文片段，与原文逐字一致：不要改写、不要概括、'
      + '不要添加任何解释或前后缀。如果文档上下文里没有答案，才回答：不知道。';
  }
  return '只依据给出的文档上下文回答用户问题。必须用简体中文回答，答案要简短直接（一个词或一句话）。'
    + '如果文档上下文里没有答案，就回答：不知道。';
}

for (const [label, file] of [['语料', CORPUS_FILE], ['题目', QUESTIONS_FILE]]) {
  if (!existsSync(file)) {
    console.error(`缺少${label} ${file}\n请先运行：python3 benchmarks/prepare/prepare-cmrc.py --n ${N_Q}`);
    process.exit(1);
  }
}

const corpus = JSON.parse(readFileSync(CORPUS_FILE, 'utf8'));
const allQuestions = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf8'));
// 金文档靠"题目自带的 context 与语料逐字相等"来定位——不额外维护一份对齐表。
const textToId = new Map(corpus.map((doc) => [doc.text, doc.id]));
const questions = allQuestions.slice(0, N_Q).map((q) => ({
  ...q,
  goldDocId: textToId.get(q.context) ?? null,
}));
const missingGold = questions.filter((q) => !q.goldDocId).length;
if (missingGold > 0) log(`⚠️ ${missingGold} 题的金文档未在语料中找到（不计入召回指标）`);

log(`=== CMRC 评测 tag=${TAG} 档案=${PROFILE} 抽取档=${EXTRACT || 'off'}`
  + ` 文档 ${corpus.length} 篇｜题 ${questions.length}｜limit=${LIMIT} ===`);

mkdirSync(WORK, { recursive: true });
const { proc, logFd } = startInstance({
  dataDir: DATA_DIR,
  port: PORT,
  token: TOKEN,
  env: { MEMORY_BRIDGE_ABSTENTION_PROFILE: PROFILE },
});
const startedAt = Date.now();
try {
  await waitHealthy(proc, BASE);
  log(`实例健康（${Math.round((Date.now() - startedAt) / 1000)}s）`);

  const done = completedIds(OUT, 'id', readFileSync);
  if (done.size > 0) log(`断点续跑：已有 ${done.size} 题完成`);

  // ── 直写 1000 篇（逐字原文）
  const base = Date.UTC(2026, 8, 1, 12, 0, 0);
  let written = 0;
  let failed = 0;
  const writeStartedAt = Date.now();
  for (const [i, doc] of corpus.entries()) {
    const payload = {
      kind: 'document_chunk',
      content: doc.text,
      occurredAt: new Date(base + i * 60_000).toISOString(),
      tags: ['kb:document-chunk', 'cmrc-eval', `doc:${doc.id}`],
      source: 'kb:file',
      sourceRef: doc.id,
      idempotencyKey: `cmrc:${doc.id}`,
      importance: 0.5,
    };
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        await api('/api/memories', payload, 'POST', 60_000);
        ok = true;
      } catch (error) {
        if (attempt === 2) {
          failed++;
          log(`写入失败 ${doc.id}：${String(error).slice(0, 150)}`);
        } else {
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
    }
    if (ok) written++;
    if (written > 0 && written % 200 === 0) {
      log(`已写入 ${written}/${corpus.length}（${Math.round((Date.now() - writeStartedAt) / 1000)}s）`);
    }
  }
  const writeSec = Math.round((Date.now() - writeStartedAt) / 1000);
  log(`写入完成 ${written} 篇（失败 ${failed}）耗时 ${writeSec}s`);

  const indexStartedAt = Date.now();
  const indexed = await waitIndexReady(DATA_DIR);
  log(`索引就绪=${indexed} 耗时 ${Math.round((Date.now() - indexStartedAt) / 1000)}s`);

  // ── 逐题：召回 → 作答 → 官方口径 EM/F1
  for (const question of questions) {
    if (done.has(question.id)) {
      log(`${question.id} 已完成，跳过`);
      continue;
    }
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
    const recalledIds = (recall?.memories ?? []).map((m) => m.memory?.sourceRef);
    const context = recall?.context?.trim() || '';
    // 作答超时/报错**不能**让整轮评测崩掉：记为 error 行，续跑时会重试（completedIds 不含 error 行）。
    let answerError = null;
    let hypothesis = '';
    if (!recallError) {
      try {
        hypothesis = await answerWith(systemPrompt(), question.question, context || '（无可用文档）');
      } catch (error) {
        answerError = String(error).slice(0, 200);
      }
    }
    const failed = recallError ?? answerError;
    const goldRank = question.goldDocId ? recalledIds.indexOf(question.goldDocId) + 1 : -1;
    const row = {
      id: question.id,
      question: question.question,
      gold: question.gold,
      goldDocId: question.goldDocId,
      recalled_ids: recalledIds,
      recalled_count: recalledIds.length,
      gold_rank: goldRank,
      quality: recall?.qualityState,
      context_chars: context.length,
      hypothesis,
      em: failed ? 0 : cmrcEm(question.gold, hypothesis),
      f1: failed ? 0 : Number(cmrcF1(question.gold, hypothesis).toFixed(3)),
      verdict: failed ? `error:${failed}` : 'scored',
      elapsed_sec: Math.round((Date.now() - questionStartedAt) / 1000),
      profile: PROFILE,
      extract: EXTRACT || 'off',
    };
    appendFileSync(OUT, `${JSON.stringify(row)}\n`);
    log(`${row.id} gold排名=${goldRank || '-'} q=${row.quality}`
      + ` em=${row.em} f1=${row.f1} ${row.elapsed_sec}s | ${hypothesis.slice(0, 50)}`);
  }

  // ── 汇总（只用本轮有效行；error 行不参与均值）
  const allRows = existsSync(OUT)
    ? readFileSync(OUT, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
    : [];
  const rows = allRows.filter((row) => !String(row.verdict ?? '').startsWith('error'));
  // 出错题不计入任何指标，但必须计数示人——否则「跑了一半」会被读成完整结果。
  const errorRows = allRows.filter((row) => String(row.verdict ?? '').startsWith('error'));
  const mean = (pick) => (rows.length ? rows.reduce((sum, row) => sum + pick(row), 0) / rows.length : 0);
  const summary = {
    tag: TAG,
    profile: PROFILE,
    extract: EXTRACT || 'off',
    docs: corpus.length,
    questions: rows.length,
    errors: errorRows.length,
    error_ids: errorRows.map((row) => row.id),
    em: Number(mean((row) => row.em).toFixed(4)),
    f1: Number(mean((row) => row.f1).toFixed(4)),
    // 召回只统计"金文档确实在语料里"的题
    ...recallSummary(rows.map((row) => (row.goldDocId ? row.gold_rank : 0))),
    write_sec: writeSec,
    indexed,
    total_sec: Math.round((Date.now() - startedAt) / 1000),
  };
  writeFileSync(path.join(WORK, `summary-${TAG}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  log(`=== 汇总 ${JSON.stringify(summary)} ===`);
  log(`=== 完成，共 ${summary.total_sec}s，结果 ${OUT} ===`);
} finally {
  await stopInstance(proc, logFd);
}
