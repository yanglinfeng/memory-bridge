# 开发与维护指南

本文面向需要修改忆桥代码的开发者。首要原则是保持身份隔离、真相事务、版本
证据和可靠召回的既有边界；不要为了减少代码量把这些安全层合并掉。

## 1. 本地开发

```bash
cd ~/memory-bridge
npm install
npm run dev
```

- 管理台开发地址：`http://127.0.0.1:5173`。
- API：`http://127.0.0.1:3789`。
- Node.js 必须为 24+。
- 需要真实语义行为时启动 Ollama，并准备 `qwen2.5:14b`、`bge-m3:latest`。

开发测试应使用隔离的 `MEMORY_BRIDGE_DATA_DIR`，不要把 fixture、benchmark 或
破坏性测试写入正式记忆库。

## 2. 代码地图

### 服务端入口

| 文件 | 所有权 |
|---|---|
| `src/server/index.ts` | 依赖装配、启动、Worker、安全关闭 |
| `src/server/config.ts` | 环境变量、默认值和安全范围 |
| `src/server/database.ts` | schema 37、迁移、备份与 attestation |
| `src/server/http-server.ts` | HTTP API、静态文件、身份边界 |
| `src/server/mcp-server.ts` | 七个 MCP 工具协议 |
| `src/server/mcp-stdio.ts` | MCP principal 固定与 stdio transport |

### 记忆引擎

| 文件 | 所有权 |
|---|---|
| `airi-memory-lifecycle.ts` | 回答前召回、回答后入账、自然意图快车道 |
| `airi-ollama-compat.ts` | AIRI OpenAI/Ollama 兼容代理 |
| `contextual-query-understanding.ts` | 有界历史、结构化消歧、single-flight 和安全澄清 |
| `memory-journal.ts` | 版本、证据、事件、tombstone |
| `lifecycle-store.ts` | session/turn/outbox/job/dead letter |
| `memory-extractor.ts` | 原子 claim 提取 |
| `episodic-memory-service.ts` | 完整 exchange 的无模型 L1 情景物化与来源绑定 |
| `pattern-observation-store.ts` | 跨窗口弱信号、反证和 3–5 条独立证据累计 |
| `hierarchical-summary-service.ts` | session/day/week L4 摘要和逐句来源 |
| `memory-layering.ts` | fact/episode/summary 标签与召回配额 |
| `explicit-memory-intent.ts` | 自然 remember/correct/forget |
| `candidate-resolver.ts` | 候选关系、冲突和版本解析 |
| `claim-relation-classifier.ts` | LLM 五路关系判断 |
| `memory-store.ts` | 当前投影、规范写入、召回、备份恢复 |
| `hybrid-retrieval.ts` | FTS/ANN/term/graph 与 Dense generation |
| `semantic-ranker.ts` | embedding、批量严格重排 |
| `memory-consolidator.ts` | 来源约束的派生摘要 |
| `memory-reflection.ts` | 双 pipeline 窗口、run、预算、证据、claim 和 checkpoint |
| `memory-governance.ts` | Pin、TTL、归档、反馈、tombstone、purge |
| `memory-worker.ts` | Worker job dispatch、租约、重试 |
| `retrieval-observability.ts` | 九阶段 trace、JSONL、健康 |

### 管理台

| 文件 | 页面/责任 |
|---|---|
| `src/web/src/App.tsx` | 页面导航、全局鉴权与状态 |
| `components/MemoryLibrary.tsx` | 列表、筛选、导入导出 |
| `components/MemoryInspector.tsx` | 版本、证据、治理和物理清除 |
| `components/CandidateInbox.tsx` | 候选与自然动作审核 |
| `components/RecallLab.tsx` | 可靠召回结果解释 |
| `components/ReflectionCenter.tsx` | 历史重提炼预览、运行、事件和模型调用账本 |
| `components/SystemStatus.tsx` | 水位、队列、Dense、tombstone、purge |
| `components/AuditLog.tsx` | 业务审计 |
| `components/AiriSetup.tsx` | AIRI/MCP 配置生成 |
| `components/AccountPage.tsx` | 账户、凭据、persona、组合召回 |
| `components/SettingsPage.tsx` | 配置展示、备份和保留策略 |
| `src/web/src/api.ts` | Bearer 内存状态和 API client |

## 3. 不可破坏的架构约束

1. principal 只能来自可信凭据或启动配置。
2. persona/session/project 不能来自自然语言、模型输出或普通 body 字段。
3. session 绑定建立后不可变；project 切换必须新 session，fork 只能继承。
4. 规范记忆保持稳定 UUID；纠正追加版本，不覆盖历史。
5. evidence 和派生摘要分离；无来源摘要不能成为真相。
6. 遗忘先 tombstone 并立即停止召回；purge 是后续显式任务。
7. 真相写入、outbox、审计和必要索引更新保持事务边界。
8. `required` 语义失败必须显式 unavailable/degraded，不能静默宽松召回。
9. 日志失败不能回滚真相，但必须可见并可诊断。
10. 完整恢复先 fail closed 验证，再替换数据；不能信任备份自报身份。
11. 每个完整 exchange 都必须可恢复地生成 L1；模型失败不能丢失 L0/L1。
12. episode 与 summary 不是用户事实；新增召回路径必须保留分层标签和来源。
13. Dense 非队尾只做增量索引；完整 generation 水位只能在队尾或受控批量边界确认。
14. 上下文依赖问题必须可验证消解；双先行词歧义时零记忆注入。
15. reextract/reflect 水位独立；失败、取消、dead 和超预算不能推进 checkpoint。
16. reflection inference 永不自动提交，且至少三个不同 turn 的逐字证据。

任何变更若需要放宽这些约束，应先更新 PRD、威胁模型、迁移方案和真实验收，
而不是在局部函数里绕过。

## 4. 增加或修改 HTTP API

1. 在 `http-server.ts` 定义路由，并在认证后使用 `principalId`。
2. 对 body/query 调用身份覆盖拒绝逻辑。
3. 严格校验字段、长度、枚举和未知字段。
4. 选择准确状态码：201 创建、202 异步、409 状态冲突等。
5. 在 `src/web/src/types.ts`/`api.ts` 更新客户端契约（如果管理台使用）。
6. 增加 HTTP 隔离、鉴权、错误和成功测试。
7. 更新 [HTTP API 文档](api-reference.md)。

列表接口必须按当前 principal 过滤；404 不应泄露“对象存在但属于其他账户”。

## 5. 增加或修改 MCP 工具

1. 在 `mcp-server.ts` 使用 Zod 定义完整输入 schema。
2. 工具实现只能使用连接启动时固定的 principal。
3. 错误返回必须可操作且不泄露其他账户信息。
4. 增加 `mcp-stdio` 和工具行为测试。
5. 更新工具清单、客户端配置和[MCP 手册](mcp-guide.md)。

新增工具是公共协议变化；不能只改描述而不做兼容和文档验证。

## 6. 数据库迁移

1. 增加 `SCHEMA_VERSION`。
2. 使用顺序、事务化 migration，允许从所有支持旧版本升级。
3. 新增列/索引/触发器前检查真实 schema，不只假设版本号可信。
4. 关键安全结构增加 attestation 和伪造结构负例。
5. 迁移失败完整 rollback，并在需要时保留迁移前备份。
6. 增加旧版本成功迁移、提交前失败、重复启动、未来版本拒绝测试。
7. 更新数据模型、部署升级、备份兼容和验收报告。

SQLite 行对象可能是 null-prototype；测试做 `deepEqual` 前先转换为普通对象。
SQL 字符串值使用绑定参数或单引号，不要把双引号字符串误当标识符。

## 7. 修改检索

检索变更至少回答：

- 候选从哪个 channel 进入？
- 是否仍为全库检索而非最近 N 条预截断？
- scope filter 在哪一层执行？
- 相关性门槛和严格重排是否保持 fail closed？
- trace 九阶段能否解释新行为？
- 固定集和真实负例如何覆盖？
- Dense generation 如何回填、评测、切换和回滚？

修改融合、阈值、query rewrite、graph 或反馈 prior 后运行 P1/Dense 固定评测，
并至少保留一个主体/账户/项目不匹配的真实 LLM 负例。

## 8. 修改提取、关系或巩固模型

- 模型名与 prompt version 分开配置并持久化到审计。
- 输出采用严格结构校验，解析失败进入可诊断错误。
- 不允许模型自行指定 principal、scope 或删除目标。
- 关系先走确定性规则，再让模型处理语义歧义。
- 巩固逐句验证来源；无支持句 quarantined。
- 更换模型必须重跑真实 Ollama 评测，不只跑 mock 单测。

## 9. 修改 Worker

- 新 job type 必须有明确幂等键、租约、attempt、backoff 和 maxAttempts。
- 业务真相事务先写 outbox，不能先发送内存任务再提交数据库。
- 崩溃后重放不得重复版本、tombstone 或 purge。
- dead letter 恢复保留原失败证据并链接 recovery job。
- 周期任务使用稳定链收敛，避免每次启动无限新增。

## 10. 修改管理台

- UI 文案必须区分 HTTP 连通、可靠语义健康和真实 MCP/AIRI 连接。
- Token 继续只保存在内存，不引入 localStorage/URL/query。
- 危险操作使用明确确认，恢复冲突使用两阶段 Token。
- 空状态显示真实空库，不注入 demo 数据。
- 异步请求防止旧响应覆盖新选择。
- 新页面/字段同步更新 `types.ts`、API 测试和[界面手册](ui-guide.md)。

## 11. 测试定位

| 变更区域 | 首选测试 |
|---|---|
| database/migration | `tests/database.test.ts`、`full-backup.test.ts` |
| identity/scope | `identity.test.ts`、`memory-scope-security.test.ts`、multitenant tests |
| HTTP | `http-server.test.ts`、`http-multitenant.test.ts`、identity management tests |
| MCP | `mcp-stdio.test.ts` |
| lifecycle | `airi-memory-lifecycle.test.ts`、`airi-ollama-compat.test.ts` |
| candidate/relation | candidate、claim-relation、explicit-intent tests |
| retrieval | hybrid、semantic、dense、namespace、observability tests |
| contextual query | `contextual-query-understanding.test.ts`、lifecycle context recall tests |
| reflection | `memory-reflection.test.ts`、governance、backup、context-reflection evaluator |
| worker/recovery | memory-worker、governance、crash recovery |
| web state | account-page-state、web-api-auth tests + build |

先跑最近测试，再跑 typecheck/全套。最终风险与验证层级见
[测试与发布](testing-and-release.md)。

## 12. 文档维护

代码变更时同时更新：

- 配置：`configuration-reference.md` 与 README 摘要。
- HTTP/MCP：对应接口文档。
- UI：`ui-guide.md`。
- schema：data、technical、deployment、backup 文档。
- 日志/trace：logging、retrieval logging、troubleshooting。
- 发布行为：acceptance report 与 AI handoff。

验证所有 Markdown 相对链接、代码块、冲突标记和关键协议覆盖。

## 13. 提交前门禁

```bash
npm run typecheck
npm test
npm run build
```

根据变更追加 model、Dense、规模、soak、crash recovery 和真实 AIRI 门禁。记录
未运行的测试和残余风险，不要用“应该没问题”替代证据。

修改查询理解或历史重提炼时还必须运行：

```bash
npm run evaluate:context-reflection -- --validate-fixture
```

涉及 Prompt、模型输出校验或 evidence 语义时，再用隔离目录运行完整 120 查询/
100 窗口真实模型评测。修评测器与修生产代码要分开写回归，不能通过放宽统计口径
掩盖 credential、scope、tombstone、重复或无逐字证据缺陷。
