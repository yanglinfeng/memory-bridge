# 备份与恢复手册

忆桥提供两种互补备份：按 principal 的完整 JSON v3 逻辑备份，以及整个 SQLite
实例的一致性物理备份。正式升级前建议两者都做。

## 1. 先选备份类型

| 类型 | 适合场景 | 包含 | 不包含 |
|---|---|---|---|
| JSON v3 | 单账户迁移、日常导出、接口验证 | 该 principal 的记忆和完整生命周期状态 | 其他账户、凭据根、可重建 Dense、JSONL |
| SQLite 一致性备份 | 整机灾难恢复、升级前快照 | 全部账户、凭据哈希、索引、迁移 ledger | 外部 Ollama 模型、代码、独立 JSONL/导出文件 |
| 整个数据目录冷备 | 停服后完整复制 | SQLite/WAL/SHM、迁移备份、logs | 代码和模型 |

任何备份都可能包含私人记忆和原始对话，应加密保存并限制权限。

## 2. JSON v3 导出

### 管理台

“记忆库 → 备份”或“设置 → 导出完整备份”。浏览器下载
`memory-bridge-backup.json`。

### HTTP API

```bash
curl -sS http://127.0.0.1:3789/api/export \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN" \
  -o memory-bridge-backup.json
```

不要把 Token 写进命令行历史。可先用 `read -s` 设置环境变量。

### 备份内容

顶层字段：

```json
{
  "version": 3,
  "schemaVersion": 30,
  "exportedAt": "2026-08-09T00:00:00.000Z",
  "userId": "stable-principal-id",
  "memories": [],
  "relations": [],
  "auditLog": [],
  "idempotencyKeys": [],
  "state": {}
}
```

`state` 包含 sessions、turns、extraction runs、candidates、action requests、
规范 items/versions/evidence/edges/events、outbox、jobs、dead letters、retention、
tombstones、consolidations、purge、namespace quality，以及历史重提炼的 settings、
checkpoint、run、冻结 turn 清单、模型调用账本、claim、事件和 candidate evidence。

它不包含可恢复 Token、其他 principal、账户/凭据根、identity audit、embedding/
Dense 派生索引或 JSONL 文件。

## 3. 导出后快速验证

如果安装了 `jq`：

```bash
jq '{version, schemaVersion, exportedAt, userId, memories: (.memories|length)}' \
  memory-bridge-backup.json
```

至少确认：

- 文件可解析为 JSON。
- `version` 为 3。
- `schemaVersion` 不高于目标代码支持的版本。
- `userId` 是预期账户。
- `exportedAt` 是本次导出时间。
- 文件大小非 0，且保存在非 Git、非公共目录。

不要通过输出 `memories[].content` 来做终端验证，避免私人内容进入终端日志。

## 4. JSON v3 恢复前提

- 目标请求必须使用与 backup `userId` 相同的 principal。
- 目标库应已有可信账户和必要的 complete session 身份锚。
- 备份自报 `schemaVersion` 不能证明 persona/project 绑定可信。
- v25 以前或缺少可信 project 归属的旧备份可能被 fail closed。
- 导入是替换当前 principal 的完整状态，不是增量 merge。
- 导入前先导出目标当前状态，以便回滚。
- 最好在维护窗口停掉 AIRI 和 MCP 写入。

## 5. JSON v3 恢复

### 管理台

1. 使用目标账户 Token 进入管理台。
2. 打开“记忆库”，点击“导入”。
3. 选择 JSON 文件。
4. 阅读“替换当前用户状态”确认框后继续。
5. 等待成功提示并刷新记忆库。

### HTTP API

```bash
curl -sS -X POST http://127.0.0.1:3789/api/import \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @memory-bridge-backup.json
```

成功响应包含 imported、relationCount、auditCount、idempotencyKeyCount 和
`stateRowCount`。

## 6. 恢复事务保证

完整导入会先验证：

- schema/格式和严格字段。
- backup user 与目标 principal。
- identity/session/project 可信绑定。
- 版本、证据、边、任务和 outbox 引用链。
- reflection run-turn、candidate evidence、claim 与 owner/namespace/scope 引用链。
- 目标库不可绕过的 tombstone ledger。

通过后才在 `BEGIN IMMEDIATE` 事务中替换当前 principal 的数据。任何中途错误
都会 rollback。恢复后：

- 非 deleted 当前记忆重建本地 FTS/概念投影。
- Dense 回填任务重新排队。
- 旧备份不能轻易复活目标库已经 tombstone 的内容。
- 其他 principal 不应受到影响。

## 7. SQLite 一致性备份

### 方式 A：安全停服后冷备

1. 停止 AIRI 新对话、全部 MCP 和忆桥 HTTP 进程。
2. 确认没有进程继续写数据目录。
3. 复制整个数据目录到加密备份位置。
4. 保留目录层级和文件时间，不只复制主 `.sqlite3`。
5. 在副本上执行完整性检查。

### 方式 B：SQLite 在线 backup API/CLI

如果系统安装了 SQLite CLI，可以使用其一致性 `.backup` 能力，而不是普通文件
复制：

```bash
sqlite3 /absolute/path/memory-bridge.sqlite3 \
  ".backup '/secure/path/memory-bridge-backup.sqlite3'"
```

在线备份期间仍应控制写入量，并在副本上检查 `PRAGMA integrity_check` 与
`PRAGMA foreign_key_check`。如果不确定 CLI/文件系统行为，选择停服冷备。

## 8. SQLite 灾难恢复

1. 停止所有使用目标数据库的进程。
2. 保全损坏/失败版本的数据库、WAL、SHM 和日志，不要直接覆盖证据。
3. 将备份恢复到新的隔离数据目录。
4. 用当前匹配代码只启动一个服务进程，让 schema 迁移完成。
5. 检查 integrity、foreign key、schema attestation 和业务健康。
6. 用测试账户完成召回、纠正、遗忘、重启闭环。
7. 通过后再切换正式 `MEMORY_BRIDGE_DATA_DIR`。

不要把高 schema 数据库交给旧代码打开；服务会拒绝，但手工绕过可能破坏数据。

## 9. 恢复后验证

### 数据库

- `PRAGMA integrity_check` 返回 `ok`。
- `PRAGMA foreign_key_check` 返回 0 行。
- schema `user_version` 与当前代码兼容。
- v26 identity、schema 31 reflection/session-ingest 与 schema 37 分层来源 attestation 通过。

### 服务

- `/api/system-health` 无未解决 dead letter。
- Dense eligible/indexed 最终相等、lag 0。
- outbox 不长期 pending/running/failed。
- retention/consolidation 每个 scope 只有预期稳定链。
- retrieval log `consecutiveFailures=0`。

### 业务

- 当前账户正向召回成功。
- 另一账户负向召回不能看到目标事实。
- persona/project/session 隔离和 fork 正确。
- 被遗忘记忆在重启后仍不召回。
- 历史版本、evidence、tombstone 和审计可查看。
- reflection 的 reextract/reflect checkpoint、运行事件、模型调用账本和候选证据
  均恢复；两条 pipeline lag 与导出前一致或能从受控重放收敛。

## 10. 备份轮换建议

- 每日：活跃账户 JSON v3。
- 升级前：JSON v3 + SQLite 一致性快照。
- 重大模型/Dense 切换前：SQLite 快照与评测报告。
- 定期：在隔离目录做真实恢复演练，而不是只检查文件存在。
- 到期：同时删除主备、旧诊断导出、截图和临时验收目录。

备份保留周期应短于无限期，并匹配用户删除承诺。

## 11. 常见恢复失败

| 错误 | 原因 | 处理 |
|---|---|---|
| backup user 与当前用户不一致 | 用错 Token/账户 | 切换到同一 principal，不要改 JSON userId |
| v3 缺少 state/schemaVersion | 文件不完整或旧格式伪装 | 重新从源实例导出 |
| project scope 可信验证失败 | 旧数据无可信 session 绑定 | 保留迁移备份，离线人工 quarantine/rebind |
| 引用链错误 | 备份损坏/手工修改 | 使用未修改备份，检查导出源 |
| 恢复后 degraded | Dense 正在回填或模型不可用 | 检查 jobs/Ollama，等待并重新评测 |
| 旧事实没有“复活” | 目标 tombstone 仍有效 | 这是保护行为；仅按明确用户意图恢复 tombstone |

安全和隐私边界见[安全与隐私指南](security-and-privacy.md)。

## 12. schema 31 历史重提炼恢复检查

JSON v3 恢复不是只恢复最终候选。必须保持下列闭包：

```text
reflection settings
  → checkpoint / run
  → immutable run-turn list / model calls / events
  → candidate / candidate evidence
  → claim decision / canonical version / outbox
```

导入前会验证：run-turn 指向同 principal/namespace 的真实 user turn；非 personal
scope 能由可信 session 绑定证明；candidate evidence 的 owner/namespace/scope
与候选和 turn 一致；claim 的 candidate/first run/last run 引用有效；模型预算状态
合法。任一错误会使整个替换事务回滚。

schema 31 的 `memory_turn_ingest_order.session_id` 也必须与 turn 和 session 的
principal/namespace 完全一致；完整恢复会校验该列和 session 增量索引，不能从
备份自报字段猜测归属。

恢复后不要手工把 checkpoint 改到最新 turn。先读取：

```bash
curl -sS "$BASE/api/reflection/status?namespace=personal" \
  -H "Authorization: Bearer $TOKEN"
```

若 lag 非零，先预览落后的具体 pipeline。恢复不会自动启动全库模型回放；只有
已有待执行 job 或人工确认后才运行。这样可避免换机器恢复时突然消耗大量模型
预算。

旧备份中的 reflection 候选不能绕过目标库 tombstone。导入和后续确认都会重新
检查 tombstone/claim decision；被 blocked 的等价推断不得复活。证据 TTL 已擦除
的 excerpt 保持 NULL，不能因为恢复而重新生成正文。

物理清除后的受管备份也会清理关联 reflection 正文与引用。用户自行复制到受管
目录外的 JSON/SQLite 备份仍需按保留策略单独销毁，系统无法远程擦除这些副本。

## 13. schema 37 分层记忆恢复检查

schema 37 完整备份额外携带 `episodes`、`episodeTurns`、`patternObservations`、
`hierarchicalSummaries` 和 `hierarchicalSummarySources`。对 schemaVersion ≥37，五组
字段缺一即在替换目标账户数据前 fail closed；旧版本按空集合兼容迁移。

导入会验证：episode 与唯一 memory、session、user/assistant turn、scope 和内容哈希一致；
episode-turn ordinal 固定为 user=0/assistant=1；observation 的 turn、run 和作用域归属
一致；摘要的每个 episode 来源属于同 owner/namespace/scope。任一哈希、引用或租户边界
不一致都会使整个恢复事务回滚。

恢复提交后会重新排 Dense 派生。先等待到期 `index_memory` 与
`summarize_memory_bucket` 收敛，再确认 Memory Doctor 中
`episode_dense_unindexed=0`、`summary_source_incomplete=0`。不要把短暂 Dense lag 当成
数据丢失，也不要手工补写来源表绕过 attestation。
