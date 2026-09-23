# 忆桥 MCP 使用手册

环境变量和身份注入方式见[配置参考](configuration-reference.md)，AIRI 每轮自动
生命周期见[AIRI 接入](airi-integration.md)，其他文档见[文档中心](README.md)。

## 1. 用途与边界

忆桥通过 MCP stdio 暴露 7 个长期记忆工具。每个 MCP 进程在启动时不可变地
绑定 `principal + namespace + 可见 scopes`，后续工具参数不能扩大这三个边界。
多账户、不同 namespace 或不同聊天身份应使用各自的 MCP 启动项；不要让模型在
工具参数中传 `userId`、`principalId` 或任意 `scopeKey`。

AIRI 的自动记忆生命周期不依赖模型主动调用 MCP；AIRI 还需要使用忆桥的
OpenAI-compatible 代理。MCP 主要用于兼容其他客户端、人工写入和检查。

## 2. 前置条件

- Node.js 24 或更高版本。
- 已执行 `npm install && npm run build`。
- Ollama 正在监听 `http://127.0.0.1:11434`。
- 已安装 `qwen2.5:14b` 与 `bge-m3:latest`。

```bash
ollama serve
ollama pull qwen2.5:14b
ollama pull bge-m3:latest
```

## 3. 启动方式

### 3.1 Pinokio 一键安装用户

先在 Pinokio 中“安全停止”忆桥，再点击“生成 MCP 配置”。可直接复制：

```text
memory-bridge/state/receipts/mcp-config.json
```

生成文件使用安装后 Node、`app/dist/server/mcp-stdio.js` 和 `state/data` 的绝对
路径，权限为 `0600`，并绑定首次账户 `default`。多账户不能共用这份身份配置：
为每个账户签发专用凭据，把 `MEMORY_BRIDGE_USER_ID` 替换为
`MEMORY_BRIDGE_MCP_TOKEN`。完整步骤见
[一键安装与操作手册](one-click-installation-and-operation.md)。

### 3.2 源码运行用户

开发源码模式：

```bash
MEMORY_BRIDGE_USER_ID=default npm run mcp
```

构建产物模式：

```bash
MEMORY_BRIDGE_USER_ID=default npm run mcp:built
```

生产接入优先使用构建产物。若已由身份 API 签发凭据，可用
`MEMORY_BRIDGE_MCP_TOKEN` 代替可信的 `MEMORY_BRIDGE_USER_ID`：

```bash
MEMORY_BRIDGE_MCP_TOKEN='<token>' npm run mcp:built
```

`MEMORY_BRIDGE_MCP_TOKEN` 只用于启动鉴权，解析完成后会从进程环境中删除。
如果两个变量都未设置，MCP 会拒绝启动。

## 4. 客户端配置示例

```json
{
  "mcpServers": {
    "memory-bridge-default": {
      "command": "/usr/local/bin/node",
      "args": [
        "/absolute/path/to/memory-bridge/dist/server/mcp-stdio.js"
      ],
      "env": {
        "MEMORY_BRIDGE_USER_ID": "default",
        "MEMORY_BRIDGE_DATA_DIR": "/absolute/path/to/memory-bridge/data",
        "MEMORY_BRIDGE_NAMESPACE": "personal",
        "MEMORY_BRIDGE_MCP_PERSONA_ID": "airi-assistant",
        "MEMORY_BRIDGE_MCP_PROJECT_ID": "memory-bridge",
        "MEMORY_BRIDGE_MCP_SESSION_ID": "chat-20260831-001",
        "MEMORY_BRIDGE_OLLAMA_URL": "http://127.0.0.1:11434",
        "MEMORY_BRIDGE_EMBED_MODEL": "bge-m3:latest",
        "MEMORY_BRIDGE_RERANK_MODEL": "qwen2.5:14b"
      }
    }
  }
}
```

`command` 和脚本路径必须是绝对路径。客户端进程需要能访问同一个数据目录
和 Ollama。修改 MCP 环境变量后应重启客户端。

不要同时设置不同账户含义的 `MEMORY_BRIDGE_USER_ID` 和
`MEMORY_BRIDGE_MCP_TOKEN`。Token 存在时以 Token 认证出的 principal 为准；为避免
配置审计产生误解，多账户配置应删除 `MEMORY_BRIDGE_USER_ID`。

### 4.1 连接绑定与作用域规则

| 边界 | 可见范围 | 典型用途 |
|---|---|---|
| principal | 只属于一个本地账户 | Alice/Bob 等账户硬隔离 |
| `personal/self` | 同 principal 的所有聊天对象可见 | 长期偏好、个人资料 |
| `role/{persona_id}` | 同 principal、同 persona 可见 | 对特定角色的关系与约定 |
| `project/{project_id}` | 同 principal、同 project 绑定会话可见 | 项目事实与决策 |
| `session/{session_id}` | 仅当前会话可见 | 不应跨聊天传播的临时信息 |

连接总会绑定 `personal/self`。仅当
`MEMORY_BRIDGE_MCP_PERSONA_ID` 与 `MEMORY_BRIDGE_MCP_SESSION_ID` 同时存在且
格式合法时，连接才额外绑定对应的 `role`、`session`，并可选绑定
`MEMORY_BRIDGE_MCP_PROJECT_ID` 对应的 `project`。缺少 persona/session 任一项时，
即使给了 project，也会安全降级为只见 `personal/self`；任一已设置 ID 格式非法则
拒绝启动，不会静默放宽。

若同一客户端需要 Alice 和 Bob、两个 namespace，或两个不同 persona/session，
应分别配置进程。多个进程可以共享 SQLite 数据目录，但每个连接只看得到自己的
绑定范围。同 principal 的两个完整聊天连接共享 personal；同 project 时共享
project；role 和 session 只对匹配的 ID 可见。

工具中的可选 `namespace` 是旧客户端兼容字段，只能省略或等于启动时绑定值。
`memory_remember.scope` 只能选择已绑定的作用域类型，调用方不能提交任意
`scopeKey`。省略 `scope` 时安全默认写入 `personal/self`。

## 5. 七个工具

| 工具 | 用途 | 关键输入 | 核心返回 |
|---|---|---|---|
| `memory_remember` | 保存稳定事实 | `content`、`kind`、可选已绑定 `scope` | `{memory, created, deduplicated}` |
| `memory_recall` | 召回相关记忆 | `query`、可选过滤 | `RecallResult[]` |
| `memory_get_context` | 生成可注入上下文 | `query`、token 预算 | `traceId`、`context`、`grounding` |
| `memory_update` | 修正现有记忆 | `id` 与变更字段 | 新的当前记忆版本 |
| `memory_forget` | 软删除并写 tombstone | `id`、`reason` | 删除后的记忆状态 |
| `memory_list` | 管理式列表查询 | 查询、类型、状态、分页 | `{items, total, limit, offset}` |
| `memory_stats` | 查看账户记忆统计 | 无 | 数量、模型和默认 namespace |

`kind` 可取：`profile`、`preference`、`project`、`event`、
`knowledge`、`relationship`、`instruction`。

### 5.1 memory_remember

```json
{
  "content": "用户偏好深色界面。",
  "kind": "preference",
  "scope": "personal",
  "tags": ["ui"],
  "importance": 0.8,
  "idempotencyKey": "airi-turn-20260808-theme"
}
```

可选字段包括 `title`、`summary`、`confidence`、`source`、
`sourceRef`、`occurredAt`、`validFrom`、`validTo` 和
`supersedesId`。credential、密码和令牌不能保存为长期记忆。

### 5.2 memory_recall

```json
{
  "query": "界面应该使用什么主题？",
  "namespace": "personal",
  "limit": 5,
  "minScore": 0.12
}
```

文本 `content` 为兼容旧客户端始终保持结果数组；非空结果中的每项包含 `memory`、
`score`、`reasons`、`explanation` 和 `traceId`。无论结果是否为空，MCP 顶层
`_meta` 与 `structuredContent` 都返回同一组诊断字段：

```json
{
  "retrievalTraceId": "4ba5...",
  "qualityState": "full",
  "errorCode": null
}
```

所以零结果文本仍是 `[]`，新客户端可以直接取得 trace；旧客户端无需修改。

schema 37 会在同一次 `memory_recall` 中融合三类结果。根据每项
`memory.source` 区分：普通来源是 fact，`conversation_episode` 是以前聊过的完整
情景，`hierarchical_summary`/`consolidation` 是有来源的派生摘要。episode 中出现的
“助手回应”不等于用户确认；模型或客户端不得把它改写成稳定用户偏好。

召回会查询当前连接绑定 scopes 的并集。调用方不能提交 `scopeKey`，也不能借
`namespace` 兼容字段切换连接边界；需要另一 persona、session、project 或 namespace
时必须启动另一条绑定正确的 MCP 连接。

### 5.3 memory_get_context

```json
{
  "query": "用户喜欢什么主题？",
  "limit": 5,
  "contextTokenBudget": 1200,
  "recentTurns": [
    {"role":"user","content":"我妹妹小林最喜欢桂花乌龙。"},
    {"role":"assistant","content":"我记下了。"}
  ]
}
```

`memory_recall` 和 `memory_get_context` 都支持最多 12 条 `recentTurns`，只用于
本次代词、省略和承接语义的消歧。它们被标记为 `request_untrusted`，不能提供或
覆盖 principal、persona、project、session 和 scope。AIRI 生命周期代理优先使用
同一可信 session 的服务端账本；普通 MCP 客户端没有可信账本时才依赖该字段。

无法唯一消解时服务返回安全澄清语义，不会选择无关长期记忆补位。调用方应把
澄清问题问给用户，而不是再次提交模型猜出的 `resolvedReferences`。

响应示意：

```json
{
  "traceId": "4ba5...",
  "query": "用户喜欢什么主题？",
  "memories": [],
  "context": "本轮没有找到足够相关的长期记忆；这不代表用户从未表达过相关信息。",
  "qualityState": "full",
  "grounding": []
}
```

`qualityState` 为 `full`、`degraded` 或 `unavailable`。非空
`grounding` 会列出 `memoryId`、当前 `versionId`、`proofCount`、第一/最后证据时间、
最多两段非敏感用户原文，以及 evidence 的 `evidenceType/turnId/sourceRef`。这些摘要
只属于召回时的当前版本，不会混入旧版本证据。

生成的 `context` 会分为“已验证事实”“过往对话情景”“派生摘要”，并为后两类附带
谨慎说明。调用方应原样保留这些边界，不要为了缩短 Prompt 去掉来源层标签。

### 5.4 memory_update 与 memory_forget

更新正文时提交修正后的完整事实，不要只写“改成新的”。更新会保留稳定
memory UUID，并追加不可变版本。遗忘是可恢复软删除，同时写入 tombstone，
防止后台摘要或旧证据把已遗忘事实重新带回。

更新始终保留原 namespace 和 scope，不能借修改把记忆移动到另一角色或会话。
`memory_update`、`memory_forget` 遇到连接范围外 UUID 时与不存在 UUID 使用同一错误，
避免泄漏其他 scope 中是否存在该记录。

### 5.5 memory_list 与 memory_stats

`memory_list` 支持 `query`、兼容用 `namespace`、`kind`、`status`、`tag`、
`limit`、`offset`。list 与 stats 都只合并当前连接绑定的 scopes，不会泄漏同
principal 的其他 persona、session、project 或 namespace。

## 6. 幂等与错误处理

- `memory_remember.idempotencyKey` 用于业务级写入幂等。
- AIRI 兼容代理内部使用 `_airiRequestKey` 合并同一次工具调用；普通客户端
  不应自行构造此字段。
- 同一个内部请求键若对应不同参数会被拒绝。
- 语义服务不可用时可靠召回不会静默退回不可靠结果；
  `memory_get_context` 返回 `qualityState=unavailable` 和明确提示。
- 工具输出是 JSON 文本内容。客户端应先解析 MCP content 中的 `text`。

## 7. 验证

```bash
npm run build:server
node --test --import tsx tests/mcp-stdio.test.ts
npm run evaluate:retrieval-p1
```

上线前还应使用两个真实凭据以及同账户两个 persona/session 启动多个 MCP 进程，
验证重启后绑定不变、跨 principal/namespace/role/session 的 UUID 均不可读写，
personal 仍能按预期共享。只看到七个工具并不代表 AIRI 自动记忆已启用；自动
召回/沉淀必须另行验证兼容代理 Base URL。

若启动失败，依次检查 principal 环境变量、构建产物路径、数据目录权限、
Ollama 端口和模型名称。检索不满意时按
[retrieval-logging.md](retrieval-logging.md) 使用 `traceId` 排查。

## 8. 历史重提炼与独立运行边界

忆桥可以作为独立 MCP stdio 服务运行，七个工具不依赖管理台页面。但历史
重提炼是受治理的后台能力，不开放为可由聊天模型任意触发的第八个 MCP 工具，
原因是它需要可信 scope、只读预览、二次确认、预算、取消和审计事件链。

操作历史重提炼有两种方式：

- 启动 HTTP 服务后使用管理台“历史重提炼”页面。
- 使用 `/api/reflection/*` 管理 API，见
  [HTTP API 第 14 节](api-reference.md#14-上下文理解与历史重提炼接口)。

MCP 和 HTTP 若共享同一 SQLite 数据目录，必须保持同一身份合同：MCP 用
`MEMORY_BRIDGE_MCP_TOKEN` 或受信 `MEMORY_BRIDGE_USER_ID` 固定账户，并用启动环境
固定 namespace/persona/project/session。Conversation API 从 Bearer principal 和服务端
会话记录派生 namespace/persona/project/session；OpenAI-compatible AIRI 路径才使用
受保护身份头。不要启动多个可写进程绕过 SQLite 单写者和 Worker 租约；
生产建议由一个 HTTP 主进程负责后台 sweep，MCP 进程只提供工具接口。

`reextract` 可补回逐字支持的遗漏事实；`reflect` 只产生
`assistant_inference/pending` 候选。用户不需要在聊天中说“请长期记住”才会被
历史扫描发现，但任何跨多轮推断都必须在管理台人工确认，不能由 MCP 模型自动
接受。
