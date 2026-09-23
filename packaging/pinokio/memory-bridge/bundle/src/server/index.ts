import { randomUUID } from 'node:crypto';
import { MemoryLifecycle } from './memory-lifecycle.js';
import {
  OllamaClaimRelationClassifier,
} from './claim-relation-classifier.js';
import { config, databasePath } from './config.js';
import { ConversationService } from './conversation-service.js';
import {
  ConversationChatEngine,
  OllamaConversationChatProvider,
} from './conversation-chat.js';
import {
  createConfiguredQueryUnderstandingService,
} from './contextual-query-understanding.js';
import { openDatabase } from './database.js';
import { createHttpServer } from './http-server.js';
import { IdentityService } from './identity.js';
import {
  ExplicitMemoryIntentService,
  OllamaExplicitMemoryIntentProvider,
} from './explicit-memory-intent.js';
import { DENSE_LSH_VERSION } from './hybrid-retrieval.js';
import { DenseIndexEvaluator } from './dense-index-evaluator.js';
import { EpisodicMemoryService } from './episodic-memory-service.js';
import {
  HierarchicalSummaryService,
} from './hierarchical-summary-service.js';
import { LifecycleStore } from './lifecycle-store.js';
import { MemoryAdminService } from './memory-admin.js';
import {
  MemoryConsolidator,
  OllamaConsolidationProvider,
} from './memory-consolidator.js';
import { MemoryGovernance } from './memory-governance.js';
import { OllamaMemoryExtractor } from './memory-extractor.js';
import { MemoryStore } from './memory-store.js';
import {
  createConfiguredReflectionProvider,
  MemoryReflectionService,
} from './memory-reflection.js';
import {
  MemoryWorker,
  MemoryWorkerRunner,
} from './memory-worker.js';
import {
  NamespaceGatedCandidateResolver,
  NamespaceQualityService,
  NamespaceRecallCoordinator,
} from './namespace-quality.js';
import { createConfiguredSemanticRanker } from './semantic-ranker.js';
import {
  SessionScopeGrants,
  TrustedSessionService,
} from './trusted-sessions.js';

const database = openDatabase(databasePath());
const trustedSessions = new TrustedSessionService(
  database,
  new SessionScopeGrants(config.sessionGrantsFile),
);
const identityService = new IdentityService(database, {
  defaultPrincipalId: config.defaultUserId,
  legacyToken: config.apiToken || undefined,
});
const conversationService = new ConversationService(database);
const namespaceQuality = new NamespaceQualityService(database);
if (
  config.namespaceQualityBootstrap === 'audited-auto' &&
  !namespaceQuality.latestSnapshot(
    config.defaultUserId,
    config.defaultNamespace,
  )
) {
  namespaceQuality.bootstrapAuto({
    userId: config.defaultUserId,
    namespace: config.defaultNamespace,
    reason: config.namespaceQualityBootstrapReason,
    actor: 'startup-config',
    expiresAt: new Date(
      Date.now() +
      config.namespaceQualityBootstrapTtlHours * 60 * 60 * 1_000,
    ).toISOString(),
  });
}
const aliasedEmbeddingModels = (
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
         ON r.model_id = g.model_id
       ORDER BY r.model_name ASC`,
    )
    .all() as Array<Record<string, unknown>>
).map((row) => String(row.model_name));
const semanticRankers = [
  ...new Set([
    config.embeddingModel,
    ...aliasedEmbeddingModels,
  ]),
].flatMap((embeddingModel) => {
  const ranker = createConfiguredSemanticRanker(embeddingModel);
  return ranker ? [ranker] : [];
});
const semanticRanker = semanticRankers[0];
const store = new MemoryStore(
  database,
  semanticRankers,
);
const lifecycleStore = new LifecycleStore(database);
const candidateResolver = new NamespaceGatedCandidateResolver(
  database,
  lifecycleStore,
  store,
  namespaceQuality,
  config.automationMode,
  {
    autoCommitMinConfidence: config.autoCommitMinConfidence,
    autoCommitMinImportance: config.autoCommitMinImportance,
    embeddingProvider: semanticRanker,
    classifier: new OllamaClaimRelationClassifier({
      baseUrl: config.ollamaBaseUrl,
      model: config.relationModel,
      promptVersion: config.relationPromptVersion,
      timeoutMs: config.semanticTimeoutMs,
      keepAlive: config.modelKeepAlive,
    }),
  },
);
const explicitIntentService = new ExplicitMemoryIntentService(
  database,
  lifecycleStore,
  store,
  candidateResolver,
  new OllamaExplicitMemoryIntentProvider({
    baseUrl: config.ollamaBaseUrl,
    model: config.explicitIntentModel,
    promptVersion: config.explicitIntentPromptVersion,
    timeoutMs: config.semanticTimeoutMs,
    keepAlive: config.modelKeepAlive,
  }),
);
const recallCoordinator = new NamespaceRecallCoordinator(
  database,
  store,
  namespaceQuality,
  { globalMode: config.automationMode },
);
const queryUnderstandingService =
  createConfiguredQueryUnderstandingService();
const memoryExtractor = new OllamaMemoryExtractor({
  baseUrl: config.ollamaBaseUrl,
  model: config.extractionModel,
  promptVersion: config.extractionPromptVersion,
  timeoutMs: config.semanticTimeoutMs,
  keepAlive: config.modelKeepAlive,
});
const reflectionService = new MemoryReflectionService(
  database,
  lifecycleStore,
  memoryExtractor,
  createConfiguredReflectionProvider(),
);
const lifecycle = new MemoryLifecycle(
  store,
  lifecycleStore,
  config.defaultUserId,
  config.defaultNamespace,
  explicitIntentService,
  recallCoordinator,
  identityService,
  queryUnderstandingService,
);
const conversationChatEngine = new ConversationChatEngine(
  conversationService,
  {
    model: config.compatChatModel,
    provider: new OllamaConversationChatProvider({
      baseUrl: config.ollamaBaseUrl,
      timeoutMs: config.semanticTimeoutMs,
    }),
    lifecycle,
  },
);
const consolidationProvider = new OllamaConsolidationProvider({
  baseUrl: config.ollamaBaseUrl,
  model: config.consolidationModel,
  promptVersion: config.consolidationPromptVersion,
  timeoutMs: config.semanticTimeoutMs,
  keepAlive: config.modelKeepAlive,
});
const consolidator = new MemoryConsolidator(
  database,
  lifecycleStore,
  store,
  consolidationProvider,
);
const episodicMemoryService = new EpisodicMemoryService(database);
const hierarchicalSummaryService = new HierarchicalSummaryService(
  database,
  store,
  consolidationProvider,
);
const governance = new MemoryGovernance(
  database,
  lifecycleStore,
  store,
);
const denseEvaluator = new DenseIndexEvaluator(store);
const adminService = new MemoryAdminService(
  database,
  store,
  lifecycleStore,
  candidateResolver,
  governance,
);
lifecycleStore.ensureConsolidationSweep();
reflectionService.ensureSweepChains();
const startupScopes = store.denseIndexScopes();
governance.ensureRetentionSweepChains(undefined, startupScopes);
for (const scope of startupScopes) {
  const generations = store.denseIndexGenerations(
    scope.userId,
    scope.namespace,
  );
  const targets = generations.length > 0
    ? generations
    : [null];
  for (const generation of targets) {
    const model = generation?.embeddingModel ||
      semanticRanker?.embeddingModel;
    if (!model) continue;
    lifecycleStore.enqueueJob({
      id: [
        'backfill-dense',
        model,
        scope.userId,
        scope.namespace,
        generation?.generationId ||
          `startup-${randomUUID()}`,
      ].join(':'),
      jobType: 'backfill_dense_index',
      userId: scope.userId,
      namespace: scope.namespace,
      payload: {
        model,
        indexVersion:
          generation?.indexVersion || DENSE_LSH_VERSION,
        probeModel: true,
        ...(generation
          ? {
              dimensions: generation.dimensions,
              generationKey: generation.generationKey,
              generationId: generation.generationId,
            }
          : {}),
      },
      requiredModelId: generation?.modelId,
      requiredGenerationId: generation?.generationId,
      priority: 2,
      maxAttempts: 5,
    });
  }
}
const workerRunner = new MemoryWorkerRunner(
  new MemoryWorker(
    lifecycleStore,
    memoryExtractor,
    candidateResolver,
    consolidator,
    governance,
    config.automationMode !== 'off',
    store,
    denseEvaluator,
    reflectionService,
    episodicMemoryService,
    hierarchicalSummaryService,
  ),
  `memory-worker:${process.pid}:${randomUUID()}`,
);
workerRunner.start();
const server = createHttpServer(store, {
  memoryLifecycle: lifecycle,
  adminService,
  identityService,
  reflectionService,
  queryUnderstandingService,
  conversationService,
  conversationChatEngine,
  conversationNamespace: config.defaultNamespace,
  trustedSessions,
});

server.listen(config.port, config.host, () => {
  console.log(
    `忆桥 Memory Bridge 已启动：http://${config.host}:${config.port}`,
  );
});

const shutdown = (signal: string) => {
  console.log(`收到 ${signal}，正在安全关闭…`);
  conversationChatEngine.close();
  workerRunner.stop();
  server.close(() => {
    database.close();
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
