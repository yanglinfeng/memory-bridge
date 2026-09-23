# 部署、升级与回滚

忆桥当前是单机、本地优先服务。本文覆盖开发运行、构建后运行、目录规划、schema
迁移、升级门禁和回滚。日常检查见[运行维护手册](operator-guide.md)。

## 1. 支持的部署形态

| 形态 | 用途 | 命令 |
|---|---|---|
| 开发模式 | 修改前后端、热更新 | `npm run dev` |
| 构建后本机服务 | 正式个人使用 | `npm run build && npm start` |
| MCP 源码模式 | 开发 MCP | `npm run mcp` |
| MCP 构建模式 | AIRI/其他客户端稳定使用 | `npm run mcp:built` |
| 隔离验收环境 | 真实 AIRI 测试，不污染正式库 | `npm run prepare:airi-acceptance` |

不支持把 HTTP 直接监听到局域网或公网；host 只接受 `127.0.0.1`/`::1`。

## 2. 目录规划

建议把代码、正式数据和验收数据分开：

```text
/path/to/memory-bridge/       # 代码和 dist
/path/to/memory-data/         # 正式 SQLite 与 logs
/path/to/memory-backups/      # 加密备份，不在代码仓库
/private/audit/airi-acceptance/ # 持久、私有、不可提交 Git 的隔离验收 root
```

正式数据目录应使用绝对路径，并由当前系统用户独占读写。不要把 `data/`、备份或
日志纳入 Git。

正式验收设置绝对父目录后再准备环境：

```bash
export MEMORY_BRIDGE_ACCEPTANCE_PARENT_DIR="/private/audit/airi-acceptance"
npm run prepare:airi-acceptance
```

准备脚本为每次运行创建唯一 mode 0700 root。默认系统临时目录只适合一次性开发
验收；长期审计应保留脱敏 0600 回执与规范 compat 快照，不归档 secrets、原始
stdout 或私人聊天正文。

## 3. 首次构建

```bash
cd ~/memory-bridge
npm install
npm run typecheck
npm run build
ollama pull qwen2.5:14b
ollama pull bge-m3:latest
```

构建产物：

- `dist/server/`：编译后的服务端和 MCP。
- `dist/web/`：Vite 管理台静态文件。

`npm start` 直接运行 `dist/server/index.js`，因此修改源码后必须重新构建。

## 4. 正式启动

```bash
MEMORY_BRIDGE_DATA_DIR="/absolute/path/to/memory-data" \
MEMORY_BRIDGE_AUTOMATION_MODE=shadow \
npm start
```

首次部署先用 `shadow`。完成 namespace 质量评测后再切 `auto`。进程收到
SIGINT/SIGTERM 时会停止 Worker、关闭 HTTP 和 SQLite；正常升级应给它安全关闭
时间，不要直接强杀。

MCP 是独立进程，必须指向同一数据目录并固定相同 principal：

```bash
MEMORY_BRIDGE_DATA_DIR="/absolute/path/to/memory-data" \
MEMORY_BRIDGE_MCP_TOKEN='mb1.…' \
npm run mcp:built
```

实际部署不要把真实 Token 保存在示例文件或 shell 历史中；使用客户端的安全
环境注入机制。

## 5. 启动后检查

带当前账户 Token 调用：

```bash
curl -sS http://127.0.0.1:3789/api/health \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
curl -sS http://127.0.0.1:3789/api/system-health \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
curl -sS http://127.0.0.1:3789/api/retrieval-log/health \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
```

至少确认：

- `quality=full`（有合格 Dense generation 时）。
- Dense `eligible=indexed`、lag 0。
- 未解决 dead letter 0。
- retrying/stale/quarantined 0。
- outbox 无长期 pending/running/failed。
- retrieval log `consecutiveFailures=0`。
- reflection 两条 pipeline 的 lag、failed/dead、预算和 checkpoint 可解释。

未来时间的周期任务 pending 是正常状态。

## 6. schema 迁移

当前 schema 为 37。启动时 `openDatabase` 按顺序迁移旧版本：

- 使用事务保证要么全部提交、要么回滚。
- 需要时在数据库同目录创建带 schema 和时间戳的迁移前备份。
- v26 验证 project/identity 列、索引、触发器和 ledger。
- v27 增加检索可观测性。
- v28 把 persona binding 唯一性收紧到 principal。
- v29 建立历史重提炼过渡骨架。
- v30 增加双 pipeline checkpoint、单调 ingest、冻结 run-turn、模型调用预算、
  claim/event 和 owner/scope attestation。
- v31 把可信 session 归属固化到 ingest ledger，增加 session 增量索引，并在迁移、
  reopen 和完整恢复时校验 candidate evidence 的真实 scope 归属。
- v32–v36 引入 Conversation 权威会话、消息、round/SSE、删除、导入和维护 attestation。
- v37 增加 L1 episode、episode-turn 来源、L2 pattern observation、L4
  session/day/week 摘要及其 episode 来源。
- 高于当前版本的数据库会拒绝由旧代码打开。

迁移前发现任何无法证明归属的 legacy project scope 会 fail closed，并保留备份
等待离线人工 quarantine/rebind；不能通过改 `PRAGMA user_version` 跳过。

## 7. 标准升级流程

1. 记录当前代码版本、Node、Ollama 模型标签、schema、数据目录和健康快照。
2. 停止 AIRI 新对话、MCP 写入和忆桥 HTTP 进程。
3. 导出当前 principal JSON v3 备份，并制作一致性 SQLite 备份。
4. 在备份副本上运行新代码迁移和测试。
5. 更新依赖并执行 `npm run typecheck && npm test && npm run build`。
6. 用正式数据目录启动单个新版本写进程，让迁移完成。
7. 检查 schema attestation、SQLite integrity、FK、队列、Dense 水位和日志健康。
8. 执行自然写入、新会话召回、纠正、遗忘和重启 smoke。
9. 再恢复 AIRI 和 MCP 正常使用。

如果升级改变 AIRI 主版本、身份头、模型、embedding generation 或 schema，必须
执行[测试与发布](testing-and-release.md)中对应的完整重验，而不只是 smoke。

## 8. 回滚原则

### 代码回滚但 schema 未变化

停止进程，恢复旧代码/构建，使用同一数据库前先确认旧代码支持当前
`user_version`。

### schema 已升级

不要让旧代码打开更高 schema。安全回滚是：

1. 停止所有写进程。
2. 保存失败升级后的数据库和日志用于分析。
3. 恢复升级前一致性 SQLite 备份。
4. 恢复对应旧代码、依赖和模型标签。
5. 在隔离目录验证后再切回正式数据目录。

### 仅 embedding/重排质量回归

Dense generation 使用 active/building/previous alias，可执行受控 alias rollback，
不需要覆盖整个 SQLite。使用项目提供的 Dense switch/rollback 验证脚本。

## 9. 数据恢复后的启动

JSON 完整恢复会重排 Dense 回填任务。恢复后短时间 `degraded` 可能是预期状态；
必须等 eligible/indexed 水位一致并完成固定评测，才能重新判定 `full`。详细见
[备份与恢复](backup-and-restore.md)。

## 10. 进程管理建议

无论使用 launchd、systemd 或其他 supervisor，都应满足：

- 工作目录固定为项目根，或显式设置所有路径。
- 使用 Node 24+ 的绝对路径。
- `MEMORY_BRIDGE_DATA_DIR` 使用绝对路径。
- 捕获 stdout/stderr，但不把 Token 加入命令参数或日志。
- 发送 SIGTERM 并允许优雅关闭。
- 限制无限重启；连续启动失败时保留现场并报警。
- HTTP 主进程和多个 MCP 客户端可以共库，但升级时必须全部停写。

当前项目没有交付特定平台的 service unit；不要把示例进程管理配置视为已经
通过目标操作系统验收。

## 11. 发布门禁

### 快速门禁

```bash
npm run typecheck
npm test
npm run build
```

### 检索与可靠性门禁

```bash
npm run benchmark:scale
npm run benchmark:rerank
npm run evaluate:dense
npm run evaluate:retrieval-p1
npm run evaluate:context-reflection -- --validate-fixture
npm run soak:reliability
npm run verify:crash-recovery
npm run qa:natural-conversation-quality
npm run qa:conversation-long-timeline
```

真实 AIRI 桌面闭环不能由这些命令替代。发布证据、适用范围和重验触发器见
[schema 37 分层记忆验收报告](acceptance-report-schema37-layered-memory.md)。

## 12. 不建议的做法

- 在服务运行时只复制 `.sqlite3` 主文件，忽略 WAL/SHM。
- 同时启动两个进程执行 schema 迁移。
- 为“修好迁移”手工更改 `user_version`、删除 ledger 或弱化触发器。
- 删除旧 Dense generation 后才测试新 embedding。
- 用正式 AIRI profile 和正式记忆库跑破坏性验收。
- 看到 `/api/health` 200 就恢复全部流量。
- 将 loopback 服务直接端口转发到公网。
