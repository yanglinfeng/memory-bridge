#!/usr/bin/env node
/**
 * 文档 ↔ 代码 一致性校验（零依赖，纯 Node）
 *
 * 把「文档声明的事实」与「代码里的实际事实」机器对撞，用于发布前把关，
 * 以及每次大改（重构 / 新增能力 / 改默认值）之后复核文档是否漂移。
 *
 * 覆盖：
 *   1. 相对链接死链
 *   2. schema 版本口径（"主张当前版本"的措辞 + 文档头部版本声明）
 *   3. 文档里引用的源码路径是否真实存在
 *   4. 运行时环境变量覆盖度（src → 配置参考）
 *   5. npm 脚本覆盖度（package.json → 命令参考）
 *   6. HTTP 路由覆盖度（http 层 → 任一文档）
 *   7. 指定配置项的默认值（代码 ⟷ 配置参考）
 *   8. 不可复现的评测分数残留（README 已声明「不主张分数」）
 *   9. 合规文件存在性与 .gitignore 关键词
 *  10. 历史文档约定条款
 *
 * 用法：
 *   node scripts/check-docs-consistency.mjs [仓库根]
 *   npm run check:docs
 *
 * 退出码：0 = 全通过；1 = 有失败项（便于挂到 CI / release 流程）。
 *
 * 设计约定（重要，别改回去）：
 *   - 历史文档（acceptance-report-* / prd-*）内部数字是「写作时刻的快照」，有意保留，
 *     不参与口径对撞。它们由 docs/README.md 的约定条款显式声明。
 *   - 「主张当前版本」的判定必须**窄**（只认 当前/适用/现行/运行于 等措辞），否则
 *     会把「schema 38 引入…」这类合法历史提及全部误报——但窄到只认「当前」又会漏掉
 *     「适用版本：schema v40」这类头部声明。所以本脚本用「窄措辞 + 独立的头部声明检查」
 *     两个互补通道，避免单通道的漏检。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'bundle', '.memory-bridge-private',
  '.firecrawl', 'coverage', 'playwright-report', 'test-results', 'logs', 'data',
]);

/**
 * 前缀式跳过的目录名。bundle 构建的事务目录形如 `.bundle.stage-<uuid>` /
 * `.bundle.quarantine-<uuid>`（切换失败时 quarantine 会保留为证据），名字带随机
 * UUID 无法逐条列举；它们都是构建产物，不应参与文档事实对撞。
 */
const SKIP_DIR_PREFIXES = ['.bundle.', '.app.'];

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name) || SKIP_DIR_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** 历史文档：内部数字是写作时刻的快照，有意保留，不参与口径对撞。 */
function isHistorical(rel) {
  const base = path.basename(rel);
  return base.startsWith('prd-') || base.startsWith('acceptance-report-');
}

/**
 * 允许出现评测数字的文档。**白名单不是免检**：文件里必须真的带上免责声明，
 * 否则照旧判 FAIL —— 否则「把声明删掉」就能静默把整份文件的数字放行。
 * 这样名单本身不用审，声明一消失门禁就红。
 */
const SCORE_ALLOWLIST = new Map([
  ['sidecar/ce-rerank/README.md', [/本机单次实测快照/]],
  ['BENCHMARKS.md', [/不主张任何分数/, /不是当前命令产出的/]],
  ['docs/testing-and-release.md', [/不代表线上成功率/]],
]);

const results = [];
function add(group, item, ok, detail = '') {
  results.push({ group, item, ok, detail });
}

function walk(dir = REPO, exts) {
  const out = [];
  const rec = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (shouldSkipDir(e.name)) continue;
        rec(path.join(d, e.name));
      } else if (!exts || exts.some((x) => e.name.endsWith(x))) {
        out.push(path.join(d, e.name));
      }
    }
  };
  rec(dir);
  return out;
}

function read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

const rel = (p) => path.relative(REPO, p).split(path.sep).join('/');

const mdFiles = walk(REPO, ['.md']);
const tsFiles = walk(path.join(REPO, 'src'), ['.ts', '.mjs']);
const nonHistMd = mdFiles.filter((p) => !isHistorical(rel(p)));

// ─────────────────────────────────────────────────────────── 1. 相对链接死链
{
  const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
  const dead = [];
  let checked = 0;
  for (const p of mdFiles) {
    for (const m of read(p).matchAll(linkRe)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const pathPart = target.split('#')[0];
      if (!pathPart) continue;
      checked += 1;
      const resolved = path.resolve(path.dirname(p), pathPart);
      if (!fs.existsSync(resolved)) dead.push(`${rel(p)} → ${target}`);
    }
  }
  add('链接', '相对链接死链', dead.length === 0,
    `检查 ${checked} 条，死链 ${dead.length} 条` + (dead.length ? '\n     ' + dead.slice(0, 15).join('\n     ') : ''));
}

// ─────────────────────────────────────────────────────── 2. schema 版本口径
{
  const dbSrc = read(path.join(REPO, 'src/server/database.ts'));
  const cur = (dbSrc.match(/export const SCHEMA_VERSION\s*=\s*(\d+)/) || [])[1] || '?';

  // 通道 A：全库「主张当前版本」的措辞（窄口径，避免误报历史提及）
  // 间隔用 [^。；;，,\n0-9]{0,10}?：两道防御共同阻止正则跨越句子/子句边界。
  // 例：「当前 schema 为 44。schema 26 的身份…」——44 是当前版本、26 是历史提及；
  // 排除句号与数字后，从「当前」出发只可能匹配到 44，不会误判后面的 26。
  const claimPat = new RegExp(
    [
      '(?:当前|目前|现行|现在|适用|本版|处于|运行于|已升级到|已迁移到)[^。；;，,\\n0-9]{0,10}?schema[\\s_]*v?(\\d{1,2})\\b',
      'schema[\\s_]*版本[^。；;，,\\n0-9]{0,10}?(\\d{1,2})\\b',
      'SCHEMA_VERSION\\s*=\\s*(\\d{1,2})\\b',
    ].join('|'), 'gi');

  const stale = [];
  for (const p of nonHistMd) {
    read(p).split('\n').forEach((line, i) => {
      if (!/schema/i.test(line)) return;
      for (const m of line.matchAll(claimPat)) {
        const v = m.slice(1).find(Boolean);
        if (v && v !== cur) stale.push(`${rel(p)}:${i + 1}  主张 schema ${v}（当前 ${cur}）｜ ${line.trim().slice(0, 80)}`);
      }
    });
  }

  // 通道 B：文档头部（前 20 行）的「适用版本 / 适用 schema」声明——最显眼也最易漏
  const headStale = [];
  for (const p of nonHistMd) {
    const head = read(p).split('\n').slice(0, 20);
    head.forEach((line, i) => {
      const m = line.match(/适用(?:版本|schema)[^\n]{0,14}?schema[\s_]*v?(\d{1,2})\b/i)
        || line.match(/适用(?:版本|schema)[^\n]{0,6}?v(\d{1,2})\b/i);
      if (m && m[1] !== cur) headStale.push(`${rel(p)}:${i + 1}  头部声明 schema v${m[1]}（当前 ${cur}）`);
    });
  }

  const all = [...stale, ...headStale];
  add('口径', 'schema 版本口径（主张当前版本 / 头部声明）', all.length === 0,
    `当前 SCHEMA_VERSION = ${cur}；漂移 ${all.length} 处` + (all.length ? '\n     ' + all.slice(0, 15).join('\n     ') : ''));
}

// ──────────────────────────────────── 3. 文档引用的源码路径是否真实存在
// 只查手册类文档：历史文档（prd / acceptance-report）引用的是当时存在的文件名，属历史事实，
// 与它们内部的数字同理，不予纠正。
{
  const srcPathRe = /`?(src\/[A-Za-z0-9_./-]+\.tsx?)`?/g;
  const missing = [];
  const seen = new Set();
  for (const p of nonHistMd) {
    for (const m of read(p).matchAll(srcPathRe)) {
      const target = m[1];
      if (seen.has(target)) continue;
      seen.add(target);
      if (!fs.existsSync(path.join(REPO, target))) missing.push(`${rel(p)} → ${target}`);
    }
  }
  add('路径', '文档引用的源码路径存在性', missing.length === 0,
    `引用 ${seen.size} 个不同的 src 路径；不存在 ${missing.length} 个`
    + (missing.length ? '\n     ' + missing.slice(0, 15).join('\n     ') : ''));
}

// ────────────────────────── 3b. 文档里裸文件名（省略路径）是否真实存在
// 手册的「代码地图」类表格常只写文件名（`memory-lifecycle.ts`），不带 src/ 前缀。
// 文件被重命名后这类引用最难被发现——开发者也搜不到（搜旧名无结果、搜新名又不知道要搜）。
{
  const bareRe = /`([a-z][a-z0-9-]+\.(?:test\.)?(?:ts|tsx|mjs))`/g;
  const known = new Set();
  for (const dir of ['src', 'tests', 'scripts']) {
    for (const f of walk(path.join(REPO, dir), ['.ts', '.tsx', '.mjs'])) known.add(path.basename(f));
  }
  const missing = [];
  const seen = new Set();
  for (const p of nonHistMd) {
    for (const m of read(p).matchAll(bareRe)) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      if (!known.has(name)) missing.push(`${rel(p)} → ${name}`);
    }
  }
  add('路径', '文档引用的裸文件名存在性', missing.length === 0,
    `引用 ${seen.size} 个裸文件名；不存在 ${missing.length} 个`
    + (missing.length ? '\n     ' + missing.slice(0, 15).join('\n     ') : ''));
}

// ─────────────────────────────────────── 4. 运行时环境变量覆盖度（src → 配置参考）
{
  const names = new Set();
  for (const p of tsFiles) {
    const s = read(p);
    for (const m of s.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
    for (const m of s.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) names.add(m[1]);
  }
  const cfg = read(path.join(REPO, 'docs/configuration-reference.md'));
  const missing = [...names].filter((n) => !cfg.includes(n)).sort();
  add('覆盖度', '运行时环境变量（src → 配置参考）', missing.length === 0,
    `代码读取 ${names.size} 个，配置参考缺 ${missing.length} 个`
    + (missing.length ? '\n     ' + missing.join('\n     ') : ''));
}

// ────────────────────────────────────────── 5. npm 脚本覆盖度（→ 命令参考）
{
  let scripts = {};
  try { scripts = JSON.parse(read(path.join(REPO, 'package.json'))).scripts || {}; } catch { /* noop */ }
  const cmdRef = read(path.join(REPO, 'docs/command-reference.md'));
  const missing = Object.keys(scripts).filter((k) => !cmdRef.includes(k)).sort();
  add('覆盖度', 'npm 脚本（package.json → 命令参考）', missing.length === 0,
    `脚本 ${Object.keys(scripts).length} 个，命令参考缺 ${missing.length} 个`
    + (missing.length ? '\n     ' + missing.join('\n     ') : ''));
}

// ───────────────────────────────────────── 6. HTTP 路由覆盖度（http 层 → 文档）
{
  const routes = new Set();
  for (const f of ['src/server/http-server.ts', 'src/server/conversation-http.ts']) {
    const s = read(path.join(REPO, f));
    for (const m of s.matchAll(/['"](\/api\/[A-Za-z0-9/:_-]*)['"]/g)) routes.add(m[1]);
  }
  const allDocs = mdFiles.map(read).join('\n');
  const missing = [...routes].filter((r) => !allDocs.includes(r)).sort();
  add('覆盖度', 'HTTP 路由（http 层 → 文档）', missing.length === 0,
    `路由字面量 ${routes.size} 条，文档缺 ${missing.length} 条`
    + (missing.length ? '\n     ' + missing.join('\n     ') : ''));
}

// ───────────────────────────────────── 7. 指定配置项默认值（代码 ⟷ 配置参考）
{
  const cfgSrc = read(path.join(REPO, 'src/server/config.ts'));
  const cfgDoc = read(path.join(REPO, 'docs/configuration-reference.md'));

  /** 从 config.ts 抓 `process.env.NAME, 默认值` 的第一个数字字面量实参
   *  注意：TS 里大数字常写成 1_000 / 25_000_000，必须吃掉下划线分隔符，否则只抓到首位数字。 */
  function codeDefault(name) {
    const m = cfgSrc.match(new RegExp(`process\\.env\\.${name}\\s*,\\s*\\n?\\s*([0-9][0-9_]*(?:\\.[0-9]+)?)`));
    return m ? m[1].replace(/_/g, '') : null;
  }
  /** 从配置参考的表格行抓 `\`NAME\` | \`值\`` */
  function docDefault(name) {
    const m = cfgDoc.match(new RegExp('`' + name + '`\\s*\\|\\s*`?([0-9.]+)`?'));
    return m ? m[1] : null;
  }

  const WATCH = [
    'MEMORY_BRIDGE_REFLECTION_LOOKBACK_DAYS',
    'MEMORY_BRIDGE_REFLECTION_MAX_DAILY_CALLS',
    'MEMORY_BRIDGE_MAX_RECALL_CANDIDATES',
    'MEMORY_BRIDGE_MAX_RERANK_CANDIDATES',
    'MEMORY_BRIDGE_CONTEXT_TOKEN_BUDGET',
    'MEMORY_BRIDGE_RERANK_CONFIDENCE_WEIGHT',
    'MEMORY_BRIDGE_RERANK_GATE_POLICY',
    'MEMORY_BRIDGE_RERANK_GATE_OPEN',
    'MEMORY_BRIDGE_RERANK_GATE_CHAT',
  ];
  const drift = [];
  let compared = 0;
  for (const name of WATCH) {
    const a = codeDefault(name);
    const b = docDefault(name);
    if (a === null || b === null) continue;
    compared += 1;
    if (a !== b) drift.push(`${name}：代码 ${a} ⟷ 文档 ${b}`);
  }
  add('默认值', '关键配置项默认值（代码 ⟷ 配置参考）', drift.length === 0,
    `比对 ${compared} 项` + (drift.length ? '\n     ' + drift.join('\n     ') : ''));
}

// ───────────────────────────────────────── 8. 不可复现的评测分数残留
//
// 判定「分数主张」而不是「提到数据集名」：只提数据集名（例如命令表里的
// `bench:cmrc`、语料来源说明）不是分数主张，按名字报会造假阳性，而假阳性
// 会让门禁被无视——那比不报更糟。
//
// 规则：同一行同时出现「分数形状的数字」与（数据集名 或 指标名）才报。
// 指标名带词边界，否则 `EM` 会命中 `MEMORY_BRIDGE`。
{
  const datasetPat = /(LongMemEval|HotpotQA|LoCoMo|CMRC)/;
  const metricPat = /\b(?:Recall@\d+|R@\d+|MRR(?:@\d+)?|EM|F1|nDCG@\d+)\b/;
  const numberPat = /\d+\.\d{2,}|\d+(?:\.\d+)?\s*%/;
  const hits = [];
  const missingMarkers = [];
  for (const p of mdFiles) {
    const r = rel(p);
    const required = SCORE_ALLOWLIST.get(r);
    if (required) {
      const body = read(p);
      for (const marker of required) {
        if (!marker.test(body)) missingMarkers.push(`${r} 缺少免责声明 ${marker}`);
      }
      continue;
    }
    read(p).split('\n').forEach((line, i) => {
      if (!numberPat.test(line)) return;
      const why = [datasetPat.test(line) ? '数据集' : '', metricPat.test(line) ? '指标' : '']
        .filter(Boolean).join('+');
      if (!why) return;
      const tag = isHistorical(r) ? '[历史文档-允许]' : '[需人工确认]';
      hits.push({ tag, s: `${tag} ${r}:${i + 1} [${why}] ${line.trim().slice(0, 90)}` });
    });
  }
  const needReview = hits.filter((h) => h.tag.includes('需人工确认'));
  add('分数', '评测分数残留（README 声明不主张分数）',
    needReview.length === 0 && missingMarkers.length === 0,
    `命中 ${hits.length} 处，需人工确认 ${needReview.length} 处`
    + `（历史文档 ${hits.length - needReview.length} 处；白名单 ${SCORE_ALLOWLIST.size} 份）`
    + (missingMarkers.length
      ? `\n     白名单文件缺失免责声明 ${missingMarkers.length} 处：\n     `
        + missingMarkers.join('\n     ')
      : '')
    + (needReview.length ? '\n     ' + needReview.slice(0, 15).map((h) => h.s).join('\n     ') : ''));
}

// ────────────────────────────────── 9. 合规文件存在性与 .gitignore 关键词
{
  const license = read(path.join(REPO, 'LICENSE'));
  add('合规', 'LICENSE（Apache-2.0 全文）',
    license.includes('Apache License') && license.includes('Version 2.0'),
    `${Buffer.byteLength(license)} 字节`);

  let pkg = {};
  try { pkg = JSON.parse(read(path.join(REPO, 'package.json'))); } catch { /* noop */ }
  add('合规', 'package.json license 字段', pkg.license === 'Apache-2.0', `license = ${pkg.license}`);

  const gi = read(path.join(REPO, '.gitignore'));
  const NEED = ['kb-tokens.json', '*.token', '*.pem', '*.key', '.env', '!.env.example'];
  const missKeys = NEED.filter((k) => !gi.includes(k));
  add('合规', '.gitignore 敏感文件关键词', missKeys.length === 0,
    `${NEED.length - missKeys.length}/${NEED.length} 项齐备` + (missKeys.length ? ` 缺：${missKeys.join(' ')}` : ''));

  for (const f of ['README.md', 'README.en.md', '.env.example', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md']) {
    add('合规', `${f} 存在`, fs.existsSync(path.join(REPO, f)),
      fs.existsSync(path.join(REPO, f)) ? '' : '缺失');
  }
}

// ───────────────────────────────────────────── 10. 历史文档约定条款
{
  const docsReadme = read(path.join(REPO, 'docs/README.md'));
  add('口径', 'docs/README.md 含「历史文档」约定条款',
    /历史文档/.test(docsReadme) && /(快照|不参与|写作时刻)/.test(docsReadme), '');
}

// ─────────────────────────────────────────────────────────────────────── 输出
const groups = [...new Set(results.map((r) => r.group))];
const failed = results.filter((r) => !r.ok);
const pad = Math.max(...results.map((r) => [...r.item].length)) + 2;

console.log('='.repeat(80));
console.log('忆桥 · 文档 ↔ 代码 一致性校验');
console.log(`仓库：${REPO}`);
console.log(`Markdown ${mdFiles.length} 份（其中历史文档 ${mdFiles.length - nonHistMd.length} 份）· src 源文件 ${tsFiles.length} 个`);
console.log('='.repeat(80));
console.log();

for (const g of groups) {
  console.log(`── ${g} ──`);
  for (const r of results.filter((x) => x.group === g)) {
    const label = r.item.padEnd(pad);
    console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${label}${r.detail}`);
  }
  console.log();
}

console.log('='.repeat(80));
console.log(`合计 ${results.length} 项：通过 ${results.length - failed.length}，失败 ${failed.length}`);
console.log('='.repeat(80));

process.exit(failed.length === 0 ? 0 : 1);
