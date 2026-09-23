# 忆桥 Memory Bridge

一个本地优先、可审计、可由用户控制的长期记忆 MCP 服务。以 MCP 与
OpenAI 兼容接口服务 AIRI 等多种客户端；平台本身不绑定任何特定客户端。

完整安装、界面、接口、运维、技术、安全和排障文档统一从
[docs/README.md](docs/README.md) 进入。

这不是演示页面：记忆会真实写入 SQLite，MCP 工具会真实读写同一数据库，管理后台只展示实际数据。首次启动为空记忆库。

当前 P0/P1 已编码完成，可用于本机开发、MCP 和 AIRI `shadow` 集成。真实 AIRI
桌面 UI 闭环尚未在当前代码快照重跑，因此整体生产发布判定仍为 `FAIL`；不能把
“功能完成”或“兼容层通过”理解成“可直接生产放量”。发布级重排已使用
`qwen2.5:14b + bge-m3:latest` 独立验证：20/20 正确，保守 P95 为 1313.867 ms，
后续复跑 P95 为 956.240 ms。历史 schema 报告只保留为旧基线，不能当作 14B 成绩。

## 已实现

- 客户端每轮回答前自动召回、回答完成后异步提取（经 OpenAI 兼容生命周期代理），不依赖“请记住”或模型主动选择 MCP 工具。
- 同一可信 session 的代词、省略和承接问题会先生成可验证独立查询；双先行词歧义时要求澄清，不注入猜测记忆。
- schema 30/31 双 pipeline 历史重提炼：直接事实重提取与跨多轮稳定模式反思分别维护 checkpoint、冻结窗口、预算和事件链；session 增量目录与证据 scope 由数据库强制校验。
- 跨多轮推断固定进入待确认，支持修正后确认、拒绝和阻止未来等价 claim；不存在 inference 自动提交开关。
- 自然语言记住、纠正和遗忘的同步快车道；纠正保持稳定 UUID 并追加版本，遗忘先写 tombstone。
- 会话证据、候选、规范记忆、不可变版本、来源关系、事件、派生摘要和治理记录分层保存。
- 规则与 `qwen2.5:14b` 共同完成去重、强化、替代、矛盾和时空共存判断；歧义与敏感项进入待确认收件箱。
- FTS5、Dense sign-LSH/ANN、概念倒排和批量严格重排组成全库混合检索，不按最近 1000 条预截断。
- 非破坏式巩固逐句绑定来源；来源变化或遗忘后摘要自动失效并可重建。
- 用户、命名空间、作用域、Pin、TTL、归档、软删除、禁止再记、物理清除、备份和恢复。
- embedding、聊天、提取、关系、巩固和重排模型分别可配置；默认全部生成角色使用 `qwen2.5:14b`，embedding 使用 `bge-m3:latest`。
- SQLite outbox/jobs 支持租约、重试、dead letter、崩溃重放和幂等执行。
- 管理台提供候选审核、版本证据、召回解释、索引水位和系统健康状态。
- 所有写入、召回、修改、遗忘和索引切换都有审计记录。
- 每次可靠召回都有 traceId，可追溯查询改写、候选通道、融合、语义过滤、重排、选择和最终注入。
- 检索 JSONL 支持 metadata/diagnostic、脱敏、日期/大小轮换、保留清理和健康告警。
- Memory Doctor 只读检查重复、冲突、孤儿、失效摘要、超大记忆和零结果热点。
- 7 个 MCP 工具：
  - `memory_remember`
  - `memory_recall`
  - `memory_get_context`
  - `memory_update`
  - `memory_forget`
  - `memory_list`
  - `memory_stats`
- HTTP API 和 React 管理后台。
- AIRI 自动生命周期配置和真实联调验收清单。

## 环境要求

- Node.js 24 或更高版本。项目使用 Node 内置的 `node:sqlite`。
- npm。
- 已运行的 [Ollama](https://ollama.com/)，以及本机模型 `bge-m3:latest`、`qwen2.5:14b`。

## 安装与运行

```bash
npm install
npm run build
ollama pull qwen2.5:14b
ollama pull bge-m3:latest
MEMORY_BRIDGE_AUTOMATION_MODE=shadow \
MEMORY_BRIDGE_REFLECTION_MODE=shadow \
npm start
```

打开 [http://127.0.0.1:3789](http://127.0.0.1:3789)。
省略 `MEMORY_BRIDGE_AUTOMATION_MODE` 时默认进入安全的 `shadow`
模式：仍会自动提取，但只进入候选收件箱，不直接形成规范长期记忆。

开发模式：

```bash
npm run dev
```

开发管理台位于 `http://127.0.0.1:5173`，API 位于 `http://127.0.0.1:3789`。

## AIRI 接入

1. 先运行 `npm install && npm run build`，确保运行依赖和构建产物都存在。
2. 打开管理台的“AIRI 接入”页面。
3. 复制根据本机路径生成的 MCP 配置。
4. 在 AIRI 中打开“设置 → 机体模块 → MCP”，添加服务器并应用重启。
5. 把 AIRI 聊天模型设为页面给出的 `qwen2.5:14b` 和兼容 Base URL。
6. 保持忆桥 HTTP 服务运行；自动生命周期由兼容 Base URL 保证，不需要在角色卡中添加记忆关键词。
7. 按接入文档完成“自然写入 → 新会话召回 → 自然纠正 → 自然遗忘 → 完整重启”的真实联调。

详细说明见 [docs/airi-integration.md](docs/airi-integration.md)。

## 数据与隐私

- 默认数据库：`data/memory-bridge.sqlite3`。
- 默认只监听 `127.0.0.1`。
- 默认用户：`default`。
- 默认命名空间：`personal`。
- 不使用云端向量服务，召回在本机完成。
- 记忆文本会发送到本机 `127.0.0.1:11434` 的 Ollama，不会由忆桥上传到云端。
- MCP 使用本地 stdio，不需要把记忆发给中转服务器。
- AIRI 使用的 LLM 仍可能看到召回的记忆，隐私边界取决于你在 AIRI 中选择的模型服务商。

可选环境变量：

下表是常用项；全部变量、范围和生效规则见
[配置参考](docs/configuration-reference.md)。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MEMORY_BRIDGE_HOST` | `127.0.0.1` | HTTP 监听地址 |
| `MEMORY_BRIDGE_PORT` | `3789` | HTTP 端口 |
| `MEMORY_BRIDGE_DATA_DIR` | `./data` | 数据目录 |
| `MEMORY_BRIDGE_USER_ID` | `default` | 默认用户 |
| `MEMORY_BRIDGE_NAMESPACE` | `personal` | 默认命名空间 |
| `MEMORY_BRIDGE_TOKEN` | 空 | 可选 HTTP Bearer Token |
| `MEMORY_BRIDGE_SEMANTIC_MODE` | `required` | `required` 使用可靠语义召回；测试时可设为 `off` |
| `MEMORY_BRIDGE_OLLAMA_URL` | `http://127.0.0.1:11434` | 本机 Ollama 地址 |
| `MEMORY_BRIDGE_EMBED_MODEL` | `bge-m3:latest` | 语义向量模型 |
| `MEMORY_BRIDGE_RERANK_MODEL` | `qwen2.5:14b` | 批量严格相关性重排模型 |
| `MEMORY_BRIDGE_EXTRACTION_MODEL` | `qwen2.5:14b` | 自动原子事实提取模型 |
| `MEMORY_BRIDGE_RELATION_MODEL` | `qwen2.5:14b` | 去重与冲突关系模型 |
| `MEMORY_BRIDGE_EXPLICIT_INTENT_MODEL` | `qwen2.5:14b` | 自然记住、纠正、遗忘意图模型 |
| `MEMORY_BRIDGE_CONSOLIDATION_MODEL` | `qwen2.5:14b` | 非破坏式巩固模型 |
| `MEMORY_BRIDGE_REFLECTION_MODEL` | `qwen2.5:14b` | 跨多轮历史反思模型 |
| `MEMORY_BRIDGE_AUTOMATION_MODE` | `shadow` | `shadow` 仅生成候选；验收后可按 namespace 设为 `auto` |
| `MEMORY_BRIDGE_RERANK_BATCH_SIZE` | `16` | Ranker 协议批量配置；可靠检索实际 provider 批次固定不超过 16 |
| `MEMORY_BRIDGE_RERANK_CONCURRENCY` | `2` | 同一重排模型最多并行调用数；资源紧张时设为 `1` |
| `MEMORY_BRIDGE_MAX_RERANK_CANDIDATES` | `64` | 自适应 16→32→64 重排候选上限 |
| `MEMORY_BRIDGE_MAX_QUERY_VARIANTS` | `4` | 原查询加改写的最大查询变体数 |
| `MEMORY_BRIDGE_QUERY_REWRITE_MIN_CANDIDATES` | `8` | 低候选触发改写的阈值 |
| `MEMORY_BRIDGE_QUERY_REWRITE_MODE` | `llm` | `off`、`deterministic` 或 `llm` |
| `MEMORY_BRIDGE_QUERY_UNDERSTANDING_MODE` | `auto` | `off`、`auto` 或 `always` |
| `MEMORY_BRIDGE_QUERY_CONTEXT_MESSAGES` | `6` | 查询消歧最近消息上限 |
| `MEMORY_BRIDGE_QUERY_CONTEXT_TOKEN_BUDGET` | `1600` | 查询消歧输入预算 |
| `MEMORY_BRIDGE_REFLECTION_MODE` | `shadow` | `off` 或 `shadow`；无 inference auto |
| `MEMORY_BRIDGE_REFLECTION_MAX_TURNS` | `40` | 单 pipeline 窗口 turn 上限 |
| `MEMORY_BRIDGE_REFLECTION_TOKEN_BUDGET` | `8000` | 单窗口硬 token 预算 |
| `MEMORY_BRIDGE_REFLECTION_MAX_DAILY_CALLS` | `48` | 每账户/namespace 每日模型调用预算 |
| `MEMORY_BRIDGE_REFLECTION_CONCURRENCY` | `1` | 同账户/namespace 模型并发 |
| `MEMORY_BRIDGE_GRAPH_CANDIDATE_LIMIT` | `24` | 一跳关系扩散候选上限 |
| `MEMORY_BRIDGE_FEEDBACK_PRIOR_MAX` | `0.04` | 反馈排序先验绝对值上限 |
| `MEMORY_BRIDGE_RETRIEVAL_LOG_MODE` | `metadata` | `metadata` 或 `diagnostic` |
| `MEMORY_BRIDGE_RETRIEVAL_JSONL` | 开启 | 设为 `off` 关闭 JSONL |
| `MEMORY_BRIDGE_RETRIEVAL_JSONL_PATH` | 数据目录内 | 检索 JSONL 基础路径 |
| `MEMORY_BRIDGE_RETRIEVAL_LOG_MAX_BYTES` | `26214400` | 单文件大小轮换阈值 |
| `MEMORY_BRIDGE_RETRIEVAL_LOG_RETENTION_DAYS` | `14` | trace JSONL 保留天数 |

发布级 `npm run benchmark:rerank` 固定核验 `qwen2.5:14b + bge-m3:latest`，
并覆盖 128 字 ranking query、16 条候选和 640 字候选正文；它测量的是固定重排负载，
不是 AIRI 端到端延迟。当前 `rerank-v9-compact-atomic-provider` 真实门禁
20/20 正确，P50/P95/max 为 1250.596/1313.867/1316.948 ms，prompt 为 676
tokens，fallback 为 0；相同口径旧 P95 为 1627.330 ms，本轮下降 19.3%。完整质量
门禁 171/171 正确。同一门禁后续真实复跑 P50/P95/max 为
876.165/956.240/958.418 ms；质量门禁 model-route P50/P95/max 为
342.710/358.616/418.678 ms。全局 14B 迁移后的质量门禁仍为 171/171，最新
model-route P95 为 365.147 ms。较快复跑不替代前述保守基线；上述数字也只证明固定
重排门禁，不代表真实 AIRI 桌面闭环已经完成。

不要把访问令牌、API Key 或包含私人信息的备份提交到 Git。

## 验证

```bash
npm run typecheck
npm run build
npm test
npm run benchmark:scale -- \
  --receipt /private/tmp/memory-bridge-scale-schema31.json
npm run benchmark:rerank
npm run verify:reranker-quality
npm run evaluate:dense
npm run evaluate:retrieval-p1
npm run evaluate:context-reflection -- --validate-fixture
npm run soak:reliability
npm run verify:crash-recovery
```

`benchmark:rerank` 与 `evaluate:dense` 使用本机 Ollama。`soak:reliability` 默认执行 PRD 要求的 10 个并发会话、2 个 Worker、连续 30 分钟可靠性验收。真实 AIRI 桌面闭环仍需按接入文档单独执行，不能用裸 HTTP 或 MCP 客户端替代。

完整文档：[文档中心](docs/README.md)。常用入口：
[界面手册](docs/ui-guide.md)、[MCP 手册](docs/mcp-guide.md)、
[运行维护](docs/operator-guide.md)、[HTTP API](docs/api-reference.md)、
[检索日志排障](docs/retrieval-logging.md)。

## 项目结构

```text
src/server/
  memory-lifecycle.ts        回答前召回、回答后沉淀与自然意图快车道
  contextual-query-understanding.ts  有界历史、结构化消歧和安全澄清
  memory-journal.ts         会话证据、outbox 和任务账本
  memory-extractor.ts       14B 结构化原子事实提取
  candidate-resolver.ts     去重、冲突、版本和证据解析
  hybrid-retrieval.ts       FTS/Dense/概念通道与全库融合
  memory-consolidator.ts    有来源约束的非破坏式巩固
  memory-reflection.ts      双 pipeline 历史重提炼、预算、证据和 checkpoint
  memory-governance.ts      保留、归档、tombstone 和物理清除
  memory-worker.ts          租约、重试、索引和后台任务
  ollama-compat.ts           OpenAI-compatible 生命周期代理
  mcp-server.ts             兼容 MCP 工具定义
  http-server.ts            管理 API、兼容代理和静态文件

src/web/
  src/              React 管理后台

tests/              引擎、HTTP 和 MCP 集成测试
docs/               用户、接口、运维、安全、技术、测试与项目上下文文档
```

## 重要边界

MCP 工具仍用于兼容其他客户端和人工操作，但自动记忆不依赖模型主动调用工具。启用自动生命周期的客户端（如 AIRI）把聊天请求发送到忆桥提供的 OpenAI-compatible Base URL；生命周期代理会在模型回答前确定性召回，并在最终回复完成后把会话证据和提取任务写入 SQLite。该兼容代理可通过 `MEMORY_BRIDGE_COMPAT_PROXY=off` 关闭，平台核心（MCP/HTTP/记忆引擎）不依赖它。

项目仍把“代码/工具可用”和“真实客户端（如 AIRI）已验收”分开记录。只有无关键词的自然写入、跨会话自动召回、同 UUID 版本纠正、遗忘、完整进程重启和重启后负向召回全部通过，才算端到端对接完成。
