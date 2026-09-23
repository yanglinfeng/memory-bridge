# AIRI 接入与验收

本文面向 AIRI 0.11.x。AIRI 界面和 MCP 配置格式以后可能变化，管理台生成的本机路径应作为当前实例的准确信息。

使用 Pinokio 的用户先按[一键安装与操作手册](one-click-installation-and-operation.md)
完成安装。Pinokio 使用动态端口，本文出现的 `3789` 只是源码默认值，实际接入必须
复制管理台“AIRI 接入”页面显示的 Base URL。

当前存在两条接入路径，必须区分：

- **兼容路径**：AIRI 0.11.x 继续使用 OpenAI-compatible 生命周期代理和 MCP。它能运行
  自动记忆，但 AIRI 本地历史与忆桥会话账本仍是双权威。
- **目标路径**：AIRI/宝豆改用 schema 36 Conversation API，只保留可重建缓存和待发送
  outbox，由忆桥统一保存会话、消息、round、当前上下文和长期记忆。

本仓库已经提供目标路径的服务端 API；AIRI/宝豆客户端的冷启动恢复、带 Bearer 的
fetch SSE、缓存降权、影子对账和真机切换仍需在对应客户端仓库完成。在此之前不能把
“服务端已具备”表述成“App 已完成单一会话权威切换”。

第一次运行先看[快速开始](quick-start.md)；页面位置和按钮见
[界面使用手册](ui-guide.md)。

## 1. 构建忆桥

```bash
npm install
npm run build
ollama pull qwen2.5:14b
ollama pull bge-m3:latest
MEMORY_BRIDGE_AUTOMATION_MODE=auto npm start
```

`auto` 是无关键词自动长期记忆所需的提交模式。首次评估新模型或新
namespace 时可以省略该变量，以默认 `shadow` 模式观察候选；这时系统
不会自动把候选升级为规范长期记忆。

单独检查 MCP：

```bash
npm run mcp:built
```

该命令启动 stdio 服务后会等待 MCP 消息，终端没有普通输出是正常现象，按 `Ctrl+C` 退出。

## 2. 在 AIRI 添加 MCP

打开 AIRI：

```text
设置 → 机体模块 → MCP
```

管理台“AIRI 接入”页面会生成类似下面的配置：

```json
{
  "mcpServers": {
    "memory-bridge": {
      "command": "/你的/node/绝对路径",
      "args": [
        "/你的/项目绝对路径/dist/server/mcp-stdio.js"
      ],
      "env": {
        "MEMORY_BRIDGE_DATA_DIR": "/你的/项目绝对路径/data",
        "MEMORY_BRIDGE_USER_ID": "default",
        "MEMORY_BRIDGE_NAMESPACE": "personal",
        "MEMORY_BRIDGE_SEMANTIC_MODE": "required",
        "MEMORY_BRIDGE_OLLAMA_URL": "http://127.0.0.1:11434",
        "MEMORY_BRIDGE_EMBED_MODEL": "bge-m3:latest",
        "MEMORY_BRIDGE_RERANK_MODEL": "qwen2.5:14b"
      }
    }
  }
}
```

使用管理台生成的真实路径，不要照抄上面的示意路径。运行连接测试，然后“应用并重启”。

Pinokio 菜单“生成 MCP 配置”会把默认账户配置写到
`state/receipts/mcp-config.json`。第二个及更多账户应删除
`MEMORY_BRIDGE_USER_ID`，改用该账户专用的 `MEMORY_BRIDGE_MCP_TOKEN`，否则多个
AIRI profile 会错误地落到同一账户。

`required` 模式不会在 Ollama 或模型不可用时退回旧的宽松词面召回，而会返回明确错误，避免把无关记忆当成用户事实。首次召回会生成并持久化语义向量，后续进程重启会复用缓存。

## 3. 兼容路径：启用自动生命周期

AIRI 聊天模型默认为 `qwen2.5:14b`，可通过
`MEMORY_BRIDGE_AIRI_CHAT_MODEL` 独立更换。AIRI 中选择的模型名必须与该配置完全一致。
OpenAI-compatible Base URL 使用管理台给出的兼容地址，默认是：

```text
http://127.0.0.1:3789/ollama-compat/v1
```

若已经在管理台创建 `mb1.…` 凭据，把它填入 AIRI 该模型提供方的 API Key 字段；
忆桥会把它作为 Bearer credential 绑定到同一 principal。不要把 Token 放进 Base URL、
角色卡或聊天正文。MCP 和兼容模型代理必须使用同一账户身份。

启动与 Stop 探针可匿名读取 `GET /api/health`，其响应固定只有 `ok`、
`service`、`version` 和 `mcpTransport`，不包含 AIRI 模型或兼容地址。
需要核对 `airiChatModel` 和 `airiOllamaCompatBaseUrl` 时，应携带账户凭据读取
受保护的 `/api/config`。

这个地址不是普通的模型转发器。兼容层对每个最终用户回合执行：

1. `beforeModel`：把当前用户问题写入召回查询，在全库执行混合检索，并将最少量相关记忆注入当前模型上下文。
2. `afterTurn`：只有最终回复已成功交付时，才原子记录用户/助手 turn 和 outbox。
3. Worker：异步执行提取、去重、冲突解析、版本更新、索引和巩固，不阻塞聊天首字。
4. `explicitIntent`：自然语言表达“记住、改成、不要再记”等语义时走同步高优先级路径。

因此不需要在角色卡中添加“请主动调用记忆工具”的提示词，也不要求用户说“请记住”。如果 AIRI 绕过该 Base URL 直接连接 Ollama，自动生命周期不会运行。

AIRI 0.11.3 的 MCP 工具仍可用于兼容和人工操作。它内部使用 `builtIn_mcpCallTool` 包装子工具；兼容层会把七个忆桥工具展开为 14B 可理解的严格别名：

- `memory_bridge_memory_remember`
- `memory_bridge_memory_recall`
- `memory_bridge_memory_get_context`
- `memory_bridge_memory_update`
- `memory_bridge_memory_forget`
- `memory_bridge_memory_list`
- `memory_bridge_memory_stats`

模型返回工具调用时，兼容层会折回 AIRI 需要的双层格式并严格校验参数。自动闭环的权威证据反而应当是 `memoryAliasCount=0`、`toolCallCount=0`，同时 SQLite 出现 recall、turn、candidate、version 或 tombstone；这证明记忆来自生命周期，而不是测试提示词强迫模型调用工具。

### 3.1 身份头、结果修复和追踪

AIRI 运行时应为每轮生成以下保留头，不要把它们作为普通自定义头手工伪造：

- `x-memory-bridge-context-version: 1`
- `x-airi-character-id`
- `x-airi-session-id`
- `x-airi-round-id`
- `x-airi-project-id`（已绑定 project 时）

前四个构成完整 v1 身份；project 为可选的不可变绑定。完整身份缺失时服务
fail closed 为 `degraded`，只读 `personal/self` 且不写生命周期证据；已绑定身份
冲突返回 409。

用户实际看到的回答有四种边界：

- 可信私有事实召回：`根据长期记忆：……` 前缀。
- 私有事实 full 零召回：精确 `不知道。`。
- 角色/指代不唯一：返回澄清问句，不猜测。
- 世界知识和建议：正常使用聊天模型回答，不被误伤为弃答。

每个 chat completion 可从响应头读 `x-memory-bridge-request-id`；产生召回后
还有 `x-memory-bridge-trace-id`。当回答不满意时，保存这两个 ID，再按
[召回日志排障](retrieval-logging.md#12-airi-回答层的召回修复)关联 compat audit 和 SQLite 九阶段 trace。

## 3.2 目标路径：Conversation API

目标客户端使用同一枚专用 Bearer credential，但不再向模型接口上传完整聊天历史。
推荐启动顺序：

1. `PUT /api/personas/{personaId}/chat-profile` 同步角色聊天档案。
2. 有 project 时先 `PUT /api/projects/{projectId}/binding`；无 project 保持 `null`。
3. `POST /api/conversations` 创建会话，持久化返回的 conversation ID。
4. `POST /api/conversations/{id}/messages` 只提交 `clientMessageId`、本轮 `text`、空
   `attachments` 和可选 `clientSentAt`，并要求 `Accept: text/event-stream`。
5. 按 `turn.accepted`、`turn.stage`、`assistant.delta`、`assistant.action` 和 terminal
   event 渲染。客户端不能把 action 拼回聊天正文。
6. 断线后使用 `GET /api/conversations/{id}/rounds/{roundId}` 查询权威结果；如事件仍在
   保留期内，可带 `Last-Event-ID` 重连 round events。
7. 冷启动先分页读取会话/消息，再从 `GET /api/conversations/changes` 的 HMAC cursor
   增量追平。缓存冲突时以服务端资源 version、message sequence 和 change sequence 为准。

浏览器原生 `EventSource` 不能在所有目标环境可靠设置 Bearer header。AIRI 客户端应使用
支持 header 和流式读取的 authenticated `fetch`，解析 SSE；不能把 Token 放进 URL。

同一会话只有一个非终态 round。客户端收到 `ROUND_IN_PROGRESS`、网络超时或未知结果时，
应复用原 `clientMessageId` 查询/重连，不能生成新 ID 自动重发。服务重启后过期执行会
收敛为 `interrupted`；只有用户明确重试时才创建新 attempt，用户消息不会重复。

服务端会在流式阶段分离展示正文与 emotion/motion 动作。当前句子、未闭合 ACT 或可疑
协议前缀先缓冲，只有可证明安全的完整句子才作为 delta 发布。最终正文与已发布 delta
不一致时，round 以 `ASSISTANT_PROTOCOL_INVALID` 失败，不写 assistant 权威消息。

### 3.2.1 历史迁移与去权威化

旧 AIRI 本地历史不能直接删除。每个账户分别执行：

1. 导出只含 user/assistant 的 session、message、round 稳定 ID、正文和时间。
2. 以稳定 `importId`、`dryRun=true` 分批调用 `POST /api/conversations/import`；记录每批
   receipt 和输出 cursor，直到 last batch。
3. 从 `batchCursor=null` 重新开始同一 `importId` 的 commit lane；不要复用 dry-run cursor。
4. 重复 commit 同一批，确认 created=0 且 matched 稳定；再比较会话数、消息数、首尾消息
   hash 和抽样正文。
5. 开启影子读取：界面仍读旧库，但后台对比忆桥分页/change feed，不允许双写修正数据。
6. 对账和重启恢复通过后，把本地库降级为可清空缓存；保留回滚开关，暂不物理删除旧库。

导入 turn 默认不排自动提取任务，避免旧历史一次性制造重复记忆。需要从历史补提炼时，
应在导入和对账完成后显式启动 reextract/reflect pipeline。

## 4. 真实验收

所有步骤必须在真实 AIRI 桌面应用中完成，验收数据必须使用隔离数据库。不要把以下内容写入正式 `data/memory-bridge.sqlite3`。

### 4.1 自然写入

在 AIRI 中说：

```text
我做新软件时从来不接受内置演示数据，第一次打开必须是空数据。
这是我所有客户项目一直遵守的原则。今天先聊聊交付节奏吧。
```

通过标准：

- 用户没有提出记忆请求，模型没有调用记忆工具。
- 回答成功交付后出现一组 user/assistant turn。
- extraction 与 resolution job 完成，候选被接受并形成一个稳定 UUID 的规范记忆。
- 记忆绑定用户原话 evidence，并完成 FTS/Dense 索引。

### 4.2 跨会话自动召回

结束原对话，新建空对话并问：

```text
我做新软件时，对首次打开的数据有什么一贯要求？
```

通过标准：

- 回答提到空数据和不内置演示数据。
- 脱敏代理日志为 `memoryAliasCount=0`、`toolCallCount=0`。
- recall 审计包含唯一记忆 ID、当前 version ID、检索通道、分数、质量状态和 `qwen2.5:14b`/`bge-m3:latest` 模型记录。
- 新会话 ID 与写入会话不同，排除旧聊天上下文。

### 4.3 自然纠正

告诉 AIRI：

```text
我现在的项目原则变了：新软件第一次打开不再要求空数据，
今后应该自动导入一套最小示例数据，方便客户马上体验。
```

通过标准：

- 不要求用户点名旧 UUID，也不要求模型调用 MCP。
- 原记忆 UUID 保持不变，revision 递增并追加 v2。
- v1 的 `superseded_at` 非空，当前投影和值改为“自动导入一套最小示例数据”。
- 同一作用域只剩一个有效当前值，不新建第二条冲突记忆。

再新建空会话提问：

```text
我做新软件时，对首次打开的数据现在有什么要求？
```

回答必须只出现新值，不能再把“空数据”作为当前要求。

### 4.4 自然遗忘

告诉 AIRI：

```text
这条关于软件首次打开数据的项目原则没必要保留了，把它忘掉吧。
```

通过标准：

- tombstone 在回答前同步写入，所有召回通道立即停止返回该 UUID。
- 规范记忆进入删除状态，审计和版本历史仍保留。
- 后台重新处理旧 turn 时不能复活同义事实。
- 新会话重复问题时，recall 审计的 `resultIds=[]`。

### 4.5 多账户、persona、project 与 fork

准备 Alice/Bob 两个独立 AIRI profile 和两个独立 Bearer token，但让它们连接
同一个隔离忆桥数据库。不要复用用户现有 AIRI profile。

1. Alice 建立 persona A/B、project A/B 和无 project 会话；在 project A
   写入只有该项目可见的代号/颜色，在 project B 和无 project 会话中确认不可见。
2. 从 project A 的 AIRI 可见入口执行“分叉并切换”；分叉必须继承 project A，
   不允许在 fork 中改绑 project，也不得产生半成品 session 或第二写者。
3. Bob 查询 Alice 项目事实，必须零召回或严格重排拒绝，回答应明确不知道，
   不能拿 Bob 自己的无关记忆猜测答案。
4. Bob 再查询一条自己的事实，必须正确召回，以排除“全都拒绝”的假隔离。

HTTP、MCP 和数据库直接写入不能替代这些 AIRI UI 步骤。AIRI profile、脱敏代理
日志和 SQLite 必须指向同一批 session/turn/trace/version 证据。

### 4.6 完整重启

完全退出 AIRI，停止忆桥，并重启 Ollama。确认没有旧 AIRI/MCP/忆桥进程后重新启动三者，再新建空会话重复召回问题。

通过标准：

- AIRI 冷启动后只派生一个忆桥 MCP 子进程。
- 已遗忘 UUID 仍被 tombstone 阻止，回答不能泄露旧值或新值。
- recall 审计仍为零结果，删除记忆的访问计数不增加。
- SQLite `integrity_check=ok`、`foreign_key_check` 为 0，outbox/jobs 无未完成项。

### 4.7 schema 36 单一会话权威切换

目标客户端完成后，还必须额外证明：

- App 发消息请求中没有完整历史、system prompt、principal 或 memory context。
- 清空 AIRI 可重建缓存后，仅凭忆桥恢复相同会话、消息顺序、active variant 和动作。
- 首 token 前、流式中途和 terminal event 前断网，均可用 round 查询/SSE 恢复，且模型
  只执行一次。
- App 与忆桥依次重启后，过期 round 收敛为 completed、failed 或 interrupted，不永久
  卡在 generating。
- 删除消息/会话后，本地旧缓存不能通过 change feed 或 SSE 重放恢复正文。
- retain/forget 两种删除策略对规范记忆和 evidence 的结果与删除确认页一致。
- 历史 dry-run/commit、重复导入和影子对账通过后，本地历史库才能降级为缓存。
- Alice/Bob、双 persona、project A/B/无 project 在列表、分页、round、SSE、change、
  delete 和 import 上都无越权命中。

## 5. 本版本验收结果

### schema 36 Conversation 服务端状态

服务端已经实现角色档案、项目绑定、会话 CRUD、消息分页、单消息聊天、round 状态、
可恢复 SSE、重新生成、change feed、消息/会话删除、记忆证据传播、维护任务和 AIRI
dry-run/commit 导入。模型不可用、记忆召回不可用、助手协议错误和 VL 未启用均有稳定
公开错误码；聊天审计只记录 ID、阶段、稳定错误码和耗时，不记录正文或 provider wire。

这仍不是 AIRI 产品验收结论：schema 36 的 AIRI/宝豆客户端切换和真实桌面/手机闭环尚未
完成，本轮也没有运行真实模型或长时间多用户压测。以下记录是兼容路径的历史证据，不能
替代 Conversation API 客户端验收。

2026-08-09 的真实 AIRI 0.11.3 桌面基线已完成：

- Alice 2 个 persona，覆盖 project A/project B/无 project；可见 fork 正确继承
  project A，并在新分叉召回项目代号“青铜海燕”和颜色“靛蓝”。
- Alice 完成自然写入、跨会话召回、同 UUID 多版本纠正、personal/role 遗忘和
  重启后负向召回。
- Bob 无法回答 Alice 项目事实，但能正确回答自己的夜间饮品“玄米茶”。

2026-08-11 又在全新隔离 schema 31 root、`qwen2.5:14b` 与
`bge-m3:latest` 上执行 v7 AIRI-compatible HTTP 重启探针：
- 13/13 功能检查全部通过，覆盖 grounded、精确弃答、澄清、知识/建议透传和重启持久化。
- requestId、响应 traceId、forced/proxy audit 和 SQLite traceId 13/13 一致；
  九阶段 trace 13/13 完整。
- 派生摘要 provenance 未泄漏，客户端不能伪造内部 grounding 字段。
- SQLite integrity `ok`、FK 0、open outbox 0、unhealthy/dead jobs 0。
- 生产 `auto` 查询理解 P95 0.215 ms；完整可靠召回 P50 421.897 ms、P95
  1352.802 ms，达到 2500 ms 门槛。
- 强制 `mode=always` 的 120 条真实 `qwen2.5:14b` 查询固定集准确率 100%，
  warm P95 898.487 ms，达到 1500 ms 门槛；仍与生产确定性快路指标分开记录。
- 回执/compat 快照以唯一 runId、0600、排他写入和 SHA-256 固化；trace 验收器
  支持同一 trace 的多个质量补救 attempt。

因此兼容层功能结果是 13/13 PASS，但它是脚本直调 HTTP 兼容层，不是真实
AIRI 桌面 UI 操作。该 schema 31 桌面闭环当时尚未重跑；历史 schema 28 桌面证据不能替代。
这份 2026-08-11 兼容路径报告当时的发布判定为 `FAIL`；它没有覆盖 schema 36 客户端
切换，且当时后续又确认 `LM-P1-004` 稳定偏好零候选阻断，所以当时不能概括为
“只缺桌面证据”。该缺陷已在后续版本关闭，当前边界见第 6 节。
数据库健康与完整可靠召回门禁已经通过。正式 3789、正式数据库和用户 AIRI profile
均未触碰。详细脱敏证据见
[schema 31 验收报告](acceptance-report-schema31-context-reflection.md)。升级 AIRI 主版本或改变
身份头/Base URL 后必须重跑。

正式验收应先设置 `MEMORY_BRIDGE_ACCEPTANCE_PARENT_DIR` 为不提交 Git 的受控绝对
目录，再执行 `npm run prepare:airi-acceptance`。未设置时隔离 root 在系统临时目录，
只适合一次性开发验收；不得把 `acceptance-secrets.json`、AIRI profile、数据库或
原始 stdout 作为公开证据归档。

## 6. 已知边界

- 当前 AIRI 0.11.x 没有稳定的原生生命周期插件接口，因此自动能力由 loopback 兼容代理实现；更换模型 Base URL 时必须保留这层代理。
- 自动提取是最终回复后的后台任务，刚说完就立即退出进程可能需要重启后由 outbox 继续处理。
- `required` 模式下 Ollama、embedding 或当前配置的生成模型不可用会明确返回不可用状态，不会伪装成完整语义召回。
- 自动模式只提交高置信、结构完整、非敏感的用户直接陈述；歧义、冲突和敏感项进入管理台收件箱。
- 密码、令牌、私钥、验证码和 Cookie 不进入候选、规范记忆或可召回原始账本。
- 10 万记忆的首次 Dense 全量回填在当前参考机器上需要数分钟；完成后增量索引和热查询远快于全量回填。
- AIRI 0.11.x 现有 UI 仍未原生消费 schema 36 Conversation API；兼容 Base URL 可继续
  使用，但它不消除客户端本地历史与服务端账本的双权威。
- Conversation 服务端当前按安全完整句发布 delta；长输出的累计前缀重复清洗可能呈
  O(n²) 增长，必须在后续规模测试中单列超长回复性能门禁。
- 历史 `LM-P1-004` 稳定偏好“completed + 零候选”缺陷已在后续分层记忆开发和
  真实模型回归中关闭；旧 schema 31 报告仍保留为历史证据，不能再作为当前阻断。
- 当前发布边界是**尚未在目标客户端（AIRI 桌面版或其它 MCP 客户端）重新执行完整 UI
  闭环**，而不是服务端、MCP 或一键安装尚未实现。这一条按客户端版本重跑一次即可关闭，
  与数据库 schema 无关。
