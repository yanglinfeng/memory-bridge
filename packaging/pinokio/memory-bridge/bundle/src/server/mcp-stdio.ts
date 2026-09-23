import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isClientIdentityId } from './client-identity-contract.js';
import { config, databasePath } from './config.js';
import {
  createConfiguredQueryUnderstandingService,
} from './contextual-query-understanding.js';
import { openDatabase } from './database.js';
import { IdentityService } from './identity.js';
import { MemoryStore } from './memory-store.js';
import {
  createMcpServer,
  type McpBoundContext,
} from './mcp-server.js';
import { createConfiguredSemanticRanker } from './semantic-ranker.js';
import type { MemoryAccessScope } from './types.js';

const MCP_TOKEN_ENV = 'MEMORY_BRIDGE_MCP_TOKEN';
const MCP_PERSONA_ENV = 'MEMORY_BRIDGE_MCP_PERSONA_ID';
const MCP_PROJECT_ENV = 'MEMORY_BRIDGE_MCP_PROJECT_ID';
const MCP_SESSION_ENV = 'MEMORY_BRIDGE_MCP_SESSION_ID';

function resolveStartupPrincipal(
  database: ReturnType<typeof openDatabase>,
): string {
  const token = process.env[MCP_TOKEN_ENV]?.trim() || null;
  const configuredPrincipalId =
    process.env.MEMORY_BRIDGE_USER_ID?.trim() || null;

  // The credential is needed only for this one startup decision. Keeping it
  // out of the process environment reduces the chance of later diagnostics
  // or child processes exposing it.
  delete process.env[MCP_TOKEN_ENV];

  if (!token && !configuredPrincipalId) {
    throw new Error(
      'MCP 启动必须显式设置 MEMORY_BRIDGE_USER_ID 或 MEMORY_BRIDGE_MCP_TOKEN',
    );
  }

  const identity = new IdentityService(database, {
    defaultPrincipalId:
      configuredPrincipalId || config.defaultUserId,
  });
  const principal = token
    ? identity.authenticate({ token, isLoopback: true })
    : identity.trustPrincipal(configuredPrincipalId!, 'mcp_trusted');
  return principal.principalId;
}

function optionalTrustedIdentityId(environmentName: string): string | null {
  const value = process.env[environmentName]?.trim() || null;
  if (value !== null && !isClientIdentityId(value)) {
    throw new Error(`${environmentName} 不是合法的稳定身份 ID`);
  }
  return value;
}

function resolveStartupBinding(
  database: ReturnType<typeof openDatabase>,
): McpBoundContext {
  const principalId = resolveStartupPrincipal(database);
  const personaId = optionalTrustedIdentityId(MCP_PERSONA_ENV);
  const projectId = optionalTrustedIdentityId(MCP_PROJECT_ENV);
  const sessionId = optionalTrustedIdentityId(MCP_SESSION_ENV);
  const scopes: MemoryAccessScope[] = [
    { scopeType: 'personal', scopeKey: 'self' },
  ];

  // A role or session is trustworthy only as a complete pair. A partial
  // desktop/client configuration fails closed to personal/self; project is
  // admitted only alongside that complete conversation identity.
  if (personaId && sessionId) {
    scopes.push({ scopeType: 'role', scopeKey: personaId });
    if (projectId) {
      scopes.push({ scopeType: 'project', scopeKey: projectId });
    }
    scopes.push({ scopeType: 'session', scopeKey: sessionId });
  }

  return {
    principalId,
    namespace: config.defaultNamespace,
    scopes,
  };
}

async function main(): Promise<void> {
  const database = openDatabase(databasePath());
  const binding = resolveStartupBinding(database);
  const aliasedModels = (
    database
      .prepare(
        `SELECT DISTINCT r.model_name
         FROM dense_index_aliases a
         JOIN dense_index_generations g
           ON g.generation_id IN (
             a.active_generation_id,
             a.building_generation_id,
             a.previous_generation_id
           )
         JOIN embedding_model_registry r
           ON r.model_id = g.model_id`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((row) => String(row.model_name));
  const rankers = [
    ...new Set([config.embeddingModel, ...aliasedModels]),
  ].flatMap((model) => {
    const ranker = createConfiguredSemanticRanker(model);
    return ranker ? [ranker] : [];
  });
  const store = new MemoryStore(
    database,
    rankers,
  );
  const server = createMcpServer(
    store,
    binding,
    createConfiguredQueryUnderstandingService(),
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error('Memory Bridge MCP failed:', error);
  process.exit(1);
});
