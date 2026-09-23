import path from 'node:path';

export const SYSTEM_JOB_USER_ID = '__memory_bridge_system__';
export const SYSTEM_JOB_NAMESPACE = '__global__';

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535
    ? parsed
    : fallback;
}

export function parseLoopbackHost(
  value: string | undefined,
): '127.0.0.1' | '::1' {
  return value === '::1' ? '::1' : '127.0.0.1';
}

export function parseModelIdentifier(
  environmentName: string,
  value: string | undefined,
  fallback: string,
): string {
  const model = value === undefined
    ? fallback
    : value.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,254}$/u.test(model)
  ) {
    throw new Error(
      `${environmentName} 必须是 1–255 位安全模型标识符`,
    );
  }
  return model;
}

export function parseCompatChatModel(
  value: string | undefined,
): string {
  // 优先新名 MEMORY_BRIDGE_COMPAT_CHAT_MODEL，回退旧名
  // MEMORY_BRIDGE_AIRI_CHAT_MODEL 以兼容既有部署。
  const effective =
    process.env.MEMORY_BRIDGE_COMPAT_CHAT_MODEL ?? value;
  return parseModelIdentifier(
    'MEMORY_BRIDGE_COMPAT_CHAT_MODEL',
    effective,
    'qwen2.5:14b',
  );
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) &&
    parsed >= minimum &&
    parsed <= maximum
    ? parsed
    : fallback;
}

function parseNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) &&
    parsed >= minimum &&
    parsed <= maximum
    ? parsed
    : fallback;
}

export function parseModelKeepAlive(
  value: string | undefined,
): string | number {
  const normalized = value?.trim() || '15m';
  if (
    normalized !== '-1' &&
    !/^(?:[1-9]\d*)(?:ms|s|m|h)$/u.test(normalized)
  ) {
    throw new Error(
      'MEMORY_BRIDGE_MODEL_KEEP_ALIVE 必须是 -1 或正数时长（如 15m）',
    );
  }
  // Ollama 对 keep_alive 的解析：数字按"次数语义"接受 -1=永久；
  // 字符串走 Go duration 解析，"-1" 会报 missing unit 而返回 400。
  return normalized === '-1' ? -1 : normalized;
}

// ── 弃答策略档案（Abstention Profile）────────────────────────────
// 弃答阈值调试的统一入口：一个环境变量切换一组召回闸门默认值，
// 单项 env 仍可覆盖（env 优先级高于档案默认值）。
// 调试方式：MEMORY_BRIDGE_ABSTENTION_PROFILE=strict|balanced|eager
// 或单项覆盖：MEMORY_BRIDGE_MIN_SEMANTIC_SIMILARITY /
//   MEMORY_BRIDGE_SEMANTIC_RERANK_EMPTY_FALLBACK_LIMIT /
//   MEMORY_BRIDGE_SEMANTIC_RERANK_FILLER_LIMIT。
// strict   = 出厂基线（零回归）：相似度门 0.35、全拒兜底 3、filler 关闭
// balanced = 知识库场景推荐档：门 0.30、兜底 4、filler 2
//            （比 strict 略松，允许在有重排兜底的情况下回答边界问题）
// eager    = 激进作答档：门 0.25、兜底 6、filler 4（大干扰库、宁多勿缺）
export const ABSTENTION_PROFILES = {
  strict: {
    semanticMinSimilarity: 0.35,
    semanticRerankEmptyFallbackLimit: 3,
    semanticRerankFillerLimit: 0,
  },
  balanced: {
    semanticMinSimilarity: 0.3,
    semanticRerankEmptyFallbackLimit: 4,
    semanticRerankFillerLimit: 2,
  },
  eager: {
    semanticMinSimilarity: 0.25,
    semanticRerankEmptyFallbackLimit: 6,
    semanticRerankFillerLimit: 4,
  },
} as const;

export type AbstentionProfileName = keyof typeof ABSTENTION_PROFILES;

export function resolveAbstentionProfile(
  value: string | undefined,
): AbstentionProfileName {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'balanced' || normalized === 'eager'
    ? normalized
    : 'strict';
}

const abstentionProfile = resolveAbstentionProfile(
  process.env.MEMORY_BRIDGE_ABSTENTION_PROFILE,
);

export const config = {
  host: parseLoopbackHost(process.env.MEMORY_BRIDGE_HOST),
  port: parsePort(process.env.MEMORY_BRIDGE_PORT, 3789),
  dataDir:
    process.env.MEMORY_BRIDGE_DATA_DIR ||
    path.join(process.cwd(), 'data'),
  defaultUserId: process.env.MEMORY_BRIDGE_USER_ID || 'default',
  defaultNamespace:
    process.env.MEMORY_BRIDGE_NAMESPACE || 'personal',
  apiToken: process.env.MEMORY_BRIDGE_TOKEN || '',
  // 匿名公开通道（多租户 v2，R3）：off=匿名一律 401（默认，行为与
  // 旧版一致）；public-readonly=loopback 上无令牌请求映射为 @anonymous
  // 虚拟主体，仅允许召回，且只可见 public scope + public 密级文档。
  anonymousMode:
    process.env.MEMORY_BRIDGE_ANONYMOUS_MODE === 'public-readonly'
      ? 'public-readonly' as const
      : 'off' as const,
  // 可信会话授权矩阵文件：principals → 允许签发/写入的 scope 集。
  // 文件不存在 = 功能关闭（签发 403、写闸不生效，零回归）。
  sessionGrantsFile:
    process.env.MEMORY_BRIDGE_SESSION_GRANTS_FILE ||
    path.join(
      process.env.MEMORY_BRIDGE_DATA_DIR ||
        path.join(process.cwd(), 'data'),
      'session-scope-grants.json',
    ),
  maxRecallCandidates: parseInteger(
    process.env.MEMORY_BRIDGE_MAX_RECALL_CANDIDATES,
    120,
    10,
    500,
  ),
  maxQueryVariants: parseInteger(
    process.env.MEMORY_BRIDGE_MAX_QUERY_VARIANTS,
    4,
    1,
    8,
  ),
  queryRewriteMinCandidates: parseInteger(
    process.env.MEMORY_BRIDGE_QUERY_REWRITE_MIN_CANDIDATES,
    8,
    1,
    64,
  ),
  queryRewriteMode:
    process.env.MEMORY_BRIDGE_QUERY_REWRITE_MODE === 'off'
      ? 'off' as const
      : process.env.MEMORY_BRIDGE_QUERY_REWRITE_MODE === 'deterministic'
        ? 'deterministic' as const
        : 'llm' as const,
  queryUnderstandingMode:
    process.env.MEMORY_BRIDGE_QUERY_UNDERSTANDING_MODE === 'off'
      ? 'off' as const
      : process.env.MEMORY_BRIDGE_QUERY_UNDERSTANDING_MODE === 'always'
        ? 'always' as const
        : 'auto' as const,
  queryContextMessages: parseInteger(
    process.env.MEMORY_BRIDGE_QUERY_CONTEXT_MESSAGES,
    6,
    2,
    12,
  ),
  queryContextTokenBudget: parseInteger(
    process.env.MEMORY_BRIDGE_QUERY_CONTEXT_TOKEN_BUDGET,
    1600,
    256,
    4096,
  ),
  queryUnderstandingMinConfidence: parseNumber(
    process.env.MEMORY_BRIDGE_QUERY_UNDERSTANDING_MIN_CONFIDENCE,
    0.78,
    0,
    1,
  ),
  reflectionMode:
    process.env.MEMORY_BRIDGE_REFLECTION_MODE === 'off'
      ? 'off' as const
      : 'shadow' as const,
  reflectionSweepHours: parseInteger(
    process.env.MEMORY_BRIDGE_REFLECTION_SWEEP_HOURS,
    24,
    1,
    168,
  ),
  reflectionIdleMinutes: parseInteger(
    process.env.MEMORY_BRIDGE_REFLECTION_IDLE_MINUTES,
    30,
    1,
    1_440,
  ),
  reflectionMinNewTurns: parseInteger(
    process.env.MEMORY_BRIDGE_REFLECTION_MIN_NEW_TURNS,
    12,
    1,
    1_000,
  ),
  reflectionMaxTurns: parseInteger(
    process.env.MEMORY_BRIDGE_REFLECTION_MAX_TURNS,
    40,
    2,
    200,
  ),
  reflectionTokenBudget: parseInteger(
    process.env.MEMORY_BRIDGE_REFLECTION_TOKEN_BUDGET,
    8_000,
    512,
    32_000,
  ),
  reflectionLookbackDays: parseInteger(
    process.env.MEMORY_BRIDGE_REFLECTION_LOOKBACK_DAYS,
    180,
    1,
    365,
  ),
  reflectionMinPatternEvidence: parseInteger(
    process.env.MEMORY_BRIDGE_REFLECTION_MIN_PATTERN_EVIDENCE,
    3,
    3,
    5,
  ),
  reflectionRequireCrossSessionEvidence:
    ['1', 'true'].includes(
      process.env.MEMORY_BRIDGE_REFLECTION_REQUIRE_CROSS_SESSION_EVIDENCE
        ?.trim().toLowerCase() || '',
    ),
  reflectionRequireCrossDayEvidence:
    ['1', 'true'].includes(
      process.env.MEMORY_BRIDGE_REFLECTION_REQUIRE_CROSS_DAY_EVIDENCE
        ?.trim().toLowerCase() || '',
    ),
  reflectionMaxDailyCalls: parseInteger(
    process.env.MEMORY_BRIDGE_REFLECTION_MAX_DAILY_CALLS,
    1_000,
    0,
    1_000,
  ),
  reflectionConcurrency: parseInteger(
    process.env.MEMORY_BRIDGE_REFLECTION_CONCURRENCY,
    1,
    1,
    8,
  ),
  reflectionModel: parseModelIdentifier(
    'MEMORY_BRIDGE_REFLECTION_MODEL',
    process.env.MEMORY_BRIDGE_REFLECTION_MODEL,
    'qwen2.5:14b',
  ),
  reflectionPromptVersion:
    process.env.MEMORY_BRIDGE_REFLECTION_PROMPT_VERSION ||
    'history-reflection-v3-grounded-evidence-repair',
  graphCandidateLimit: parseInteger(
    process.env.MEMORY_BRIDGE_GRAPH_CANDIDATE_LIMIT,
    24,
    0,
    100,
  ),
  feedbackPriorMax: parseNumber(
    process.env.MEMORY_BRIDGE_FEEDBACK_PRIOR_MAX,
    0.04,
    0,
    0.1,
  ),
  retrievalLogMode:
    process.env.MEMORY_BRIDGE_RETRIEVAL_LOG_MODE === 'diagnostic'
      ? 'diagnostic' as const
      : 'metadata' as const,
  retrievalJsonlEnabled:
    process.env.MEMORY_BRIDGE_RETRIEVAL_JSONL !== 'off',
  retrievalJsonlPath:
    process.env.MEMORY_BRIDGE_RETRIEVAL_JSONL_PATH || '',
  retrievalLogMaxBytes: parseInteger(
    process.env.MEMORY_BRIDGE_RETRIEVAL_LOG_MAX_BYTES,
    25 * 1024 * 1024,
    1024 * 1024,
    1024 * 1024 * 1024,
  ),
  retrievalLogRetentionDays: parseInteger(
    process.env.MEMORY_BRIDGE_RETRIEVAL_LOG_RETENTION_DAYS,
    14,
    1,
    365,
  ),
  memoryContextTokenBudget: parseInteger(
    process.env.MEMORY_BRIDGE_CONTEXT_TOKEN_BUDGET,
    1600,
    256,
    8192,
  ),
  semanticMode:
    process.env.MEMORY_BRIDGE_SEMANTIC_MODE === 'off'
      ? 'off' as const
      : 'required' as const,
  ollamaBaseUrl:
    process.env.MEMORY_BRIDGE_OLLAMA_URL ||
    'http://127.0.0.1:11434',
  modelKeepAlive: parseModelKeepAlive(
    process.env.MEMORY_BRIDGE_MODEL_KEEP_ALIVE,
  ),
  foregroundQuietMs: parseInteger(
    process.env.MEMORY_BRIDGE_FOREGROUND_QUIET_MS,
    2_000,
    0,
    60_000,
  ),
  compatChatModel:
    parseCompatChatModel(process.env.MEMORY_BRIDGE_AIRI_CHAT_MODEL),
  // OpenAI 兼容生命周期代理开关：off 时完全不挂载 /ollama-compat 路由。
  // 记忆平台本身（MCP/HTTP/记忆引擎）不依赖该代理。
  compatProxy:
    process.env.MEMORY_BRIDGE_COMPAT_PROXY === 'off' ? false : true,
  embeddingModel: parseModelIdentifier(
    'MEMORY_BRIDGE_EMBED_MODEL',
    process.env.MEMORY_BRIDGE_EMBED_MODEL,
    'bge-m3:latest',
  ),
  queryModel: parseModelIdentifier(
    'MEMORY_BRIDGE_QUERY_MODEL',
    process.env.MEMORY_BRIDGE_QUERY_MODEL,
    parseModelIdentifier(
      'MEMORY_BRIDGE_RERANK_MODEL',
      process.env.MEMORY_BRIDGE_RERANK_MODEL,
      'qwen2.5:14b',
    ),
  ),
  rerankModel: parseModelIdentifier(
    'MEMORY_BRIDGE_RERANK_MODEL',
    process.env.MEMORY_BRIDGE_RERANK_MODEL,
    'qwen2.5:14b',
  ),
  extractionModel: parseModelIdentifier(
    'MEMORY_BRIDGE_EXTRACTION_MODEL',
    process.env.MEMORY_BRIDGE_EXTRACTION_MODEL,
    'qwen2.5:14b',
  ),
  extractionPromptVersion:
    process.env.MEMORY_BRIDGE_EXTRACTION_PROMPT_VERSION ||
    'extract-v6',
  relationModel: parseModelIdentifier(
    'MEMORY_BRIDGE_RELATION_MODEL',
    process.env.MEMORY_BRIDGE_RELATION_MODEL,
    'qwen2.5:14b',
  ),
  relationPromptVersion:
    process.env.MEMORY_BRIDGE_RELATION_PROMPT_VERSION ||
    'claim-relation-v1',
  explicitIntentModel: parseModelIdentifier(
    'MEMORY_BRIDGE_EXPLICIT_INTENT_MODEL',
    process.env.MEMORY_BRIDGE_EXPLICIT_INTENT_MODEL,
    'qwen2.5:14b',
  ),
  explicitIntentPromptVersion:
    process.env.MEMORY_BRIDGE_EXPLICIT_INTENT_PROMPT_VERSION ||
    'explicit-memory-intent-v2',
  consolidationModel: parseModelIdentifier(
    'MEMORY_BRIDGE_CONSOLIDATION_MODEL',
    process.env.MEMORY_BRIDGE_CONSOLIDATION_MODEL,
    'qwen2.5:14b',
  ),
  consolidationPromptVersion:
    process.env.MEMORY_BRIDGE_CONSOLIDATION_PROMPT_VERSION ||
    'consolidate-v6',
  consolidationMinSources: parseInteger(
    process.env.MEMORY_BRIDGE_CONSOLIDATION_MIN_SOURCES,
    2,
    2,
    20,
  ),
  consolidationMaxSources: parseInteger(
    process.env.MEMORY_BRIDGE_CONSOLIDATION_MAX_SOURCES,
    40,
    2,
    100,
  ),
  consolidationIdleMinutes: parseInteger(
    process.env.MEMORY_BRIDGE_CONSOLIDATION_IDLE_MINUTES,
    15,
    1,
    1_440,
  ),
  summaryTimezoneOffsetMinutes: parseInteger(
    process.env.MEMORY_BRIDGE_SUMMARY_TIMEZONE_OFFSET_MINUTES,
    -new Date().getTimezoneOffset(),
    -840,
    840,
  ),
  episodeHotDays: parseInteger(
    process.env.MEMORY_BRIDGE_EPISODE_HOT_DAYS,
    30,
    7,
    365,
  ),
  episodeCompactionBatchSize: parseInteger(
    process.env.MEMORY_BRIDGE_EPISODE_COMPACTION_BATCH_SIZE,
    1_000,
    50,
    5_000,
  ),
  consolidationRedundancyThreshold: parseInteger(
    process.env.MEMORY_BRIDGE_CONSOLIDATION_REDUNDANCY_THRESHOLD,
    4,
    2,
    100,
  ),
  retentionArchiveThreshold: parseNumber(
    process.env.MEMORY_BRIDGE_RETENTION_ARCHIVE_THRESHOLD,
    0.1,
    0.01,
    0.9,
  ),
  retentionSweepHours: parseInteger(
    process.env.MEMORY_BRIDGE_RETENTION_SWEEP_HOURS,
    24,
    1,
    168,
  ),
  automationMode:
    process.env.MEMORY_BRIDGE_AUTOMATION_MODE === 'off'
      ? 'off' as const
      : process.env.MEMORY_BRIDGE_AUTOMATION_MODE === 'auto'
        ? 'auto' as const
        : 'shadow' as const,
  namespaceQualityBootstrap:
    process.env.MEMORY_BRIDGE_NAMESPACE_QUALITY_BOOTSTRAP ===
      'audited-auto'
      ? 'audited-auto' as const
      : 'none' as const,
  namespaceQualityBootstrapReason:
    process.env.MEMORY_BRIDGE_NAMESPACE_QUALITY_BOOTSTRAP_REASON ||
    'explicit_startup_bootstrap',
  namespaceQualityBootstrapTtlHours: parseInteger(
    process.env.MEMORY_BRIDGE_NAMESPACE_QUALITY_BOOTSTRAP_TTL_HOURS,
    24,
    1,
    168,
  ),
  autoCommitMinConfidence: parseNumber(
    process.env.MEMORY_BRIDGE_AUTO_COMMIT_MIN_CONFIDENCE,
    0.95,
    0,
    1,
  ),
  autoCommitMinImportance: parseNumber(
    process.env.MEMORY_BRIDGE_AUTO_COMMIT_MIN_IMPORTANCE,
    0.5,
    0,
    1,
  ),
  workerPollMs: parseInteger(
    process.env.MEMORY_BRIDGE_WORKER_POLL_MS,
    500,
    100,
    60_000,
  ),
  semanticEmbedBatchSize: parseInteger(
    process.env.MEMORY_BRIDGE_EMBED_BATCH_SIZE,
    64,
    1,
    256,
  ),
  semanticRerankBatchSize: parseInteger(
    process.env.MEMORY_BRIDGE_RERANK_BATCH_SIZE,
    16,
    1,
    32,
  ),
  semanticRerankConcurrency: parseInteger(
    process.env.MEMORY_BRIDGE_RERANK_CONCURRENCY,
    2,
    1,
    2,
  ),
  // 重排候选文本总预算（字符/批，按水位法摊给该批候选）。
  // 出厂 640 是为对话记忆短条目调的 1.5s 延迟门槛；知识库 chunk 数百字
  // 时该预算会把每条压到约 40 字，重排看不到答案区。
  // 默认 640 = 现行为（零回归）；知识库场景建议 2400 起。
  // 放大时须同步抬高 semanticRerankNumCtx，否则尾部候选被上下文截断。
  semanticRerankCandidateTextBudget: parseInteger(
    process.env.MEMORY_BRIDGE_SEMANTIC_RERANK_CANDIDATE_TEXT_BUDGET,
    640,
    128,
    16_384,
  ),
  // 重排调用的 num_ctx。0 = 不显式传（沿用 Ollama 运行时默认，通常 2048），
  // 与出厂行为一致；放大候选预算时必须设到足够容纳整批 payload，
  // 否则模型只看到前一半候选（实测默认值下 4472 字符仅喂入 2050 token）。
  semanticRerankNumCtx: parseInteger(
    process.env.MEMORY_BRIDGE_SEMANTIC_RERANK_NUM_CTX,
    0,
    0,
    131_072,
  ),
  // 重排 provider：llm = 生成模型逐批判定（出厂行为）；
  // cross_encoder = 专用交叉编码器（bge-reranker-v2-m3，Python sidecar）。
  // CE 模式跳过 LLM 文本预算/num_ctx/协议恢复/早停——那些都是为贵模型服务的；
  // 分数经 sigmoid 映射为 confidence，score>=0 视为相关。
  // sidecar 启动方式见 sidecar/ce-rerank/README.md。
  semanticRerankProvider:
    process.env.MEMORY_BRIDGE_RERANK_PROVIDER === 'cross_encoder'
      ? 'cross_encoder' as const
      : 'llm' as const,
  crossEncoderBaseUrl:
    process.env.MEMORY_BRIDGE_CROSS_ENCODER_URL ||
    'http://127.0.0.1:3798',
  crossEncoderModel:
    process.env.MEMORY_BRIDGE_CROSS_ENCODER_MODEL ||
    'bge-reranker-v2-m3',
  crossEncoderTimeoutMs: parseInteger(
    process.env.MEMORY_BRIDGE_CROSS_ENCODER_TIMEOUT_MS,
    30_000,
    1_000,
    600_000,
  ),
  crossEncoderBatchSize: parseInteger(
    process.env.MEMORY_BRIDGE_CROSS_ENCODER_BATCH_SIZE,
    32,
    1,
    128,
  ),
  // CE 分数→confidence 的校准陡度：confidence = sigmoid(score * k)。
  // k 越大，relevant 项（score 明显>0）的 confidence 越快饱和到 1，
  // 最终排序越回归 dense 分主导（与 LLM 重排的 0.95/1.0 二值 confidence
  // 同语义）；k=1 为裸 sigmoid，会把连续置信度注入排序造成扰动。
  crossEncoderConfidenceScale: parseInteger(
    process.env.MEMORY_BRIDGE_CROSS_ENCODER_CONF_SCALE,
    3,
    1,
    10,
  ),
  // 召回排序的 confidence 权重：relevance = semantic*(1-w) + confidence*w。
  // 出厂 0.45 = 现行为。CE 模式（confidence 承载重排器信息量远高于二值
  // LLM 判定）建议 0.9，让 CE 排序主导、dense 只做兜底信号。
  semanticRerankConfidenceWeight: parseNumber(
    process.env.MEMORY_BRIDGE_RERANK_CONFIDENCE_WEIGHT,
    0.45,
    0,
    1,
  ),
  semanticCacheTtlMs: parseInteger(
    process.env.MEMORY_BRIDGE_SEMANTIC_CACHE_TTL_MS,
    30_000,
    1_000,
    600_000,
  ),
  semanticCacheMaxEntries: parseInteger(
    process.env.MEMORY_BRIDGE_SEMANTIC_CACHE_MAX_ENTRIES,
    256,
    1,
    4_096,
  ),
  semanticMaxRerankCandidates: parseInteger(
    process.env.MEMORY_BRIDGE_MAX_RERANK_CANDIDATES,
    64,
    1,
    64,
  ),
  abstentionProfile,
  semanticMinSimilarity: parseNumber(
    process.env.MEMORY_BRIDGE_MIN_SEMANTIC_SIMILARITY,
    ABSTENTION_PROFILES[abstentionProfile].semanticMinSimilarity,
    0,
    1,
  ),
  semanticMinConfidence: parseNumber(
    process.env.MEMORY_BRIDGE_MIN_RERANK_CONFIDENCE,
    0.7,
    0,
    1,
  ),
  // 语料域分档门槛：逐候选按 memories.corpus_domain 查表，未标注走
  // semanticMinConfidence。policy 严（制度文档答错代价高，宁可拒答）、
  // open 松（维基类问法与正文措辞距离大，高门槛误杀正确依据）。
  rerankGatePolicy: parseNumber(
    process.env.MEMORY_BRIDGE_RERANK_GATE_POLICY,
    0.9,
    0,
    1,
  ),
  rerankGateOpen: parseNumber(
    process.env.MEMORY_BRIDGE_RERANK_GATE_OPEN,
    0.65,
    0,
    1,
  ),
  rerankGateChat: parseNumber(
    process.env.MEMORY_BRIDGE_RERANK_GATE_CHAT,
    0.7,
    0,
    1,
  ),
  semanticRerankEmptyFallbackLimit: parseInteger(
    process.env
      .MEMORY_BRIDGE_SEMANTIC_RERANK_EMPTY_FALLBACK_LIMIT,
    ABSTENTION_PROFILES[abstentionProfile]
      .semanticRerankEmptyFallbackLimit,
    0,
    8,
  ),
  // 重排相关不足填充：relevant 数量不足时按粗排分补齐 non-relevant 候选
  // （标 filler、排序垫底），用于知识库多跳场景保留链条中间环节。
  // 默认随弃答策略档案（strict=0 关闭）；对话记忆场景可用 strict。
  semanticRerankFillerLimit: parseInteger(
    process.env.MEMORY_BRIDGE_SEMANTIC_RERANK_FILLER_LIMIT,
    ABSTENTION_PROFILES[abstentionProfile].semanticRerankFillerLimit,
    0,
    8,
  ),
  semanticTimeoutMs: parseInteger(
    process.env.MEMORY_BRIDGE_SEMANTIC_TIMEOUT_MS,
    120_000,
    1_000,
    600_000,
  ),
};

export function databasePath(): string {
  return path.join(config.dataDir, 'memory-bridge.sqlite3');
}
