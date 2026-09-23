#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';

import {
  DATA_PURGE_CONFIRMATION,
  createDatabaseBackup,
  diagnoseInstallation,
  installProject,
  restoreDatabaseBackup,
  uninstallProject,
  upgradeProject,
  verifyStopLifecycle,
  writeDoctorReceipt,
} from './memory-bridge-lifecycle-lib.mjs';

function usage() {
  return `忆桥生命周期 CLI

用法：
  node scripts/memory-bridge-lifecycle.mjs install --source DIR --install-root DIR --state-dir DIR
  node scripts/memory-bridge-lifecycle.mjs upgrade --source DIR --install-root DIR --state-dir DIR
  node scripts/memory-bridge-lifecycle.mjs backup --source DIR --install-root DIR --state-dir DIR
  node scripts/memory-bridge-lifecycle.mjs restore --source DIR --install-root DIR --state-dir DIR --backup FILE --stop-receipt FILE
  node scripts/memory-bridge-lifecycle.mjs uninstall --source DIR --install-root DIR --state-dir DIR
  node scripts/memory-bridge-lifecycle.mjs stop --phase preflight|postflight --source DIR --install-root DIR --state-dir DIR --pid PID --cwd DIR --ready-url URL [--verify-stopped --receipt-file FILE]
  node scripts/memory-bridge-lifecycle.mjs doctor --source DIR --install-root DIR --state-dir DIR [--strict] [--no-mcp-smoke]

卸载默认保留数据。清除数据需要：
  --purge-data --confirm-purge ${DATA_PURGE_CONFIRMATION}`;
}

function parse(argv) {
  const command = argv[0];
  if (!['install', 'upgrade', 'backup', 'restore', 'uninstall', 'stop', 'doctor'].includes(command)) {
    throw new Error(usage());
  }
  const options = { command };
  const booleanFlags = new Map([
    ['--purge-data', 'purgeData'],
    ['--mcp-smoke', 'mcpSmoke'],
    ['--no-mcp-smoke', 'noMcpSmoke'],
    ['--no-ollama', 'noOllama'],
    ['--no-port', 'noPort'],
    ['--strict', 'strict'],
    ['--verify-stopped', 'verifyStopped'],
  ]);
  const valueFlags = new Map([
    ['--source', 'source'],
    ['--install-root', 'installRoot'],
    ['--state-dir', 'stateDir'],
    ['--confirm-purge', 'purgeConfirmation'],
    ['--receipt-dir', 'receiptDir'],
    ['--ollama-url', 'ollamaUrl'],
    ['--host', 'host'],
    ['--port', 'port'],
    ['--phase', 'phase'],
    ['--pid', 'pid'],
    ['--cwd', 'cwd'],
    ['--ready-url', 'readyUrl'],
    ['--backup', 'backupPath'],
    ['--backup-env', 'backupEnv'],
    ['--stop-receipt', 'stopReceipt'],
    ['--receipt-file', 'receiptFile'],
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (booleanFlags.has(argument)) {
      options[booleanFlags.get(argument)] = true;
      continue;
    }
    const key = valueFlags.get(argument);
    if (!key) throw new Error(`未知参数：${argument}\n${usage()}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} 缺少值`);
    options[key] = value;
    index += 1;
  }
  if (options.backupEnv) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(options.backupEnv)) {
      throw new Error('--backup-env 必须是安全的环境变量名');
    }
    options.backupPath = process.env[options.backupEnv];
  }
  if (options.command === 'restore' && (!options.backupPath || !options.stopReceipt)) {
    throw new Error('restore 要求备份路径和 --stop-receipt FILE');
  }
  if (options.command !== 'restore' && (
    options.backupPath || options.backupEnv || options.stopReceipt
  )) {
    throw new Error('restore 参数只能用于 restore 命令');
  }
  if (options.command === 'stop') {
    const required = ['source', 'installRoot', 'stateDir', 'phase', 'pid', 'cwd', 'readyUrl'];
    const missing = required.filter((key) => !options[key]);
    if (missing.length > 0) throw new Error(`stop 缺少必填参数：${missing.join(', ')}`);
    const stopOnly = new Set([
      'command', 'source', 'installRoot', 'stateDir', 'phase', 'pid', 'cwd',
      'readyUrl', 'verifyStopped', 'receiptFile',
    ]);
    const unsupported = Object.keys(options).filter((key) => !stopOnly.has(key));
    if (unsupported.length > 0) {
      throw new Error(`stop 不支持参数：${unsupported.join(', ')}`);
    }
    if (
      !['preflight', 'postflight'].includes(options.phase) ||
      (options.phase === 'preflight' && (options.verifyStopped || options.receiptFile)) ||
      (options.phase === 'postflight' && (!options.verifyStopped || !options.receiptFile))
    ) {
      throw new Error('stop phase 必须是 preflight，或带 --verify-stopped 的 postflight');
    }
  }
  options.source = path.resolve(options.source || process.cwd());
  if (!options.installRoot) throw new Error('--install-root 必填');
  options.installRoot = path.resolve(options.installRoot);
  options.stateDir = path.resolve(
    options.stateDir || path.join(path.dirname(options.installRoot), 'state'),
  );
  options.checkOllama = !options.noOllama;
  options.checkPort = !options.noPort;
  options.mcpSmoke = options.command === 'doctor' && !options.noMcpSmoke;
  if (options.command !== 'stop' && (
    options.verifyStopped || options.phase || options.pid || options.cwd ||
    options.readyUrl || options.receiptFile
  )) {
    throw new Error('stop 参数只能用于 stop 命令');
  }
  if (
    options.command === 'doctor' &&
    options.strict &&
    (options.noOllama || options.noPort || options.noMcpSmoke)
  ) {
    throw new Error('--strict 禁止搭配 --no-ollama、--no-port 或 --no-mcp-smoke');
  }
  return options;
}

async function main() {
  const options = parse(process.argv.slice(2));
  let result;
  if (options.command === 'install') result = await installProject(options);
  else if (options.command === 'upgrade') result = await upgradeProject(options);
  else if (options.command === 'backup') result = await createDatabaseBackup(options);
  else if (options.command === 'restore') result = await restoreDatabaseBackup(options);
  else if (options.command === 'uninstall') result = await uninstallProject(options);
  else if (options.command === 'stop') result = await verifyStopLifecycle(options);
  else {
    result = await diagnoseInstallation(options);
    if (options.receiptDir) {
      result.receipt = writeDoctorReceipt(path.resolve(options.receiptDir), result);
    }
  }
  console.log(JSON.stringify(result, null, 2));
  if (options.command === 'doctor' && !result.passed) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
