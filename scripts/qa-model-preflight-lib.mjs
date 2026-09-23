const MODEL_ROLE_FIELDS = Object.freeze({
  chat: 'compatChatModel',
  extraction: 'extractionModel',
  relation: 'relationModel',
  explicitIntent: 'explicitIntentModel',
  consolidation: 'consolidationModel',
  reflection: 'reflectionModel',
  rerank: 'rerankModel',
  embedding: 'embeddingModel',
});

function requiredModel(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`AIRI 模型预检失败：${label} 不是规范模型标识符`);
  }
  return value;
}

function manifestModelMap(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('AIRI 模型预检失败：manifest.models 缺失');
  }
  return Object.fromEntries(
    Object.keys(MODEL_ROLE_FIELDS).map((role) => [
      role,
      requiredModel(input[role], `manifest.models.${role}`),
    ]),
  );
}

function runtimeModelMap(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('AIRI 模型预检失败：运行时配置缺失');
  }
  return Object.fromEntries(
    Object.entries(MODEL_ROLE_FIELDS).map(([role, field]) => [
      role,
      requiredModel(input[field], `runtime.${field}`),
    ]),
  );
}

export function verifyModelPreflight({
  manifestModels,
  runtime,
  requestedChatModel,
}) {
  const normalizedManifest = manifestModelMap(manifestModels);
  const normalizedRuntime = runtimeModelMap(runtime);
  const requested = requiredModel(
    requestedChatModel,
    'requestedChatModel',
  );
  const mismatches = Object.keys(MODEL_ROLE_FIELDS)
    .filter((role) => normalizedManifest[role] !== normalizedRuntime[role])
    .map(
      (role) => `${role}: manifest=${normalizedManifest[role]}, ` +
        `runtime=${normalizedRuntime[role]}`,
    );
  if (requested !== normalizedManifest.chat) {
    mismatches.push(
      `requestedChatModel=${requested}, manifest.chat=${normalizedManifest.chat}`,
    );
  }
  if (mismatches.length > 0) {
    throw new Error(`AIRI 模型预检失败：${mismatches.join('；')}`);
  }
  return {
    passed: true,
    manifestModels: normalizedManifest,
    runtimeModels: normalizedRuntime,
    requestedChatModel: requested,
  };
}

export function buildMcpModelEnvironment(manifestModels) {
  const models = manifestModelMap(manifestModels);
  return {
    MEMORY_BRIDGE_EMBED_MODEL: models.embedding,
    MEMORY_BRIDGE_RERANK_MODEL: models.rerank,
    MEMORY_BRIDGE_EXTRACTION_MODEL: models.extraction,
    MEMORY_BRIDGE_RELATION_MODEL: models.relation,
    MEMORY_BRIDGE_EXPLICIT_INTENT_MODEL: models.explicitIntent,
    MEMORY_BRIDGE_CONSOLIDATION_MODEL: models.consolidation,
    MEMORY_BRIDGE_REFLECTION_MODEL: models.reflection,
  };
}
