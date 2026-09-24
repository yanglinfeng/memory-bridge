# 安全策略

忆桥（Memory Bridge）是**本地优先**的知识库与记忆引擎。它的安全模型建立在两个前提上：
数据留在本机、隔离在服务端强制。本文档说明怎么报告漏洞、哪些版本受支持、默认边界在哪，
以及在什么情况下部署会失效。

---

## 1. 报告漏洞

**请不要为安全问题开公开 Issue。**

请走 GitHub 的私密报告通道：

1. 打开仓库的 **Security** 标签页 → **Report a vulnerability**（直达 `https://github.com/yanglinfeng/memory-bridge/security/advisories/new`）；
2. 如果该入口不可用，请开一个**不含细节**的 Issue，只说明"有安全问题需要私下联系"，我们会在
   Issue 里换成私密渠道继续。

请尽量附上：

- 受影响版本（`package.json` 的 `version`）与该实例的 `SCHEMA_VERSION`
- 复现步骤，最好是最小可复现的 HTTP 请求或 MCP 调用序列
- 影响判断：是**越权读到不该读的数据**、**写入未授权主体**，还是**拒绝服务**
- 你的部署形态：本机自用 / 内网服务器 / 反向代理

**关于时间表：** 这是一个主要由维护者个人推进的开源项目，**不承诺**具体的响应或修复时限。
我们会尽快确认收到、评估影响，并在修复发布后于 `CHANGELOG.md` 里说明。请避免在修复发布前
公开细节。

## 2. 支持版本

| 版本 | 支持 |
|---|---|
| `1.0.x`（当前） | 是 |
| `1.0.0` 之前 | 否（未公开发布） |

安全修复只对当前小版本发布。若你在用从源码构建的中间提交，请先确认能复现到带 tag 的版本上。

## 3. 威胁模型：忆桥保护什么

**保护对象**（受威胁模型覆盖）：

1. **记忆与文档内容**——防止未授权主体读到不该读的内容；
2. **主体与 scope 绑定**——防止调用方通过参数扩大自己的可见范围；
3. **证据与版本完整性**——防止篡改来源绑定、绕过 tombstone、改绑 version/turn；
4. **审计链**——防止静默修改或删除审计记录；
5. **凭据**——Token 与账户凭据的存储与校验。

**不在威胁模型内**（请自行负责）：

- **已获得本机 root/用户权限的攻击者**。数据库文件与进程内存对他都是可读的。忆桥不防御
  本机提权。
- **被投毒的模型**。Embedding、重排、生成都跑在本机 Ollama / sidecar 上；模型本身被替换或
  被恶意权重污染，忆桥无法检测。
- **上游语料的真实性**。忆桥保证"这段文字确实来自这份文件"，不保证"这份文件说的是对的"。
- **物理接触与磁盘取证**。`secure_delete` 覆写的是 SQLite 层数据，不覆盖文件系统日志、
  APFS 快照或备份介质。

## 4. 默认安全边界

| 项 | 默认 | 说明 |
|---|---|---|
| 监听地址 | `127.0.0.1` | `MEMORY_BRIDGE_HOST` 只接受 `127.0.0.1` / `::1`，其他值回退到 loopback。**不监听局域网/公网** |
| 未认证请求 | `401` | 除健康检查等显式白名单外，`/api` 路由强制鉴权 |
| 匿名通道 | 关闭 | `MEMORY_BRIDGE_ANONYMOUS_MODE=public-readonly` 才开启，且有额外约束（见 §5） |
| 授权矩阵不存在 | 功能关闭 | `session-scope-grants.json` 缺失时，可信会话签发返回 `403`，不是"放行" |
| 越权 scope 申请 | `403` | 签发时按矩阵校验，未授权 scope 直接拒绝 |
| 安全删除 | 开启 | 启动即 `PRAGMA secure_delete = ON`，删除时覆写页 |
| 数据外发 | 无 | Embedding / 重排 / 生成全部走本机，无云服务回退 |
| 检索日志 | `metadata` | 默认只记录元数据；`diagnostic` 会保存脱敏后的查询文本 |
| 自动提交 | `shadow` | `MEMORY_BRIDGE_AUTOMATION_MODE` 默认只产出候选，不自动落库 |

**跨源读取**：服务不返回 CORS 头，管理台与 API 同源提供，因此不依赖 CORS。非预期的跨源读取
由浏览器同源策略挡下。若你把前端反向代理到另一个源，浏览器的保护就不再适用——那是你的部署
决策，需自行处理 CORS、CSRF 与 TLS。

## 5. 多层隔离

忆桥的可见性是**横向 scope × 纵向密级**的正交组合，两个条件都通过才可见：

| 维度 | 机制 | 强制点 |
|---|---|---|
| 横向 scope | `project` / `role` / `session` / `public` | 服务端按可信会话绑定的 scope 过滤，调用方**不能**在 MCP/HTTP 参数里扩大 |
| 纵向密级 | `public` < `internal` < `confidential` | 只返回密级序不高于读者 `clearance` 的行 |
| 部门隔离 | 授权矩阵（主体 → 可签发 scope + clearance） | 签发时校验，矩阵按 mtime 热加载 |

**匿名公开通道的边界**（`MEMORY_BRIDGE_ANONYMOUS_MODE=public-readonly`）：

- 只在**请求源为 loopback** 时把无令牌请求映射为虚拟主体 `@anonymous`；
- `@anonymous` **仅允许召回**（`POST /api/recall`），端点白名单之外一律拒绝；
- 可见范围限定为 `public` scope **且** `public` 密级，两个条件同时满足。

也就是说：把记忆标成 `public` 就等于同意它在匿名通道被读到。**不要把内部资料标成 `public`。**

**永不放宽的闸门**：墓碑（tombstone）、规范值不匹配等确定性弃答规则不受任何档位影响。
`strict` / `balanced` / `eager` 只调整相似度门与填充条数，不改变隔离与证据规则。

配置与签发方式见 [安全与隐私指南 §5.1](docs/security-and-privacy.md)、
[命令参考 §12](docs/command-reference.md)（`npm run kb:provision`）。

## 6. 凭据管理

优先使用**账户凭据**而不是全局 legacy Token：

```bash
npm run identity -- init --display-name YOUR_NAME --label main
npm run identity -- create-principal --display-name ALICE
npm run identity -- issue-token --principal <id> --label laptop --expires-at 2027-01-01
npm run identity -- list-credentials --principal <id>
npm run identity -- revoke-credential --principal <id> --credential <credId> --reason "设备遗失"
```

- `MEMORY_BRIDGE_TOKEN` 是 legacy 全局 Token，**不区分主体**，一旦泄露即全库可达。仅用于
  本机一次性调试；正式环境请吊销并改用账户凭据。
- MCP 的 `MEMORY_BRIDGE_MCP_TOKEN` 只在 stdio 启动时校验，**读取后会从环境变量里删除**，
  避免子进程继承。
- 不要把这些值写进项目文件、截图、日志或 shell 历史。`.gitignore` 已忽略 `kb-tokens.json`、
  `*.token`、`*.pem`、`*.key`、`.env`。

## 7. 部署红线

**不要把忆桥直接暴露到公网。** 它没有面向公网设计：无 TLS 终结、无速率限制、无账户锁定、
无 CORS/CSRF 策略。需要远程访问时，请用 VPN 或带认证的隧道，不要做端口转发。

| 事项 | 要求 |
|---|---|
| 反向代理 | 必须终止 TLS，并自行实现认证与限流；上游仍应是 loopback |
| `MEMORY_BRIDGE_HOST` | 保持 `127.0.0.1`。绕过该限制的部署不属于受支持配置 |
| `diagnostic` 日志模式 | 只在限时排障窗口开启；可能含个人信息 |
| 数据目录权限 | 限本机账户可读（`chmod 700`）；备份文件含密钥材料，同样对待 |
| 备份 | 加密后存放；恢复流程见 [备份与恢复](docs/backup-and-restore.md) |
| 物理清除 | 敏感数据下线用 purge（`secure_delete` 覆写主库与迁移备份），注意它**不可逆** |

## 8. 已知边界与未做

诚实清单——这些是当前的**缺口**，不是承诺：

- 无 AD / LDAP / SSO 对接。组织架构与主体映射需在 `kb:provision` 侧自行维护。
- 无可视化的权限矩阵管理界面，授权矩阵是 JSON 文件。
- 无速率限制与账户锁定，暴力猜 Token 不受节流（loopback 部署下影响有限）。
- 不返回 `Content-Security-Policy` 等安全响应头。
- 流式录入的**结构化提取器**尚未实现，当前是原文片段直存，不做内容安全审查。
- 单机架构：隔离依赖同一进程内的服务端强制，没有跨节点的一致性校验。

发现上述任一被利用的实际路径，仍请按 §1 报告。
