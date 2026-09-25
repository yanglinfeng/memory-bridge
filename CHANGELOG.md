# Changelog

本项目的所有重要变更都记录在此。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

维护约定：

- 面向**使用者**的变更必须在此登记（新增能力、行为变化、默认值变化、破坏性变更、安全修复）。
  纯内部重构、测试增补、文档润色不单独登记。
- 默认值是契约的一部分。**改默认值就是破坏性变更**，必须写进「变更」并在 PR 描述里说明理由。
- 数据库 schema 版本随发布单调递增。破坏性变更须写明迁移方向与是否可回退。

---

## [Unreleased]

### 新增

- `scripts/check-docs-consistency.mjs` 与 `npm run check:docs`：把文档声明的事实与代码实际事实
  机器对撞（schema 口径、环境变量 / npm 脚本 / HTTP 路由覆盖度、文档引用的源码路径存在性、
  配置默认值、合规文件、评测分数残留），失败时退出码为 1，可挂 CI。
- `.env.example`：可复制的环境变量清单，含默认值与加载方式说明。
- `CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`：贡献、安全与行为准则。
- `examples/`：curl / Java / Node 三种接入示例，覆盖写入（含 `corpusDomain` /
  `classification`）、召回与 as-of 查询。
- `BENCHMARKS.md` 与 `benchmarks/`：三套公开可复现的问答基准（CMRC 2018 中文抽取式、
  HotpotQA 英文多跳、自建中文弃答语料），含公共脚手架、官方评分口径与语料生成脚本。
  一键入口 `npm run bench:cn` / `bench:cmrc` / `bench:hotpotqa`，
  语料准备 `npm run bench:prepare`。
- `benchmarks/prepare/prepare-cmrc.py` / `prepare-hotpotqa.py`：从公开数据集现取并生成语料，
  输出 manifest（数据集名、许可、种子、规模、各文件 sha256）。第三方语料**不随仓库分发**：
  其许可（CC BY-SA 4.0）与本仓库不同，只保留生成规则。

### 变更

- `packaging/pinokio/memory-bridge/bundle/` 不再纳入版本控制。它是**源码镜像式构建产物**
  （曾占仓库约三分之一文件量），改动源码后由 `npm run bundle:pinokio` 重新生成；
  `npm test` 的 `pretest` 钩子会在跑测试前自动重建，全新 clone 无需手工处理。
- 对外文档不再主张任何评测分数。在复现脚本与完整条件随 `BENCHMARKS.md` 发布之前，
  README 与手册只描述能力现状；历史验收报告中的数字保持原值，仅作为当时环境的证据快照。
- `npm run check:docs` 的「评测分数残留」判定由「提到数据集名」改为「**分数主张**」：
  同一行同时出现分数形状的数字与（数据集名 或 指标名）才报。命令表里的 `bench:cmrc`
  这类纯命名不再误报——假阳性会让门禁被无视，比不报更糟。同时它开始覆盖此前漏掉的形态
  （带指标名但不带数据集名的表格行）。
- `check:docs` 的白名单不再是免检：列入白名单的文档必须真的带有免责声明，
  否则照旧判失败。这样「把声明删掉」无法静默放行整份文件的数字。

### 修复

- `docs/api-接口文档.md` 头部的「适用版本」声明此前停留在旧版本号上，现更正为当前 schema 版本，
  并补上「历史 schema 号只表示该能力从哪一版引入」的口径说明。
- `docs/developer-guide.md` / `docs/technical-reference.md` 的源文件索引补齐存储层与 schema 层
  拆分出的模块（`memory-store-*.ts`、`migrations/`、`schema-sql.ts`、`schema-migration-ledger.ts`、
  `sqlite-schema-helpers.ts`、`schema-integrity.ts`、`conversation-{types,internals}.ts`）。
- 迁移备份与写锁之间的无锁窗口不再无保护。备份因技术限制必须在 `BEGIN IMMEDIATE` 之前完成
  （第二连接的 `wal_checkpoint(TRUNCATE)` 在主连接持写事务时无法完成），该窗口内的并发写
  本不会被写锁挡住。现于取锁后立即复检数据库文件家族（主库 + `-wal` + `-journal`）的身份，
  发现漂移即 fail-closed 拒绝迁移，避免用过期快照回滚。
  判据必须包含 `-wal`：**WAL 模式下并发写不落主库文件**（实测主库 size / mtime / inode 三项
  全不变，只把 WAL 撑大），只查主库会漏判；`-shm` 因只读访问也会被改写而不纳入判据。
- `supersede` 现在显式写入被取代记忆的 `valid_to`（封口在继任者 `valid_from` 那一刻；
  继任者未声明 `valid_from` 时退回取代时刻）。此前历史窗口只能靠 `hybrid-retrieval` 里
  `status = 'superseded' AND updated_at > ?` 这一条回退判据，而 `updated_at` 是通用列、
  其它写路径也会刷新它，历史窗口会随之漂移。两处取代路径（`remember` 的 `supersedesId`
  与恢复流程的冲突取代）行为现已一致；`memories` 与 `memory_versions` **两张表同时封口**，
  只改一边会让完整备份的逐字段一致性校验失败、导出的备份再也导不回来。
  无法构成合法窗口时（被取代记忆的 `valid_from` 已不早于继任者生效时刻）保持 NULL，
  不回退判据、不钳制出自相矛盾的历史。
- 基准脚手架的四处测量缺陷（都会让跑出来的数字**不成立**，而不只是难看）：
  ① 作答超时未捕获，一次 LLM 超时会崩掉整轮评测 → 改为记为 error 行，续跑自动重试；
  ② 出错题被静默排除、不留计数 → 汇总新增 `errors` / `error_ids`，跑不满一眼可见；
  ③ 条件标注与实际不符（`bench:cn` 写死 `filler=3`，而实际值由弃答档案决定）→ 改为标注档案名；
  ④ HotpotQA 召回口径两头不一致（逐题按全部 gold、汇总按第一条 gold，两跳题会把召回算高一倍）
  → 统一为「全部 gold 的平均」。
- 评测实例现在**钉住模型**（作答请求也带 `keep_alive`）并把语义步预算放宽到 300s。
  原因：实测 Ollama 冷加载 `bge-m3` 要 **85 秒**，而默认预算 120s 会在模型被卸载后
  顶穿 → `provider_transport_error` → 语义链路**静默降级**（`quality=degraded`）
  而指标照常计算。不修的话，跑出来的是「模型加载失败」而不是「检索能力」。
  这是一条**评测条件**，已写进 `BENCHMARKS.md` 并需随数字一起报。

### 已知问题

- 无未决的测试红灯。此前登记的两条已全部收口：

  - 迁移备份的写锁顺序缺口已修（见上方修复条目），守卫测试改为验证新的复检机制。
  - `npm run test:lifecycle` 的 2 例 doctor 失败经查为**运行环境不满足 `engines`**：doctor 的
    `runtime.node` 检查要求 Node ≥ 24，用 Node 22 运行必然判 fail 并连带拉低 `daily.passed`，
    被测的 warn / info 逻辑其实完全正常。换用满足要求的解释器即 **36/36 通过**，非代码缺陷。

---

## [1.0.0] - 待发布

首个公开发布。发布动作：切仓库为 public、打 tag `v1.0.0`、在干净目录 clone 跑通 Quick Start。

### 新增

**检索与问答**

- 全库混合检索：FTS5 词面 + Dense ANN + 概念倒排三通道，不按"最近 N 条"预截断。
- Cross-Encoder 重排：`bge-reranker-v2-m3` 本地 sidecar，按语料域（`policy` / `open` / `chat`）
  分档相关性门槛；sidecar 不可用时显式降级，不静默回落。
- 相关性不足时按粗排分填充（filler），保留多跳证据链。
- 弃答策略：`strict` / `balanced` / `eager` 三档；确定性弃答（墓碑、规范值不匹配）永不放宽。
- 答案工具 `calculator` / `date_diff` / `date_shift`：算术与日期交给代码算。
- bi-temporal 召回：检索窗口同时受 `valid_from` / `valid_to` 约束，支持 as-of 查询。
- 回答前上下文查询理解：代词与省略消歧，带逐字校验与双先行词歧义拒绝。

**接入面**

- 7 个 MCP 工具：`memory_remember`、`memory_recall`、`memory_get_context`、`memory_update`、
  `memory_forget`、`memory_list`、`memory_stats`。
- HTTP API、OpenAI 兼容代理、React 管理台（候选审核、版本证据、召回解释、索引水位、系统健康）。
- 知识库 / RAG 应用层直写通道：`kind=document_chunk` 切片入库，字段级契约见 API 接口文档。
- 可信会话签发与授权矩阵（`MEMORY_BRIDGE_SESSION_GRANTS_FILE`），`npm run kb:provision` 管理。

**记忆治理**

- 自然语言记住 / 纠正 / 遗忘的同步快车道；纠正保持稳定 UUID 并追加版本，遗忘先写 tombstone。
- 跨多轮推断固定进入待确认，无 inference 自动提交开关。
- 非破坏式巩固：来源变化或遗忘后摘要自动失效并可重建。
- 分层情景记忆：L1 情景 / L2 观察 / L4 session-day-week 摘要，逐句来源绑定。
- 默认保留用户数据：无自动衰减、无证据脱敏；要清理须显式配置保留策略。

**多租户可见性（schema 40–44）**

- 横向 scope（`project` / `role` / `session` / `public`）× 纵向密级
  （`public` < `internal` < `confidential`）正交，两个条件都通过才可见。
- 内容出生通道（`origin`）与语料域（`corpus_domain`）分档。
- 匿名公开读通道：loopback + 仅召回 + 仅 `public` scope 与 `public` 密级。

**工程底座**

- SQLite（`node:sqlite`）+ outbox / jobs：租约、重试、dead letter、崩溃重放、幂等执行。
- 全操作审计 + 检索 JSONL 日志（元数据 / 诊断分级、脱敏、轮转、保留清理）。
- Memory Doctor 只读体检：重复、冲突、孤儿、失效摘要、超大记忆、零结果热点。
- 模型全可配置，默认全程本机 Ollama，无需云服务。

### 已知限制

- 无 AD / LDAP / SSO 对接；无可视化权限矩阵界面（授权矩阵为 JSON 文件）。
- 无速率限制与账户锁定；不返回 CSP 等安全响应头。
- 流式录入的结构化提取器未实现（当前为原文片段直存）。
- 批量写入吞吐受本机模型进程限制，批量接口未上线。
- 不提供文档解析：推荐接 RAGFlow / Docling 等上游，忆桥专注其上的可信层。
