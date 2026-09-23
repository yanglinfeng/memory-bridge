import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  openDatabase,
  SCHEMA_VERSION,
} from '../src/server/database.js';
import { parseModelIdentifier } from '../src/server/config.js';
import { IdentityService } from '../src/server/identity.js';
import { NamespaceQualityService } from '../src/server/namespace-quality.js';
import { createPrivateQaRunRoot } from './qa-receipt-lib.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const NAMESPACE = `airi-final-v${SCHEMA_VERSION}`;
const ALICE_ID = 'airi-acceptance-alice';
const BOB_ID = 'airi-acceptance-bob';
const ROOT_PREFIX = `memory-bridge-airi-final-v${SCHEMA_VERSION}.`;
const configuredAcceptanceParent =
  process.env.MEMORY_BRIDGE_ACCEPTANCE_PARENT_DIR?.trim();
const acceptanceParent = configuredAcceptanceParent || tmpdir();

function configuredModel(name, fallback) {
  return parseModelIdentifier(name, process.env[name], fallback);
}

const defaultChatModel = configuredModel(
  'MEMORY_BRIDGE_AIRI_CHAT_MODEL',
  'qwen2.5:14b',
);
const models = {
  chat: parseModelIdentifier(
    'MEMORY_BRIDGE_QA_CHAT_MODEL',
    process.env.MEMORY_BRIDGE_QA_CHAT_MODEL,
    defaultChatModel,
  ),
  extraction: configuredModel(
    'MEMORY_BRIDGE_EXTRACTION_MODEL',
    'qwen2.5:14b',
  ),
  relation: configuredModel(
    'MEMORY_BRIDGE_RELATION_MODEL',
    'qwen2.5:14b',
  ),
  explicitIntent: configuredModel(
    'MEMORY_BRIDGE_EXPLICIT_INTENT_MODEL',
    'qwen2.5:14b',
  ),
  consolidation: configuredModel(
    'MEMORY_BRIDGE_CONSOLIDATION_MODEL',
    'qwen2.5:14b',
  ),
  reflection: configuredModel(
    'MEMORY_BRIDGE_REFLECTION_MODEL',
    'qwen2.5:14b',
  ),
  rerank: configuredModel(
    'MEMORY_BRIDGE_RERANK_MODEL',
    'qwen2.5:14b',
  ),
  embedding: configuredModel(
    'MEMORY_BRIDGE_EMBED_MODEL',
    'bge-m3:latest',
  ),
};

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function writePrivateJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  chmodSync(filePath, 0o600);
}

function scalar(database, sql, ...parameters) {
  const row = database.prepare(sql).get(...parameters);
  return Number(Object.values(row ?? {})[0] ?? 0);
}

function main() {
  const root = createPrivateQaRunRoot(acceptanceParent, ROOT_PREFIX);
  const dataDir = path.join(root, 'memory-data');
  const airiUserDataDirs = {
    alice: path.join(root, 'airi-profile-alice'),
    bob: path.join(root, 'airi-profile-bob'),
  };
  const receiptsDir = path.join(root, 'receipts');
  const databasePath = path.join(dataDir, 'memory-bridge.sqlite3');
  const secretsPath = path.join(root, 'acceptance-secrets.json');
  const manifestPath = path.join(root, 'acceptance-manifest.json');
  const mcpPaths = {
    alice: path.join(airiUserDataDirs.alice, 'mcp.json'),
    bob: path.join(airiUserDataDirs.bob, 'mcp.json'),
  };
  let database;

  try {
    mkdirSync(dataDir, { mode: 0o700 });
    mkdirSync(airiUserDataDirs.alice, { mode: 0o700 });
    mkdirSync(airiUserDataDirs.bob, { mode: 0o700 });
    mkdirSync(receiptsDir, { mode: 0o700 });
    chmodSync(root, 0o700);

    database = openDatabase(databasePath);
    const identity = new IdentityService(database, {
      defaultPrincipalId: ALICE_ID,
    });
    const alice = identity.initializeFirstAccount({
      principalId: ALICE_ID,
      displayName: 'AIRI Acceptance Alice',
      label: 'final-airi-alice',
    });
    const bobPrincipal = identity.createPrincipal({
      id: BOB_ID,
      displayName: 'AIRI Acceptance Bob',
    });
    const bob = identity.issueCredential({
      principalId: bobPrincipal.id,
      label: 'final-airi-bob',
    });

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000)
      .toISOString();
    const quality = new NamespaceQualityService(database);
    for (const principalId of [ALICE_ID, BOB_ID]) {
      const decision = quality.bootstrapAuto({
        userId: principalId,
        namespace: NAMESPACE,
        reason: 'isolated-final-airi-acceptance',
        actor: 'prepare-airi-acceptance',
        expiresAt,
      });
      if (decision.mode !== 'auto') {
        throw new Error(`${principalId} 未进入 auto 模式`);
      }
    }

    writePrivateJson(secretsPath, {
      alice: {
        principalId: ALICE_ID,
        credentialId: alice.credential.id,
        token: alice.token,
      },
      bob: {
        principalId: BOB_ID,
        credentialId: bob.credential.id,
        token: bob.token,
      },
    });

    const mcpConfig = (token) => ({
      mcpServers: {
        'memory-bridge': {
          command: process.execPath,
          args: [path.join(PROJECT_ROOT, 'dist/server/mcp-stdio.js')],
          env: {
            MEMORY_BRIDGE_DATA_DIR: dataDir,
            MEMORY_BRIDGE_MCP_TOKEN: token,
            MEMORY_BRIDGE_NAMESPACE: NAMESPACE,
            MEMORY_BRIDGE_SEMANTIC_MODE: 'required',
            MEMORY_BRIDGE_OLLAMA_URL: 'http://127.0.0.1:11434',
            MEMORY_BRIDGE_EMBED_MODEL: models.embedding,
            MEMORY_BRIDGE_RERANK_MODEL: models.rerank,
            MEMORY_BRIDGE_EXTRACTION_MODEL: models.extraction,
            MEMORY_BRIDGE_RELATION_MODEL: models.relation,
            MEMORY_BRIDGE_EXPLICIT_INTENT_MODEL:
              models.explicitIntent,
            MEMORY_BRIDGE_CONSOLIDATION_MODEL:
              models.consolidation,
            MEMORY_BRIDGE_REFLECTION_MODEL: models.reflection,
          },
        },
      },
    });
    writePrivateJson(mcpPaths.alice, mcpConfig(alice.token));
    writePrivateJson(mcpPaths.bob, mcpConfig(bob.token));

    const schemaVersion = scalar(database, 'PRAGMA user_version');
    const integrity = database.prepare('PRAGMA integrity_check').get();
    const foreignKeyViolations = database
      .prepare('PRAGMA foreign_key_check')
      .all().length;
    const principalCount = scalar(
      database,
      'SELECT COUNT(*) AS count FROM account_principals',
    );
    const credentialCount = scalar(
      database,
      'SELECT COUNT(*) AS count FROM auth_credentials',
    );
    const canonicalMemoryCount = scalar(
      database,
      'SELECT COUNT(*) AS count FROM memory_items',
    );
    const turnCount = scalar(
      database,
      'SELECT COUNT(*) AS count FROM conversation_turns',
    );
    const candidateCount = scalar(
      database,
      'SELECT COUNT(*) AS count FROM memory_candidates',
    );
    const rolloutCount = scalar(
      database,
      `SELECT COUNT(*) AS count
       FROM namespace_rollout_state
       WHERE namespace = ? AND rollout_mode = 'auto'
         AND quality_state = 'bootstrap'
         AND override_kind = 'bootstrap_auto'`,
      NAMESPACE,
    );
    const initialState = {
      schemaVersion,
      integrity: String(Object.values(integrity ?? {})[0]),
      foreignKeyViolations,
      principalCount,
      credentialCount,
      rolloutCount,
      canonicalMemoryCount,
      turnCount,
      candidateCount,
    };

    if (
      schemaVersion !== SCHEMA_VERSION ||
      initialState.integrity !== 'ok' ||
      foreignKeyViolations !== 0 ||
      // v25+ deliberately retains `default` as the legacy compatibility
      // principal. Alice and Bob are the two credentialed acceptance users.
      principalCount !== 3 ||
      credentialCount !== 2 ||
      canonicalMemoryCount !== 0 ||
      turnCount !== 0 ||
      candidateCount !== 0 ||
      rolloutCount !== 2
    ) {
      throw new Error(
        `隔离验收库的初始不变量不成立：${JSON.stringify(initialState)}`,
      );
    }

    database.close();
    database = undefined;
    writePrivateJson(manifestPath, {
      format: 'memory-bridge-airi-acceptance:v1',
      createdAt: new Date().toISOString(),
      root,
      dataDir,
      databasePath,
      receiptsDir,
      retention: configuredAcceptanceParent
        ? 'persistent-parent'
        : 'temporary-parent',
      secretsPath,
      airiProfiles: {
        alice: {
          userDataDir: airiUserDataDirs.alice,
          mcpPath: mcpPaths.alice,
          mcpConfigSha256: sha256File(mcpPaths.alice),
        },
        bob: {
          userDataDir: airiUserDataDirs.bob,
          mcpPath: mcpPaths.bob,
          mcpConfigSha256: sha256File(mcpPaths.bob),
        },
      },
      namespace: NAMESPACE,
      principals: [
        {
          id: ALICE_ID,
          credentialId: alice.credential.id,
          tokenHint: alice.credential.secretHint,
        },
        {
          id: BOB_ID,
          credentialId: bob.credential.id,
          tokenHint: bob.credential.secretHint,
        },
      ],
      models,
      initialState,
      databaseSha256: sha256File(databasePath),
    });

    console.log(JSON.stringify({
      ok: true,
      root,
      manifestPath,
      schemaVersion,
      integrity: 'ok',
      foreignKeyViolations,
      principalCount,
      credentialCount,
      rolloutCount,
      canonicalMemoryCount,
      turnCount,
      candidateCount,
      retention: configuredAcceptanceParent
        ? 'persistent-parent'
        : 'temporary-parent',
      secrets: 'written with mode 0600; values not printed',
    }, null, 2));
  } catch (error) {
    try {
      database?.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    throw error;
  }
}

main();
