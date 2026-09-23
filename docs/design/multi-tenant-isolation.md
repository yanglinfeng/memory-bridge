# 多租户隔离与可信会话架构设计

状态：**P0 已实现**（trusted_sessions v41 迁移、POST/DELETE/GET /api/sessions、配置文件授权矩阵、写读同源闸门、部门互不可见端到端测试） ｜ 前置事实全部经过读码核实（引用 `文件:行号`） ｜ 2026-09-16

**已实现与设计的差异**：R1 失败关闭在"召回侧"采取**显式 401**（过期/吊销/主体不符），而非静默回落 personal/self——显式失败更利于调试且同样不放大可见范围；矩阵文件缺失时签发 403、写闸不生效（零回归）。

---

## 0. 一句话结论

**多租户隔离走"HTTP 标准 API 为权威入口"路线：知识库摄取服务 等服务端系统按标准接口调用，MCP 只保留给聊天型客户端（AIRI）。可信会话采用"服务端签发、短期令牌、scope 绑定在会话上"的协议，客户端从头到尾不能自报 scope。**

---

## 1. 入口路线决策：MCP 入口 vs 标准接口

| 维度 | HTTP 标准 API（推荐） | MCP 入口 |
|---|---|---|
| 适配对象 | 服务对服务（知识库摄取服务、企业内网系统） | LLM 聊天客户端（AIRI） |
| 鉴权模型 | API token → 服务端裁定 scope | 连接级绑定（boundNamespace/固定 principal） |
| 批量/幂等 | 天然支持（幂等键、错误码、重试） | 弱（工具调用语义，无批量契约） |
| 错误处理 | 标准 HTTP 状态码 + 结构化错误 | 工具错误文本，调用方需解析 |
| 审计 | 完整请求级审计 | 工具调用级审计 |
| 结论 | **权威入口，新能力先落这里** | 适配器：能力子集 + 会话语义 |

**原则：两个通道共享同一套服务端裁定逻辑（scope 解析、可见性过滤、审计），不重复实现；HTTP 先行，MCP 跟进子集。**

### 1.1 已核实的现状（能力具备、集成未打通）

| 事实 | 位置 |
|---|---|
| 作用域枚举 `personal/project/role/session` | mcp-server.ts:48-53 |
| 召回 SQL 强制按 scope 过滤 | hybrid-retrieval.ts:556-571 |
| 客户端不能在请求体指定 scope/namespace | http-server.ts:313-325（`rejectClientRecallScopeOverride`） |
| HTTP recall 的 namespace 固定为 `config.defaultNamespace` | http-server.ts:1711 |
| recall 已支持 `x-memory-session-id` header | http-server.ts:1712-1740 |
| 可信会话 scope 来源：personal 恒有 + role(persona) + session + project | lifecycle-store.ts:1584-1623 |
| 写入侧可打 `scopeType/scopeKey` | types.ts:94-95 |

### 1.2 两个已知缺口

1. **没有"部门"维度**：可信会话只能给 personal/role/session/project。**决策：部门 = `project` scope**（`scope_type='project', scope_key=<dept_id>`），不改枚举、不加新概念。
2. **没有会话签发接口**：目前"可信会话"是内核内部会话（conversation 体系）派生的。服务端系统（知识库摄取服务）需要一个显式的会话签发 API。

---

## 2. 可信会话协议设计（核心）

### 2.1 生命周期

```
知识库摄取服务                    忆桥内核
   │  POST /api/sessions          │
   │  {scopes:[{type:'project',   │  ← 校验 API token 的授权矩阵
   │   key:'dept-finance'}],      │    （该 token 允许签发哪些 scope）
   │   ttlSeconds:3600}           │  ← 生成 sessionId + 服务端落库
   │ ◄──── {sessionId, expiresAt} │
   │                              │
   │  POST /api/recall            │
   │  x-memory-session-id: xxx    │  ← 服务端从会话表读 scopes
   │  {query:"..."}               │    body 带 scope 仍直接 422
   │ ◄──── 召回结果                │
```

### 2.2 API 契约

```
POST /api/sessions          签发会话
  body: { scopes: [{scopeType, scopeKey}...], ttlSeconds?: number }
  行为：逐项校验 token 授权矩阵 → 全部通过才签发（失败关闭，部分通过不签发）
  返回：{ sessionId, scopes, expiresAt }

DELETE /api/sessions/:id    显式吊销（登出/换部门场景）
GET  /api/sessions/:id      校验与续期查看（不自动续期）

后续所有请求：x-memory-session-id header
```

### 2.3 健壮性要求（不可妥协项）

| # | 要求 | 说明 |
|---|---|---|
| R1 | **失败关闭** | 无会话 / 会话过期 / 会话吊销 → 只按 `personal/self` 召回，绝不放大 |
| R2 | **授权矩阵** | token 与 scope 的签发权限存服务端（`token_scope_grants` 表）；写死在配置文件也行（单机交付），多租户必须落库 |
| R3 | **scope 绑定不可变** | 签发后 scopes 冻结在会话上；部门权限变更=吊销旧会话+签发新会话，杜绝"已签发会话悄悄变权" |
| R4 | **TTL 上限** | 默认 3600s，上限 24h；不提供自动续期（要续期就重新签发，审计面干净） |
| R5 | **审计** | 签发/吊销/每次召回用的 sessionId 全部入审计日志（含 scope 集），事后可回答"谁在什么时候用哪些 scope 查了什么" |
| R6 | **并发上限** | 每 token 活跃会话数上限（默认 32），防会话泛滥 |
| R7 | **写读同源** | 知识库摄取服务 写文档打 scope 用同一授权矩阵校验——能签发 `project:dept-finance` 查询会话的 token，才能往该 scope 写入；避免"写得进、查不到"或反向泄漏 |

### 2.4 与现有 conversation 会话的关系

现有 conversation 体系的 scope 派生（lifecycle-store.ts:1584-1623）**保持不动**——那是聊天客户端路径。新 `/api/sessions` 是服务端路径，两套会话最终汇入同一个召回 scope 过滤器（hybrid-retrieval.ts:556-571），过滤逻辑零改动。

---

## 3. 实施分阶段

| 阶段 | 内容 | 工作量 |
|---|---|---|
| P0 | `POST/DELETE /api/sessions` + 授权矩阵（配置文件版）+ recall 读会话 scope + 测试 | 1-2 天 |
| P1 | 授权矩阵落库 + 会话管理台（列表/吊销）+ 审计报表 | 2-3 天 |
| P2 | LDAP/AD 同步部门→scopeKey 映射（知识库摄取服务 侧或独立同步器） | 视客户环境 |

---

## 4. 明确不做的事

- ❌ 不给 HTTP recall 开 body scope 参数（哪怕带签名）——`rejectClientRecallScopeOverride` 的存在就是这条红线的代码化。
- ❌ 不用 namespace 做部门隔离（HTTP recall namespace 固定，写入到非默认 namespace 的数据 HTTP 查不到——已知陷阱）。
- ❌ 不在 MCP 通道加"部门会话"——MCP 连接级绑定是聊天客户端语义，混入多租户会破坏其安全模型。
