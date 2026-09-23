# 故障排查手册

本手册按“症状 → 证据 → 处理 → 验证”组织。不要先删除数据库、清空队列或放宽
相关性阈值；先保留现场并确定故障层。

## 1. 五分钟分层诊断

1. HTTP 是否可达。
2. 当前 Token 是否有效、是否为预期 principal。
3. Ollama 是否运行且模型标签存在。
4. `/api/system-health` 的 quality、Dense 水位、队列和 dead letter。
5. `/api/retrieval-log/health` 是否连续失败。
6. 用一条已知记忆执行“召回测试”并保存 traceId。

```bash
curl -sS http://127.0.0.1:3789/api/health \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
curl -sS http://127.0.0.1:3789/api/identity \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
curl -sS http://127.0.0.1:3789/api/system-health \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
curl -sS http://127.0.0.1:3789/api/retrieval-log/health \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
curl -sS http://127.0.0.1:11434/api/tags
```

## 2. 服务无法启动

| 现象 | 证据 | 处理 |
|---|---|---|
| `EADDRINUSE` | 3789 已被占用 | 找到现有忆桥进程，避免启动第二实例；或改端口 |
| Node 版本错误 | `node --version` < 24 | 切换 Node 24+ 后重新安装/构建 |
| 找不到 dist | `npm start` 报模块不存在 | 先 `npm run build` |
| 数据目录不可写 | 启动错误含 EACCES | 修正目录所有者/权限，不要用 root 绕过 |
| schema 高于支持版本 | 明确拒绝打开 | 使用匹配的新代码；不要改 user_version |
| v26 migration blocked | legacy project 归属不明 | 使用迁移备份，离线人工 quarantine/rebind |

启动失败时保留完整错误、数据库/WAL 和自动迁移备份；不要反复用不同版本打开。

## 3. 管理台打不开或空白

### 3789 完全不可达

- 确认 `npm start` 正在运行。
- 确认访问的是当前 `MEMORY_BRIDGE_PORT`。
- 检查进程 stderr。

### 开发模式 5173 可见但 API 失败

- 确认 `npm run dev` 同时启动了 3789 API 和 Vite。
- 查看浏览器网络面板中的 401/404/500。
- 不要把 5173 当成生产地址。

### 构建后页面 404

- 重新 `npm run build`，确认 `dist/web/index.html` 存在。
- 确认从项目根启动，静态文件路径与构建一致。

## 4. 反复要求 Token

刷新页面后要求 Token 是设计行为：管理台只把 Token 保存在内存，不持久化。

如果刚输入就 401：

- 确认没有多余空格或使用 secret hint 代替完整 Token。
- 在“账户”或 CLI 检查凭据是否 revoked/expired。
- 确认 Token 属于当前数据目录，而不是另一个测试库。
- 确认服务没有在初始化后关闭 legacy Token 路径。

丢失 Token：

```bash
npm run identity -- list-principals
npm run identity -- issue-token \
  --principal ACCOUNT_ID \
  --label "管理台恢复"
```

第二条命令会在终端显示一次完整 Token，避免录屏和日志采集。

## 5. Ollama 或模型不可用

| 现象 | 检查 | 处理 |
|---|---|---|
| `fetch failed` | 11434 `/api/tags` | 启动 `ollama serve` |
| model not found | 模型标签 | `ollama pull qwen2.5:14b` / `bge-m3:latest` |
| 超时 | CPU/GPU、模型大小、timeout | 降低并发或提高合理 timeout，不直接关语义门禁 |
| 维度/指纹不匹配 | Dense generation 状态 | 注册新 generation 并回填评测 |
| AIRI 模型被拒绝 | 兼容代理错误 | AIRI 模型必须为当前固定 `qwen2.5:14b` |

开发阶段可以用 qwen2.5:14b 控制成本；换生产模型后必须重跑评测。

## 6. 召回零结果

先区分：

- `full + 0`：可靠链正常，但没有候选通过最终门槛。
- `degraded`：部分质量条件未满足。
- `unavailable`：语义链不可用，系统拒绝注入不可靠结果。

按 trace 检查：

1. request 的 namespace/scopes 是否正确。
2. rewrite 是否生成合理变体。
3. channels 是否有 FTS/ANN/term/graph 候选。
4. fusion 是否把目标带入语义阶段。
5. semantic 是否低于相似阈值。
6. rerank 是否因主体、persona、project 或问题无关而拒绝。
7. selection 是否被 scope precedence、冲突或多样性抑制。
8. context 是否因 token budget 截断。

不要因为一次零结果就全局降低重排门槛。先把该 query 加入固定难例。

## 7. 错误召回或串数据疑虑

### 错误但同账户

- 提交带 traceId 的 `rejected` 反馈。
- 检查候选主体、谓词、时间和 scope。
- 查看五路关系决策及 rerank rationale。

### 疑似跨账户/persona/project

这是高优先级安全事件：

1. 立即停写并保全数据库、WAL、日志和 trace。
2. 核对 Token 对应 principal。
3. 核对 persona/session/project 稳定 ID，而不是显示名。
4. 检查 session 绑定不可变和 schema 28 persona principal 唯一性。
5. 用 Alice/Bob 各自 Token 重放正向/负向测试。
6. 未确认根因前不要恢复 auto。

## 8. Dense lag 大于 0

检查：

- eligible 与 indexed 差值。
- active/building generation、模型、维度和 fingerprint。
- `backfill_dense_index` / `evaluate_dense_index` job 状态。
- Ollama embedding 是否可用。
- dead letter 最后错误。

恢复依赖后等待 Worker 回填。只有固定评测通过才能切 active alias。不要直接把
lag 字段改成 0 或删除未索引记忆。

## 9. 任务长期 pending/running/retrying

- future `retention_sweep` / `consolidation_sweep` pending 是正常。
- 普通任务 nextRunAt 已过仍 pending：检查 Worker 是否启动。
- running 超出租约：确认旧进程是否崩溃，等待 lease 回收。
- retrying：修复模型/数据错误，观察 attempt 和 nextRunAt。
- dead letter：先读原错误，再使用恢复接口生成 recovery job。
- 重复周期链：检查启动收敛和 scope，不要手工删除唯一有效链。

## 10. 候选一直不自动提交

- `MEMORY_BRIDGE_AUTOMATION_MODE` 可能为 `shadow`。
- namespace 没有有效 auto 质量快照。
- confidence/importance 低于自动提交阈值。
- 内容被判定 sensitive/credential。
- 关系冲突、目标歧义或 tombstone 阻断。
- 提取/关系 job 正在 retrying。

先在“待确认”核对候选原因。不要直接把所有门槛改为 0。

## 11. 自然纠正/遗忘没有生效

- 确认 AIRI 请求经过兼容 Base URL，而不是只配置 MCP。
- 查看 `memory_action_requests` 是否进入待确认。
- 纠正是否选中正确 memory，是否追加版本而不是新 UUID。
- 遗忘是否目标模糊，需要人工选择。
- 查看 tombstone 和 purge job 状态。
- 完整重启后做负向召回，确认不是旧 AIRI 上下文在回答。

## 12. JSONL 不增长

- `MEMORY_BRIDGE_RETRIEVAL_JSONL` 是否为 `off`。
- 查看 `/api/retrieval-log/health` 的路径、lastError 和连续失败。
- 检查目录存在、权限、磁盘空间和文件轮换。
- 确认真的执行了可靠召回，而不是只打开管理台列表。
- metadata 模式仍会写 trace，只是不含原 query。

日志故障不应阻断召回，但连续失败需要修复。详见[日志查看](logging-guide.md)。

## 13. 备份导入失败

| 错误 | 处理 |
|---|---|
| userId 不一致 | 用同 principal Token；不要手改 backup userId |
| 不是有效 JSON/v3 缺状态 | 重新导出完整备份 |
| identity/project attestation 失败 | 使用目标可信锚，离线处理旧绑定 |
| 引用链不完整 | 备份损坏；恢复未修改版本 |
| 导入后 degraded | 等待 Dense 回填和评测 |

完整恢复是替换当前 principal，不是追加。操作前先备份目标现状。

## 14. Memory Doctor 报警

- critical：阻塞发布，保全证据并定位数据链。
- warning：检查样本和 recommendation，再决定修复。
- info zero-result hotspot：可能来自负例/隔离测试，不自动判故障。
- Doctor 永远只读；如果输出声称执行了 destructive action，应停止并调查。

## 15. 什么时候可以重启

可以在以下情况下安全重启：

- 没有正在进行的手工导入/迁移。
- 已让进程通过 SIGTERM/SIGINT 关闭。
- SQLite 无 integrity/FK 问题。
- 数据目录和代码版本匹配。

重启后租约任务会重放。重启不能修复模型缺失、schema 伪造或数据串租户。

## 16. 提交问题前的最小信息

- 可复现步骤、期望与实际。
- Node、AIRI、Ollama 和模型标签。
- schema 版本。
- quality、Dense lag、未解决 dead letter、retrying、日志健康计数。
- 单个脱敏 traceId/导出。
- 相关 memoryId/jobId。

不要发送 Token、完整数据库、原始备份或未脱敏私人对话。
