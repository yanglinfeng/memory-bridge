# 上下文查询理解与通用历史对话重新提炼：最终实施 PRD

> 产品：忆桥 Memory Bridge  
> 状态：`IMPLEMENTED / RELEASE GATE FAILED`  
> 版本：2.0  
> 日期：2026-08-10  
> 基线：schema 28、AIRI 0.11.x、开发默认 `legacy local generation model`、`bge-m3:latest`  
> 目标：schema 31（schema 29 为未发布过渡骨架，schema 30 为历史重提炼基线）  
> 关联文档：`prd-contextual-query-understanding-and-memory-reflection.md`

## 1. 决策摘要

本版本把五个产品点作为一个闭环交付，而不是五个互不相干的功能：

1. 上下文查询理解与歧义澄清。
2. 通用历史重提炼基础设施。
3. 历史直接事实重提取。
4. 跨多轮历史反思。
5. 运行、预览、确认、修正、拒绝和追踪界面。

审查后补充六个不可省略的横向能力：

1. 跨版本候选去重与证据合并。
2. checkpoint 只在持久化事务成功后推进，失败不得跳过历史。
3. 任务限流、取消、租约、重试、dead letter 和模型调用预算。
4. 证据 TTL、tombstone、备份恢复和物理清除闭包。
5. 模型/提示/实现版本升级后的受控回放和回滚。
6. 固定评测、shadow 放量、线上反馈和可追踪质量指标。

二次安全审查再补充以下发布门槛：

1. reextract 与 reflect 使用独立 pipeline generation 和 checkpoint。
2. 使用单调 ingest sequence 扫描，`occurred_at` 只用于语义窗口，迟到数据不能漏扫。
3. 保存不可变 run-turn 清单，重试不得重新猜测窗口。
4. 模型预算必须原子预留、消费并形成可审计账本。
5. 语义 claim 使用单写者注册表完成跨版本、并发去重和拒绝抑制。
6. candidate evidence 必须在数据库和提交前验证 owner、namespace、scope 一致。
7. 人工确认/拒绝使用状态比较更新，提交前重查取消、TTL、tombstone 与 scope。
8. 上下文理解必须具备单回合 single-flight、硬 token 上限和安全澄清模板。
9. AIRI 对普通私有稳定事实问句也必须执行零召回弃答，不能要求用户显式说出
   “长期记忆”才启用抗幻觉门禁。
10. 可信召回的私有事实必须确定性落到回答；回答模型否认、改写或换主体时，
    代理层返回经过召回上下文修复的结果，且世界知识/建议类 hard negative 不受该规则影响。
11. 派生摘要的内部 provenance 和代理私有控制字段不得泄漏或由客户端伪造；
    只有可信生命周期层能设置 grounding 状态。
12. 每次 AIRI 请求必须能从 requestId 直接关联 retrieval traceId、九阶段 trace
    和代理审计，否则不得声称可追溯。
13. 验收回执必须绑定可复核的审计快照和实现指纹；不能对会继续追加的整个
    stdout 文件做哈希，也不能只靠文件时间推断回执对应哪版代码。
14. AIRI 聊天模型必须与提取、关系、重排、巩固和反思模型独立配置；
    `legacy local generation model` 只是开发默认值，不得成为代理协议的硬编码依赖。
15. 八个 Ollama 模型角色必须使用同一套 trim、安全标识符校验和 fail-fast 规则；
    manifest、HTTP 运行时、MCP 子进程和验收请求不得各自解释配置。
16. `/api/system-health` 必须检查当前 HTTP 服务实际使用的 AIRI 聊天模型，不能在
    options 覆盖后继续检查进程级默认值；管理台必须显示八个角色和明确缺失列表。
17. 隔离验收必须逐角色比较 manifest 与 `/api/config`，并把 manifest/runtime/request
    三方证据写入回执；任何合法自定义模型组合都不得被 QA 脚本硬编码覆盖。

未经用户确认的跨多轮推断永远不能自动成为规范记忆。本版本不提供解除该限制的
配置开关。

## 2. 立项时已确认的缺口

### 2.1 上下文查询缺口

- AIRI 生命周期能够解析最近 user/assistant 消息，但召回只传入最后一句。
- `RecallInput` 和 `SemanticRanker.rewrite()` 没有历史 turn、消解证据、歧义和
  约束字段。
- 查询改写只在首批候选为零或数量不超过阈值时触发；候选很多但全部无关时不会
  补救。
- 最终严格重排只收到原查询，不知道高置信独立查询和保留约束。
- AIRI 只有在问题显式包含“长期记忆/记得”等词时，才会把 full 零召回标记为
  必须弃答；“Bob 的项目叫什么”这类普通私有事实问句会直接交给模型自由回答，
  即使没有跨账户泄漏，也可能生成无依据的新事实。旧 9/9 探针只检查
  expected/forbidden 字符串，不能证明普通零召回抗幻觉。

隔离探针已经复现：

- “我妹妹小林最喜欢桂花乌龙”之后询问“她最喜欢什么”，实际召回 query 只有
  “她最喜欢什么”。
- 12 个噪声候选会让 rewrite `triggered=false`；严格重排全部拒绝后结果为零，
  系统仍不会启动质量补救。

### 2.2 历史重提炼缺口

- 普通用户 turn 只通过一次稳定 `extract_turn` 任务进入当前提取器。
- extraction run 已有实现版本字段，schema 28 修复也能定向重跑，但没有通用
  增量扫描、checkpoint、preview 或模型升级回放。
- consolidation 只整理已经提交的规范记忆，不重新读取历史对话发现遗漏。
- 没有多 turn 反思 provider、reflection run、多证据候选和相应 Worker/API/UI。

## 3. 目标与非目标

### 3.1 目标

- 口语、代词、省略和承接提问能在同一可信 session 内可靠消解。
- 无法唯一消解时请求澄清，不用无关长期记忆补位。
- 在证据保留期内按增量窗口重新检查历史，补回明确遗漏的直接事实。
- 从多个不同 user turn 发现稳定候选模式，但始终要求人工确认。
- 任意任务可预览、可追踪、可重试、可取消、可幂等重放。
- 账户、namespace、persona、project、session 和 tombstone 边界在模型调用前后
  均由确定性代码校验。
- 普通用户无需说“请查长期记忆”；对可确定为私有稳定事实的问题，full 零召回
  必须禁用继续查找工具并返回明确“不知道”，同时记录可追溯触发原因。

### 3.2 非目标

- 不训练或微调基础模型。
- 不永久保存全部聊天原文。
- 不允许助手内容单独成为用户事实证据。
- 不根据语气、表情、沉默或单次负面表达诊断人格、健康或心理状态。
- 不把历史重提炼实现成不可追溯的自由文本总结。
- 不在本版本提供 inference 自动提交。

## 4. 可行性分析

| 功能 | 可行性 | 主要依赖 | 主要风险 | 发布策略 |
|---|---|---|---|---|
| 上下文查询理解 | 高 | 现有生命周期、混合检索、重排 | legacy local model 指代误判、额外延迟 | trace-only → 候选 → ranking → 澄清 |
| 历史基础设施 | 高 | SQLite、Worker、租约、治理 | 迁移、并发、checkpoint 跳过 | schema 先行，隔离库验证 |
| 直接事实重提取 | 高 | 现有 extractor/Resolver | 重复候选、旧事实复活 | preview/shadow，达标后才 auto |
| 跨多轮反思 | 中 | 多证据、敏感分类、人工审核 | 幻觉、过度归纳、隐私 | 永久 shadow/pending |
| 管理 API/UI | 高 | 现有管理台和候选收件箱 | 误操作、大范围回放成本 | 二次确认、限额、异步任务 |
| 百万 turn 增量运行 | 中高 | 复合索引、水位和批量窗口 | 全表扫描、Ollama 吞吐 | 只扫增量索引窗口、预算限制 |
| AIRI 普通零召回弃答 | 高 | 现有召回质量状态、代理响应修复 | 规则过宽会误伤世界知识或建议问题 | 只覆盖私有稳定事实问句；正例、hard negative 和 HTTP 回归共同门禁 |
| grounded 回答修复 | 高 | 生命周期返回的可信事实与 trace | 强制文案可能降低自然度 | 仅对私有事实或已检测到矛盾的召回执行，保留确定性前缀 |
| 内部元数据隔离 | 高 | 代理边界删除、来源类型判断 | 错删合法内容 | 仅剥离 `consolidation` 来源的严格首行标记和四个保留字段 |
| request/trace 关联 | 高 | HTTP 响应头、compat JSONL、SQLite trace | 请求失败时可能尚未产生 trace | requestId 始终返回；仅已进入召回时返回 traceId |
| 验收证据自包含 | 高 | 只读文件哈希、私有快照 | 回执体积和维护成本上升 | 仅快照结构化审计行；记录 schema、Node、lockfile、核心 dist 和探针指纹 |
| AIRI 聊天模型独立配置 | 高 | 现有代理 options 和环境变量 | 请求、模型列表、JSON/SSE 响应校验可能不一致 | 单一运行时值贯穿全链路；自定义模型回归；更换后重验固定集和桌面闭环 |
| 八角色模型配置一致性 | 高 | 现有配置、manifest、`/api/config`、MCP env | 空格/非法字符、局部 options、QA 默认值造成 split-brain | 统一解析器；逐角色预检；回执保存三方模型映射；管理台显示缺失列表 |

本机 `legacy local generation model` 足够用于开发和固定评测，但产品不能依赖“模型大概会理解”。
身份、scope、逐字证据、条件保留、tombstone 和自动提交资格必须由确定性代码裁决。

## 5. 总体架构

```text
回答前
  可信身份 + 当前问题 + 同 session 有界历史
    → 上下文依赖检测
    → 结构化查询理解（最多一次模型调用）
    → 原查询 + 独立查询 + 变体
    → FTS/Dense/概念/图 + RRF
    → 严格重排 + 约束校验
    → 记忆注入 / 澄清 / 明确 degraded

回答后
  完成 turn 入账 → 现有逐 turn 提取 → 更新可反思水位

后台
  reflection_sweep
    → 可信增量窗口
    → reextract_turn_window（直接事实）
    → reflect_turn_window（跨多轮候选）
    → 逐字证据/scope/tombstone/credential 校验
    → Resolver 或待确认收件箱
    → 用户确认后进入规范版本
    → 现有 consolidation
```

## 6. 功能一：上下文查询理解

### 6.1 输入边界

- 完整身份模式优先从数据库读取同 principal、namespace、可信 session 的最近
  6 条已完成 user/assistant 消息。
- 当前尚未入账的问题单独加入。
- 数据库没有历史时，允许使用 AIRI 请求中的有界历史，标记为
  `request_untrusted`。
- 不包含 system、tool、Memory Bridge 注入文本、credential 原文或其他 session。
- MCP/HTTP 的 `recentTurns` 只能影响语义，不能提供或覆盖身份和 scope。

默认限制：2～12 条消息，默认 6；256～4096 token，默认 1600。

### 6.2 结构化结果

结果至少包含：

- `status`: `not_needed/resolved/ambiguous/unavailable`
- `originalQuery`
- `standaloneQuery`
- `rankingQuery`
- `variants`
- `resolvedReferences` 与支持 turn ID
- 时间、否定、条件、模态、主体和对象约束
- 频率约束；约束保留必须由 standalone query 本文证明，不能依赖模型在
  `constraints` 字段中自报同一个词。
- `unresolvedReferences`
- `clarificationQuestion`
- `confidence/contextSource/model/promptVersion/latencyMs`

原问题永远保留。只有 `resolved` 且达到置信门槛的独立查询才能参与 ranking；低置信
变体最多用于增加候选。

### 6.3 两级触发

第一级在召回前确定性识别代词、指示词、省略承接、极短无主体问题及英文等价表达。

第二级在原查询召回后按质量触发：

- 零/低候选。
- 最高相似度、主题重叠或融合分低于门槛。
- 严格重排全部拒绝。
- 查询和候选主体/谓词无法对齐。

每个回合最多调用一次理解模型；已有 LLM rewrite 必须复用同一次结构化结果。
同 owner/session/round/query/context hash/model/prompt 的重放与并发请求使用
single-flight 和短期幂等结果，不能重复消耗模型预算。

### 6.4 确定性安全校验

- 支持 turn 必须真实存在于选定窗口。
- 每个声明为支持证据的 turn 都必须逐字包含 `resolvedText`；不得把竞争 turn 一并
  挂到同一个实体上绕过歧义检测。
- 否定、时间、频率、条件和模态不得丢失。
- 两个同等可能先行词必须返回 `ambiguous`。
- 模型输出的 principal、namespace、persona、project、session 字段一律拒绝。
- assistant 消息可帮助理解话题，但不能单独证明用户事实。
- 上下文中的提示注入只作为待分析数据。
- 上下文窗口执行真正的硬 token 上限；单条超长 turn 必须安全截断或排除，输入模型前
  先做 credential redaction。
- 模型生成的澄清句不得直接拼入 system 指令；只允许单行、受限长度、无工具/角色/
  system 指令模式的自然问句，否则使用固定澄清模板。

### 6.5 失败行为

- 上下文依赖问题无法消解：不注入猜测记忆，返回一句自然澄清问题。
- 模型不可用：独立问题继续原查询；唯一、逐字支持的明确项目指示允许只替换原词的
  确定性降级，其余上下文依赖问题标记 degraded/unavailable，不冒充完整召回。
- trace 保持九阶段，扩展 `rewrite` 事件；metadata 模式只保存哈希和计数。
- 候选很多但严格重排全部拒绝时仍必须进入第二级质量补救；每回合理解模型调用总数
  仍不得超过一次。

### 6.6 AIRI 零召回答案门禁

- `qualityState=full` 且最终记忆结果为 0 时，对两类问题进入强制弃答：
  1. 显式长期记忆查询。
  2. 不含“长期记忆”关键词、但可由确定性规则识别为私有稳定事实问句，例如本人
     偏好、住址、生日、常用工具、角色/项目代号、发布窗口和计划状态。
- 判定必须同时要求问句形式、私有主体锚点和稳定属性面；“如何给项目起名”、
  “什么是向量数据库”、一般建议、教程和世界知识问题不得仅因零召回而强制弃答。
- `degraded/unavailable` 只能披露召回不完整，不能把零结果当成不存在。
- 命中后在发给模型前禁用记忆工具，在响应后确定性修复为“不知道。”，不信任
  legacy local model 自己服从提示词。
- 结构化审计必须区分 `explicit_query` 与 `private_fact_query`，内部控制字段必须在
  上游请求前删除，不得泄露给 Ollama 或客户端。
- 验收必须包含普通问法、跨账户私有事实、显式问法、hard negative、审计原因、
  内部字段剥离和真实 AIRI 隔离探针；仅检查 expected/forbidden 字符串不足以宣称
  抗幻觉通过。

## 7. 功能二：通用历史重提炼基础设施

### 7.1 schema 30/31

新增：

- `memory_reflection_checkpoints`
- `memory_reflection_runs`
- `memory_candidate_evidence`
- `memory_turn_ingest_order`
- `memory_reflection_run_turns`
- `memory_reflection_model_calls`
- `memory_reflection_claims`
- `memory_reflection_events`

`memory_candidates` 增加可空 `reflection_run_id`、`candidate_origin` 和稳定
`claim_fingerprint`。候选来源区分 `turn_extraction/history_reextract/reflection`。

schema 31 在上述基础上把可信 `session_id` 固化到
`memory_turn_ingest_order`，增加 owner/namespace/session/ingest sequence 复合索引，
并由触发器保证 ingest 身份不可变、turn 与 session 归属一致。迁移和 reopen 还会
校验既有 candidate evidence 的 personal/role/project/session 真实归属；无法证明的
旧数据 fail closed，不猜测、不半迁移。

### 7.2 checkpoint 与事务规则

- 扫描水位使用单调 `ingest_seq`，并绑定 principal、namespace、scope、run type 与
  完整 pipeline generation；`occurred_at` 仅用于 30 天语义窗口和展示。
- run 创建时固化 turn ID、alias、ordinal 与内容哈希；重试只能读取该不可变清单。
- run 创建、候选/证据写入和 checkpoint 推进必须处于同一最终提交事务，或通过
  明确的 completed handoff 保证等价原子性。
- `partial/failed/dead/cancelled` 运行不得越过尚未成功处理的 turn。
- 重叠窗口只用于理解，不重复计算证据数。

### 7.3 跨版本去重

同时使用两类键：

- run 幂等键：owner + scope + run type + turn set hash + implementation version。
- 语义候选键：owner + scope + normalized claim + negation。

相同实现重复运行零新增副作用；不同实现发现等价 claim 时合并尚未存在的 evidence，
不能在待确认收件箱制造重复候选。

去重不能使用“先查询再插入”。必须在 `BEGIN IMMEDIATE` 内通过
`memory_reflection_claims` 的 owner/scope/fingerprint 唯一键取得单写者所有权；已拒绝
或 blocked 的 inference fingerprint 默认抑制后续版本再次出现。

### 7.4 任务治理

- 每 principal/namespace 一条稳定 `reflection_sweep` 链。
- 窗口任务使用现有租约、指数重试和 dead letter。
- 支持取消尚未运行的手动任务；运行中的模型请求完成后在提交前再次检查取消状态。
- 配置单窗口 turn/token 上限、每日模型调用上限和并发数。
- 首次升级不自动全库回放，必须 preview 或显式确认。
- 每次模型调用先在同一事务中预留每日预算，记录 run、call type、模型、估算 token、
  完成/失败/退款状态；并发 Worker 不能突破限额。

## 8. 功能三：历史直接事实重提取

- 重新检查仍保留正文的旧 user turn。
- 只输出原文逐字支持的 `missed_explicit`。
- 复用当前原子提取、credential、条件覆盖、scope、冲突和 tombstone 校验。
- 自动提交只允许经过固定评测且 namespace 为 auto 的明确 direct_user 候选；默认
  实施和首次发布均为 shadow。
- 模型/提示/提取器版本升级、人工修复和 pre-retention 可触发受限窗口。
- preview 不写候选、规范记忆或 checkpoint。

## 9. 功能四：跨多轮历史反思

- 输入只包含同 owner、namespace 和可信 scope 的 user turn。
- 默认窗口最多 40 个 user turn、8000 token、回看 30 天且不超过证据 TTL。
- 非 `missed_explicit` 观察至少引用 2 个不同 turn，默认产品门槛为 3。
- 每个 excerpt 必须逐字存在于对应 turn；模型只看到 T1/T2 等临时别名。
- 所有输出固定 `sourceAuthority=assistant_inference` 和 `state=pending`。
- 敏感观察进入敏感待确认；credential、医学/心理诊断式推断和无逐字证据内容直接
  拒绝。
- `possible_change` 不得自动 supersede；用户确认后才以 `user_confirmed` 进入版本链。

## 10. 功能五：管理 API、界面与用户控制

### 10.1 API

- `GET /api/reflection/status`
- `GET /api/reflection/runs`
- `POST /api/reflection/preview`
- `POST /api/reflection/reextract`
- `POST /api/reflection/run`
- `POST /api/reflection/runs/:id/retry`
- `POST /api/reflection/runs/:id/cancel`
- `POST /api/reflection/candidates/:id/confirm`
- `POST /api/reflection/candidates/:id/reject`

所有接口从认证上下文取得 principal；拒绝 body/query 身份覆盖。大范围任务必须返回
预计 turn 数、token 预算和二次确认摘要。

### 10.2 管理台

- 显示最近水位、lag、pending/running/failed/dead/cancelled 数量。
- 支持 preview、受限运行、重试和取消。
- 候选显示直接事实/跨多轮推断、证据数、会话数、时间跨度、scope、敏感级别和
  模型/提示版本。
- 系统状态显示 AIRI 聊天、提取、关系判断、自然意图、巩固、历史反思、Embedding、
  重排八个角色；Ollama 模型清单已知时明确列出缺失模型。
- 用户可以确认、修正后确认、拒绝、阻止以后再记。
- 默认只显示最小必要摘录，不展示完整历史窗口。

### 10.3 用户开关

- `off`：不创建新 sweep/run。
- `shadow`：允许产生待确认候选。
- 关闭功能不删除既有 run、checkpoint 或候选；删除必须走既有治理流程。

## 11. 数据生命周期与安全

- reflection 不延长 conversation turn 或 excerpt 的原始 TTL。
- 证据擦除时同步擦除 candidate evidence excerpt，只保留不可逆哈希和运行计数。
- tombstone 在候选生成前和提交前检查两次。
- 物理清除覆盖 reflection run 可识别正文、candidate evidence、索引、缓存和受管
  备份。
- 每账户完整备份/恢复包含 checkpoint、run、candidate evidence，并验证所有外键
  与 owner/scope 一致性。
- schema attestation 必须核验新增表、关键列、唯一索引、owner/scope 触发器和
  `foreign_key_check`，不能只检查表名存在。
- 日志默认不记录历史正文、独立查询正文或 resolvedText；diagnostic 模式仍执行
  credential redaction。

## 12. 配置默认值

| 配置 | 默认 | 说明 |
|---|---:|---|
| `MEMORY_BRIDGE_QUERY_UNDERSTANDING_MODE` | `auto` | `off/auto/always` |
| `MEMORY_BRIDGE_QUERY_CONTEXT_MESSAGES` | `6` | 2～12 |
| `MEMORY_BRIDGE_QUERY_CONTEXT_TOKEN_BUDGET` | `1600` | 256～4096 |
| `MEMORY_BRIDGE_QUERY_UNDERSTANDING_MIN_CONFIDENCE` | `0.78` | ranking 门槛 |
| `MEMORY_BRIDGE_AIRI_CHAT_MODEL` | `legacy local generation model` | AIRI OpenAI-compatible 聊天模型，与其他模型角色独立 |
| `MEMORY_BRIDGE_REFLECTION_MODE` | `shadow` | `off/shadow` |
| `MEMORY_BRIDGE_REFLECTION_SWEEP_HOURS` | `24` | 稳定 sweep 间隔 |
| `MEMORY_BRIDGE_REFLECTION_IDLE_MINUTES` | `30` | 窗口空闲要求 |
| `MEMORY_BRIDGE_REFLECTION_MIN_NEW_TURNS` | `12` | 自动运行门槛 |
| `MEMORY_BRIDGE_REFLECTION_MAX_TURNS` | `40` | 单窗口上限 |
| `MEMORY_BRIDGE_REFLECTION_TOKEN_BUDGET` | `8000` | 单窗口预算 |
| `MEMORY_BRIDGE_REFLECTION_LOOKBACK_DAYS` | `30` | 不超过 evidence TTL |
| `MEMORY_BRIDGE_REFLECTION_MIN_PATTERN_EVIDENCE` | `3` | 不同 turn 数 |
| `MEMORY_BRIDGE_REFLECTION_MAX_DAILY_CALLS` | `48` | 每 principal/namespace |
| `MEMORY_BRIDGE_REFLECTION_CONCURRENCY` | `1` | 本机默认并发 |

不得提供 inference 自动提交开关。

## 13. 质量门槛

### 13.1 查询理解固定集

至少 120 个案例。门槛：

- 可唯一消解语义正确率不低于 92%。
- 否定、时间、条件和模态保留率 100%。
- 应澄清案例错误记忆注入数为 0。
- 跨 principal/scope 泄漏数为 0。
- 真实 provider 调用覆盖率为 100%；正则、缓存或 mock 绕过不得计作真实模型评测。
- 每回合理解模型调用不超过一次。
- warm P95：理解不超过 1.5 秒，完整可靠召回不超过 2.5 秒。

### 13.2 历史重提炼固定集

至少 100 个隔离窗口。门槛：

- 直接事实自动提交 precision 不低于 99%，否则保持 shadow。
- 含直接事实的正例窗口召回率不低于 90%。
- 稳定跨轮模式正例窗口召回率不低于 80%。
- inference 自动提交数、无逐字证据数、tombstone 复活数、跨 scope 混合数和
  credential 泄漏数均为 0。
- 相同窗口/版本重复运行新增候选和版本数为 0。
- 不同实现版本的等价候选合并而不是重复展示。
- 百万 turn 日常 sweep 只扫描增量索引窗口。

### 13.3 2026-08-11 真实固定集证据

- 查询固定集干净独占重跑：120/120 条真实调用 `legacy local generation model`，provider 覆盖率
  100%、唯一消解语义正确率 100%、约束保留率 100%、错误记忆注入 0、scope
  泄漏 0、每例最多一次模型调用；功能和安全门槛通过。
- 同一固定集的开发机 warm P95 为 898.487 ms，低于 1500 ms 目标；prompt/output
  eval P95 为 91.378/732.205 ms。查询固定集功能、安全和性能均 PASS。
- 历史重提炼回执：`/private/tmp/memory-bridge-reflection-quality-v1-schema31-final.json`。
  100 个真实隔离窗口的 direct precision、direct 正例窗口召回、stable pattern
  窗口召回均为 100%；inference 自动提交、无逐字证据、tombstone 复活、scope
  混合、credential 泄漏、诊断式推断、重复排队和跨版本重复均为 0。
- 本机开发延迟与目标生产硬件 SLA 分开记录。生产放量前必须在目标硬件重跑同一
  固定集并满足 1.5 秒门槛；不得删除、放宽或用 mock 覆盖该门槛。

## 14. 实施阶段

### Phase 0：契约与 RED 测试

- 固定类型、错误码、schema 和 trace 字段。
- 为最后一句召回、候选多但全拒绝、历史漏提取、重复回放和跨 scope 写失败测试。

### Phase 1：查询理解

- 有界上下文、检测器、provider、校验器。
- 多查询融合、质量补救、澄清、trace 和 Recall Lab。

### Phase 2：schema 30/31 与任务基础设施

- 表、索引、attestation、checkpoint/run/evidence。
- sweep、租约、重试、取消、dead letter、预算和健康状态。
- 备份、恢复、purge 和 Doctor。

### Phase 3：历史直接事实重提取

- preview、版本化回放、现有 extractor/Resolver 接入、跨版本去重。

### Phase 4：跨多轮反思

- provider、逐字证据、敏感/credential/scope 校验、待确认和确认转换。

### Phase 5：API、管理台、文档和验收

- 管理 API、运行视图、候选证据 UI。
- 固定评测、规模、崩溃恢复、真实模型和 AIRI 多账户验收。

## 15. 完成定义

只有同时满足以下条件才允许标记完成：

- schema 31 迁移、结构指纹、备份恢复和物理清除闭包通过。
- 查询理解、历史重提炼固定集和全部既有回归通过。
- 多账户、多 persona、project、session、模型不可用、重启和崩溃恢复通过。
- 歧义错误注入、跨 scope 泄漏、inference 自动提交、tombstone 复活、credential
  泄漏和重复候选均为 0。
- 普通私有事实 full 零召回的无依据答案为 0；建议、教程和世界知识 hard negative
  不得被错误强制为“不知道”。
- 管理台能够预览、运行、取消、追踪、确认、修正和拒绝。
- `npm run typecheck`、`npm test`、`npm run build` 通过。
- 当前配置的 AIRI 聊天模型、其他生成模型和 embedding 隔离验收通过。
- 文档记录真实证据，不用“模型可以生成结果”代替端到端证明。

## 16. 实施前缺口复核与可行性

2026-08-09 对 schema 30 实现和管理台进行第二次独立复核后，除原五项
功能外，确认以下收口项同样属于可靠交付范围：

| 优先级 | 缺口 | 风险 | 实施与验收 | 可行性 |
|---|---|---|---|---|
| P0 | reextract/reflect 的 sweep 被单一 reflect checkpoint 决策 | 一条 pipeline 可永久饥饿或产生空 run | 每条 pipeline 使用自己的 generation/checkpoint 选窗，双向漂移回归必须通过 | 高；仅修改 sweep 调度逻辑 |
| P0 | 并发数配置未进入 run 领取路径 | 本机模型被并发压垮，预算绕过 | 同 owner/namespace 槽位检查与租约更新使用同一 `BEGIN IMMEDIATE` | 高；无 schema 变更 |
| P0 | preview 只展示 reflect 窗口 | 水位分叉时隐藏待重提取历史，运行按钮误禁用 | API 返回两条 pipeline 的独立 turn/token/call 预估，UI 按 run type 禁用 | 高；使用现有 `selectWindow` |
| P0 | status 用最领先 checkpoint 计算单一 lag | 落后的 scope/pipeline 被健康假象掩盖 | 返回每 scope/run type 的 lag，总览使用 worst lag | 中；需精确的 scope 最新 ingest 查询 |
| P1 | 自动 sweep 未纳入 session scope | 短期会话约定和角色内局部上下文不会被重提炼 | 纳入回看窗口内、已空闲、有新 user turn 的 session；每日预算和并发门禁仍生效 | 中；需避免扫描全部历史 session |
| P1 | events 缺少 run failed/dead 与 model-call 预留/完成/失败 | 不能从日志还原成本和故障链 | 账本状态变更与事件同事务；run 详情返回账本 | 高；复用现有 event/ledger 表 |
| P1 | 固定评测集未达 120 query/100 window | 无法量化模型更换后回归 | 提供版本化 fixture、可重复脚本、门槛与 JSON receipt | 中；不改在线路径，但需真实模型耗时验收 |
| P1 | API/UI/日志/运维文档未覆盖 reflection | 用户可见但无法稳定操作和排障 | 补齐接口、界面、配置、技术、日志、备份恢复和测试文档 | 高；在最终合同稳定后更新 |
| P0 | 增量 scope 发现的 JOIN 可被 SQLite 重排成历史 turn 扫描 | 有 ingest 水位仍会在百万 turn 上退化 | 以 `memory_turn_ingest_owner_idx` 为驱动并用固定上下水位；基准断言真实 query plan | 高；SQL 执行计划约束与规模回归 |
| P0 | 已存在 pending/running run 时 sweep 仍重复预览窗口 | 每日调度按 scope 重复扫描且无法满足稳定态 P95 | 在选窗前按 owner/scope/run type/generation 跳过活跃 run | 高；不改变幂等语义 |

实施顺序固定为：P0 数据正确性和可见性 → P1 调度/日志 → 固定评测 →
隔离真实模型与 AIRI 验收 → 文档收口。任一门禁未通过时不得标记可发布。

## 17. 实施结果与剩余门禁

截至 2026-08-11，Phase 0～5、第 16/18 节可靠性收口、第 19 节检索可追溯性和
第 20 节第五次诊断审查均已编码。当前基线包括 627 项自动化回归、120 条真实查询、
100 个 schema 31 真实历史窗口、100,000 memory/1,000,000 turn 规模基准和真实
SIGKILL 恢复。功能实现完成不等于生产发布通过；真实 AIRI 桌面闭环继续作为
独立门禁。

| 门禁 | 结果 |
|---|---|
| 五项产品功能 | PASS |
| 第 16 节十项可靠性收口 | PASS |
| 多账户、多 role/project/session 隔离 | PASS |
| 固定历史重提炼质量与安全零计数 | PASS |
| 百万级增量查询计划与稳定 sweep | PASS |
| Worker 崩溃恢复、heartbeat、fencing 和取消清理 | PASS |
| `npm test`、typecheck、build | PASS：627/627 |
| 当前构建 AIRI-compatible HTTP v7 探针 | 功能 13/13、trace 13/13、compat audit PASS；不是 AIRI 桌面 UI 验收 |
| 120 条固定查询理解 warm P95 ≤ 1.5 秒 | **PASS：898.487 ms** |
| 完整可靠召回 P95 ≤ 2.5 秒 | **PASS：1352.802 ms** |
| 全新隔离数据库健康 | **PASS：integrity ok、FK 0、open outbox 0、unhealthy/dead jobs 0** |

因此当前五项产品功能及其 P0/P1 可靠性补强已经实现，但第 15 节的生产发布条件
仍未满足。后续还需要完成当前 schema 31 真实 AIRI 桌面 UI 闭环；目标硬件或生产
模型变化时仍须重跑同一固定集，不得删除门槛或清理证据来制造 PASS。完整证据见
[schema 31 当前验收报告](acceptance-report-schema31-context-reflection.md)。

## 18. schema 31 第三次缺口审查与范围裁决

schema 30 主功能完成后，再按“大规模数据、模型不稳定、迁移失败、线上不可诊断”
四类生产事故反推，确认原五项和第 16 节之外还有以下 P0/P1 缺口。它们不是新增
产品花样，而是保证原五项在长期运行后仍然正确的必要条件。

| 优先级 | 补充缺口 | 失败风险 | 方案与可行性 | 当前状态 |
|---|---|---|---|---|
| P0 | ingest ledger 没有可信 session 归属 | 百万 turn 的 session sweep 退化成历史扫描，甚至把 turn 归入错误会话 | schema 31 固化 `session_id`、复合索引和不可变触发器；迁移可由 turn→session 可信链回填 | 已实现并通过迁移、reopen、规模和备份回归 |
| P0 | 既有 candidate evidence 只靠应用层校验 | 旧坏数据或低层写入可能跨 role/project/session 污染候选 | 数据库触发器、迁移前扫描和 reopen attestation 三层 fail closed | 已实现，坏 evidence 迁移原子回滚 |
| P0 | legacy local model 会返回“resolved 但仍残留代词/扩写实体” | 高置信脏独立查询绕过约束检查，导致漏召回或错误实体 | 仅在可信 ledger、唯一先行词、单一引用面、无性别/竞争冲突时，用原问题做确定性重建 | 已实现；低置信、竞争、多代词和性别冲突仍关闭 |
| P0 | 模型保守返回 ambiguous 时没有安全接管 | 明确的唯一先行词被无谓澄清，真实固定集召回下降 | 只允许模型明确 defer 且确定性条件全部满足时接管；不允许低置信 resolved 绕过门槛 | 已实现并有正反回归 |
| P0 | 重启回执把 null 延迟当 0，且不要求 rewrite 事件 | 缺日志会被伪装成超快召回，发布门禁假 PASS | 缺 rewrite、缺任一延迟、非法/非正阈值全部判无证据；完整可靠召回按两段耗时求和 | 已实现并有机器可判定回归 |
| P1 | 首次发现未 idle session 时 scope 水位可能提前越过 | 会话稍后变 idle 后永远不再进入重提炼 | 独立持久化 scope discovery watermark，只在可安全发现后推进 | 已实现并有延迟 idle 回归 |
| P1 | 普通查询也要求完整大 JSON schema | 本机 legacy local model 输出成本高，P95 长期卡在 4 秒级 | provider 私有短 wire 输出在边界恢复成原完整对象，只有质量补救生成 variants；安全约束仍由代码逐字验证 | 已实现；强制 provider P95 898.487 ms，达到 1500 ms |
| P1 | schema 30→31 缺少可恢复升级证明 | 正式库升级失败会留下半迁移或不可回滚状态 | 写锁内备份、单事务迁移、结构 attestation、完整备份往返和伪造 session 拒绝 | 已实现并通过回归 |
| P0 | reflection generation key 仍固定写入 `schema:30` | schema 31 升级后可能复用旧 checkpoint/generation，跳过应重新提炼的历史 | generation 直接绑定数据库 `SCHEMA_VERSION`，并同时断言 reextract/reflect 两条 pipeline | 已修复，新增回归并通过全量测试 |
| P1 | 百万级规模基准只输出 stdout | 指标无法长期机器复核，文档抄录可能漂移 | 增加原子 `--receipt` JSON 输出并保存数据规模、阈值、测量、query plan 与环境元数据 | 已实现并有回执写入回归 |
| P0 | AIRI 仅对显式“长期记忆”零结果强制弃答 | 日常私有事实问句零召回后仍可能由 legacy local model 编造；旧 9/9 字符串探针会漏报 | 增加私有稳定事实问句确定性分类、精确 `不知道。`、grounded 修复、hard negative、原因/链路审计与真实隔离探针 | 已实现；当前 v7 13/13，见第 21 节 |
| P0 | 派生摘要标记可见，客户端可伪造内部 grounding 字段 | 泄漏内部 UUID，或绕过可信生命周期强制假事实 | 只对 `consolidation` 来源剥离严格首行 provenance；生命周期前删除四个保留字段，异常时也不信任客户端值 | 已实现并有伪造/泄漏回归 |
| P1 | compat requestId 与 retrieval trace 不可直接关联 | 回答不满意时只能靠时间猜测 trace，多账户并发下易误判 | 响应头同时返回 requestId/traceId，compat audit 记录 `retrievalTraceId`，验收器断言与 SQLite 九阶段一致 | 已实现；当前 v7 复验通过 |
| P1 | 回执哈希整个会继续追加的 compat stdout | 服务关闭日志追加后，回执中的哈希无法从源文件重算 | 只解析严格行首事件，规范化为 0600 JSONL 快照，记录 hash scope、bytes、event/invalid count | 已实现；当前 v7 快照可复核 |
| P1 | 回执未绑定当前构建和探针版本 | 无 Git commit 时无法机器证明回执对应哪一版实现 | 记录 schema、Node、package-lock、核心 runtime、probe/lib SHA 和聚合指纹 | 已实现；当前 v7 的 35 个 runtime 文件已绑定 |
| P1 | AIRI 聊天模型在代理中硬编码为 `legacy local generation model` | 开发后期更换模型时，`/models`、请求和 JSON/SSE 响应会互相拒绝 | 新增 `MEMORY_BRIDGE_AIRI_CHAT_MODEL`，将同一运行时值传入 models/chat/流式/重试/健康与配置端点；保留 legacy local model 默认 | 已实现；默认与自定义模型回归通过 |
| P0 | system-health 读取进程默认聊天模型而代理使用局部 options | `/api/config`、真实代理和 readiness 检查形成 split-brain，可能把缺失模型误判为健康 | `systemHealth` 接受已解析 chat model，HTTP 边界传入同一值；自定义模型集成回归 | 已实现，局部模型贯穿 health 与代理 |
| P0 | 七个非聊天模型不 trim/不校验 | manifest 已 trim、运行时却保留空格或危险字符，provider 与 health 对同一配置得出不同结果 | 八角色统一 `parseModelIdentifier`，空白、控制字符、分号和超长值启动即失败 | 已实现，八角色逐项回归 |
| P1 | QA/MCP 子进程硬编码部分模型，回执只证明 chat | 自定义合法组合验收时跑错模型或误报失败，无法证明 relation/intent/reflection 一致 | manifest 作为默认真相；逐角色比对 `/api/config`；MCP env 和两类回执保存完整模型映射 | 已实现，验收 helper 有正反回归 |
| P1 | 系统状态页只展示四个模型且不显示 missingModels | 运维无法判断聊天、关系、意图、反思究竟缺哪个模型 | 管理台展示八角色并把缺失列表作为显式告警 | 已实现；需随最终 Web/浏览器验收复核 |

### 18.1 可行性结论

- 数据正确性和安全项可行性高，均能用 SQLite 事务、索引、触发器和确定性校验
  完成，不依赖更大的模型。
- 查询质量修复可行性高，但只能接管可证明的唯一引用；扩大到多引用或不可信请求
  历史会提高错误注入风险，因此明确不做。
- 普通零召回弃答可行性高，因为召回完成度和结果数已经是可信结构化状态；难点只在
  问句分类。采用窄规则面和 hard negative 可以控制误伤，不需要增加一次模型调用。
- 本机延迟优化可行性中等。紧凑协议已经显著降低输出成本，但 `legacy local generation model`
  的 120 条真实调用 P95 仍高于生产门槛；后续应换目标模型/硬件或做经固定集验证的
  推理加速，不能删除真实 provider 覆盖门禁。

### 18.2 本版本不继续扩张的 P2 能力

下列能力确实有价值，但不属于 AIRI 本地长期记忆 P0/P1；把它们塞进本次会扩大
安全边界或改变产品形态：

- 多机分布式部署、云同步和跨设备一致性。
- 数据库静态加密与外部 KMS；当前只能依赖本机磁盘加密和文件权限。
- 图片、音频和文件内容的多模态记忆。
- 超出当前中文/英文规则面的完整多语言指代系统。
- 自动夜间生产流量评测和告警编排；当前已具备固定集、反馈难例和日志证据，尚未
  交付外部调度平台。

这些 P2 项不是当前代码“已经支持”的功能，也不得在 README 中暗示已经上线。

## 19. 第四次缺口审查：检索可追溯性与低召回补救

2026-08-10 按“用户对匹配结果不满意时，能否只凭一次请求证据定位到具体失败
阶段和候选”的标准重新审计后，确认原五项能力之外还有以下 P1。它们不会改变
记忆内容真相或权限模型，但会直接影响日志诊断、低召回恢复和发布证据可信度。

| 优先级 | 缺口 | 失败风险 | 实施方案 | 可行性与兼容性 |
|---|---|---|---|---|
| P1 阻断 | provider、query variant embedding 或 rerank 失败时不足九类 trace 阶段 | 只能看到 request/result，无法判断失败在哪一步，和日志合同冲突 | trace session 在失败时补齐尚未执行的阶段，记录 `failedStage/errorCode/skipped/upstream_stage_failed`；成功、零结果、澄清和失败共用同一阶段合同 | 高；只扩展事件 detail，不改 schema |
| P1 阻断 | 质量补救结束第一条 trace 后递归创建第二条未关联 trace | 返回的 traceId 丢失第一次失败证据，并发下无法还原整轮召回 | 同一 root trace 内使用 `attempt=1/2`；rewrite～selection 可按 attempt 重复，context/result 只最终写一次 | 高；traceId 和现有 API 返回形状保持不变 |
| P1 阻断 | 只有聚合 `filterSummary`，没有逐候选淘汰原因 | 能看出“淘汰 5 条”，但不能判断具体 memory 在相似度、重排、scope、摘要覆盖还是 limit 被拒绝 | 新增 `candidateDecisions`，仅记录 memoryId、stage、decision、reasonCode、score、threshold；正文只在 diagnostic 模式已有边界内出现 | 高；元数据日志可直接承载，无 schema 变更 |
| P1 阻断 | 各阶段缺少独立 `durationMs` | 总耗时异常时无法区分 embedding、候选通道、融合、重排或上下文构造 | trace session 使用 monotonic clock 为每个事件写入非负 `durationMs`，result 继续保留 totalDurationMs | 高；不增加模型调用 |
| P1 阻断 | `MEMORY_BRIDGE_QUERY_REWRITE_MODE=off` 同时关闭零候选确定性补救 | 用户只想关闭 LLM rewrite，却失去无成本的别名/规范化救援，造成可避免的低召回 | `off` 只关闭 LLM；零候选时仍运行一次有界 deterministic variants，且 trace 明确实际模式 | 高；保持开销上限，语义比旧配置名更准确 |
| P1 中 | MCP `memory_recall` 空数组无法携带 traceId | 零召回恰是最需要排障的情况，但调用方只能按时间猜 trace | 文本 content 继续返回旧数组；在 MCP `_meta` 和 `structuredContent` 附 `retrievalTraceId`，并把 `_airiRequestKey` 的哈希写入 trace request | 高；旧客户端不受影响，新客户端可直接关联 |

### 19.1 验收标准

- 正常、零结果、歧义、query embedding 失败、variant embedding 失败和 rerank 失败
  都能从一个 traceId 看到 request/rewrite/channels/fusion/semantic/rerank/selection/
  context/result 九类阶段；失败后的下游阶段必须标记 skipped，不能伪装成执行成功。
- 每个事件含有限、非负 `durationMs`；result 的 `totalDurationMs` 仍为整条 trace 总耗时。
- 质量补救只新增一个 trace row；同一 trace 中 attempt 递增且最终 response traceId 不变。
- 被淘汰候选可以通过 `candidateDecisions` 精确定位 memoryId 和稳定 reasonCode；
  metadata 模式不得泄漏查询或记忆正文。
- rewrite mode 为 off 且原查询零候选时，至少执行 deterministic rescue；不得调用
  LLM rewrite。
- 真实 MCP stdio 的空 `memory_recall` 文本仍为 `[]`，但 `_meta` 和
  `structuredContent` 必须返回同一个 retrievalTraceId，数据库可按该 ID 找到 trace。

### 19.2 明确延期项

- AIRI-compatible HTTP 已用 requestId、响应头、compat audit 和 retrievalTraceId 完成
  直接关联；SQLite request 事件保存 `correlationSource=airi` 和 requestId 的
  SHA-256 `correlationIdHash`，不持久化原始 requestId。MCP 内部请求键采用同样的
  不可逆哈希策略，因此该关联能力已经实现，不再列为 P2。
- 不为 trace 新建父子表或分布式 tracing 系统；单机 SQLite 下 root trace + attempt
  已能完整还原一次召回，新增 schema 会提高迁移风险而没有当前收益。

## 20. 第五次缺口审查：候选上限、关联与日志隐私

在第 19 节实现后，又从“日志能否在不读取正文的情况下解释低召回、慢召回和错误”
反推，确认以下补充点。它们均不改 schema，使用现有 trace detail、MCP 元数据和
递归脱敏器即可落地，可行性高。

| 优先级 | 缺口 | 风险 | 最终方案 | 状态 |
|---|---|---|---|---|
| P1 | lexical/ANN/term/fusion 上限只有返回数 | 不能区分本来候选少与被 cap 截断 | 每通道记录精确 raw/returned/capped；fusion 另记 valid 与 cap | 已实现并回归 |
| P1 | 无效派生来源只能人工计算 raw-valid | 派生摘要失效会被误判为检索漏召回 | fusion 显式记录 `invalidDerivedSourceCount` 和 `invalid_derived_source` | 已实现并回归 |
| P1 | 图扩散没有 raw/capped 诊断 | “无关系”与“关系过多被截断”不可区分 | window count 返回 `graphDiagnostics`，cap 写 `graph_channel_cap` | 已实现并回归 |
| P1 | 重排提前满足与候选上限混用原因 | 调参会错误扩大候选或误判性能瓶颈 | 区分 `rerank_candidate_cap` 与 `rerank_early_stop_sufficient_relevant` | 已实现并回归 |
| P0 | trace 脱敏不能代表 audit_log/JSONL 已安全 | provider 错误或嵌套字段可能泄漏 Token | 三种日志面统一递归脱敏；自由错误存 hash，凭据字段存 `[REDACTED]` | 已实现并回归 |
| P1 | MCP 空数组缺少质量语义 | 只拿到 traceId 仍不能立即区分 full/degraded/unavailable | `_meta/structuredContent` 同时返回 traceId、qualityState、errorCode | 已实现并回归 |
| P1 | AIRI request 与 SQLite trace 缺少隐私安全关联 | 并发请求只能按时间猜，存原 ID 又扩大标识面 | 生命周期传 correlation context，SQLite 只存 SHA-256 | 已实现并回归 |
| P1 | 质量补救返回无用结构时没有 outcome | 已产生模型成本，但 trace 看起来像从未尝试补救 | 同 trace 新 attempt 写 `quality_fallback_not_useful`，保留状态和耗时 | 已实现并回归 |
| P0 | QA 验收器假设一个 trace 恰好九条事件 | 质量补救的多 attempt 会被误报为 trace 不完整，或验收器被迫忽略真实补救链 | 按 attempt 校验完整 rewrite→selection 子序列；允许 `quality_fallback_not_useful` 在 rewrite 明确终止 | 已实现并回归 |
| P0 | 固定文件名回执可被后续运行覆盖 | 无法证明发布结论对应哪次运行，失败证据可被无意改写 | runId 唯一文件名、`wx` 排他写入、0600 权限、文件 SHA-256、compat 快照 SHA-256 与实现指纹 | 已实现并回归 |
| P1 | 不可变回执仍默认位于系统临时目录 | 系统清理后哈希无原文件可重算，长期发布审计链中断 | `MEMORY_BRIDGE_ACCEPTANCE_PARENT_DIR` 允许将每次私有隔离 root 创建在受控持久目录；`.memory-bridge-private/` 默认忽略，禁止归档 secrets/原始 stdout/私人正文 | 已实现并回归；正式验收必须显式设置 |

额外复核了质量补救 provider 耗时归属：`beginAttempt()` 虽在 provider 返回后切换
attempt，但 trace 的 monotonic `lastEventNs` 不会被重置，因此 attempt 2 的首个 rewrite
事件已经包含 provider 等待。新增延迟回归证明该行为，无需改动生产计时代码。

## 21. 最终发布边界

“P0/P1 已编码完成”和“允许生产发布”是两个不同结论。当前 schema 31
AIRI-compatible HTTP v7 不可变重启回执的功能检查 13/13、trace coverage 13/13、
compat audit 全部通过；生产 `auto` 完整可靠召回 P95 1352.802 ms，隔离库
integrity `ok`、FK 0、open outbox 0、unhealthy/dead jobs 0。120 条强制
`legacy local generation model` 查询理解固定集的质量、安全和性能门槛通过，warm P95 898.487 ms；
当前 schema 31 真实 AIRI 桌面 UI 闭环尚未重跑，所以整体仍
必须是 `FAIL`。开发、本机 MCP、
AIRI-compatible 集成和 shadow 使用可以继续；不得开启 inference 自动提交，也不得
用旧 schema 或旧回执替代当前证据。

当前权威回执为：
`.memory-bridge-private/acceptance/memory-bridge-airi-final-v31.nJ6Lcp/receipts/restart-persistence-probe.20260810193553514-a5c12df8.json`，
SHA-256 为
`8a8dde4e24ef0adc8c7b20c2db1011c1390c95398d6d33b5b0642d77438fcd4c`，
实现聚合指纹为
`7aaa9083dc9a6091dbca80a821a5d6868d5df02a93cf7d82b345e8f69d1037b3`。
回执和规范快照均为 0600，使用 runId 唯一文件名和排他创建，不允许后续运行覆盖。
本次 v7 位于 `.memory-bridge-private/acceptance` 受控私有持久目录；不得公开归档
secrets、原始 stdout、AIRI profile、验收数据库或私人聊天正文。
功能通过不改变本节的发布 `FAIL`。
