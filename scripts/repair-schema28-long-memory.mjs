import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/server/database.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import { MemoryStore } from '../src/server/memory-store.js';
import { Schema28LongMemoryDefectRepair } from
  '../src/server/schema28-defect-repair.js';

function usage() {
  return [
    '用法：',
    '  npm run repair:schema28-memory -- --database FILE [--user ID] [--namespace NAME] [--limit N]',
    '  npm run repair:schema28-memory -- --database FILE --apply [--user ID] [--namespace NAME] [--limit N]',
    '',
    '默认只生成 dry-run 计划；只有显式传入 --apply 才修改数据库。',
    '执行 --apply 前应停止服务并备份数据库。工具不会输出 Token 或原始对话。',
  ].join('\n');
}

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }
  const valueOptions = new Set([
    '--database',
    '--user',
    '--namespace',
    '--limit',
  ]);
  const values = new Map();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--apply') {
      if (apply) throw new Error('--apply 不能重复');
      apply = true;
      continue;
    }
    if (!valueOptions.has(option)) {
      throw new Error(`未知参数：${option}`);
    }
    if (values.has(option)) throw new Error(`参数重复：${option}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${option} 缺少值`);
    }
    values.set(option, value);
    index += 1;
  }
  const databaseValue = String(values.get('--database') || '').trim();
  if (!databaseValue) {
    throw new Error('必须显式提供 --database，避免误改正式数据库');
  }
  const database = path.resolve(databaseValue);
  if (!fs.existsSync(database) || !fs.statSync(database).isFile()) {
    throw new Error('--database 必须指向已存在的 SQLite 文件');
  }
  const limitValue = values.get('--limit');
  const limit = limitValue === undefined
    ? undefined
    : Number.parseInt(String(limitValue), 10);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('--limit 必须是正整数');
  }
  return {
    help: false,
    database,
    apply,
    userId: values.get('--user'),
    namespace: values.get('--namespace'),
    limit,
  };
}

const input = parseArguments(process.argv.slice(2));
if (input.help) {
  console.log(usage());
  process.exitCode = 0;
} else {
  const database = openDatabase(input.database);
  try {
    const store = new MemoryStore(database);
    const lifecycle = new LifecycleStore(database);
    const repair = new Schema28LongMemoryDefectRepair(
      database,
      store,
      lifecycle,
    );
    const report = repair.run({
      apply: input.apply,
      userId: input.userId,
      namespace: input.namespace,
      limit: input.limit,
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    database.close();
  }
}
