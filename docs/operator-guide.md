# 忆桥运行与维护手册

完整配置字典见[配置参考](configuration-reference.md)，专项部署、备份和排障分别见
[部署升级](deployment-and-upgrade.md)、[备份恢复](backup-and-restore.md)和
[故障排查](troubleshooting.md)。

## 1. 首次安装

```bash
cd ~/memory-bridge
npm install
npm run build
ollama serve
ollama pull qwen2.5:14b
ollama pull bge-m3:latest
```

首次启动的记忆库为空，不会自动写入演示数据：

```bash
MEMORY_BRIDGE_AUTOMATION_MODE=shadow npm start
```

管理台默认地址为 `http://127.0.0.1:3789`。`shadow` 会提取候选但不自动
写成规范长期记忆；完成 namespace 质量审计后再改为 `auto`。

## 2. 推荐运行配置

```bash
MEMORY_BRIDGE_HOST=127.0.0.1 \
MEMORY_BRIDGE_PORT=3789 \
MEMORY_BRIDGE_DATA_DIR="$HOME/memory-bridge/data" \
MEMORY_BRIDGE_AUTOMATION_MODE=shadow \
MEMORY_BRIDGE_AIRI_CHAT_MODEL=qwen2.5:14b \
MEMORY_BRIDGE_EMBED_MODEL=bge-m3:latest \
MEMORY_BRIDGE_RERANK_MODEL=qwen2.5:14b \
MEMORY_BRIDGE_EXTRACTION_MODEL=qwen2.5:14b \
MEMORY_BRIDGE_RELATION_MODEL=qwen2.5:14b \
MEMORY_BRIDGE_EXPLICIT_INTENT_MODEL=qwen2.5:14b \
MEMORY_BRIDGE_CONSOLIDATION_MODEL=qwen2.5:14b \
MEMORY_BRIDGE_QUERY_UNDERSTANDING_MODE=auto \
MEMORY_BRIDGE_REFLECTION_MODE=shadow \
MEMORY_BRIDGE_REFLECTION_MODEL=qwen2.5:14b \
npm start
```

默认数据库为 `<DATA_DIR>/memory-bridge.sqlite3`。检索 JSONL 默认写入
同目录的 `logs/retrieval.YYYY-MM-DD.jsonl`。

## 3. 账户与凭据

- HTTP principal 由 Bearer token 解析，客户端不能在 body/query 中传
  `userId` 或 `principalId`。
- 首次身份初始化只允许 loopback、同源、`application/json` 请求。
- MCP 启动时通过 `MEMORY_BRIDGE_USER_ID` 或
  `MEMORY_BRIDGE_MCP_TOKEN` 固定绑定一个 principal。
- persona、project、session 是同一账户内的访问作用域，不等同于账户。
- 不同 token 只能看到各自的记忆、trace、反馈样本和 Doctor 报告。

正式使用时为每个账户签发独立凭据。令牌只显示一次，不要写进 Git、日志或
截图。撤销凭据前确认还有其他可用凭据，避免锁死账户。

## 4. AIRI 接入

1. 启动 Ollama 和忆桥 HTTP 服务。
2. 在 AIRI 配置忆桥 MCP，见 [mcp-guide.md](mcp-guide.md)。
3. 将 AIRI 的 OpenAI-compatible Base URL 指向
   `http://127.0.0.1:3789/ollama-compat/v1`。
4. 聊天模型使用管理台展示的兼容模型名；实际后端仍为
   `qwen2.5:14b`。
5. 为账户提供对应 Bearer token，保证 HTTP 生命周期和 MCP principal 一致。
6. 完成自然写入、跨会话召回、纠正、遗忘、fork 和完整重启验收。

排查单轮回答时保留响应头 `x-memory-bridge-request-id` 和
`x-memory-bridge-trace-id`。前者查 compat audit，后者查 SQLite 九阶段 trace；两者
不能用“大概同一时间”代替精确关联。

只配置 MCP 不等于启用 AIRI 自动记忆。回答前召回和回答后沉淀由兼容代理
确定性执行。详见 [airi-integration.md](airi-integration.md)。

## 5. 日常健康检查

```bash
curl -sS http://127.0.0.1:3789/api/health
curl -sS http://127.0.0.1:3789/api/system-health
curl -sS http://127.0.0.1:3789/api/retrieval-log/health
curl -sS -X POST http://127.0.0.1:3789/api/memory-doctor \
  -H 'Content-Type: application/json' \
  -d '{"sampleLimit":20}'
```

`GET /api/health` 固定公开且只返回 `ok`、`service`、`version` 和
`mcpTransport`，供启动、Stop 等进程探针使用。启用身份凭据后，仍需为其余
三条命令添加：

```text
-H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
```

重点检查：

- `system-health.quality` 是否为 `full`。
- Dense `eligible/indexed` 是否一致、`lag` 是否为 0。
- jobs 是否长期 retrying、未解决 dead letter 是否增长。
- `deadLetterCount` 只统计未解决死信；`deadLetterHistoryCount` 保留全部
  历史。全局巩固 sweep 自动续链后会标记 `resolved=true` 并给出
  `recoveryJobId/recoveryStatus`，原 dead job 和错误证据不会被删除。
- `retrievalLog.consecutiveFailures` 是否大于 0。
- Memory Doctor 是否报告 critical 问题。
- `consolidation_sweep` 应只有一条稳定全局活跃链；每个已用账户/namespace
  应只有一条 `retention_sweep`。这些按未来时间排队的 pending 周期任务是
  正常状态，不应误判为 backlog。
- schema 38 会合并同一记忆/同一 scope 的旧待处理巩固任务，并在反思 run 已经
  终止时收口遗留窗口任务。判断 backlog 时只统计已经到 `available_at` 的任务；
  同 scope 同时最多允许一个 running 和一个最新 pending 后继。
- 每次 retention sweep 同时执行旧 Episode 精炼。用 `/api/audit` 查看
  `episode_indexes_compacted` 和 `episode_indexes_rehydrated`；前者说明安全卸载了
  可重建热索引，后者说明覆盖摘要失效后已恢复本地索引并排队 Dense 重建。

Memory Doctor 永远只报告，`destructiveActionsTaken` 固定为 0。

查看最近精炼审计：

```bash
curl -sS 'http://127.0.0.1:3789/api/audit?limit=200' \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
```

在线精炼不会删除原始对话，也不会强制 `VACUUM`。被释放的 SQLite 页先进入
freelist，后续写入会复用，所以数据库文件可能暂时不缩小但增长速度会下降。如果
必须立即把空闲页归还给操作系统，应先做一致性备份、停止所有服务和 MCP 写入，再在
维护窗口使用受信任的 SQLite 工具；不要对运行中的正式库直接执行 `VACUUM`。

一次可发布快照至少应同时满足：`quality=full`、Dense lag 0、未解决 dead
letter 0、retrying/stale/quarantined 0、重复活跃任务链 0、outbox 未完成 0、
SQLite integrity `ok`、FK violation 0。只看 `/api/health` 200 不足以判定可发布。

## 6. 备份与恢复

逻辑备份：

```bash
curl -sS http://127.0.0.1:3789/api/export \
  -o memory-bridge-backup.json
```

恢复前应停写或在维护窗口进行，并先备份当前数据库。导入：

```bash
curl -sS -X POST http://127.0.0.1:3789/api/import \
  -H 'Content-Type: application/json' \
  --data-binary @memory-bridge-backup.json
```

备份中包含私人记忆和证据，按敏感数据保存。不要只复制单个 SQLite 主文件
而忽略活跃 WAL；在线物理备份应使用 SQLite 一致性备份流程或先安全停服。

恢复后执行：

```bash
npm run verify:dense-switch-rollback
npm run evaluate:dense
```

恢复会重新排队 Dense 回填；在水位完成前健康状态可能为 `degraded`。

## 7. 升级

1. 停止忆桥与 MCP 写入进程。
2. 保存逻辑备份和一致性数据库备份。
3. 更新代码并执行 `npm install && npm run build`。
4. 先在备份副本运行测试。
5. 启动服务，让数据库迁移在单写者下完成。
6. 检查 `/api/system-health`、schema attestation、Dense 水位和日志健康。

当前 schema 为 39。schema 26 的身份不可变 attestation 会在后续迁移前验证；
schema 27 增加检索可观测性，schema 28 将 persona binding 唯一性收紧到
principal，schema 30 增加双 pipeline 历史重提炼、不可变 turn 清单、模型预算
账本、语义 claim 和事件链；schema 31 固化 ingest session 归属并增加 session
增量索引与 candidate evidence scope attestation；schema 32–36 引入 Conversation
权威服务，schema 37 增加 L1 情景、L2 observation 和 L4 层级摘要；schema 38 增加
任务积压合并、终态反思任务收口和可逆 Episode 热索引精炼；schema 39 收紧
正式记忆证据的 principal、namespace 与 scope 绑定。不得手工跳过、伪造迁移
记录或只修改 `user_version`。

## 8. 检索日志配置

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `MEMORY_BRIDGE_RETRIEVAL_LOG_MODE` | `metadata` | `metadata` 或 `diagnostic` |
| `MEMORY_BRIDGE_RETRIEVAL_JSONL` | 开启 | 设为 `off` 关闭 JSONL |
| `MEMORY_BRIDGE_RETRIEVAL_JSONL_PATH` | 数据目录内 | JSONL 基础路径 |
| `MEMORY_BRIDGE_RETRIEVAL_LOG_MAX_BYTES` | 25 MiB | 单文件大小轮换阈值 |
| `MEMORY_BRIDGE_RETRIEVAL_LOG_RETENTION_DAYS` | 14 | 保留天数 |

生产默认保持 `metadata`。`diagnostic` 会记录经脱敏的查询文本，可能仍含
个人信息，只在限时排障窗口启用。完整排障流程见
[retrieval-logging.md](retrieval-logging.md)。

AIRI 兼容层审计输出到 stdout/stderr，生产应由 supervisor 按权限和轮换策略收集。
验收时可将受限日志路径通过 `MEMORY_BRIDGE_QA_COMPAT_AUDIT_LOG` 交给重启探针；
该变量不会让服务自动写日志。当前 v7 探针会生成 0600 规范审计快照和实现指纹，
并使用唯一 runId、`wx` 排他写入、SHA-256 和多 attempt trace 验证。
正式验收应设置 `MEMORY_BRIDGE_ACCEPTANCE_PARENT_DIR` 为受控私有绝对目录；默认
系统临时目录只适合一次性开发验收。

## 9. trace 清理与反馈样本

按配置保留期清理：

```bash
curl -sS -X POST http://127.0.0.1:3789/api/retrieval-traces/prune \
  -H 'Content-Type: application/json' \
  -d '{}'
```

指定截止时间：

```json
{"before":"2026-07-01T00:00:00.000Z"}
```

`rejected` 是负例，`used/confirmed` 是正例。反馈只作为相关性门槛后的
有界先验，默认最大幅度 0.04，不能把无关记忆推过重排门槛。

## 10. 常见故障

| 现象 | 检查 | 处理 |
|---|---|---|
| `fetch failed` | Ollama 11434 | 启动 `ollama serve` |
| 模型不存在 | `/api/tags` | 拉取准确模型标签 |
| `qualityState=unavailable` | trace result/error | 修复语义服务，不静默降级 |
| Dense lag > 0 | system health/jobs | 等待回填或检查 dead letter |
| 零结果频繁 | Doctor + queryHash | 查看 rewrite/channel/semantic/rerank |
| 错误召回 | selection/rerank | 提交带 traceId 的 rejected 反馈 |
| JSONL 不增长 | log health/path | 检查目录、磁盘和权限 |
| MCP 启动拒绝 | principal env | 设置 USER_ID 或 MCP_TOKEN |
| 账户串数据疑虑 | token/trace scopes | 立即停写并做双账户隔离测试 |

## 11. 发布前命令

```bash
npm run typecheck
npm test
npm run build
npm run benchmark:scale
npm run benchmark:rerank
npm run evaluate:dense
npm run evaluate:retrieval-p1
npm run soak:reliability
npm run verify:crash-recovery
npm run qa:natural-conversation-quality
npm run qa:conversation-long-timeline
```

本版本已完成一次真实 AIRI 双账户、双 persona、双 project、无 project、fork、
纠正、遗忘和重启闭环。以后更换 AIRI 主版本、身份头契约、模型组合或数据库
迁移后，自动化服务端测试仍不能替代重新执行该桌面闭环。
`qa:natural-conversation-quality` 验证自然表达下的召回、弃答、纠正、遗忘和稳定习惯；
`qa:conversation-long-timeline` 执行隔离的 8 用户 × 10,000 条、180 天、写并发 4
规模门禁，并保留数据库、manifest 和不可变回执。两者都不能替代真实 AIRI 桌面 UI。

## 12. 历史重提炼日常操作

历史重提炼有两条独立水位：

- `reextract`：重新检查仍保留正文的历史 user turn，补回明确遗漏的直接事实。
- `reflect`：从至少三个不同 user turn 提出稳定模式或可能变化，只进入待确认。

推荐从管理台“历史重提炼”页面操作：先选择 namespace 和可信 scope，点击
“预览窗口”，分别核对两条 pipeline 的 turn 数、token、模型调用量和
`blockedTurn`，再只启动需要的那一条。API 等价流程见
[HTTP API 第 14 节](api-reference.md#14-上下文理解与历史重提炼接口)。

日常检查至少包括：

```bash
curl -sS "$BASE/api/reflection/status?namespace=personal" \
  -H "Authorization: Bearer $TOKEN"
curl -sS "$BASE/api/reflection/runs?limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

判断规则：

- `checkpointLag` 是最坏 pipeline lag，不是平均值；非零时查看
  `pipelineLags` 找到具体 scope 和 run type。
- `callsUsedToday` 包含失败的真实物理调用；不要通过重试绕过每日预算。
- pending/running 可取消；failed/dead 先看详情事件和模型调用错误，再重试。
- 运行失败、取消、dead 或单条超预算时 checkpoint 不前移；修复根因后会从同一
  历史位置继续。
- `shadow` 是正常生产安全模式。不要因为待确认候选多就试图启用 inference
  自动提交；系统没有这个开关。

在“待确认”页处理跨多轮推断时，逐条核对最小证据摘录、scope、时间跨度和
敏感级别。选择“拒绝并阻止以后再记”会抑制后续模型/Prompt 版本产生的等价
claim。证据已被 TTL 擦除、命中 tombstone、scope 不一致或包含 credential 时，
确认操作会失败关闭。

更换查询理解、提取或反思模型后，先在隔离目录执行固定集：

```bash
npm run evaluate:context-reflection -- \
  --receipt /private/tmp/context-reflection-quality.json
```

本机 `qwen2.5:14b` 的重排发布固定集在 20/20 正确时保守 P95 为 1313.867 ms，
后续复跑 P95 为 956.240 ms；该结果不能外推到其他生产硬件或日常聊天链路。
功能/安全门槛和目标环境延迟门槛必须分开记录，任何一项失败都不能写成“全部通过”。

schema 31 的 2026-08-11 结果只保留为历史基线。schema 37 分层情景报告仍是内容质量
基线；当前 schema 39 还必须同时通过任务收口、冷热精炼、升级迁移、完整回归和
大库完整性验证。任一门禁未完成时不得用历史 627/627 或旧桌面证据替代。
