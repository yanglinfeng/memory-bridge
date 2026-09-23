# 忆桥文档中心

本目录是“忆桥 Memory Bridge”的完整交付文档。当前源码数据库 schema 为
**44**（以 `src/server/database.ts` 的 `SCHEMA_VERSION` 为准）；默认运行栈为 Node.js 24+、SQLite、Ollama、TypeScript、React 和 MCP
stdio。首次启动为空数据，不包含演示记忆。

## 按角色开始

| 你是谁 | 建议阅读顺序 |
|---|---|
| 知识库/RAG 应用层 | [API 接口文档](api-接口文档.md) → [配置参考](configuration-reference.md) → [检索日志排障](retrieval-logging.md) |
| 第一次使用 | [一键安装与操作](one-click-installation-and-operation.md) → [界面使用](ui-guide.md) → [AIRI 接入](airi-integration.md) |
| AIRI 用户 | [AIRI 接入](airi-integration.md) → [MCP 手册](mcp-guide.md) → [召回日志排障](retrieval-logging.md) |
| API/MCP 集成方 | [HTTP API](api-reference.md) → [MCP 手册](mcp-guide.md) → [配置参考](configuration-reference.md) |
| 运维人员 | [运行维护](operator-guide.md) → [部署升级](deployment-and-upgrade.md) → [备份恢复](backup-and-restore.md) → [故障排查](troubleshooting.md) |
| 安全负责人 | [安全与隐私](security-and-privacy.md) → [数据模型](data-model.md) → [日志总览](logging-guide.md) |
| 开发人员 | [技术实现](technical-reference.md) → [数据模型](data-model.md) → [开发指南](developer-guide.md) → [测试发布](testing-and-release.md) |

## 用户与接入文档

| 文档 | 内容 |
|---|---|
| [一键安装与操作](one-click-installation-and-operation.md) | Pinokio 安装、首次使用、AIRI/MCP 接入、升级、备份、诊断和卸载 |
| [快速开始](quick-start.md) | 从空环境启动、创建账户、验证服务并接入 AIRI |
| [界面使用](ui-guide.md) | 管理台各页面、历史重提炼、常见任务、危险操作和状态解释 |
| [AIRI 接入](airi-integration.md) | 兼容代理、Conversation 目标路径、历史迁移和真实验收 |
| [MCP 手册](mcp-guide.md) | 七个 MCP 工具、stdio 配置、参数和错误处理 |
| [HTTP API](api-reference.md) | HTTP/Conversation 路由、鉴权、SSE、恢复、删除、导入和错误码 |
| [命令参考](command-reference.md) | npm 脚本、身份 CLI、健康检查和常用命令 |
| [FAQ](faq.md) | 常见产品与使用问题 |
| [术语表](glossary.md) | principal、persona、scope、tombstone、trace 等术语 |

## 运维与治理文档

| 文档 | 内容 |
|---|---|
| [运行维护](operator-guide.md) | 首次安装、日检、保留策略、升级和发布前检查 |
| [配置参考](configuration-reference.md) | 所有运行时环境变量、默认值、范围和生效方式 |
| [部署升级](deployment-and-upgrade.md) | 开发/生产运行、目录规划、升级、迁移和回滚 |
| [备份恢复](backup-and-restore.md) | 每账户 JSON v3 备份、SQLite 备份、恢复验证 |
| [日志总览](logging-guide.md) | Conversation/业务审计、检索 trace、反思调用、任务/死信和 Doctor |
| [召回日志排障](retrieval-logging.md) | 九阶段检索 trace 和错误/低召回定位流程 |
| [故障排查](troubleshooting.md) | 按症状定位 Ollama、身份、索引、队列和界面问题 |
| [安全与隐私](security-and-privacy.md) | 本地边界、令牌、租户隔离、敏感数据和威胁模型 |

## 技术与质量文档

| 文档 | 内容 |
|---|---|
| [架构与记忆模型](architecture.md) | 产品级分层记忆模型和关键边界 |
| [技术实现](technical-reference.md) | 兼容/Conversation 请求链、后台任务、一致性和失败语义 |
| [数据模型](data-model.md) | schema 44 会话/分层记忆/多租户表组、实体关系、版本、证据、可见性与密级、冷热精炼、删除和导入 |
| [开发指南](developer-guide.md) | 代码入口、扩展点、约束和变更验证方式 |
| [测试与发布](testing-and-release.md) | 门禁层级、模型评测、真实 AIRI 验收和重验触发器 |
| [schema 37 分层记忆验收报告](acceptance-report-schema37-layered-memory.md) | L0–L4、自然对话质量、80K 长时间轴、回归、性能和回执证据 |
| [schema 38 存储精炼验收报告](acceptance-report-schema38-storage-refinement.md) | 任务收口、可逆冷热精炼、20K 数据库副本、重启与空间回收证据 |
| [schema 31 历史验收报告](acceptance-report-schema31-context-reflection.md) | 上下文查询、历史重提炼、规模、崩溃恢复、延迟门禁和 AIRI 证据边界 |
| [schema 30 历史验收报告](acceptance-report-schema30-context-reflection.md) | schema 31 前的功能、规模与隔离 AIRI 证据快照 |
| [schema 28 历史验收报告](acceptance-report-p0-p1.md) | 旧 P0/P1 自动化和 AIRI 0.11.3 证据快照，不代表当前结论 |
| [P0/P1 交付 PRD](prd-p0-p1-observability-delivery.md) | 本次发布范围、可行性、任务和发布门槛 |
| [上下文查询与历史反思 PRD](prd-contextual-query-understanding-and-memory-reflection.md) | 口语指代查询理解、历史重提取、跨多轮反思和安全验收 |
| [上下文查询与历史重提炼最终 PRD](prd-contextual-query-and-history-refinement-final.md) | 最终范围、补充缺口、可行性、实施阶段和完成定义 |
| [会话权威与聊天 API PRD](prd-conversation-authority-and-chat-api.md) | schema 36 单消息聊天、SSE 恢复、删除、导入、客户端切换和完成定义 |
| [分层情景记忆 P0/P1 PRD](prd-layered-episodic-memory-p0-p1.md) | schema 37 L0–L4、统一召回、观察晋升、摘要、性能和完成定义 |
| [完整产品 PRD](prd-airi-memory-system.md) | 全量产品目标、需求、数据和质量约束 |

## 设计文档（面向当前实现）

| 文档 | 内容 |
|---|---|
| [多租户隔离与可信会话](design/multi-tenant-isolation.md) | trusted_sessions 签发、授权矩阵、写读同源闸门、部门互不可见与失败关闭语义 |
| [答案工具与弃答调参](design/answer-tools-and-abstention-tuning.md) | calculator / date_diff / date_shift 框架，以及 strict / balanced / eager 三档的调参循环 |

英文入口见仓库根目录 [`README.en.md`](../README.en.md)；核心指南的英文版仍在 Roadmap 上。

## 文档使用约定

- 配置默认值以 `src/server/config.ts` 为最终事实源。
- HTTP 行为以 `src/server/http-server.ts` 为最终事实源；MCP 行为以
  `src/server/mcp-server.ts` 为最终事实源。
- 数据库当前版本以 `src/server/database.ts` 中的 `SCHEMA_VERSION` 为准。
- 验收报告是带日期和环境的证据快照，不应被理解为任何未来模型、AIRI
  版本或 schema 都自动通过。
- PRD 与验收报告是**历史文档**：里面写的「当前 schema」「60/627」等数字都是写作
  当时的快照，不要拿它们当作今天的行为说明；今天的行为以本节上方列出的手册为准。
- 文档中的 Token、账户 ID、traceId 和 memoryId 都是占位符；不要把真实
  Token、私人记忆、诊断导出或备份提交到 Git。

## 当前文档快照

- 文档刷新日期：2026-09-23。
- 源码 schema：44（v40 内容出生通道 `memories.origin`；v41 `trusted_sessions` 可信会话签发与部门级隔离；v42 语料域 `memories.corpus_domain`；v43 密级列与幂等键 scope 维度；v44 `public` scope 公开通道）。
- 默认模型：`qwen2.5:14b`；默认 embedding：`bge-m3:latest`。
- 默认 HTTP：`http://127.0.0.1:3789`。
- 默认自动化模式：`shadow`。
- 默认历史重提炼模式：`shadow`；跨多轮 inference 永不自动提交。
- 当前 schema 44 继承的存储精炼基线证据见
  [schema 38 存储精炼验收报告](acceptance-report-schema38-storage-refinement.md)；内容质量
  仍以 [schema 37 分层记忆验收报告](acceptance-report-schema37-layered-memory.md) 为基线。
  历史 schema 31/30/28 的数字只作为旧基线，不能替代当前代码的完整回归、自然对话
  质量、长时间轴和真实客户端门禁。
