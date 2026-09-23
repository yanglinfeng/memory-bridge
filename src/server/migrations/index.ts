/**
 * 迁移注册表 —— 版本号即顺序，缺一不可。
 *
 * 从 database.ts 的 migrate() 逐块搬出（零逻辑改写）。
 * 新增版本时：
 *   1. 写 src/server/migrations/vNN-<slug>.ts，导出 applyVNN(context)；
 *   2. 在这里 import 并追加到 MIGRATION_STEPS 末尾（version 必须递增）；
 *   3. 若该块会 DROP/重建会话触发器，记得重装 V32/33/35/36 四组；
 *   4. 同步 SCHEMA_VERSION 与 lifecycle 的 EXPECTED_SCHEMA。
 */
import type { MigrationContext, MigrationStep } from './context.js';
import {
  IDENTITY_SCHEMA_VERSION,
} from '../schema-migration-ledger.js';
import {
  ensureV26SchemaAttestation,
} from '../schema-integrity.js';
import { applyV1 } from './v01-initial-schema.js';
import { applyV2 } from './v02-idempotency-keys-v2.js';
import { applyV3 } from './v03-audit-log-v3.js';
import { applyV4 } from './v04-memory-embeddings.js';
import { applyV5 } from './v05-conversation-and-extraction-core.js';
import { applyV6 } from './v06-memory-items-and-versions.js';
import { applyV7 } from './v07-fts-and-ann-index.js';
import { applyV8 } from './v08-memory-term-index.js';
import { applyV9 } from './v09-derived-consolidation-and-purge.js';
import { applyV10 } from './v10-conversation-lineage-and-tool-events.js';
import { applyV11 } from './v11-outbox-events.js';
import { applyV12 } from './v12-dense-lsh-index.js';
import { applyV13 } from './v13-dense-index-state.js';
import { applyV14 } from './v14-dense-lsh-generation-key.js';
import { applyV15 } from './v15-semantic-revision-triggers.js';
import { applyV16 } from './v16-candidate-resolution-and-evidence.js';
import { applyV17 } from './v17-candidate-stable-key.js';
import { applyV18 } from './v18-extraction-prompt-contract-version.js';
import { applyV19 } from './v19-memory-action-requests.js';
import { applyV20 } from './v20-tombstones-active-item-index.js';
import { applyV21 } from './v21-action-request-review-index.js';
import { applyV22 } from './v22-embedding-model-registry.js';
import { applyV23 } from './v23-drop-legacy-dense-lsh-indexes.js';
import { applyV24 } from './v24-namespace-quality-snapshots.js';
import { applyV25 } from './v25-account-principals-and-auth.js';
import { applyV26 } from './v26-project-binding-and-identity-attestation.js';
import { applyV27 } from './v27-retrieval-traces-and-feedback.js';
import { applyV28 } from './v28-client-persona-principal-index.js';
import { applyV29 } from './v29-reflection-settings-and-runs.js';
import { applyV30 } from './v30-reflection-run-turns-and-claims.js';
import { applyV31 } from './v31-turn-ingest-order.js';
import { applyV32 } from './v32-persona-chat-and-project-bindings.js';
import { applyV33 } from './v33-conversation-rounds.js';
import { applyV34 } from './v34-conversation-changes.js';
import { applyV35 } from './v35-conversation-regeneration.js';
import { applyV36 } from './v36-conversation-deletion.js';
import { applyV37 } from './v37-conversation-episodes-and-summaries.js';
import { applyV38 } from './v38-episode-compactions.js';
import { applyV39 } from './v39-memory-evidence-triggers.js';
import { applyV40 } from './v40-content-origin.js';
import { applyV41 } from './v41-trusted-sessions.js';
import { applyV42 } from './v42-corpus-domain.js';
import { applyV43 } from './v43-visibility-model-v2.js';
import { applyV44 } from './v44-public-scope-enum.js';

/**
 * v26 之后、v27 之前的一段补签分支：原始 migrate() 中它是块外语句，
 * 只在 fromVersion 恰好等于 IDENTITY_SCHEMA_VERSION(26)（即 v26 块未执行）
 * 时补一次账本签名。这里保留 always 步骤以维持完全相同的执行时机。
 */
const ensureV26AttestationAtIdentityVersion = (
  context: MigrationContext,
): void => {
  if (context.version === IDENTITY_SCHEMA_VERSION) {
    ensureV26SchemaAttestation(context.database);
  }
};

export const MIGRATION_STEPS: ReadonlyArray<MigrationStep> = [
  { version: 1, label: '初始 schema：memories / memory_relations / audit_log / idempotency_keys', apply: applyV1 },
  { version: 2, label: '幂等键表重建（v2）', apply: applyV2 },
  { version: 3, label: '审计日志表重建（v3）', apply: applyV3 },
  { version: 4, label: '记忆向量表', apply: applyV4 },
  { version: 5, label: '会话与提取核心表（sessions/turns/extraction_runs/candidates/items/versions）', apply: applyV5 },
  { version: 6, label: '记忆条目 / 版本 / 任务表', apply: applyV6 },
  { version: 7, label: '全文索引 FTS 与 ANN 索引及触发器', apply: applyV7 },
  { version: 8, label: '词项索引', apply: applyV8 },
  { version: 9, label: '派生合并句与物理清除任务', apply: applyV9 },
  { version: 10, label: '会话血缘键与工具事件', apply: applyV10 },
  { version: 11, label: '发件箱事件表', apply: applyV11 },
  { version: 12, label: '稠密 LSH 索引表', apply: applyV12 },
  { version: 13, label: '稠密索引状态表与代际索引', apply: applyV13 },
  { version: 14, label: '稠密 LSH 代际唯一键', apply: applyV14 },
  { version: 15, label: '语义修订戳触发器', apply: applyV15 },
  { version: 16, label: '候选裁决运行、证据与墓碑', apply: applyV16 },
  { version: 17, label: '候选 stableKey 索引', apply: applyV17 },
  { version: 18, label: '提取提示词契约版本列与回填', apply: applyV18 },
  { version: 19, label: '记忆动作请求表', apply: applyV19 },
  { version: 20, label: '墓碑活跃条目索引', apply: applyV20 },
  { version: 21, label: '动作请求复核索引', apply: applyV21 },
  { version: 22, label: '向量模型登记表与稠密索引代际/别名重建', apply: applyV22 },
  { version: 23, label: '清理 legacy 稠密 LSH 索引', apply: applyV23 },
  { version: 24, label: '命名空间质量快照与灰度状态', apply: applyV24 },
  { version: 25, label: '账号主体 / 凭据 / 人设绑定表', apply: applyV25 },
  { version: 26, label: '会话项目绑定列、身份不可变触发器与账本首批签名', apply: applyV26 },
  {
    version: 26,
    label: 'v26 身份账本补签（仅当版本恰为 26 时生效）',
    always: true,
    apply: ensureV26AttestationAtIdentityVersion,
  },
  { version: 27, label: '检索 trace 与反馈样本表', apply: applyV27 },
  { version: 28, label: '客户端人设主体索引', apply: applyV28 },
  { version: 29, label: '反思设置 / 检查点 / 运行表', apply: applyV29 },
  { version: 30, label: '反思运行轮次 / 模型调用 / 声明表', apply: applyV30 },
  { version: 31, label: '轮次摄取顺序表', apply: applyV31 },
  { version: 32, label: '人设会话档案、项目绑定、消息动作与游标键', apply: applyV32 },
  { version: 33, label: '会话轮次表与租约索引', apply: applyV33 },
  { version: 34, label: '会话变更流表', apply: applyV34 },
  { version: 35, label: '重新生成请求表', apply: applyV35 },
  { version: 36, label: '删除回执 / 屏障 / 证据证明 / 记忆重算 / 维护任务 / 导入状态', apply: applyV36 },
  { version: 37, label: '会话片段、模式观察与摘要表', apply: applyV37 },
  { version: 38, label: '片段压缩表', apply: applyV38 },
  { version: 39, label: '记忆证据触发器安装与会话触发器重装', apply: applyV39 },
  { version: 40, label: '内容出生通道（pipeline / api）', apply: applyV40 },
  { version: 41, label: '可信会话签发表', apply: applyV41 },
  { version: 42, label: '语料域分档 corpus_domain', apply: applyV42 },
  { version: 43, label: '多租户可见性模型 v2', apply: applyV43 },
  { version: 44, label: '公开通道：scope_type CHECK 枚举重建', apply: applyV44 },
];

/** 按注册表顺序执行所有尚未应用的迁移，返回最终版本号。 */
export function runMigrationSteps(context: MigrationContext): number {
  for (const step of MIGRATION_STEPS) {
    if (step.always) {
      step.apply(context);
      continue;
    }
    if (context.version < step.version) {
      step.apply(context);
      context.version = step.version;
    }
  }
  return context.version;
}
