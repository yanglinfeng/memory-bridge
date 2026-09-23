#!/usr/bin/env node
// 忆桥多租户隔离验收脚本（建议纳入 CI / 每次上线前跑）
//
// 覆盖：认证开关、写读同源、部门互不可见、会话生命周期、错误语义。
// 用法：
//   KB_BASE_URL=http://127.0.0.1:3789 \
//   KB_TOKEN_INGEST=<入库主体令牌> KB_TOKEN_READER=<另一部门主体令牌> \
//   node scripts/kb-isolation-acceptance.mjs
//
// 也可用 KB_TOKEN_FILE 指向 scripts/kb-provision.mjs apply --token-out 产出的文件：
//   KB_TOKEN_FILE=/secure/kb-tokens.json KB_TOKEN_INGEST_PRINCIPAL=kb-writer \
//   KB_TOKEN_READER_PRINCIPAL=kb-reader-finance node scripts/kb-isolation-acceptance.mjs
//
// 退出码 0 = 全部通过；1 = 有失败（会打印失败项）。

import fs from 'node:fs';

const BASE = process.env.KB_BASE_URL || 'http://127.0.0.1:3789';
const INGEST_DEPT = process.env.KB_INGEST_DEPT || 'dept-verify-a';
const OTHER_DEPT = process.env.KB_OTHER_DEPT || 'dept-verify-b';
const UNAUTHORIZED_DEPT = process.env.KB_UNAUTHORIZED_DEPT || 'dept-verify-none';

function loadTokens() {
  if (process.env.KB_TOKEN_INGEST && process.env.KB_TOKEN_READER) {
    return {
      ingest: process.env.KB_TOKEN_INGEST,
      reader: process.env.KB_TOKEN_READER,
    };
  }
  const file = process.env.KB_TOKEN_FILE;
  if (!file) {
    throw new Error(
      '需要 KB_TOKEN_INGEST + KB_TOKEN_READER，或用 KB_TOKEN_FILE 指向令牌文件',
    );
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pick = (principalId) => {
    const hit = parsed.tokens.find((entry) => entry.principalId === principalId);
    if (!hit) throw new Error(`令牌文件里找不到主体 ${principalId}`);
    return hit.token;
  };
  return {
    ingest: pick(process.env.KB_TOKEN_INGEST_PRINCIPAL || 'kb-writer'),
    reader: pick(process.env.KB_TOKEN_READER_PRINCIPAL || 'kb-reader-finance'),
  };
}

const tokens = loadTokens();

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
}

async function req(method, path, { token, session, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (session) headers['x-memory-session-id'] = session;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text.slice(0, 200);
  }
  return { status: res.status, json };
}

const stamp = Date.now();
const chunk = (content, key, extra = {}) => ({
  kind: 'document_chunk',
  content,
  idempotencyKey: key,
  source: 'kb:acceptance',
  corpusDomain: 'policy',
  validFrom: '2026-01-01T00:00:00Z',
  ...extra,
});

const A_MARKER = `验收标记甲-${stamp}`;
const B_MARKER = `验收标记乙-${stamp}`;

// ── 1. 认证开关 ──
{
  const res = await req('GET', '/api/memories');
  record('匿名无令牌访问受保护路由被拒（401）', res.status === 401, `HTTP ${res.status}`);
}
{
  const res = await req('GET', '/api/memories', { token: 'mb1.bogus.bogus' });
  record('伪造令牌被拒（401）', res.status === 401, `HTTP ${res.status}`);
}
{
  const res = await req('GET', '/api/memories', { token: tokens.ingest });
  record('有效令牌放行（200）', res.status === 200, `HTTP ${res.status}`);
}
{
  const res = await req('GET', '/api/health');
  record('探活端点无需令牌（200，运维依赖）', res.status === 200, `HTTP ${res.status}`);
}

// ── 2. 写入（带授权 scope） ──
{
  const res = await req('POST', '/api/memories', {
    token: tokens.ingest,
    body: chunk(`${A_MARKER}：本部门差旅住宿标准为每人每晚 500 元。`, `kb:${INGEST_DEPT}:verify:a-${stamp}`, {
      scopeType: 'project',
      scopeKey: INGEST_DEPT,
    }),
  });
  record(`写入 ${INGEST_DEPT} 文档（201）`, res.status === 201, `HTTP ${res.status}`);
}
{
  const res = await req('POST', '/api/memories', {
    token: tokens.ingest,
    body: chunk(`${B_MARKER}：另一部门调薪规则为基本工资的 12%。`, `kb:${OTHER_DEPT}:verify:b-${stamp}`, {
      scopeType: 'project',
      scopeKey: OTHER_DEPT,
    }),
  });
  record(`写入 ${OTHER_DEPT} 文档（201）`, res.status === 201, `HTTP ${res.status}`);
}

// ── 3. 写读同源 ──
{
  const res = await req('POST', '/api/memories', {
    token: tokens.reader,
    body: chunk('越权写入尝试。', `kb:${OTHER_DEPT}:verify:evil-${stamp}`, {
      scopeType: 'project',
      scopeKey: OTHER_DEPT,
    }),
  });
  record('无权限主体越权写他部门 scope 被拒（403）', res.status === 403, `HTTP ${res.status}`);
}

// ── 4. 会话签发 ──
let ingestSession;
{
  const res = await req('POST', '/api/sessions', {
    token: tokens.ingest,
    body: { scopes: [{ scopeType: 'project', scopeKey: INGEST_DEPT }], ttlSeconds: 600 },
  });
  ingestSession = res.json?.sessionId;
  record('签发本部门会话（201）', res.status === 201 && !!ingestSession, `HTTP ${res.status}`);
}
{
  const res = await req('POST', '/api/sessions', {
    token: tokens.reader,
    body: { scopes: [{ scopeType: 'project', scopeKey: OTHER_DEPT }] },
  });
  record('无权限主体越权签发他部门会话被拒（403）', res.status === 403, `HTTP ${res.status}`);
}
{
  const res = await req('POST', '/api/sessions', {
    token: tokens.ingest,
    body: { scopes: [{ scopeType: 'project', scopeKey: UNAUTHORIZED_DEPT }] },
  });
  record('签发未授权 scope 被拒（403）', res.status === 403, `HTTP ${res.status}`);
}
{
  const res = await req('POST', '/api/sessions', {
    token: tokens.ingest,
    body: { scopes: [], ttlSeconds: 600 },
  });
  record('空 scopes 被拒（400）', res.status === 400, `HTTP ${res.status}`);
}

// ── 5. 召回可见性 ──
async function recallContent(token, session, query) {
  const res = await req('POST', '/api/recall', {
    token,
    session,
    body: { query, limit: 8, kinds: ['document_chunk'] },
  });
  return {
    status: res.status,
    contents: (res.json?.memories ?? []).map((m) => m.memory?.content ?? ''),
  };
}
{
  const r = await recallContent(tokens.ingest, ingestSession, A_MARKER);
  const hitOwn = r.contents.some((t) => t.includes(A_MARKER));
  const hitOther = r.contents.some((t) => t.includes(B_MARKER));
  record('带本部门会话：能看到本部门文档', r.status === 200 && hitOwn, `HTTP ${r.status}，命中 ${r.contents.length} 条`);
  record('带本部门会话：看不到他部门文档（隔离生效）', !hitOther, hitOther ? '⚠ 泄漏！' : '无泄漏');
}
{
  const r = await recallContent(tokens.ingest, undefined, A_MARKER);
  const leaked = r.contents.some((t) => t.includes(A_MARKER) || t.includes(B_MARKER));
  record('不带会话：部门文档全部不可见（收窄 personal/self）', !leaked, `HTTP ${r.status}，命中 ${r.contents.length} 条`);
}

// ── 5.5 可见性模型 v2：交叉主体（A 写 → B 读） ──
// 验收铁律：召回类验收必须做交叉主体矩阵。只用写入方自己召回会
// 系统性漏掉跨主体路径（v1 时代 20/20 全绿却漏掉真风险的教训）。
let readerSessionA;
{
  const res = await req('POST', '/api/sessions', {
    token: tokens.reader,
    body: { scopes: [{ scopeType: 'project', scopeKey: INGEST_DEPT }], ttlSeconds: 600 },
  });
  readerSessionA = res.json?.sessionId;
  record('另一主体签发同部门会话（201）', res.status === 201 && !!readerSessionA, `HTTP ${res.status}`);
}
{
  const r = await recallContent(tokens.reader, readerSessionA, A_MARKER);
  const hit = r.contents.some((t) => t.includes(A_MARKER));
  record('可见性 v2：另一主体（同 scope 会话）能看到写入方的部门文档', r.status === 200 && hit,
    hit ? '跨主体可见 ✓' : `HTTP ${r.status}，命中 ${r.contents.length} 条 — 跨主体仍不可见？`);
}

// ── 5.6 幂等键跨 scope 不再静默去重（v43） ──
{
  const dupKey = `kb:${INGEST_DEPT}:verify:idem-x-${stamp}`;
  const first = await req('POST', '/api/memories', {
    token: tokens.ingest,
    body: chunk(`幂等键跨部门甲-${stamp}。`, dupKey, {
      scopeType: 'project', scopeKey: INGEST_DEPT,
    }),
  });
  const second = await req('POST', '/api/memories', {
    token: tokens.ingest,
    body: chunk(`幂等键跨部门乙-${stamp}。`, dupKey, {
      scopeType: 'project', scopeKey: OTHER_DEPT,
    }),
  });
  record(
    '同账号同幂等键写两个部门：各自独立落库（v43 前:第二个静默去重）',
    first.status === 201 && second.status === 201 && second.json?.deduplicated !== true,
    `first=${first.status} second=${second.status} dedup=${second.json?.deduplicated}`,
  );
}

// ── 5.7 密级（fail-closed：无密级会话必须看不到机密） ──
{
  const res = await req('POST', '/api/memories', {
    token: tokens.ingest,
    body: chunk(`机密标记丙-${stamp}：高管薪酬数据。`, `kb:${INGEST_DEPT}:verify:c-${stamp}`, {
      scopeType: 'project', scopeKey: INGEST_DEPT, classification: 'confidential',
    }),
  });
  record('写入机密文档（201）', res.status === 201, `HTTP ${res.status}`);
}
{
  const r = await recallContent(tokens.reader, readerSessionA, `机密标记丙-${stamp}`);
  const leaked = r.contents.some((t) => t.includes(`机密标记丙-${stamp}`));
  record('默认密级会话（internal）：看不到机密文档', !leaked,
    leaked ? '⚠ 机密泄漏！' : `HTTP ${r.status}，命中 ${r.contents.length} 条`);
}

// ── 5.8 匿名公开通道（仅当服务以 public-readonly 启动时执行） ──
if (process.env.KB_EXPECT_ANONYMOUS === '1') {
  const pubMarker = `公开标记丁-${stamp}`;
  {
    const res = await req('POST', '/api/memories', {
      token: tokens.ingest,
      body: chunk(`${pubMarker}：对外公开的企业简介。`, `kb:public:verify:d-${stamp}`, {
        scopeType: 'public', scopeKey: 'public', classification: 'public',
      }),
    });
    record('写入公开文档（public scope + public 密级，201）', res.status === 201, `HTTP ${res.status}`);
  }
  {
    const r = await recallContent(undefined, undefined, pubMarker);
    const hit = r.contents.some((t) => t.includes(pubMarker));
    record('匿名（无令牌）可召回公开文档', r.status === 200 && hit, `HTTP ${r.status}，命中 ${r.contents.length} 条`);
  }
  {
    const r = await recallContent(undefined, undefined, A_MARKER);
    const leaked = r.contents.some((t) => t.includes(A_MARKER));
    record('匿名看不到部门文档', !leaked, leaked ? '⚠ 匿名越权！' : '无泄漏');
  }
  {
    const res = await req('POST', '/api/memories', {
      body: chunk('匿名写入尝试。', `kb:evil-${stamp}`),
    });
    record('匿名写入被拒（401，仅召回白名单）', res.status === 401, `HTTP ${res.status}`);
  }
  {
    const res = await req('POST', '/api/sessions', {
      body: { scopes: [{ scopeType: 'public', scopeKey: 'public' }] },
    });
    record('匿名签发会话被拒（401）', res.status === 401, `HTTP ${res.status}`);
  }
}

// ── 6. 会话生命周期 ──
{
  const res = await req('DELETE', `/api/sessions/${ingestSession}`, { token: tokens.ingest });
  record('吊销会话成功', res.status === 200 || res.status === 204, `HTTP ${res.status}`);
  const after = await recallContent(tokens.ingest, ingestSession, A_MARKER);
  record('吊销后召回返回 401（不回落放大）', after.status === 401, `HTTP ${after.status}`);
}
{
  const res = await req('GET', `/api/sessions/${ingestSession}`, { token: tokens.reader });
  record('查他人会话返回 404（主体隔离）', res.status === 404, `HTTP ${res.status}`);
}
{
  const res = await req('GET', `/api/sessions/${ingestSession}`, { token: tokens.ingest });
  record('查自己的会话返回 200 且带 revokedAt', res.status === 200 && !!res.json?.revokedAt, `HTTP ${res.status}`);
}

// ── 7. 错误语义 ──
{
  const res = await req('POST', '/api/recall', {
    token: tokens.ingest,
    session: '11111111-1111-4111-8111-111111111111',
    body: { query: A_MARKER, limit: 5, kinds: ['document_chunk'] },
  });
  record(
    '不存在的 sessionId 被拒（注意真实错误文本，见手册 §7.1）',
    res.status !== 200,
    `HTTP ${res.status}：${String(res.json?.error ?? JSON.stringify(res.json)).slice(0, 90)}`,
  );
}
{
  const res = await req('POST', '/api/recall', {
    token: tokens.ingest,
    body: { query: 'x', scopeType: 'project', scopeKey: OTHER_DEPT },
  });
  record('召回请求体带 scopeType 被拒（客户端不可提权）', res.status >= 400, `HTTP ${res.status}`);
}

// ── 汇总 ──
const failed = results.filter((r) => !r.ok);
console.log(
  `\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`,
);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name}（${f.detail}）`);
  process.exitCode = 1;
}
