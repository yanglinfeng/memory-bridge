// 发布前敏感信息预检（预跑版）：工作区跟踪文件 + 全量 git 历史
// 用法：node scripts/pre-release-scan.mjs [--history]
// 输出命中明细；退出码 0=干净 1=有命中
import { execSync } from 'node:child_process';

const patterns = [
  ['绝对路径/用户名', String.raw`/Users/mhlinfeng|C:\\Users\\|/home/\w+`],
  ['邮箱', String.raw`[A-Za-z0-9._%+-]+@(?:qq|163|gmail|outlook|foxmail|tencent|aliyun)\.(?:com|net)`],
  ['疑似密钥/令牌', String.raw`sk-[A-Za-z0-9]{8,}|api[_-]?key["':= ]{1,4}[A-Za-z0-9_\-]{12,}|Bearer [A-Za-z0-9_\-.]{20,}|password["':= ]{1,4}[A-Za-z0-9_\-]{6,}`],
  ['内网地址', String.raw`(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)`],
  ['私有目录名', String.raw`\.memory-bridge-private|memory-bridge-private`],
  ['真实姓名线索', String.raw`mhlinfeng|林锋|linfeng`],
];

const mode = process.argv.includes('--history') ? 'history' : 'worktree';

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', maxBuffer: 1 << 28 }); }
  catch (e) { return e.stdout ?? ''; }
}

let total = 0;
const report = [];
for (const [label, pat] of patterns) {
  let out = '';
  if (mode === 'worktree') {
    out = run(`git grep -I -n -i -E "${pat}" -- . ':!package-lock.json' 2>/dev/null | head -40`);
  } else {
    // 全历史：对每个 blob 搜（仓库不大，可接受）；限定内容文件，跳过锁文件与语料
    out = run(
      `git rev-list --all | while read c; do git grep -I -n -i -E "${pat}" "$c" -- . ':!package-lock.json' ':!benchmarks/corpus/*' 2>/dev/null; done | sort -u | head -60`,
    );
  }
  const lines = out.split('\n').filter(Boolean);
  total += lines.length;
  report.push({ label, pat, hits: lines });
}

console.log(`\n═══ 敏感信息预检（${mode === 'history' ? '全量 git 历史' : '工作区跟踪文件'}）═══`);
for (const r of report) {
  console.log(`\n【${r.label}】${r.hits.length ? `⚠️ ${r.hits.length} 处命中` : '✓ 干净'}`);
  for (const h of r.hits.slice(0, 25)) console.log('  ' + h.slice(0, 160));
  if (r.hits.length > 25) console.log(`  …还有 ${r.hits.length - 25} 处`);
}
console.log(`\n═══ 合计命中 ${total} 处 ═══`);
process.exit(total ? 1 : 0);
