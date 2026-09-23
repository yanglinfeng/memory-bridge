# Schema 37 分层情景记忆 P0/P1 验收报告

状态：最终验收进行中  
日期：2026-08-13  
范围：[分层情景记忆 P0/P1 PRD](prd-layered-episodic-memory-p0-p1.md)

## 1. 判定边界

本报告验收忆桥 schema 37 的 L0–L4 分层记忆后端，包括情景入账、统一召回、
跨窗口观察、反思截断补偿、层级摘要、整理、日志、性能和后台可靠性。

它不把后端测试冒充成 AIRI/宝豆桌面或手机 UI 真机验收。最终会分别给出：

- 分层记忆后端 P0/P1 判定；
- 真实客户端整体发布边界；
- 可复核数据库、manifest、回执、SHA-256 和测试命令。

在 80K 回执、最终完整回归和文档门禁全部完成前，本报告状态保持“进行中”。

## 2. 实现映射

| PRD 项 | 当前实现 | 主要代码与验证 |
|---|---|---|
| P0-1 情景可靠入账 | 完整 exchange 异步、无 LLM、幂等生成 L1；绑定 owner/namespace/scope/session/user turn/assistant turn；凭据脱敏 | `episodic-memory-service.ts`、`memory-worker.ts`、`episodic-memory.test.ts` |
| P0-2 联合索引 | 情景事务内进入 FTS；Dense 通过可重试任务异步写 embedding/LSH | `memory-store.ts`、`hybrid-retrieval.ts`、`episodic-memory.test.ts`、`memory-worker.test.ts` |
| P0-3 统一召回 | fact/episode/summary 混合召回、独立配额、明确上下文标签、租户与 scope 隔离 | `memory-layering.ts`、`memory-store.ts`、`hybrid-retrieval.test.ts`、`memory-layering.test.ts` |
| P0-4 跨窗口观察 | claim fingerprint + turn 唯一观察；3–5 条独立证据；可要求跨 session/day；反证、纠正和遗忘阻断 | `pattern-observation-store.ts`、`memory-reflection.ts`、`pattern-observation.test.ts` |
| P0-5 截断补偿 | 最多 4 候选、每候选最多 5 条证据；记录 done reason/eval/output 指纹；截断只重试一次 compact 请求；失败不提交或推进 checkpoint | `memory-reflection.ts`、`memory-reflection.test.ts` |
| P1-1 层级摘要 | session/day/ISO week 摘要；输入指纹幂等；逐句绑定 episode/version；失败保留旧有效版本 | `hierarchical-summary-service.ts`、`hierarchical-summary-service.test.ts` |
| P1-2 记忆整理 | observation 证据累计而非重复事实；摘要不自证；删除、遗忘、物理清除和备份覆盖所有分层表 | `memory-governance.ts`、`conversation-import-delete.test.ts`、`full-backup.test.ts`、`memory-governance.test.ts` |
| P1-3 可观测性 | 两阶段任务日志、来源层标签、情景/Dense/摘要/observation Doctor 检查、dead letter 恢复证据 | `memory-admin.ts`、`retrieval-observability.ts`、`logging-guide.md`、相关测试 |

## 3. 关键架构与性能修复

旧实现的单条 `index_memory` 会在每次 embedding 后扫描整个 owner/namespace 的
Dense 水位，40,000 条时形成近似 N² 放大。当前实现改为：

1. 非队尾索引任务只增量写本记忆的 embedding/LSH；
2. 同 scope/generation 的当前到期任务清空后，队尾才执行一次完整水位核验；
3. future `available_at` 任务不阻塞当前 eligible 水位；
4. Worker 复用已经完成的 generation probe；直接批量回填仍保留完整验收语义。

真实 40K 数据库副本的 100 个生产 Worker 索引烟测：总计 1839.404 ms、平均
18.394 ms/任务、P95 21.111 ms；修复前单任务约 70–90 秒。该烟测证明缺陷定位和
局部修复，最终是否通过仍以本报告的完整 80K 收敛回执为准。

## 4. 自然对话质量证据

权威隔离运行：

- 根目录：`.memory-bridge-private/natural-conversation-quality/run-sUN8rD`
- 范围：3 用户 × 每用户 2 角色 × 每角色 80 条，共 480 条、45 天、写并发 4
- 固定模型：`legacy local generation model`、`bge-m3:latest`
- 总状态：PASS
- exchange→episode、turn 绑定、FTS、Dense：全部 100%
- session/day/week 摘要：6/240/42，来源支持率 100%
- 情景 Recall@5：1.0
- 可靠召回 Recall@1/3/5、MRR、Precision@1、负例弃答率：全部 1.0
- 可靠召回 P50/P95：288.110/1284.802 ms，P95 门槛 ≤1500 ms
- 跨账户、跨角色、跨项目泄漏：0
- 旧值复活、遗忘复活、错误记忆、最终回答幻觉：0
- 稳定习惯：5/6，错误稳定模式 0
- SQLite integrity：ok；外键违规、未收敛工作、dead letter：0
- 回执权限：0600
- 回执 SHA-256：`f8a32338bb2c81ee5d4d53c14b728abd47a5712b7c2a2be37f103c889c35428f`

该运行使用真实模型做质量样本，但不等同于对每条消息调用 legacy local model，也不替代 80K
规模、完整回归或真实客户端验收。

## 5. 80K 长时间轴证据

最终运行正在执行，完成后在此固化：

- 8 用户 × 每用户 10,000 条，共 80,000 条；
- 180 天时间轴；实际写并发 4；
- 40,000 个完整 episode；
- episode/FTS/Dense/session-day-week 摘要来源覆盖；
- observation、outbox/jobs、failed reflection、dead/unhealthy/DLQ；
- 8 个真实 MCP principal 的七工具契约、正向召回和环形跨账户零泄漏；
- 200 次 FTS 样本非空且 P95 <150 ms；
- 数据库关闭重开后的 persistence fingerprint；
- `fullScaleGenerationProviderCalls: 0` 的明确 provenance；
- 回执路径、0600 权限和独立 SHA-256 复算。

## 6. 最终回归与构建

最终 80K 运行结束后重新执行并记录：

```bash
node --test tests/qa-conversation-long-timeline-contract.test.mjs
npm test
npm run typecheck
npm run build
```

HTTP/SSE 测试必须在允许本机 loopback 的环境运行；环境阻断不能记为 PASS。

## 7. 最终判定

当前：`PENDING`。原因不是已知功能缺陷，而是最终 80K 收敛、完整回归、构建和
文档质量门禁尚未全部形成回执。完成后本节会逐条列出 PASS/FAIL 和剩余边界。

