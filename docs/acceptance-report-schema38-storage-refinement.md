# Schema 38 后台收口与存储精炼验收报告

日期：2026-08-15  
结论：**本报告范围 PASS**。后台重复任务收口、Episode 可逆冷热精炼、重启不反弹、
原始证据保持和离线空间回收均通过。该结论不替代真实模型自然对话质量或 AIRI/宝豆
客户端真机发布门禁。

## 1. 已实现范围

- 同一 memory 的旧 pending/failed `consolidate_memory_change` 只保留最新后继。
- 同一规范 scope 的旧 pending/failed `consolidate_scope` 只保留最新后继；running
  和 recovery 任务不被中断。
- completed、partial、cancelled reflection run 的遗留窗口任务自动完成收口。
- 每次 retention sweep 精炼超过热窗口、未 Pin、且被 active week summary 覆盖的
  Episode。
- 精炼只卸载 embedding、Dense LSH、ANN 和 term 热索引；原始 turn、Episode、版本、
  证据链和 FTS 保留。
- 摘要失效时恢复 ANN/term，写 `episode_rehydrated` outbox，并由 Worker 重建 Dense。
- Dense 水位和启动索引修复排除冷 Episode，防止重启后索引反弹。

## 2. 真实数据库副本

来源数据库保持不变：

```text
.memory-bridge-private/natural-conversation-quality/run-5Mal6U/data/memory-bridge.sqlite3
```

最终验证副本：

```text
.memory-bridge-private/storage-refinement-validation/
run-5Mal6U-schema38-refinement-final-20260815/data/memory-bridge.sqlite3
```

来源为 schema 37、20,000 条 turn、10,000 个 Episode，使用既有
`legacy local generation model + bge-m3:latest` 测试数据。存储精炼本身不调用生成模型。

## 3. 验证结果

配置：热窗口 30 天，精炼时间 `2026-08-15T00:00:00.000Z`，批次 5,000。

| 检查 | 结果 |
|---|---:|
| 精炼 Episode | 10,000 / 10,000 |
| 保留原始 turn | 20,000 / 20,000 |
| 保留 Episode | 10,000 / 10,000 |
| 保留 FTS | 10,000 / 10,000 |
| 移除 embedding | 10,000 |
| 移除 Dense LSH | 320,000 |
| 移除 ANN | 160,000 |
| 移除 term | 960,000 |
| 重启后冷 embedding/Dense/ANN/term | 0 / 0 / 0 / 0 |
| 5 个账户 Dense watermark | 全部 complete |
| turn 指纹 | 精炼前后完全一致 |
| Episode 指纹 | 精炼前后完全一致 |
| `integrity_check` | `ok` |
| 外键违规 | 0 |

精炼事务后 SQLite freelist 为 130,543 页，页大小 4,096 字节，约 510 MiB 可供后续
写入复用。在线运行不强制 `VACUUM`，因此主要效果是抑制文件继续增长。

在停止写入的验证副本执行一次离线 `VACUUM`：

| 文件 | 字节 | 约 MiB |
|---|---:|---:|
| 来源副本 | 903,639,040 | 861.8 |
| VACUUM 前 | 903,688,192 | 861.8 |
| VACUUM 后 | 345,714,688 | 329.7 |
| 实际归还 | 557,973,504 | 532.1 |

文件体积下降约 61.7%。这个数字只代表该 20,000 条数据分布，不是所有用户库的固定
比例。

## 4. 自动化门禁

- `npm run typecheck`：PASS。
- schema 38 定向六文件回归：176/177；唯一失败为受限沙箱禁止监听 loopback，允许
  `127.0.0.1` 后该 HTTP 用例单独 PASS。
- `npm test`：881/881 PASS，包含 HTTP/SSE、MCP、迁移、队列、治理、精炼和一键安装
  bundle 一致性。
- `npm run build`：PASS，Vite 1,593 modules。
- `npm run bundle:pinokio:check`：PASS，bundle fingerprint
  `edcdf65b1a40557717ece1ffa0c3ba7dd7509f2a7d9a2e39426c8e5f15babb75`。
- `npm run verify:storage-refinement`：真实数据库副本 PASS。
- `npm run qa:pinokio-lifecycle`：19/19 阶段 PASS；2 principal、4 persona、7 个 MCP
  工具，恢复后 recall/list/stats 各 4/4，跨账户泄漏、open outbox、dead/dead-letter、
  quarantine、事务残留和活进程残留均为 0，MCP P95 310.905 ms。证据目录：
  `.memory-bridge-private/system-simulation/lifecycle-20260815135805343-54d28cf3-Y4unu6`。

## 5. 运维边界

- 定期 retention sweep 会自动做在线精炼；用户无需手工触发每条记忆。
- 正常 pending 周期任务和未来 `available_at` 不属于 backlog；只统计已经到期且长期
  无进展的 pending/failed、dead/dead-letter 和未完成 outbox。
- completed/dead 历史记录保留用于追责；合并的是重复可执行工作，不是抹掉失败证据。
- 正式运行库不要在线执行 `VACUUM`。需要立刻缩小文件时，先一致性备份、停止 HTTP、
  Worker 和 MCP 写入，再在维护窗口对副本验证后操作。
