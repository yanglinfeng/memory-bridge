# 一键安装与 MCP 系统验收 PRD

## 1. 目标

把忆桥从“源码可以运行”推进为可重复安装、可安全升级、可保留数据卸载、可自助诊断，
并通过隔离的 MCP stdio 客户端完成多用户、并发、长期运行和多数据量系统验收。

本轮只支持 macOS、本机 Node 24+ 与 Ollama。模型固定为 `legacy local generation model`，embedding
固定为 `bge-m3:latest`。不修改正式 `data/`、正式 3789 服务或现有 AIRI profile。

## 2. 生命周期 P0

### 安装

- 源码、安装代码和用户状态必须分离。
- 安装目标使用 staging；依赖安装、构建和产物检查全部通过后才原子切换。
- 首次安装创建 mode 0700 状态目录和数据目录，记录不含密钥的安装 manifest。
- 不复制 `.git`、`node_modules`、`dist`、正式数据、验收数据或临时报告。

### 升级

- 当前版本在新版本准备完成前保持可用。
- 新版本构建失败不得改写当前安装。
- 切换时保留一个明确的 rollback 代码目录。
- 不用旧代码打开更高 schema；数据迁移仍由应用启动时的 schema ledger 执行。

### 卸载

- 默认只删除安装代码，保留 `state/data`、诊断回执和安装历史。
- 清除数据必须同时提供 `--purge-data` 与固定确认串。
- 拒绝 `/`、用户主目录、源码根和路径关系不安全的目标。

### 故障诊断

输出机器可读 JSON 和人类摘要，至少检查：

- macOS、Node、npm；
- 安装 manifest、构建产物和目录权限；
- Ollama 可达性以及 `legacy local generation model`、`bge-m3:latest`；
- SQLite schema、integrity、foreign key、outbox、retry/dead jobs；
- 3789 端口/服务状态；
- 隔离临时库上的 MCP stdio 握手和工具列表。

Doctor 不输出 Token、原始对话或私有记忆正文。

## 3. Pinokio 一键入口

目标目录固定为 `PINOKIO_HOME/api/memory-bridge`，提供：

- Install
- Start
- Update
- Repair/Reset
- Doctor
- Uninstall（保留数据）

服务只监听 loopback，启动 URL 必须从进程输出的正则捕获结果设置到 `local.url`。

## 4. MCP 系统验收 P0/P1

### 隔离和负例

- 至少 6 个 principal，每个 principal 使用独立 MCP stdio 连接和凭据。
- 正向召回自己的唯一标识；跨 principal、跨 namespace 召回必须为零。
- Token 不进入回执；测试库、日志和回执使用 0700/0600 权限。

### 可靠性

- 幂等重放、并发重复写、更新版本链、软删除/tombstone、重启后持久化。
- 断开 MCP 子进程后重连，数据和隔离不变。
- SQLite integrity/FK、重复稳定键、孤儿 evidence、open outbox、retry/dead job 为门禁。

### 性能与规模

- MCP 业务路径记录 P50/P95/P99、吞吐、错误率和超时。
- MCP 多用户数据集使用真实 `bge-m3:latest` 与 `legacy local generation model`。
- 复用 10 万记忆/100 万 turn 基准验证索引和历史窗口规模，再从 MCP 执行边界召回。
- 短档用于开发；正式档包含 30 分钟稳定性运行。两档都保留数据和回执。

### 记忆整理

- 运行真实模型巩固固定集，检查压缩率、Recall@10 损失、无来源句和内部 ID 泄漏。
- 运行双 pipeline 历史重提炼固定集，检查 checkpoint、预算、scope、tombstone 和
  `assistant_inference` 不自动提交。
- 失败样本只保存脱敏标识、指标、trace/job ID，不保存凭据和私人正文。

## 5. 交付物

- 生命周期 CLI 与自动化测试；
- Pinokio app launcher；
- MCP 系统仿真器与正式 profile；
- 保留的 SQLite、JSONL、manifest、SHA-256 和验收回执；
- 安装、升级、卸载、诊断、测试和故障排查文档。

## 6. 发布门禁

以下任一项失败则不声明可上线：

- 生命周期回滚/数据保留测试失败；
- MCP scope leak 或错误身份绑定大于 0；
- integrity/FK/孤儿/未收敛任务/dead job 大于 0；
- 纠正后旧值仍被可靠召回，或 tombstone 复活；
- 正式模型/embedding 与回执声明不一致；
- 回执缺少实现指纹、数据摘要、持续时间或 SHA-256。
