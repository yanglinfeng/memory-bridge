# 配置参考

忆桥使用环境变量配置。变量在进程启动时读取，修改后必须重启服务或 MCP
进程。默认值以 `src/server/config.ts` 为准。

## 1. 配置规则

- `MEMORY_BRIDGE_HOST` 只接受 `127.0.0.1` 或 `::1`；其他值回退到
  `127.0.0.1`，服务不会直接监听局域网/公网地址。
- 数值超出允许范围或不是合法数字时使用默认值，不会无限放大资源消耗。
- 模型名必须与 Ollama `/api/tags` 返回的标签完全一致。
- 不要把 Token 写进项目文件、截图、日志或 shell 历史。正式环境优先使用账户
  凭据，不再依赖全局 legacy Token。

## 2. 网络、存储与身份

| 变量 | 默认值 | 允许值/范围 | 说明 |
|---|---:|---|---|
| `MEMORY_BRIDGE_HOST` | `127.0.0.1` | `127.0.0.1`、`::1` | HTTP 监听地址，仅 loopback |
| `MEMORY_BRIDGE_PORT` | `3789` | 1–65535 | HTTP、管理台和 AIRI 兼容代理共用端口 |
| `MEMORY_BRIDGE_DATA_DIR` | `<cwd>/data` | 可写目录 | SQLite、日志和派生本地状态目录 |
| `MEMORY_BRIDGE_USER_ID` | `default` | 非空稳定 ID | 默认 principal；MCP 也可用它固定账户 |
| `MEMORY_BRIDGE_NAMESPACE` | `personal` | 非空字符串 | 默认 namespace |
| `MEMORY_BRIDGE_TOKEN` | 空 | Bearer Token | legacy 全局 HTTP Token；账户凭据模式更推荐 |
| `MEMORY_BRIDGE_MCP_TOKEN` | 未设置 | `mb1.…` Token | 仅 MCP stdio 启动时认证，读取后会从环境删除 |
| `MEMORY_BRIDGE_MCP_PERSONA_ID` | 未设置 | AIRI 稳定 ID | 与 SESSION_ID 同时设置时绑定 `role/{persona}` |
| `MEMORY_BRIDGE_MCP_PROJECT_ID` | 未设置 | AIRI 稳定 ID | 完整 persona/session 身份下可选绑定 `project/{project}` |
| `MEMORY_BRIDGE_MCP_SESSION_ID` | 未设置 | AIRI 稳定 ID | 与 PERSONA_ID 同时设置时绑定 `session/{session}` |

MCP 必须设置 `MEMORY_BRIDGE_USER_ID` 或 `MEMORY_BRIDGE_MCP_TOKEN` 之一。Token
方式会校验凭据并绑定 principal；USER_ID 方式是本机受信任启动配置。连接同时
固定 `MEMORY_BRIDGE_NAMESPACE`。persona 与 session 必须成对设置才会启用非个人
scope，project 只有在这对身份完整时才生效；缺项时安全降级为仅
`personal/self`，格式非法则拒绝启动。调用方不能在 MCP 工具参数里扩大这些边界。

稳定身份 ID 长度为 1–128，只允许英文字母、数字、下划线、连字符，以及首字符
之后的点、冒号。不要使用显示名、自然语言或模型生成的临时文本作为这些 ID。

## 3. Ollama 与模型角色

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MEMORY_BRIDGE_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama Base URL |
| `MEMORY_BRIDGE_SEMANTIC_MODE` | `required` | `off` 或 `required`；生产使用 `required` |
| `MEMORY_BRIDGE_COMPAT_PROXY` | 开 | 设为 `off` 关闭 OpenAI 兼容生命周期代理（`/ollama-compat` 路由不挂载）；平台核心 MCP/HTTP/记忆引擎不依赖它 |
| `MEMORY_BRIDGE_COMPAT_CHAT_MODEL` | `qwen2.5:14b` | OpenAI 兼容代理使用的聊天模型；读取时优先本变量，未设置回退旧名 `MEMORY_BRIDGE_AIRI_CHAT_MODEL`（兼容既有部署） |
| `MEMORY_BRIDGE_QUERY_MODEL` | `MEMORY_BRIDGE_RERANK_MODEL`，未设置时为 `qwen2.5:14b` | 上下文查询理解专用模型 |
| `MEMORY_BRIDGE_EMBED_MODEL` | `bge-m3:latest` | embedding 与 Dense generation 模型 |
| `MEMORY_BRIDGE_RERANK_MODEL` | `qwen2.5:14b` | 批量严格相关性重排 |
| `MEMORY_BRIDGE_EXTRACTION_MODEL` | `qwen2.5:14b` | 对话原子事实提取 |
| `MEMORY_BRIDGE_RELATION_MODEL` | `qwen2.5:14b` | 候选五路关系判断 |
| `MEMORY_BRIDGE_EXPLICIT_INTENT_MODEL` | `qwen2.5:14b` | 自然记住/纠正/遗忘意图 |
| `MEMORY_BRIDGE_CONSOLIDATION_MODEL` | `qwen2.5:14b` | 非破坏式巩固与来源验证 |
| `MEMORY_BRIDGE_REFLECTION_MODEL` | `qwen2.5:14b` | 跨多轮历史反思；推断仍只进入待确认 |
| `MEMORY_BRIDGE_MODEL_KEEP_ALIVE` | `15m` | Ollama 模型常驻时间；`-1` 表示持续常驻，也可用 `30s`、`15m`、`2h` |

AIRI 聊天模型与提取、关系、重排、巩固和反思模型独立。更换
`MEMORY_BRIDGE_AIRI_CHAT_MODEL` 不需迁移数据库，但必须重启服务，并重跑固定正反例、
AIRI-compatible HTTP 探针和真实 AIRI 桌面闭环。

### Prompt 版本

| 变量 | 默认值 |
|---|---|
| `MEMORY_BRIDGE_EXTRACTION_PROMPT_VERSION` | `extract-v6` |
| `MEMORY_BRIDGE_RELATION_PROMPT_VERSION` | `claim-relation-v1` |
| `MEMORY_BRIDGE_EXPLICIT_INTENT_PROMPT_VERSION` | `explicit-memory-intent-v2` |
| `MEMORY_BRIDGE_CONSOLIDATION_PROMPT_VERSION` | `consolidate-v6` |
| `MEMORY_BRIDGE_REFLECTION_PROMPT_VERSION` | `history-reflection-v1` |

改变模型或 prompt 版本会改变质量基线，应重新执行对应固定评测和真实 AIRI
闭环，不能沿用旧报告中的成功率。

## 4. 检索与上下文

| 变量 | 默认值 | 范围 | 说明 |
|---|---:|---:|---|
| `MEMORY_BRIDGE_MAX_RECALL_CANDIDATES` | 120 | 10–500 | 融合前后的候选安全上限 |
| `MEMORY_BRIDGE_MAX_QUERY_VARIANTS` | 4 | 1–8 | 原查询和改写变体总上限 |
| `MEMORY_BRIDGE_QUERY_REWRITE_MIN_CANDIDATES` | 8 | 1–64 | 低候选时触发改写的阈值 |
| `MEMORY_BRIDGE_QUERY_REWRITE_MODE` | `llm` | `off`、`deterministic`、`llm` | 查询改写方式 |
| `MEMORY_BRIDGE_GRAPH_CANDIDATE_LIMIT` | 24 | 0–100 | 一跳关系扩散候选上限；0 关闭 |
| `MEMORY_BRIDGE_FEEDBACK_PRIOR_MAX` | 0.04 | 0–0.1 | 反馈对最终分数的最大绝对影响 |
| `MEMORY_BRIDGE_CONTEXT_TOKEN_BUDGET` | 1600 | 256–8192 | 返回给模型的记忆上下文预算 |
| `MEMORY_BRIDGE_RERANK_BATCH_SIZE` | 16 | 1–32 | Ranker 协议批量；可靠检索实际 provider 批次固定不超过 16，较大配置会安全拆批 |
| `MEMORY_BRIDGE_RERANK_CONCURRENCY` | 2 | 1–2 | 同一重排模型的并发调用上限；显存或统一内存紧张时设为 1 |
| `MEMORY_BRIDGE_MAX_RERANK_CANDIDATES` | 64 | 1–64 | 严格重排最多候选数 |
| `MEMORY_BRIDGE_MIN_SEMANTIC_SIMILARITY` | 0.35 | 0–1 | embedding 最低相似门槛 |
| `MEMORY_BRIDGE_MIN_RERANK_CONFIDENCE` | 0.7 | 0–1 | LLM 重排最低置信门槛 |
| `MEMORY_BRIDGE_SEMANTIC_TIMEOUT_MS` | 120000 | 1000–600000 | 单次语义模型调用超时 |
| `MEMORY_BRIDGE_SEMANTIC_CACHE_TTL_MS` | 30000 | 1000–600000 | rewrite/rerank 成功结果的进程内短缓存 TTL |
| `MEMORY_BRIDGE_SEMANTIC_CACHE_MAX_ENTRIES` | 256 | 1–4096 | 语义短缓存最大条目数；失败结果不长期缓存 |

可靠检索在送入重排 provider 前使用独立延迟预算：ranking query 最多 128 字，
每个 16 条 provider 批次的候选正文合计最多 640 字。超长 query 只在 provider
副本中按首段、关键中段和尾段保序压缩；原始 query 仍用于召回、时间、否定和规则判断。
Provider 私有载体使用 `{q,m:[[index,memory],...]}`，响应只接受结构化相关 index
数组；完整候选对象仍留在进程内用于权限、版本、遗忘和防幻觉判断，不会因 wire
压缩而丢失治理字段。

降低门槛通常提高召回但也提高误召回。调整前保存固定评测结果，调整后比较
Recall、MRR、nDCG、负例误召回、P95 延迟和 zero-result 热点。

## 5. 自动提取与 namespace 门禁

| 变量 | 默认值 | 范围/值 | 说明 |
|---|---:|---|---|
| `MEMORY_BRIDGE_AUTOMATION_MODE` | `shadow` | `off`、`shadow`、`auto` | 关闭、仅候选、自动提交 |
| `MEMORY_BRIDGE_AUTO_COMMIT_MIN_CONFIDENCE` | 0.95 | 0–1 | 自动提交最低置信度 |
| `MEMORY_BRIDGE_AUTO_COMMIT_MIN_IMPORTANCE` | 0.5 | 0–1 | 自动提交最低重要度 |
| `MEMORY_BRIDGE_NAMESPACE_QUALITY_BOOTSTRAP` | `none` | `none`、`audited-auto` | 启动时为默认 namespace 建立限时 auto 质量证明 |
| `MEMORY_BRIDGE_NAMESPACE_QUALITY_BOOTSTRAP_REASON` | `explicit_startup_bootstrap` | 非空字符串 | bootstrap 审计原因 |
| `MEMORY_BRIDGE_NAMESPACE_QUALITY_BOOTSTRAP_TTL_HOURS` | 24 | 1–168 | bootstrap 证明有效期 |

`auto` 不是全局无条件写入。最终行为还取决于 namespace 质量快照、敏感级别、
来源权威、关系判断、tombstone、置信度和重要度。

## 6. Embedding 与 Worker

| 变量 | 默认值 | 范围 | 说明 |
|---|---:|---:|---|
| `MEMORY_BRIDGE_WORKER_POLL_MS` | 500 | 100–60000 | 后台 Worker 轮询间隔 |
| `MEMORY_BRIDGE_EMBED_BATCH_SIZE` | 64 | 1–256 | embedding 批量大小 |
| `MEMORY_BRIDGE_FOREGROUND_QUIET_MS` | 2000 | 0–60000 | 前台模型请求结束后，后台模型任务继续让出的安静窗口 |

模型替换会注册新 Dense generation；新旧 generation 可并存，完成回填与固定
评测后再原子切换 alias。不要直接删除旧 generation 作为“升级”。

## 7. 巩固与保留

| 变量 | 默认值 | 范围 | 说明 |
|---|---:|---:|---|
| `MEMORY_BRIDGE_CONSOLIDATION_MIN_SOURCES` | 2 | 2–20 | 生成摘要的最少来源 |
| `MEMORY_BRIDGE_CONSOLIDATION_MAX_SOURCES` | 40 | 2–100 | 单次巩固最多来源 |
| `MEMORY_BRIDGE_CONSOLIDATION_IDLE_MINUTES` | 15 | 1–1440 | 空闲多久后允许巩固 |
| `MEMORY_BRIDGE_CONSOLIDATION_REDUNDANCY_THRESHOLD` | 4 | 2–100 | 冗余触发阈值 |
| `MEMORY_BRIDGE_RETENTION_ARCHIVE_THRESHOLD` | 0.1 | 0.01–0.9 | 低权重自动归档阈值 |
| `MEMORY_BRIDGE_RETENTION_SWEEP_HOURS` | 24 | 1–168 | 保留策略扫描周期 |
| `MEMORY_BRIDGE_EPISODE_HOT_DAYS` | 30 | 7–365 | L1 情景保留完整热索引的天数 |
| `MEMORY_BRIDGE_EPISODE_COMPACTION_BATCH_SIZE` | 1000 | 50–5000 | 每次保留扫描最多精炼的旧情景数 |

单条记忆 TTL 和按 namespace/kind 的策略可在“设置”页面维护。保留策略只归档
符合条件的低权重内容；Pin、档案和长期指令有额外保护。超过热窗口的 L1 情景
只有在有效 week 摘要完整覆盖时才卸载 embedding、Dense LSH、ANN 和词项热索引；
原始 turn、Episode、版本、证据和 FTS 仍保留。摘要失效后会恢复 ANN/词项，并通过
持久 outbox 重建 Dense。SQLite 释放页会先进入 freelist 供后续写入复用，因此在线
精炼主要抑制继续增长，不会强制执行阻塞式 `VACUUM`。

## 8. 检索日志

| 变量 | 默认值 | 范围/值 | 说明 |
|---|---:|---|---|
| `MEMORY_BRIDGE_RETRIEVAL_LOG_MODE` | `metadata` | `metadata`、`diagnostic` | 是否保存经脱敏查询文本 |
| `MEMORY_BRIDGE_RETRIEVAL_JSONL` | 开启 | 设为 `off` 关闭 | 是否写 JSONL 旁路日志 |
| `MEMORY_BRIDGE_RETRIEVAL_JSONL_PATH` | `<data>/logs/retrieval` | 文件基础路径 | 实际文件按日期/大小轮换 |
| `MEMORY_BRIDGE_RETRIEVAL_LOG_MAX_BYTES` | 26214400 | 1 MiB–1 GiB | 单个 JSONL 文件阈值 |
| `MEMORY_BRIDGE_RETRIEVAL_LOG_RETENTION_DAYS` | 14 | 1–365 | JSONL/trace 保留天数 |

`diagnostic` 可能包含个人信息，只应在限时排障窗口使用。SQLite trace 是权威
诊断链；JSONL 写失败不会回滚记忆事务，但会出现在日志健康状态中。

## 9. 推荐启动示例

```bash
MEMORY_BRIDGE_HOST=127.0.0.1 \
MEMORY_BRIDGE_PORT=3789 \
MEMORY_BRIDGE_DATA_DIR="/absolute/path/to/memory-data" \
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

## 10. MCP 启动示例

优先使用短生命周期或专用凭据：

```bash
MEMORY_BRIDGE_DATA_DIR="/absolute/path/to/memory-data" \
MEMORY_BRIDGE_MCP_TOKEN='mb1.…' \
MEMORY_BRIDGE_NAMESPACE='personal' \
MEMORY_BRIDGE_MCP_PERSONA_ID='airi-assistant' \
MEMORY_BRIDGE_MCP_PROJECT_ID='memory-bridge' \
MEMORY_BRIDGE_MCP_SESSION_ID='chat-20260831-001' \
npm run mcp:built
```

本机受信任的固定 principal 方式：

```bash
MEMORY_BRIDGE_DATA_DIR="/absolute/path/to/memory-data" \
MEMORY_BRIDGE_USER_ID='stable-principal-id' \
MEMORY_BRIDGE_NAMESPACE='personal' \
npm run mcp:built
```

最后一种未设置 persona/session 的示例有意只绑定 `personal/self`，适合旧 MCP
客户端或人工维护。需要角色、项目或会话隔离时应使用第一种完整绑定形式，并为每个
不同聊天身份启动独立进程。

## 11. 验收脚本专用变量

以下变量用于 benchmark/soak/恢复脚本，不是常规服务配置：

- `MEMORY_BRIDGE_ACCEPTANCE_PARENT_DIR`：可选绝对路径；设置后
  `prepare:airi-acceptance` 在该受控私有父目录创建唯一 mode 0700 隔离 root，并将
  manifest 标记为 `persistent-parent`。未设置时使用系统临时目录。
- `MEMORY_BRIDGE_ACCEPTANCE_ROOT`：已创建的单次隔离 root；供 QA 探针读取。
- `MEMORY_BRIDGE_QA_BASE_URL`：隔离兼容层 URL。
- `MEMORY_BRIDGE_QA_COMPAT_AUDIT_LOG`：受限 compat stdout 日志路径；探针只归一化
  严格事件行并写 0600 不可变快照。
- `MEMORY_BRIDGE_QA_CHAT_MODEL`：验收请求的聊天模型，必须与 manifest/runtime 一致。
- `MEMORY_BRIDGE_QA_TIMEOUT_MS`、`MEMORY_BRIDGE_QA_RELIABLE_RECALL_P95_MS`：探针
  超时和可靠召回 P95 门槛。
- `MEMORY_BRIDGE_SOAK_DURATION_MS`
- `MEMORY_BRIDGE_SOAK_INTERVAL_MS`
- `MEMORY_BRIDGE_SOAK_KILL_DELAY_MS`
- `MEMORY_BRIDGE_SOAK_ALLOW_SHORT`
- `MEMORY_BRIDGE_KEEP_SOAK`
- `MEMORY_BRIDGE_KEEP_BENCHMARK`
- `MEMORY_BRIDGE_KEEP_CRASH_RECOVERY`
- `RERANK_BATCH_SIZE`
- `RERANK_BENCH_SAMPLES`
- `CASE_INDEX`

除非正在修改评测脚本，不要把这些变量带入正式服务进程。验证命令和适用范围见
[测试与发布](testing-and-release.md)。
`MEMORY_BRIDGE_ACCEPTANCE_PARENT_DIR` 内会包含 Token、隔离 AIRI profile 和数据库，
不得提交 Git；公开证据只保留脱敏回执、规范 compat 快照及其 SHA-256。

## 12. 上下文理解与历史重提炼

### 12.1 回答前上下文查询理解

| 变量 | 默认值 | 范围/值 | 说明 |
|---|---:|---|---|
| `MEMORY_BRIDGE_QUERY_UNDERSTANDING_MODE` | `auto` | `off`、`auto`、`always` | 代词、省略、承接和低质量补救 |
| `MEMORY_BRIDGE_QUERY_CONTEXT_MESSAGES` | 6 | 2–12 | 最近消息硬上限 |
| `MEMORY_BRIDGE_QUERY_CONTEXT_TOKEN_BUDGET` | 1600 | 256–4096 | 送入理解模型的上下文预算 |
| `MEMORY_BRIDGE_QUERY_UNDERSTANDING_MIN_CONFIDENCE` | 0.78 | 0–1 | 独立查询可参与 ranking 的最低置信 |

`auto` 只在确定性检测到上下文依赖或首轮召回质量不足时调用模型；同一回合最多
一次，并与兼容 rewrite 共享结果。`always` 主要用于固定评测和诊断。关闭后独立
问题仍可用原查询，但上下文依赖问题不会获得模型消歧。

最近消息在消息边界内裁剪，并在送模前 credential redaction。模型输出必须通过
逐字 `surface/resolvedText`、支持 turn、否定、时间、频率、条件、模态和双先行词
歧义校验；每个支持 turn 都必须实际包含 `resolvedText`。唯一可信实体明确但模型
漏掉原问题约束时，只允许从原问题做实体替换的确定性修复，禁止依据模型新增词语。
调低置信门槛不能绕过这些确定性规则。

### 12.2 后台历史重提炼

| 变量 | 默认值 | 范围/值 | 说明 |
|---|---:|---|---|
| `MEMORY_BRIDGE_REFLECTION_MODE` | `shadow` | `off`、`shadow` | 关闭或产生受审核候选；无 auto |
| `MEMORY_BRIDGE_REFLECTION_SWEEP_HOURS` | 24 | 1–168 | 每 principal/namespace sweep 周期 |
| `MEMORY_BRIDGE_REFLECTION_IDLE_MINUTES` | 30 | 1–1440 | 会话空闲门槛 |
| `MEMORY_BRIDGE_REFLECTION_MIN_NEW_TURNS` | 12 | 1–1000 | 自动窗口最少新增 user turn |
| `MEMORY_BRIDGE_REFLECTION_MAX_TURNS` | 40 | 2–200 | 单 pipeline 窗口 turn 上限 |
| `MEMORY_BRIDGE_REFLECTION_TOKEN_BUDGET` | 8000 | 512–32000 | 单窗口硬 token 预算 |
| `MEMORY_BRIDGE_REFLECTION_LOOKBACK_DAYS` | 30 | 1–365 | 语义回看范围，不延长证据 TTL |
| `MEMORY_BRIDGE_REFLECTION_MIN_PATTERN_EVIDENCE` | 3 | 2–20 | 推断最少不同 turn 数 |
| `MEMORY_BRIDGE_REFLECTION_MAX_DAILY_CALLS` | 48 | 0–1000 | 每 principal/namespace 物理调用预算 |
| `MEMORY_BRIDGE_REFLECTION_CONCURRENCY` | 1 | 1–8 | 同 owner/namespace 同时模型调用数 |

本机 14B 推荐保持并发 1。每日预算在调用前原子预留，失败调用同样形成账本；把
并发或预算调大只改变资源上限，不改变 scope、证据、tombstone 和人工确认门槛。

`reextract` 与 `reflect` 使用不同 generation/checkpoint。改变模型、Prompt 或
实现版本不会自动全库回放；先用预览估算 turn/token/calls，再显式确认。单条
turn 超出预算时窗口停止且 checkpoint 不跳过，不能靠缩小窗口上限把它静默
遗漏。
