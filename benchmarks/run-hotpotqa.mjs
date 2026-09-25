// HotpotQA（distractor）英文知识库评测：考"检索找不找得到 + 两跳拼不拼得齐"。
//
// 与对话记忆基准（LongMemEval / LoCoMo）不是同一根轴：那套考「记不记得跨会话的事」，
// 这套考「给定文档库能不能找到并答对」。**两套数值不可横比。**
//
// 形态：**一题一实例**（每题自带 10 段落：2 gold + 8 干扰，库很小，全进候选池），
//   → 写入 10 段 → 等索引 → 一次召回 → 英文作答 → 官方 EM/F1 + 检索 R@k/MRR。
//   无需 LLM 裁判，口径全离线可复算。
//
// 用法：
//   node benchmarks/run-hotpotqa.mjs                       # 默认 100 题（bridge 80 / comparison 20）
//   MEMORY_BRIDGE_BENCH_N=10 node benchmarks/run-hotpotqa.mjs   # 冒烟
//
// 前置：`node benchmarks/prepare/prepare-hotpotqa.py` 生成语料；`npm run build:server`。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  answerWith, completedIds, createApi, createLogger, sleep,
  startInstance, stopInstance, waitHealthy, waitIndexReady, workRoot,
} from './lib/harness.mjs';
import { hotpotEmF1 } from './lib/scoring.mjs';

const PORT = Number(process.env.MEMORY_BRIDGE_BENCH_PORT || 3793);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.MEMORY_BRIDGE_BENCH_TOKEN || 'bench-local-token';
const N = Number(process.env.MEMORY_BRIDGE_BENCH_N || 100);
const LIMIT = Number(process.env.MEMORY_BRIDGE_BENCH_LIMIT || 8);
const SMOKE = Number(process.env.MEMORY_BRIDGE_BENCH_SMOKE || 0);

const WORK = workRoot();
const DATA = process.env.MEMORY_BRIDGE_BENCH_DATA
  || path.join(WORK, 'corpus', 'hotpot-distractor.jsonl');
const TAG = process.env.MEMORY_BRIDGE_BENCH_TAG || `hotpot-n${SMOKE || N}`;
const OUT = path.join(WORK, `results-${TAG}.jsonl`);
const LOG = path.join(WORK, `progress-${TAG}.log`);
const DATA_DIR_ROOT = path.join(WORK, `memdata-${TAG}`);

const log = createLogger(LOG);

/**
 * 分层等距抽样：bridge:comparison = 8:2（对齐官方 dev 分布），步长取整保证确定性。
 * 换 N 时抽出的题集不保证是嵌套的，但同一 N 永远得到同一批题。
 */
function sampleQuestions(rows, count) {
  const bridgeCount = Math.round(count * 0.8);
  const plan = { bridge: bridgeCount, comparison: count - bridgeCount };
  const picked = [];
  for (const [type, want] of Object.entries(plan)) {
    const pool = rows.filter((row) => row.type === type);
    const step = Math.max(1, Math.floor(pool.length / want));
    for (let i = 0; i < want && i * step < pool.length; i++) {
      picked.push(pool[i * step]);
    }
  }
  return picked;
}

async function runQuestion(question, index, api) {
  const startedAt = Date.now();
  const dataDir = path.join(DATA_DIR_ROOT, question.id);
  const { proc, logFd } = startInstance({ dataDir, port: PORT, token: TOKEN });
  try {
    await waitHealthy(proc, BASE);

    // 直写 10 个段落。sourceRef 用段落标题——gold 就是按标题匹配的。
    const base = Date.UTC(2026, 8, 1, 12, 0, 0);
    let written = 0;
    let failed = 0;
    for (const [position, title] of question.para_titles.entries()) {
      const text = (question.para_sentences[position] ?? []).join('');
      if (!text.trim()) continue;
      const payload = {
        kind: 'document_chunk',
        content: `${title}. ${text}`,
        occurredAt: new Date(base + position * 60_000).toISOString(),
        tags: ['kb:document-chunk', 'hotpot', `doc:${question.id}`],
        source: 'kb:file',
        sourceRef: title,
        idempotencyKey: `hotpot:${question.id}:${title}`,
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
            log(`Q${index} 写入失败 ${title}：${String(error).slice(0, 150)}`);
          } else {
            await sleep(2_000);
          }
        }
      }
      if (ok) written++;
    }

    const indexed = await waitIndexReady(dataDir);

    // 一次召回。质量降级时重试：索引刚就绪时偶发 degraded，直接算分会低估。
    let recall = null;
    let recallError = null;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        recall = await api('/api/recall', {
          query: question.question, limit: LIMIT, contextTokenBudget: 2000,
        }, 'POST', 180_000);
        if (recall.qualityState === 'full' && (recall.memories?.length ?? 0) > 0) break;
        await sleep(10_000);
      }
    } catch (error) {
      recallError = String(error).slice(0, 200);
    }
    const recalledTitles = (recall?.memories ?? []).map((m) => m.memory.sourceRef);
    // 作答超时/报错**不能**让整轮评测崩掉：写 error 字段，续跑时会重试（completedIds 跳过 error 行）。
    let answerError = null;
    let hypothesis = '';
    if (!recallError) {
      try {
        hypothesis = await answerWith(
          "Answer the user's question using ONLY the provided document context. "
          + 'Always answer in English. Reply with a short, direct answer (a phrase or a few words). '
          + "If the context does not contain the answer, say: I don't know.",
          question.question,
          recall?.context?.trim() || '(no document available)',
        );
      } catch (error) {
        answerError = String(error).slice(0, 200);
      }
    }
    const answerFailed = recallError ?? answerError;
    const { em, f1 } = answerFailed ? { em: 0, f1: 0 } : hotpotEmF1(hypothesis, question.answer);

    // 检索指标：gold 是「段落标题」集合，两跳题要对上两个标题
    const goldTitles = [...new Set(question.gold_titles)];
    const goldRanks = goldTitles.map((title) => recalledTitles.indexOf(title) + 1);
    const mrr = goldRanks.some((rank) => rank > 0)
      ? Math.max(...goldRanks.map((rank) => (rank > 0 ? 1 / rank : 0)))
      : 0;

    const row = {
      question_id: question.id,
      type: question.type,
      question: question.question,
      answer: question.answer,
      gold_titles: goldTitles,
      hypothesis,
      em,
      f1: Number(f1.toFixed(3)),
      recall_at_2: Number((goldRanks.filter((r) => r > 0 && r <= 2).length / goldTitles.length).toFixed(3)),
      recall_at_5: Number((goldRanks.filter((r) => r > 0 && r <= 5).length / goldTitles.length).toFixed(3)),
      recall_at_8: Number((goldRanks.filter((r) => r > 0 && r <= 8).length / goldTitles.length).toFixed(3)),
      mrr: Number(mrr.toFixed(3)),
      gold_ranks: goldRanks,
      recalled_titles: recalledTitles,
      recalled_count: recalledTitles.length,
      recall_quality: recall?.qualityState,
      error: answerFailed,
      written,
      failed,
      indexed,
      elapsed_sec: Math.round((Date.now() - startedAt) / 1000),
    };
    appendFileSync(OUT, `${JSON.stringify(row)}\n`);
    log(`Q${index} [${question.type}] R@2=${row.recall_at_2} gold排名=${goldRanks.join('/')} `
      + `EM=${em} F1=${row.f1} ${row.elapsed_sec}s`);
    return row;
  } finally {
    await stopInstance(proc, logFd);
  }
}

mkdirSync(DATA_DIR_ROOT, { recursive: true });
if (!existsSync(DATA)) {
  console.error(`缺少语料 ${DATA}\n请先运行：node benchmarks/prepare/prepare-hotpotqa.py`);
  process.exit(1);
}

const rows = readFileSync(DATA, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
const questions = SMOKE > 0 ? rows.slice(0, SMOKE) : sampleQuestions(rows, N);
log(`=== HotpotQA 评测 tag=${TAG}｜题 ${questions.length}`
  + `（bridge=${questions.filter((q) => q.type === 'bridge').length}`
  + `/comparison=${questions.filter((q) => q.type === 'comparison').length}）｜limit=${LIMIT} ===`);

const done = completedIds(OUT, 'question_id', readFileSync);
if (done.size > 0) log(`断点续跑：已完成 ${done.size} 题`);

const api = createApi(BASE, TOKEN);
let index = 0;
for (const question of questions) {
  index++;
  if (done.has(question.id)) continue;
  try {
    await runQuestion(question, index, api);
  } catch (error) {
    log(`Q${index} ${question.id} 失败：${String(error).slice(0, 300)}`);
    appendFileSync(OUT, `${JSON.stringify({
      question_id: question.id, type: question.type, question: question.question,
      answer: question.answer, error: String(error).slice(0, 300),
    })}\n`);
  }
}

// ── 汇总 ＋ 归因四桶（把"检索失败"与"生成失败"分开）
const scored = existsSync(OUT)
  ? readFileSync(OUT, 'utf8').split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((row) => row && !row.error)
  : [];
const mean = (list, pick) => (list.length ? list.reduce((sum, row) => sum + pick(row), 0) / list.length : 0);
// 出错题（召回/作答超时）不计入任何指标，但必须计数示人——否则「跑了一半」会被读成完整结果。
const errorRows = existsSync(OUT)
  ? readFileSync(OUT, 'utf8').split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((row) => row?.error)
  : [];
const bucketOf = (row) => {
  const hitAll = row.recall_at_2 === 1;
  const hitSome = row.gold_ranks.some((rank) => rank > 0);
  const abstained = /i don't know|i do not know|不知道/i.test(row.hypothesis);
  if (hitAll) return abstained ? 'C_命中但弃答' : 'D_命中且作答';
  return hitSome ? 'A_检索半miss' : 'B_检索全miss';
};
const summary = {
  tag: TAG,
  questions: scored.length,
  errors: errorRows.length,
  error_ids: errorRows.map((row) => row.question_id),
  em: Number(mean(scored, (row) => row.em).toFixed(4)),
  f1: Number(mean(scored, (row) => row.f1).toFixed(4)),
  // 召回指标按「每条 gold 的平均命中率」聚合，与逐题口径一致。
  // 不要退回只看 gold_ranks[0]：两跳题只算第一条会把召回显著算高，
  // 于是同一份结果里出现两个互相矛盾的召回口径。
  recall_at_2: Number(mean(scored, (row) => row.recall_at_2).toFixed(4)),
  recall_at_5: Number(mean(scored, (row) => row.recall_at_5).toFixed(4)),
  recall_at_8: Number(mean(scored, (row) => row.recall_at_8).toFixed(4)),
  mrr: Number(mean(scored, (row) => row.mrr).toFixed(4)),
  // 归因四桶：D 桶 EM 才是作答层的真实水平（A/B 桶没给全证据，答不对不怪模型）
  buckets: scored.reduce((acc, row) => {
    const key = bucketOf(row);
    acc[key] = acc[key] ?? { count: 0, em: 0 };
    acc[key].count++;
    acc[key].em += row.em;
    return acc;
  }, {}),
  recalled_count_avg: Number(mean(scored, (row) => row.recalled_count).toFixed(2)),
};
for (const [key, value] of Object.entries(summary.buckets)) {
  value.em = Number((value.em / value.count).toFixed(4));
}
writeFileSync(path.join(WORK, `summary-${TAG}.json`), `${JSON.stringify(summary, null, 2)}\n`);
log(`=== 汇总 ${JSON.stringify(summary)} ===`);
