# schema 31 上下文查询与历史重提炼验收报告

> 日期：2026-08-11  
> 数据库 schema：31  
> 查询、提取、反思模型：`legacy local generation model`  
> Embedding：`bge-m3:latest`  
> 最终判定：`FAIL`（仅缺当前 schema 31 真实 AIRI 桌面 UI 闭环）

## 1. 结论

P0/P1 功能已经编码完成。schema 31 的功能、安全隔离、627 项自动化、历史重提炼
质量、百万级规模、崩溃恢复、迁移和 AIRI-compatible HTTP v7 13/13 功能探针均通过，
可用于本机开发、MCP 单独运行、AIRI 集成和 `shadow` 模式。管理台浏览器复验也已
确认服务质量、Dense、逐调用 trace、job attempt/no-op/compensation 和零控制台错误。

当前整体生产发布判定仍为 `FAIL`，只剩一项明确边界：

1. 当前 schema 31 没有重跑真实 AIRI 桌面 UI 闭环。v7 是脚本直接调用
   `/ollama-compat/v1/chat/completions` 的隔离集成探针；历史 schema 28
   AIRI 0.11.3 桌面证据不能替代当前 schema/代码/身份契约验收。

查询理解性能阻断已经关闭：provider 私有 Ollama wire 协议改用短键，收到响应后
立即恢复成原有完整内部对象，公开 Service/API 契约和后续安全校验均未改变。120 条
固定集仍在 `mode=always` 下逐例真实调用 `legacy local generation model`，warm P95 为 898.487 ms，
低于 1500 ms 门槛。

固定发布口径：

```text
FAIL / schema 31 功能、安全、规模、历史重提炼、强制 legacy local generation model 查询理解性能和
AIRI-compatible HTTP v7 13/13 探针均通过，生产 auto 路径完整可靠召回 P95 达标且
dead job 为 0；当前仅缺 schema 31 真实 AIRI 桌面 UI 闭环证据
```

## 2. PRD 范围与补充缺口

| 范围 | 状态 | 结果 |
|---|---|---|
| 上下文查询理解 | PASS | 同 session 有界历史、歧义关闭、可信确定性快路、短 wire 协议、质量补救和 trace 已实现；强制 legacy local model P95 898.487 ms |
| 通用历史重提炼基础设施 | PASS | 双 pipeline、独立 checkpoint、冻结窗口、预算、租约、取消、事件和版本回放已实现 |
| 历史直接事实重提取 | PASS | 原文逐字证据、现有 Resolver、安全门禁和跨版本去重已实现 |
| 跨多轮历史反思 | PASS | 多 turn 稳定模式只进入待确认，禁止 inference 自动提交 |
| 管理 API、界面与用户控制 | PASS | preview、运行、取消、追踪、确认、修正、拒绝和阻止未来等价 claim 已实现 |
| 多账户、多角色、多项目、多会话 | PASS | principal、namespace、role、project、session 边界由可信身份和数据库约束共同保证 |

原五项之外，本期还完成：双 pipeline 防饥饿、最差 lag、模型并发与预算账本、
session scope 增量 sweep、运行/模型调用日志、百万级查询计划、schema 31 ingest
session 归属、candidate evidence 数据库校验、迁移/备份 attestation，以及缺失
rewrite/延迟证据时 fail closed 的重启发布探针。还补齐了普通私有事实
零召回确定性弃答、grounded 回答修复、派生 provenance 防泄漏、客户端伪造
内部字段防护、requestId→traceId→九阶段链路，以及可复核审计快照/实现指纹。
第五次审查又补齐 lexical/ANN/term/fusion/graph 的精确截断计数、无效派生来源原因、
重排候选上限与提前停止区分、逐候选决策、质量补救 not-useful outcome、MCP 空结果
质量元数据，以及 SQLite/audit/JSONL 的统一递归脱敏和 AIRI correlation hash。
聊天模型也已与提取/关系/重排/巩固/反思模型解耦：
`MEMORY_BRIDGE_AIRI_CHAT_MODEL` 默认为 `legacy local generation model`，可在不迁移数据库的前提下替换。
验收证据现使用唯一 runId、排他创建、0600、文件 SHA-256 和实现指纹；QA trace
验证器支持同一 trace 的多个质量补救 attempt。准备脚本还支持
`MEMORY_BRIDGE_ACCEPTANCE_PARENT_DIR`，可把整套隔离 root 建在受控持久目录，
避免默认系统临时目录被清理。
完整可行性和 P2 边界见
[最终 PRD](prd-contextual-query-and-history-refinement-final.md)。

## 3. 最终自动化与构建

2026-08-11 在当前源码上执行：

- `npm run typecheck`：PASS。
- `npm test`：627/627 PASS，fail 0。HTTP 测试在允许临时 loopback 的验收环境执行；
  受限沙箱的 `listen EPERM` 不计为产品断言结果。
- `npm run build`：PASS，Vite 1,593 modules。
- `npm run verify:crash-recovery`：PASS。

真实 `SIGKILL` 恢复中，Job/Run 由新 Worker 接管，attempts=2，checkpoint 只推进
一次；最终 incomplete outbox/jobs、dead letter、duplicate stable key 均为 0，
SQLite integrity `ok`，FK violation 0。

## 4. schema 31 迁移与数据约束

- schema 30 的 `memory_turn_ingest_order` 原子迁移到 v31，并从可信
  turn→session 链回填 100/100 `session_id`。
- owner/namespace/session/ingest sequence 复合索引存在并用于 session 增量扫描。
- reextract/reflect generation key 直接绑定当前 `SCHEMA_VERSION`，schema 升级不会
  因旧的硬编码版本继续复用 checkpoint；两条 pipeline 均有确定性回归。
- ingest 身份不可变；turn、session 和 owner 不一致的低层写入由触发器拒绝。
- candidate evidence 在数据库层验证 personal/role/project/session 真实归属。
- 坏 evidence、伪造 session、缺索引或削弱约束均 fail closed；迁移失败完整回滚。
- schema 31 完整备份往返通过，恢复不能靠自报 `schemaVersion` 绕过身份校验。

## 5. 查询理解固定集

2026-08-11 在无其他模型评测竞争时，使用当前源码单独执行
`npm run evaluate:context-reflection -- --section query`。回执为
`/private/tmp/memory-bridge-query-quality-v3-final-source.json`，SHA-256
`1358d27a1e7f2038b1017da6ab7780bbe8a9cd6969860cc02cec88445c8d4e8c`。

| 指标 | 结果 | 门槛 | 状态 |
|---|---:|---:|---|
| 样本 | 120 | 120 | PASS |
| 真实 provider 调用 | 120/120 | 100% | PASS |
| 唯一消解语义正确率 | 100% | ≥ 92% | PASS |
| 约束保留率 | 100% | 100% | PASS |
| 错误记忆注入 | 0 | 0 | PASS |
| scope 泄漏 | 0 | 0 | PASS |
| 每例最大模型调用 | 1 | ≤ 1 | PASS |
| warm P95 | 898.487 ms | ≤ 1500 ms | PASS |

`mode=always` 保证 120/120 都真实调用 provider，providerCallCoverage=1，
maxModelCallsPerCase=1，不能用确定性快路或缓存稀释模型指标。120 个模型调用遥测
完整：prompt eval P95 91.378 ms、输出 eval P95 732.205 ms、输出 token P95 43，
120/120 均为 warm。该结果与生产 `auto` 路径 v7 的查询理解 P95 0.215 ms 仍应
分开解释，前者证明真实本地 legacy local model 慢路径已经达到 1.5 秒门槛。

## 6. 历史重提炼固定集

2026-08-11 当前源码完整重跑；查询部分曾受到并发评测污染，不用于性能结论，但
随后串行执行的 100 个真实隔离反思窗口全部通过：

- direct precision：100%。
- direct positive window recall：100%。
- stable pattern recall：100%。
- inference 自动提交、无逐字证据、tombstone 复活、scope 混合、credential 泄漏、
  诊断式推断、重复副作用和跨版本重复：全部为 0。

当前反思质量结果与 627 项自动化、v7 隔离探针共同绑定本轮源码行为。

## 7. 百万级规模

真实基准：100,000 memories、1,000,000 turns、100 sessions。

- 候选生成 P95：43.385 ms。
- 完整非 LLM 检索 P95：259.268 ms。
- Reflection 增量 preview P95：0.803 ms。
- Reflection 稳定 sweep P95：17.994 ms。
- 发现 101 个 scope；稳定态 queued=0、active Run=0。
- session 选窗命中 `memory_turn_ingest_session_idx`，没有回退成历史 turn 全表扫描。

这些结果证明增量目录与查询计划可行，不代表包含本机 legacy local model 推理的端到端延迟达标。

## 8. schema 31 隔离 AIRI-compatible HTTP 重启探针

当前权威 v7 不可变回执：
`.memory-bridge-private/acceptance/memory-bridge-airi-final-v31.nJ6Lcp/receipts/restart-persistence-probe.20260810193553514-a5c12df8.json`，
SHA-256：
`8a8dde4e24ef0adc8c7b20c2db1011c1390c95398d6d33b5b0642d77438fcd4c`。

验收使用 schema 31 持久私有隔离 root；正式 3789 服务、正式数据库和用户 AIRI
profile 均未改动。探针由 Node 脚本直接调用兼容 HTTP API，不是 AIRI 桌面 UI
自动化。浏览器只验收忆桥管理台，不替代 AIRI 桌面客户端。

结果：

- schema 31 迁移后 `PRAGMA user_version=31`，integrity `ok`，FK 0。
- 13/13 功能检查 PASS，trace coverage 13/13；包含 grounded/abstain/clarify/
  passthrough、双账户/双向隔离、project、hard negative 和 provenance 防泄漏。
- query-understanding P50/P95：0.022/0.215 ms；该 13 条生产 `auto` 子集主要走确定性
  快路；120 条强制 provider 固定集已单独达到 898.487 ms。
- retrieval-trace P50/P95：421.861/1352.606 ms。
- 完整可靠召回 P50：421.897 ms；P95：1352.802 ms，门槛 2500 ms，PASS。
- requestId、响应 traceId、forced/proxy audit 和 SQLite traceId 全部一致；
  13/13 都持有顺序完整的九阶段 trace。
- compat 规范审计快照为 61 个本轮隔离事件、16483 bytes、非法行 0，SHA-256：
  `0254b986eed75f0d95d61ba9a70706553acce99ebdcd2ee9be8c96a04e65122d`。
- 回执 `implementation` 绑定 schema 31、Node v26.4.0、package-lock、35 个完整
  `dist/server` runtime 文件和探针文件；聚合指纹为
  `e203caecc1a8f90ceef7d2745af3d36f5fc8d2e0f7003b44491a872962b53548`。
- 回执与 compat 快照均为 0600，runId 文件名通过 `wx` 排他创建，已有文件不可覆盖。
- open outbox：0。
- unhealthy/dead jobs：0；浏览器管理台也显示死信 0、索引积压 0。
- 最终 Web 构建后在隔离端口 3791 复验：未登录 footer 正确显示当前 host，登录后
  服务质量“完整”、Dense PASS，浏览器 console warning/error 0。临时管理台凭据
  已撤销并实测不能再次登录，隔离服务随后安全停止。
- 停服后的只读最终快照：integrity `ok`、FK 0、open outbox 0、
  running/failed/retrying/dead/quarantined jobs 0、dead-letter rows 0；8 个 pending
  均为未来运行的周期任务，不属于不健康任务。
- 当前 Dense component gate 使用真实 `bge-m3:latest`，Recall@20 100%、MRR@10
  93.5%；不调用 reranker，报告 SHA 与不可变固定集契约强绑定。

旧 v6 及更早回执只保留为历史证据，不用于当前结论。v7 root 位于不提交 Git 的
持久私有目录；公开发布只能引用脱敏指标和 SHA，禁止归档或提交 secrets、原始
stdout、隔离数据库、AIRI profile 或私人聊天正文。

## 9. 使用与发布边界

允许：

- 本机开发、MCP 单独运行和 AIRI 集成。
- 历史重提炼 `shadow` 运行、preview 和人工确认。
- 使用 SQLite trace、JSONL、Run 事件、模型调用账本和 dead letter 排障。

暂不允许：

- 把本机 `legacy local generation model` 的 898.487 ms 与生产 auto 完整可靠召回 1352.802 ms
  外推到其他硬件和模型；目标环境仍需重验。
- 未在目标硬件/生产模型重验就放量。
- 自动提交 `assistant_inference`。
- 放宽阈值、伪造固定集报告或把 HTTP/管理台验收冒充 AIRI 桌面验收。

更换模型、Prompt、AIRI 主版本、身份头或 schema 后，必须按
[测试与发布](testing-and-release.md)重新验收。

## 10. 安全说明

- 探针仅在本机运行时读取 `acceptance-secrets.json` 的凭据；操作输出、快照和报告未展示、
  输出或提交 Token。
- 报告不包含私人聊天全文、credential secret 或未脱敏 trace。
- schema 28/30 报告只保留为历史快照，不替代本报告。
