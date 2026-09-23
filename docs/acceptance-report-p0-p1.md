# AIRI 长期记忆 P0/P1 最终验收报告

> 日期：2026-08-09  
> 服务端 schema：28  
> 开发验收模型：`legacy local generation model`  
> Embedding：`bge-m3:latest`

> **历史快照说明：** 本报告只证明 2026-08-09 的 schema 28/P0-P1 基线，
> 不是当前 schema 31 的发布结论。当前证据请查看
> [schema 31 当前验收报告](acceptance-report-schema31-context-reflection.md)。

## 1. 当前发布判定

当前判定：`PASS`。

服务端 P0/P1、检索可观测性、规模、真实模型、崩溃恢复、MCP、AIRI 代码
契约和 P0-05 真实桌面闭环全部通过。桌面验收使用 AIRI 0.11.3、Alice/Bob
两个隔离 profile 和独立验收数据库；正式 3789 服务及正式数据库未被改写。

## 2. 验收矩阵

| 范围 | 状态 | 证据 |
|---|---|---|
| P0-01 账户切换 hydrate | PASS | stage-ui session/chat 契约包含账户切换回归 |
| P0-02 fork/lifecycle lease | PASS | session、chat-sync lifecycle 和崩溃恢复测试 |
| P0-03 单 authority/command bridge | PASS | stage-tamagotchi authority/chat-sync 定向测试 |
| P0-04 跨 renderer/故障注入 | PASS | browser contract、完整服务端回归、SIGKILL 恢复 |
| P0-05 真实 AIRI 双账户/双 persona/双 project/fork/重启 | PASS | AIRI UI、脱敏代理日志和 SQLite 三方证据 |
| P1-01 rewrite/multi-query/自适应重排 | PASS | P1 固定哨兵和 trace 事件 |
| P1-02 反馈先验/正负难例 | PASS | 反馈绑定、难例和有界先验测试 |
| P1-03 一跳图扩散/权限重检 | PASS | graph principal/scope 隔离测试 |
| P1-04 grounding/abstention | PASS | memory/version/evidence 注入、负例弃答 |
| P1-05 Memory Doctor | PASS | 9 类检查、只读约束及真实验收库健康快照 |
| P1-06 重排器与评测 | PASS | `legacy local generation model` 真实重排基准 |
| P1-07 真实表达回归哨兵 | PASS | 11 条同义、跨语言、否定、时间、指代、scope、干扰和压缩场景 |
| 九阶段检索日志 | PASS | SQLite trace、JSONL、脱敏、轮换、健康与故障旁路 |
| 文档 | PASS | MCP、操作、HTTP API、日志排障和本报告 |

## 3. 自动化验证结果

### 3.1 服务端

- `npm run typecheck`：PASS。
- `npm run build`：PASS；Vite 生产构建 1,592 modules。
- `npm test`：435/435 PASS，fail 0。
- 完整回归在允许临时 loopback 的验收环境执行；受限沙箱的 socket
  `EPERM` 只作为基础设施诊断，不作为产品断言结果。
- 可观测性与故障注入定向测试：7/7 PASS。
- HTTP trace、反馈、日志健康与 Doctor 定向测试包含在 435 项完整回归中。
- 两个真实 MCP Token、两个进程、重启后 principal 隔离包含在完整回归中。

### 3.2 规模与性能

默认开启 JSONL 的首次规模验收暴露日志性能回归：

- 候选生成 P95：84.906 ms，门槛 200 ms。
- 完整非 LLM 检索 P95：421.603 ms，超过 350 ms 门槛。

对照测试关闭 JSONL 后，完整非 LLM 检索 P95 为 289.419 ms。定位到旧实现
每个阶段同步追加一次 JSONL，并再次写一次日志健康表。修复后保留九阶段逐行
格式，但每个 trace 只批量追加一次 JSONL、更新一次健康状态。

最终默认配置复测：

- 100,000 条记忆、1,000,000 个 conversation turns、100 个 session。
- 第 1,001、10,001、100,000 位置的边界记忆均可召回。
- 候选生成 P50/P95/max：66.030 / 70.396 / 79.222 ms。
- 完整非 LLM 检索 P50/P95/max：305.162 / 316.915 / 337.977 ms。
- Dense 离线全量回填：300,072.570 ms；该时间不计入热查询 P95。
- 隔离数据库约 3.37 GB，退出时已自动删除。

### 3.3 真实本机模型

`npm run benchmark:rerank`：

- 模型：`legacy local generation model`。
- 候选：16；样本：5。
- P50/P95/max：405.970 / 409.884 / 409.884 ms。
- 门槛：2,000 ms；PASS。

`npm run evaluate:dense`：

- 模型：`bge-m3:latest`，1,024 维。
- 查询：20。
- Recall@20：1.000。
- MRR@10：0.975。
- failed cases：0；PASS。

`npm run evaluate:retrieval-p1`：

- 11 条固定真实表达，其中 10 条正例、1 条无证据负例。
- Recall@5 / MRR@5 / nDCG@5：1.000 / 1.000 / 1.000。
- 负例弃答准确率：1.000。
- forbidden hit：0；unexpected hit：0；missing required：0。
- 零结果率从 baseline 0.6364 降到 0.0909。
- P95：2,888.175 ms。
- 平均模型调用：2.909 次/请求。
- 压缩整理后场景命中真实 `MemoryConsolidator` 生成的派生摘要。

该固定集只是回归哨兵，不能宣传为线上检索成功率。线上仍需按真实流量保存
trace、人工反馈和失败样本，持续计算分桶质量。

### 3.4 可靠性

`npm run verify:crash-recovery`：PASS。

- Worker 被 `SIGKILL` 后从过期 lease 恢复，提取任务 attempts=2 后完成。
- incomplete outbox：0；incomplete jobs：0；dead letters：0。
- duplicate stable keys：0。
- SQLite integrity：`ok`；FK violations：0。
- 隔离库退出时已删除。

此前当前主线的完整 30 分钟 soak 已通过：10 sessions、2 workers、35,960
turns、0 incomplete outbox/jobs、0 dead letter、0 重复或孤儿、integrity `ok`、
FK 0。此次日志批量调整另有 407 项回归和 10 万规模复测覆盖。

## 4. AIRI 代码契约

- stage-ui session-store/chat contract：2 files，69/69 PASS。
- stage-tamagotchi authority/chat-sync lifecycle：3 files，53/53 PASS。
- Chrome browser context-bridge contract：1 file，24/24 PASS。
- stage-ui `vue-tsc --noEmit`：PASS。
- stage-tamagotchi `vue-tsc --noEmit`：PASS。

browser contract 控制台中的“invalid identity”和“provider offline”是测试主动构造
的 fail-closed 分支；最终 24 项断言全部通过。

## 5. 隔离真实桌面环境

schema 28 隔离环境完成真实桌面验收后的最终状态。隔离目录和 namespace 名称中
保留的 `v27` 是当次检索可观测性验收标签；最终数据库实际
`PRAGMA user_version=28`：

- 两个有独立凭据的 principal：Alice、Bob。
- 两个 mode-0600 AIRI profile 与独立 `mcp.json`。
- namespace：`airi-final-v27`，两个账户均有 24 小时 `auto` bootstrap。
- 初始规范记忆、turn、candidate 均为 0，排除演示数据污染。
- principal count 3（含 legacy `default`），credential count 2。
- integrity `ok`；FK violations 0。
- 隔离忆桥监听 3790；已有的 3789 服务未停止、未覆盖。
- Alice 25 个 session、2 个 persona、project A/project B/无 project 三种绑定；
  Bob 5 个 session，只有自己的 persona 和无 project 会话。
- Alice 12 个规范记忆项，其中 7 active、5 inactive，16 个版本，最大 revision 4；
  personal tombstone 4 个、role tombstone 1 个。Bob 仅 1 个自己的 active 记忆。
- Alice/Bob `quality=full`，Dense eligible/indexed 分别 7/7 与 1/1，lag 0；
  retrying、stale、quarantined 和未解决 dead letter 均为 0。
- 原始 dead letter 历史保留为审计证据；Alice 当前可见历史 2 条且均
  `resolved=true`，Bob 为 0。历史记录不等于当前故障。
- 只有 1 条稳定全局 consolidation sweep；Alice、Bob、default 各 1 条
  retention sweep；重复活跃任务链 0，outbox pending/running/failed 均为 0。
- Memory Doctor 的 8 类结构/一致性问题为 0；Alice 有 18 个由负例和
  零召回隔离查询产生的 info 级 zero-result hotspot，整体状态仍为 `healthy`，
  `destructiveActionsTaken=0`。
- 检索日志为 `metadata` 且 JSONL 开启；Alice/Bob 当前
  `consecutiveFailures=0`、`lastError=null`。Alice 保留 5 次历史日志故障计数，
  `totalFailures` 不会因恢复而抹除，不能与当前连续失败混为一谈。
- SQLite `integrity_check=ok`、`foreign_key_check=0`。

令牌只存在 mode-0600 临时 secrets 文件和 MCP 配置，不写入报告、日志或截图。

## 6. P0-05 真实桌面证据

1. Alice 在日常表达中自动形成项目事实，并在新聊天中无关键词召回；权威链
   来自生命周期代理，不依赖用户说“请记住”或模型主动调用 MCP。
2. Alice 的项目事实完成同 UUID 多版本纠正；新会话只使用当前版本。自然遗忘
   生成 personal/role tombstone，重启后旧事实没有复活。
3. Alice 同时覆盖 persona A/B、project A/B 与无 project。项目 A 聊天通过
   AIRI 可见入口执行“分叉并切换”，新分叉继承 project A，并正确召回项目代号
   “青铜海燕”和颜色“靛蓝”。
4. Bob 查询 Alice 项目事实时，重排器明确拒绝主体不一致候选，AIRI 回答
   “不知道”；Bob 查询自己的夜间饮品时正确回答“玄米茶”。
5. 完整退出/重启后，身份绑定、当前版本、tombstone、Dense generation 和
   唯一治理任务链保持一致；UI、脱敏代理日志与 SQLite 结果一致。

本报告不保存聊天全文、Token、credential secret 或截图中的私人字段。临时
Token 只存在 mode-0600 验收文件中。

## 7. 文档交付

- `docs/prd-p0-p1-observability-delivery.md`：实施 PRD、可行性和任务拆解。
- `docs/mcp-guide.md`：MCP 启动、身份、七工具与客户端配置。
- `docs/operator-guide.md`：安装、运行、AIRI、账户、备份、升级和排障。
- `docs/api-reference.md`：HTTP 认证、接口、请求响应、错误与一致性。
- `docs/retrieval-logging.md`：九阶段 trace、反馈、Doctor、隐私和排障决策树。
- `docs/airi-integration.md`：真实 AIRI 生命周期接入和验收步骤。

## 8. 诚实边界

- 本次真实 AIRI P0-05 已通过，但以后更换 AIRI 主版本、身份头契约或模型
  Base URL 后，服务端自动化 PASS 仍不能替代重新执行桌面闭环。
- 固定 11 条评测 PASS 不等于线上成功率 100%。
- `legacy local generation model` 是开发成本基线；更换生产模型后必须重建/切换 Dense generation，
  重跑质量门禁，不得直接继承本报告结论。
- Memory Doctor 只报告，不自动修复；日志用于定位原因，不自动证明模型回答正确。
