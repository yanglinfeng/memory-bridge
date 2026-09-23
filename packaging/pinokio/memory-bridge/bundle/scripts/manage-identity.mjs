import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, databasePath } from '../src/server/config.js';
import { openDatabase } from '../src/server/database.js';
import { IdentityService } from '../src/server/identity.js';

const THIS_SCRIPT = fileURLToPath(import.meta.url);
const DATABASE_FILE_NAME = 'memory-bridge.sqlite3';
const COMMAND_OPTIONS = Object.freeze({
  init: ['--id', '--display-name', '--label', '--expires-at'],
  'list-principals': [],
  'create-principal': ['--id', '--display-name'],
  'issue-token': ['--principal', '--label', '--expires-at'],
  'list-credentials': ['--principal'],
  'revoke-credential': ['--principal', '--credential', '--reason'],
  'list-personas': ['--principal'],
  overview: ['--principal'],
});
const COMMON_OPTIONS = ['--database', '--data-dir'];

function usage() {
  return [
    '用法：',
    '  npm run identity -- init --display-name NAME --label LABEL [--id ID] [--expires-at ISO]',
    '  npm run identity -- list-principals [--data-dir DIR | --database FILE]',
    '  npm run identity -- create-principal --display-name NAME [--id ID]',
    '  npm run identity -- issue-token --principal ID --label LABEL [--expires-at ISO]',
    '  npm run identity -- list-credentials --principal ID',
    '  npm run identity -- revoke-credential --principal ID --credential ID [--reason TEXT]',
    '  npm run identity -- list-personas --principal ID',
    '  npm run identity -- overview --principal ID',
    '',
    '公共选项：',
    '  --data-dir DIR    使用 DIR/memory-bridge.sqlite3',
    '  --database FILE   使用明确的 SQLite 数据库文件',
    '  --help, -h        显示帮助',
    '',
    'init 仅在全库从未签发过凭据时成功，并原子创建命名账户与首个 Token。',
    '未指定数据库时使用服务正式 databasePath。Token 仅在 init/签发当次输出。',
  ].join('\n');
}

function requireText(value, label, maximumLength = 255) {
  const text = String(value ?? '').normalize('NFKC').trim();
  if (
    !text ||
    text.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(text)
  ) {
    throw new Error(`${label} 无效`);
  }
  return text;
}

function requirePath(value, label) {
  const text = String(value ?? '').trim();
  if (
    !text ||
    text.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(text)
  ) {
    throw new Error(`${label} 无效`);
  }
  return path.resolve(text);
}

function parseOptions(command, argv) {
  const allowed = new Set([
    ...COMMON_OPTIONS,
    ...COMMAND_OPTIONS[command],
  ]);
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!allowed.has(option)) {
      throw new Error(`未知参数：${option}`);
    }
    if (options.has(option)) {
      throw new Error(`参数重复：${option}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${option} 缺少值`);
    }
    options.set(option, value);
    index += 1;
  }
  if (options.has('--database') && options.has('--data-dir')) {
    throw new Error('--database 与 --data-dir 不能同时使用');
  }
  return options;
}

export function parseIdentityArguments(argv) {
  if (
    argv.length === 0 ||
    argv[0] === '--help' ||
    argv[0] === '-h'
  ) {
    return Object.freeze({ help: true });
  }
  const command = argv[0];
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) {
    throw new Error(`未知命令：${command}`);
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    if (argv.length !== 2) {
      throw new Error('--help 不能与其他参数同时使用');
    }
    return Object.freeze({ help: true });
  }
  const options = parseOptions(command, argv.slice(1));
  const database = options.has('--database')
    ? requirePath(options.get('--database'), '--database')
    : options.has('--data-dir')
      ? path.join(
          requirePath(options.get('--data-dir'), '--data-dir'),
          DATABASE_FILE_NAME,
        )
      : databasePath();
  if (fs.existsSync(database) && fs.statSync(database).isDirectory()) {
    throw new Error('--database 必须指向文件而不是目录');
  }
  const required = (name, maximumLength = 255) =>
    requireText(options.get(name), name, maximumLength);
  const optional = (name, maximumLength = 255) =>
    options.has(name)
      ? requireText(options.get(name), name, maximumLength)
      : undefined;

  if (command === 'init') {
    return Object.freeze({
      help: false,
      command,
      database,
      id: optional('--id'),
      displayName: required('--display-name'),
      label: required('--label'),
      expiresAt: optional('--expires-at'),
    });
  }
  if (command === 'list-principals') {
    return Object.freeze({ help: false, command, database });
  }
  if (command === 'create-principal') {
    return Object.freeze({
      help: false,
      command,
      database,
      id: optional('--id'),
      displayName: required('--display-name'),
    });
  }
  if (command === 'issue-token') {
    return Object.freeze({
      help: false,
      command,
      database,
      principalId: required('--principal'),
      label: required('--label'),
      expiresAt: optional('--expires-at'),
    });
  }
  if (command === 'list-credentials') {
    return Object.freeze({
      help: false,
      command,
      database,
      principalId: required('--principal'),
    });
  }
  if (command === 'revoke-credential') {
    return Object.freeze({
      help: false,
      command,
      database,
      principalId: required('--principal'),
      credentialId: required('--credential'),
      reason: optional('--reason', 1000),
    });
  }
  return Object.freeze({
    help: false,
    command,
    database,
    principalId: required('--principal'),
  });
}

export function runIdentityCommand(argv) {
  const input = parseIdentityArguments(argv);
  if (input.help) return usage();
  const database = openDatabase(input.database);
  try {
    const identity = new IdentityService(database, {
      defaultPrincipalId: config.defaultUserId,
    });
    if (input.command === 'init') {
      return identity.initializeFirstAccount({
        principalId: input.id,
        displayName: input.displayName,
        label: input.label,
        expiresAt: input.expiresAt,
      });
    }
    if (input.command === 'list-principals') {
      return { principals: identity.listPrincipals() };
    }
    if (input.command === 'create-principal') {
      return {
        principal: identity.createPrincipal({
          id: input.id,
          displayName: input.displayName,
        }),
      };
    }
    if (input.command === 'issue-token') {
      const issued = identity.issueCredential({
        principalId: input.principalId,
        label: input.label,
        expiresAt: input.expiresAt,
      });
      return {
        token: issued.token,
        credential: issued.credential,
      };
    }
    if (input.command === 'list-credentials') {
      return {
        principalId: input.principalId,
        credentials: identity.listCredentials(input.principalId),
      };
    }
    if (input.command === 'revoke-credential') {
      return {
        credential: identity.revokeCredentialForPrincipal(
          input.principalId,
          input.credentialId,
          input.reason,
        ),
      };
    }
    if (input.command === 'list-personas') {
      return {
        principalId: input.principalId,
        personas: identity.listPersonaBindings(input.principalId),
      };
    }
    const principal = identity.trustPrincipal(
      input.principalId,
      'internal_job',
    );
    return {
      overview: identity.currentOverview(principal),
      credentials: identity.listCredentials(input.principalId),
    };
  } finally {
    database.close();
  }
}

function writeResult(value) {
  if (typeof value === 'string') {
    process.stdout.write(`${value}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(THIS_SCRIPT)
) {
  try {
    writeResult(runIdentityCommand(process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    process.stderr.write(`identity 管理失败：${message}\n`);
    process.exitCode = 1;
  }
}
