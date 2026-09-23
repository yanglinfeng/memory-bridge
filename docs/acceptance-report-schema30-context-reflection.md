# schema 30 上下文查询与历史重提炼验收报告

> 历史快照：本文只证明 schema 30 当时的代码和回执，不是 schema 31 当前发布
> 结论。当前证据请查看
> [schema 31 当前验收报告](acceptance-report-schema31-context-reflection.md)。

> 日期：2026-08-10  
> 数据库 schema：30  
> 查询、提取、反思模型：`legacy local generation model`  
> Embedding：`bge-m3:latest`

## 1. 最终判定

当前判定：`FAIL`。

功能正确性、安全隔离、历史重提炼质量、百万级规模、崩溃恢复和隔离 AIRI
闭环均已通过；唯一未通过项是目标生产硬件上的查询理解 warm P95 ≤ 1.5 秒。
本机 `legacy local generation model` 实测 warm P95 为 3956.973 ms，因此不能写成“全部通过”或
“可以直接生产放量”。

这不等于功能不可使用。当前代码可用于本机开发、AIRI 集成和 shadow 模式验证；
生产放量前必须在目标硬件或目标生产模型上重跑同一固定集并通过延迟门槛。

## 2. PRD 范围验收

| 范围 | 状态 | 验收结论 |
|---|---|---|
| 上下文查询理解 | 功能/安全 PASS，生产延迟 FAIL | 同 session 有界历史、歧义关闭、多查询融合、trace 和 120 条真实模型评测已实现 |
| 通用历史重提炼基础设施 | PASS | schema 30、双 checkpoint、不可变 turn 清单、预算、租约、取消、事件、备份和清除闭包已实现 |
| 历史直接事实重提取 | PASS | 版本化回放、现有 extractor/Resolver、安全门禁和跨版本去重已实现 |
| 跨多轮历史反思 | PASS | 逐字证据、敏感信息过滤、只进待确认、确认时重新校验已实现 |
| 管理 API、界面与用户控制 | PASS | preview、运行、取消、详情、事件链、模型账本、shadow 开关和候选处理已实现 |

原五项之外的可靠性交付缺口也已收口：

- `reextract` 与 `reflect` 使用独立 generation/checkpoint，不再互相饥饿。
- 并发槽位检查、预算预留和租约领取处于同一事务边界。
- preview 分别返回两条 pipeline 的 turn、token、调用量和阻塞原因。
- status 使用最差 scope/pipeline lag，不用领先水位掩盖落后水位。
- sweep 覆盖活跃 personal/project/role/session，同时限制 session 回看窗口。
- run、model call 和取消/失败事件能够还原真实成本和处理链。
- 固定集达到 120 query、100 history window，并强制真实 provider 覆盖率 100%。
- scope 增量发现固定由 ingest 索引驱动，session 选窗固定命中 session 索引。
- 同 owner/scope/run type/generation 已有活跃 Run 时，sweep 在选窗前跳过。
- Job/Run heartbeat、Worker fencing、取消清理和 sweep 水位续链均有回归与崩溃证明。

## 3. 自动化回归

- `npm test`：522/522 PASS。
- `npm run typecheck`：PASS。
- `npm run build`：PASS；Vite 生产构建 1,593 modules。
- `npm run verify:crash-recovery`：PASS。

真实 `SIGKILL` 恢复验证中，崩溃 Worker 的 Job/Run 被新 Worker 接管，
`attempts=2`，checkpoint 只前移一次。模型调用状态为一条 `completed`、一条
`failed`，事件链为：

```text
queued → started → model_call_reserved → model_call_failed →
started → model_call_reserved → model_call_completed → completed
```

恢复后 SQLite integrity 为 `ok`，FK violation 为 0。

## 4. 固定质量评测

两个回执使用相同 fixture SHA-256：
`278910549a3a531e1c03d1dc94ec660b3c1c79e5f40efa03263ed2ab7f4b56bc`。

### 4.1 查询理解

回执：`/private/tmp/memory-bridge-query-quality-v1-final3.json`。

| 指标 | 结果 | 门槛 | 状态 |
|---|---:|---:|---|
| 样本 | 120 | 120 | PASS |
| 真实 provider 调用 | 120/120 | 100% | PASS |
| 唯一消解语义正确率 | 99% | ≥ 92% | PASS |
| 约束保留率 | 100% | 100% | PASS |
| 错误记忆注入 | 0 | 0 | PASS |
| scope 泄漏 | 0 | 0 | PASS |
| 每例最大模型调用 | 1 | ≤ 1 | PASS |
| warm P95 | 3956.973 ms | ≤ 1500 ms | **FAIL** |

唯一功能偏差是 `entity-20:pronoun_preference` 被模型保守判为 ambiguous；该结果
不会注入错误记忆。评测器要求每个案例实际调用 provider，正则、缓存或 mock
绕过会直接使评测失败。

### 4.2 历史重提炼

回执：`/private/tmp/memory-bridge-reflection-quality-v1-final.json`。

- 100 个隔离窗口全部完成。
- 直接事实 precision：100%。
- 直接事实正例窗口召回：100%。
- 稳定模式正例窗口召回：100%。
- inference 自动提交、无逐字证据、tombstone 复活、scope 混合、credential
  泄漏、诊断式推断、重复副作用和跨版本重复：全部为 0。

## 5. 百万级规模

基准数据为 100,000 条记忆、1,000,000 个 turn、100 个 session：

- 候选生成 P95：42.820 ms。
- 完整非 LLM 检索 P95：253.527 ms。
- Reflection 增量 preview P95：0.726 ms。
- Reflection 稳定 sweep P95：1.873 ms。
- 初次 sweep 发现 101 个 scope，创建 202 个双 pipeline Run。
- ingest 查询计划命中 `memory_turn_ingest_owner_idx`。
- role/project/session 选窗命中 `conversation_turns_session_idx`。

SQLite 使用 64 MiB 页缓存、256 MiB mmap 和内存临时表；这些是有界运行配置，
不是通过无限扩大内存掩盖全表扫描。

## 6. 隔离 AIRI 与管理台验收

验收环境：

- 隔离服务：`127.0.0.1:3792`。
- namespace：`airi-final-v30`。
- 两个独立 principal 和两个独立 AIRI profile：Alice、Bob。
- 初始 turn、session 和规范记忆均为 0，没有演示数据污染。
- 正式 3789 服务和正式数据库未停止、未覆盖、未迁移。

长聊天回执 28/28 PASS，包含 41 次真实聊天和 10 次 MCP 调用。最终形成：

- Alice：14 个 session、44 个 turn、10 条 active memory、1 条 deleted memory。
- Bob：11 个 session、38 个 turn、11 条 active memory、1 条 deleted memory。
- 账户、role、project 和 session 负例均未串数据。
- 自然纠正后只返回新值；自然遗忘后旧值没有复活。
- SQLite integrity `ok`，FK violation 0，outbox open 0。

管理台补充验证：

- Alice `personal/self` preview 显示 27 条待处理 user turn，两条 pipeline 独立估算。
- `role/alice-ink` 只读 preview 显示 14 条相关 user turn。
- `session/alice-ink-train` 只读 preview 显示 5 条相关 user turn。
- 两次 scope preview 均显示“没有写入运行或候选”。
- 真实 `reflect` Run `af9e53c5-ce80-4c3c-82a1-4d0b5d083f24` 完成，使用
  `legacy local generation model`，checkpoint 前移到 ingest 97，0 pending、2 rejected。
- 取消 Run `bff6a149-7ebb-40e2-9d8f-284801c254db` 最终为 cancelled；三次已派发
  模型调用均记为 completed，没有遗留 `reserved`。
- Bob 在相同 namespace 中看不到 Alice 的 Run、checkpoint 或模型调用。

关闭隔离服务前的直接数据库核验：integrity `ok`、FK violation 0、Reflection
模型调用 `completed=4`、`reserved=0`。周期性 reflection/retention/consolidation
sweep 的下一次任务保持 pending 属于调度设计，不等同于未收敛的执行任务。

该隔离库另保留一条 `consolidate_scope` dead letter：本机 Qwen 在五次尝试中仍
未覆盖一个派生来源。它不属于 schema 30 Reflection Run，也未造成跨账户或
错误记忆写入，但证明本机 legacy local model 的巩固质量仍需运维处理；不得把这份临时验收库
描述为“零历史故障”。

## 7. 发布与使用边界

允许：

- 本机开发与功能验证。
- AIRI 通过 MCP/生命周期代理接入。
- 历史重提炼 `shadow` 运行和人工确认。
- 用真实日志、trace、事件链和模型账本分析召回或提炼问题。

暂不允许：

- 宣称已满足 1.5 秒生产查询理解 SLA。
- 未在目标硬件重验就开启大规模生产流量。
- 自动提交 `assistant_inference`。
- 把 dead letter、模型失败或低召回静默当作成功。

最终发布口径固定为：

```text
FAIL / 功能、安全、规模和 AIRI 隔离验收通过，但 legacy local generation model 查询理解生产延迟 SLA 尚未通过
```
