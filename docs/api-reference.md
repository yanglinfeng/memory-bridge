# 忆桥 HTTP API 参考

本文覆盖当前 HTTP 公共接口。环境变量见[配置参考](configuration-reference.md)，
MCP 协议见[MCP 手册](mcp-guide.md)，全部文档见[文档中心](README.md)。

## 1. 通用约定

- Base URL：`http://127.0.0.1:3789`
- JSON：`Content-Type: application/json`
- 最大请求体：5 MiB
- 响应：`application/json; charset=utf-8`，`Cache-Control: no-store`
- 时间：ISO 8601 UTC 字符串
- ID：UUID，特殊内部 generation ID 除外

启用身份服务或 `MEMORY_BRIDGE_TOKEN` 后：

```http
Authorization: Bearer <token>
```

principal 只由服务端凭据解析。body/query 中出现 `userId` 或
`principalId` 会返回 400，避免身份覆盖和跨账户读取。
Conversation API 还拒绝客户端提交 `namespace`；tenant namespace 由服务端认证与
会话配置确定，消息正文、`recentTurns` 和自定义 header 都不能改变它。

Conversation API 的错误统一为：

```json
{
  "error":"可操作的错误说明",
  "code":"CONVERSATION_NOT_FOUND",
  "retryable":false,
  "requestId":"uuid"
}
```

旧管理接口仍可能只返回 `error/code`；客户端应优先按稳定 `code` 分支，不能解析
中文文案。

常见状态码：200 成功、201 创建、202 已排队、400 参数错误、401 鉴权失败、
403 首次初始化来源不可信、404 不存在或不属于当前账户、409 状态冲突、
503 依赖服务不可用。

## 2. 接口总览

### 身份与配置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 公开、最小化的进程身份检查 |
| GET | `/api/config` | 当前 principal 的客户端配置 |
| POST | `/api/identity/bootstrap` | 本机首次账户初始化 |
| GET | `/api/identity` | 当前身份总览 |
| GET/POST | `/api/identity/credentials` | 列出/签发凭据 |
| POST | `/api/identity/credentials/:id/revoke` | 撤销凭据 |
| GET | `/api/identity/personas` | 当前账户 persona 列表 |

`GET /api/health` 是唯一不要求身份凭据的 `/api/*` 请求，固定只返回
`ok`、`service`、`version` 和 `mcpTransport`。其他方法、`/api/health/`
以及所有其他 `/api/*` 路径仍需按身份策略鉴权；模型、路径和运行状态等
详细信息从受保护的 `/api/config` 与 `/api/system-health` 读取。

### 会话权威 API

| 方法 | 路径 | 说明 |
|---|---|---|
| PUT/GET | `/api/personas/:personaId/chat-profile` | 角色聊天档案版本 |
| PUT | `/api/projects/:projectId/binding` | 注册或更新可信项目绑定 |
| GET | `/api/projects` | 当前账户项目绑定 |
| POST/GET | `/api/conversations` | 创建/分页列出会话 |
| GET/PATCH/DELETE | `/api/conversations/:id` | 详情、更新、删除 |
| POST/GET | `/api/conversations/:id/messages` | 单消息流式聊天/消息分页 |
| GET | `/api/conversations/:id/rounds/:roundId` | round 断线恢复 |
| GET | `/api/conversations/:id/rounds/:roundId/events` | 可恢复 SSE |
| POST | `/api/conversations/:id/regenerate` | 重新生成最新回复 |
| DELETE | `/api/messages/:messageId` | 按轮删除消息 |
| GET | `/api/conversations/changes` | 可直接应用的增量同步 |
| POST | `/api/conversations/import` | AIRI 历史 dry-run/commit 导入 |
| GET | `/api/conversations/doctor` | 会话、导入、删除与任务体检 |

### 记忆与治理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/memories` | 列表/创建 |
| GET/PATCH/DELETE | `/api/memories/:id` | 详情/更新/软删除 |
| POST | `/api/memories/:id/restore` | 恢复，冲突时两阶段确认 |
| POST | `/api/memories/:id/revert` | 回退到历史版本 |
| POST | `/api/memories/:id/pin` | Pin/Unpin |
| POST | `/api/memories/:id/archive` | 归档 |
| POST | `/api/memories/:id/unarchive` | 取消归档 |
| POST | `/api/memories/:id/ttl` | 设置或清除 TTL |
| POST | `/api/memories/:id/purge` | 排队物理清除 |
| GET | `/api/candidates` | 候选收件箱 |
| POST | `/api/candidates/:id/accept|reject` | 审核候选 |
| GET | `/api/action-requests` | 自然纠正/遗忘动作收件箱 |
| POST | `/api/action-requests/:id/accept|reject` | 审核动作 |
| GET/PUT | `/api/retention-policies` | 保留策略 |
| GET | `/api/consolidations` | 派生摘要状态 |
| GET | `/api/tombstones` | 禁止再记/遗忘标记 |
| GET | `/api/purge-jobs` | 物理清除任务 |

### 召回、日志与运维

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/recall` | 可靠召回并生成上下文 |
| GET | `/api/recalls` | 审计式召回解释列表 |
| GET | `/api/retrieval-traces` | trace 列表和过滤 |
| GET | `/api/retrieval-traces/:traceId` | 完整 trace |
| GET | `/api/retrieval-traces/:traceId/export` | 下载诊断 JSON |
| POST | `/api/retrieval-traces/prune` | 清理旧 trace |
| GET | `/api/retrieval-log/health` | 日志健康 |
| POST | `/api/feedback` | 写 retrieved/used/confirmed/rejected |
| GET | `/api/feedback-examples` | 导出正负难例 |
| POST | `/api/memory-doctor` | 只读记忆体检 |
| GET | `/api/audit` | 审计记录 |
| GET | `/api/stats` | 记忆统计 |
| GET | `/api/system-health` | 队列、索引、模型和日志综合健康 |
| POST | `/api/dead-letters/recover` | 为当前账户的死信创建恢复任务 |
| GET/POST | `/api/export`、`/api/import` | 逻辑备份/恢复 |

## 3. 身份与凭据接口

### 3.1 首次初始化

```http
POST /api/identity/bootstrap
Content-Type: application/json

{
  "displayName":"本机主人",
  "label":"AIRI desktop",
  "expiresAt":"2027-08-09T00:00:00.000Z"
}
```

`expiresAt` 可省略。接口只允许 loopback、同源/非跨站、JSON 请求，并且全库只
能成功一次。响应 201 返回 `principal`、`credential` 和只显示一次的 `token`。
成功后匿名 loopback 和 legacy 全局 Token 路径关闭。

### 3.2 当前身份

```http
GET /api/identity
```

返回当前 principal、当前 credential、已绑定 persona、最近 session、personal
记忆数和 namespace 汇总。显示名不是授权依据，隔离使用稳定 ID。

```http
GET /api/identity/personas
```

返回 `{ "personas": [...] }`，只包含当前 principal 的绑定。

### 3.3 凭据

```http
GET /api/identity/credentials
```

返回当前凭据 ID 和凭据列表；列表只包含不可逆 hint，不返回完整 Token。

```http
POST /api/identity/credentials
Content-Type: application/json

{"label":"第二台 AIRI","expiresAt":"2027-08-09T00:00:00.000Z"}
```

只有已通过持久 credential 认证的请求能签发。响应 201 的完整 Token 只在本次
响应出现。

```http
POST /api/identity/credentials/:id/revoke
Content-Type: application/json

{"reason":"设备退役"}
```

`reason` 可省略，最长 1000 字符。撤销当前页面凭据后，后续请求会返回 401。

### 3.4 配置

```http
GET /api/config
```

返回当前 principal、默认 namespace、host/port/dataDir、模型、自动化模式、
AIRI 聊天模型和兼容 Base URL。它不返回完整 Token。

## 4. 记忆接口

### 创建

```bash
curl -sS -X POST "$BASE/api/memories" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "kind":"preference",
    "content":"用户偏好深色界面。",
    "namespace":"personal",
    "scopeType":"personal",
    "scopeKey":"self",
    "idempotencyKey":"theme-20260808"
  }'
```

关键字段与 MCP `memory_remember` 一致。credential sensitivity 会被拒绝。

### 列表

`GET /api/memories` 支持：`query`、`namespace`、`scopeType`、
`scopeKey`、`kind`、`status`、`tag`、`limit`、`offset`。

### 更新、删除与恢复

```http
PATCH /api/memories/:id
{"content":"修正后的完整事实"}

DELETE /api/memories/:id
{"reason":"用户要求遗忘"}
```

恢复若与当前单值事实冲突，首次请求返回预览和 `confirmationToken`；确认时：

```json
{
  "confirmation":"replace",
  "confirmationToken":"64位小写十六进制值"
}
```

只允许 `replace`，token 与快照不一致返回 409。

`GET /api/memories/:id` 返回的 `versions[].summary` 与
`versions[].evidence` 都只属于对应版本。历史版本证据不能用来证明当前版本，调用方
也不能跨版本拼接摘要形成新结论。

## 5. 可靠召回

```bash
curl -sS -X POST "$BASE/api/recall" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'x-memory-client-name: trusted-client' \
  -H "x-memory-session-id: $SESSION_ID" \
  -d '{
    "query":"用户喜欢什么界面主题？",
    "limit":5,
    "contextTokenBudget":1200
  }'
```

响应核心结构：

```json
{
  "traceId":"uuid",
  "query":"用户喜欢什么界面主题？",
  "memories":[
    {
      "memory":{"id":"uuid","content":"用户偏好深色界面。"},
      "score":0.91,
      "reasons":["本地语义相似 82%","严格重排确认可直接回答"],
      "explanation":{
        "lexicalRank":1,
        "annRank":2,
        "termRank":1,
        "graphRank":null,
        "semanticSimilarity":0.82,
        "rerankConfidence":1,
        "feedbackPrior":0
      }
    }
  ],
  "context":"...",
  "qualityState":"full",
  "grounding":[
    {
      "memoryId":"uuid",
      "versionId":"uuid",
      "proofCount":3,
      "firstEvidenceAt":"2026-08-01T07:00:00.000Z",
      "lastEvidenceAt":"2026-08-09T06:55:00.000Z",
      "excerpts":["我起床后会先喝一杯温水。"],
      "evidence":[
        {"evidenceType":"conversation","turnId":"uuid","sourceRef":null}
      ]
    }
  ]
}
```

零结果不等于用户从未表达；应按响应的 abstention 文案处理。
`unavailable` 表示可靠语义链不可用，本轮不会注入不可靠记忆。

`namespace`、`scopes`、`scopeType` 和 `scopeKey` 不能由请求体覆盖。没有可信会话头时
只召回当前 principal 的 `personal/self`；需要 role/project/session 时必须同时提供
`x-memory-client-name` 与 `x-memory-session-id`，服务端从不可变会话绑定派生可见范围，
未知会话返回 404。`grounding.versionId` 是本次召回时的当前版本，证明数量、时间和
摘录只从该版本汇总；后续版本变化后，新召回会返回新的版本快照。

schema 37 的 `memories` 可能同时包含三种召回层。客户端应按 `memory.source`
解释，不能把所有结果都显示成“用户事实”：

| `memory.source` | 层级 | 展示语义 |
|---|---|---|
| 其他规范来源 | fact | 已验证事实，仍需结合版本、证据和有效期 |
| `conversation_episode` | episode | 过往完整 user/assistant 对话情景，只证明聊过 |
| `hierarchical_summary` / `consolidation` | summary | 有来源的派生摘要，可展开 grounding 回溯 |

可靠上下文会使用“已验证事实”“过往对话情景”“派生摘要”分段，并对 episode 明示
“助手回应不是用户事实”。更新、遗忘或来源失效后，被阻断的 episode/summary 不得仅因
FTS 或旧 Dense 命中而返回。

## 6. Retrieval trace

列表：

```http
GET /api/retrieval-traces?namespace=personal&qualityState=full&resultId=<uuid>&since=<iso>&until=<iso>&limit=100&offset=0
```

所有过滤都隐含当前 principal。`qualityState` 仅接受 `full`、`degraded`、
`unavailable`。详情返回 summary 加按 `sequence` 排序的 `events`。

可靠召回保证九种阶段，而不是固定九条事件。成功的质量补救在同一 `traceId` 中用
递增 `attempt` 重复 rewrite～selection；not-useful 补救在 rewrite 终止；失败阶段
及其下游带 `errorCode`、`skipped` 和
稳定原因码。每条事件含 `durationMs`。channels/fusion 还返回通道、融合和图扩散的
`rawCount/returnedCount/cappedCount`，selection 返回逐候选 `candidateDecisions`。

```bash
curl -sS "$BASE/api/retrieval-traces/$TRACE_ID"
curl -sS "$BASE/api/retrieval-traces/$TRACE_ID/export" \
  -o "retrieval-trace-$TRACE_ID.json"
```

清理：

```http
POST /api/retrieval-traces/prune
{}
```

或 `{"before":"2026-07-01T00:00:00.000Z"}`。响应为
`{"deleted":42}`。

## 7. 反馈与难例

```bash
curl -sS -X POST "$BASE/api/feedback" \
  -H 'Content-Type: application/json' \
  -d "{\"memoryId\":\"$MEMORY_ID\",\"feedback\":\"rejected\",\"traceId\":\"$TRACE_ID\"}"
```

`feedback` 可为 `retrieved`、`used`、`confirmed`、`rejected`。带 traceId
时，trace 必须属于当前 principal，且 selection 必须包含该 memory。
`used/confirmed/rejected` 会进入难例表；`retrieved` 只保留原始事件。

```http
GET /api/feedback-examples?feedback=rejected&limit=200&offset=0
```

## 8. 日志健康

```http
GET /api/retrieval-log/health
```

返回 `logMode`、`jsonlEnabled`、`jsonlPath`、`retentionDays`、
`maxBytes`、`lastSuccessAt`、`lastFailureAt`、`consecutiveFailures`、
`totalFailures`、`lastError`。SQLite trace 或 JSONL 任一通道失败都会可见，
但日志故障不会回滚记忆真相。

## 9. Memory Doctor

```bash
curl -sS -X POST "$BASE/api/memory-doctor" \
  -H 'Content-Type: application/json' \
  -d '{
    "sampleLimit":20,
    "oversizedCharacterThreshold":12000,
    "zeroResultHotspotThreshold":3
  }'
```

问题类别：duplicate stable key、活跃单值冲突、未解决候选、孤儿当前版本、
孤儿边、stale/quarantined 摘要、超大记忆、30 天高频零结果 query hash，以及
schema 37 的 `episode_dense_unindexed` 和 `summary_source_incomplete`。
每项返回 `severity/count/sampleIds/recommendation`。本接口不修改数据，
`destructiveActionsTaken` 固定为 0。

`episode_dense_unindexed` 表示 L1 情景已经安全落库/FTS 可用，但异步 Dense 尚未完成；
先查同账户/namespace 的 `index_memory` backlog、失败和 dead letter。
`summary_source_incomplete` 表示活动 L4 摘要的来源 episode 数与声明不一致，是 critical，
应先停止依赖该摘要并从仍有效来源重建，不要手工补外键。

## 10. 分页、幂等与一致性

- 列表型接口使用 `limit/offset`；各接口会把 limit 限制到安全上限。
- 创建记忆优先用 `idempotencyKey`。
- 更新保持 memory UUID，新增不可变版本。
- 删除先 tombstone，再由显式 purge job 做物理清除。
- trace 和反馈是旁路可观测数据，不作为记忆真相源。

## 11. 身份、会话与健康语义

### 11.1 可信身份

Bearer token 是 HTTP principal 的唯一外部来源。Conversation API 的 namespace、
persona、project 和 session 从服务端可信会话记录读取；客户端正文、`recentTurns`、
模型输出和自定义 header 都不能覆盖，冲突会在调用模型前失败。AIRI 生命周期代理还会生成
稳定的 client、persona、session、round 身份头，并在会话已绑定时携带
project ID；保留身份头会覆盖/剥离用户自定义的同名值，调用方不能伪造。

- `personal/self`：同一 principal 内共享。
- `role/{persona_id}`：只对同 principal、同 persona 可见。
- `project/{project_id}`：只对结构化绑定到同 project 的 session 可见。
- `session/{session_id}`：只对当前 session 可见。

session 的 persona/project 绑定不可变。切换 persona 或 project 必须新建
session；fork 只能继承原绑定，不能在请求体中重新指定另一个 project。

### 11.2 `/api/system-health`

- `quality=full`：可靠语义链可用且当前 principal 的 Dense 水位完整。
- `deadLetterCount`：当前未解决死信；这是发布门禁字段。
- `deadLetterHistoryCount`：包含已恢复历史，不应直接当作当前故障。
- `queues`：未来执行的 retention/consolidation 周期任务会显示为 pending。
- `index.lag`：当前 principal 的 eligible 与 indexed 差值。
- `automation.retryingJobCount`：仍需人工关注的 failed/retrying 工作。
- `modelRuntime`：逐职责模型、最近 provider 调用、请求/模型耗时、cache、
  single-flight、cold/warm、token 与实现指纹；用于区分确定性快路和真实模型路径。
- `jobAttempts`：最近任务 attempt 的 `attempt/maxAttempts`、`failureClass`、
  `resultStatus`、输入/输出指纹、模型耗时、no-op、补偿、恢复、是否可重试、
  是否重复以及 `nextState`，用于还原 dead-letter 与补偿链。
- `denseIndex.generations[].evaluation`：各 active/building/previous generation 的
  dataset SHA、Recall@20、MRR@10 和 PASS/FAIL；该评测直接读取 Dense 通道，
  不调用 reranker。失败样本留在不可变评测回执，不由健康接口返回正文。

健康接口按当前 principal 隔离业务队列和记忆索引；稳定全局
`consolidation_sweep` 会作为系统治理链参与健康计算，但不能暴露其他账户的
业务记忆、trace 或候选内容。

## 12. 候选、动作与治理接口

### 12.1 候选审核

```http
GET /api/candidates?limit=200
```

只列当前 principal 的待确认/冲突候选。接受前可修正文和值：

```http
POST /api/candidates/:id/accept
Content-Type: application/json

{"content":"完整规范事实","value":"规范值"}
```

两个字段可省略以使用候选原值；传入时必须非空。

```http
POST /api/candidates/:id/reject
Content-Type: application/json

{"blockFuture":true}
```

`blockFuture=true` 会写 tombstone，阻止以后再次提交同义事实。

### 12.2 自然记忆动作审核

```http
GET /api/action-requests?limit=200
```

返回自然 remember/correct/forget 动作。接受时可指定精确目标和修正文案：

```http
POST /api/action-requests/:id/accept
Content-Type: application/json

{
  "memoryId":"uuid",
  "content":"修正后的完整事实",
  "value":"规范值"
}
```

`memoryId` 用于选择精确纠正/遗忘目标；`content` 最长 2000 字符，`value` 最长
1000 字符。服务会按动作类型要求必要字段。

```http
POST /api/action-requests/:id/reject
Content-Type: application/json

{"blockFuture":false}
```

### 12.3 单条记忆治理

| 路径 | Body | 响应语义 |
|---|---|---|
| `POST /api/memories/:id/pin` | `{"pinned":true}` | Pin/Unpin；省略视为 true |
| `POST /api/memories/:id/archive` | `{"reason":"…"}` | 归档；reason 可省略，最长 500 |
| `POST /api/memories/:id/unarchive` | `{}` | 取消归档 |
| `POST /api/memories/:id/ttl` | `{"expiresAt":"ISO"}` 或 `{"expiresAt":null}` | 设置/清除单条 TTL |
| `POST /api/memories/:id/purge` | `{"reason":"…"}` | 202，排队物理清除 |

### 12.4 保留、巩固与遗忘状态

```http
GET /api/retention-policies
PUT /api/retention-policies
```

PUT body：

```json
{
  "namespace":"personal",
  "kind":"preference",
  "evidenceTtlDays":90,
  "halfLifeDays":180,
  "autoArchive":true
}
```

`kind`、两个天数都可为 `null`；天数范围 1–3650。另有只读列表：

- `GET /api/consolidations?limit=200`
- `GET /api/tombstones?limit=200`
- `GET /api/purge-jobs?limit=100`

### 12.5 死信恢复

```http
POST /api/dead-letters/recover
Content-Type: application/json

{
  "jobId":"原 dead-letter job id",
  "mode":"recompute",
  "reason":"已修复上游模型配置，重新计算"
}
```

成功返回 202 和新恢复任务。job 必须属于当前 principal；恢复前先修复模型、数据
或配置根因。`mode` 必填：`recompute` 重新读取当前来源并计算，`repair` 使用一次
受控协议修复，`supersede` 用新的后继任务取代旧意图。原 dead letter 不删除，以便
保留故障证据；`reason` 可选并进入脱敏审计。

## 13. 备份与恢复接口

```http
GET /api/export
```

下载当前 principal 的完整 JSON v3 备份，不包含其他账户或可恢复 Token。

```http
POST /api/import
Content-Type: application/json

<完整 JSON v3 backup>
```

导入会先验证 userId、身份绑定、引用链和 tombstone ledger，再在事务中替换当前
principal 的完整状态；不是增量 merge。恢复后 Dense 回填重新排队。格式、安全
边界和恢复验证见[备份与恢复手册](backup-and-restore.md)。

## 14. 上下文理解与历史重提炼接口

历史重提炼固定为 `off` 或 `shadow`。跨多轮推断不会自动提交为规范记忆，
不存在解除该限制的接口或配置。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/reflection/status?namespace=personal` | 双 pipeline checkpoint、最坏 lag、预算和运行计数 |
| GET | `/api/reflection/runs?limit=100` | 当前 principal 的运行列表 |
| GET | `/api/reflection/runs/:id` | 运行、事件链和模型调用账本 |
| PUT | `/api/reflection/settings` | 设置 namespace 的 `off/shadow` |
| POST | `/api/reflection/preview` | 只读预览 reextract/reflect 两个窗口 |
| POST | `/api/reflection/reextract` | 确认后排队历史直接事实重提取 |
| POST | `/api/reflection/run` | 确认后排队跨多轮反思 |
| POST | `/api/reflection/runs/:id/retry` | 重试 failed/dead 运行 |
| POST | `/api/reflection/runs/:id/cancel` | 取消 pending/running 运行 |
| GET | `/api/reflection/candidates/:id/evidence` | 读取当前账户的最小证据摘录 |
| POST | `/api/reflection/candidates/:id/confirm` | 确认或修正后确认推断候选 |
| POST | `/api/reflection/candidates/:id/reject` | 拒绝，可选择阻止以后再记 |

预览请求：

```http
POST /api/reflection/preview
Content-Type: application/json

{
  "namespace":"personal",
  "scopeType":"personal",
  "scopeKey":"self"
}
```

响应中的 `pipelines.reextract` 和 `pipelines.reflect` 各自包含
`generationKey/turnCount/estimatedTokens/callsRequired/blockedTurn`。总览
`checkpointLag` 取全部 scope/pipeline 的最坏 lag；不能用较领先的 pipeline
掩盖另一条落后水位。

只有核对预览后才能排队：

```http
POST /api/reflection/run
Content-Type: application/json

{
  "namespace":"personal",
  "scopeType":"personal",
  "scopeKey":"self",
  "confirmed":true
}
```

省略 `confirmed:true` 返回 409。`personal` 的 `scopeKey` 必须为 `self`；
`role/project/session` 必须提供由可信会话身份产生的稳定 scope key。body/query
中的 `userId/principalId` 一律拒绝。

运行详情的 `modelCalls` 为实际物理调用账本，失败调用也计入预算；`events`
使用真实事件名 `queued`、`started`、`model_call_reserved`、
`model_call_completed`、`model_call_failed`、`model_call_refunded`、`completed`、
`failed`、`dead`、`cancel_requested`、`cancelled`。`refunded` 只表示模型尚未派发
便终止；已经派发后失败或取消必须结算为 `failed`。失败、取消、dead 或超长 turn
阻塞都不得越过对应 checkpoint。

候选审核也可继续使用通用 `/api/candidates/:id/accept|reject`。reflection 专用
别名便于客户端表达语义；接受前会再次校验逐字证据、TTL、tombstone、scope
和取消状态。`blockFuture:true` 会把 claim 决策和 tombstone 原子写入，阻止
跨实现版本再次展示等价推断。

回答前的上下文查询理解集成在 AIRI 生命周期和可靠召回内部，不单独暴露允许
客户端伪造 `resolvedReferences` 的写接口。查询不唯一时返回安全澄清，不注入
猜测记忆；trace 的 rewrite 阶段只记录允许级别的哈希、计数和状态。

## 15. AIRI OpenAI-compatible 代理

这两个路由 AIRI 使用，不是通用管理 API：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/ollama-compat/v1/models` | 返回只包含当前 AIRI 兼容聊天模型的 OpenAI 模型列表 |
| POST | `/ollama-compat/v1/chat/completions` | 执行回答前召回、Ollama 转发、回答修复和回答后证据入账 |

启用身份服务时，两个路由都需要：

```http
Authorization: Bearer <token>
```

`chat/completions` 使用五个保留身份头：

| Header | 要求 | 语义 |
|---|---|---|
| `x-memory-bridge-context-version` | 完整身份必填，当前只能是 `1` | 身份合同版本 |
| `x-airi-character-id` | 完整身份必填 | 当前 persona/character 稳定 ID |
| `x-airi-session-id` | 完整身份必填 | 当前会话稳定 ID |
| `x-airi-round-id` | 完整身份必填 | 本轮稳定 ID，用于幂等和 single-flight |
| `x-airi-project-id` | 已绑定项目时必填，无项目时省略 | 不可变 project 绑定 |

同名重复头、非 URL-safe 稳定 ID 或未知合同版本返回 400。缺失完整
v1 上下文时身份状态为 `degraded`：只允许 `personal/self` 召回，不形成
生命周期写入。persona/session/project 已绑定后冲突返回 409，不进入 Ollama。

每个 `chat/completions` 响应都携带 request ID；进入可靠召回后还携带 trace ID：

```http
x-memory-bridge-request-id: <uuid-v4>
x-memory-bridge-trace-id: <uuid-v4>
```

`x-memory-bridge-request-id` 是 compat 请求 ID；只有进入可靠召回并产生 trace 后才有
`x-memory-bridge-trace-id`。它与 compat audit 的 `retrievalTraceId` 和 SQLite
九阶段 trace 一致，可直接用于排障。

对私有稳定事实，兼容层执行确定性回答合同：

- 可信召回返回 `根据长期记忆：……`；不允许回答模型改成无依据新值。
- full 零召回返回精确的 `不知道。`。
- 世界知识、教程和建议不属于私有事实，不被强制弃答。
- 歧义问题返回澄清问句，不注入猜测记忆。
- `consolidation` 来源的严格首行内部 provenance 会被剥离。

`_airiMemoryContextState`、`_airiMemoryGroundedFacts`、
`_airiMemoryContextReason` 和 `_airiMemoryTraceId` 是代理内部保留字段，
不是公开请求参数。代理在调用生命周期前会删除客户端值；即使生命周期
报错，也不会信任伪造的 grounding。

关键错误语义：

| 状态 | 常见原因 |
|---:|---|
| 400 | JSON/模型/身份头/工具参数非法，或请求模型不是当前配置的 AIRI 聊天模型 |
| 409 | persona/session/project 不可变绑定冲突 |
| 502 | Ollama 上游失败、输出契约破损、非法模型响应或连续空回复 |
| 504 | 超过代理超时上限，上游请求已取消 |

请求体上限 5 MiB，上游与改写后响应上限各 10 MiB；超限不会形成
最终 turn 或记忆任务。

代理只暴露 `MEMORY_BRIDGE_AIRI_CHAT_MODEL` 配置的一个模型，默认为
`qwen2.5:14b`。受保护的 `/api/config` 通过 `airiChatModel` 字段返回当前
运行时值。

## 16. 会话权威 API

以下接口是新客户端的正式路径。客户端只发送本轮消息，不得上传完整历史、
`systemPrompt`、记忆上下文、`userId`、`principalId` 或 `namespace`。AIRI 的
OpenAI-compatible 代理继续用于旧客户端兼容。

### 16.1 建立角色档案与会话

首次档案使用 `expectedVersion: 0`：

```bash
curl -sS -X PUT "$BASE/api/personas/$PERSONA_ID/chat-profile" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "expectedVersion":0,
    "displayName":"星璃",
    "systemPrompt":"温和、诚实，不编造记忆。",
    "greeting":"晚上好。",
    "language":"zh-Hans",
    "capabilityIds":["emotion.basic","motion.basic"]
  }'

curl -sS -X POST "$BASE/api/conversations" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{
    \"idempotencyKey\":\"$CREATE_KEY\",
    \"personaId\":\"$PERSONA_ID\",
    \"projectId\":null,
    \"title\":null
  }"
```

档案版本是不可变快照；会话绑定的 persona/project 不可修改。PATCH 只接受
`expectedVersion`、`title`、`status` 和已存在的 `personaProfileVersion`。

### 16.2 单消息聊天与安全 SSE

```http
POST /api/conversations/:conversationId/messages
Authorization: Bearer <token>
Accept: text/event-stream
Content-Type: application/json

{
  "clientMessageId":"client-uuid",
  "text":"你还记得我工作日上午喜欢喝什么吗？",
  "attachments":[],
  "clientSentAt":"2026-08-12T08:00:00.000Z"
}
```

事件示例：

```text
id: <roundId>:1
event: turn.accepted
data: {"roundId":"...","attemptId":"...","requestId":"...","userMessage":{...}}

id: <roundId>:4
event: assistant.delta
data: {"roundId":"...","attemptId":"...","requestId":"...","delta":"我记得。"}

id: <roundId>:6
event: turn.completed
data: {"roundId":"...","attemptId":"...","requestId":"...","assistantMessage":{...}}
```

Ollama NDJSON 会逐块进入安全流式层。未闭合 ACT、工具包装和当前不完整句子继续
缓冲；只把已经证明可展示的完整片段写为 `assistant.delta`。所有 delta 拼接必须
逐字等于 completed `displayContent`。若后段协议畸形，已发布的安全 partial 保留，
随后以 `turn.failed` 终止，不写权威助手消息。

同一 `clientMessageId` 和相同载荷重放返回同一 round；不同载荷返回
`IDEMPOTENCY_CONFLICT`。一个会话同时只允许一个非终态 round。

### 16.3 断线恢复

```bash
curl -sS "$BASE/api/conversations/$CONVERSATION_ID/rounds/$ROUND_ID" \
  -H "Authorization: Bearer $TOKEN"

curl -N "$BASE/api/conversations/$CONVERSATION_ID/rounds/$ROUND_ID/events" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: text/event-stream' \
  -H "Last-Event-ID: $LAST_EVENT_ID"
```

不得把 Token 放进 URL，也不要使用无法自定义 Authorization header 的原生
`EventSource`；使用 authenticated `fetch` streaming。事件正文至少保留至终态后
24 小时。收到 `EVENT_HISTORY_EXPIRED` 后改用 round 查询和消息分页恢复。

### 16.4 分页与增量同步

```http
GET /api/conversations?status=active&limit=30&cursor=...
GET /api/conversations/:id/messages?before=...&limit=50
GET /api/conversations/:id/messages?afterSequence=120&limit=50
GET /api/conversations/changes?cursor=...&limit=100
```

消息响应按 `sequence` 升序；`before` 和 `afterSequence` 不能同时使用。所有 cursor
均为绑定 principal、namespace、路由、过滤条件和快照上界的 HMAC 不透明值。
change feed 返回 conversation/message upsert、delete tombstone 和 active variant；
`SYNC_CURSOR_EXPIRED` 表示客户端必须全量重拉。

### 16.5 regenerate 与删除策略

regenerate 只允许最新 completed round：

```json
{
  "clientRequestId":"client-uuid",
  "sourceAssistantMessageId":"message-uuid"
}
```

旧变体保留；新变体成功后才切 active，失败不覆盖旧 active。

删除消息或会话必须明确策略：

```json
{
  "clientRequestId":"client-uuid",
  "reason":"用户删除这段聊天",
  "memoryPolicy":"forget_derived_memories"
}
```

- `retain_derived_memories`：正文立即不可见，证据改为无正文删除证明。
- `forget_derived_memories`：撤销直接证据；唯一证据记忆 tombstone，多证据记忆
  生成仅由剩余证据支持的新版本，关系和索引由维护任务收敛。

多证据重算通过追加新版本并复制仍有效证据实现；旧 evidence 不会被改绑到另一
version 或 turn。原 turn 被物理删除时，外键只允许把原 evidence 的 `turn_id` 清空，
不能改成另一条 turn。

删除返回 202 receipt。相同资源不能事后切换另一种策略；冲突返回
`DELETE_POLICY_CONFLICT`。30 天删除屏障阻止晚到模型结果和离线缓存复活正文。

### 16.6 AIRI 历史导入

```json
{
  "dryRun":true,
  "importId":"stable-import-id",
  "batchCursor":null,
  "isLastBatch":true,
  "conversations":[{
    "externalSessionId":"airi-session-id",
    "personaId":"persona-uuid",
    "projectId":null,
    "title":"旧会话",
    "messages":[{
      "externalMessageId":"airi-message-id",
      "externalRoundId":"airi-round-id",
      "role":"user",
      "displayContent":"原消息",
      "occurredAt":"2026-08-01T00:00:00.000Z"
    }]
  }]
}
```

dry-run 和 commit 是独立 lane；commit 必须从 `batchCursor:null` 重新开始。每批最多
100 个会话、2,000 条消息、10 MiB。cursor、身份、结构或所有权错误使整批回滚；
可分类的内容冲突进入 `conflicted/skipped` 统计。导入 turn 标记为
`lifecycleSuppressed/skipAutoExtraction`，不会自动重提炼；需要重提炼时另行创建
reflection/reextract run。

### 16.7 公开错误码与审计

新增稳定码包括 `MODEL_UNAVAILABLE`、`MEMORY_RECALL_UNAVAILABLE`、
`ASSISTANT_PROTOCOL_INVALID`、`VL_SERVICE_DISABLED`、`INVALID_EVENT_CURSOR`、
`EVENT_HISTORY_EXPIRED` 和 `SYNC_CURSOR_EXPIRED`。VL 未开启固定返回 501 和
“VL 服务暂未开启”；助手协议无效返回 502；模型/召回不可用返回 503。

`audit_log` 记录 `conversation_chat_started/completed/failed`，detail 只包含
principal 作用域下的 namespace、conversation/round/request/attempt ID、模型、稳定
错误码、总耗时、召回耗时、provider 耗时和首 token 耗时，不记录用户/助手正文、
Prompt、记忆上下文、Token 或 provider 原始 wire。
