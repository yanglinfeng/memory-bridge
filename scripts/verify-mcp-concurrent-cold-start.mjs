import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const serverPath = path.join(projectRoot, 'dist/server/mcp-stdio.js');
const dataDir = path.resolve(process.argv[2] || '');
const receiptPath = path.resolve(process.argv[3] || '');
const databasePath = path.join(dataDir, 'memory-bridge.sqlite3');
const EXPECTED_BOUNDARY_ID = 'scale-boundary-100000';

if (!process.argv[2] || !process.argv[3]) {
  throw new Error(
    '用法：node scripts/verify-mcp-concurrent-cold-start.mjs <dataDir> <receiptPath>',
  );
}
if (!fs.existsSync(serverPath)) throw new Error('缺少已构建 MCP server');
if (!fs.existsSync(databasePath)) throw new Error('缺少验收数据库');
if (fs.existsSync(receiptPath)) throw new Error('回执文件已存在');

function scalar(database, sql) {
  return Number(Object.values(database.prepare(sql).get() || {})[0] || 0);
}

function databaseSnapshot(includeIntegrity = false) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      schemaVersion: scalar(database, 'PRAGMA user_version'),
      memories: scalar(database, 'SELECT COUNT(*) FROM memories'),
      turns: scalar(database, 'SELECT COUNT(*) FROM conversation_turns'),
      annRows: scalar(database, 'SELECT COUNT(*) FROM memory_ann_index'),
      termRows: scalar(database, 'SELECT COUNT(*) FROM memory_term_index'),
      incompleteAnn: scalar(
        database,
        `SELECT COUNT(*) FROM (
           SELECT m.id
           FROM memories m
           LEFT JOIN memory_ann_index a
             ON a.memory_id = m.id
            AND a.index_model = 'local-hybrid-v2'
           WHERE m.status != 'deleted'
           GROUP BY m.id
           HAVING COUNT(DISTINCT a.band) != 16
         )`,
      ),
      missingTerms: scalar(
        database,
        `SELECT COUNT(*)
         FROM memories m
         WHERE m.status != 'deleted'
           AND NOT EXISTS (
             SELECT 1 FROM memory_term_index t
             WHERE t.memory_id = m.id
               AND t.index_model = 'local-hybrid-v2'
           )`,
      ),
      duplicateAnn: scalar(
        database,
        `SELECT COUNT(*) - COUNT(DISTINCT memory_id || ':' ||
           index_model || ':' || band) FROM memory_ann_index`,
      ),
      duplicateTerms: scalar(
        database,
        `SELECT COUNT(*) - COUNT(DISTINCT memory_id || ':' ||
           index_model || ':' || term) FROM memory_term_index`,
      ),
      ...(includeIntegrity
        ? {
          integrity: String(
            Object.values(
              database.prepare('PRAGMA integrity_check').get() || {},
            )[0] || '',
          ),
          foreignKeyViolations:
            database.prepare('PRAGMA foreign_key_check').all().length,
        }
        : {}),
    };
  } finally {
    database.close();
  }
}

function createConnection(label) {
  const client = new Client({
    name: `memory-bridge-cold-start-${label}`,
    version: '1.0.0',
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH || '',
      MEMORY_BRIDGE_DATA_DIR: dataDir,
      MEMORY_BRIDGE_USER_ID: 'default',
      MEMORY_BRIDGE_SEMANTIC_MODE: 'off',
      MEMORY_BRIDGE_RETRIEVAL_LOG_MODE: 'metadata',
      MEMORY_BRIDGE_RETRIEVAL_JSONL: 'off',
    },
    stderr: 'pipe',
  });
  const stderr = [];
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  return {
    label,
    client,
    transport,
    stderr,
    connectedMs: null,
    maxRssKb: 0,
  };
}

function sampleRss(connection) {
  const pid = connection.transport.pid;
  if (!pid) return;
  try {
    const output = execFileSync(
      'ps',
      ['-o', 'rss=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 1_000 },
    ).trim();
    connection.maxRssKb = Math.max(
      connection.maxRssKb,
      Number(output) || 0,
    );
  } catch {
    // 进程可能刚好在采样时退出；最终连接/关闭状态另行校验。
  }
}

function telemetrySummary(stderr) {
  const events = stderr
    .join('')
    .split(/\r?\n/u)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed?.component === 'hybrid-index-repair' ? [parsed] : [];
      } catch {
        return [];
      }
    });
  const batches = events.filter((event) => event.event === 'batch-committed');
  const lockDurations = batches
    .map((event) => Number(event.lockDurationMs) || 0)
    .sort((left, right) => left - right);
  const percentile = (value) => lockDurations.length === 0
    ? 0
    : lockDurations[
      Math.max(0, Math.ceil(lockDurations.length * value) - 1)
    ];
  return {
    batches: batches.length,
    selected: batches.reduce(
      (total, event) => total + (Number(event.selected) || 0),
      0,
    ),
    repaired: batches.reduce(
      (total, event) => total + (Number(event.repaired) || 0),
      0,
    ),
    skipped: batches.reduce(
      (total, event) => total + (Number(event.skipped) || 0),
      0,
    ),
    busyRetries: batches.reduce(
      (total, event) => total + (Number(event.busyRetries) || 0),
      0,
    ),
    lockP50Ms: percentile(0.5),
    lockP95Ms: percentile(0.95),
    lockMaxMs: lockDurations.at(-1) || 0,
  };
}

function errorFingerprint(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    name: error instanceof Error ? error.name : 'Error',
    messageSha256: createHash('sha256').update(message).digest('hex'),
    sqliteBusy: /SQLITE_BUSY|database is (?:locked|busy)/iu.test(message),
  };
}

function writeReceipt(receipt) {
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    receiptPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  fs.chmodSync(receiptPath, 0o600);
}

const startedAt = new Date().toISOString();
const before = databaseSnapshot(false);
const connections = [createConnection('a'), createConnection('b')];
let sampler;
let failure = null;
let toolsPerConnection = [];
let boundaryRecallPassed = false;
let connectWallMs = null;
const connectStartedAt = performance.now();

try {
  sampler = setInterval(
    () => connections.forEach(sampleRss),
    100,
  );
  await Promise.all(connections.map(async (connection) => {
    const connectionStartedAt = performance.now();
    await connection.client.connect(connection.transport, {
      timeout: 10 * 60_000,
      maxTotalTimeout: 10 * 60_000,
    });
    connection.connectedMs = Number(
      (performance.now() - connectionStartedAt).toFixed(3),
    );
  }));
  connectWallMs = Number(
    (performance.now() - connectStartedAt).toFixed(3),
  );
  connections.forEach(sampleRss);
  toolsPerConnection = await Promise.all(
    connections.map(async (connection) => {
      const tools = await connection.client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === 'memory_recall'));
      return tools.tools.length;
    }),
  );
  const recalled = await connections[0].client.callTool({
    name: 'memory_recall',
    arguments: {
      query: '用户阅读长文时更喜欢什么版本？纸质版本。',
      namespace: 'personal',
      limit: 3,
      minScore: 0,
    },
  });
  const text = recalled.content.find((entry) => entry.type === 'text');
  const parsed = text && text.type === 'text' ? JSON.parse(text.text) : [];
  boundaryRecallPassed = Array.isArray(parsed) && parsed.some(
    (entry) => entry?.memory?.id === EXPECTED_BOUNDARY_ID,
  );
  assert.equal(boundaryRecallPassed, true);
} catch (error) {
  failure = error;
} finally {
  if (sampler) clearInterval(sampler);
  await Promise.allSettled(
    connections.map((connection) => connection.client.close()),
  );
}

const after = databaseSnapshot(true);
const stderrTexts = connections.map((connection) =>
  connection.stderr.join('')
);
const busyInStderr = stderrTexts.some((stderr) =>
  /SQLITE_BUSY|database is (?:locked|busy)/iu.test(stderr)
);
const telemetry = connections.map((connection, index) => ({
  label: connection.label,
  connectMs: connection.connectedMs,
  maxRssKb: connection.maxRssKb,
  stderrBytes: Buffer.byteLength(stderrTexts[index]),
  ...telemetrySummary(connection.stderr),
}));
const passed =
  failure === null &&
  !busyInStderr &&
  toolsPerConnection.length === 2 &&
  boundaryRecallPassed &&
  after.schemaVersion === 31 &&
  after.incompleteAnn === 0 &&
  after.missingTerms === 0 &&
  after.duplicateAnn === 0 &&
  after.duplicateTerms === 0 &&
  after.integrity === 'ok' &&
  after.foreignKeyViolations === 0;

const receipt = {
  format: 'memory-bridge-mcp-concurrent-cold-start-v1',
  startedAt,
  completedAt: new Date().toISOString(),
  passed,
  workload: {
    processes: 2,
    simultaneousConnect: true,
    startupTimeoutMs: 10 * 60_000,
    semanticMode: 'off',
  },
  before,
  after,
  toolsPerConnection,
  boundaryRecallPassed,
  busyInStderr,
  totalConnectWallMs: connectWallMs,
  connections: telemetry,
  failure: failure ? errorFingerprint(failure) : null,
};
writeReceipt(receipt);
console.log(JSON.stringify({
  passed,
  receiptPath,
  totalConnectWallMs: receipt.totalConnectWallMs,
  connections: telemetry,
}));
if (!passed) process.exitCode = 1;
