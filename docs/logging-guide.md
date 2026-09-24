# 日志查看与可追溯性总览

忆桥没有把所有信息混在一个文本日志里，而是按用途分成业务审计、检索 trace、
任务/死信、身份审计和进程日志。排障前先选对数据源。

## 1. 日志类型

| 类型 | 回答的问题 | 查看入口 | 主标识符 |
|---|---|---|---|
| 业务审计 | 谁对哪条记忆做了什么 | 管理台“审计日志”、`GET /api/audit` | memoryId、action |
| Conversation 审计 | 一轮聊天在哪个阶段失败、模型和首 token 花了多久 | `GET /api/audit` | conversationId、roundId、requestId、attemptId |
| 检索 trace | 为什么这次召回命中/漏掉 | retrieval trace API、JSONL | traceId、queryHash |
| AIRI 兼容层审计 | 回答是否被弃答/修复，对应哪次召回 | stdout/supervisor 中的结构化行 | requestId、retrievalTraceId |
| 任务与死信 | 后台任务为何延迟/失败 | 管理台“系统状态” | jobId、jobType |
| 历史重提炼 | 哪个窗口、模型调用和 checkpoint 发生了什么 | 管理台“历史重提炼”、`/api/reflection/runs/:id` | runId、callId、generationKey |
| 身份审计 | 凭据/身份绑定何时成功或拒绝 | SQLite `identity_audit_log` | principalId、credentialId |
| 进程日志 | 服务是否启动、关闭或 fatal | stdout/stderr/supervisor | 时间、进程 ID |
| Memory Doctor | 是否存在结构性异常和热点 | `POST /api/memory-doctor` | category、sampleIds |

不要用业务审计替代检索 trace，也不要看到历史 dead letter 就认定当前任务仍
失败。`deadLetterCount` 才是未解决数量，history 会保留恢复证据。

## 2. 关联标识符

一次问题通常按以下链路关联：

```text
principalId
  └─ personaId / sessionId / projectId / roundId
       ├─ Conversation requestId / attemptId
       │    ├─ conversation_chat_started/completed/failed
       │    ├─ recallDurationMs / providerDurationMs / firstTokenMs
       │    └─ round event sequence / change sequence
       ├─ compat requestId
       │    └─ retrievalTraceId (= traceId)
       ├─ traceId
       │    ├─ result memoryId / versionId
       │    ├─ retrieval events
       │    └─ feedback example
       └─ reflection runId / generationKey
            ├─ immutable run-turn list
            ├─ model callId / budget state
            ├─ candidateId / claim fingerprint / evidence
            └─ checkpoint / job / dead-letter evidence
```

收集排障信息时优先记录 requestId、traceId、memoryId、jobId 和时间范围，不要记录完整
Token。显示名不是安全标识，persona/project 应使用稳定 ID。

## 3. 业务审计日志

### 管理台

打开“审计日志”，可以看到时间、操作、记忆 ID 和 JSON detail。适合确认创建、
更新、纠正、召回、反馈、遗忘、恢复、归档、Pin 和索引治理等操作。

### API

```bash
curl -sS 'http://127.0.0.1:3789/api/audit?limit=100&offset=0' \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
```

接口只返回当前 principal。审计记录是解释证据，不应用于直接重放写操作。

### Conversation 聊天审计

Conversation API 每个实际执行 attempt 最少写：

- `conversation_chat_started`
- `conversation_chat_completed`，或 `conversation_chat_failed`

detail 包含 namespace、conversationId、roundId、requestId、attemptId、model，以及可用时的
稳定错误 `code`、`durationMs`、`recallDurationMs`、`providerDurationMs` 和
`firstTokenMs`。这些记录用于判断慢在召回还是 provider，也能区分客户端重连与真实模型
重试。

审计边界明确不保存用户/助手正文、system prompt、Token、memory context 或 provider
wire。排障时先用 round 查询取得 requestId/attemptId，再从当前账户审计中关联 action；
不要用聊天正文搜索日志。

```bash
curl -sS 'http://127.0.0.1:3789/api/audit?limit=200&offset=0' \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
```

## 4. 检索 trace

每次可靠召回生成 traceId，并记录 request、rewrite、channels、fusion、semantic、
rerank、selection、context、result 九种阶段。它不是“固定九行”：成功的质量补救
会在同一个 trace 中以新的 `attempt` 重复 rewrite～selection；not-useful 补救在
rewrite 终止；context/result 只写最终一次，失败路径会补齐带 `skipped` 的下游阶段。

事件的 `durationMs` 用于定位慢阶段；channels/fusion 中的
`diagnosticsByVariant`、`graphDiagnostics` 和 `truncationSummary` 用于定位候选上限与
无效派生来源；selection 的 `candidateDecisions` 用于定位单条 memory 的淘汰原因。

### 列表

```bash
curl -sS \
  'http://127.0.0.1:3789/api/retrieval-traces?qualityState=full&limit=100&offset=0' \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
```

可过滤 namespace、qualityState、resultId、since、until、limit、offset。

### 详情

```bash
curl -sS "http://127.0.0.1:3789/api/retrieval-traces/$TRACE_ID" \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
```

### 导出单次诊断

```bash
curl -sS \
  "http://127.0.0.1:3789/api/retrieval-traces/$TRACE_ID/export" \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN" \
  -o "retrieval-trace-$TRACE_ID.json"
```

导出前确认 trace 属于目标账户；分享前人工脱敏。逐阶段判断方式见
[检索日志与召回排障](retrieval-logging.md)。

## 5. JSONL 检索日志

默认启用，基础路径位于 `<DATA_DIR>/logs/retrieval`，实际文件按日期和大小轮换，
例如：

```text
retrieval.2026-08-09.jsonl
retrieval.2026-08-09.1786200000000.jsonl
```

第二种名称表示达到大小阈值后，用毫秒时间戳轮换出的旧文件。

每行是一个 trace 阶段事件；同一 trace 的九种阶段（含可能重复的 attempt）在完成时
一次批量追加，避免每个事件都单独触发文件 I/O 和健康更新。metadata 模式保存受控
标识符、query hash 和阶段统计，不保存原始查询；diagnostic 保存经脱敏 query，但
仍可能包含个人信息。

本机快速查看最后 20 条：

```bash
tail -n 20 /absolute/path/to/data/logs/retrieval.*.jsonl
```

按 traceId 搜索：

```bash
rg '"traceId":"替换为实际-trace-id"' \
  /absolute/path/to/data/logs/retrieval.*.jsonl
```

不要在共享终端、CI 或工单中直接输出 diagnostic 整行。

## 6. 检索日志健康

```bash
curl -sS http://127.0.0.1:3789/api/retrieval-log/health \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
```

重点字段：

- `logMode`
- `jsonlEnabled`
- `jsonlPath`
- `retentionDays` / `maxBytes`
- `lastSuccessAt` / `lastFailureAt`
- `consecutiveFailures`
- `totalFailures`
- `lastError`

`totalFailures` 是历史累计，不等于当前故障；当前判断看
`consecutiveFailures` 和 `lastError`。JSONL 失败不会回滚召回，但必须告警。

## 7. 任务与死信

管理台“系统状态”展示 job type、状态、attempt、next run、lease、错误和 dead
letter 历史。常见类型包括 `materialize_episode`、`summarize_memory_bucket`、
extract、resolve、index、Dense backfill/evaluate、consolidation、retention 和 purge。

schema 37 的 L1/L4 是两阶段队列：`materialize_episode` 提交情景后才排
`index_memory` 与 `summarize_memory_bucket`。所以物化期间 jobs 可能随 episode 数量
上升；判断收敛应看最终到期 outbox/jobs 是否归零，而不是只看中间瞬时总数。
`index_memory` 非队尾只做本记忆的增量 embedding/LSH；同 scope/generation 的当前
到期索引任务清空后，队尾任务才执行全 scope Dense 水位核验。若水位长期不 ready，
应同时查看同 scope 的 pending/failed 索引任务、eligible/indexed/lag 和最新错误。

解释原则：

- future pending 周期任务正常。
- 长期 running 可能是租约或 Worker 问题。
- retrying 表示仍在自动恢复。
- failed/dead letter 需要查看最后错误和依赖模型。
- recovered dead letter 保留历史，但应有 recoveryJobId/recoveryStatus。

恢复单个属于当前账户的 dead letter：

```bash
curl -sS -X POST http://127.0.0.1:3789/api/dead-letters/recover \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jobId":"替换为实际-job-id","mode":"recompute","reason":"根因已修复"}'
```

`mode` 只能是 `recompute`、`repair` 或 `supersede`。恢复前先修复根因，并先查看
最近 attempt 的 failure class、输入/输出指纹、补偿动作和 recovery strategy；反复
使用相同模式恢复只会制造更多失败证据。

## 8. 身份审计

`identity_audit_log` 记录身份 bootstrap、认证、签发、撤销和绑定相关结果。当前
管理台不直接展示此表；只有在本机离线调查或受控运维工具中读取。

不要在服务运行时用手工 SQL 修改身份表。调查时使用数据库副本，只输出 action、
outcome、principal/credential ID、source 和时间，避免泄露 detail 中的敏感内容。

## 9. 进程日志

服务当前输出启动地址、安全关闭信息和 fatal 错误到 stdout/stderr。MCP fatal
前缀为 `Memory Bridge MCP failed:`。

进程日志适合定位：

- 端口占用或启动失败。
- schema fail closed。
- MCP principal 缺失。
- 未捕获错误和安全关闭。

业务低召回不能只靠进程日志定位，应使用 trace。

## 10. Memory Doctor

```bash
curl -sS -X POST http://127.0.0.1:3789/api/memory-doctor \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sampleLimit":20}'
```

Doctor 检查重复 stable key、活跃单值冲突、未解决候选、孤儿当前版本/边、
stale/quarantined 摘要、超大记忆和高频零结果热点；schema 37 起还检查 episode
来源绑定、未索引情景、层级摘要来源断链、observation owner/scope 一致性和相关任务积压。
它只读，
`destructiveActionsTaken` 固定为 0。

zero-result hotspot 是 info 信号；负例测试和隔离测试本来就会产生零结果，不应
看到 count 就批量放宽召回门槛。

schema 36 引入、当前 schema 44 沿用只读 Conversation Doctor：

```bash
curl -sS http://127.0.0.1:3789/api/conversations/doctor \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
```

它按当前 principal/namespace 统计 stuck round、regenerate/attempt 不一致、孤儿
message/action/evidence、assistant 协议污染、completed 但零候选且无 reason、
Conversation maintenance pending/dead、import conflict/unmatched session 和 change lag。
`healthy=false` 时先按非零计数定位；Doctor 只读，不会自动删除、重试或修改聊天历史。

## 11. 从“不满意结果”到难例

1. 获取本次 `traceId`。
2. 查看 selection 是否真的包含目标 memoryId。
3. 若返回了错误记忆，提交 `rejected`；若确实使用/正确，提交 used/confirmed。
4. 导出 feedback examples，形成模型/配置回归集。
5. 调整后在固定集和真实负例上复测。

```bash
curl -sS -X POST http://127.0.0.1:3789/api/feedback \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"memoryId":"MEMORY_ID","feedback":"rejected","traceId":"TRACE_ID"}'
```

## 12. 清理与留存

按配置清理旧 trace：

```bash
curl -sS -X POST http://127.0.0.1:3789/api/retrieval-traces/prune \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

或传 `{"before":"ISO-8601"}`。清理 retrieval trace 不删除业务审计、记忆真相、
版本或外部已复制的诊断文件。

## 13. 最小排障证据包

对外求助前只收集：

- 软件/Node/AIRI/Ollama 版本和模型标签。
- schema user_version，不含数据库正文。
- `/api/system-health` 的计数和质量状态。
- `/api/retrieval-log/health`。
- 单个已脱敏 trace 导出。
- 相关 memoryId/jobId 和时间范围。
- Conversation 问题附 conversationId、roundId、requestId、attemptId、稳定错误码和事件序号，
  不附消息正文。
- 可稳定复现的问题/期望，不附真实 Token。

完整备份、数据库、私人 query 和 Token 默认都不应进入问题报告。

## 14. 历史重提炼日志

运行列表：

```bash
curl -sS "$BASE/api/reflection/runs?limit=50" \
  -H "Authorization: Bearer $TOKEN"
```

运行详情：

```bash
curl -sS "$BASE/api/reflection/runs/$RUN_ID" \
  -H "Authorization: Bearer $TOKEN"
```

详情返回三部分：`run`、`events`、`modelCalls`。建议按以下顺序排查：

1. 核对 `userId/namespace/scopeType/scopeKey/runType/generationKey`，确认没有查错
   账户或 pipeline。
2. 看 `status/attempts/leaseOwner/leaseUntil/cancelRequestedAt/lastError`。
3. 查看 `modelCalls` 的 reserved、completed、failed、refunded；每个条目代表一次
   真实物理调用，不是逻辑重试摘要。
4. 按真实事件名确认 `queued → started → model_call_reserved →
   model_call_completed/model_call_failed/model_call_refunded →
   completed/failed/dead/cancelled`。`model_call_refunded` 只能发生在派发前终止。
5. 对照 `/api/reflection/status` 的 `pipelineLags` 和 checkpoint；失败、取消和
   dead 不应推进水位。
6. 若结果质量不满意，记录 candidateId、claim fingerprint、证据数和时间跨度，
   不要复制整个历史窗口或模型完整输出。

常见诊断：

| 现象 | 证据 | 结论/操作 |
|---|---|---|
| `callsUsedToday` 已满 | modelCalls 数量和状态 | 等下一预算周期或降低计划窗口；不要反复重试 |
| run 长期 running | 过期 lease + 无新事件 | 检查 Worker；租约到期后由重试路径恢复 |
| Job 已换 Worker、Run 仍显示旧 Worker | Job/Run lease 与 `started` 事件 | 检查同步 heartbeat；只有当前 lease owner 能续租、失败或提交 |
| 取消后仍有 `reserved` | modelCalls + `model_call_failed/refunded` | 异常；终态事务必须把已派发调用结算为 failed、未派发调用结算为 refunded |
| failed/dead | `lastError` + failed call | 修复模型、预算、scope 或数据根因后再 retry |
| 两个 pipeline lag 不同 | `pipelineLags` | 分别预览和运行落后 pipeline |
| 超长 turn 阻塞 | preview `blockedTurn` | checkpoint 正确停住；治理该 turn 或调整受控预算 |
| 候选重复 | 相同 claim fingerprint | 检查 claim 单写者、跨版本 evidence merge 和拒绝抑制 |
| 候选无法确认 | TTL/tombstone/scope/credential 错误 | 这是提交前失败关闭，不能手工改状态绕过 |

日志隐私边界：默认事件详情只保存 ID、哈希、计数、状态、估算 token 和脱敏错误；
不保存完整历史窗口、独立查询正文或模型完整输出。credential 输入在送模前按行
替换为内部占位符，任何包含该占位符的模型候选也会被拒绝，避免脱敏文本反过来
成为长期记忆。

## 15. AIRI 兼容层审计与强制回答

兼容层以严格行首输出脱敏 JSON：

```text
[ollama-compat] {"action":"proxy_result","requestId":"...","result":"success","retrievalTraceId":"..."}
```

与长期记忆回答直接相关的 action：

| action | 含义 | 关键字段 |
|---|---|---|
| `zero_recall_abstention` | 私有事实 full 零召回，响应被修复为精确 `不知道。` | `memoryContextReason`、`retrievalTraceId` |
| `grounded_recall_repair` | 可信事实已召回，响应被修复为 `根据长期记忆：……` | `memoryContextReason`、`retrievalTraceId` |
| `memory_lifecycle` | `beforeModel` / `afterTurn` 是否完成 | `result` |
| `proxy_result` | 代理最终成功、HTTP 错误或客户端断开 | `result`、`retrievalTraceId` |

`memoryContextReason` 当前为 `explicit_query` 或 `private_fact_query`。一个强制
弃答/修复请求应同时满足：

1. HTTP `x-memory-bridge-request-id` 等于审计 `requestId`。
2. HTTP `x-memory-bridge-trace-id` 等于 forced event、`proxy_result` 的
   `retrievalTraceId`。
3. 同 traceId 在 SQLite 中持有顺序完整的 request→result 九阶段。

SQLite 不保存 AIRI 原始 requestId，只在 request 事件保存
`correlationSource=airi` 和 requestId 的 64 位 SHA-256 `correlationIdHash`；响应头和
compat 日志继续返回原 requestId/traceId，足以做一次请求内关联而不会扩大持久化
标识面。

`audit_log`、SQLite trace 和 JSONL 使用同一递归脱敏边界。嵌套的 token、apiKey、
authorization、cookie、password、secret 等字段直接写 `[REDACTED]`；provider
错误自由文本写 `errorHash`，不保存可能夹带的 Token。`contextTokenBudget` 等非凭据
计数字段不会被误删。

真实验收时，先由 supervisor 或 shell 将服务 stdout/stderr 保存到一个受限文件，
再把该路径交给重启探针：

```bash
MEMORY_BRIDGE_QA_COMPAT_AUDIT_LOG=/absolute/private/compat-audit.log \
node scripts/qa-restart-persistence-probe.mjs
```

该变量只告诉探针“读哪个日志”，不会让服务自动写该文件。当前 v7 探针
只解析严格行首的合法事件，写出 0600 规范 JSONL 快照，并记录
`sourceSha256/sourceAuditBytes/parsedEventCount/invalidPrefixedLineCount/hashScope`。
对会继续追加的整个 stdout 做哈希不可复核。
