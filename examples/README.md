# 接入示例

三个**零构建、可直接运行**的最小示例，覆盖知识库接入的核心链路：

| 示例 | 运行方式 | 适合 |
|---|---|---|
| [`curl/quickstart.sh`](curl/quickstart.sh) | `bash examples/curl/quickstart.sh` | 最快验证接口通不通 |
| [`node/quickstart.mjs`](node/quickstart.mjs) | `node examples/node/quickstart.mjs` | Node / 脚本化接入（Node ≥ 18，零依赖） |
| [`java/QuickStart.java`](java/QuickStart.java) | `java examples/java/QuickStart.java` | 后端服务集成（JDK 17+，零依赖） |

三者做的是同一件事，便于对照：

1. 健康检查
2. 写入一段文档切片（带 `corpusDomain` / `classification`）
3. 召回并打印可直接拼进 prompt 的 `context`
4. 验证幂等：同一 `idempotencyKey` 重放不产生重复条目
5. 用 `supersedesId` 发布修订版，再分别查「现在」与「过去某时点」

> 示例里的响应字段处理**刻意从简**（curl 用 `jq`、Node 用 `JSON`、Java 用正则提取）。
> 生产代码请用你惯用的 HTTP 客户端与 JSON 库。Java 示例的注释里标了该替换的位置。

---

## 1. 前置

**服务在跑**（默认 `http://127.0.0.1:3789`）：

```bash
npm run build && npm start
curl -s http://127.0.0.1:3789/api/health
# {"ok":true,"service":"memory-bridge","version":"1.0.0","mcpTransport":"stdio"}
```

**拿到令牌。** 除健康检查外，`/api` 路由都要求 `Authorization: Bearer <token>`。三选一：

```bash
# 方式 A：临时全局 Token（最快，仅本机调试；不区分主体，泄露即全库可达）
MEMORY_BRIDGE_TOKEN=dev-token-only npm start
export MB_TOKEN=dev-token-only

# 方式 B：账户凭据（推荐，可吊销、可设过期）
npm run identity -- init --display-name YOUR_NAME --label main
npm run identity -- issue-token --principal <principalId> --label laptop --expires-at 2027-01-01
export MB_TOKEN='mb1.…'

# 方式 C：匿名公开读（只读，且只可见 public scope + public 密级）
MEMORY_BRIDGE_ANONYMOUS_MODE=public-readonly npm start    # 然后不传 Authorization
```

示例从环境变量读取（不传则默认打到 3789）：

```bash
export MB_BASE=http://127.0.0.1:3789
export MB_TOKEN=你的令牌
```

## 2. 字段怎么填：`corpusDomain` 与 `classification`

这两个字段决定**这条切片谁能看到**（密级）和**用多严的门槛判断它是否相关**（语料域）。
不填也能用，但填对了召回质量差别很大。

| `corpusDomain` | 门槛 | 用在哪 | 代价 |
|---|---:|---|---|
| `policy` | 0.9 | 制度、合同、规章 | 召回略少——「同话题但不是答案」的段落会被压掉，可能直接拒答 |
| `open` | 0.65 | 百科、公开文档、FAQ | 问法与正文措辞距离大时不易误杀 |
| `chat` | 0.7 | 对话记忆 | 文档片段**不要**标成 `chat` |

| `classification` | 谁能读到 |
|---|---|
| `public` | 匿名公开通道也能读（配合 `public` scope）。**标它等于同意被公开读到** |
| `internal`（默认） | 登录主体，密级足够即可 |
| `confidential` | 只有 `clearance=confidential` 的会话 |

**一条实测经验**：`policy` 门槛 0.9 是刻意从严的。查询措辞离正文太远会**直接拒答**
（返回 0 条、`qualityState: full`）——这是设计行为，不是故障。制度类语料的查询尽量带上正文里的
关键词，或者用 `balanced` 档位放宽（`MEMORY_BRIDGE_ABSTENTION_PROFILE=balanced`）。

## 3. 时序有效性：改版了怎么办

文档改版**不要**新建一份不同 `idempotencyKey` 的切片然后指望模型自己分辨新旧——用
`supersedesId` 显式声明取代关系：

```jsonc
{
  "idempotencyKey": "kb:employee-handbook:ch3-s2-v2",   // 新键（改版必须换键）
  "supersedesId": "旧切片的 memory id",                  // 旧切片自动转为 superseded
  "validFrom": "2026-09-20T00:00:00Z"                    // 新规定生效时间
}
```

效果（实测）：

| 查询 | 结果 |
|---|---|
| 不带 `timestamp`（查"现在"） | 只返回**修订版**（"每周到岗 3 天"） |
| `"timestamp": "2026-09-10T..."`（查过去） | 只返回**当时的旧版**（"每周到岗 4 天"） |

**注意**：当前版本在 `supersede` 时**尚未补写旧记录的行级 `valid_to`**（查询响应里该字段可能是
`null`），旧版本靠 `status=superseded` 退出默认检索。as-of 查询已能正确区分两个版本。
这一点记在 [Roadmap](../README.md#roadmap) 里，会在后续版本补齐。

## 4. 写入的其他约定

- 每个切片**一次 POST**，串行 + 适度间隔（含向量化，大文档导入不要并发打满）。
- `content` 保持**逐字原文**，不要在忆桥侧做 LLM 改写——会破坏指纹幂等与稠密检索质量。
  切分与结构化提取属于上游应用层。
- `idempotencyKey` 要稳定可复算（如 `文档名:章节:序号`）。重复导入会自动合并，不产生重复条目。
- **去重是两级的**，理解它能解释"为什么没产生新条目"：
  1. **幂等键**——同 `user` + `namespace` + scope + key 命中已有条目时，直接返回它
     （`created: false`、`deduplicated: true`）。这一级由你控制，务必用稳定键。
  2. **内容指纹**——当键不同或未提供键时，若同 `user`/`namespace`/scope 下已有**内容校验和与
     `occurredAt`/`validFrom`/`validTo` 三项全部相同**且未删除的条目，则合并进它（tags 取并集，
     `importance`/`confidence` 取较高值），不新建条目。

  推论：**同一段原文配同一个 `occurredAt` 重复入库不会产生副本**；反过来，如果你把 `occurredAt`
  写成"导入时刻"，那每次导入都会新建一条。示例脚本的查询数据因此可安全重复运行。
- `kind` 必须是 `document_chunk`：治理管线（合并 / 反思 / 层级摘要）按此豁免，不会把文档片段
  当对话记忆处理；同时它不参与时间衰减。

完整字段契约见 [API 接口文档](../docs/api-接口文档.md)；召回参数与降级语义见
[API 参考](../docs/api-reference.md)。
