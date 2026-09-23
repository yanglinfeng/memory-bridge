# AIRI 自动长期记忆系统 PRD

> 产品名称：忆桥 Memory Bridge  
> 文档状态：开发基线  
> 版本：2.3  
> 日期：2026-08-01  
> 目标客户端：AIRI v0.11.3 及后续兼容版本  
> 开发模型基线：`legacy local generation model`  
> 本文中的阶段仅表示安全实施顺序，不缩减最终交付范围。
> P0 范围：本地多账户、同一账户下多个 AIRI persona/聊天对象，以及可信 project 绑定和跨项目隔离，均为发布必需能力。

## 1. 产品结论

忆桥必须从“可由模型调用的长期记忆 CRUD MCP”升级为“独立、自动、可追溯、可治理的长期记忆系统”。

最终用户不需要使用“请记住”“调用记忆工具”等关键词。系统在日常对话中自动完成：

1. 回答前召回相关长期记忆。
2. 回答后异步提取值得长期保存的信息。
3. 对候选记忆进行去重、冲突判断、版本更新和来源绑定。
4. 按会话、主题、人物和项目进行非破坏式巩固与压缩。
5. 在全量记忆中执行混合检索，不因记录超过 1000 条出现正确性断崖。
6. 允许用户检查、确认、修改、撤销、归档、遗忘和物理清除记忆。
7. 允许聊天、提取、重排、embedding 和巩固模型分别替换。
8. 在同一本地实例中安全支持多个账户；同一账户的稳定个人记忆可跨 persona 共享，persona、当前聊天和 project 记忆不得越界。

当前 v1 的 SQLite、MCP、审计、底层 `user_id`/scope 隔离、软删除、备份、语义缓存和 AIRI 适配继续保留。底层字段存在不等于产品能力已经接通；新系统必须补齐可信身份解析、逐请求身份上下文和 AIRI persona 映射，再通过迁移和兼容层演进。

## 2. 背景与问题

### 2.1 当前已验证能力

- AIRI 可调用 `memory_remember`、`memory_recall`、`memory_get_context`、`memory_update`、`memory_forget`、`memory_list` 和 `memory_stats`。
- 显式写入后的记忆可跨会话和进程重启召回。
- 记忆支持修改、替代、软删除、恢复、审计和备份。
- `bge-m3:latest` embedding 与 LLM 严格重排可减少明显误召回。
- 存储层已经能按 `user_id + namespace` 隔离，并能表达 `personal`、`project`、`role`、`session` scope。
- 正式数据库首次运行为空，不包含演示数据。

### 2.2 当前核心缺口

- 普通聊天只把 MCP 工具交给模型选择，不保证每轮召回或写入。
- AIRI v0.11.3 的长期/短期记忆设置仍为 WIP，占位功能不能承担记忆生命周期。
- 可靠召回先按更新时间截取最近 1000 条，旧记忆可能仍在数据库却永远无法进入召回候选。
- `summary`、`importance` 和 `supersedesId` 只是字段或调用原语，没有自动摘要、巩固、冲突解析或周期整理器。
- 只对完全相同的正文做哈希去重，同义改写、部分重叠和矛盾事实可以重复存在。
- 记忆更新直接覆盖当前行，没有完整版本、原始证据和可补偿撤销链。
- embedding 表是缓存，不是全库向量索引。
- 现有测试证明工具链与存储正确，不证明长期自动提取、全库召回质量和大规模性能。
- AIRI 生命周期仍固定使用进程级默认用户，HTTP 只有不绑定账户的全局 Bearer Token；请求体中的 `userId` 不能构成可信账户边界。
- AIRI 请求尚未建立稳定 persona/character ID 契约，自动召回与沉淀也没有接通 `role`、`session` scope。
- 管理、遗忘、按 UUID 修改和检索尚未全部约束在当前可信 principal 内，存在越权或跨 persona 泄漏风险。

### 2.3 产品风险

如果直接给当前系统增加自动写入，记忆条数会快速增长，并放大以下问题：

- 临时闲聊、引用、反讽、假设和第三方事实被错误保存。
- 同一事实产生多个同义版本。
- 新旧信息互相矛盾，模型随机选择。
- 用户已经遗忘的信息从旧对话中重新被提取。
- 摘要幻觉覆盖真实原话。
- 数据量越大，旧信息越难召回。
- 不可信 `userId`、复用全局 Token 或不稳定 persona 名称导致跨账户、跨聊天对象读取或修改记忆。

因此必须先建立可信身份、作用域可见性、证据、版本、候选、冲突和治理机制，再启用完全自动提交。

## 3. 产品目标

### 3.1 用户目标

- 用户自然聊天即可获得跨会话连续体验。
- 用户无需知道 MCP、向量检索或提示词。
- AIRI 能正确记住稳定偏好、身份事实、项目决定、关系、重要事件和长期指令。
- AIRI 能识别事实已经改变，而不是同时相信新旧版本。
- AIRI 能解释“为什么记住”和“为什么这次想起”。
- 用户可以控制敏感信息、保留时间和遗忘范围。
- 同一本机的不同账户互不读取、修改、遗忘或导出对方记忆。
- 同一账户可在多个 AIRI persona 间共享稳定个人事实，同时保留每个 persona 的关系、角色指令和聊天私有记忆。
- 同一账户的不同 project 只共享 personal 记忆，不共享 project 决定、候选、派生摘要或治理操作。

### 3.2 系统目标

- 自动提取高精度优先，错误自动提交率必须极低。
- 原始证据与派生结论分离，所有自动记忆可追溯。
- 规范事实采用版本化更新，不原地丢失历史。
- 检索面向全量有效记忆，不使用按更新时间预截断的正确性捷径。
- 对话主链与后台提取解耦，提取失败不阻塞聊天。
- 模型和索引可替换、可回填、可回滚。
- 派生摘要和索引均可从真相库重建。
- 每次请求、后台任务、审计和治理操作都携带由可信凭据解析出的 principal，而不是信任客户端自报的 `userId`。
- 自动召回联合查询当前 principal 的 `personal/self`、当前 `role/persona_id`、当前 `session/session_id` 和会话已绑定的 `project/project_id`，并在存储查询阶段阻止越界。

### 3.3 非目标

- 本地单实例多账户是 P0；本版本不建设互联网多租户 SaaS、组织/团队 RBAC、计费系统或跨账户共享记忆。
- 本版本不依赖云端数据库、消息队列或必须联网的模型服务。
- 本版本不把 AIRI 的人格、情绪或关系系统写死进通用记忆核心。
- 本版本不自动保存密码、令牌、私钥、验证码或其他凭据。
- 本版本不把模型推断当作未经标记的用户事实。

## 4. 产品原则

1. **证据优先**：用户原话和会话事件是证据，摘要和画像只是派生视图。
2. **少记但记准**：普通信息可留在短期层，长期层只保存稳定且有价值的信息。
3. **非破坏式巩固**：压缩生成新派生项，不覆盖来源事实。
4. **规则优先、模型辅助**：时态、作用域和基数先由确定性规则判断，LLM 只处理语义歧义。
5. **全库可召回**：任何有效记忆都不能因为写入时间较早而失去被检索的机会。
6. **自动化不依赖提示词自觉**：召回与沉淀由生命周期适配器保证。
7. **遗忘优先于再提取**：用户删除后的 tombstone 必须阻止旧证据重新生成相同记忆。
8. **模型可替换**：模型名称、维度、提示版本和输出契约不得渗透进业务真相。
9. **可降级但不伪装**：组件失败时返回明确质量状态，不静默冒充完整召回。
10. **默认本地与最小披露**：仅将回答所需的最少记忆注入当前模型。
11. **身份是安全边界**：principal 只能来自可信认证映射；请求体、模型输出和自然语言中的账户名都不能改变身份。
12. **persona 默认隔离**：共享只发生在同一 principal 的 `personal/self`；persona 与 session 私有记忆默认不可被其他 persona 或会话看见。
13. **稳定 ID，不猜身份**：persona 必须使用 AIRI 稳定元数据或明确适配契约；缺失时 fail closed，不能用显示名、角色提示词或用户文本替代。
14. **project 是不可变运行时绑定**：project 只能来自 AIRI 已注册项目的运行时选择；session 创建后连同 `null` 绑定都不可改变。切换 project 必须新建空白 session，fork 只能继承来源 session 的 project。

## 5. 用户场景

### US-01 自然形成偏好

用户在正常聊天中说“我做新软件时不喜欢内置演示数据”。系统在回答后提取偏好，绑定原始消息证据，并在以后讨论初始化体验时自动召回。

### US-02 事实纠正

用户先说“我主要用 VS Code”，数月后说“我现在已经改用 Cursor”。系统识别为同一作用域下的当前编辑器变化，创建新版本并关闭旧版本的有效期。

### US-03 时间共存

用户说“我以前住杭州，现在住上海”。系统保存两个带时间范围的事实，不把它们错误判断为冲突。

### US-04 模糊与敏感信息

用户以玩笑或不确定语气表达偏好时，系统只创建待确认候选。涉及密码、令牌和验证码时不创建候选。

### US-05 自动召回

用户新建会话直接问“我做软件最在意什么”，系统在模型回答前自动检索并注入相关偏好，不要求用户点名记忆工具。

### US-06 主题巩固

用户长期讨论同一项目。系统保留原子决定和事件，同时生成可重建的项目快照。回答当前状态问题时优先使用快照，并可展开来源。

### US-07 遗忘

用户要求忘记某一事实。系统立即停止所有召回，写入 tombstone，并阻止后台任务从旧聊天重新提取该事实。

### US-08 可解释与撤销

用户可在管理台看到记忆来源、版本、冲突、摘要依据和召回原因，并可撤销自动修改。

### US-09 本地多账户隔离

Alice 与 Bob 使用同一本地忆桥实例。两人可使用相同 namespace、相同谓词甚至相同正文，但任何检索、列表、按 UUID 修改、遗忘、导出、审计和后台任务都只能操作各自 principal 的数据。

### US-10 同账户跨 persona 共享

同一账户分别与 persona A 和 persona B 聊天。用户的稳定身份事实和通用偏好写入 `personal/self`，在两个 persona 中都可召回。

### US-11 persona 私有记忆

用户只对 persona A 建立的关系事实、persona 专属约定和角色指令写入 `role/{persona_id}`。persona B 即使使用同样的问题或显示名，也不能召回、修改或从摘要中推断这些内容。

### US-12 当前聊天私有记忆

只对当前聊天有效的计划、临时上下文和未完成事项写入 `session/{session_id}`。它可覆盖当前回答中的较宽作用域信息，但不能改写 personal 或 persona 的规范事实，也不能泄漏到另一聊天。

### US-13 project 隔离与切换

用户可在 AIRI 创建或选择一个已注册 project。该 project 选择在新聊天创建时固化；同一聊天不能改绑到另一个 project。切换 project 会新建空白聊天，fork 继承原 project。project A 的决定、摘要和候选不能被 project B 或未绑定 project 的聊天召回、纠正或审核。

## 6. 目标架构

```text
AIRI / 其他客户端
        │
        ▼
可信身份解析器
  ├─ HTTP Token → principal
  ├─ MCP stdio 连接 → principal
  └─ AIRI 稳定元数据 → persona / session / project
        │
        ▼
生命周期适配器
  ├─ beforeModel：查询理解、自动召回、上下文注入
  ├─ afterTurn：写入会话账本与 outbox
  └─ explicitIntent：记住、纠正、忘记的同步高优先级路径
        │
        ▼
后台 Worker
  ├─ Extractor：原子 claim、时态、作用域、敏感性
  ├─ Resolver：去重、强化、并存、替代、冲突
  ├─ Indexer：FTS 与 ANN 增量索引
  ├─ Consolidator：会话/主题/人物/项目派生摘要
  └─ Retention：衰减、归档、tombstone、物理清除
        │
        ▼
SQLite 真相库
  ├─ 会话与消息证据
  ├─ 候选记忆
  ├─ 规范记忆与版本
  ├─ 来源关系与事件
  ├─ 治理策略与 tombstone
  └─ outbox / jobs
        │
        ├─ FTS5 派生索引
        └─ ANN 派生索引
```

核心服务保持客户端无关。AIRI 只承担适配职责，不能成为长期记忆真相库。

身份解析器为每次调用生成不可变的 `IdentityContext`：

```text
principal_id + namespace + persona_id? + session_id? + project_id? + credential_id/source
```

生命周期、Worker、索引、管理 API 与审计必须传递该上下文或其不可伪造的任务快照。业务方法不得在同一次请求中回退到另一个全局默认用户。

## 7. 分层记忆模型

### 7.1 工作记忆

- 当前会话最近若干轮和运行时上下文。
- 不进入长期事实库。
- 由 AIRI 或生命周期适配器按 token 预算管理。

### 7.2 证据/情景层

- 保存会话、用户消息、助手回复、工具结果、时间和来源。
- 支持按策略设置 30～90 天 TTL；用户明确保留的事件可延长。
- 助手输出默认不能自动升级为用户事实。

### 7.3 候选观察层

- 存放自动提取的原子 claim。
- 状态：`pending`、`accepted`、`rejected`、`conflicted`。
- 保存提取模型、提示版本、原文片段、置信度、敏感级别和幂等键。

### 7.4 规范长期层

- 保存稳定身份、偏好、项目决定、关系、知识、指令和重要事件。
- 每个记忆项有稳定 ID；正文变化生成新版本。
- 当前版本只是投影，历史版本不可被普通更新覆盖。

### 7.5 派生巩固层

- 会话摘要、主题摘要、人物快照、项目快照和长期洞察。
- 必须绑定来源版本集合及生成模型。
- 来源变化、冲突、遗忘或模型升级时可以失效并重建。

### 7.6 治理层

- 保存保留策略、敏感权限、用户 pin、tombstone、禁止再记规则和物理清除任务。
- 治理记录不进入模型上下文。

### 7.7 身份与可见性层

- principal 是本地账户安全边界；namespace 是该账户内的逻辑记忆空间。
- `personal/self` 对同一 principal 的所有 persona 可见。
- `role/{persona_id}` 只对当前稳定 persona 可见。
- `session/{session_id}` 只对当前聊天可见。
- `project/{project_id}` 仅在客户端明确提供可信项目绑定时加入可见集合，不由模型猜测。
- scope 之间不通过同名、相似正文或 embedding 自动扩权。

## 8. 数据模型要求

### FR-DATA-00 可信身份

新增或演进为：

- `account_principals`
- `auth_credentials`
- `client_persona_bindings`

要求：

- principal 使用不可变内部 ID；可修改的显示名不参与安全判断。
- HTTP 凭据只保存不可逆哈希、状态、创建/轮换/撤销时间和所属 principal，不保存可回显明文 Token。
- AIRI 绑定保存客户端类型、稳定 persona ID、可选显示名和所属 principal；显示名仅用于 UI。
- 会话必须绑定 principal、namespace、persona ID、客户端 session ID 和可空 project ID；绑定建立后不可被后续消息静默改写，`null → project`、`project A → null` 和 `project A → project B` 均视为身份冲突。
- project ID 必须来自 AIRI 本地项目注册表和当前运行时 session；模型输出、turn metadata、聊天正文、显示名和旧 metadata 都不能创建或改写 project 归属。
- 所有真相表、派生索引、outbox/job、tombstone、审计和备份恢复都必须保留 principal 与 scope 归属。
- 旧单用户数据迁移到显式 `default` principal；迁移不得改变现有记忆 UUID。

### FR-DATA-01 会话账本

新增：

- `conversation_sessions`
- `conversation_turns`
- `turn_tool_events`

每个 turn 必须有稳定的客户端 ID 或由会话、角色、内容哈希和序号构造的幂等 ID。工具循环、重试和完整历史重发不能造成重复入账。

每个 session/turn 必须继承已经解析的 principal、namespace、persona、session 和可空 project 绑定；不能从消息正文、请求体 `userId` 或 turn metadata 二次解析身份与 project。

### FR-DATA-02 候选与提取运行

新增：

- `extraction_runs`
- `memory_candidates`

候选至少包含：

- 主体、谓词、值和否定。
- 作用域、类型和时间范围。
- 置信度、重要度和敏感级别。
- 来源 turn、原文片段。
- 提取器、模型和提示版本。
- 规范化哈希和稳定键。

### FR-DATA-03 规范记忆与版本

新增或演进为：

- `memory_items`
- `memory_versions`
- `memory_evidence`
- `memory_edges`
- `memory_events`

每次自动或人工修改必须：

1. 追加版本。
2. 更新当前版本指针。
3. 追加不可变事件。
4. 写入 outbox。

### FR-DATA-04 后台任务

新增：

- `outbox_events`
- `memory_jobs`
- `dead_letter_jobs`

任务必须支持租约、重试、指数退避、幂等执行、失败原因和可见积压。

### FR-DATA-05 治理

新增：

- `retention_policies`
- `memory_tombstones`
- `purge_jobs`

用户遗忘后必须先写 tombstone，再清理召回索引，避免竞争窗口内复活。

### FR-DATA-06 兼容投影

现有 `memories` 表在迁移期作为当前版本兼容投影，七个 MCP 工具继续可用。旧数据回填为 `legacy` 来源的 v1 版本。

## 9. 自动摄取与生命周期

### FR-INGEST-00 逐请求身份解析

- HTTP/AIRI 请求先认证，再解析 principal；业务 JSON 中的 `userId` 只能在受信任的迁移工具中使用，普通 API 必须忽略或拒绝。
- AIRI persona 只接受经适配器白名单声明的稳定字段。字段缺失或发生冲突时不得读取或写入 `role` scope，并返回可观测的降级原因。
- session 使用 AIRI 稳定 conversation/session ID；若缺失，只能创建该连接生命周期内不可复用的临时 session，不能与历史 session 自动合并。
- project 使用可选 `x-airi-project-id`，且只在创建 session 时绑定；服务端必须在召回前事务性创建或校验该绑定，任何中途变化返回冲突并保证零召回、零模型调用、零 turn/outbox 副作用。
- AIRI 切换 project 必须创建全新的空白 session；fork 只能复制来源 session 的 project，不能在 fork 时选择或覆盖 project。旧 session 不得从 metadata 猜测或回填 project。
- MCP stdio 的一个连接可由启动配置固定为一个可信 principal；工具参数不得在连接内切换 principal。
- 解析出的 `IdentityContext` 必须写入 turn、outbox 和 job，Worker 不得使用启动时默认用户替代任务所属用户。

### FR-INGEST-01 回答前自动召回

- 每个普通用户回合在模型生成前自动执行查询理解与记忆召回。
- 不依赖模型选择 MCP 工具。
- 召回必须显式携带当前 principal、namespace、persona 和 session，并使用 FR-RETRIEVE-01 定义的可见 scope 集合。
- project scope 只能读取当前结构化 `conversation_sessions.project_id`；turn metadata、候选 scopeKey 和模型文本都不是可信 project 来源。
- 召回失败必须设置 `qualityState=degraded` 或 `unavailable`。
- 注入内容包含记忆 ID、版本 ID和来源摘要，不能只有无来源文本。

### FR-INGEST-02 回答后异步沉淀

- 完整回复产生后只同步写入 turn 与 outbox。
- 提取、去重、冲突和 embedding 在后台执行。
- 后台故障不得增加聊天首字延迟或阻断用户继续对话。
- 提取器必须输出 scope 决策：稳定用户事实和通用偏好默认进入 `personal/self`；persona 专属关系/约定/角色指令进入 `role/{persona_id}`；仅当前聊天有效的信息进入 `session/{session_id}`。
- 当所需稳定 persona/session ID 不存在时，相应私有候选只能进入待确认/隔离状态，不得错误降级写入 personal。

### FR-INGEST-03 显式意图快车道

“记住”“纠正”“忘记”及语义等价表达走高优先级同步路径：

- 明确记住：写入证据和候选，满足安全策略时立即提交。
- 明确纠正：查询稳定键和旧版本后创建新版本。
- 明确忘记：立即写 tombstone 并停止召回。

### FR-INGEST-04 提取安全规则

禁止自动保存：

- 密码、令牌、私钥、验证码、会话 Cookie。
- 纯助手生成且未经用户确认的事实。
- 明确引用的第三方观点作为用户本人事实。
- 假设、反讽、否定和角色扮演内容，除非分类器能证明其真实语义。
- 临时错误、一次性请求和无长期价值闲聊。

### FR-INGEST-05 自动提交门槛

- 明确用户陈述、非敏感、结构完整且高置信的稳定事实可自动提交。
- 推断偏好、歧义、敏感或可能冲突的内容进入待确认收件箱。
- 自动提交 precision 低于验收门槛时系统必须回退为 shadow 或待确认模式。

## 10. 去重、冲突与版本

### FR-RESOLVE-01 解析顺序

1. 规范化后的精确值。
2. 稳定键：`principal + namespace + subject + predicate + scope_type + scope_key`。
3. embedding 近重复候选。
4. 规则/NLI/LLM 判断：
   - `equivalent`
   - `reinforces`
   - `supersedes`
   - `contradicts`
   - `coexists`

### FR-RESOLVE-02 谓词规则

谓词注册表至少声明：

- 单一当前值：当前住址、当前职位、当前编辑器。
- 多值集合：语言、兴趣、合作关系。
- 时间事件：可以并存。
- 作用域规则：personal、project、persona(role) 和 session 相互隔离；不同 scope 的同一谓词不得互相 supersede。

### FR-RESOLVE-03 决策

- 等价：不新建有效记忆，只增加 evidence 和观察次数。
- 强化：重新计算置信度，不能简单取历史最大值。
- 明确纠正：创建新版本，关闭旧版本有效期。
- 时间或作用域不同：并存。
- 同范围矛盾但无明确纠正：标记冲突，不自动覆盖。
- 用户直接陈述的权威度高于助手推断。

### FR-RESOLVE-04 并发与撤销

- 更新使用 revision 乐观锁。
- 撤销通过追加补偿版本完成，不回写或删除历史。
- 恢复已删除记忆时重新经过 tombstone 和冲突解析。

## 11. 巩固、压缩与衰减

### FR-CONSOLIDATE-01 触发

- 会话结束。
- 同一主题的候选达到阈值。
- 热层冗余率超过阈值。
- 定时空闲任务。
- 来源事实发生修改、冲突或删除。

### FR-CONSOLIDATE-02 非破坏式摘要

- 巩固生成新的派生记忆，不覆盖原子事实。
- 保存来源版本 ID 集合、集合哈希、模型、提示版本和生成时间。
- 摘要逐句必须能映射到至少一个有效来源。
- 无来源陈述进入隔离区，不参与召回。

### FR-CONSOLIDATE-03 失效与重建

- 任一来源修改、删除或冲突时，相关摘要标记 stale。
- Worker 增量重算 stale 摘要。
- 模型升级可双跑新旧摘要并原子切换。

### FR-CONSOLIDATE-04 分级衰减

- profile、用户 pin 和明确长期 instruction 默认不自动衰减。
- 临时状态、计划和普通事件按类型使用不同半衰期。
- 低权重先归档，不静默物理删除。
- `retrieved`、`used`、`confirmed`、`rejected` 分开统计，单纯被返回不能强化记忆。

### FR-CONSOLIDATE-05 压缩质量

- 冗余场景中热候选数量至少减少 60%。
- Recall@10 相对未巩固基线下降不超过 1 个百分点。
- 严重无来源摘要为 0。

## 12. 全库检索

### FR-RETRIEVE-01 候选生成

对全体有效规范记忆和有效派生摘要并行执行：

- FTS5/BM25。
- ANN 向量召回。
- 实体和关系扩散。
- 时间、namespace、kind、作用域和有效期过滤。

禁止先按 `updated_at` 截取固定数量再进行语义搜索。

每次 AIRI 自动召回的可见集合必须由可信身份上下文确定：

1. `personal/self`
2. 当前 persona 存在时的 `role/{persona_id}`
3. 当前 session 存在时的 `session/{session_id}`
4. 客户端显式绑定项目时的 `project/{project_id}`

principal、namespace 与 scope 过滤必须进入 FTS、ANN、关系扩散和真相库 SQL 的候选生成阶段，不能先跨账户取候选再在应用层过滤。缺失 persona/session 时不加入对应 scope。

### FR-RETRIEVE-02 融合

- 各检索通道取 40～80 个候选。
- 使用 RRF 或经过评测的确定性融合。
- 使用稳定键消除重复和已解决冲突。
- 使用 MMR 或等价方法保持候选多样性。
- 同一语义在多个可见 scope 中冲突时，仅对本次回答采用 `session > role/persona > project > personal` 的就近优先级；该优先级不得自动关闭、覆盖或改写较宽 scope 的规范版本。
- 融合结果必须保留 scope 来源；任何跨 principal、跨 persona 或跨 session 候选都作为安全错误记录，不能作为低分结果返回。

### FR-RETRIEVE-03 重排与上下文

- 对前 15～20 条执行一次批量重排，禁止默认逐条串行调用生成式大模型。
- 最终选取 5～8 条。
- 默认上下文预算 1200～2000 token，可按模型窗口配置。
- 每条结果包含词面、向量、时间、重要度、冲突和重排解释。

### FR-RETRIEVE-04 索引生命周期

- 写入后异步增量生成 embedding。
- FTS 可在 embedding 完成前提供高精度召回。
- embedding 记录模型、维度、文本哈希和版本。
- 模型升级使用双索引回填和原子别名切换。
- 索引损坏可从 SQLite 真相库重建。

### FR-RETRIEVE-05 质量状态

返回：

- `full`
- `degraded`
- `unavailable`

严谨模式可在语义组件不可用时拒绝注入；可用性模式只允许高精度 FTS 降级，并必须显式标记。

## 13. 模型策略

### FR-MODEL-01 角色隔离

分别配置：

- 聊天模型。
- 提取模型。
- 冲突/NLI 模型。
- 巩固模型。
- embedding 模型。
- reranker。

任何角色都不得在数据表或业务规则中硬编码具体模型名称。

### FR-MODEL-02 开发配置

开发阶段默认：

- 聊天：`legacy local generation model`
- 提取：`legacy local generation model`
- 冲突辅助：`legacy local generation model`
- 巩固：`legacy local generation model`
- embedding：`bge-m3:latest`
- 重排：`legacy local generation model` 批量判断或小型专用 reranker

单元测试使用确定性 fake provider；真实模型集成测试单独运行。

### FR-MODEL-03 生产替换

- 更换生成模型不需要迁移规范记忆。
- 更换 embedding 通过新索引版本后台回填。
- 每次模型升级必须在固定评测集达到质量门槛后才能切换。
- 所有自动生成项保存模型和提示版本。

## 14. 隐私、遗忘与安全

### FR-GOV-01 记忆控制

管理台支持：

- Pin。
- 归档与恢复。
- TTL。
- “不要再记这个”。
- 软删除。
- 物理清除。
- 导出与恢复。

### FR-GOV-02 Tombstone

- 用户遗忘后立即从所有召回路径排除。
- tombstone 参与候选解析，阻止旧对话重新生成同义事实。
- 用户明确恢复时必须重新确认并记录事件。

### FR-GOV-03 物理清除

物理清除覆盖：

- 原始正文和原文片段。
- 候选、版本与 evidence。
- embedding、FTS 和 ANN。
- 派生摘要与缓存。
- 可恢复备份中的内容或其解密密钥。

审计只保留不含正文的时间、动作和不可逆哈希。

### FR-GOV-04 最小披露

- 只把当前回答需要的记忆注入模型。
- 管理 API 默认仅监听 loopback。
- 日志不得输出完整敏感正文。
- 未来接入云模型时必须在 UI 明确展示数据离开本机的边界。

### FR-GOV-05 账户认证与越权防护

- 多账户 HTTP 模式使用 Token → principal 的可信映射；一个 Token 只能代表一个 principal。
- Token 验证使用保存的哈希并采用恒定时间比较；Token 明文不得进入数据库、日志、错误响应或前端持久化。
- 请求体、查询参数和模型工具参数不能覆盖已认证 principal。显式传入冲突 `userId` 时必须拒绝并审计。
- 列表、检索、按 UUID 读取/修改/遗忘、候选审核、导出、恢复、备份和物理清除都必须同时约束 principal。
- 未认证的单用户兼容模式仅允许 loopback，并固定映射到迁移后的 `default` principal；启用多账户凭据后不得静默回退。
- 撤销或轮换凭据应立即阻止新请求，不影响该 principal 已有记忆的所有权。

### FR-GOV-06 可信备份恢复

- 备份中的 `schemaVersion` 只描述数据格式，不能证明 persona、session、project 或 `identity_status=complete` 的可信来源。
- 携带可信身份绑定的完整备份只能在目标库已有同一 owner、client、external session、namespace、persona、project 和身份状态的不可变可信绑定时恢复；核对必须在导入写事务内、任何目标数据删除前完成。无法证明时必须 fail closed，并要求离线人工 quarantine/rebind。
- schema `<25` 的 persona/身份字段必须降级为 legacy/null；schema `<26` 的任何 project scope 或 project 绑定必须在删除目标数据前拒绝，不能通过自报版本、伪造字段或改写 stable key 提权。
- 导入前必须验证兼容投影、规范 item、current version 的 owner、namespace、kind、status 与 scope 完全一致，并验证 candidate、action、evidence、turn、session 及 project 绑定的完整引用和归属链。
- 目标数据替换和必需的 Dense 重建任务必须原子提交；提交后的调度问题只能作为明确可恢复警告返回，不能把已经替换成功的数据报告为整体导入失败。

## 15. 管理台

### FR-UI-01 记忆库

明确显示当前账户、namespace、persona/session 作用域筛选，以及当前规范记忆的状态、类型、重要度、置信度、有效期和来源数量。前端筛选不能代替服务端 principal 约束。

### FR-UI-02 待确认收件箱

显示 pending、conflicted 和敏感候选，支持接受、修正、拒绝和“以后不要再记”。

### FR-UI-03 版本与证据

显示：

- 原始引用和会话/turn。
- 所有版本与替代关系。
- 自动提取模型和提示版本。
- 摘要来源图。
- 修改、撤销和遗忘事件。

### FR-UI-04 召回解释

显示每次召回：

- 查询。
- 候选通道和分数。
- 被过滤原因。
- 实际注入的记忆和版本。
- 质量状态和索引水位。

### FR-UI-05 系统健康

显示：

- 提取队列积压。
- dead letter。
- FTS/ANN 索引状态。
- 模型可用性。
- 最近自动化延迟。
- 降级和错误率。

### FR-UI-06 账户、persona 与 project

- 显示当前认证账户和凭据状态，但永不显示完整 Token。
- 列出该账户已绑定的 AIRI persona 稳定 ID、显示名、最近会话和私有记忆数量。
- 支持查看 personal、当前 project、当前 persona 和当前 session 的召回组合及优先级。
- persona 重命名只更新显示名；合并、转移或删除绑定属于显式治理操作，必须预览影响并写审计事件。
- 支持创建、选择和查看本地 project 稳定 ID；已被 session 使用的 ID 不随显示名变化。切换 project 的交互必须明确创建空白聊天，fork 入口不得提供 project 覆盖选项。

## 16. 兼容性与迁移

### MIG-01 数据迁移

1. 迁移前自动备份现有 SQLite。
2. 创建 `default` principal，新表旁路创建，旧 `memories` 每条按原有 user/namespace 回填为对应 principal 下的 legacy v1。
3. 原有 UUID 保持稳定。
4. 迁移脚本可重复运行且幂等。
5. 任一步失败时事务回滚，原库继续可用。
6. 旧配置在 loopback 单用户模式下保持可用；启用多账户后必须通过显式 Token→principal 配置或管理流程迁移。
7. v26 不从旧 session metadata 回填 project。旧库任一访问控制表存在 `scope_type='project'` 时必须 fail closed、保留迁移前备份并完整回滚；只能通过离线人工 quarantine/rebind 明确归属后再迁移，禁止自动猜测或批量改写 scope/stable key。
8. `PRAGMA user_version` 不是结构证明：高于当前版本必须拒绝；等于当前版本仍须验证必需结构和访问控制不变量，不能因伪造版本跳过检查。
9. 迁移前备份必须在阻止并发写的迁移屏障内取得一致快照；若迁移因最后一笔已提交写入而 fail closed，保留的备份必须包含该写入。

### MIG-02 双写与 Shadow

1. 旧 MCP API 保持不变。
2. 新写入同时产生版本、事件和兼容投影。
3. 自动提取先以 shadow 模式运行，只生成报告和待确认候选。
4. 新旧召回并行比较，不立即影响 AIRI 回答。
5. 达到质量门槛后按 namespace 开启自动提交和新召回。

### MIG-03 AIRI 适配

- 优先使用稳定生命周期插件接口。
- 当前版本使用兼容代理捕获请求和完整响应。
- 必须识别 streaming、工具循环、重试和历史消息重发。
- AIRI 到忆桥的 v1 凭据为 `Authorization: Bearer <account token>`。每个聊天请求必须由运行时生成四个身份头：`x-memory-bridge-context-version: 1`、`x-airi-character-id`、`x-airi-session-id`、`x-airi-round-id`；已绑定 project 时额外发送保留可选头 `x-airi-project-id`。
- 上述五个 `x-*` 保留头必须先从用户自定义 provider headers 中剥离，再由 AIRI 可信运行时生成；用户配置、插件透传和请求体不得覆盖、重复或伪造它们。
- 适配器必须输出经过契约验证的 stable persona ID 与 session ID；AIRI 未提供稳定 persona ID 时，应补扩展字段/插件桥接，不能把显示名当 ID。
- AIRI 必须提供本地 project 注册表及创建/选择入口。project 选择只在新 session 创建时写入；切换 project 新建空白 session，fork 继承原绑定。
- AIRI 只有在用户显式启用 Memory Bridge identity 模式且目标为 loopback 忆桥地址时才能发送上述角色/会话头；普通 custom provider 和远程兼容端点默认不得收到这些本地身份标识。
- 忆桥消费身份头后不得继续向 Ollama 或其他模型 provider 转发；请求体中的 `userId`、`character_id`、`conversation_id` 只能用于诊断，不能覆盖可信契约。
- 旧 AIRI 配置默认绑定 `default` principal；多账户部署为每个受信任客户端配置独立凭据。
- 适配器失败时不能破坏普通聊天。

## 17. 非功能要求

### NFR-01 容量

- 10 万条有效规范记忆。
- 100 万 conversation turns。
- 最相关记录位于最老位置、第 1001 条和第 10001 条时仍能召回。

### NFR-02 延迟

在验收参考硬件上分别报告冷、热数据：

- 10 万条候选生成 P95 ≤ 200 ms。
- 非 LLM 完整检索 P95 ≤ 350 ms。
- warm 重排与上下文构建 P95 ≤ 2 s。
- 自动提取不计入聊天首字延迟。

### NFR-03 持久性

- 已提交 turn/event 在 `kill -9` 后零丢失。
- outbox 重放不产生重复副作用。
- 索引可校验并重建。
- SQLite busy 不得造成静默丢操作。

### NFR-04 可观测性

至少记录：

- extraction lag。
- pending/conflict 比率。
- 有效重复率。
- index lag。
- 召回通道、注入和使用反馈。
- 降级率、撤销率和 tombstone 拦截次数。
- 任务重试和 dead letter。

## 18. 质量与验收

### AC-01 自动提取

- 自动提交 precision ≥ 98%。
- 候选提取 recall ≥ 90%。
- 凭据自动保存为 0。
- 引用、反讽、否定、假设和第三方事实负例通过。

### AC-02 去重与冲突

- 有效语义重复率 < 1%。
- 同范围矛盾事实静默覆盖为 0。
- 明确纠正能创建新版本并关闭旧有效期。
- 不同时间或作用域的事实可正确共存。

### AC-03 检索

- 标注集 Recall@20 ≥ 95%。
- MRR@10 ≥ 0.85。
- 当前值冲突解析准确率 ≥ 98%。
- 最老、第 1001 和第 10001 条回归样本必须命中。
- 删除和过期记忆不得进入默认召回。

### AC-04 巩固

- 每个派生摘要句子均有有效 evidence。
- 严重无来源陈述为 0。
- 热候选压缩率 ≥ 60%。
- Recall@10 损失 ≤ 1 个百分点。
- 来源变化后摘要可自动失效并重建。

### AC-05 遗忘

- 用户遗忘后立即不召回。
- 旧聊天不能重新提取已 tombstone 的事实。
- 物理清除任务在 5 分钟内覆盖正文、索引和缓存。

### AC-06 可靠性

- 10 个并发会话、2 个 Worker 连续运行 30 分钟无丢操作。
- kill/restart 后任务可恢复且无重复记忆。
- 提取、索引或模型故障不阻塞普通聊天。

### AC-07 真实 AIRI

必须通过不带“请记住”关键词的真实流程：

1. 在普通聊天中自然提及稳定偏好。
2. 结束会话并等待后台提取。
3. 新建会话自然提问，AIRI 自动召回并正确回答。
4. 自然纠正该偏好，新版本替代旧版本。
5. 新会话只回答新值。
6. 自然要求遗忘。
7. 重启 AIRI、忆桥和 Ollama 后仍无法召回。
8. 管理台可追溯全过程的 turn、候选、版本、证据、召回和 tombstone。

### AC-08 模型替换

- 开发基线全部使用 `legacy local generation model` 完成真实验收。
- 替换聊天、提取或巩固模型不需要迁移规范记忆。
- 替换 embedding 后能后台双索引回填并切换。

### AC-09 多账户、多 persona 与 project

- 同库 Alice/Bob 至少各 100 条、包含相同 namespace/谓词/正文的夹具中，双方召回 precision/隔离率均为 100%，跨账户返回为 0。
- 使用另一 principal 的 UUID 执行读取、修改、遗忘、恢复、候选审核、导出和物理清除必须全部拒绝，且不泄漏对象是否存在。
- 同一账户的 persona A 与 B 都能召回 `personal/self`；A 的 `role/persona-A` 在 B 中返回为 0，B 的私有记忆在 A 中返回为 0。
- `session/chat-A1` 不得出现在 `chat-A2`；同一谓词发生冲突时当前回答遵循 `session > role/persona > project > personal`，但各 scope 原始版本保持不变。
- 同一账户的 project A、project B 和无 project session 三者互相隔离；project ID 在 session 内任何 `A→B`、`A→null`、`null→A` 变化都必须返回冲突并产生零召回、零模型、零 turn/outbox。
- project 切换必须创建空白 session，fork 只能继承原 project；旧 metadata、模型输出和自定义 header 不能伪造 project 绑定。
- 缺失、伪造或中途变化的 persona ID 不得读取/写入 role scope；显示名相同的两个稳定 persona ID 仍必须隔离。
- HTTP Token 不得通过请求体 `userId` 冒用其他账户；撤销 Token 后访问立即失败。
- 旧单用户 loopback/MCP 配置及既有 UUID 回归测试通过。
- 真实 AIRI 至少用同一账户两个 persona、两个 project 和两个以上聊天完成 personal 共享、persona/project/session 私有、纠正、遗忘、project 切换新建空白 session 与 fork 继承闭环；不能用 curl、伪造 HTTP 或 MCP 工具调用代替。

## 19. 固定评测集

评测集至少覆盖：

- 同义改写与部分重叠。
- 当前事实与历史事实。
- 明确纠正和隐含变化。
- 多值偏好与单值属性。
- 否定、反讽、假设、引用和第三方事实。
- 临时状态与长期偏好。
- 跨 namespace 和项目作用域。
- 跨账户同 namespace、同谓词、同正文的泄漏负例。
- 同账户 personal 共享、persona A/B 私有、同名 persona 不同稳定 ID、session A1/A2 隔离。
- 缺失、伪造、中途变化 persona ID 和请求体冒用 `userId`。
- project A/B/未绑定隔离、session 内改绑、fork 继承、旧 metadata 伪造和五个保留身份头覆盖。
- 敏感信息和凭据。
- 删除后从旧证据再提取。
- 摘要失真和来源变化。
- 索引延迟、模型不可用和降级路径。
- 记录位于第 1001、第 10001 和最老位置。

## 20. 实施顺序

### 阶段 A0：可信身份与作用域基础

- principal、凭据哈希与 Token→principal 解析。
- AIRI stable persona/session/project 契约与不可变绑定。
- request-scoped `IdentityContext` 贯穿 HTTP、生命周期、Worker、审计和治理。
- personal + persona + session + project 联合召回及 fail-closed 安全测试。
- 旧单用户 `default` principal 兼容迁移。

### 阶段 A：真相与执行基础

- schema v5+。
- turn ledger、candidate、version、evidence、event、outbox、job、tombstone。
- legacy 迁移、备份和兼容投影。

### 阶段 B：自动生命周期

- AIRI 请求/回复捕获。
- 回答前自动召回。
- 回答后异步提取。
- 显式意图快车道。
- shadow 模式和幂等重放。

### 阶段 C：规范化与冲突

- 稳定键和谓词规则。
- 语义去重。
- equivalent/reinforces/supersedes/contradicts/coexists。
- 版本、撤销和待确认收件箱。

### 阶段 D：全库检索

- FTS5。
- 嵌入式 ANN。
- 混合召回、融合、批量重排和 token 预算。
- 双索引、重建和质量状态。

### 阶段 E：巩固与治理

- 会话、主题、人物和项目摘要。
- 来源支持验证。
- 分级衰减和归档。
- tombstone 与物理清除。
- 管理台解释和健康状态。

### 阶段 F：全面验收

- 单元、集成、属性和故障注入测试。
- 多账户 IDOR、跨 persona/session/project 泄漏、session 改绑和身份降级故障注入。
- `legacy local generation model` 真实模型评测。
- 10 万记忆与 100 万 turn 规模基准。
- 真实 AIRI 无关键词闭环。
- 独立审查 PRD 覆盖度、数据一致性和验收证据。

## 21. 发布门槛

只有同时满足以下条件，项目才可声明为“完整 AIRI 自动长期记忆系统”：

- 本 PRD 的 P0/P1 功能要求全部实现，不以文档或占位 UI 代替。
- 本地多账户、personal 共享、persona/session/project 私有隔离通过 AC-09；不存在以全局 Token、请求体 `userId`、显示名、旧 metadata 或自定义 header 冒充可信身份/project 的路径。
- 所有自动化和规模验收有可复现命令、数据与结果。
- 真实 AIRI 无关键词闭环及双 persona/双 project/多聊天闭环通过。
- 正式数据库不包含演示或验收数据。
- 旧 MCP 用户和现有 UUID 兼容。
- 迁移、备份、恢复、重建和回滚经过测试。
- 当前限制和未达到的指标全部显式披露。
- 独立复审结论为 PASS。

## 22. 参考与取舍

Ackem 的逐轮异步摄取、事实/情景/知识分层、混合召回、衰减和巩固是设计参考，但不作为代码依赖：

- 项目年轻且记忆核心缺少充分自动化测试。
- 未提供可信的大规模检索和延迟基准。
- 许可证文本和 AGPL/商业授权边界需要单独确认。
- 其 Electron 应用内部结构不适合作为通用 MCP 记忆服务边界。

忆桥采用 clean-room 实现，只借鉴公开架构思想，不复制 Ackem 代码。
