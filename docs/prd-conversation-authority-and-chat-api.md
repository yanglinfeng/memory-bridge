# 忆桥会话权威与聊天 API PRD

## 1. 文档状态

- 状态：`SERVER P0 IMPLEMENTED / VALIDATION PENDING`
  （服务端 P0 已实现；完整发布验收和客户端切换未完成）
- 创建日期：2026-08-11
- 最近更新：2026-08-12
- 目标系统：Memory Bridge / 忆桥，当前服务端基线 schema 36
- 优先级：P0，完成前 AIRI/宝豆仍存在双会话权威
- 关联文档：
  - `docs/prd-airi-memory-system.md`
  - `docs/prd-contextual-query-and-history-refinement-final.md`
  - `docs/airi-integration.md`
  - `docs/api-reference.md`
  - `docs/security-and-privacy.md`

### 1.1 当前实现盘点

| 范围 | 状态 | 说明 |
|---|---|---|
| schema 32–36 与迁移 | 服务端已实现 | 产品会话字段、round/attempt/event、change、regenerate、delete/import 账本已落库 |
| Conversation HTTP API | 服务端已实现 | profile/project、CRUD、分页、单消息 SSE、round 恢复、change、delete、import 已接正式入口 |
| 安全流式与协议分层 | 服务端已实现 | Ollama NDJSON 真增量、句级 sanitizer、ACT/action 分层、最终前缀一致性 fail closed |
| 幂等、single-flight 与重启收敛 | 服务端已实现 | 持久 round/attempt/lease/generation；过期执行收敛为 interrupted |
| 删除和记忆证据传播 | 服务端已实现 | retain/forget、删除屏障、唯一/多证据处理、维护 job |
| AIRI 历史导入 | 服务端已实现 | dry-run/commit lane、多批 cursor、幂等 receipt、整批回滚、lifecycle suppressed |
| 可观测性与公开错误 | 服务端已实现 | started/completed/failed 审计、阶段耗时、稳定 501/502/503 错误码 |
| schema 36 完整发布验证 | 待完成 | 本轮按要求不运行真实模型、完整 suite、build、规模和真机测试 |
| AIRI/宝豆客户端去权威化 | 未开始/不在本仓库 | 仍需 cold start、authenticated fetch SSE、缓存降权、影子对账、回滚和真机 |
| `LM-P1-004` 稳定偏好零候选 | 未关闭 | Conversation API 交付不得隐藏该长期记忆质量阻断 |

因此当前只能宣称“Conversation 服务端 P0 已实现并进入验证阶段”，不能宣称“忆桥已
成为 AIRI/宝豆唯一会话权威”，也不能宣称整个长期记忆产品已经达到发布完成定义。

## 2. 决策摘要

忆桥必须成为账号下会话、消息、当前上下文和长期记忆的唯一权威来源。

AIRI/宝豆客户端以后只负责产品交互、短期缓存、待发送队列、语音和角色表现层；
它不再保存另一套权威聊天历史，不再把完整历史作为模型请求来源，也不再判断长期
记忆的入库、清洗、召回、巩固或遗忘。

本 PRD 要补齐以下闭环：

1. 角色聊天档案同步到忆桥。
2. 创建、读取、更新、归档和删除会话。
3. 分页读取会话消息，支持跨 App 重启恢复。
4. 客户端只提交一条新消息，由忆桥重建上下文、召回记忆并调用模型。
5. 流式返回干净正文和结构化动作。
6. 原子保存用户消息、助手回复、动作、证据和生命周期任务。
7. 支持网络断开后的幂等重连、状态查询和结果恢复。
8. 支持重新生成、单轮删除、整段会话删除及明确的记忆处理策略。
9. 支持从 AIRI 现有本地历史幂等迁移，最终移除客户端权威会话库。

## 3. 背景与当前缺口

### 3.1 已有基础

忆桥已经具备：

- `conversation_sessions` 和 `conversation_turns` 可信账本；
- principal、persona、project、session、round 的身份绑定；
- `beforeModel` 查询理解、作用域推导和长期记忆召回；
- `afterTurn` 用户/助手回合记录和异步提取；
- 候选、规范记忆、版本、巩固、反思、遗忘、治理和审计；
- `/ollama-compat/v1/chat/completions` 模型代理。

### 3.2 开发前服务端缺口（schema 36 已补齐）

本 PRD 启动时 HTTP API 缺少：

- 无会话创建、列表、详情、标题和归档 API；
- 无消息分页、跨重启恢复和增量同步 API；
- 无“只提交本轮消息”的权威聊天 API；
- 无移动网络断开后的 round 查询和幂等恢复协议；
- 无重新生成的变体语义；
- 无会话/消息删除对派生记忆的明确处理规则；
- 无 AIRI 本地会话账本的正式迁移接口；
- 助手内部动作协议可能作为普通正文进入 `conversation_turns`。

以上服务端缺口现已由 schema 32–36、Conversation service/HTTP/chat engine 和
assistant protocol sanitizer 补齐。当前剩余缺口不在同一层：AIRI/宝豆客户端仍需
切换请求路径、恢复/同步策略和本地缓存所有权，完整发布验证也尚未完成。

AIRI 当前同时维护本地 session/message/index/outbox/tombstone，并将完整消息历史交给
OpenAI-compatible provider。忆桥又保存 session/turn。两套权威会导致冷启动、匿名
会话恢复、删除、重试和跨设备同步出现不一致。

## 4. 产品目标与非目标

### 4.1 产品目标

- App 重启、WebView 重载、Mac 服务重启后可以从忆桥恢复相同会话和消息。
- App 发消息时只提交当前会话 ID 和本轮内容，不提交完整历史。
- 忆桥从可信账本构建同会话近期上下文，并召回跨会话长期记忆。
- 同一幂等键重复、并发或断线重试不会产生重复消息、重复模型调用或重复提取。
- 用户看到和历史保存的助手正文不含 `ACT`、工具包装、记忆内部协议或系统提示。
- 多账号、多角色、多项目严格隔离；未知身份和越权访问 fail closed。
- 删除语义明确、可审计、可恢复或可物理清除，不留下无来源的派生记忆。
- API 足以让 iPhone、桌面端和未来 Android/Web 共用同一份会话数据。

### 4.2 非目标

本 PRD 不负责：

- STT/TTS 模型、音频传输和声音克隆；
- VRM/MMD/3D 模型、换装和动画资源；
- 图片建模、Qwen-VL 或媒体二进制存储；
- 老人硬件、手表、摔倒检测等设备协议；
- 面向公网的账号注册、TLS、WAF 或云端多主部署；
- 重新设计长期记忆提取、Dense、重排和反思算法本身；
- 任意有副作用工具的完整执行协议。提醒、报表等能力后续通过独立 capability/tool
  协议接入，但本 PRD 必须预留结构化事件，不能再把动作编码进正文。

## 5. 系统所有权与边界

### 5.1 忆桥负责

- 会话及消息的权威持久化、顺序、版本和删除状态；
- persona/project 与会话的不可变可信绑定；
- 角色聊天档案的服务端快照；
- 同会话近期上下文、较早历史摘要和跨会话长期记忆组合；
- 查询理解、召回、Prompt 组装、模型调用和结果修复；
- 用户/助手正文清洗、动作解析、凭据脱敏和入库；
- 提取、去重、冲突、巩固、反思、保留、遗忘和物理清除；
- 幂等、断线恢复、审计、trace 和同步 change feed。

### 5.2 AIRI/宝豆客户端负责

- 中文界面、会话列表展示、输入框和流式渲染；
- 角色 3D 外观、服装、动画、表情落地和音频播放；
- 本地草稿、乐观 UI、可清空缓存和待发送 outbox；
- 将忆桥结构化动作映射为本地动画，但不把动作重新拼回正文；
- 断网状态、失败提示和用户主动重试；
- 角色编辑后将聊天档案同步给忆桥。

客户端缓存不是权威。清空缓存后必须能仅靠忆桥恢复；缓存与服务端冲突时以忆桥
资源版本、message sequence 和 change sequence 为准。

### 5.3 Mac Local AI Hub / 安全桥负责

- iPhone 到 loopback 服务的认证、TLS pin、WebSocket/HTTP 转发；
- STT、TTS、媒体和本地模型进程的可用性；
- 不保存第二套权威会话历史，不改写 principal/persona/session/project 身份；
- 转发断线可以重试，但必须复用客户端幂等键。

## 6. 核心产品原则

1. **一个权威**：会话和消息只由忆桥裁决。
2. **一轮一提交**：客户端不再上传完整历史、system prompt 或召回结果。
3. **可信身份来自服务端**：principal 只由 Bearer credential 得出。
4. **会话绑定不可变**：persona/project 建立后不能通过发消息请求更换。
5. **正文和协议分离**：可展示正文、规范化文本、结构化动作、长期记忆 claim 分层。
6. **原始证据不被“润色”覆盖**：用户普通文本保留原意和原貌；检索清洗写入独立字段。
7. **允许空记忆和失败**：不得为了给出答案而注入无关记忆或重复生成。
8. **删除必须说明记忆后果**：删除聊天和要求忆桥忘记是相关但不同的动作。
9. **移动网络优先**：断线、重复请求、服务重启必须可恢复。
10. **迁移可回滚**：客户端权威库只能在对账通过后降级为缓存。

## 7. 目标请求流程

```text
App POST 本轮消息
  -> 鉴权并读取会话不可变身份
  -> 幂等占位并原子保存用户消息
  -> 从可信 conversation_turns 读取近期上下文
  -> 上下文查询理解
  -> 按 principal/persona/project/session 召回长期记忆
  -> 组合系统安全策略 + persona chat profile + 记忆 + 近期上下文
  -> 调用本地 Qwen
  -> 流式解析正文和动作
  -> 清洗内部协议、凭据和不可展示内容
  -> 原子完成助手消息与 round
  -> 提交 turn.recorded/outbox/提取/巩固/反思任务
  -> App 收到 completed，并按结构化动作驱动角色
```

客户端不得在请求 body 中提交 `userId`、`principalId`、完整 `messages`、
`recentTurns`、`systemPrompt`、`memoryContext` 或其他可伪造权威上下文。出现这些字段
应返回 400，而不是静默采纳。

## 8. 通用 API 约定

### 8.1 基础约定

- Base URL 沿用 `http://127.0.0.1:3789`。
- 路径沿用当前 `/api/...` 风格。
- JSON 请求使用 `Content-Type: application/json`。
- 流式聊天使用 `Accept: text/event-stream`。
- 所有时间使用 ISO 8601 UTC。
- 服务端资源 ID 使用 UUID；客户端 ID 只作为幂等键，不直接获得数据所有权。
- 所有响应使用 `Cache-Control: no-store`。
- 所有列表使用不透明 cursor，不使用 offset 作为实时会话的权威分页。
- principal 由 `Authorization: Bearer <token>` 解析，响应不返回 Token。

### 8.2 错误结构

兼容现有 `error` 字符串，并为新接口增加稳定机器码：

```json
{
  "error": "会话不存在或无权访问",
  "code": "CONVERSATION_NOT_FOUND",
  "retryable": false,
  "requestId": "uuid"
}
```

至少支持：

- `INVALID_REQUEST`：400
- `AUTH_REQUIRED`：401
- `FORBIDDEN_IDENTITY_OVERRIDE`：400
- `INVALID_CURSOR`：400
- `INVALID_EVENT_CURSOR`：400
- `PERSONA_NOT_FOUND`：404
- `PERSONA_PROFILE_NOT_FOUND`：404
- `PROJECT_NOT_FOUND`：404
- `CONVERSATION_NOT_FOUND`：404
- `MESSAGE_NOT_FOUND`：404
- `IDEMPOTENCY_CONFLICT`：409
- `VERSION_CONFLICT`：409
- `ROUND_IN_PROGRESS`：409 或复用现有执行
- `CONVERSATION_ARCHIVED`：409
- `REGENERATION_NOT_LATEST`：409
- `DELETE_POLICY_CONFLICT`：409
- `ASSISTANT_PROTOCOL_INVALID`：502，可重试
- `MODEL_UNAVAILABLE`：503，可重试
- `MEMORY_RECALL_UNAVAILABLE`：503 或按当前可靠召回策略明确降级
- `VL_SERVICE_DISABLED`：501/503，中文文案统一为“VL 服务暂未开启”
- `EVENT_HISTORY_EXPIRED`：410，改用 round 查询和消息分页恢复
- `SYNC_CURSOR_EXPIRED`：410，要求全量重新同步

404 必须同时用于“不存在”和“不属于当前 principal”，避免资源枚举。

## 9. 资源模型

### 9.1 PersonaChatProfile

```json
{
  "personaId": "uuid",
  "profileVersion": 3,
  "displayName": "星璃",
  "systemPrompt": "角色的人格、语气和边界设定",
  "greeting": "晚上好，我一直在这里。",
  "language": "zh-Hans",
  "capabilityIds": ["emotion.basic"],
  "updatedAt": "2026-08-11T00:00:00.000Z"
}
```

3D、服装、VRM、音色和本地资源路径不进入忆桥聊天档案。`capabilityIds` 只能引用
服务端允许列表，不能上传任意可执行工具或代码。

persona prompt 的优先级必须低于系统安全规则、身份作用域和记忆防注入规则。它不能
要求忆桥读取其他账号、角色或项目的记忆。

### 9.1.1 ProjectBinding

```json
{
  "projectId": "uuid",
  "displayName": "本地记忆产品",
  "status": "active",
  "createdAt": "2026-08-11T00:00:00.000Z",
  "updatedAt": "2026-08-11T00:00:00.000Z",
  "version": 1
}
```

ProjectBinding 只证明某个 external project ID 已被当前可信 principal/namespace 注册，
不包含项目正文或文件。相同 external ID 在不同 principal 下是不同绑定，不形成共享权限。

### 9.2 Conversation

```json
{
  "id": "uuid",
  "personaId": "uuid",
  "projectId": null,
  "personaProfileVersion": 3,
  "title": "第一次聊天",
  "status": "active",
  "messageCount": 12,
  "lastMessageAt": "2026-08-11T00:10:00.000Z",
  "lastMessagePreview": "今天感觉好一点了吗？",
  "createdAt": "2026-08-11T00:00:00.000Z",
  "updatedAt": "2026-08-11T00:10:00.000Z",
  "version": 7
}
```

`status` 至少支持 `active | archived | deleted`。列表默认不返回 deleted。

### 9.3 Message

```json
{
  "id": "uuid",
  "conversationId": "uuid",
  "roundId": "uuid",
  "sequence": 12,
  "role": "assistant",
  "displayContent": "我记得你更喜欢桂花乌龙。",
  "actions": [
    {"id":"uuid","type":"emotion","payload":{"name":"happy"}}
  ],
  "attachments": [],
  "status": "completed",
  "generationGroupId": "uuid",
  "variantIndex": 1,
  "isActiveVariant": true,
  "createdAt": "2026-08-11T00:10:00.000Z",
  "completedAt": "2026-08-11T00:10:02.000Z",
  "version": 1
}
```

`sequence` 在单个 conversation 内单调递增、永不复用。普通历史 API 不返回内部
Prompt、`normalizedContent`、模型原始 wire、记忆上下文或 credential。

### 9.4 Round

Round 将一条用户消息、一次或多次助手生成变体、召回 trace 和最终状态关联起来。

状态至少支持：

- `accepted`
- `understanding`
- `recalling`
- `generating`
- `completed`
- `failed`
- `interrupted`
- `deleted`

## 10. P0 API 契约

### 10.1 同步角色聊天档案

```http
PUT /api/personas/:personaId/chat-profile
```

请求：

```json
{
  "expectedVersion": 2,
  "displayName": "星璃",
  "systemPrompt": "...",
  "greeting": "...",
  "language": "zh-Hans",
  "capabilityIds": ["emotion.basic"]
}
```

要求：

- persona 必须属于当前 principal；首次注册也只能在当前 principal 内建立绑定。
- 没有历史 profile 时首次 PUT 必须使用 `expectedVersion: 0`，成功创建 v1；已有版本时
  expectedVersion 必须等于当前版本。
- 更新生成新的 `profileVersion`，不能原地覆盖已用于历史生成的快照。
- 已有 conversation 默认继续使用其绑定版本；新会话使用最新版本。
- 后续可显式为会话升级 profile，但不能改变 personaId。
- `GET /api/personas/:personaId/chat-profile` 返回当前版本和可用版本摘要。

### 10.1.1 同步项目绑定

```http
PUT /api/projects/:projectId/binding
GET /api/projects
```

PUT 请求：

```json
{
  "expectedVersion": 0,
  "displayName": "本地记忆产品"
}
```

要求：

- projectId 是 external ID，所有权只由当前 Bearer principal 和服务端 namespace 建立；
  请求体不能指定 principal、namespace 或其他账号。
- 首次 PUT 使用 expectedVersion 0 创建 v1；后续更新 displayName 使用乐观版本。
- GET 只返回当前 principal/namespace 的 active bindings。
- create/import 使用非空 projectId 前必须已有 binding；不存在或属于其他 principal 都返回
  `PROJECT_NOT_FOUND`，不能根据会话请求体自动认领。
- schema 迁移从已存在的可信 conversation session 非空 project 绑定回填此表。

### 10.2 创建会话

```http
POST /api/conversations
```

请求：

```json
{
  "idempotencyKey": "client-generated-uuid",
  "personaId": "uuid",
  "projectId": null,
  "title": null
}
```

要求：

- `idempotencyKey` 必填，同 principal 下重复请求返回同一 conversation。
- persona 必须存在且属于当前 principal。
- project 可空；非空时必须属于当前 principal/namespace。
- personaId/projectId 一经创建不可变；切换角色或项目必须创建新会话。
- title 为空时可在首轮完成后异步生成中文标题，但不得阻塞首字。
- 成功返回 201 和 Conversation。

### 10.3 会话列表、详情和更新

```http
GET /api/conversations?personaId=&projectId=&status=&cursor=&limit=
GET /api/conversations/:conversationId
PATCH /api/conversations/:conversationId
```

列表要求：

- 默认按 `lastMessageAt DESC, id DESC` 稳定排序。
- `limit` 默认 30，最大 100。
- 返回 `items`、`nextCursor`、`hasMore` 和 `syncCursor`。
- 不返回其他 principal 的数量、ID 或错误差异。

PATCH 只允许：

```json
{
  "expectedVersion": 7,
  "title": "与星璃的夜聊",
  "status": "archived",
  "personaProfileVersion": 4
}
```

禁止修改 personaId、projectId、principal、namespace 和历史 profile snapshot。
`personaProfileVersion` 只影响 PATCH 成功后新接受的 round；round accepted 时必须固定并
持久化实际使用的 profile version，不能被并发 PATCH 改写。

### 10.4 分页读取消息

```http
GET /api/conversations/:conversationId/messages?before=&afterSequence=&limit=
```

要求：

- 初次不传 cursor 时返回最新一页，但 `items` 在响应内按 sequence 升序，方便渲染。
- `before` 用于向前加载历史；`afterSequence` 用于恢复后追新，二者不能同时出现。
- `limit` 默认 50，最大 100。
- 返回 `items`、`nextCursor`、`hasMore`、conversationVersion。
- 默认只返回 active variant；调试/管理接口可查看其他生成变体。
- 已软删除的资源不返回正文，只通过 change feed 传播 tombstone。
- 分页期间新增消息不能导致重复、漏项或顺序变化。

### 10.5 发送消息并流式获取回复

```http
POST /api/conversations/:conversationId/messages
Accept: text/event-stream
```

请求：

```json
{
  "clientMessageId": "client-generated-uuid",
  "text": "你还记得我工作日早上喜欢喝什么吗？",
  "attachments": [],
  "clientSentAt": "2026-08-11T00:10:00.000Z"
}
```

要求：

- `clientMessageId` 必填，并在 principal + conversation 内唯一。
- 同一 ID 和同一 payload 重试必须返回/接续同一 round。
- 同一 ID 对应不同 text/attachment hash 返回 409 `IDEMPOTENCY_CONFLICT`。
- 不允许请求覆盖 persona、project、role、system prompt、历史或记忆上下文。
- text 经过 NFKC 边界检查但不得擅自改写用户可见内容。
- 用户消息必须先原子持久化并提交成功，才允许调用模型。
- 召回、模型或流失败不能删除已经确认的用户消息。
- 客户端断开默认不取消服务端 round；服务端继续完成或明确标为 interrupted。
- 只有清洗后的助手正文和结构化 actions 才能进入权威 history。
- assistant 完成和 round 完成必须原子提交；随后才发布提取 outbox。

SSE 事件顺序：

```text
event: turn.accepted
data: {roundId,userMessage,requestId}

event: turn.stage
data: {roundId,stage:"recalling"}

event: assistant.delta
data: {roundId,delta:"我记得"}

event: assistant.action
data: {roundId,action:{id,type,payload}}

event: turn.completed
data: {roundId,assistantMessage,conversationVersion,memory:{queued:true}}
```

失败：

```text
event: turn.failed
data: {roundId,code,message,retryable,stage}
```

规则：

- `assistant.delta` 只是临时显示，`turn.completed.assistantMessage` 才是权威最终正文。
- delta 拼接结果必须与 completed 的 `displayContent` 一致；协议边界未闭合时服务端必须
  缓冲，不得发布之后需要撤回的 delta。P0 不定义 replace 事件。
- `assistant.action` 不得包含任意代码、Prompt 或未注册 capability。
- SSE data 不得包含内部长期记忆正文列表、system prompt 或模型原始 wire。

### 10.6 查询 round 与断线恢复

```http
GET /api/conversations/:conversationId/rounds/:roundId
GET /api/conversations/:conversationId/rounds/:roundId/events
Accept: text/event-stream
Last-Event-ID: 7b0b1a3e-02d1-4b9d-9672-e0bba76fe80f:17
```

返回 round 状态、用户消息、当前 active assistant message、失败码和可重试信息。

断线恢复规则：

1. 客户端如果已收到 roundId，先查询 round。
2. 如果只保留 clientMessageId，重复 POST 原请求。
3. completed 返回已有结果，不再次调用模型或提取。
4. in-progress 可附着到同一执行或返回当前状态，不能并行创建第二次执行。
5. failed 只有在用户或明确策略发起重试时创建新 attempt；旧失败保留审计。
6. Memory Bridge 重启后必须从持久 round 状态恢复为 completed、failed 或 interrupted，
   不允许永久卡在 generating。

events 接口按 round 内单调事件序号重放，每条 SSE 都必须带标准 `id:`；完整恢复、鉴权、
过期和删除规则见 17.7。

### 10.7 重新生成

```http
POST /api/conversations/:conversationId/regenerate
```

请求：

```json
{
  "clientRequestId": "client-generated-uuid",
  "sourceAssistantMessageId": "uuid"
}
```

要求：

- P0 只允许重新生成当前会话最新 completed round；其他历史回复返回
  `REGENERATION_NOT_LATEST`。
- 不复制用户消息，不删除或覆盖旧助手消息。
- 新回复写入同一 `generationGroupId`，`variantIndex + 1`。
- 新变体成功后才成为 active；失败时旧 active 仍保持。
- 普通历史读取只返回 active 变体。
- 旧非 active 助手变体不得重复触发长期记忆提取或作为反思事实。
- 有副作用工具不得因重新生成自动重复执行；未来工具协议必须提供独立幂等键和确认。
- 重复 clientRequestId 必须返回同一 regenerate attempt。

### 10.8 删除单轮消息

```http
DELETE /api/messages/:messageId
Content-Type: application/json
```

请求必须明确记忆策略：

```json
{
  "clientRequestId": "client-generated-uuid",
  "reason": "用户删除这轮聊天",
  "memoryPolicy": "retain_derived_memories"
}
```

`memoryPolicy` 只能是：

- `retain_derived_memories`：聊天正文立即不可见，已形成的规范记忆可保留；相关 evidence
  转为不含正文的删除证明，不能继续暴露原文。
- `forget_derived_memories`：撤销本轮 evidence；仅由该 evidence 支持的记忆失效并写
  tombstone，多证据记忆保留其他证据并重新计算派生摘要/关系/索引。

用户消息或助手消息属于同一 round 时，默认删除整个 round，避免出现无问题的答案或
无答案的问题。响应返回实际受影响的 message IDs、memory action request/job IDs。

### 10.9 删除会话

```http
DELETE /api/conversations/:conversationId
Content-Type: application/json
```

请求同样必须包含 `memoryPolicy`，不得依赖隐含默认值。
同时必须包含稳定 `clientRequestId`，用于重复提交时返回同一删除 receipt。

要求：

- API 成功后会话和消息立即从普通读取/召回近期上下文中消失。
- 写会话 tombstone 和 change event，防止离线客户端把删除内容重新上传。
- `retain_derived_memories` 不得保留可反查的原始聊天正文。
- `forget_derived_memories` 必须按 evidence 图传播，重算受影响的规范记忆、巩固、关系和
  Dense/FTS 索引，不能简单删除 session 后留下孤儿记忆。
- 物理清除异步执行，返回 202 和 purge job；软删除先同步生效。
- archive 必须使用 PATCH，不得伪装成 delete。

### 10.10 增量同步

```http
GET /api/conversations/changes?cursor=&limit=
```

要求：

- change sequence 在 principal 内单调递增。
- change 至少覆盖 conversation upsert/delete、message upsert/delete、active variant 改变。
- 返回 `items`、`nextCursor`、`hasMore` 和 `serverTime`。
- 删除以 tombstone 传播，离线客户端收到后必须删除本地缓存。
- cursor 有保留期；过期返回 410 `SYNC_CURSOR_EXPIRED`，客户端重新拉会话和消息全量。
- change feed 只同步产品消息，不同步内部 memory、trace、prompt 和 worker job。

## 11. 内容分层、清洗与入库规则

### 11.1 四层数据必须分开

1. **display content**：用户在历史记录中看到的正文。
2. **normalized content**：仅供查询理解、检索、提取使用的规范化文本。
3. **structured actions**：emotion、motion、tool request/result 等受控事件。
4. **memory claims**：从证据派生的长期记忆候选、版本和巩固结果。

不能用 normalized content 覆盖 display content，不能把 memory claim 当作历史原话，
不能把 action token 当作 assistant 正文。

### 11.2 用户消息

- 普通用户正文按用户输入保存为 display content。
- NFKC、口语消解、同义改写和实体解析只写内部 normalized/query-understanding 结果。
- credential 命中时不保存明文，沿用忆桥现有 redaction；响应历史也只能显示替代文本。
- system prompt、内部记忆上下文和鉴权头永不进入用户 turn。

### 11.3 助手消息

模型原始输出必须先经过协议解析，再产生：

```json
{
  "displayContent": "我也很高兴见到你。",
  "actions": [{"type":"emotion","payload":{"name":"happy"}}]
}
```

以下内容禁止进入 display content 和 `conversation_turns.content`：

- `<|ACT ...|>`、`<tool_call>` 等内部包装；
- Memory Bridge 自动记忆 marker 和 memory JSON；
- system/developer prompt；
- credential、Authorization 或身份头；
- 模型推理草稿和 provider wire 元数据。

未知、格式错误或未注册动作必须隔离并记录结构化 reason，不能原样展示或静默执行。
客户端仍可做防御性过滤，但服务端入库前清洗才是权威门禁。

### 11.4 原始模型输出保留

普通 conversation 数据不得保存原始 provider wire。若 diagnostic 模式为排障限时保存：

- 必须与用户历史表分离；
- 必须脱敏、加密/权限隔离并设置短 TTL；
- 普通 API、export 和 change feed 不得返回；
- 关闭 diagnostic 后由治理任务清除。

## 12. 上下文、召回和生命周期规则

- 同会话近期上下文只从服务端可信 ledger 读取。
- 超出近期窗口的同会话历史可使用带 evidence 的会话摘要，不要求 App 重传。
- 跨会话事实只从长期记忆召回，不直接把所有旧聊天塞入 Prompt。
- persona/project/session scopes 从 Conversation 绑定推导，不接受本轮 body 覆盖。
- 查询理解必须保留时间、场景、否定、频率和指代条件。
- recall zero 是合法结果；不得为了避免空结果使用无关候选。
- 用户消息与助手 completed 原子落账后，再触发 `turn.recorded`、extract、consolidate、
  reflect 等后台任务。
- assistant partial/failed/interrupted、非 active regenerate 变体不得自动提交长期记忆。
- 每个 extraction run 必须有候选或结构化 zero-candidate reason，继续执行 LM-P1-004 门禁。

## 13. 数据模型和迁移要求

### 13.1 Schema

在当前 schema 31 之后使用下一个可用 schema 版本；若开发期间已有其他迁移则顺延，
不得争抢固定版本号。

现有 `conversation_sessions`、`conversation_turns` 应增量演进，不新建一套平行的
chat history 表。至少需要表达：

- conversation title/status/version/last_message_at/profile_version；
- message sequence/display content/status/round/generation variant；
- normalized content 或其受控引用；
- structured action 与 attachment reference；
- client idempotency key 和 payload hash；
- round state/attempt/failure/active variant；
- principal change sequence 和删除 tombstone；
- raw evidence、删除证明、memory evidence 的引用关系。

所有身份字段和 principal/persona/project/session 绑定继续受不可变触发器与外键保护。

### 13.2 AIRI 本地历史导入

增加受 credential 保护的批量迁移接口：

```http
POST /api/conversations/import
```

必须支持：

- `dryRun`、稳定 `importId`、批次 cursor；
- 每批数量和总请求体限制；
- 校验 persona/project/session/message/round 所有权；
- 使用现有 AIRI session/message IDs 作为 external/import IDs，而非越权主键；
- 按 trusted session、round、role、内容 hash 幂等去重；
- 已被 compat 生命周期写入的 turn 不得再次入库或重复触发提取；
- 默认只补缺失会话产品字段和缺失 turn，不自动重新提炼全部历史；
- 如需重提炼，显式创建 reflection/reextract run，沿用现有安全门禁；
- 返回 created/matched/conflicted/skipped 逐类统计和不含私人正文的错误摘要；
- 任一批次内部事务失败完整回滚，可重复运行。

## 14. 客户端切换与回滚

### Phase 0：契约和 RED 测试

- 先固定 API schema、错误码、SSE 事件和多账户负例。
- 新测试必须先证明当前缺失/失败。

### Phase 1：服务端会话权威

- 扩展 schema、ConversationService、MessageService、RoundService 和 change feed。
- 复用现有 LifecycleStore、AiriMemoryLifecycle 和 identity，不复制记忆算法。

### Phase 2：聊天闭环

- 实现“单消息输入 -> 可信上下文 -> 召回 -> Qwen -> 清洗 -> 原子落账 -> SSE”。
- OpenAI-compatible 保留兼容，但新 App 以 Conversation API 为正式路径。

### Phase 3：历史迁移和影子对账

- AIRI 导出本地历史，先 dryRun，再幂等导入。
- 一个版本内同时读取忆桥并与本地只读快照对账，记录数量/ID/hash 差异，不记录正文。
- 新写入以忆桥为权威；本地只保留 cache/outbox。

### Phase 4：客户端去权威化

- 冷启动从忆桥拉 conversation + latest messages。
- IndexedDB/session store 降级为可重建缓存。
- 移除本地 import/reset/fork 对权威历史的直接修改，全部调用忆桥 API。

### 回滚

- 切换期保留一版只读本地快照，不自动覆盖忆桥。
- 服务端迁移前创建可验证备份；schema 失败原子回滚。
- 若新 API 发布门禁失败，App 恢复旧读取路径但停止双向合并，避免旧数据覆盖新权威。

## 15. 可观测性和审计

每轮至少关联：

- requestId
- principalId（日志只使用内部稳定 ID，不记 Token）
- conversationId
- roundId
- user/assistant messageId
- personaId/projectId
- idempotency outcome
- query-understanding trace
- recall traceId/qualityState/result count
- model request/first-token/completion latency
- protocol cleaning reason/action count
- persistence transaction outcome
- extraction job/run ID 和 zero-candidate reason

日志默认 metadata，不记录私人正文、system prompt、memory context、Token 或原始模型 wire。

新增健康指标：

- stuck rounds by state/age
- idempotency conflicts/replays
- conversation/message change lag
- orphan messages/rounds/actions/evidence
- assistant protocol contamination count
- extraction completed with zero candidates and no reason
- import conflicts and unmatched local sessions

Memory Doctor 增加相应只读检查。

## 16. 性能与可靠性目标

本机隔离数据集至少包含 100 个角色、1,000 个会话、100,000 条消息。

- 会话列表 P95 < 200 ms。
- 最新 50 条消息读取 P95 < 200 ms。
- 幂等 replay（已完成 round）P95 < 200 ms，不调用模型。
- `turn.accepted` 在用户消息事务提交后尽快返回，P95 < 500 ms。
- 模型首字单独统计忆桥前处理、查询理解、召回和 Ollama 时间，不混成一个不可解释值。
- 服务进程重启后不存在永久 `generating` round。
- SQLite integrity `ok`、FK 0、orphan 0、open outbox 最终归零、dead job 0。

模型、Dense 和 query-understanding 的既有性能门禁继续适用，不能为满足聊天延迟而关闭
可靠召回、身份校验或自动生命周期。

## 17. 自动化与真实验收矩阵

### 17.1 功能

- 创建、列表、详情、改标题、归档、分页、增量同步。
- 单消息请求成功生成中文回复并跨 App/忆桥重启恢复。
- 新会话能召回同账号允许作用域的长期记忆。
- App 不上传完整历史也能理解“刚才那个”“还是之前的安排”等口语指代。
- regenerate 成功/失败/重复请求，active variant 规则正确。

### 17.2 幂等与故障

- 同一 POST 顺序重复 20 次，只产生一对 user/assistant 和一次提取。
- 同一 POST 并发 20 次，只存在一个模型执行。
- 相同 ID、不同正文稳定返回 409。
- SSE 在首字前、中途、完成前断开，重连不重复生成且最终可查。
- Ollama 不可用、超时、进程被杀、忆桥重启后 round 进入明确终态。
- App outbox 重放不会复活已删除 conversation/message。

### 17.3 隔离与安全

- Alice/Bob 各两个 persona、两个 project，所有列表/详情/消息/round/change/import 正负例。
- persona A 无法读取 persona B 的 session scoped 内容；personal 记忆按既有规则共享。
- body/query 伪造 userId/principalId/personaId/projectId/systemPrompt/history 全部拒绝。
- 猜测其他 principal UUID 一律 404，不泄漏资源是否存在。
- Token、凭据样式文本、系统提示不进入 history、SSE、日志、export。

### 17.4 清洗与记忆

- `<|ACT {"emotion":"happy"}|>` 只形成 action，history 正文中出现次数为 0。
- malformed ACT、未知 action、tool wrapper、memory marker、prompt injection 固定负例。
- 用户原话与 normalized query 分离，历史展示未被自动“润色”。
- failed/partial/non-active assistant 不形成长期记忆。
- completed extraction 零候选必须有 reason；稳定偏好能形成候选/记忆。
- 删除 retain/forget 两种策略覆盖单证据、多证据、巩固、关系、Dense、重启。

### 17.5 迁移

- 同一 AIRI 导出重复导入 3 次，第二/三次 created=0，无重复 turn/job/memory。
- compat 已写入 turn 与本地历史导入正确 match。
- 冲突不覆盖，dryRun 与真实统计一致。
- 迁移后会话数、消息数、角色/项目绑定和抽样 hash 对账通过。
- 清空 App 缓存后仍能从忆桥完整恢复。

### 17.6 真机

- iPhone 冷启动、热启动、WebView reload、锁屏恢复、Wi-Fi 短断、Mac 休眠恢复。
- 连续聊天至少 100 轮，杀掉并重启 App/忆桥后继续同一会话。
- 多角色切换无历史串线，消息、TTS 文本和角色动作一致。
- 真机验收只使用隔离 profile/database/namespace，不读取正式私人聊天。

### 17.7 编码前冻结的协议决定

以下决定用于消除实现阶段的歧义。除非形成新的兼容迁移方案，否则服务端、客户端和
自动化验收都必须遵守同一契约。

1. **SSE 使用可恢复事件流**：每个 `eventId` 使用 `<roundId>:<sequence>` 复合格式；
   sequence 在 round 内从 1 开始、跨 attempt 单调递增且不复用。服务端校验 eventId 中的
   roundId 必须等于 URL roundId。所有 event data 都带 `roundId`、`attemptId` 和
   `requestId`。
   `GET .../rounds/:roundId/events` 必须使用 Bearer-authenticated `fetch` streaming，要求
   `Accept: text/event-stream`，每条事件输出标准 `id:`；不得把 Token 放入 URL，也不依赖
   无法自定义 Authorization header 的原生 `EventSource`。服务端先重放 `Last-Event-ID`
   之后的事件，再继续实时推送。非法、超前或不属于该 round 的 ID 返回
   `INVALID_EVENT_CURSOR`；事件已过期返回 `EVENT_HISTORY_EXPIRED`。终态除 completed、
   failed 外，还定义 `turn.interrupted` 和 `turn.deleted`。完成的 round 只重放，不调用
   模型。正文事件至少保留至终态后 24 小时；删除事务必须先持久化无正文的
   `turn.deleted` terminal event，再关闭活动流，并同步清除或脱敏 accepted 正文、delta
   和 action replay，不能从 events API 复原已删内容。
2. **关键事件与业务状态同事务**：用户消息、round、`turn.accepted` event 在同一事务
   提交；助手消息、active variant、round completed、terminal event 和 extraction outbox
   在同一事务提交。事件不能先于其权威资源可读，也不能只有资源而缺终态事件。
3. **流式清洗不使用事后正文分叉**：assistant protocol parser 在协议边界未闭合时缓冲，
   只发布已证明可展示的安全正文。P0 不定义 `assistant.replace`；所有 delta 拼接必须逐字
   等于 completed `displayContent`。持久化按安全文本块合并，不要求逐 token 写 SQLite。
4. **每会话只允许一个非终态 round**：同一 `clientMessageId` 和相同 payload 附着现有
   round；相同 ID、不同 payload 返回 `IDEMPOTENCY_CONFLICT`。当前 round 未终止时，
   另一个 `clientMessageId` 返回 `ROUND_IN_PROGRESS`，不排队、不并发调用模型。后续若要
   队列化必须另加兼容协议。
5. **重启后的执行状态使用租约收敛**：`accepted | understanding | recalling |
   generating` round 持久化 attempt、lease owner、lease expiry 和 heartbeat。租约默认
   120 秒、每 10 秒 heartbeat，并允许配置；服务启动时以及运行中每 30 秒 reconcile。
   过期且没有可证明完成结果的 attempt 原子标记为 `interrupted`，不得猜测模型已完成。
   客户端重新 POST 原 `clientMessageId` 即表示显式重试：在同一 round 新建 attempt，不
   重复用户消息；round 顶层状态重新进入 generating，旧 attempt 保留审计。
6. **角色档案历史可读、版本使用点不可变**：
   `GET /api/personas/:personaId/chat-profile?version=` 读取指定历史快照；不传 version 返回
   当前版本和版本摘要。Conversation PATCH 可切换到同 persona 的已存在 profile version，
   并产生 conversation change event。每个 round accepted 时持久化
   `personaProfileVersionUsed`，之后并发 profile 更新或 Conversation PATCH 不得改变该轮
   Prompt。schema 32 迁移为每个现有 active principal/persona 建立 legacy default v1：
   使用最近一次非空 displayName，systemPrompt/greeting 为空、language 为 zh-Hans、
   capabilityIds 为空。迁移后新增 persona 必须先以 expectedVersion 0 创建 profile；没有
   profile 的 create/import 返回 `PERSONA_PROFILE_NOT_FOUND`。
7. **P0 不接收媒体正文**：`attachments` 只保留为未来受控引用。P0 请求仅接受空数组；
   非空、远程 URL、base64 或本地路径返回 `VL_SERVICE_DISABLED`，不得写入权威历史。
8. **ACT grammar 和授权固定**：单个回复允许 0–8 个与正文交错的 wrapper；每个 wrapper
   最多 1 KiB，全部动作 JSON 最多 8 KiB。接受严格的规范对象
   `{"type":"emotion|motion","payload":{"name":"..."}}` 和严格单键简写
   `{"emotion|motion":"..."}`，拒绝额外字段并规范化为同一结构。`name` 必须匹配
   `[A-Za-z0-9._-]{1,64}`，且出现在服务端静态动作注册表。P0 注册表固定为 emotion：
   `neutral | happy | sad | angry | surprised | worried | calm | excited`，motion：
   `idle | wave | nod | shake_head | bow`；扩展必须走新 capability/version，不能任意透传。
   `emotion.basic` 授权 emotion，`motion.basic` 授权 motion。未知、未授权、嵌套、超限、
   截断或 malformed wrapper 使
   整个助手生成以 `ASSISTANT_PROTOCOL_INVALID` fail closed，不保存权威 assistant message
   或 action；已经安全发布并持久化的 delta event 保留，随后以 `turn.failed` 终止，重连
   必须重放同一 partial + failed，不能伪装成 completed。只记录不含原文的 reasonCode。
   reasonCode 固定为
   `truncated_protocol | malformed_action | unknown_action | unauthorized_action |
   nested_protocol | forbidden_protocol | unknown_protocol | action_limit_exceeded`。新
   Conversation API 遇到 provider `tool_calls` 也 fail closed；compat 代理继续走现有独立
   受控路径。
9. **游标使用标准 HMAC，不接受可篡改锚点**：cursor 格式为版本化 payload 加
   HMAC-SHA-256 MAC，使用 Node 标准 crypto 和恒定时间验签，不自制密码算法。独立的
   32-byte cursor key 持久化保存，带 key version，可保留 previous key 作为轮换宽限；
   禁止复用 Stop、Restore、credential 或其他密钥。payload 绑定 principal 内部 ID、
   namespace、route、资源 ID、过滤条件、排序锚点、snapshot upper bound 和 expiry；不含
   正文、Token 或其他秘密。畸形、签名错误、过期、错 scope 或跨路由统一
   `INVALID_CURSOR`。会话/消息 cursor 默认 24 小时有效，change cursor 最长 30 天，均
   必须跨服务重启可用。
10. **change feed 是可直接应用的产品事件**：sequence 在 principal 内单调递增且不
    复用，保留期 30 天；每页固定 snapshot upper bound。item 至少包含：
    `sequence`、`type`、`conversationId`、`resourceId`、`resourceVersion`、`occurredAt`、
    `tombstone` 和 `resource`。upsert 携带完整的公开 Conversation/Message 产品表示，
    tombstone 的 `resource` 为 null 且无正文。类型固定覆盖 `conversation.upsert |
    conversation.delete | message.upsert | message.delete | message.active_variant`。会话列表
    的 `syncCursor` 与列表 snapshot 必须在同一只读事务截取。删除事务必须同步清除或
    脱敏该 conversation/round/message 既有 change events 中 resource 的正文、preview 和
    actions，只保留 sequence、type、resourceId、resourceVersion 等同步元数据以及新的
    tombstone；任何历史 cursor 都不能恢复已删内容。过期 cursor 返回
    `SYNC_CURSOR_EXPIRED`，客户端全量重拉。
11. **Conversation 状态和创建幂等固定**：同一 create idempotency key 只有 persona、
    project、title payload hash 完全相同时才重放，否则 `IDEMPOTENCY_CONFLICT`。
    `active <-> archived` 可通过带 expectedVersion 的 PATCH 双向切换；archived 禁止发消息
    并返回 `CONVERSATION_ARCHIVED`；deleted 不可 PATCH 或恢复为 active。非空 projectId
    必须来自当前 principal/namespace 的 ProjectBinding；schema 迁移只从身份完整的现有
    sessions 回填，create/import 请求体本身不能建立项目所有权。
12. **Regenerate 只处理最新轮且不改旧记录**：P0 只允许当前会话最新 completed round。
    新变体复用 generationGroupId、使用新的 message sequence 和 variantIndex；由于不存在
    后续消息，它仍保持正确显示顺序。生成上下文使用源用户消息之前的 active 历史加该
    用户消息，排除旧 assistant variants。新变体完成前旧 active 不变；成功事务中切换
    active、写 change event，并把旧 assistant-derived evidence 撤销/标记 recomputing，
    然后才为新 active 排 extraction。regenerate 与发送新消息原子竞争同一个 conversation
    single-flight；执行期间拒绝新消息和第二个 regenerate。失败时旧 active 和旧 evidence
    均不变，round 顶层恢复/保持 `completed`，失败只记录在 regenerate attempt。
13. **删除先建立屏障，再有界重算**：删除 generating round/conversation 时，事务先递增
    generation/version、标记 round deleted、取消本进程模型请求、关闭 SSE 并写 change
    tombstone；晚到 completion 必须使用 generation/version 条件更新，失败后不得写
    assistant、action、event 正文或 outbox。删除屏障和 tombstone 至少保留 30 天，物理
    清除不能提前删除。`forget_derived_memories` 同步撤销直接 evidence、tombstone 仅由它
    支持的记忆，并把所有可索引到的受影响派生记忆设为 `recomputing`；检索层同时根据
    删除屏障 fail closed，防止后台尚未扫描到的派生结果召回。图传播和索引重建按有界
    批次异步执行，失败进入 quarantine/dead-letter。`retain_derived_memories` 把 evidence
    转为无正文删除证明；聊天正文可物理清除，但该证明不能随正文一起删除。
14. **删除请求本身幂等**：同一 `clientRequestId` 和相同 resource/policy/reason 返回同一
    receipt；同 ID 不同 payload 返回 `IDEMPOTENCY_CONFLICT`。资源已删除后，同一
    memoryPolicy 的新 ID 返回原结果；不同 policy 返回 `DELETE_POLICY_CONFLICT`，不能
    静默改变已经执行的记忆后果。
15. **Import 的 dry-run 与 commit 是独立 lane**：请求包含 `dryRun`、稳定 `importId`、
    对应 lane 上次响应的 `batchCursor`（首批 null）、`isLastBatch` 和 conversations[]。
    dry-run 只写不含正文的 receipt，不写会话/消息、不推进 commit cursor；完成 dry-run
    后，commit 必须从 `batchCursor=null` 重新开始。cursor 绑定 principal、importId、lane、
    previous batch 和 payload hash；同 cursor 同 hash 重放，不同 hash 冲突。isLastBatch 后
    允许重放，不允许追加。每条会话携带 external session ID、personaId、projectId、title；
    每条消息只允许 user/assistant，携带 external message/round ID、displayContent 和
    occurredAt，拒绝 system/tool。新导入会话绑定导入时 persona 最新 profile version。
    单批最多 100 会话、2,000 消息、10 MiB JSON。结构、cursor、身份或所有权错误使整批
    回滚；同 owner 内可归类的重复/内容冲突记入 matched/conflicted/skipped，并与其他
    created 在一个事务提交。imported turn 标记为 lifecycle suppressed，默认不触发提取；
    重提炼必须显式创建 reflection/reextract run。
16. **服务端完成与客户端切换分开判定**：当前仓库可以完成 schema、服务、API、导入和
    服务端验收，但在 AIRI/宝豆客户端仓库完成 cold start 恢复、authenticated fetch SSE、
    缓存降权、影子对账和真机验证之前，不得宣称“App 已完成单一会话权威切换”。

## 18. 实现文件边界

当前实现：

- `src/server/conversation-service.ts`：profile/project、CRUD、分页、round、change、
  regenerate、删除、导入、维护任务和 Conversation Doctor。
- `src/server/conversation-chat.ts`：beforeModel、provider 真流式、完成/失败事务和聊天审计。
- `src/server/conversation-http.ts`：严格字段、HTTP 错误、SSE 首次连接和恢复。
- `src/server/assistant-protocol.ts`：完整响应与增量响应的正文/action 安全分层。

复用和扩展：

- `src/server/http-server.ts`：在身份鉴权后挂载 Conversation 路由。
- `src/server/index.ts`：实例化 Conversation service/chat engine 并注入正式 server。
- `src/server/database.ts`：schema 32–36、索引、触发器和迁移 attestation。
- `src/server/lifecycle-store.ts`、`src/server/airi-memory-lifecycle.ts`：复用权威
  session/turn、beforeModel 和 afterTurn 生命周期。
- `src/server/airi-ollama-compat.ts`：保留旧 AIRI 兼容路径，不作为新会话 API 的第二真相。
- `src/server/identity.ts`、`src/server/memory-governance.ts`、
  `src/server/memory-admin.ts`：身份、删除和只读诊断边界。

不要新建绕过 LifecycleStore 的第二套 session/turn 持久化，不要把业务状态只存在内存，
不要让 HTTP handler 直接拼大型 SQL 或重复实现身份/记忆规则。

同步更新：

- `docs/api-reference.md`
- `docs/architecture.md`
- `docs/data-model.md`
- `docs/security-and-privacy.md`
- `docs/airi-integration.md`
- `docs/testing-and-release.md`

## 19. 完成定义

只有同时满足以下条件才可以宣称“忆桥已成为会话权威”：

- P0 API、SSE、错误码和数据模型全部实现并有契约测试。
- App 发消息正式路径不再提交完整消息历史。
- App 清空本地缓存后可从忆桥恢复会话和消息。
- 多账号、多角色、多项目正负例及重启验收通过。
- 幂等、断线、并发、模型失败、服务重启均无重复或永久卡死 round。
- 权威 assistant history 中内部动作/记忆协议污染为 0。
- 删除 retain/forget 语义和 evidence 传播验收通过。
- AIRI 历史 dryRun、导入和重复导入验收通过。
- schema 迁移、备份恢复、SQLite integrity、FK、orphan、outbox、dead job 门禁通过。
- `npm run typecheck`、`npm test`、`npm run build` 全部通过。
- `docs/api-reference.md` 提供可复制请求、SSE 和错误恢复示例。
- 当前未解决的 `LM-P1-004` 不得因本 API 交付被隐藏或宣称完成。

## 20. 交付顺序

1. `[服务端完成]` Schema、服务层和 assistant protocol parser。
2. `[服务端完成]` PersonaChatProfile、conversation CRUD、message pagination。
3. `[服务端完成]` 单消息聊天 SSE、round 幂等和断线恢复。
4. `[服务端完成]` Regenerate、delete policy、change feed。
5. `[部分完成]` AIRI import 和 App 切换契约已完成；客户端影子对账/切换未完成。
6. `[进行中]` 文档已同步；完整自动化、规模、真实模型和隔离真机发布门禁待执行。

不得先删除 AIRI 本地历史实现再补服务端；必须先完成忆桥 API、迁移、对账和回滚能力。
