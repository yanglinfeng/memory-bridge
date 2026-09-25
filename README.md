# Memory Bridge（忆桥）

**Local-first, evidence-backed knowledge & memory layer for MCP.**

**带证据引用与审计的本地优先知识库引擎，同时是不绑定任何客户端的 MCP 记忆中间件。**

[简体中文](README.md) · [English](README.en.md)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A524-green)
![Schema](https://img.shields.io/badge/schema-v44-blue)
![MCP](https://img.shields.io/badge/protocol-MCP-purple)

> **EN** — Memory Bridge answers three questions most RAG / memory stacks skip: *where did this sentence come from*, *is the source still valid*, and *who can see it*. Every answer carries source bindings and a retrieval `traceId`; every change is audited; every namespace is isolated. Data never leaves your machine.

AI 知识库最大的风险不是答不出，是**编造**和**引用已废止的文件**。忆桥给回答配出处、给变更留审计、给部门数据上隔离——数据 100% 留在本机。

## 为什么是忆桥

| 企业落地绕不开的问题 | 忆桥的机制 |
|---|---|
| 这句话的出处是哪份文件的哪一段？ | 非破坏式巩固逐句绑定来源，每次召回带 `traceId`，可回放「查询改写 → 候选 → 融合 → 重排 → 选择 → 注入」全程 |
| 文件改版了，旧答案还会被引用吗？ | 文档级版本链：内容变更自动走 `supersede`，旧版本退出默认检索，历史版本仍可审计回溯 |
| 谁能看见、谁改过？ | 用户 / 命名空间 / 作用域三层隔离 + 可信会话签发与授权矩阵 + 全操作审计日志 |

## 已实现

**检索与问答**

- FTS5 + Dense ANN + 概念倒排 + 严格重排的全库混合检索，不按「最近 N 条」预截断
- Cross-encoder 重排：`bge-reranker-v2-m3` Python sidecar，按语料域（policy / open）分档相关性门槛
- 相关性不足时按粗排分填充（filler），保留多跳证据链
- 弃答策略：语料里没有就明确说没有，不硬编
- 答案工具：`calculator` / `date_diff` / `date_shift`——算术与日期交给代码算，不让模型口算
- bi-temporal 召回：检索窗口同时受 `valid_from` / `valid_to` 约束

**接入面**

- **7 个 MCP 工具**：`memory_remember` · `memory_recall` · `memory_get_context` · `memory_update` · `memory_forget` · `memory_list` · `memory_stats`
- HTTP API + OpenAI 兼容接口 + React 管理台（候选审核、版本证据、召回解释、索引水位、系统健康）
- 知识库 / RAG 应用层直写通道，字段级契约见 [API 接口文档](docs/api-接口文档.md)

**记忆治理**

- 自然语言记住 / 纠正 / 遗忘的同步快车道；纠正保持稳定 UUID 并追加版本，遗忘先写 tombstone
- 跨多轮推断固定进入待确认，支持确认 / 拒绝 / 阻止未来等价 claim——没有 inference 自动提交开关
- 非破坏式巩固：来源变化或遗忘后摘要自动失效并可重建
- 默认保留用户数据：无自动衰减、无证据脱敏

**工程底座**

- SQLite（`node:sqlite`）+ outbox / jobs：租约、重试、dead letter、崩溃重放、幂等执行
- 全操作审计 + 检索 JSONL 日志（元数据 / 诊断分级、脱敏、轮转、保留清理）
- Memory Doctor 只读体检：重复、冲突、孤儿、失效摘要、超大记忆、零结果热点
- 模型全可配置：默认生成 `qwen2.5:14b`、embedding `bge-m3:latest`（Ollama），无需云服务

## Quick Start

前置：Node.js ≥ 24，Ollama 已运行。

```bash
ollama pull qwen2.5:14b
ollama pull bge-m3:latest

git clone https://github.com/yanglinfeng/memory-bridge.git
cd memory-bridge
npm install
npm run build
npm start          # HTTP 服务 + 管理台：http://127.0.0.1:3789
```

首次启动为空记忆库——没有演示数据，管理台只展示真实写入的内容。

接入任意 MCP 客户端（Claude Desktop / Cline / …）：

```json
{
  "mcpServers": {
    "memory-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/memory-bridge/dist/server/mcp-stdio.js"]
    }
  }
}
```

### 接入示例

三个**零构建、可直接运行**的最小示例（curl / Node / Java），覆盖写入（含 `corpusDomain` /
`classification`）、幂等重放、召回、`supersede` 改版与时序对照查询：

```bash
export MB_TOKEN=你的令牌        # 见 examples/README.md §1

bash examples/curl/quickstart.sh
node examples/node/quickstart.mjs
java examples/java/QuickStart.java      # JDK 17+，零依赖
```

详见 [examples/README.md](examples/README.md)。

### 文档一致性

文档里声明的 schema 版本、环境变量、npm 脚本、HTTP 路由与配置默认值，可以和代码事实一键对撞：

```bash
npm run check:docs
```

它会把「文档说的」与「代码里的」逐项比对并在不一致时以非零退出码失败，适合在发布前与每次
大改后重跑。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

完整安装、运维、接口与排障文档从 [docs/README.md](docs/README.md) 进入；
基准评测的条件与一键复现见 [BENCHMARKS.md](BENCHMARKS.md)。

## 评测

忆桥自带评测与压测链路（`scripts/` 下 40+ 个可执行脚本，覆盖检索、重排、巩固、命名空间隔离、上下文反思、规模、可靠性与崩溃恢复），并在 [`docs/acceptance-report-*.md`](docs/) 中保留带日期与环境的证据快照。

**公开基准（英文知识库问答、中文自建集、大规模延迟压测）的完整条件与一键复现脚本将随 `BENCHMARKS.md` 发布。在数字可复现之前，README 不主张任何分数**——这是本项目「可信层」定位的一部分。

## 和主流方案的区别（按维度，不按体量）

| 维度 | 忆桥 | mem0 | Zep / Graphiti | RAGFlow | AnythingLLM |
|---|---|---|---|---|---|
| 引用可验证（来源绑定 + `traceId`） | ✅ | — | — | ✅ | 部分 |
| 时序有效性（版本替代退出检索） | ✅ 文档级 | — | ✅ 事实级 | — | — |
| 全操作审计日志 | ✅ | 企业版 | ✅ | — | — |
| 命名空间 / 部门隔离 | ✅ 可信会话 + 授权矩阵 | 企业版 | ✅ | 团队级 | Workspace |
| 遗忘与纠正（tombstone / 版本追加） | ✅ | ✅ | ✅ | — | — |
| 完全离线、数据不出本机 | ✅ | 部分 | ❌ 自托管社区版已下线 | ✅ | ✅ |
| MCP 原生 | ✅ 7 工具 | ✅ | 社区封装 | ✅ | — |

> 本表只列**架构上有无**，不评分数高低。各项目迭代都很快，请以各自仓库为准。

## Roadmap

- [x] `BENCHMARKS.md`：公开基准的完整条件与一键复现（`npm run bench:cn` / `bench:cmrc` / `bench:hotpotqa`）
- [x] 社区四件套：`CONTRIBUTING.md` / `SECURITY.md` / `CHANGELOG.md` / `CODE_OF_CONDUCT.md`，附 `.env.example` 与 `examples/`（curl / Node / Java）
- [x] 文档 ↔ 代码一致性门禁 `npm run check:docs`（发布前与每次大改后重跑）
- [x] `supersede` 时补写 `valid_to`，并补 as-of 查询的回归测试
- [x] 清掉 3 例预存在的失败用例：迁移备份与写锁顺序那 1 例已修（改为取锁后复检文件家族）；
  `test:lifecycle` 的 2 例 doctor 经查是 Node 版本低于 `engines >= 24` 所致，**非代码缺陷**
- [x] 英文入口 `README.en.md`（核心指南英文版仍待补）
- [ ] `pretest` 加 Node 版本守卫：`engines` 在 npm 里只是警告、不阻断执行，
  Node < 24 跑 `npm test` 会稳定看到 2 例假红灯
- [ ] 文档解析深度：推荐接入 RAGFlow / Docling 等上游，忆桥专注其上的可信层

## License

[Apache-2.0](./LICENSE)
