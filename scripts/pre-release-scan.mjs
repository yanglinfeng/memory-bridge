// 发布前敏感信息预检：工作区跟踪文件 + 待发布提交历史
//
// 用法：
//   node scripts/pre-release-scan.mjs                          # 只扫工作区跟踪文件
//   node scripts/pre-release-scan.mjs --history                # 追加扫 HEAD 可达的全部对象
//   node scripts/pre-release-scan.mjs --history --all-refs     # 连本地所有 ref 一起扫
//
// 退出码：0 = 无阻断项；1 = 存在阻断项（block）
//
// 三条设计原则（前两版各踩过一次坑，都是静默假阴性，所以写死在这）：
//
//   1. 不经过 shell。上一版把正则拼进 `sh -c "git grep -E \"...\""`，"疑似密钥"
//      规则自身含双引号，打断 shell 引号配对 → 命令报错返回空 → 该规则假报"干净"。
//      现在一律走 execFile/spawnSync 传数组。
//   2. 不用 grep 的正则方言。macOS 自带 BSD grep：`\b` 词边界与 `(?:` 非捕获组
//      都不是 POSIX ERE 语法，会被当字面量，规则命中恒为 0 却报干净（曾出现
//      "yanglinfeng" 明明在 README 里、"公开账号"规则却显示 ✓）。现在用 git 取
//      内容、在 JS 里用 RegExp 匹配。
//   3. 命中一律打印，只分严重级别。占位值/哨兵值、行内豁免注释只降级为"待确认"，
//      不会被丢掉——扫描器的静默丢弃等价于假阴性。
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * @type {{
 *   id:string, label:string, severity:'block'|'info', re:RegExp,
 *   valueGroup?:number, fakeValue?:RegExp, needsFollowUp?:RegExp,
 *   allowPath?:RegExp, allowPathReason?:string, note?:string
 * }[]}
 */
const RULES = [
  {
    id: 'local-abs-path',
    label: '本机绝对路径',
    severity: 'block',
    re: /(?:^|[^:\w/])\/(?:Users|home|Volumes)\/[A-Za-z0-9._-]+\//g,
    note: '会泄露本机用户名与目录结构',
  },
  {
    id: 'local-username',
    label: '本机用户名',
    severity: 'block',
    re: /\bmhlinfeng\b/gi,
  },
  {
    id: 'private-key',
    label: '私钥块',
    severity: 'block',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    // PEM 的真正敏感部分是 base64 密钥体；只有标题行而没有密钥体的，是测试夹具
    needsFollowUp: /^[A-Za-z0-9+/=]{40,}$/,
  },
  {
    id: 'bridge-token',
    label: '忆桥主体令牌',
    severity: 'block',
    re: /\b(?:mb1|kq2)\.[0-9a-fA-F-]{8,}\.[A-Za-z0-9_-]{16,}/g,
    note: '本项目令牌格式，一旦进过历史必须轮换',
  },
  {
    id: 'vendor-key',
    label: '第三方 API 密钥',
    severity: 'block',
    re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}|\bAIza[0-9A-Za-z_-]{30,}|\bghp_[A-Za-z0-9]{20,}/g,
  },
  {
    id: 'secret-assignment',
    label: '疑似密钥/口令赋值',
    severity: 'block',
    re: /(?:api[_-]?key|apikey|access[_-]?token|secret|passwd|password)["']?\s*[:=]\s*["']([A-Za-z0-9_\-./+=]{12,})["']/gi,
    valueGroup: 1,
  },
  {
    id: 'bearer',
    label: 'Bearer 令牌',
    severity: 'block',
    re: /Bearer\s+[A-Za-z0-9_\-.]{24,}/g,
  },
  {
    id: 'internal-ip',
    label: '内网地址',
    severity: 'block',
    re: /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
    allowPath: /^(?:tests|docs)\//,
    allowPathReason: '测试与文档里用 RFC1918 示例地址（如解析回环地址的用例）',
    note: '127.0.0.1 / 0.0.0.0 是正常回环绑定，不在本规则内',
  },
  {
    id: 'real-email',
    label: '真实邮箱',
    severity: 'block',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(?:com|net|cn|org|io|dev)/g,
    fakeValue: /@(?:example\.(?:com|org|net)|test\.local|noreply\.github\.com|users\.noreply\.github\.com)$/i,
  },
  {
    id: 'private-dir',
    label: '私有目录名 · 待确认',
    severity: 'info',
    re: /\.memory-bridge-private/g,
    note: '目录名本身是配置的一部分（已在 .gitignore）；确认没有真实私有文件被跟踪即可',
  },
  {
    id: 'public-handle',
    label: '公开仓库账号 · 预期',
    severity: 'info',
    re: /\byanglinfeng\b/g,
    note: '仓库所有者账号，出现在 clone 命令与 issue 链接里属预期',
  },
];

// 一眼可判为占位/哨兵值的形态：测试里用来断言"日志不得泄露密钥"的假值
const FAKE_VALUE =
  /(?:sentinel|placeholder|example|dummy|fake|sample|redacted|do[_-]?not[_-]?log|must[_-]?not[_-]?log|abc123|123456|xyz789|test[_-]?only)/i;

// 纯词组形态（全小写或全大写的连缀词）不像真实密钥：nested-api-key、raw-result-secret
const WORDLIKE_VALUE = /^(?:[a-z]+(?:[-_][a-z]+)+|[A-Z]+(?:[-_][A-Z]+)+)$/;

// 行内豁免：在这一行任意位置写 pre-release-scan:allow 即可降级为"待确认"
const INLINE_ALLOW = /pre-release-scan:allow/;

// 决不能被 git 跟踪的文件（存在即阻断：说明 .gitignore 没兜住）
const MUST_NOT_TRACK = [
  '.env',
  'kb-tokens.json',
  'kb-auth-spec.json',
  'session-scope-grants.json',
  '.memory-bridge-private',
];

// 跳过：锁文件（体积大无信息量）与本脚本自身（规则里就写着这些模式）
const SKIP_PATHS = new Set(['package-lock.json', 'scripts/pre-release-scan.mjs']);
const MAX_BLOB_BYTES = 3_000_000;

const argv = process.argv.slice(2);
const scanHistory = argv.includes('--history') || argv.includes('--all-refs');
const allRefs = argv.includes('--all-refs');

function git(args, encoding = 'utf8') {
  return execFileSync('git', args, {
    encoding,
    maxBuffer: 1 << 30,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function run(args, input, { binary = false } = {}) {
  const result = spawnSync('git', args, {
    input,
    encoding: binary ? null : 'utf8',
    maxBuffer: 1 << 30,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git ${args.join(' ')} → ${result.stderr}`);
  }
  return result.stdout ?? (binary ? Buffer.alloc(0) : '');
}

const isBinary = (buffer) => buffer.subarray(0, 8192).includes(0);

/**
 * 逐行匹配。
 * @returns {{line:number,text:string,exempt?:string}[]}
 */
function scanText(text, rule) {
  const lines = text.split('\n');
  const hits = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    rule.re.lastIndex = 0;
    const matches = [...line.matchAll(rule.re)];
    if (matches.length === 0) continue;

    // 取用于判假的样本：优先正则捕获组，其次整段命中
    const samples = matches.map((match) =>
      rule.valueGroup ? (match[rule.valueGroup] ?? '') : match[0],
    );

    let exempt;
    if (INLINE_ALLOW.test(line)) exempt = '行内豁免注释';
    else if (rule.needsFollowUp && !hasKeyBody(lines, index, rule.needsFollowUp)) {
      exempt = '只有标题行、没有密钥体（测试夹具）';
    } else if (rule.fakeValue && samples.every((sample) => rule.fakeValue.test(sample))) {
      exempt = '占位值';
    } else if (FAKE_VALUE.test(line)) exempt = '疑似哨兵/占位值';
    else if (samples.some((sample) => WORDLIKE_VALUE.test(sample))) exempt = '词组形态，不像真实密钥';

    hits.push({ line: index + 1, text: line, exempt });
  }
  return hits;
}

function hasKeyBody(lines, index, pattern) {
  for (let offset = 1; offset <= 3; offset += 1) {
    const next = lines[index + offset];
    if (next === undefined) return false;
    if (pattern.test(next.trim())) return true;
  }
  return false;
}

function scanEntries(label, entries, { withSha = false } = {}) {
  console.log(`\n${'═'.repeat(4)} 敏感信息预检 · ${label} ${'═'.repeat(4)}`);
  console.log(`（已扫描 ${entries.length} 个文本对象）`);
  const totals = { block: 0, info: 0, exempt: 0 };

  for (const rule of RULES) {
    const blocked = [];
    const exempted = [];
    for (const entry of entries) {
      if (rule.allowPath?.test(entry.path)) continue;
      for (const hit of scanText(entry.text, rule)) {
        const record = { ...entry, ...hit };
        if (hit.exempt) exempted.push(record);
        else blocked.push(record);
      }
    }
    totals.exempt += exempted.length;
    if (rule.severity === 'block') {
      totals.block += blocked.length;
    } else {
      totals.info += blocked.length;
    }

    if (blocked.length === 0 && exempted.length === 0) {
      console.log(`\n【${rule.label}】✓ 干净`);
      continue;
    }

    const format = (hit) => {
      const where = withSha ? `${hit.path}@${hit.sha.slice(0, 7)}` : hit.path;
      return `  ${where}:${hit.line}: ${hit.text.trim().slice(0, 150)}`;
    };

    if (blocked.length > 0) {
      const mark = rule.severity === 'block' ? '⛔ 阻断' : 'ℹ️ 待确认';
      console.log(`\n【${rule.label}】${mark} · ${blocked.length} 处`);
      if (rule.note) console.log(`  ↳ ${rule.note}`);
      for (const hit of blocked.slice(0, 20)) console.log(format(hit));
      if (blocked.length > 20) console.log(`  …还有 ${blocked.length - 20} 处`);
    }

    if (exempted.length > 0) {
      const reasons = [...new Set(exempted.map((h) => h.exempt))].join('、');
      if (blocked.length === 0) {
        console.log(`\n【${rule.label}】✓ 无阻断（已豁免 ${exempted.length} 处）`);
      }
      console.log(`  ↳ 豁免 ${exempted.length} 处：${reasons}`);
      for (const hit of exempted.slice(0, 3)) console.log(format(hit));
      if (exempted.length > 3) console.log(`  …另有 ${exempted.length - 3} 处同类`);
    }
  }
  return totals;
}

/** 工作区：直接读盘上被跟踪的文件 */
function collectWorktree() {
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const entries = [];
  for (const file of files) {
    if (SKIP_PATHS.has(file)) continue;
    let buffer;
    try {
      buffer = readFileSync(file);
    } catch {
      continue; // 已删除或不可读
    }
    if (buffer.length > MAX_BLOB_BYTES || isBinary(buffer)) continue;
    entries.push({ path: file, sha: '', text: buffer.toString('utf8') });
  }
  return entries;
}

/** 历史：取所有可达对象的内容（按 path 标注） */
function collectHistory(revs) {
  const listing = git(['rev-list', '--objects', ...revs]).split('\n').filter(Boolean);
  const threads = [];
  for (const line of listing) {
    const space = line.indexOf(' ');
    if (space < 0) continue; // commit/tree 无 path
    const sha = line.slice(0, space);
    const path = line.slice(space + 1);
    if (SKIP_PATHS.has(path)) continue;
    threads.push({ sha, path });
  }
  if (threads.length === 0) return [];

  // 一次拿回类型与体积，先按体积过滤，避免把大二进制拖进内存
  const meta = run(['cat-file', '--batch-check'], threads.map((t) => t.sha).join('\n') + '\n');
  const metaById = new Map();
  for (const line of meta.split('\n')) {
    if (!line) continue;
    const [sha, type, size] = line.split(' ');
    metaById.set(sha, { type, size: Number(size) });
  }

  const wanted = threads.filter((thread) => {
    const info = metaById.get(thread.sha);
    return info && info.type === 'blob' && info.size <= MAX_BLOB_BYTES;
  });
  if (wanted.length === 0) return [];

  const out = run(['cat-file', '--batch'], wanted.map((t) => t.sha).join('\n') + '\n', {
    binary: true,
  });
  const entries = [];
  let cursor = 0;
  for (const thread of wanted) {
    if (cursor >= out.length) break;
    const headerEnd = out.indexOf(0x0a, cursor);
    if (headerEnd < 0) break;
    const header = out.toString('utf8', cursor, headerEnd);
    const size = Number(header.split(' ')[2]);
    const bodyStart = headerEnd + 1;
    const bodyEnd = bodyStart + size;
    if (!Number.isFinite(size) || bodyEnd > out.length) break;
    const body = out.subarray(bodyStart, bodyEnd);
    cursor = bodyEnd + 1;
    if (isBinary(body)) continue;
    entries.push({ path: thread.path, sha: thread.sha, text: body.toString('utf8') });
  }
  return entries;
}

let blockers = 0;
let infos = 0;
let exemptCount = 0;

const scopes = [{ label: '工作区跟踪文件', entries: collectWorktree(), withSha: false }];

if (scanHistory) {
  const revArgs = allRefs ? ['--all'] : ['HEAD'];
  const revs = git(['rev-list', ...revArgs]).split('\n').filter(Boolean);
  scopes.push({
    label: allRefs
      ? `全量历史（所有 ref · ${revs.length} 个提交）`
      : `待发布历史（HEAD 可达 · ${revs.length} 个提交）`,
    entries: collectHistory(revs),
    withSha: true,
  });
}

for (const scope of scopes) {
  const totals = scanEntries(scope.label, scope.entries, { withSha: scope.withSha });
  blockers += totals.block;
  infos += totals.info;
  exemptCount += totals.exempt;
}

console.log(`\n${'═'.repeat(4)} 敏感文件跟踪状态 ${'═'.repeat(4)}`);
const tracked = new Set(git(['ls-files', '-z']).split('\0').filter(Boolean));
let leaked = 0;
for (const name of MUST_NOT_TRACK) {
  const found = [...tracked].filter((file) => file === name || file.startsWith(name + '/'));
  if (found.length > 0) {
    leaked += found.length;
    blockers += found.length;
    console.log(`  ⛔ ${name} 被跟踪（${found.length} 个文件）`);
    for (const file of found.slice(0, 5)) console.log(`      ${file}`);
  }
}
if (leaked === 0) console.log('  ✓ 干净（.gitignore 兜住）');

console.log(`\n═══ 汇总：阻断项 ${blockers} · 待确认项 ${infos} · 已豁免 ${exemptCount} ═══`);
console.log(blockers === 0 ? '结论：无阻断项，可继续发布流程。' : '结论：存在阻断项，先清理再发布。');
process.exit(blockers === 0 ? 0 : 1);
