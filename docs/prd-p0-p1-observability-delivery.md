# AIRI 长期记忆 P0/P1 与可观测性交付 PRD

> **历史快照：** 本文记录 2026-08-09 的 schema 28 P0/P1 交付基线，不代表
> schema 31 当前生产发布结论。当前范围和证据请查看
> [最终 PRD](prd-contextual-query-and-history-refinement-final.md)与
> [schema 31 验收报告](acceptance-report-schema31-context-reflection.md)。

> 产品：忆桥 Memory Bridge  
> 文档版本：1.1  
> 日期：2026-08-09  
> 基线：`docs/prd-airi-memory-system.md` v2.3  
> 开发验收模型：`legacy local generation model`；Embedding：`bge-m3:latest`

## 1. 交付结论

本轮不是新做一套记忆系统，而是在现有长期记忆内核上完成发布阻塞修复、检索质量闭环和可追溯诊断能力。最终交付必须同时满足：

1. AIRI 多账户、多 persona、多 session、多 project 与 fork 生命周期不串号、不死锁、不产生多写者。
2. 低召回时自动重写查询、扩展别名、执行多查询并按需扩大候选，而不是直接返回空结果。
3. 每次召回都有稳定 `traceId`，可重建“原查询 → 查询变体 → 各通道候选 → 融合 → 过滤 → 重排 → MMR → 最终注入”的全过程。
4. 用户反馈不只计数，还能以有界、可解释方式影响排序，并沉淀为可复现难例。
5. 关系边能够参与受权限约束的一跳扩散；不得借关系边绕过 principal、namespace、scope、敏感级别或 tombstone。
6. AIRI 注入的记忆必须携带 memory/version/evidence 来源；召回不可用或证据不足时不得把“未找到”表述成“用户没有”。
7. 管理员能运行记忆健康检查，发现重复、冲突、孤儿证据、失效派生摘要、超大记忆和检索热点。
8. MCP、HTTP、运行、日志分析和 AIRI 接入都有可执行文档。

## 2. 范围

### 2.1 P0 发布阻塞

- P0-01：修复 AIRI 账户切换期间延迟索引读取导致新账户未完成 hydrate 的回归。
- P0-02：生命周期 lease 贯穿 fork、create、finalize、publish、discard，禁止持锁后再次进入同一持久化队列。
- P0-03：所有聊天写入只经 authority/command bridge；Markdown Stress 等开发入口不得直接调用 orchestrator 写入。
- P0-04：增加跨 renderer Web Locks、账户切换、fork 崩溃恢复和 writer 失效故障注入。
- P0-05：真实 AIRI 完成双账户、双 persona、双 project、跨聊天召回、纠正、遗忘、fork、退出重启闭环。

### 2.2 P1 记忆质量

- P1-01：低召回控制器。
  - 规范化与实体/概念别名扩展。
  - 确定性 query rewrite。
  - 可选的 `legacy local generation model` 结构化 query rewrite。
  - multi-query 并行候选生成。
  - 候选不足时按 16 → 32 → 64 自适应扩大重排池，上限受配置和延迟预算约束。
- P1-02：反馈闭环。
  - 保留 retrieved/used/confirmed/rejected 原始事件。
  - 排序只使用有界反馈先验，任何反馈都不得绕过相关性门槛。
  - rejected 召回沉淀为难例；confirmed/used 沉淀为正例。
  - 支持导出难例并运行离线回归评测。
- P1-03：关系增强。
  - 基于已命中的同账户、同可见范围记忆做一跳扩散。
  - 图候选作为第四检索通道参与 RRF；必须再次执行完整 SQL 权限过滤。
  - 默认不做多跳，防止延迟、噪声和权限面扩大。
- P1-04：回答 grounding 与 abstention。
  - 注入 memory ID、version ID、evidence 摘要和召回质量状态。
  - 记录本轮实际注入来源与回答关联日志。
  - unavailable/degraded/zero-result 采用明确的非断言文案。
  - 不对模型的一般知识回答做无意义强制引用；只约束来自长期记忆的用户事实。
- P1-05：Memory Doctor。
  - 重复稳定键/规范值。
  - 活跃冲突和未解决候选。
  - 孤儿版本/证据/边。
  - stale/quarantined 派生摘要。
  - 超过 token 阈值的单条记忆和高频未命中查询。
  - 每项输出数量、样本 ID、严重级别和建议动作，不自动破坏数据。
- P1-06：重排器可替换与评测。
  - 保持现有批量生成式重排器。
  - 固化 provider 接口和 trace 字段，允许以后接专用 cross-encoder。
  - 基线比较 Recall@K、MRR、nDCG、零结果率、P95 和每次请求模型调用数。
- P1-07：真实评测覆盖。
  - 否定、时间变化、同义改写、指代、跨 scope、干扰事实、跨语言。
  - 真实用户表达不得只使用“请记住”“长期记住”等关键词。
  - 固定小数据集只作为回归哨兵，不作为线上成功率宣传。

### 2.3 可观测性与日志

每次召回生成 UUID `traceId`，结构化日志至少包含：

| 阶段 | 必需字段 |
|---|---|
| request | traceId、principal、namespace、scope 摘要、queryHash、可选诊断 query、时间 |
| rewrite | rewrite 类型、query 变体、耗时、模型/提示版本 |
| channels | lexical/dense/term/graph 候选数量、候选 ID/名次、耗时 |
| fusion | RRF 分数、去重数量、权限过滤数量 |
| semantic | embedding generation、相似度门槛、候选上限、耗时 |
| rerank | 模型、批次数、每个候选 relevant/confidence、耗时 |
| selection | scope 遮蔽、摘要覆盖、反馈先验、MMR 惩罚、最终 ID |
| context | token 预算、实际 token、注入 memory/version/evidence |
| result | full/degraded/unavailable、总耗时、错误代码 |

日志要求：

- 默认写入本地数据库审计链；支持 JSONL 运维日志。
- 默认不把凭据、令牌或 credential memory 写入日志。
- `metadata` 模式记录 query hash 和候选 ID；`diagnostic` 模式才记录查询文本，并明确提示可能含个人信息。
- 支持按 traceId、时间、用户、namespace、结果 ID、质量状态查询。
- JSONL 单文件有大小/日期轮换与保留天数；写日志失败不得破坏记忆真相事务，但必须在健康状态中暴露。
- 日志中的 principal 对普通非管理员接口不可跨账户查看。

## 3. 非目标

- 本轮不建设互联网 SaaS、计费、organization/team 跨账户共享 ACL。
- 本轮不引入 Neo4j 等新数据库；关系增强限定 SQLite 一跳扩散。
- 本轮不把所有聊天原文都升级为长期规范事实。
- 本轮不承诺消除通用大模型全部幻觉，只保证长期记忆来源可追溯、召回不确定性可披露。
- 本轮不以更大的模型替代 `legacy local generation model` 掩盖逻辑问题。

## 4. 可行性

| 任务 | 可行性 | 依据 | 主要风险 | 控制方式 |
|---|---|---|---|---|
| AIRI 账户切换 | 高 | 已有确定性失败测试 | watcher/epoch 时序 | 最小修复并保留回归测试 |
| fork lease | 高 | 已有 Web Locks 与 lease 雏形 | 嵌套队列自锁 | 显式传 lease，持锁路径禁止二次排队 |
| 单 authority | 高 | 已有 command bridge | 开发入口遗漏 | 代码搜索 + contract 测试 |
| multi-query | 高 | 三路候选与 RRF 已存在 | 候选/模型调用膨胀 | 限定变体数量与自适应停止条件 |
| 反馈排序 | 高 | 已有四类计数和事件 | 恶意反馈污染 | 有界先验，不绕过语义门槛 |
| 图扩散 | 中高 | 已有 edges/relations | 权限泄漏、噪声 | 一跳、SQL 前置过滤、低权重通道 |
| grounding | 中高 | 已有版本/evidence 注入 | 模型不遵循提示 | 质量披露、来源日志、确定性 fallback |
| Memory Doctor | 高 | 所需表和状态已存在 | 大库扫描开销 | 索引 SQL、采样、显式运行 |
| 结构化日志 | 高 | 已有 audit_log/召回解释 | PII、磁盘增长 | 分级日志、脱敏、轮换、保留策略 |
| 真实 AIRI 验收 | 中 | 依赖桌面、Ollama、双 profile | UI/锁屏/本机资源 | 隔离 profile、固定模型、可恢复脚本 |

## 5. 任务拆解与依赖

```text
PRD/契约
  ├─ P0 AIRI 一致性
  │    ├─ 账户切换
  │    ├─ lifecycle lease
  │    └─ 单 authority + 故障注入
  ├─ 召回 trace 基础
  │    ├─ traceId/事件模型
  │    ├─ 查询/API
  │    └─ JSONL/保留
  ├─ P1 低召回控制器
  │    ├─ rewrite/alias/multi-query
  │    └─ 自适应候选 + 图通道
  ├─ P1 质量闭环
  │    ├─ feedback prior/难例
  │    ├─ grounding/abstention
  │    └─ Memory Doctor
  └─ 文档与验收
       ├─ MCP/HTTP/运维/日志
       ├─ 固定与真实评测
       └─ AIRI 双账户最终闭环
```

依赖规则：

1. P0 账户/lease/authority 先于真实桌面验收。
2. trace 基础先于 multi-query 和反馈排序，确保新逻辑从第一天可诊断。
3. 图扩散依赖 trace 与权限过滤测试。
4. 文档随稳定接口同步，最终在接口冻结后校验示例。

## 6. 接口交付

### 6.1 MCP

保留七个现有工具：

- `memory_remember`
- `memory_recall`
- `memory_get_context`
- `memory_update`
- `memory_forget`
- `memory_list`
- `memory_stats`

兼容原则：不删除字段，不改变已有成功结果的核心类型。新增诊断字段应可选；stdio 连接仍固定绑定一个 principal。

### 6.2 HTTP

需要补充或固化：

- 召回 trace 列表与详情。
- 按 trace 导出诊断包。
- Memory Doctor 运行与结果。
- feedback 事件与难例导出。
- 日志配置、保留和健康状态。

所有接口继续使用可信 Token 解析 principal，拒绝请求体身份覆盖。

## 7. 验收标准

### AC-P0

- AIRI 账户 A 的延迟读写在切换到 B 后不能覆盖、清空或阻塞 B 的索引。
- fork 持锁路径在 5 秒测试预算内完成；不得出现持锁后等待自身队列。
- 两个 renderer 同时 fork 时最多一个写者进入临界区，失败者可恢复且无半成品会话。
- Markdown Stress 和其他开发入口不能绕过 authority。
- 真实 AIRI 双账户/双 persona/双 project/fork/重启闭环明确 PASS。

### AC-P1-Retrieval

- 原查询零候选时至少执行一次确定性 rewrite；满足停止条件后才允许返回零结果。
- 查询变体不得超过配置上限，重复变体必须去重。
- 低召回测试集中 Recall@20 不低于旧基线，零结果率下降且错误召回不超过门槛。
- 图扩散候选不能跨 principal/namespace/scope/sensitivity。
- rejected 反馈不能使无关记忆跨越相关性门槛；confirmed/used 只能做有界同分排序增强。

### AC-Observability

- 每次 reliable recall 都能用一个 traceId 查到完整阶段链。
- trace 中最终结果与实际注入 memory/version 一致。
- 模型失败、零候选、候选上限、权限过滤、重排拒绝均有明确原因。
- metadata 日志不含原查询正文和凭据；diagnostic 模式有明确开关。
- 日志故障在 health 中可见，但不会回滚已经提交的记忆真相事务。

### AC-Doctor

- 人工构造重复、冲突、孤儿、stale 摘要和超大记忆时均能发现。
- 默认只报告，不自动删除或改写。
- 每个问题至少给出一个可定位 ID 和建议动作。

### AC-Documentation

- 新环境只按 MCP 文档即可启动并列出七个工具。
- 操作手册覆盖安装、启动、AIRI 配置、账户、备份、恢复、升级、日志和常见故障。
- 接口文档包含请求、响应、认证、错误码、幂等、分页、作用域和示例。
- 日志排障文档可从一次“不满意召回”定位到具体通道、过滤原因和重排决策。

## 8. 验证命令

- 忆桥：`npm run typecheck`、`npm test`、`npm run build`
- 规模与检索：`npm run benchmark:scale`、`npm run benchmark:rerank`、`npm run evaluate:dense`
- AIRI：stage-ui session-store/command-bridge/browser contract 定向测试、相关 package typecheck/build
- 最终：隔离数据库完整性、FK、空正式库、真实 AIRI 桌面验收和独立复审

## 9. 交付文档清单

- `docs/README.md`：统一文档中心与按角色阅读路径。
- `docs/quick-start.md`、`docs/ui-guide.md`：首次使用和管理台逐页说明。
- `docs/mcp-guide.md`：MCP 安装、身份绑定、七工具说明与客户端示例。
- `docs/operator-guide.md`：运行、AIRI 接入、账户、备份恢复、升级和日常维护。
- `docs/api-reference.md`：HTTP 接口、认证、schema、错误码和 curl 示例。
- `docs/configuration-reference.md`：全部运行时配置、范围和生效方式。
- `docs/retrieval-logging.md`：trace 字段、查询方法、诊断流程、隐私和保留策略。
- `docs/logging-guide.md`、`docs/troubleshooting.md`：全日志入口和故障处理。
- `docs/technical-reference.md`、`docs/data-model.md`：技术实现和 schema 数据模型。
- `docs/security-and-privacy.md`：身份、隔离、敏感数据和威胁边界。
- `docs/deployment-and-upgrade.md`、`docs/backup-and-restore.md`：上线与恢复流程。
- `docs/testing-and-release.md`、`docs/developer-guide.md`：质量门禁和维护约束。
- `docs/acceptance-report-p0-p1.md`：最终自动化和真实 AIRI 验收证据。

## 10. 发布判定

最终判定：`PASS`。AC-P0、AC-P1、AC-Observability、AC-Doctor 和文档验收
均已完成；P0-05 已在 AIRI 0.11.3 隔离桌面 profile 中执行双账户、双 persona、
双 project、无 project、可见 fork、纠正、遗忘与重启闭环。最终证据见
`docs/acceptance-report-p0-p1.md`。

| 交付组 | 状态 | 最终证据 |
|---|---|---|
| P0 AIRI 一致性 | PASS | Alice/Bob 隔离、project 继承、跨会话召回、纠正/遗忘/重启 |
| P1 检索质量 | PASS | rewrite、混合检索、严格重排、图扩散、反馈、grounding、abstention |
| 可观测性 | PASS | 九阶段 SQLite/JSONL trace、日志健康、反馈难例和诊断导出 |
| 数据治理 | PASS | 稳定 UUID/版本、tombstone、保留/巩固唯一任务链、备份恢复 |
| 文档 | PASS | 用户、界面、MCP/API、运维、日志、技术、数据、安全、测试和验收文档中心 |

发布结论只适用于本报告锁定的代码、schema 28 和开发验收模型组合。固定评测
PASS 仍不等于线上成功率 100%；更换模型、embedding generation、AIRI 主版本
或身份边界后，必须重新执行对应质量门禁和真实桌面验收。
