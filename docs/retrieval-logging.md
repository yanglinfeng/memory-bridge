# 检索日志与召回排障手册

本文专门解释可靠召回内部九阶段。业务审计、身份审计、任务/死信和进程日志的
区别与查看入口见[日志查看总览](logging-guide.md)。

## 1. 目标

每次可靠召回生成一个 UUID `traceId`。trace 用于回答四个问题：候选从哪里
来、哪些规则过滤了它、qwen 重排做了什么决定、最终哪些版本被注入。
trace 不能替代记忆真相、版本链或原始证据。

## 2. 日志存储

1. SQLite：`retrieval_traces`、`retrieval_trace_events`、
   `retrieval_feedback_examples`、`retrieval_log_state`。
2. JSONL：默认写到数据目录 `logs/retrieval.YYYY-MM-DD.jsonl`。

JSONL 按日期切分；达到大小阈值时追加时间戳轮换。默认 14 天清理。写失败
采用 best effort，不会让一次已成功的记忆写入或召回事务回滚。
同一 trace 的每个阶段事件各占一行，但在 trace 完成时一次批量追加，并只更新一次
日志健康状态，避免可观测性旁路放大热检索延迟。

## 3. metadata 与 diagnostic

默认 `metadata`：

- 保存 SHA-256 `queryHash`，不保存原 query。
- 保存候选/result memory ID、排名、数量、门槛、模型和耗时。
- `variants` 只保存类型和 hash。

`diagnostic`：

- 保存经脱敏的 query 和诊断文本。
- 自动遮蔽 Bearer、password、token、secret、API key 形式的值。
- 仍可能含姓名、偏好、项目和其他个人信息。

只在限时排障窗口设置：

```bash
MEMORY_BRIDGE_RETRIEVAL_LOG_MODE=diagnostic npm start
```

排障结束后恢复 `metadata` 并重启。

## 4. 九种阶段与多次 attempt

| 阶段 | 重点字段 | 常见含义 |
|---|---|---|
| `request` | principal、namespace、scopes、queryHash | 请求边界 |
| `rewrite` | triggered、variants、model、rewriteError | 是否扩展查询 |
| `channels` | 各通道数量、candidateIds | 候选是否产生 |
| `fusion` | fusedScore、variantHitCount、graphRank | 多查询/RRF 合并 |
| `semantic` | minSimilarity、qualified/filtered | embedding 粗筛 |
| `rerank` | stages、decisions、confidence | qwen 严格相关性 |
| `selection` | filterSummary、result IDs、MMR | 最终选择 |
| `context` | token budget、injectedSources | 实际注入 |
| `result` | qualityState、duration、errorCode | 最终状态 |

可靠召回固定覆盖九种阶段，但不保证恰好九条事件。首次召回为 `attempt=1`；质量
补救仍使用同一个 `traceId`；成功补救以 `attempt=2` 重复 `rewrite`～`selection`。
`context` 和 `result` 只在最终结果写一次。provider 失败时未执行的下游阶段也会
写入，并标记 `skipped/upstream_stage_failed`，避免缺行被误判为成功。
provider 正常返回但结构不能改善查询时，attempt 2 在 rewrite 以
`quality_fallback_not_useful` 终止，不会把已花费的补救调用隐藏掉。

每条事件都有非负 `durationMs`，`result.totalDurationMs` 是整条请求耗时。metadata
模式只保存受控标识符、哈希、计数、枚举和稳定原因码；provider 自由文本错误只保存
`errorHash`。diagnostic 模式允许脱敏后的查询/诊断文本，但仍递归屏蔽 Token、
password、API key、Authorization 和 Cookie。

## 5. 从一次不满意结果开始

### 第一步：取得 traceId

- `/api/recall` 和 `memory_get_context` 总会返回 `traceId`。
- 非空 `memory_recall` 的每个结果带相同 `traceId`。
- `memory_recall` 即使文本结果为 `[]`，MCP `_meta` 和 `structuredContent` 仍直接返回
  `retrievalTraceId`、`qualityState` 和 `errorCode`，无需按时间猜测。
- AIRI `/ollama-compat/v1/chat/completions` 从响应头读
  `x-memory-bridge-request-id` 和 `x-memory-bridge-trace-id`，无需按时间猜测。

```bash
curl -sS "$BASE/api/retrieval-traces/$TRACE_ID/export" \
  -H "Authorization: Bearer $TOKEN" \
  -o "trace-$TRACE_ID.json"
```

### 第二步：看 result

- `full`：Dense 水位完整，流水线成功。
- `degraded`：索引未完全回填或使用受控降级路径。
- `unavailable`：模型/provider 失败，可靠召回拒绝静默降级。

### 第三步：看 channels

- lexical=0：没有词面命中，不一定是错误。
- ann=0：Dense generation 未命中或未回填。
- term=0：实体/概念词未匹配。
- graph>0：一跳关系扩散参与，仍已重新执行权限过滤。
- 所有变体为 0：检查 rewrite、scope、namespace、status、TTL、sensitivity。
- `diagnosticsByVariant` 提供 lexical/ANN/term 的 `rawCount/returnedCount/cappedCount`；
  `graphDiagnostics` 提供图扩散的同类精确计数。
- `truncationSummary` 的稳定原因码包括 `lexical_channel_cap`、`ann_channel_cap`、
  `term_channel_cap` 和 `graph_channel_cap`。

### 第四步：看 semantic 与 rerank

- `filteredCandidateCount` 高：相似度门槛过严或 embedding 不适配。
- 候选存在但 relevant=false：重排器认为不能直接回答。
- 16 条无足够 relevant 后会自适应扩到 32、64，`stages` 可见。
- `rerank_candidate_cap` 表示仍有候选因重排上限未处理；
  `rerank_early_stop_sufficient_relevant` 表示已有足够相关结果而提前停止，两者不能
  混为一类。
- 不要只看关键词；检查主体、对象、否定、时间和“事实/要求”模态。
- 即使候选属于当前 principal，也可能是“用户自己的饮品偏好”这类与问题主体
  不一致的真记忆。若问题问另一个人物/角色/项目，检查 rerank decision 是否
  明确拒绝主体、账户、persona 或 project 不一致；不能用一个真实但无关的候选
  填补零召回。

### 第五步：看 selection/context

- `被有效派生摘要覆盖`：原子事实由带逐句证据的摘要代替。
- `被更高优先级作用域遮蔽`：session/role/project 覆盖低层同谓词事实。
- MMR penalty：近重复结果为保留多样性被降权。
- `candidateDecisions` 可按 memoryId 查看 semantic/rerank/selection 的 accepted、
  rejected、filtered 以及稳定 `reasonCode`；`filterSummary` 仅作聚合。
- fusion 的 `invalid_derived_source` 表示候选命中过检索通道，但派生摘要来源已失效；
  `fusion_candidate_cap` 才表示融合后超过返回上限。
- context 中 memory/version/evidence 必须与实际注入一致。

## 6. 常见问题决策树

```text
不满意召回
├─ result=unavailable → 查 Ollama/provider/errorCode
├─ channels 全为 0
│  ├─ rewrite 未触发 → 查候选阈值与配置
│  ├─ scope/namespace 错 → 修调用方绑定
│  └─ Dense lag > 0 → 等待/修复回填任务
├─ 候选有，semantic 全过滤 → 查 embedding/相似度/时间状态
├─ semantic 通过，rerank 拒绝 → 查主体/否定/时间/提示回归
├─ rerank 通过，selection 丢弃 → 查 scope/摘要覆盖/MMR/limit
└─ context 正确但回答错 → 属于回答模型 grounding 使用问题
```

## 7. 提交反馈

错误命中：

```bash
curl -sS -X POST "$BASE/api/feedback" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"memoryId\":\"$MEMORY_ID\",\"feedback\":\"rejected\",\"traceId\":\"$TRACE_ID\"}"
```

正确且实际使用可标记 `used`，人工确认可标记 `confirmed`。反馈先验限制在
`±MEMORY_BRIDGE_FEEDBACK_PRIOR_MAX`，默认 0.04，只在语义和严格重排通过后
生效。它不能修复没有候选或重排拒绝的问题；这些要从 trace 修索引、改写或
重排器。

## 8. 零结果热点

Memory Doctor 按最近 30 天聚合 `queryHash`，默认同一 hash 三次零结果即报告。
metadata 模式下无法反推出原 query；应在用户授权的诊断窗口复现，或由调用方
在自己的受控工单中保存 query 与 traceId 对照。

`zero_result_hotspot` 是 info 级质量信号，不等于数据库损坏或后台任务失败。
负例、隔离测试和正确弃答也会形成热点。应先核对这些 trace 是否本来就没有
证据，再决定扩展 rewrite/别名；不要为了让数字归零而放宽相关性门槛。

## 9. 日志健康与故障

```bash
curl -sS "$BASE/api/retrieval-log/health"
```

判断：

- `consecutiveFailures=0`：当前健康。
- `lastError` 包含 `EACCES/ENOTDIR/EEXIST`：JSONL 路径或权限问题。
- `no such table`：SQLite trace schema 受损或迁移未完成。
- `totalFailures` 持续增长：立即处理磁盘、权限或数据库错误。

SQLite trace 写失败和 JSONL 写失败都必须在 health 中可见。测试已覆盖：
日志路径不可写时召回继续；trace event 表故障时已存在记忆仍可召回且真相不变。

## 10. 隐私与留存

- 普通接口只能读取当前 principal 的 trace。
- credential memory 永不进入召回和日志。
- 导出的 trace 仍可能包含 memory UUID、范围、模型决策和 diagnostic query。
- 工单结束后删除临时导出，按最小权限保存。
- 可用 `/api/retrieval-traces/prune` 清理 SQLite trace；JSONL 按保留天数清理。

## 11. 离线评测

```bash
npm run evaluate:retrieval-p1
```

报告包含 baseline/P1 的 Recall@5、MRR、nDCG、低召回率、零结果率、P95、
模型调用数、越权/意外命中和逐 case trace。固定集是回归哨兵，不是线上成功率。

## 12. AIRI 回答层的召回修复

retrieval trace 证明“系统找到了什么”，compat audit 证明“用户最终看到了什么”。
两者必须用同一 traceId 关联：

```text
HTTP requestId
  → [airi-ollama-compat] requestId
  → zero_recall_abstention / grounded_recall_repair
  → retrievalTraceId
  → SQLite request.correlationIdHash (requestId 的 SHA-256，不保存原文)
  → SQLite request→rewrite→channels→fusion→semantic→rerank→selection→context→result
```

若用户看到精确 `不知道。`，应找到唯一
`zero_recall_abstention/result=forced`；若看到 `根据长期记忆：……`，应找到唯一
`grounded_recall_repair/result=forced`。两者的 `memoryContextReason` 只能是
`explicit_query` 或 `private_fact_query`。

排查要点：

- trace 为 full 且 result count=0：私有事实应弃答，世界知识/建议应正常透传。
- trace 有可信私有事实但回答模型否认或换值：应由 grounded repair 修复。
- forced event 多于 1 个、类型冲突、reason 错或 traceId 不一致：验收必须失败。
- 回答出现 `[派生摘要:...]` 或内部 UUID：属于 provenance 泄漏，不是正常召回文本。

兼容层日志查看和验收快照方法见[日志查看总览](logging-guide.md#15-airi-兼容层审计与强制回答)。
