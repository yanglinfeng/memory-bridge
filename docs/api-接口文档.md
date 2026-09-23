# 忆桥 Memory Bridge 接口文档（知识库接入指南）

> 适用版本：schema v40（2026-09-16）。面向知识库/RAG 应用层及任何想把文档/流式内容接入忆桥的客户端。
> 所有改动均已提交（内核 `5898381`）。

---

## 1. 总览

| 项目 | 值 |
|---|---|
| 生产实例 | `http://127.0.0.1:3789` |
| 认证 | `Authorization: Bearer <MEMORY_BRIDGE_TOKEN>`（所有 /api 路由强制） |
| 数据目录 | `MEMORY_BRIDGE_DATA_DIR` 环境变量指定（多实例隔离用） |
| MCP 接入 | stdio，工具名前缀 `memory_`（见 §6） |

**信任模型（零配置核心）**：通过认证 API 直写的记忆，服务端强制打 `origin=api` 标记，凭通道背书参与召回兜底，**调用方无需任何白名单或配置**。客户端声明的来源字段不参与信任判定，不可伪造。

---

## 2. 文档入库（文本切片直写）

切片工作在应用层完成（应用层的 Markdown → 章节级切分），忆桥只接切好的片段。**每个片段一次 POST**：

```
POST /api/memories
```

```jsonc
{
  "kind": "document_chunk",              // 固定：文档片段专用 kind
  "content": "……切分后的原文片段（逐字引用，不要改写）……",
  "title": "员工手册 > 第三章 考勤",      // 建议带文档路径/章节号，便于溯源
  "tags": ["kb:document-chunk", "kb:file", "doc:employee-handbook"],
  "source": "kb:file",            // 入口标记：文件型
  "sourceRef": "employee-handbook.md#ch3-s2",  // 文档内定位
  "idempotencyKey": "kb:employee-handbook:ch3-s2",  // 幂等键：重复导入不产生重复条目
  "importance": 0.5,
  "occurredAt": "2026-09-01T00:00:00Z"   // 可选：文档生效/发布时间
}
```

**必须遵守的约定：**

1. `kind` 必须是 `document_chunk` —— 治理管线（合并/反思/层级摘要）按此豁免，不会把文档片段当对话记忆误伤；
2. `source` 以 `kb:` 开头（`kb:file` = 文件型入口，`kb:stream` = 流式入口）；
3. `content` 保持**逐字原文**，切分即结构化提取，不要 LLM 改写（会破坏指纹幂等与稠密检索质量）；
4. `idempotencyKey` 稳定可复算（如 `doc名:章节:序号`），重复导入自动合并。

响应：`201` + 完整 MemoryRecord（含 `id`）。

### 2.1 文档版本更新（新值取代旧值）

文档改版后重导同一章节时，用 supersedes 链自动封口旧片段：

```jsonc
{
  "kind": "document_chunk",
  "content": "新版考勤规定：每周 4 天到岗",
  "idempotencyKey": "kb:employee-handbook:ch3-s2-v2",
  "source": "kb:file",
  "validFrom": "2026-09-16T00:00:00Z",   // 新规定生效时间
  "supersedesId": "旧片段的 memory id"    // 旧片段自动封口为历史事实
}
```

效果：现在查询只见新规定；**传 `timestamp` 查过去时点仍能看到旧规定**（bi-temporal，见 §4）。

### 2.2 批量写入注意

当前每条一次同步 HTTP（含向量化），大文档导入建议**串行 + 适度间隔**；批量接口（一次多片段）在路线图中（S5），未上线。

---

## 3. 流式录入

与 §2 同一接口，仅入口标记不同：

```jsonc
{
  "kind": "document_chunk",
  "content": "……",
  "source": "kb:stream",
  "tags": ["kb:document-chunk", "kb:stream", "stream:钉钉群-售后支持"],
  "sourceRef": "dingtalk-group-123/2026-09-16#msg-456",
  "idempotencyKey": "kb:stream:dingtalk-123:msg-456"
}
```

流型入口与文件型靠 tag 隔离，治理策略互不干扰。

> ⚠️ 现状：流式**结构化提取器**（从聊天/邮件流里提炼经验教训，P2/P4 范畴）忆桥侧尚未实现——当前流式录入是"原文片段直存"，不提炼。KB 主链路不受影响。

---

## 4. 查询（召回）

```
POST /api/recall
```

```jsonc
{
  "query": "考勤规定是什么？",            // 支持中英文口语，与文档语言不一致也可命中
  "limit": 8,                            // 返回条数上限
  "contextTokenBudget": 2000,            // 生成 context 文本的 token 预算
  "kinds": ["document_chunk"],           // 可选：只查文档库
  "tags": ["doc:employee-handbook"],     // 可选：按文档过滤
  "timestamp": "2026-09-01T00:00:00Z"    // 可选：bi-temporal as-of 查询
}
```

**`timestamp`（as-of 时间轴）**：
- 省略 = 查"现在"，只返回当前有效事实；
- 传过去时间 = 该时点仍有效、后被取代（superseded）的旧事实也可召回，并带有效期窗口标注（`发生时间` / `有效期`），用于回答"以前是什么、现在改成什么了"。

响应关键字段：

```jsonc
{
  "qualityState": "full",          // full=正常召回；degraded/fallback=降级
  "memories": [ { "memory": {...}, "score": 0.766, "reasons": [...] } ],
  "context": "……可直接拼入 LLM prompt 的紧凑文本（每条含发生时间/有效期/来源摘要）……",
  "traceId": "……"                  // 检索全过程留痕，排障用
}
```

`context` 是给作答模型用的成品文本——**接入方应把 `context` 直接放进 prompt**，让模型基于它回答，而不是自己拼 memories。

### 检索管线（内部，供理解）

查询改写（中英/口语→文档语汇）→ FTS5 词面 + 稠密向量（bge-m3）+ 概念倒排三通道 → LLM 重排（document_chunk 走 KB 专用判据："是否包含回答 q 所需信息"）→ 兜底门禁（api 直写条目凭通道背书放行）。

---

## 5. 其他 HTTP 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/memories` | 列表/分页查询记忆 |
| GET | `/api/memories/:id` | 单条详情（含关系） |
| PATCH | `/api/memories/:id` | 校对/更新单条 |
| DELETE | `/api/memories/:id` | 遗忘（软删，body 可带 `reason`） |
| POST | `/api/memories/:id/restore` | 恢复 |
| GET | `/api/stats` | 数量/类型/命名空间分布 |
| GET | `/api/retrieval-traces` | 按 traceId 查检索过程 |
| GET/PUT | `/api/retention-policies` | 保留策略（默认不衰减、不抹除，见 §8） |
| GET | `/api/export` / POST `/api/import` | 备份/迁移 |

---

## 6. MCP 工具（7 个）

给 AIRI 等聊天客户端用；知识库应用层建议走 HTTP。

| 工具 | 用途 |
|---|---|
| `memory_remember` | 写入（服务端强制 origin=api） |
| `memory_recall` | 召回（支持 `timestamp` as-of） |
| `memory_get_context` | 检索 + 生成可拼 prompt 的紧凑上下文 |
| `memory_update` / `memory_forget` | 更新 / 遗忘 |
| `memory_list` / `memory_stats` | 查看 / 统计 |

---

## 7. 能力现状与已知短板

忆桥的能力目标是**在有出处的前提下作答**：答不出时明确弃答，而不是编一个。

已具备：

- 引用可验证——每次召回带 `traceId`，可回放「查询改写 → 候选 → 融合 → 重排 → 选择 → 注入」全程；
- 弃答闸门——确定性规则（墓碑、规范值不匹配）永不放宽，语义闸门可按 `strict / balanced / eager` 档位调节；
- 时序有效性——`valid_from` / `valid_to` 约束检索窗口，被替代的版本退出召回；
- 完全离线——Embedding、重排、生成全部走本机 Ollama 或本地 sidecar。

已知短板：

1. 召回覆盖不足时，新写入事实存在漏召回（P1 调优中）；
2. 无计算 / 推理层——「三天前」这类日期算术题目前走弃答（P2）；
3. 批量写入吞吐受本机模型进程限制（S5）。

> 本仓库的评测脚本（`scripts/` 下 40+ 个）与带日期、带环境的证据快照（`docs/acceptance-report-*.md`）可用于自查。
> 公开基准的完整条件与一键复现脚本随 `BENCHMARKS.md` 发布；在其可复现之前，本站文档**不主张任何分数**。

---

## 8. 数据保留与生命周期（默认不衰减、不删数据）

忆桥对用户数据的默认立场是**保留**：没有任何后台任务会自动删除记忆内容。

| 机制 | 默认 | 动作 | 可逆 |
|---|---|---|---|
| 时间衰减归档 | **关闭** | 无 | — |
| 证据 TTL 抹除 | **关闭** | 无 | — |
| 显式 TTL（`expires_at`） | 不设置 | 到期后记忆归档，默认召回不可见（`includeArchived: true` 仍可召回） | 可 `restore` 恢复 |
| 物理清除（purge） | 不触发 | `secure_delete` 覆写主库与迁移备份 | 不可逆，仅主动请求 |

**要启用衰减或抹除，必须显式配置策略**（`PUT /api/retention-policies`）：

```jsonc
{
  "namespace": "personal",
  "kind": "event",          // 省略或 null = 该 namespace 下全部类型
  "halfLifeDays": 365,      // 权重每 365 天减半，跌破阈值才归档
  "evidenceTtlDays": 90,    // 该天数之前的对话原文与证据摘要会被抹除
  "autoArchive": false      // false = 该 scope 完全不参与归档判定
}
```

| 字段 | 传 `null` 的含义 | 传数字的含义 |
|---|---|---|
| `halfLifeDays` | **永久保留**（不参与时间衰减） | 权重每 N 天减半，跌破阈值时归档 |
| `evidenceTtlDays` | **永不抹除证据** | N 天前的对话原文改写为 `[retention-redacted]`，`memory_evidence.excerpt` 置空 |
| `autoArchive` | — | `false`：该 scope 完全不归档 |

策略写入是**全字段覆盖**（`ON CONFLICT DO UPDATE`）：只提供部分字段时，未提供的字段会被重置为 `null`（即不衰减、不抹除）。

**对知识库接入方的含义**：`kind=document_chunk` 的片段不参与时间衰减，且直写不产生对话轮次，因此不会被证据 TTL 触及。唯一需要注意的是 `kind` 必须正确打标——漏标或误标为 `knowledge`/`event` 会让文档片段进入衰减轨道。

> v0.40 变更说明：`evidenceTtlDays` 曾默认 90 天，会在无人工配置的情况下把 90 天前的对话原文与证据摘要静默抹除；`halfLifeDays` 曾按类型默认取 90~730 天，会静默归档老记忆。现两者默认均为"不启用"——关闭是默认状态，需要清理才显式开启。
