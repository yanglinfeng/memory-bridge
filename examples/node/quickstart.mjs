#!/usr/bin/env node
/**
 * 忆桥接入示例 · Node
 *
 * 覆盖：健康检查 → 写入文档切片 → 幂等重放 → 召回 → 发布修订版 → 时序对照查询
 *
 * 用法：
 *   export MB_TOKEN=你的令牌          # 见 examples/README.md §1
 *   node examples/node/quickstart.mjs
 *
 * 可选：
 *   MB_BASE=http://127.0.0.1:3789     # 默认打到本机 3789
 *
 * 零依赖：只用 Node 内置的 fetch（需 Node ≥ 18）。生产代码建议加超时、重试与并发控制。
 */

const BASE = process.env.MB_BASE || 'http://127.0.0.1:3789';
const TOKEN = process.env.MB_TOKEN || '';
const KEY = `kb:example-handbook:ch3-s2-${Date.now()}`;

async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

const hr = (t) => console.log(`\n──── ${t} ────`);
const round3 = (n) => Math.round(n * 1000) / 1000;

console.log(`目标：${BASE}`);
if (!TOKEN) console.log('（未设置 MB_TOKEN：仅健康检查会成功，其余会得到 401）');

// ─────────────────────────────────────────────────────────────── 1. 健康检查
hr('1. 健康检查');
{
  const { status, json } = await req('GET', '/api/health');
  console.log(`HTTP ${status}  ${JSON.stringify(json)}`);
}

// ───────────────────────────────────────────────────── 2. 写入文档切片（v1）
hr('2. 写入文档切片（带 corpusDomain / classification）');
const chunkV1 = {
  kind: 'document_chunk',
  content: '员工考勤规定：每周须到岗 4 天，其余 1 天可远程办公。迟到超过 30 分钟计为半天事假。',
  title: '员工手册 > 第三章 考勤 > 3.2 到岗要求',
  tags: ['kb:document-chunk', 'kb:file', 'doc:employee-handbook'],
  source: 'kb:file',
  sourceRef: 'employee-handbook.md#ch3-s2',
  idempotencyKey: KEY,
  importance: 0.5,
  occurredAt: '2026-09-01T00:00:00Z',
  corpusDomain: 'policy',        // 制度/合同类：门槛 0.9，宁可拒答也不放行
  classification: 'internal',    // 全员可见但需登录；机密用 confidential，公开用 public
};

const first = await req('POST', '/api/memories', chunkV1);
console.log(`HTTP ${first.status}`);
const firstId = first.json?.memory?.id;
console.log('memory.id      =', firstId);
console.log('origin         =', first.json?.memory?.origin, '  （服务端强制打标，客户端无法伪造）');
console.log('corpusDomain   =', first.json?.memory?.corpusDomain);
console.log('classification =', first.json?.memory?.classification);
if (!firstId) {
  console.error('\n写入未拿到 memory.id，后续步骤无法继续。原始响应：');
  console.error(JSON.stringify(first.json, null, 2));
  process.exit(1);
}

// ────────────────────────────────────────────────────── 3. 幂等：同键重放一次
hr('3. 幂等重放（同一 idempotencyKey）');
{
  const again = await req('POST', '/api/memories', chunkV1);
  console.log(`HTTP ${again.status}`);
  console.log('created        =', again.json?.created);
  console.log('deduplicated   =', again.json?.deduplicated, '  （true = 命中已有条目，未产生重复）');
  console.log('id 是否相同    =', again.json?.memory?.id === firstId ? '是' : '否');
}

// ────────────────────────────────────────────────────────────────────── 4. 召回
hr('4. 召回（查询措辞带上正文关键词，避免 policy 门槛拒答）');
{
  const { status, json } = await req('POST', '/api/recall', {
    query: '员工考勤规定 每周须到岗 天 远程办公',
    limit: 3,
    contextTokenBudget: 800,
  });
  console.log(`HTTP ${status}   qualityState = ${json.qualityState}`);
  console.log('traceId =', json.traceId);
  for (const m of json.memories ?? []) {
    console.log(`  score=${round3(m.score)}  ${m.memory.content.slice(0, 40)}`);
  }
  console.log('\ncontext（可直接拼进 LLM prompt）：');
  console.log(String(json.context).split('\n').map((l) => `  | ${l}`).join('\n'));
}

// ──────────────────────────────────────── 5. 发布修订版（supersede 取代旧版）
hr('5. 发布修订版（supersedesId 显式声明取代）');
{
  const { status, json } = await req('POST', '/api/memories', {
    kind: 'document_chunk',
    content: '员工考勤规定（修订版）：每周须到岗 3 天，其余 2 天可远程办公。',
    title: '员工手册 > 第三章 考勤 > 3.2 到岗要求（2026-09 修订）',
    tags: ['kb:document-chunk', 'kb:file', 'doc:employee-handbook'],
    source: 'kb:file',
    sourceRef: 'employee-handbook.md#ch3-s2-v2',
    idempotencyKey: `${KEY}-v2`,
    validFrom: '2026-09-20T00:00:00Z',
    supersedesId: firstId,
    corpusDomain: 'policy',
    classification: 'internal',
  });
  console.log(`HTTP ${status}    新片段 id = ${json.memory?.id}`);
  console.log('                validFrom =', json.memory?.validFrom);
  const old = await req('GET', `/api/memories/${firstId}`);
  console.log('旧片段 status =', old.json?.memory?.status ?? old.json?.status, '  （应为 superseded）');
}

// ──────────────────────────────────────────────────── 6. 时序对照：现在 vs 过去
const q = { query: '员工考勤规定 每周须到岗 天 远程办公', limit: 3 };

hr('6a. 查「现在」——应只出现修订版（3 天）');
{
  const { json } = await req('POST', '/api/recall', q);
  for (const m of json.memories ?? []) {
    console.log(`  ${m.memory.content.slice(0, 42)}｜status=${m.memory.status}`);
  }
}

hr('6b. 查「过去时点 2026-09-10」——应只出现当时的旧版（4 天）');
{
  const { json } = await req('POST', '/api/recall', { ...q, timestamp: '2026-09-10T00:00:00Z' });
  for (const m of json.memories ?? []) {
    console.log(`  ${m.memory.content.slice(0, 42)}｜status=${m.memory.status}`);
  }
}

console.log('\n完成。这些数据写在你的数据目录里（示例用固定前缀 kb:example-handbook: 便于识别与清理）。');
