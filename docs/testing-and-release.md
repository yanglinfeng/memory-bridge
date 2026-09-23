# 测试、验收与发布门禁

忆桥把“代码能运行”“检索质量合格”“真实 AIRI 自动记忆闭环通过”分开验收。
任何单一绿色命令都不能代表全部三层通过。

## 1. 测试层级

| 层级 | 目标 | 是否依赖 Ollama |
|---|---|---|
| TypeScript 类型检查 | 接口和类型一致 | 否 |
| 自动化单元/集成 | 数据、身份、API、MCP、Worker、恢复 | 大部分否，模型边界可 stub |
| Conversation 契约 | schema 31→39、CRUD、round/SSE、删除、导入和审计 | 否，provider 可 fake |
| 分层情景记忆 | exchange→episode、FTS/Dense、observation、层级摘要和来源 | 大部分否 |
| Build | 服务端与 React 产物 | 否 |
| 固定检索评测 | Recall/MRR/nDCG 和 Dense generation | 是 |
| 查询理解/历史重提炼固定集 | 120 条查询、100 个隔离历史窗口和安全零计数 | 是 |
| AIRI-compatible HTTP 探针 | 兼容层、生命周期、响应修复、审计和 trace 联动 | 是 |
| 重排 benchmark | 真实 14B 性能与固定质量集 | 是 |
| 规模/稳定性 | 100k/1m、并发、租约和崩溃恢复 | 部分是 |
| 真实 AIRI 桌面 | 无关键词写入/召回/纠正/遗忘/fork/重启 | 是，且依赖 AIRI |

## 2. 快速开发门禁

```bash
npm run typecheck
npm test
npm run build
```

适用于普通代码变更和合入前检查。`npm test` 会先构建服务端，再用 Node test
runner 执行 `tests/**/*.test.ts` 和 `tests/**/*.test.mjs`。

schema 31 历史验收快照：

- typecheck：PASS。
- build：PASS，Vite 1,593 modules。
- 自动化测试：627/627 PASS。HTTP 测试必须在允许本机回环端口的环境执行；受限
  沙箱若出现 `listen EPERM 127.0.0.1`
  失败，发布证据必须采用允许回环端口的沙箱外原样重跑结果。

这些数字只描述 schema 31 验收时锁定的代码，不应硬编码成未来永远不变的门槛。
当前重排收口代码快照已完成 986/986 自动化、`npm run typecheck` 和
`npm run build`；旧的 627/627 仍只作为 schema 31 历史证据。完整回归通过不替代
真实 AIRI 桌面闭环。

## 3. 固定检索评测

```bash
npm run evaluate:dense
npm run evaluate:retrieval-p1
npm run evaluate:namespace-quality
```

用途：

- `evaluate:dense`：在不可变 Dense generation 上验证语义召回。
- `evaluate:retrieval-p1`：混合召回 P1 固定集。
- `evaluate:namespace-quality`：决定 namespace 是否具备 auto 资格。

验收快照：Dense Recall@20 1.0、MRR@10 0.975；P1 固定集
Recall@5/MRR@5/nDCG@5 均为 1.0。这些是小型回归哨兵，不代表线上成功率 100%。

## 4. 真实模型重排

```bash
npm run benchmark:rerank
npm run verify:reranker-quality
```

发布门禁固定使用 `qwen2.5:14b + bge-m3:latest`，不得用其他模型、mock、自定义样本或
注入 fetch 冒充真实 PASS。默认性能样本覆盖 128 字 ranking query、16 条候选、
640 字候选正文和 20 个唯一顺序；门槛保持 P95 ≤ 1500 ms。必须同时验证负例，例如：

- 查询 Alice 的项目代号。
- 候选只有 Bob 的夜间饮品“玄米茶”。
- 严格重排必须返回 `relevant=false`。

离线 mock 单测不能证明新模型理解主体、账户、persona、role 和 project 一致性。
更换模型或 prompt 后必须重跑真实正/负例。

2026-09-01 当前协议为 `rerank-v9-compact-atomic-provider`，使用紧凑等价
prompt、`{q,m:[[index,memory],...]}` provider 载体和顶层相关 index 数组，未删除
主体、谓词、否定、时间或证据正文。真实生产负载 20/20 正确，P50/P95/max 为
1250.596/1313.867/1316.948 ms，prompt 为 676 tokens，fallback 为 0；相同口径
旧 P95 为 1627.330 ms，下降 19.3%。完整质量门禁 171/171 正确。冷加载只在
warmup 中单独记录，不混入稳态 P95。

同一发布门禁后续真实复跑仍为 20/20，P50/P95/max 为
876.165/956.240/958.418 ms；质量门禁仍为 171/171，model-route P50/P95/max
为 342.710/358.616/418.678 ms。全局 14B 迁移后质量门禁再次 171/171 通过，最新
model-route P95 为 365.147 ms。发布记录同时保留 1313.867 ms 的较保守 P95
基线和 956.240 ms 的后续复跑，不把单次较快复跑外推为稳定下界。

生产默认重排模型仍是 `qwen2.5:14b`；上述发布真实性能测试固定使用
`qwen2.5:14b + bge-m3:latest`。不得把固定门禁成绩写成日常会话的端到端运行时性能，
也不得把固定重排门禁外推成端到端客户端延迟。

## 5. 规模与可靠性

```bash
npm run benchmark:scale -- \
  --receipt /private/tmp/memory-bridge-scale-schema31.json
npm run soak:reliability
npm run verify:crash-recovery
npm run verify:dense-switch-rollback
npm run qa:natural-conversation-quality
npm run qa:conversation-long-timeline
```

- 规模基线覆盖 100k memories / 1m turns；发布证据必须使用 `--receipt` 保存机器
  可读 JSON，不能只从终端抄录指标。
- soak 默认执行 PRD 的长时间、多会话、多 Worker 验收。
- crash recovery 验证 outbox、lease、幂等和重放。
- Dense switch/rollback 验证 building/active/previous alias 原子切换。
- 自然对话质量 runner 验证召回、弃答、纠正、遗忘、稳定习惯和真实模型 provenance。
- 长时间轴 runner 固定执行 8 用户 × 每用户 10,000 条、180 天、写并发 4，并验证
  episode/FTS/Dense/摘要来源覆盖、MCP 隔离、持久化和不可变回执。

不要为缩短正式发布门禁而设置脚本的 short/keep 变量。短跑只适合开发反馈。

## 6. 记忆质量评测

```bash
npm run evaluate:consolidation-quality
npm run evaluate:explicit-correction-quality
```

应验证：

- 提取为可独立理解的原子 claim。
- equivalent/reinforces/supersedes/contradicts/coexists 决策正确。
- correction 保持 UUID、追加版本、关闭旧当前值。
- consolidation 每句话有来源，无来源句 quarantined。
- 来源变化后摘要 stale，并可重建。
- forget 立即停止召回并阻止同义复活。

## 7. 多账户与作用域验收

至少准备 Alice 和 Bob 两个真实凭据，覆盖：

- Alice personal 正向召回。
- Bob 查询 Alice 事实为零结果/不知道。
- Bob 自己事实正常召回。
- 同账户两个 persona 的 role 隔离。
- project A/project B/无 project 隔离。
- session 私有与 personal 共享。
- fork 继承 project，不能重绑。
- 相同 client/persona 稳定 ID 在不同 principal 不串绑（schema 28）。
- body/query `userId`/`principalId` 覆盖被拒绝。
- MCP 同 principal 的两个真实进程必须覆盖跨 namespace、role、project、session 的
  recall/list/stats/update/forget/supersede 负例；连接外 UUID 与不存在 UUID 同样失败。

测试必须使用两个真实 Token，不要只改请求 body 模拟用户。

## 8. 真实 AIRI 桌面闭环

服务端测试不能替代以下步骤：

1. 用隔离 AIRI profile 和隔离忆桥数据目录启动。
2. 自然聊天表达偏好，不说“请长期记住”。
3. 等后台提取后新建空会话，自然提问并召回。
4. 自然表达偏好已改变，验证同 UUID 新 revision。
5. 自然要求遗忘，验证 tombstone。
6. 测双 persona、双 project、无 project 和 fork。
7. 用 Bob 进行跨账户负例和自己的正例。
8. 完整重启 AIRI、忆桥和 Ollama。
9. 重启后正向事实仍召回，被遗忘/越权事实仍不召回。
10. 普通私有事实零召回精确返回 `不知道。`，可信召回以
    `根据长期记忆：` 开头，世界知识/建议 hard negative 正常回答。
11. 检查响应 `x-memory-bridge-request-id` / `x-memory-bridge-trace-id`，并证明
    forced/proxy audit 与 SQLite 九阶段 trace 同一。

验收环境不得改写用户正式 AIRI profile 或把测试数据写入正式库。完整步骤见
[AIRI 接入与验收](airi-integration.md)。

## 9. 数据完整性门禁

发布快照至少满足：

- SQLite integrity `ok`。
- foreign key violation 0。
- schema/迁移 ledger/身份触发器 attestation 通过。
- v39 `memory_evidence_owner_insert` / `memory_evidence_identity_update` 规范 SQL
  attestation 通过，owner/namespace/scope 污染 evidence 为 0。
- 跨边界 evidence 插入及 `memory_version_id`/`turn_id` 换绑负例必须由 SQLite 拒绝。
- duplicate active canonical chain 0。
- outbox pending/running/failed 0（周期 future job 除外）。
- 未解决 dead letter 0。
- retrying/stale/quarantined 0。
- 每 scope 周期任务活跃链数量正确。
- Dense eligible=indexed、lag 0。
- retrieval log consecutiveFailures 0。
- Memory Doctor 无 critical。

## 9.1 schema 36 引入、当前 schema 44 沿用的 Conversation 权威门禁

### 不依赖真实模型的 P0 契约

- 空库和 schema 31→44 迁移都到达 44；污染 assistant 历史必须阻断迁移。
- 两个真实 principal 的 persona、project、conversation、message、round、event、change、
  delete 和 import 均严格隔离，越权资源统一 404。
- create/message/regenerate/delete/import 的幂等键同 payload 重放原结果，不同 payload
  返回 `IDEMPOTENCY_CONFLICT`。
- 同一 conversation 并发发送只有一个非终态 round；失败/中断不会复制用户消息。
- SSE 在 accepted、首 delta、中间 delta 和 terminal 前断开后可恢复，delta 不重复、不乱序。
- fake provider 按多个 NDJSON chunk 输出时产生真实增量；未闭合 ACT/协议不提前发布。
- 最终正文和已发布 delta 逐字一致；后段协议畸形保留已发布安全 partial，但最终 failed，
  不写 assistant message 或 extraction outbox。
- 删除同步清除历史 event/change 正文和 action；晚到 completion 受 generation barrier 拒绝。
- retain 删除生成无正文 evidence proof；forget 对唯一/多 evidence 分别 tombstone/recompute。
- AIRI import 覆盖多 batch、dry-run/commit lane、cursor 篡改、last batch、重复消息、跨账户
  cursor 和整批回滚；import turn 不自动排生命周期任务。
- Conversation Doctor 检查 non-terminal stale round、event/change 过期正文、维护 dead job、
  orphan、active variant 唯一性和 import 状态一致性。
- 审计存在 started/completed/failed，包含模型、稳定错误码和 recall/provider/first-token/总耗时，
  但正文、Prompt、Token、memory context 和 provider wire 命中均为 0。

### 需要 loopback 的 HTTP 契约

- 所有路由都必须携带真实 Bearer；body/query 身份覆盖返回
  `FORBIDDEN_IDENTITY_OVERRIDE`。
- SSE `Content-Type`、`Cache-Control: no-store`、event ID、`Last-Event-ID` 和错误 JSON 符合
  [API 参考](api-reference.md)。
- `MODEL_UNAVAILABLE`=503、`MEMORY_RECALL_UNAVAILABLE`=503、
  `ASSISTANT_PROTOCOL_INVALID`=502、`VL_SERVICE_DISABLED`=501。
- 受限沙箱的 `listen EPERM 127.0.0.1` 只能记为环境阻断；必须在允许 loopback 的隔离环境
  原样重跑，不能把它登记成 PASS。

### 客户端整体发布前仍需完成

- 真实 `qwen2.5:14b` 的聊天、记忆召回、失败恢复和首 token/完整回复 P50/P95。
- 8 用户 × 每人至少 10,000 条、符合时间轴的长期对话，包含多 persona/project、周期性
  纠正/遗忘/巩固、适当并发、进程重启和保留数据复核；schema 37 分层后端以
  `qa:conversation-long-timeline` 关闭该项，客户端仍需独立真机闭环。
- 超长多句回复单独测安全流式累计清洗，防止潜在 O(n²) 造成尾延迟失控。
- schema 36 AIRI/宝豆客户端的清空缓存恢复、authenticated fetch SSE、影子对账、
  去权威化回滚和桌面/手机真机。
- `LM-P1-004` 稳定偏好零候选修复和真实模型正/负例。

## 10. 当前真实验收快照

schema 37 的分层内容质量历史基线、运行目录和回执 SHA-256 见
[schema 37 分层记忆验收报告](acceptance-report-schema37-layered-memory.md)。该报告把
“分层记忆后端 P0/P1”与“真实 AIRI/宝豆客户端整体发布”分开判定；后端通过不能冒充
真机 UI 已验收。schema 31 的 627/627、旧 Dense 和 compatible HTTP v7 结果只作为
历史基线，不能替代当前代码证据。

schema 38 的任务收口、可逆精炼和 20,000 条数据库副本历史验证见
[schema 38 存储精炼验收报告](acceptance-report-schema38-storage-refinement.md)。该报告
只关闭后台重复工作和存储增长门禁，不替代 schema 39 发布验收、真实模型自然对话
质量或客户端真机验收。

v7 回执必须同时保留：0600 规范 compat audit 快照及其 hash scope/bytes/
event count，以及 schema、Node、package-lock、核心 dist 和探针文件的
`implementation` 指纹。回执和快照必须使用唯一 runId 与排他创建；QA 验收器按
attempt 校验 trace，不能假设固定九行。对会继续追加的整个 stdout 做哈希不是
可复核证据。

正式验收前先创建不提交 Git 的持久私有父目录：

```bash
mkdir -p .memory-bridge-private/acceptance
chmod 700 .memory-bridge-private/acceptance
export MEMORY_BRIDGE_ACCEPTANCE_PARENT_DIR="$PWD/.memory-bridge-private/acceptance"
npm run prepare:airi-acceptance
```

准备脚本会在该父目录下创建 mode 0700 的唯一隔离 root，并在 manifest 标记
`retention=persistent-parent`。回执与规范 compat 快照可留存；
`acceptance-secrets.json`、AIRI profile、原始 stdout、数据库和私人聊天正文不得
进入公开仓库或普通日志。未设置变量时仍使用系统临时目录，仅适合一次性开发验收。

旧 [schema 28 验收报告](acceptance-report-p0-p1.md) 只证明当时 AIRI 0.11.3、
旧 schema 和旧固定集，不得替代当前 schema 44 的发布结论。

## 11. 何时必须重验

| 变更 | 最少重验 |
|---|---|
| 文档/注释 | 文档链接、代码块和示例检查 |
| 管理台展示 | typecheck、build、相关 UI/API 测试 |
| HTTP/MCP schema | typecheck、全自动化、客户端兼容测试 |
| 身份/作用域/project | 全自动化 + 双账户/双 persona/project 真实负例 |
| 数据库迁移 | migration/rollback/integrity + 真实恢复演练；v39 还需 38→39 备份、证据保留、削弱触发器修复和污染库 fail-closed |
| embedding | Dense 回填、固定评测、alias switch/rollback |
| AIRI chat 模型或 `MEMORY_BRIDGE_AIRI_CHAT_MODEL` | models/chat JSON/SSE 兼容、真实正反例、固定集、真实 AIRI 桌面闭环 |
| rerank/extract/relation 模型或 prompt | 对应真实正反例、固定集、AIRI 闭环 |
| AIRI 主版本或身份头 | 全部真实桌面闭环 |
| tombstone/purge/backup | 删除、旧备份恢复、重启负例和数据完整性 |

## 12. 发布记录要求

每次发布应记录：

- 代码/依赖/AIRI/Node/Ollama/模型版本。
- schema version 和迁移来源。
- 所有执行命令、时间、通过/失败和环境。
- fixed fixture 版本与关键指标。
- 回执 SHA-256、规范审计快照 SHA-256 和 implementation 聚合指纹。
- 验收 root 的 retention 是 `persistent-parent` 还是 `temporary-parent`；正式发布
  只接受前者。
- 真实 AIRI profile/data 目录是否隔离。
- health、Dense、队列、日志和 Doctor 快照。
- 已知边界、跳过项和残余风险。

报告不得包含 Token、私人记忆正文或未脱敏 trace。

## 13. 文档质量门禁

文档变更至少验证：

- 所有 Markdown 非空。
- 相对链接目标存在。
- fenced code block 成对闭合。
- 无 merge conflict marker。
- 配置名、HTTP 路由、MCP 工具和 npm scripts 与源码一致。
- README 和文档中心能找到所有用户、运维、接口和技术手册。

最终发布报告应明确“运行测试通过”和“文档结构通过”是两类独立证据。

## 14. 上下文查询理解与历史重提炼固定集

固定集由 20 个实体确定性展开：

- 20 × 6 = 120 条查询：人称指代、指示项目、时间、否定、模态/频率、双先行词
  歧义。
- 20 × 5 = 100 个隔离窗口：直接事实、稳定模式、credential、诊断式推断和
  跨 scope 干扰。

先只校验 fixture，不调用模型：

```bash
npm run evaluate:context-reflection -- --validate-fixture
```

完整真实模型评测必须使用隔离数据库和去正文回执：

```bash
npm run evaluate:context-reflection -- \
  --query-model qwen2.5:14b \
  --extract-model qwen2.5:14b \
  --reflection-model qwen2.5:14b \
  --embedding-model bge-m3:latest \
  --receipt /private/tmp/context-reflection-quality-v1.json
```

也可用 `--section query` 或 `--section reflection` 分开运行。回执记录 dataset SHA、
模型、阈值、聚合指标和逐案例去正文结果，不保存历史窗口正文或模型完整输出。

查询功能/安全门槛：

- 唯一消解正确率 ≥ 92%，约束保留率 100%。
- 应澄清错误注入、跨 scope 泄漏均为 0。
- 真实查询 provider 调用覆盖率 100%；任何正则、缓存或 mock 绕过都判失败。
- 每回合模型调用 ≤ 1。
- 目标生产硬件 warm P95 ≤ 1.5 秒；完整可靠召回 P95 ≤ 2.5 秒。

历史门槛：

- 直接事实 precision ≥ 99%，正例窗口召回 ≥ 90%。
- 稳定模式窗口召回 ≥ 80%。
- inference 自动提交、无逐字证据、tombstone 复活、scope 混合、credential
  泄漏、诊断式推断、重复排队和跨版本重复均为 0。

必须分层报告：

1. 功能正确性。
2. 安全零计数。
3. 本机开发延迟基线。
4. 目标生产硬件延迟门槛。

本机结果不能直接外推到其他硬件或生产模型；目标环境必须重跑同一固定集，且不能
删除、放宽或用确定性快路覆盖强制 provider 门槛。

2026-08-11 当前代码的真实固定集结果：

- 查询：120/120 实际调用 `qwen2.5:14b`，provider 覆盖率 100%、语义正确率
  100%、约束保留 100%、错误注入 0、scope 泄漏 0、最多一次模型调用；warm
  P95 898.487 ms，查询专项 PASS。
- 历史重提炼：`/private/tmp/memory-bridge-reflection-quality-v1-schema31-final.json`，100 个
  窗口中 direct precision、direct 正例窗口召回、stable pattern 窗口召回均为
  100%，其余安全和重复副作用计数均为 0。

相关确定性回归至少包括：

```bash
npx tsx --test tests/contextual-query-understanding.test.ts
npx tsx --test tests/memory-reflection.test.ts
npx tsx --test tests/context-reflection-quality-evaluator.test.mjs
```

评测器的逐字证据检查必须按数据库内部 turn UUID 查正文，并允许跨窗口/跨版本
合并的合法 evidence；credential redaction 占位符绝不能成为候选。任何修复
评测器口径的改动都必须有单独回归，避免“修指标”掩盖真实生产缺陷。
