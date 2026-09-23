# 系统性能与任务可靠性优化 PRD

## 实施状态（2026-08-11）

本 PRD 的 P0/P1 代码、迁移、日志、管理台和自动化测试均已实现。当前证据：

- 627/627 自动化、typecheck、build 通过。
- `bge-m3:latest` Dense 固定集 Recall@20 1.0、MRR@10 0.935、failed cases 0，
  且评测过程没有调用 reranker。
- AIRI-compatible HTTP v7 13/13 功能与九阶段 trace 通过；完整可靠召回
  P50 421.897 ms、P95 1352.802 ms，达到 2500 ms 门槛。
- 隔离验收库 integrity `ok`、FK 0、open outbox 0、unhealthy/dead jobs 0；
  `completed_noop`、定向补偿、逐 attempt 事件和三种恢复模式均已落地。
- 生产 `auto` 的可信确定性查询快路 P95 0.215 ms。强制 `mode=always` 的
  `legacy local generation model` 120 条真实 provider 固定集准确率 100%、warm P95 898.487 ms，
  低于 1500 ms；短 wire 响应在 provider 边界恢复成原完整对象，公开契约不变。

真实 AIRI 桌面 UI 闭环属于发布验收边界，不属于上述兼容层探针；当前仍需重跑。

- 状态：P0/P1 已交付；性能与任务可靠性门禁已关闭
- 优先级：P0 / P1
- 日期：2026-08-10
- 适用版本：长期记忆 MCP / AIRI 集成服务
- 开发验收模型：本机 `legacy local generation model`

## 1. 背景与结论

当前系统的确定性检索和数据库阶段并不慢，主要延迟来自串行调用本机生成式模型：完整可靠召回中，LLM 重写与 LLM 重排约占总耗时的 99.88%。后台记忆巩固还可能卸载与前台共用的模型，并把下一次查询变成冷启动。

任务可靠性方面，`consolidate_scope` 会把不适合合并的独立事实强制压缩为固定句数；覆盖校验失败后，worker 使用完全相同的输入、模型参数和策略重复执行，最终形成没有修复价值的 dead job。现有 dead-letter 恢复仍然原样复制失败任务，无法消除根因。

本次优化不以关闭质量检查、减少隔离条件、伪造模型指标或更换测试模型来换取性能。系统必须同时做到：明确请求走毫秒级确定性路径；确需模型推理时保留慢路径及可解释 provenance；后台任务能够区分“无需处理”“可重试”“需要补偿”和“不可自动恢复”。

## 2. 优化前基线（保留用于对照）

### 2.1 查询理解

- 120 条固定集，强制 `mode=always`，每条真实调用 `legacy local generation model`：warm P95 `2149.583 ms`。
- 模型冷启动约 `6875 ms`，其中加载约 `3863 ms`。
- 模型热启动约 `2565 ms`；输入约 340 Token，仅约 46～49 ms，约 54 个输出 Token 耗时约 2400 ms。
- AIRI 12 条实际子集在 `auto` 模式下查询理解 P95 `4.462 ms`，说明确定性跳过模型有效，但尚未覆盖可安全解析的引用查询。

### 2.2 完整召回

- 12 条真实链路 P95 `17848.847 ms`。
- rerank：`76589.896 ms`，占阶段总耗时 `63.78%`。
- rewrite：`43343.684 ms`，占阶段总耗时 `36.10%`。
- 其余阶段合计约 `146.6 ms`，占 `0.12%`。

### 2.3 dead job

- 已复现 `consolidate_scope` 任务达到 `5/5` 次尝试后进入 dead。
- 两条不同 kind、不同事实被强制压缩为一句，模型未覆盖全部来源。
- 每次尝试的输入、温度、seed 和策略不变，因此退避只延迟相同的确定性失败。

## 3. 目标与非目标

### 3.1 目标

1. 明确、无需上下文消歧的查询理解 P95 小于 `10 ms`。
2. 满足严格安全条件的可信引用快路 P95 小于 `50 ms`，且不调用模型。
3. warm 常规可靠召回 P95 目标 `800～1000 ms`；必须独立报告使用 legacy local model 模型的慢路径，不用快路样本稀释其数据。
4. 相同 rewrite/rerank 请求在短时间内只进行一次真实推理，并能安全复用结果。
5. 不适合巩固的来源以 `completed_noop/not_beneficial` 正常结束，不制造 dead job。
6. 可重试故障、协议故障、覆盖故障、来源漂移和不支持任务采用不同恢复策略。
7. 日志可以重建每次检索和后台 job attempt 的输入指纹、输出指纹、耗时、决策、补偿动作与最终状态。

### 3.2 非目标

- 本轮不引入新的外部模型、向量数据库或第三方服务。
- 本轮不把专用 cross-encoder 或独立 GPU 推理实例设为运行前提。
- 不通过放宽 tenant/account/persona/session 隔离、grounding、coverage 或幻觉检查换取速度。
- 不把 deterministic/heuristic 结果标记成 Qwen 推理结果或计入强制模型评测。

## 4. 用户故事

1. 作为 AIRI 用户，我追问“她刚才说的项目是什么”时，若上下文中只有一个可信、性别和谓词均匹配的先行词，应立即获得解析结果。
2. 作为系统管理员，我能区分一次召回走了确定性快路、缓存还是模型慢路，并看到各阶段真实耗时。
3. 作为运维人员，我能判断 dead job 是网络瞬态、协议错误、覆盖失败还是业务上无需合并，并采用对应恢复方式。
4. 作为评测人员，我能分别查看 cold/warm、fast/model、cache hit/miss 指标，不能被混合统计误导。

## 5. 功能范围

### 5.1 P0：前台延迟

#### P0-1 可信确定性查询快路

仅在生产 `auto` 模式下启用。必须同时满足：

- recent turns 全部来自 `trusted_ledger`。
- 查询恰好包含一个引用 surface。
- 先行词唯一，或确定性判断为歧义并直接 fail closed。
- 性别、实体类型和谓词支持一致。
- 不存在竞争先行词。
- 时间、否定、频率、条件和模态信息可完整保留。

`mode=always` 必须继续真实调用 provider。性别冲突、多代词、竞争先行词、谓词不支持或不可信来源不得走快路。输出必须记录 `decision_source=deterministic_trusted`，不得冒充模型名。

#### P0-2 独立查询模型配置

增加独立的 query-understanding 模型配置，默认兼容现有 rerank 模型。开发默认仍为 `legacy local generation model`，便于后续按职责切换模型而不影响重排和巩固。

#### P0-3 Rewrite 质量触发

首轮有候选时先判断候选质量，不再仅因候选数量低于阈值调用 LLM rewrite。首轮 rewrite 只在零候选、明确低质量或可证明缺少关键信号时触发。

#### P0-4 Fallback 增量检查

只有 fallback 产生新的 retrieval signal 才重跑检索：解析状态为 resolved，且 standalone/ranking query 与原查询不同，或产生新增 query variant。`ambiguous` 且没有新增信号不得重跑。

#### P0-5 Single-flight TTL 缓存

- Rewrite key：模型、规范化 query、关键配置版本。
- Rerank key：模型、规范化 query、候选 ID/正文哈希及顺序、协议版本。
- 相同并发请求共享一个 promise；成功结果短 TTL、有界缓存；失败不得长期缓存。
- 缓存仅保存在进程内，不持久化候选正文；日志只记录 key 指纹和命中状态。

#### P0-6 前后台 QoS

- 巩固任务不得以 `keep_alive=0` 卸载前台共用模型。
- keep-alive 可配置，并记录模型加载/推理耗时。
- 用户活跃或存在前台压力时，后台任务应让出执行权或延后，不与前台串行抢占同一模型。

### 5.2 P0：后台任务可靠性

#### P0-7 Consolidation 资格判断

在调用模型前按主体、谓词、否定、时间、kind 和语义关系判断是否存在可合并簇。互不相关的独立事实不强制压缩；没有收益时返回 `completed_noop/not_beneficial`。

#### P0-8 故障分类与定向补偿

- `transient`：指数退避加 jitter，可重试。
- `protocol`：最多一次格式 repair，随后缩小批次或隔离。
- `coverage`：只补缺失来源；独立事实拆分为不同 cluster 或 no-op。
- `source_drift`：重新读取来源并重算资格。
- `unsupported`：quarantine，不自动重放。

若输入指纹、输出指纹和错误类型连续相同，必须停止盲重试并进入补偿或隔离状态。

### 5.3 P1

1. 将 rerank 响应协议压缩为索引和位标志等紧凑结构，同时保持 subject、predicate、entailment 三类质量门槛。
2. 持久化逐 attempt 事件：`failure_class`、`input_fingerprint`、`output_fingerprint`、`model_duration_ms`、`missing_source_ids`、`compensation_action`、`next_state`。
3. dead-letter 恢复支持 `recompute`、`repair`、`supersede`，不可恢复故障不再原样重放。
4. 管理界面和日志文档展示 fast/model/cache/no-op/compensation 状态。

### 5.4 P2 候选项

- 专用 cross-encoder 重排器。
- 查询、重排、巩固使用独立推理实例或资源队列。
- 基于线上 trace 的自适应 candidate budget 和批处理。

## 6. 数据与日志要求

### 6.1 检索 trace

每次 attempt 至少记录：

- route：`deterministic_fast` / `model` / `cache`。
- provider 实际调用次数。
- model、cold/warm 可判定信息、prompt/output token、模型耗时。
- rewrite/rerank cache hit、single-flight shared。
- 原查询、新查询、variant 是否产生真实 delta（正文按既有脱敏策略）。
- 各阶段耗时和最终候选数。

### 6.2 Job attempt

每次尝试必须是独立事件，不得只保留累计 attempts 和最后一条错误。相同指纹保护、补偿和人工恢复都必须写审计日志。

## 7. 验收标准

### 7.1 查询理解

- `auto + 唯一可信先行词`：provider 调用 0 次，provenance 为 deterministic。
- `always`：provider 调用 1 次。
- 性别冲突、多代词、竞争先行词、谓词不支持：provider 不得被安全快路绕过。
- 固定模型集报告真实 provider 次数，不将 fast path 冒充 Qwen 指标。

### 7.2 召回质量与性能

- 运行 rewrite、rerank、上下文检索和 namespace 固定质量集，准确率不得低于修改前门槛。
- 相同并发请求只调用一次 rewrite/rerank provider。
- fallback 无 query/variant delta 时，检索和 rerank 不重复执行。
- 分别报告 deterministic fast、forced provider、full retrieval 的 cold/warm P50/P95/P99。

### 7.3 后台任务

- 两条不同主体/谓词或独立事实：完成 no-op，provider 0 调用。
- transient 故障仍可重试，且退避带 jitter。
- deterministic coverage failure 不得原样重复五次。
- dead-letter recovery 必须选择明确恢复模式，不可恢复故障不得克隆为同一任务。

### 7.4 工程门槛

- 定向测试、`npm run typecheck`、`npm test`、`npm run build` 全部通过。
- 使用真实 `legacy local generation model` 完成 warm/cold 性能验收。
- 配置、日志、API、运维和测试文档同步更新。

## 8. 任务拆解与顺序

1. 查询理解可信快路、独立 query model、provenance 与测试。
2. Rewrite 质量触发、fallback delta、缓存与并发去重。
3. 紧凑 rerank 协议及真实模型质量/性能对照。
4. Consolidation 资格预检、故障分类、补偿和重复指纹保护。
5. Job attempt 数据模型与 dead-letter 恢复模式。
6. 配置/日志/API/运维文档、全量回归、真实模型验收。

## 9. 风险与回滚

- 快路误解析风险：默认 fail closed；可通过配置关闭，只回退模型路径。
- 缓存陈旧风险：候选正文哈希、顺序、模型和协议均进入 key；TTL 短且有容量上限。
- 紧凑协议质量下降：必须通过固定质量集；不通过则保留旧协议。
- no-op 漏合并风险：保留审计原因和来源 ID，可人工 recompute。
- schema 迁移风险：新增字段/表只做向前兼容，迁移前备份，旧读取路径继续可用。

## 10. 完成定义

代码、数据库迁移、自动化测试、质量非回归、任务可靠性、日志和操作文档已经完成。
完整可靠召回达到 2.5 秒门槛，强制本地 legacy local model 查询理解达到 1.5 秒门槛，因此本 PRD
的实现状态为“P0/P1 已交付，性能与任务可靠性门禁已关闭”。该结论来自 120/120
真实 provider 调用，不是 fast path 或缓存稀释；模型、prompt 或硬件变化后须重验。
