// 基准评测的公共脚手架：内核实例生命周期、带鉴权的 API 客户端、索引就绪等待。
//
// 设计约束（踩过的坑，别改）：
// - **实例与正式库严格隔离**：每个评测自带 `MEMORY_BRIDGE_DATA_DIR` 与独立端口，
//   绝不触碰生产数据目录。
// - **代理变量必须删掉**：内核是本机 HTTP，若继承 `HTTPS_PROXY` 会连不上自己。
// - **召回前必须等索引**：写入是异步索引，`memory_jobs` 里还有 pending/running
//   时召回会得到不完整候选池（表现为"莫名召回不到"）。
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PROXY_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
  'all_proxy', 'ALL_PROXY',
];

/** 仓库根目录（由本文件位置反推，不写死绝对路径）。 */
export function repoRoot() {
  return process.env.MEMORY_BRIDGE_BENCH_KERNEL
    // 必须用 fileURLToPath 而非 URL.pathname：后者保留 %20 转义，
    // 检出路径含空格时会拼出不存在的路径（实测踩过）。
    || path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
}

/** 评测产物根目录；默认 `benchmarks/.work`，已列入 .gitignore。 */
export function workRoot() {
  return process.env.MEMORY_BRIDGE_BENCH_WORKDIR
    || path.join(repoRoot(), 'benchmarks', '.work');
}

export function ollamaBase() {
  return process.env.MEMORY_BRIDGE_BENCH_OLLAMA || 'http://127.0.0.1:11434';
}

export function answerModel() {
  return process.env.MEMORY_BRIDGE_BENCH_ANSWER_MODEL || 'qwen2.5:14b';
}

/** 日志：同时打到 stdout 与文件，便于长跑后回溯。 */
export function createLogger(logPath) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    appendFileSync(logPath, `${line}\n`);
  };
}

/**
 * 启动一个隔离的内核实例。
 *
 * @param {object} options
 * @param {string} options.dataDir  该实例的数据目录
 * @param {number} options.port     监听端口（每个基准独占）
 * @param {string} options.token    鉴权令牌
 * @param {Record<string,string>} [options.env] 额外的 MEMORY_BRIDGE_* 覆盖
 */
export function startInstance({ dataDir, port, token, env = {} }) {
  mkdirSync(dataDir, { recursive: true });
  const logFd = openSync(path.join(dataDir, 'server.log'), 'a');
  const childEnv = {
    ...process.env,
    MEMORY_BRIDGE_DATA_DIR: dataDir,
    MEMORY_BRIDGE_PORT: String(port),
    MEMORY_BRIDGE_TOKEN: token,
    // 长跑时不让模型被卸载，避免每次召回都重载（耗时数据会失真）
    MEMORY_BRIDGE_MODEL_KEEP_ALIVE: '-1',
    // 语义步默认 120s。实测 Ollama 冷加载 bge-m3 要 85s，一旦中途被卸载，
    // 单次 embed 就会顶穿 120s → provider_transport_error → 整条语义链路
    // 静默降级（结果里只是 quality=degraded，指标却照算）。放宽到 300s
    // 是为了让召回反映检索质量，而不是反映模型加载速度。这是**评测条件**，必须随结果一起报。
    MEMORY_BRIDGE_SEMANTIC_TIMEOUT_MS: '300000',
    ...env,
  };
  for (const key of PROXY_KEYS) delete childEnv[key];
  const proc = spawn(process.execPath, ['dist/server/index.js'], {
    cwd: repoRoot(),
    env: childEnv,
    stdio: ['ignore', logFd, logFd],
  });
  return { proc, dataDir, logFd };
}

export async function waitHealthy(proc, base, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `实例启动即退出（code=${proc.exitCode}）。`
        + '常见原因：端口被上一轮残留实例占用，或 dist 未构建（npm run build:server）。',
      );
    }
    try {
      const res = await fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return;
    } catch {
      // 尚未监听，继续等
    }
    await sleep(1_000);
  }
  throw new Error(`实例健康检查超时（${timeoutMs} ms），端口可能被占用`);
}

export function stopInstance(proc, logFd) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) {
      try { closeSync(logFd); } catch {}
      return resolve();
    }
    const killer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve();
    }, 8_000);
    proc.once('exit', () => {
      clearTimeout(killer);
      try { closeSync(logFd); } catch {}
      resolve();
    });
    try { proc.kill('SIGTERM'); } catch { resolve(); }
  });
}

/**
 * 等异步索引清空后再召回——否则候选池不完整，指标会偏低且不可复现。
 */
export async function waitIndexReady(dataDir, timeoutMs = 1_800_000) {
  const deadline = Date.now() + timeoutMs;
  const db = new DatabaseSync(path.join(dataDir, 'memory-bridge.sqlite3'));
  try {
    while (Date.now() < deadline) {
      const row = db
        .prepare(
          `SELECT count(*) AS n FROM memory_jobs
           WHERE job_type IN ('index_memory', 'backfill_dense_index')
             AND status IN ('pending', 'running')`,
        )
        .get();
      if (!row || Number(row.n) === 0) return true;
      await sleep(2_000);
    }
    return false;
  } finally {
    try { db.close(); } catch {}
  }
}

/** 带鉴权的 JSON API 客户端。 */
export function createApi(base, token) {
  return async function api(pathname, body, method = 'POST', timeoutMs = 120_000) {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${pathname} -> ${res.status} 非 JSON：${text.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(`${pathname} -> ${res.status}：${text.slice(0, 300)}`);
    return json;
  };
}

/** 调用 Ollama 作答（与各基准脚本共用同一形态，仅 system prompt 不同）。 */
export async function answerWith(systemPrompt, question, contextText) {
  const res = await fetch(`${ollamaBase()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: answerModel(),
      stream: false,
      // 与内核一致地钉住模型：不设的话 Ollama 按默认 5 分钟卸载，
      // 中途重载会让作答耗时里混进几十秒的加载时间（实测冷加载 bge-m3 需 85s）。
      keep_alive: process.env.MEMORY_BRIDGE_BENCH_KEEP_ALIVE ?? -1,
      options: { temperature: 0, num_predict: 64 },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `文档上下文：\n${contextText}\n\n问题：${question}` },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  }).then((r) => r.json());
  return (res?.message?.content ?? '').trim();
}

/** 断点续跑：读结果文件里已完成的题号（错误行不算完成）。 */
export function completedIds(outPath, idField, readFileSyncImpl) {
  const done = new Set();
  if (!readFileSyncImpl) return done;
  try {
    for (const line of readFileSyncImpl(outPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const verdict = String(row.verdict ?? '');
        if (row.error || verdict.startsWith('error')) continue;
        if (row[idField]) done.add(row[idField]);
      } catch {
        // 半行（上次被 kill）忽略
      }
    }
  } catch {
    // 文件不存在
  }
  return done;
}

/** 逐条直写文档，带重试；返回写入统计。 */
export async function writeDocuments(api, log, documents, { tag, sourceRefOf, idOf }) {
  const base = Date.UTC(2026, 8, 1, 12, 0, 0);
  let written = 0;
  let failed = 0;
  const started = Date.now();
  for (const [i, doc] of documents.entries()) {
    const payload = {
      kind: 'document_chunk',
      content: doc.content,
      occurredAt: new Date(base + i * 60_000).toISOString(),
      tags: ['kb:document-chunk', tag, `doc:${idOf(doc)}`],
      source: 'kb:file',
      sourceRef: sourceRefOf(doc),
      idempotencyKey: `${tag}:${idOf(doc)}`,
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
          log(`写入失败 ${idOf(doc)}：${String(error).slice(0, 150)}`);
        } else {
          await sleep(2_000);
        }
      }
    }
    if (ok) written++;
    if (written > 0 && written % 200 === 0) {
      log(`已写入 ${written}/${documents.length}（${Math.round((Date.now() - started) / 1000)}s）`);
    }
  }
  return { written, failed, writeSec: Math.round((Date.now() - started) / 1000) };
}
