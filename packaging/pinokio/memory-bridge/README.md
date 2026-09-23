# 忆桥 Pinokio 启动器

本目录是忆桥的一键安装入口。发布包必须在同级包含 `bundle/` 源码快照。源码仓库
中的完整中文手册是 `docs/one-click-installation-and-operation.md`；公开发布启动器时
应把该手册作为 Release 文档一并提供。

- 一键安装：构建到 `app/`，数据写入 `state/data/`。
- 安全升级：先构建 staging，备份 SQLite，再原子切换；失败自动恢复旧代码。
- 故障诊断：检查 Node、构建产物、SQLite、固定 Ollama 模型、端口和 MCP stdio，并将回执写入 `state/receipts/`。
- 修复重装与卸载：默认保留 `state/data/`。
- 生成 MCP 配置：先安全停止，再点击“生成 MCP 配置”；结果位于
  `state/receipts/mcp-config.json`，默认绑定 `default` 账户。

首次安装前仍需单独安装 Ollama，并下载 `qwen2.5:14b` 和 `bge-m3:latest`。启动器
使用动态本机端口，始终以菜单里的“打开管理界面”和管理台“AIRI 接入”地址为准，
不要照抄固定 `3789`。AIRI 要实现逐轮自动记忆，除 MCP 外还必须把模型 Base URL
指向管理台给出的 `/ollama-compat/v1`，并把 `mb1.…` Token 填入 API Key。

清除数据没有放进图形菜单，避免误删。如确需清除，必须在终端显式提供双重确认参数；详见项目安装文档。
