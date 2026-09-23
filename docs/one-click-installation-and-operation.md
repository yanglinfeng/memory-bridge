# 忆桥一键安装与操作手册

本文是普通用户从零开始使用忆桥的主手册，覆盖 Pinokio 安装、首次启动、
AIRI/MCP 接入、验证、升级、备份、恢复、诊断和卸载。

## 1. 当前交付状态

忆桥已经具备可独立运行的 Pinokio 启动器，菜单提供：

- 一键安装、启动和安全停止；
- 安全升级和保留数据修复重装；
- SQLite 一致性备份和带校验恢复；
- MCP 配置生成；
- 故障诊断；
- 保留数据卸载。

一键安装会安装忆桥代码、npm 依赖并构建管理台和服务端，但不会替你安装
Ollama，也不会自动下载大模型。当前仓库已经有可用的本地启动器；在发布到
GitHub Release 或 Pinokio 目录之前，它还不是一个公网下载链接。

## 2. 安装前准备

### 2.1 安装 Pinokio 和 Ollama

1. 安装 Pinokio Desktop。
2. 安装 Ollama Desktop，确认 Ollama 正在运行。
3. 在终端准备两个默认模型：

```bash
ollama pull qwen2.5:14b
ollama pull bge-m3:latest
```

`qwen2.5:14b` 负责聊天、提取、关系判断、查询理解和重排；`bge-m3:latest`
负责 embedding。开发阶段可以继续使用这两个本机模型，后续再按
[配置参考](configuration-reference.md)分别替换。

### 2.2 把本地启动器加入 Pinokio

当前启动器目录是：

```text
~/memory-bridge/packaging/pinokio/memory-bridge
```

在 Pinokio 中使用“导入本地项目/打开本地启动器”选择这个目录。若当前 Pinokio
版本只显示应用仓库目录，则在 Pinokio 设置中打开它的应用目录，把整个
`memory-bridge` 文件夹放进去后返回首页刷新。必须选择包含 `pinokio.js`、
`install.js` 和 `bundle/` 的这一层，不能只选择 `bundle/`。

将来从 GitHub 发布时，用户应导入发布仓库 URL；安装后的操作步骤完全相同。

## 3. 一键安装和首次启动

1. 在 Pinokio 首页打开“忆桥 Memory Bridge”。
2. 点击“一键安装”。等待安装、依赖恢复和构建全部完成。
3. 返回应用菜单，点击“启动”。
4. 服务就绪后点击“打开管理界面”。

Pinokio 每次启动会选择一个可用的本机端口，因此不要把 `3789` 当成固定地址。
以菜单显示的“打开管理界面”URL为准。

首次启动应看到空记忆库，不会自动导入演示数据。安装内容与用户数据分开：

```text
memory-bridge/app/             已安装程序
memory-bridge/state/data/      SQLite 用户数据
memory-bridge/state/backups/   备份
memory-bridge/state/receipts/  诊断、安装和 MCP 配置回执
```

## 4. 创建第一个账户

1. 在管理台打开“账户”。
2. 输入显示名和首枚凭据标签，例如 `AIRI desktop`。
3. 点击“创建账户与凭据”。
4. 立即复制只显示一次的 `mb1.…` Token，保存到密码管理器。

首个账户的稳定 principal 是 `default`。创建凭据后，管理台刷新时需要重新输入
Token；AIRI 的兼容模型接口也要把同一枚 Token 作为 API Key/Bearer credential。
不要把 Token 贴进聊天、提交到 Git 或写入公开文档。

## 5. 先验证忆桥本身

在管理台“记忆库”手工新建：

```text
我做新软件时，第一次打开必须是空数据。
```

类型选“偏好”，命名空间选 `personal`。然后在“召回测试”输入：

```text
我对新软件第一次打开的数据有什么要求？
```

结果应命中刚才的记忆，并带有 traceId 和质量状态。如果失败：

1. 确认 Ollama 正在运行；
2. 确认两个模型已经下载；
3. 返回 Pinokio 执行“故障诊断”；
4. 按[召回日志排障](retrieval-logging.md)用 traceId 定位。

## 6. 生成 MCP 配置

Pinokio 只在忆桥停止时显示“生成 MCP 配置”：

1. 点击“安全停止”。
2. 点击“生成 MCP 配置”。
3. 打开以下文件并复制完整 JSON：

```text
memory-bridge/state/receipts/mcp-config.json
```

文件权限为 `0600`，其中包含当前 Pinokio Node、MCP 脚本和数据目录的绝对路径。
默认生成的配置绑定 `default` principal，与首次账户和管理台使用同一批记忆。

对于第二个及更多账户，不要继续使用默认配置。为目标账户签发专用 Token，并在
该账户的 MCP 配置中删除：

```json
"MEMORY_BRIDGE_USER_ID": "default"
```

改为：

```json
"MEMORY_BRIDGE_MCP_TOKEN": "mb1.该账户的专用令牌"
```

一个 MCP 进程只绑定一个账户，模型工具参数不能切换账户。

## 7. 接入 AIRI 0.11.x

AIRI 需要同时完成“MCP 工具”和“兼容模型代理”两项配置。只加 MCP 能手工调用
记忆工具，但不能保证每轮聊天自动召回和沉淀。

### 7.1 添加 MCP

1. 打开 AIRI“设置 → 机体模块 → MCP”。
2. 添加本地 MCP Server，粘贴上一步生成的 JSON。
3. 运行连接测试，确认出现七个 `memory_*` 工具。
4. 应用配置并重启 AIRI。

### 7.2 配置自动记忆代理

忆桥启动后，打开管理台“AIRI 接入”，复制页面实际显示的：

- 模型名：默认 `qwen2.5:14b`；
- OpenAI-compatible Base URL：动态端口下的
  `http://127.0.0.1:<实际端口>/ollama-compat/v1`；
- 创建账户时保存的当前账户 Token：填入 AIRI 的 API Key 字段。

在 AIRI 新增或修改 OpenAI-compatible/Ollama-compatible 模型提供方，填入上述
三项。不要把 Base URL 直接指向 `http://127.0.0.1:11434`，否则聊天能运行，
但会绕过忆桥的回答前召回和回答后沉淀。

### 7.3 验证自动记忆

1. 在普通聊天中自然说出一条稳定偏好，不要说“请记住”。
2. 等待后台任务完成；默认 `shadow` 模式会先进入“待确认”。
3. 在管理台确认候选，或在完成自己的质量评估后切换到 `auto`。
4. 新建一个空会话，用不同说法询问该偏好。
5. 再测试自然纠正、遗忘以及 AIRI/忆桥/Ollama 全部重启后的结果。

Pinokio 启动器默认保持安全的 `shadow` 模式，避免尚未评估的模型直接污染长期
记忆。`shadow` 不是失效：它会自动提取，但需要人工确认；生产切换 `auto` 前应先
完成 namespace 质量评测。详细验收见[AIRI 接入文档](airi-integration.md)。

## 8. 接入其他 MCP 客户端

支持 MCP stdio 的客户端通常都可以使用 `mcp-config.json`。核心要求是：

- `command` 和 `args` 必须是绝对路径；
- 客户端能访问 `state/data` 和本机 Ollama；
- 每个进程用 `MEMORY_BRIDGE_USER_ID` 或 `MEMORY_BRIDGE_MCP_TOKEN` 固定账户；
- 修改配置后必须彻底重启客户端；
- 客户端应解析工具 `content[].text` 中的 JSON，并读取 `_meta` 里的 trace 与质量状态。

七个工具的参数和返回值见[MCP 使用手册](mcp-guide.md)。AIRI 之外的客户端若只
接入 MCP，是否会自动调用记忆工具取决于该客户端的 agent 策略；忆桥不会自动截获
它没有经过兼容代理或 Conversation API 的普通聊天。

## 9. 日常菜单怎么用

| 菜单 | 什么时候使用 | 结果 |
|---|---|---|
| 启动 | 日常开始使用 | 启动 HTTP、管理台和后台 Worker |
| 打开管理界面 | 服务运行后 | 打开本次动态端口 |
| 运行日志 | 服务运行中 | 查看当前服务 stdout/stderr |
| 安全停止 | 升级、恢复、重装或卸载前 | 验证目标进程并留下 Stop 回执 |
| 备份记忆库 | 运行中或停止后 | 在 `state/backups` 生成 SQLite 备份和 SHA-256 manifest |
| 从备份恢复 | 服务停止后 | 校验备份，先保存恢复前快照，再切换数据库 |
| 安全升级 | 服务停止后 | staging 构建、升级前备份、原子切换，失败自动保留旧版本 |
| 故障诊断 | 至少成功启动过一次后 | 检查构建、schema、SQLite、模型、端口和七个 MCP 工具 |
| 保留数据修复重装 | 程序损坏但数据要保留 | 重装 `app`，不删除 `state/data` |
| 卸载程序（保留数据） | 暂时不用或准备重装 | 删除程序，保留数据库与备份 |

安全升级要求启动器来自有可信 Git origin 的发布仓库；当前纯本地副本没有可信
更新源时会拒绝伪升级，不会修改现有程序或数据。

## 10. 备份、恢复和卸载

### 10.1 备份

点击“备份记忆库”。成功通知只代表一致性备份和 manifest 已写入；重要升级前还应
把 `state/backups` 复制到另一块磁盘。

### 10.2 恢复

1. 安全停止忆桥。
2. 点击“从备份恢复”。
3. 选择备份文件。
4. 恢复器校验格式、schema、完整性和 SHA-256 后再切换。
5. 启动忆桥，检查系统健康并抽样召回。

恢复前数据库会再保存一份快照，避免选错备份后无路可退。

### 10.3 卸载

1. 安全停止忆桥。
2. 点击“卸载程序（保留数据）”。
3. `app/` 被移除，`state/data/`、`state/backups/` 和回执保留。

图形菜单故意不提供“连数据一起删除”，避免误操作。真正物理清除必须走带双重
确认的生命周期 CLI；执行前先阅读[运行维护手册](operator-guide.md)，并单独备份。

## 11. 故障诊断

点击“故障诊断”后，完整 JSON 回执和 SHA-256 会写入：

```text
memory-bridge/state/receipts/
```

重点检查：

- `ok` 是否为 `true`；
- 数据库 schema 是否为 39，`integrity_check` 是否为 `ok`；
- Ollama 和固定模型是否可用；
- MCP smoke 是否实际调用全部七个工具；
- 是否存在 unhealthy/dead job 或索引水位落后。

诊断回执默认不包含记忆正文，但分享前仍应检查路径、账户 ID 和运行环境信息。
不要公开发送 Token、数据库、原始聊天或备份。

## 12. 当前边界

- Pinokio 生命周期和 MCP 工具已有自动化验收；公网发布仓库/签名安装包仍需在
  正式开源发布时建立。
- 当前 AIRI 0.11.x 走兼容 Base URL；服务端 Conversation API 已有，但 AIRI 客户端
  尚未完成单一权威切换。
- 当前没有在真实客户端上重跑完整 UI 全闭环，因此发布前仍要按
  [AIRI 接入与验收](airi-integration.md)在目标客户端版本上跑一次真机验收。
- 本地 14B 模型适合低成本开发，但质量和速度仍取决于硬件、模型和数据规模。
