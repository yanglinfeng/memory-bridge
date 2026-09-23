import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMcpModelEnvironment,
  verifyModelPreflight,
} from '../scripts/qa-model-preflight-lib.mjs';

const manifestModels = {
  chat: 'chat-custom:latest',
  extraction: 'extract-custom:latest',
  relation: 'relation-custom:latest',
  explicitIntent: 'intent-custom:latest',
  consolidation: 'consolidate-custom:latest',
  reflection: 'reflect-custom:latest',
  rerank: 'rerank-custom:latest',
  embedding: 'embed-custom:latest',
};

const runtime = {
  compatChatModel: manifestModels.chat,
  extractionModel: manifestModels.extraction,
  relationModel: manifestModels.relation,
  explicitIntentModel: manifestModels.explicitIntent,
  consolidationModel: manifestModels.consolidation,
  reflectionModel: manifestModels.reflection,
  rerankModel: manifestModels.rerank,
  embeddingModel: manifestModels.embedding,
};

test('验收模型预检逐角色绑定 manifest、请求和运行时配置', () => {
  const evidence = verifyModelPreflight({
    manifestModels,
    runtime,
    requestedChatModel: manifestModels.chat,
  });

  assert.equal(evidence.passed, true);
  assert.deepEqual(evidence.manifestModels, manifestModels);
  assert.deepEqual(evidence.runtimeModels, manifestModels);
  assert.equal(evidence.requestedChatModel, manifestModels.chat);
});

test('验收模型预检拒绝运行时角色漂移和 QA 聊天模型覆盖', () => {
  assert.throws(
    () => verifyModelPreflight({
      manifestModels,
      runtime: {
        ...runtime,
        reflectionModel: 'unexpected-reflection:latest',
      },
      requestedChatModel: manifestModels.chat,
    }),
    /reflection/,
  );
  assert.throws(
    () => verifyModelPreflight({
      manifestModels,
      runtime,
      requestedChatModel: 'unexpected-chat:latest',
    }),
    /requestedChatModel/,
  );
  assert.throws(
    () => verifyModelPreflight({
      manifestModels: { ...manifestModels, relation: '' },
      runtime,
      requestedChatModel: manifestModels.chat,
    }),
    /relation/,
  );
});

test('MCP 验收子进程使用 manifest 中的全部语义模型', () => {
  assert.deepEqual(buildMcpModelEnvironment(manifestModels), {
    MEMORY_BRIDGE_EMBED_MODEL: manifestModels.embedding,
    MEMORY_BRIDGE_RERANK_MODEL: manifestModels.rerank,
    MEMORY_BRIDGE_EXTRACTION_MODEL: manifestModels.extraction,
    MEMORY_BRIDGE_RELATION_MODEL: manifestModels.relation,
    MEMORY_BRIDGE_EXPLICIT_INTENT_MODEL: manifestModels.explicitIntent,
    MEMORY_BRIDGE_CONSOLIDATION_MODEL: manifestModels.consolidation,
    MEMORY_BRIDGE_REFLECTION_MODEL: manifestModels.reflection,
  });
});
