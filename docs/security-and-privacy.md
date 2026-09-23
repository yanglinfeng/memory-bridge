# 安全与隐私指南

忆桥是本地优先的个人长期记忆服务。它默认缩小网络暴露和数据外发，但不等于
“无需安全管理”。本手册说明当前实现保护什么、没有保护什么，以及正式使用的
最低安全要求。

## 1. 保护对象

- 用户长期偏好、身份事实、项目内容和关系信息。
- 原始对话 turn、证据摘录和历史版本。
- 账户凭据、principal/persona/session/project 绑定。
- 检索 query、trace、反馈难例和审计记录。
- JSON 备份、SQLite 文件、WAL、JSONL 日志和诊断导出。

这些内容即使没有标记 `sensitive`，也应按个人敏感数据处理。

## 2. 默认安全边界

- HTTP 只监听 `127.0.0.1`；也可明确选择 `::1`。
- 配置解析器不会接受局域网或公网监听地址。
- MCP 使用本地 stdio，不需要中转服务器。
- 模型默认调用本机 `127.0.0.1:11434` Ollama。
- 首次启动为空库，不注入演示用户或默认私人数据。
- 账户建立后，HTTP 请求必须通过 Bearer 凭据确定 principal。

loopback 只阻挡远程网络，不阻挡同一系统账户下的恶意本机进程。电脑被入侵、
数据目录权限过宽或用户主动接入云端模型时，忆桥无法提供完整机密性。

## 3. 账户与 Token

Token 格式为 `mb1.<credential-id>.<secret>`。数据库只保存 SHA-256 secret hash
和末尾提示，不保存可恢复明文。

安全做法：

- Token 只在初始化/签发当次显示，立刻存入密码管理器。
- 为 AIRI、管理台和其他 MCP 客户端签发独立标签的凭据，便于单独撤销。
- 不要把 Token 放入 Git、README、截图、JSONL、聊天消息或问题报告。
- 避免把 Token 直接写在 shell 命令行；可用 `read -s` 读取环境变量。
- 撤销当前凭据前先确认另有一枚有效凭据。
- 不再需要的凭据立即撤销；长期运行客户端使用专用凭据。

管理台 Token 只保存在页面内存，未写 localStorage。MCP 的
`MEMORY_BRIDGE_MCP_TOKEN` 在启动认证完成后从进程环境删除，减少后续诊断或
子进程暴露概率。

## 4. 首次初始化

`POST /api/identity/bootstrap` 只允许：

- loopback 来源；
- 同源或非跨站浏览器请求；
- `Content-Type: application/json`；
- 全库从未建立凭据；
- 严格允许字段。

初始化成功后匿名本机访问和 legacy 全局 Token 迁移路径关闭。不要让不可信
本机用户抢先访问尚未初始化的实例。

## 5. 多账户与多角色隔离

principal 是强安全边界；namespace、persona、project、session 是 principal
内部的可见作用域。

服务强制：

- HTTP body/query 中的 `userId`、`principalId` 被拒绝。
- 所有业务查询隐含当前 principal。
- schema 28 persona 唯一键包含 principal。
- role scope 绑定稳定 persona ID，不依赖可变显示名。
- project 只来自可信 session 绑定，旧 metadata 不参与回填。
- session/project/persona 归属建立后由触发器和 ledger 保护不可变。
- MCP 一个 stdio 连接固定一个 principal、一个 namespace 和一组可见 scopes；
  缺少完整 persona/session 身份时只允许 `personal/self`。
- schema 39 的 `memory_evidence_owner_insert` 与
  `memory_evidence_identity_update` 是数据库最终防线：带 turn 的 evidence 必须与
  version、owner、namespace 和 scope 对齐，版本或 turn 不能事后换绑。启动会校验
  规范触发器 SQL 并扫描污染行；同名削弱触发器会被重装，既有污染会阻止打开数据库。

用户自定义 headers 中与 AIRI 保留身份头同名的字段会被剥离或覆盖，不能伪造
另一 persona、session 或 project。

## 6. 记忆内容安全

- `credential` sensitivity 的内容拒绝保存为长期记忆。
- `sensitive` 内容使用更保守的提取、展示和召回策略。
- 自动提取只保存跨会话有价值的原子 claim，不应保存完整无关对话。
- 用户可 Pin、归档、软删除、禁止再记或排队物理清除。
- tombstone 在物理清除前立即停止召回并阻止同义复活。
- Memory Doctor 只读，不会以“修复”为名修改或删除数据。

每条 evidence 永久归属一个具体 memory version。没有 turn 的外部来源证据可以直接
创建，但不能事后伪装成某条对话 turn；旧版本证据也不能移动到当前版本。

仍需在 AIRI 角色、模型提供商和使用场景层面限制“哪些记忆应该注入”。忆桥
不能阻止用户主动把召回内容发送给云端 LLM。

## 6.1 会话权威 API 安全

Conversation API 只接受当前一条用户消息，不接受客户端提交完整 `messages`、
`systemPrompt`、`memoryContext`、`recentTurns`、`userId`、`principalId` 或
`namespace`。principal 由 Bearer credential 得出，persona/project 从已授权的
会话不可变绑定读取。不存在和越权资源统一返回 404，避免枚举。
生命周期证据只能引用该服务端可信 session 中的 turn；客户端 `recentTurns` 只用于
本轮语义消歧，不能成为可信证据或改变证据归属。

服务端还执行以下边界：

- 用户和助手正文持久化前执行 credential 替换；聊天审计不保存正文、Prompt、Token、
  召回上下文或 provider wire。
- 同一会话只允许一个非终态 round；用户消息、round 和 accepted event 同事务。
- round 的 lease、attempt、generation 和删除 barrier 阻止重启或晚到模型结果越权落库。
- `assistant.delta` 只有通过句级协议清洗后才可发布；未闭合 ACT/工具协议继续缓冲。
- emotion/motion 只允许固定 registry 中、且 persona profile 已授权的 capability；动作与
  展示正文分表保存。
- 完整响应再次清洗并与已发布 delta 逐字校验；分叉或协议畸形返回
  `ASSISTANT_PROTOCOL_INVALID`，不写权威 assistant message。
- 分页、change feed 和 import cursor 使用实例 HMAC key，并绑定 principal、namespace、
  cursor 用途和位置；伪造、跨账户重放或跨用途替换均被拒绝。

SSE 断开不会默认取消服务端 round。客户端必须使用同一 `clientMessageId` 查询或重连，
不能用新 ID 猜测性重发，否则会产生一个新的业务请求。

## 7. 模型与数据外发

默认 Ollama 是本机服务，忆桥不会主动上传记忆。但隐私边界取决于
`MEMORY_BRIDGE_OLLAMA_URL` 和 AIRI 最终模型：

- 指向远程 Ollama-compatible 服务会把提取/重排/巩固内容发到该服务。
- AIRI 选择云端模型时，最终注入的记忆上下文可能离开本机。
- 远程服务的日志、训练、保留和地域政策不由忆桥控制。

改为远程模型前，应完成供应商评估、数据分类、最小披露和用户同意。

## 8. 日志与诊断隐私

| 数据 | 默认内容 | 风险 |
|---|---|---|
| 业务审计 | action、memoryId、结构化 detail | 可重建用户行为 |
| Conversation 审计 | conversation/round/request/attempt ID、阶段耗时、稳定错误码 | 可关联聊天时间和失败模式 |
| retrieval metadata | query hash、scope、阶段统计 | 可关联行为模式 |
| diagnostic trace | 经脱敏 query 和详细阶段 | 仍可能含个人信息 |
| JSONL | trace 的旁路副本 | 文件权限和保留风险 |
| 诊断导出 | 单次完整 trace | 易被附到工单或聊天 |
| 进程 stderr/stdout | 启动、关闭、错误 | 错误对象可能含路径或模型信息 |

生产保持 `metadata`。只有在限时排障窗口开启 `diagnostic`，结束后恢复默认并按
保留策略清理。任何导出在分享前都应再次人工脱敏。

## 9. 数据目录与文件权限

最低要求：

- 数据目录仅当前系统用户可读写。
- 不放在公开同步盘、公共共享目录或 Web 根目录。
- SQLite、WAL、SHM、迁移备份、JSONL 和 JSON 备份采用同一敏感等级。
- 磁盘启用系统级加密；电脑离开时锁屏。
- 备份介质加密，并定义独立删除/过期策略。

忆桥当前不实现字段级静态加密，依赖操作系统磁盘加密、文件权限和主机安全。

## 10. 删除与“被遗忘权”

### 软删除

写 tombstone、停止召回、保留恢复能力和审计证据。

### 物理清除

异步删除正文、版本证据、索引、关系和受影响派生内容。完成前在“系统状态”
查看 purge job。

删除消息/会话时还必须明确选择：

- `retain_derived_memories`：聊天正文删除，原 evidence 转为无正文、不可逆 hash 的删除
  证明，已支持的规范记忆可保留。
- `forget_derived_memories`：撤销直接 evidence；唯一证据记忆 tombstone，多证据记忆
  追加只由剩余证据支持的新版本。

删除重算通过追加新版本和复制剩余有效证据完成，不会修改旧 evidence 的 version/turn
身份。唯一允许的身份变化是原 turn 物理删除后由外键把原 `turn_id` 清空；禁止换绑到
另一 version 或另一 turn。

删除事务会同步清除历史 SSE/change 中的正文与 action，写至少 30 天的 generation
barrier，并取消受影响的 in-flight round。关系/索引重算和延迟正文 purge 由有界维护
任务执行；failed/dead 必须进入发布健康门禁。

### 系统边界之外

物理清除不会自动删除：

- 先前导出的 JSON 备份。
- 手工复制的 SQLite 数据目录。
- 已分享的 trace、截图或工单。
- 云端模型服务已经保留的输入。

处理删除请求时必须同时盘点这些副本。

## 11. 备份与恢复安全

- JSON v3 备份包含私人记忆、会话和证据，按明文敏感文件管理。
- 导入只允许 backup userId 与当前 principal 相同。
- 完整身份不能由 backup 自报的 schemaVersion 证明；目标库必须已有可信锚。
- 导入在删除目标状态前验证引用链和身份绑定，失败时事务回滚。
- 目标库现有 tombstone ledger 不会因旧备份而被轻易绕过。
- embedding/Dense 会重建，不把旧向量当作可信可移植状态。

AIRI 历史迁移使用独立的 Conversation import API。先以 `dryRun=true` 验证，再从
空 cursor 开始 commit；dry-run/commit lane 不共享 cursor。每个 cursor 绑定账户、
namespace、importId、lane、批次和 payload hash，批内任何结构、身份或所有权错误都
整批回滚。导入 receipt 只保存 hash 和统计，不保存一份额外聊天正文。导入的 turn
默认不触发自动提取，避免迁移时重复制造记忆。

## 12. 网络部署限制

当前版本设计为单机 loopback 服务，不提供：

- TLS 终止。
- 公网速率限制和 WAF。
- 浏览器跨域开放策略。
- 面向互联网的账户注册、密码找回或管理员 RBAC。
- 多主数据库或跨主机一致性。

不要通过修改代码或端口转发直接暴露公网。如果业务要求远程访问，应先设计
TLS、反向代理鉴权、审计、限流、主机隔离和安全测试，并把它作为新的交付范围。

## 13. 最低上线检查

- [ ] 数据目录仅当前用户可访问。
- [ ] 已初始化账户并为每个客户端签发独立凭据。
- [ ] 没有 Token、备份或私人 trace 进入 Git。
- [ ] `MEMORY_BRIDGE_HOST` 为 loopback。
- [ ] Ollama URL 和 AIRI 模型的数据去向已确认。
- [ ] 生产使用 retrieval `metadata`。
- [ ] 已验证 Alice/Bob 负向越权测试。
- [ ] project/session fork 和不可变绑定测试通过。
- [ ] schema 39 两条 evidence 触发器 attestation 通过，owner/namespace/scope 污染行是 0。
- [ ] 跨账户、跨 namespace/scope 插入和 version/turn 换绑负例都被数据库拒绝。
- [ ] Conversation HMAC cursor、同会话 single-flight、断线恢复和晚到 completion 门禁通过。
- [ ] assistant 历史中 ACT、工具包装、Token 和记忆内部协议污染为 0。
- [ ] 删除 retain/forget、证据传播、SSE/change 正文清除和维护任务无 dead。
- [ ] AIRI import dry-run、重复 commit、跨账户 cursor 和整批回滚通过。
- [ ] 备份已加密，恢复在隔离副本验证。
- [ ] 删除流程包含外部备份和诊断副本。
- [ ] 未解决 dead letter、Dense lag、retrying 和日志连续失败为 0。

## 14. 疑似串数据应急处理

1. 立即停止 AIRI、MCP 和忆桥写入进程。
2. 不要删除数据库、WAL、日志或 dead letter，先保全证据。
3. 记录当前进程配置、principal、credential hint、persona、session、project、
   traceId 和时间范围；不要记录完整 Token。
4. 导出受影响账户的只读诊断和一致性备份。
5. 用两个独立 Token 重放正向/负向隔离测试。
6. 检查 session 绑定、scope、v26 attestation、v28 persona binding、v39 evidence
   trigger attestation 和污染扫描。
7. 确认根因和影响范围后再恢复服务或执行数据治理。

具体命令见[故障排查](troubleshooting.md)和[日志查看](logging-guide.md)。
