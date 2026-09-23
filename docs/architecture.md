# 架构与记忆模型

本文描述产品层记忆模型。运行时模块、请求序列和失败语义见
[技术实现参考](technical-reference.md)，表组和 schema 见[数据模型](data-model.md)。

## 系统边界

忆桥负责会话、消息、当前上下文和长期记忆的唯一权威真相，以及自动生命周期、
检索、演变、治理和审计。AIRI/宝豆负责角色、语音、界面、可重建缓存和待发送
outbox，不再保存另一套权威聊天历史。新客户端使用 Conversation API；旧客户端
可继续经过本机 OpenAI-compatible 生命周期代理。MCP 工具是跨客户端记忆接口，
不是替代权威会话事务的触发器。

```text
AIRI / 宝豆 / 其他客户端
        │ 单条新消息 + Bearer 身份
        ▼
Conversation API（schema 36 引入，当前 schema 44）
  ├─ 会话/消息/round/change feed 权威账本
  ├─ HMAC cursor、幂等、租约、SSE 重放与删除屏障
  ├─ 安全句级流式清洗：正文 / ACT / memory claim 分层
  └─ AIRI dry-run/commit 历史导入
        │
        ▼
生命周期层
  ├─ beforeModel：上下文查询理解、自动召回与最小上下文注入
  ├─ completed transaction：用户/助手 turn、event 与 outbox
  └─ explicitIntent：自然记住、纠正、遗忘快车道
        │
        ▼
后台 Worker
  ├─ 提取与候选解析
  ├─ 历史直接重提取与跨多轮反思
  ├─ FTS / Dense 索引
  ├─ 非破坏式巩固
  └─ 保留、归档与物理清除
        │
        ▼
SQLite 真相库 ── FTS5 / Dense sign-LSH / 概念倒排
```

HTTP 管理 API 默认只监听 `127.0.0.1`。AIRI 的兼容 Base URL 默认为
`http://127.0.0.1:3789/ollama-compat/v1`。

Conversation API 的 single-flight 以 conversation 为边界：同一会话最多一个非终态
round。用户消息、round 和 `turn.accepted` 同事务；助手消息、active variant、
`turn.completed` 与 extraction outbox 同事务。服务重启后过期租约收敛为
`interrupted`，客户端以原 `clientMessageId` 显式重试，不复制用户消息。

## 分层数据

当前 schema 44 使用 L0–L4 五层，而不是把“有没有晋升为事实”当作是否记住：

| 层 | 权威载体 | 作用 | 模型失败时 |
|---|---|---|---|
| L0 原始会话 | session、turn、工具事件 | 不可替代的原始证据 | 仍保留 |
| L1 情景记忆 | `conversation_episodes` + `memories` | 每个完整 user/assistant exchange 都可检索 | 确定性物化，不依赖模型 |
| L2 行为观察 | `memory_pattern_observations` | 跨窗口累计弱信号、反证和纠正 | checkpoint 不前移 |
| L3 规范事实 | item、version、evidence、edge、event | 身份、偏好、规则、关系和项目事实 | 失败关闭，不提交残缺候选 |
| L4 层级摘要 | `conversation_memory_summaries` + `memories` | session/day/week 压缩 | 保留来源和上一有效版本 |

工作记忆只服务当前请求，不进入长期真相。治理层横跨 L0–L4，负责 Pin、TTL、
归档、tombstone、保留策略和物理清除。

`memories` 是兼容当前投影；`memory_items`、`memory_versions` 和
`memory_evidence` 才是版本与来源真相。更新不会覆盖历史版本。

## 自动写入

1. 成功交付回复后，代理原子记录用户/助手 turn 和 outbox。
2. Worker 不调用模型就把完整 exchange 物化为 L1 情景，并立即进入 FTS；Dense
   由可重试任务异步补齐。
3. Worker 使用 `qwen2.5:14b` 异步提取原子候选，不阻塞聊天首字。
4. 确定性规则先处理凭据、否定、时间、作用域和基数。
5. 关系引擎再判断 equivalent、reinforces、supersedes、contradicts 或
   coexists。
6. 高置信且通过 namespace 质量门禁的候选才能自动提交；其他候选进入
   待确认收件箱。
7. 每次提交同时追加版本、事件、outbox，并更新兼容投影；session 结束后再生成
   有来源边的 session/day/week L4 摘要。

namespace 默认处于 `shadow`。只有固定评测通过且运行时模型/提示版本相符
时才进入 `auto`；质量回归必须回退 `shadow`。

## 安全流式与动作分层

Ollama NDJSON 增量先进入 `StreamingAssistantProtocolSanitizer`。当前句子、未闭合
ACT 和可疑协议前缀留在内存缓冲；只有完整且已验证的安全句子才能持久化为
`assistant.delta`。完成事务重新清洗完整响应，并校验历史 delta 拼接是最终
`displayContent` 的逐字前缀，只写剩余后缀。任何分叉都以
`ASSISTANT_PROTOCOL_INVALID` fail closed。

结构化 emotion/motion 动作使用固定 registry 和 capability 授权，直到最终完成事务
才进入 `conversation_message_actions` 和 `assistant.action`。后段协议畸形时可保留
已经发布的安全 partial，但不写助手权威消息，也不发布提取 outbox。

## 会话删除与证据传播

删除先同步写 receipt、tombstone、round/conversation generation 屏障和无正文
`turn.deleted`，再清除历史 SSE/change 中的正文与 action。晚到模型 completion 必须
匹配 generation 和活动 attempt，否则不能写消息或 outbox。

- retain：evidence 改为无正文删除证明，规范记忆可继续存在。
- forget：撤销直接 evidence；唯一证据记忆写 tombstone，多证据记忆追加由剩余
  evidence 支持的新版本。
- 关系/索引收敛和延迟正文 purge 由有界维护任务执行；失败进入 failed/dead 健康门禁。

删除屏障和同步 tombstone 至少保留 30 天，防止离线缓存或晚到任务复活已删正文。

## 上下文查询理解

回答前先从同一 principal、namespace 和可信 session 读取有界最近对话。系统用
确定性检测器识别人称代词、指示词、省略承接和首轮召回质量不足，再最多调用一次
结构化理解模型。输出保留原查询，并区分：

- `not_needed`：独立问题，直接使用原查询。
- `resolved`：带逐字支持 turn 的独立查询，可参与多查询召回和重排。
- `ambiguous`：存在两个同等可能先行词，返回安全澄清且零记忆注入。
- `unavailable`：模型或上下文不可用；上下文依赖问题失败关闭。

模型不能决定身份和 scope。支持 turn、`surface/resolvedText`、否定、时间、
频率、条件、模态和主体/对象都由确定性代码复验。上下文消息中的提示词只是数据，
credential 在送模前脱敏。原查询始终保留，用于 trace、约束比较和失败回退。
每个被模型列为支持证据的 turn 都必须逐字包含 `resolvedText`，不能把竞争 turn
一并挂到同一个实体上绕过歧义门禁。唯一可信人名明确但模型改写漏掉时间、否定等
原词时，系统只替换原问题中的代词并保留其余原文；模型不可用时，仅对唯一且逐字
支持的明确“某项目”指示执行同类降级，其余上下文依赖问题仍返回 `unavailable`。

## 通用历史重提炼

schema 30 在逐 turn 提取之外增加两条独立 pipeline；schema 31 将每条 ingest
记录的 session 归属固化，并在数据库层校验证据与真实 session scope：

```text
monotonic ingest order
  ├─ reextract checkpoint → 冻结 run-turn 清单 → 逐 turn 直接事实重提取
  └─ reflect checkpoint   → 冻结 run-turn 清单 → 跨多轮稳定模式/可能变化
                                      ↓
                         逐字证据 + scope + credential
                         + tombstone + claim 单写者校验
                                      ↓
                         待确认候选 → 人工确认/拒绝/阻止
```

`occurred_at` 只定义语义窗口；扫描水位使用单调 `ingest_seq`，所以迟到数据不会
漏扫。run 创建时固化 turn ID、顺序和内容哈希，重试不能重新选择一个更有利的
窗口。成功提交候选、证据和 checkpoint 是同一事务；失败、取消、dead 和单条
超预算都不能越过历史。

跨实现版本使用 scope 内规范 claim fingerprint 合并 evidence，不重复展示候选。
被用户拒绝或“以后别再记”的推断由 claim 决策和 tombstone 共同抑制。模型调用
在执行前原子预留每日预算，并记录每次物理调用；默认同账户/namespace 并发 1。

历史直接重提取仍复用现有原子提取器、Resolver 和 namespace 自动提交门禁。
跨多轮反思固定为 `assistant_inference/pending`，至少三个不同 user turn 的逐字
证据，永远不能自动成为规范记忆；用户确认后才转为 `user_confirmed`。

## 全库召回

召回不按最近 1000 条预截断。系统对全体有效记忆并行执行：

- FTS5 / BM25；
- `bge-m3:latest` Dense sign-LSH/ANN；
- 概念与实体词项；
- namespace、访问作用域、状态、有效期和 tombstone 过滤。

事实、情景和摘要分别受分层配额约束，再经过 RRF 融合、去重、多样性处理和一次
`qwen2.5:14b` 批量严格重排。最终结果携带记忆 ID、版本 ID、检索通道、
分层来源、分数、质量状态和召回解释。情景标为“过往对话情景”，摘要标为
“派生摘要”，不能伪装成已验证事实。语义组件不可用时必须显式返回
`degraded` 或 `unavailable`。

## 巩固

schema 37 在会话结束后生成 session/day/week 层级摘要；原有主题/人物/项目巩固仍在
空闲 15 分钟、热主题达到阈值或来源变化时排入任务。
巩固只生成新的派生记忆，不覆盖原子事实。每个摘要句必须：

- 引用至少一个当前有效的来源版本；
- 通过独立的语义支持核验；
- 在来源修改、冲突、归档或遗忘后立即失效。

检索层还会再次验证派生来源，防止后台竞争窗口把过期摘要注入模型。

schema 38 对同一记忆、同一 scope 的待处理巩固任务做最新后继合并；已经 running
的任务不被中断，完成/部分完成/取消的反思 run 不再留下可执行窗口任务。队列因此
保留真实待办和故障证据，但不会因重复事件无限复制同一份工作。

## 可逆记忆精炼

保留扫描同时维护 L1 Episode 的冷热分层。最近 30 天、Pin、没有有效 week 摘要
覆盖的 Episode 保留完整索引；超过热窗口且已有有效 week 摘要的 Episode 只卸载
可重建的 embedding、Dense LSH、ANN 和词项热索引。原始 turn、Episode、版本、
证据链和 FTS 全部保留，因此精确文字检索和审计不会消失。

覆盖摘要失效时，系统先恢复 ANN/词项索引，再通过持久 outbox 让 Worker 重建
Dense。在线精炼只把释放页交给 SQLite freelist 复用，不阻塞服务执行 `VACUUM`；
是否在维护窗口把空闲页归还操作系统由运维显式决定。

## 遗忘与物理清除

普通遗忘先写 tombstone，再从所有召回路径排除记忆。tombstone 使用
作用域、类型、不可逆正文哈希和无明文语义指纹，阻止旧会话重新提取同义
事实；同一谓词的新值仍可保存。

物理清除由高优先级 Worker 执行，覆盖正文、候选、版本、证据、索引、
历史重提炼 run-turn/evidence/claim 可识别正文、派生摘要、缓存及系统受管迁移
备份。完成前必须成功截断 WAL。审计只保留
动作、时间和不可逆哈希；用户自行复制到系统管理范围外的导出文件不在
自动清除边界内。

## 模型边界

开发与验收固定使用：

- 聊天、提取、关系、自然意图、巩固和重排：`qwen2.5:14b`
- embedding：`bge-m3:latest`

模型与提示版本记录在生成项和质量快照中，但不写死在规范记忆真相里。
更换生成模型不迁移规范记忆；更换 embedding 使用新 generation 回填、
固定评测和原子别名切换。
