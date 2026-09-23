#!/usr/bin/env node
// 忆桥多租户授权签发工具（生产用）
//
// 一次把「主体 + 令牌 + 授权矩阵」三件事配好，避免手工改 JSON 出错。
// 复用内核真实实现（IdentityService / trusted-sessions 校验器），
// 不重写规则，杜绝文档与代码漂移。
//
// 用法见 usage()。变更类命令必须显式 --yes。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, databasePath } from '../src/server/config.js';
import { openDatabase } from '../src/server/database.js';
import { IdentityService } from '../src/server/identity.js';
import { isClientIdentityId } from '../src/server/client-identity-contract.js';
import {
  ISSUABLE_SCOPE_TYPES,
  parseGrantedScope,
} from '../src/server/trusted-sessions.js';

const THIS_SCRIPT = fileURLToPath(import.meta.url);
const DATABASE_FILE_NAME = 'memory-bridge.sqlite3';
const GRANTS_FILE_NAME = 'session-scope-grants.json';

const COMMAND_OPTIONS = Object.freeze({
  plan: ['--spec'],
  apply: ['--spec', '--token-out', '--replace', '--rotate', '--yes'],
  check: ['--spec'],
  matrix: ['--spec', '--out', '--replace', '--yes'],
  token: ['--principal', '--label', '--expires-at', '--token-out', '--yes'],
  'list': [],
  sessions: ['--principal', '--all'],
  revoke: ['--principal', '--credential', '--reason', '--yes'],
});
const COMMON_OPTIONS = ['--database', '--data-dir'];
const BOOLEAN_OPTIONS = new Set(['--yes', '--replace', '--all', '--rotate']);

function usage() {
  return [
    '忆桥多租户授权签发工具',
    '',
    '用法：',
    '  node --import tsx scripts/kb-provision.mjs check  --spec FILE',
    '  node --import tsx scripts/kb-provision.mjs plan   --spec FILE [--data-dir DIR]',
    '  node --import tsx scripts/kb-provision.mjs apply  --spec FILE [--data-dir DIR] [--token-out FILE] [--replace] [--rotate] --yes',
    '  node --import tsx scripts/kb-provision.mjs matrix --spec FILE [--out FILE] [--replace] --yes',
    '  node --import tsx scripts/kb-provision.mjs token  --principal ID --label LABEL [--expires-at ISO] [--token-out FILE] --yes',
    '  node --import tsx scripts/kb-provision.mjs list   [--data-dir DIR]',
    '  node --import tsx scripts/kb-provision.mjs sessions --principal ID [--all]',
    '  node --import tsx scripts/kb-provision.mjs revoke --principal ID --credential CID [--reason TEXT] --yes',
    '',
    '公共选项：',
    '  --data-dir DIR    使用 DIR/memory-bridge.sqlite3，矩阵写入 DIR/session-scope-grants.json',
    '  --database FILE   指定 SQLite 文件（矩阵默认写到其所在目录）',
    '  --help, -h        显示帮助',
    '',
    '说明：',
    '  · check 只校验 spec，不碰任何文件；plan 只读库并预演，不改任何东西。',
    '  · apply 会：写授权矩阵（先备份旧文件）→ 建主体 → 签发令牌。',
    '  · apply 幂等：同 label 已有活跃凭据则跳过；要强制换新加 --rotate。',
    '  · --replace 会用 spec 完全覆盖矩阵（丢弃 spec 之外的主体），默认是合并。',
    '  · 令牌只在签发当次输出一次，服务端只存哈希，丢了只能重签。',
    '  · 一旦存在任何凭据，「匿名 loopback 放行」永久失效——所有 /api',
    '    调用都必须带 Authorization，请先把客户端改好再 apply。',
  ].join('\n');
}

// ────────────────────────── 参数解析 ──────────────────────────

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
  if (!text || text.length > 4096 || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new Error(`${label} 无效`);
  }
  return path.resolve(text);
}

function parseArguments(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { help: true };
  }
  const command = argv[0];
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) {
    throw new Error(`未知命令：${command}`);
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    if (argv.length !== 2) throw new Error('--help 不能与其他参数同时使用');
    return { help: true };
  }
  const allowed = new Set([...COMMON_OPTIONS, ...COMMAND_OPTIONS[command]]);
  const values = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (!allowed.has(option)) throw new Error(`未知参数：${option}`);
    if (values.has(option)) throw new Error(`参数重复：${option}`);
    if (BOOLEAN_OPTIONS.has(option)) {
      values.set(option, true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} 缺少值`);
    values.set(option, value);
    index += 1;
  }
  if (values.has('--database') && values.has('--data-dir')) {
    throw new Error('--database 与 --data-dir 不能同时使用');
  }

  const database = values.has('--database')
    ? requirePath(values.get('--database'), '--database')
    : values.has('--data-dir')
      ? path.join(
          requirePath(values.get('--data-dir'), '--data-dir'),
          DATABASE_FILE_NAME,
        )
      : databasePath();
  const dataDir = path.dirname(database);
  const grantsFile = values.has('--out')
    ? requirePath(values.get('--out'), '--out')
    : process.env.MEMORY_BRIDGE_SESSION_GRANTS_FILE
      ? requirePath(
          process.env.MEMORY_BRIDGE_SESSION_GRANTS_FILE,
          'MEMORY_BRIDGE_SESSION_GRANTS_FILE',
        )
      : path.join(dataDir, GRANTS_FILE_NAME);

  const text = (name, max = 255) =>
    values.has(name) ? requireText(values.get(name), name, max) : undefined;

  return {
    help: false,
    command,
    database,
    dataDir,
    grantsFile,
    specFile: text('--spec', 4096)
      ? requirePath(values.get('--spec'), '--spec')
      : undefined,
    tokenOut: text('--token-out', 4096)
      ? requirePath(values.get('--token-out'), '--token-out')
      : undefined,
    replace: values.get('--replace') === true,
    rotate: values.get('--rotate') === true,
    yes: values.get('--yes') === true,
    all: values.get('--all') === true,
    principalId: text('--principal'),
    label: text('--label'),
    expiresAt: text('--expires-at'),
    credentialId: text('--credential'),
    reason: text('--reason', 1000),
  };
}

function requireSpec(input) {
  if (!input.specFile) throw new Error('缺少 --spec FILE');
  return input.specFile;
}

// ────────────────────────── spec 校验 ──────────────────────────

/**
 * spec 结构：
 * {
 *   "principals": [
 *     { "id": "kb-writer", "displayName": "…",
 *       "scopes": ["project:dept-finance"], "maxActiveSessions": 32,
 *       "tokens": [ { "label": "…", "expiresAt": "2027-01-01T00:00:00Z" } ] }
 *   ]
 * }
 */
function loadSpec(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`无法读取 spec 文件 ${file}：${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`spec 不是合法 JSON：${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('spec 顶层必须是对象');
  }
  if (!Array.isArray(parsed.principals) || parsed.principals.length === 0) {
    throw new Error('spec.principals 必须是非空数组');
  }

  const seen = new Set();
  const principals = parsed.principals.map((entry, index) => {
    const where = `principals[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${where} 必须是对象`);
    }
    const id = requireText(entry.id, `${where}.id`);
    if (!isClientIdentityId(id)) {
      throw new Error(
        `${where}.id "${id}" 不合法：须匹配 ^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$`,
      );
    }
    if (seen.has(id)) throw new Error(`主体 id 重复：${id}`);
    seen.add(id);

    const displayName = requireText(
      entry.displayName ?? id,
      `${where}.displayName`,
    );
    const scopes = entry.scopes ?? [];
    if (!Array.isArray(scopes)) throw new Error(`${where}.scopes 必须是数组`);
    const parsedScopes = new Set();
    for (const scope of scopes) {
      const parsedScope = parseGrantedScope(scope); // 复用内核校验
      parsedScopes.add(`${parsedScope.scopeType}:${parsedScope.scopeKey}`);
    }

    let maxActiveSessions;
    if (entry.maxActiveSessions !== undefined) {
      if (
        !Number.isInteger(entry.maxActiveSessions) ||
        entry.maxActiveSessions < 1
      ) {
        throw new Error(`${where}.maxActiveSessions 必须是正整数`);
      }
      maxActiveSessions = entry.maxActiveSessions;
    }

    // 主体最高密级（可选）：会话请求的 clearance 高于它时会被收窄。
    let clearance;
    if (entry.clearance !== undefined && entry.clearance !== null) {
      if (
        entry.clearance !== 'public' &&
        entry.clearance !== 'internal' &&
        entry.clearance !== 'confidential'
      ) {
        throw new Error(
          `${where}.clearance 必须是 public/internal/confidential`,
        );
      }
      clearance = entry.clearance;
    }

    const tokens = entry.tokens ?? [];
    if (!Array.isArray(tokens)) throw new Error(`${where}.tokens 必须是数组`);
    const parsedTokens = tokens.map((token, tokenIndex) => {
      const tokenWhere = `${where}.tokens[${tokenIndex}]`;
      if (!token || typeof token !== 'object' || Array.isArray(token)) {
        throw new Error(`${tokenWhere} 必须是对象`);
      }
      const label = requireText(token.label, `${tokenWhere}.label`);
      let expiresAt;
      if (token.expiresAt !== undefined && token.expiresAt !== null) {
        const value = requireText(token.expiresAt, `${tokenWhere}.expiresAt`);
        if (Number.isNaN(Date.parse(value))) {
          throw new Error(`${tokenWhere}.expiresAt 不是合法时间`);
        }
        const normalized = new Date(value).toISOString();
        if (normalized <= new Date().toISOString()) {
          throw new Error(`${tokenWhere}.expiresAt 必须晚于当前时间`);
        }
        expiresAt = normalized;
      }
      return { label, expiresAt };
    });

    return {
      id,
      displayName,
      scopes: [...parsedScopes].sort(),
      maxActiveSessions,
      clearance,
      tokens: parsedTokens,
    };
  });

  const warnings = [];
  for (const principal of principals) {
    if (principal.scopes.length === 0) {
      warnings.push(
        `主体 ${principal.id} 未授予任何 scope：无法签发会话，` +
          '写入受控作用域会 403（只能落 personal/self）',
      );
    }
    if (principal.tokens.length === 0) {
      warnings.push(
        `主体 ${principal.id} 没有配置 tokens：不会签发新令牌，` +
          '已有令牌不受影响',
      );
    }
  }
  return { principals, warnings };
}

// ────────────────────────── 矩阵读写 ──────────────────────────

function readExistingGrants(file) {
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || typeof raw !== 'object' || typeof raw.principals !== 'object' || raw.principals === null) {
    throw new Error(`现有矩阵文件 ${file} 结构非法（缺少 principals 对象）`);
  }
  return raw;
}

function buildGrants(spec, existing, replace) {
  const principals = {};
  if (!replace && existing) {
    for (const [id, grants] of Object.entries(existing.principals)) {
      principals[id] = {
        scopes: Array.isArray(grants.scopes) ? [...grants.scopes] : [],
        ...(grants.maxActiveSessions !== undefined
          ? { maxActiveSessions: grants.maxActiveSessions }
          : {}),
        ...(grants.clearance !== undefined
          ? { clearance: grants.clearance }
          : {}),
      };
    }
  }
  const changes = [];
  for (const principal of spec.principals) {
    const before = principals[principal.id];
    const entry = { scopes: principal.scopes };
    if (principal.maxActiveSessions !== undefined) {
      entry.maxActiveSessions = principal.maxActiveSessions;
    }
    if (principal.clearance !== undefined) {
      entry.clearance = principal.clearance;
    }
    principal.scopes.forEach(parseGrantedScope);
    principals[principal.id] = entry;
    changes.push({
      principalId: principal.id,
      action: before ? '更新' : '新增',
      scopesBefore: before?.scopes ?? [],
      scopesAfter: principal.scopes,
    });
  }
  for (const id of Object.keys(principals)) {
    for (const scope of principals[id].scopes) parseGrantedScope(scope);
  }
  return { file: { principals }, changes };
}

function writeGrants(file, grants) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    backup = `${file}.bak-${stamp}`;
    fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(grants, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    // 沙箱/macOS 环境下 node 的 renameSync/unlinkSync 可能 EPERM
    // （同路径 shell mv 可用）。回退为原地覆盖写入，tmp 清不掉就留存。
    if (error.code !== 'EPERM') throw error;
    fs.copyFileSync(tmp, file);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 留存 tmp 不影响结果，可手工清理
    }
  }
  return backup;
}

// ────────────────────────── 身份库操作 ──────────────────────────

function hasAnyCredential(identity) {
  return identity
    .listPrincipals()
    .some((principal) => identity.listCredentials(principal.id).length > 0);
}

function provisionPrincipal(identity, principal, state) {
  const existing = identity
    .listPrincipals()
    .some((row) => row.id === principal.id);
  const actions = [];
  if (existing) {
    return { actions: [`主体 ${principal.id} 已存在，跳过创建`], bootstrap: null };
  }
  if (!state.credentialHistory) {
    // 全库首次开户：内核只允许走这条路径一次，且它本身就会签发一把令牌。
    const first = principal.tokens[0];
    const initialized = identity.initializeFirstAccount({
      principalId: principal.id,
      displayName: principal.displayName,
      label: first?.label ?? 'bootstrap',
      expiresAt: first?.expiresAt ?? undefined,
    });
    state.credentialHistory = true;
    actions.push(
      `首次开户：创建主体 ${principal.id} 并签发令牌 "${first?.label ?? 'bootstrap'}"`,
    );
    return { actions, bootstrap: initialized };
  }
  identity.createPrincipal({
    id: principal.id,
    displayName: principal.displayName,
  });
  actions.push(`创建主体 ${principal.id}`);
  return { actions, bootstrap: null };
}

function issueSpecTokens(identity, principal, state, bootstrap, rotate) {
  const tokens = [];
  const skipped = [];
  // 首次开户时令牌已由 initializeFirstAccount 签发，跳过 spec 里对应的那一条，
  // 避免同一 label 重复签发两把（其中一把还接不到、等于凭空浪费）。
  if (bootstrap) {
    tokens.push({
      principalId: principal.id,
      credentialId: bootstrap.credential.id,
      label: bootstrap.credential.label,
      expiresAt: bootstrap.credential.expiresAt ?? null,
      token: bootstrap.token,
    });
  }
  const startIndex = bootstrap && principal.tokens.length > 0 ? 1 : 0;
  // 幂等：同 label 已有活跃凭据就跳过，避免重复 apply 灌出一堆废令牌。
  // 要强制换新，用 --rotate（轮换场景），或单独用 token 命令。
  const active = rotate
    ? new Set()
    : new Set(
        identity
          .listCredentials(principal.id)
          .filter((credential) => credential.status === 'active')
          .map((credential) => credential.label),
      );
  for (const token of principal.tokens.slice(startIndex)) {
    if (active.has(token.label)) {
      skipped.push(`${principal.id} / ${token.label}（已存在活跃凭据，跳过）`);
      continue;
    }
    const issued = identity.issueCredential({
      principalId: principal.id,
      label: token.label,
      expiresAt: token.expiresAt,
    });
    tokens.push({
      principalId: principal.id,
      credentialId: issued.credential.id,
      label: token.label,
      expiresAt: issued.credential.expiresAt ?? null,
      token: issued.token,
    });
  }
  return { tokens, skipped };
}

function writeTokens(tokens, file) {
  const payload = {
    _warning:
      '本文件含明文令牌，请立即转存到密钥管理系统并删除本文件；' +
      '服务端只存哈希，丢失只能重新签发。',
    generatedAt: new Date().toISOString(),
    tokens,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(file, 0o600);
}

// ────────────────────────── 命令实现 ──────────────────────────

function describeTarget(input) {
  return [
    `数据库：${input.database}`,
    `数据目录：${input.dataDir}`,
    `授权矩阵：${input.grantsFile}`,
  ];
}

function commandCheck(input) {
  const spec = loadSpec(requireSpec(input));
  return {
    ok: true,
    spec: input.specFile,
    principals: spec.principals.map((principal) => ({
      id: principal.id,
      displayName: principal.displayName,
      scopes: principal.scopes,
      maxActiveSessions: principal.maxActiveSessions ?? 32,
      tokensToIssue: principal.tokens.map((token) => token.label),
    })),
    warnings: spec.warnings,
  };
}

function loadContext(input) {
  const database = openDatabase(input.database);
  const identity = new IdentityService(database, {
    defaultPrincipalId: config.defaultUserId,
    legacyToken: config.apiToken || undefined,
  });
  return { database, identity };
}

function commandPlan(input) {
  const spec = loadSpec(requireSpec(input));
  const existing = readExistingGrants(input.grantsFile);
  const built = buildGrants(spec, existing, input.replace);
  const { database, identity } = loadContext(input);
  try {
    const credentialHistory = hasAnyCredential(identity);
    const principals = identity.listPrincipals();
    const known = new Set(principals.map((row) => row.id));
    return {
      target: describeTarget(input),
      credentialHistory,
      anonymousLoopbackAllowed: !credentialHistory && !config.apiToken,
      existingPrincipals: principals.map((row) => row.id),
      matrixMode: input.replace ? '覆盖（丢弃未在 spec 中的主体）' : '合并（保留未在 spec 中的主体）',
      matrixChanges: built.changes,
      willCreatePrincipals: spec.principals
        .filter((principal) => !known.has(principal.id))
        .map((principal) => principal.id),
      willIssueTokens: spec.principals.flatMap((principal) =>
        principal.tokens.map((token) => `${principal.id} / ${token.label}`),
      ),
      warnings: [
        ...spec.warnings,
        ...(credentialHistory
          ? []
          : [
              '⚠ apply 后本库首次出现凭据，匿名 loopback 放行将永久失效：' +
                '所有 /api 调用必须带 Authorization，且召回需带 x-memory-session-id 才看得到部门文档。',
            ]),
      ],
    };
  } finally {
    database.close();
  }
}

function commandApply(input) {
  if (!input.yes) {
    throw new Error('apply 会修改数据库与授权矩阵，请确认后加 --yes 重跑');
  }
  const spec = loadSpec(requireSpec(input));
  const existing = readExistingGrants(input.grantsFile);
  const built = buildGrants(spec, existing, input.replace);
  const backup = writeGrants(input.grantsFile, built.file);

  const { database, identity } = loadContext(input);
  const state = { credentialHistory: hasAnyCredential(identity) };
  const actions = [];
  const tokens = [];
  const skipped = [];
  try {
    const bootstraps = new Map();
    for (const principal of spec.principals) {
      const result = provisionPrincipal(identity, principal, state);
      actions.push(...result.actions);
      if (result.bootstrap) bootstraps.set(principal.id, result.bootstrap);
    }
    for (const principal of spec.principals) {
      const issued = issueSpecTokens(
        identity,
        principal,
        state,
        bootstraps.get(principal.id) ?? null,
        input.rotate,
      );
      tokens.push(...issued.tokens);
      skipped.push(...issued.skipped);
    }
  } finally {
    database.close();
  }

  if (input.tokenOut) writeTokens(tokens, input.tokenOut);
  return {
    ok: true,
    target: describeTarget(input),
    matrixBackup: backup,
    matrixChanges: built.changes,
    actions,
    tokensIssued: tokens.length,
    tokensSkipped: skipped,
    tokens: input.tokenOut
      ? `已写入 ${input.tokenOut}（权限 0600），请立即转存后删除该文件`
      : tokens,
    reminder: [
      '授权矩阵已热加载，无需重启服务。',
      '客户端必须改为带 Authorization + x-memory-session-id，否则召回只见 personal/self。',
      '若客户端尚未就绪，可删除矩阵文件回滚（会话签发整体关闭），但凭据已签发不可撤销。',
    ],
  };
}

function commandMatrix(input) {
  if (!input.yes) {
    throw new Error('matrix 会写文件，请确认后加 --yes 重跑');
  }
  const spec = loadSpec(requireSpec(input));
  const existing = readExistingGrants(input.grantsFile);
  const built = buildGrants(spec, existing, input.replace);
  const backup = writeGrants(input.grantsFile, built.file);
  return {
    ok: true,
    grantsFile: input.grantsFile,
    backup,
    matrixChanges: built.changes,
  };
}

function commandToken(input) {
  if (!input.yes) {
    throw new Error('token 会写入新凭据，请确认后加 --yes 重跑');
  }
  if (!input.principalId) throw new Error('缺少 --principal ID');
  if (!input.label) throw new Error('缺少 --label LABEL');
  const { database, identity } = loadContext(input);
  try {
    const issued = identity.issueCredential({
      principalId: input.principalId,
      label: input.label,
      expiresAt: input.expiresAt,
    });
    const entry = {
      principalId: input.principalId,
      credentialId: issued.credential.id,
      label: input.label,
      expiresAt: issued.credential.expiresAt ?? null,
      token: issued.token,
    };
    if (input.tokenOut) {
      writeTokens([entry], input.tokenOut);
      return {
        ok: true,
        credentialId: entry.credentialId,
        expiresAt: entry.expiresAt,
        tokens: `已写入 ${input.tokenOut}（权限 0600）`,
      };
    }
    return { ok: true, ...entry };
  } finally {
    database.close();
  }
}

function commandList(input) {
  const { database, identity } = loadContext(input);
  try {
    return {
      target: describeTarget(input),
      credentialHistory: hasAnyCredential(identity),
      principals: identity.listPrincipals().map((principal) => ({
        id: principal.id,
        displayName: principal.displayName,
        status: principal.status,
        credentials: identity.listCredentials(principal.id).map((credential) => ({
          id: credential.id,
          label: credential.label,
          status: credential.status,
          expiresAt: credential.expiresAt ?? null,
        })),
      })),
      grantsFileExists: fs.existsSync(input.grantsFile),
    };
  } finally {
    database.close();
  }
}

function commandSessions(input) {
  const { database } = loadContext(input);
  try {
    const now = new Date().toISOString();
    const rows = input.principalId
      ? database
          .prepare(
            `SELECT session_id, principal_id, scopes_json, issued_at, expires_at, revoked_at
             FROM trusted_sessions WHERE principal_id = ? ORDER BY issued_at DESC`,
          )
          .all(input.principalId)
      : database
          .prepare(
            `SELECT session_id, principal_id, scopes_json, issued_at, expires_at, revoked_at
             FROM trusted_sessions ORDER BY issued_at DESC LIMIT 200`,
          )
          .all();
    const sessions = rows.map((row) => ({
      sessionId: row.session_id,
      principalId: row.principal_id,
      scopes: JSON.parse(row.scopes_json),
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      active: !row.revoked_at && row.expires_at > now,
      revoked: Boolean(row.revoked_at),
    }));
    return {
      principalId: input.principalId ?? '(全部)',
      activeCount: sessions.filter((session) => session.active).length,
      sessions: input.all ? sessions : sessions.slice(0, 20),
    };
  } finally {
    database.close();
  }
}

function commandRevoke(input) {
  if (!input.yes) {
    throw new Error('revoke 会吊销凭据，请确认后加 --yes 重跑');
  }
  if (!input.principalId) throw new Error('缺少 --principal ID');
  if (!input.credentialId) throw new Error('缺少 --credential CID');
  const { database, identity } = loadContext(input);
  try {
    return {
      ok: true,
      credential: identity.revokeCredentialForPrincipal(
        input.principalId,
        input.credentialId,
        input.reason,
      ),
    };
  } finally {
    database.close();
  }
}

const COMMANDS = Object.freeze({
  check: commandCheck,
  plan: commandPlan,
  apply: commandApply,
  matrix: commandMatrix,
  token: commandToken,
  list: commandList,
  sessions: commandSessions,
  revoke: commandRevoke,
});

function run(argv) {
  const input = parseArguments(argv);
  if (input.help) return usage();
  return COMMANDS[input.command](input);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(THIS_SCRIPT)
) {
  try {
    const result = run(process.argv.slice(2));
    process.stdout.write(
      typeof result === 'string'
        ? `${result}\n`
        : `${JSON.stringify(result, null, 2)}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    process.stderr.write(`kb-provision 失败：${message}\n`);
    process.exitCode = 1;
  }
}

export { parseArguments, loadSpec, run };
