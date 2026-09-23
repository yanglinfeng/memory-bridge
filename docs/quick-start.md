# 快速开始

本手册用于在一台已经安装 Node.js 和 Ollama 的电脑上，从空数据启动忆桥，
创建首个本地账户，并完成一次可验证的记忆召回。完整生产设置见
[运行维护手册](operator-guide.md)。

## 1. 前置条件

- Node.js 24 或更高版本；`node --version` 应显示 `v24` 或更新。
- npm。
- Ollama 已安装且可以运行。
- 项目目录：`~/memory-bridge`。

## 2. 安装并准备本机模型

```bash
cd ~/memory-bridge
npm install
npm run build
ollama pull qwen2.5:14b
ollama pull bge-m3:latest
```

另开一个终端启动 Ollama：

```bash
ollama serve
```

如果 Ollama 已经由桌面应用启动，不要再启动第二个占用 11434 端口的进程。

## 3. 以安全模式启动忆桥

```bash
cd ~/memory-bridge
MEMORY_BRIDGE_AUTOMATION_MODE=shadow npm start
```

看到以下文字说明 HTTP 服务已监听：

```text
忆桥 Memory Bridge 已启动：http://127.0.0.1:3789
```

`shadow` 会自动分析对话，但把新事实放入“待确认”，不会直接升级为规范长期
记忆。只有完成质量评测后才建议使用 `auto`。

## 4. 打开管理台并创建账户

浏览器打开 [http://127.0.0.1:3789](http://127.0.0.1:3789)。

首次使用时：

1. 打开“账户”。
2. 输入账户显示名和首枚凭据标签。
3. 点击“创建账户与凭据”。
4. 立即复制只显示一次的 `mb1.…` Token，并保存到密码管理器。

创建首个凭据后，匿名本机访问会关闭。管理台只把 Token 保存在当前页面内存，
刷新或关闭页面后需要重新输入；它不会写入 localStorage。

## 5. 验证空库和服务健康

首次启动应显示“还没有长期记忆”，而不是演示数据。带上刚才的 Token：

```bash
read -s MEMORY_BRIDGE_ACCESS_TOKEN
export MEMORY_BRIDGE_ACCESS_TOKEN
curl -sS http://127.0.0.1:3789/api/health \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
curl -sS http://127.0.0.1:3789/api/system-health \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
```

终端会等待你粘贴 Token；输入内容不会回显，也不会出现在这条命令的 shell
历史中。

`/api/health` 返回 `ok: true` 只代表进程可访问。可靠召回还应检查
`/api/system-health` 的模型、队列、Dense 水位和 `quality`。

## 6. 创建并召回第一条记忆

在“记忆库”点击“新建记忆”，填写：

- 记忆内容：`用户希望项目首次打开时不包含任何演示数据。`
- 类型：`偏好`。
- 命名空间：`personal`。
- 重要度：可保持默认。
- 置信度：可保持默认。

保存后打开“召回测试”，输入：

```text
项目第一次打开时，数据应该是什么状态？
```

正常结果应包含刚创建的记忆、质量状态、分数解释和实际提供给 AIRI 的上下文。
如果零召回，先确认 Ollama 中两个模型都存在，再查看
[召回日志排障](retrieval-logging.md)。

## 7. 接入 AIRI

1. 打开管理台“AIRI 接入”，复制当前机器生成的 MCP 配置。
2. 在 AIRI 的 MCP 设置中添加忆桥 stdio 服务。
3. 将 AIRI 的 OpenAI-compatible Base URL 设置为
   `http://127.0.0.1:3789/ollama-compat/v1`。
4. 模型选择 `qwen2.5:14b`。
5. HTTP 生命周期代理与 MCP 使用同一个账户身份。
6. 按[AIRI 接入与验收](airi-integration.md)完成自然写入、新会话召回、纠正、
   遗忘、fork 和完整重启。

只添加 MCP 不会自动截获每轮对话。AIRI 的确定性回答前召回和回答后沉淀依赖
上述兼容 Base URL。

## 8. 何时切换到 auto

完成 namespace 固定评测并确认候选质量后，停止服务，再用以下方式启动：

```bash
MEMORY_BRIDGE_AUTOMATION_MODE=auto npm start
```

`auto` 仍受置信度、重要度、敏感级别、关系判断、tombstone 和 namespace
质量门禁约束。它不是“模型说什么都自动记住”。

## 9. 下一步

- 学习管理台：[界面使用手册](ui-guide.md)。
- 配置全部模型和阈值：[配置参考](configuration-reference.md)。
- 添加其他 MCP 客户端：[MCP 使用手册](mcp-guide.md)。
- 生产运行、备份和健康检查：[运行维护手册](operator-guide.md)。
