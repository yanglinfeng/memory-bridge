# 答案工具框架设计 + 弃答阈值调参手册

状态：工具框架已实现（`src/server/answer-tools.ts`），弃答档案已实现（`src/server/config.ts`） ｜ 2026-09-16

---

## 第一部分：答案工具框架（已落地）

### 1.1 设计原则

| 原则 | 落地方式 |
|---|---|
| 单一注册表，多通道暴露 | `AnswerToolRegistry` 一个实例；HTTP 与 MCP 共享 |
| 纯确定性计算 | 内置工具零 LLM 参与、零副作用、结果可复现 |
| 安全 | 计算器自研词法+调度场求值（**禁 eval**），表达式长度/token 数/结果尺寸有上限 |
| 可扩展 | 新工具 = 实现 `AnswerTool` 接口 + `register()` 一次 |

### 1.2 现有工具

| 工具 | 用途 | 通道 |
|---|---|---|
| `calculator` | 算术表达式（`+ - * / % ^`、括号、一元负号） | `GET /api/tools`、`POST /api/tools/calculator/invoke`、MCP `answer_calculator` |
| `date_diff` | 两日期差（天数 + 年月日拆分），支持 ISO/`YYYY/MM/DD`/中文日期 | 同上，MCP `answer_date_diff` |
| `date_shift` | 日期平移 N 天（可负），返回结果日期与星期 | 同上，MCP `answer_date_shift` |

### 1.3 新增工具步骤（未来接入搜索、单位换算等）

1. 在 `src/server/answer-tools.ts` 实现 `AnswerTool`（name/params 描述/execute）；
2. `answerToolRegistry.register(...)` —— HTTP 通道自动出现；
3. 需要暴露给 MCP 客户端时，在 `mcp-server.ts` 加一条薄封装（zod schema 转发）。

**约定**：参数非法抛 Error（message 面向调用方）；结果 JSON ≤ 4096 字节（注册表统一护栏）；工具永不触库、不发网络请求——需要外部数据的工具（如企业搜索）单独评审再进。

---

## 第二部分：弃答阈值调参手册

### 2.1 架构：弃答策略档案（Abstention Profile）

**一次切换一组闸门默认值，单项 env 仍可覆盖（env > 档案）。**

```
MEMORY_BRIDGE_ABSTENTION_PROFILE = strict | balanced | eager
```

| 闸门 | strict（出厂零回归） | balanced（KB 推荐） | eager（激进） |
|---|---|---|---|
| `MEMORY_BRIDGE_MIN_SEMANTIC_SIMILARITY`（粗排候选门） | 0.35 | 0.30 | 0.25 |
| `MEMORY_BRIDGE_SEMANTIC_RERANK_EMPTY_FALLBACK_LIMIT`（重排全拒兜底条数） | 3 | 4 | 6 |
| `MEMORY_BRIDGE_SEMANTIC_RERANK_FILLER_LIMIT`（相关不足按粗排分填充） | 0（关） | 2 | 4 |

balanced 档的依据：内部调优时最优档位为 `filler=3`，档案取 2 是刻意保守一档，避免在自家语料上过拟合（完整评测条件与脚本随 `BENCHMARKS.md` 发布）。

**不在档案里的固定闸门（改动需改代码，属语义级）**：
- 确定性弃答（墓碑 `deterministic_tombstone_abstention`、规范值不匹配 `deterministic_canonical_value_mismatch`）——**永不放宽**，这是防幻觉的最后防线；
- `semanticMinConfidence`（0.7）——对 Ollama 重排无效（confidence 硬编码 0.95/1），仅对接其他 rerank 提供方时有意义；
- 早停规则（`sufficient_relevant` / `coarse_score_cliff 0.65`）——影响延迟不影响弃答，暂不动。

### 2.2 调试循环（每轮 10 分钟）

```
1. 改 env（或换档案）→ 2. 跑 cn-eval（12 题，~90s）→ 3. 读 results JSONL 的
retrieval_trace → 4. 归因 → 回到 1
```

```bash
# 快速对照（中文，12 题）
cd cn-eval && CN_PROFILE=balanced CN_SCALE=1000 CN_TAG=try1 node run_cn.mjs

# 关键 trace 字段（读这些就够了，别逐条翻 decisions）：
#   stopReason                  ← 本次为什么停（candidate_cap / sufficient_relevant / ...）
#   relevantCandidateCount      ← 重排列为相关的条数
#   rerankFillerCount           ← filler 补了多少条
#   rerankEmptyFallbackCount    ← 全拒兜底补了多少条
#   minSimilarity 门下被滤掉的  ← 看 candidateDecisions 里 stage=coarse 的 rejected
```

### 2.3 归因决策表

| 症状（trace 表现） | 归因 | 调哪个 |
|---|---|---|
| `stopReason=all_candidates_attempted` 且 `relevantCandidateCount=0` | 候选池太小/门槛太高 | 调低 MIN_SEMANTIC_SIMILARITY |
| `relevantCandidateCount=0` 但粗排分数不低 | 重排误杀 | 依赖全拒兜底（已开）或查 KB_RERANK prompt |
| 多跳题 gold 排名靠后或缺失 | 链条中间环节被滤 | 加 FILLER_LIMIT |
| 不可答题开始乱答 | 放得太开 | 回退一档，或检查 filler 来源过滤 |
| 延迟上涨明显 | 相似度门放太低进了太多候选 | 门不低于 0.25，候选池上限 64 兜底 |

### 2.4 铁律

1. **每改一档必须同时看"不可答题"表现**——弃答放宽的唯一风险就是把"正确弃答"变成"幻觉作答"，cn-eval 固定带 2 道不可答题就是干这个的。
2. 改动阈值后跑 `npm test`（新增档案测试会校验三档单调性与 strict 基线）。
3. 生产推荐 balanced；eager 只在大干扰库 + 有人工复核的场景试。
