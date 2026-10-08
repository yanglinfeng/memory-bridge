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

## [1.0.0] - 2026-10-08

首个公开发布。发布动作：切仓库为 public、打 tag `v1.0.0`、在干净目录 clone 跑通 Quick Start。

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
- `npm run verify:release-scan` / `verify:release-scan:history`：发布前敏感信息预检。
  扫工作区跟踪文件与待发布历史里的本机绝对路径、用户名、私钥、API 密钥、Bearer 令牌、
  内网地址、真实邮箱，并检查敏感文件是否被跟踪；退出码 0/1 可直接接进发布流程。
  占位值与测试哨兵值降级为「已豁免」但**仍然全部打印**——扫描器上的静默丢弃等价于假阴性。
- `.github/ISSUE_TEMPLATE/`：缺陷报告、功能建议、商业合作（私有化部署 / 商用授权 / 定制开发）
  三张结构化表单，配套 `config.yml` 把 Discussions 与 Security 通道前置并关闭空白 Issue；
  `.github/PULL_REQUEST_TEMPLATE.md` 把四项发布前自查写进模板。
- 记忆**列表、详情与导出**响应新增 `stableKey` 字段。该键存放于身份层 `memory_items`，
  此前响应里完全没有，下游做幂等与版本演进只能退化成按 `title` 匹配。未显式指定键时
  内核自动生成 `explicit:<uuid>`，因此该字段在真实数据里不为 `null`。
- `server.json` 与 `glama.json`：面向 MCP 官方 Registry 与 Glama 目录的分发元数据
  （server 名、npm 包标识、stdio 传输、环境变量；Glama 的维护者声明与分类）。
  其中环境变量声明补齐了启动必需的 `MEMORY_BRIDGE_USER_ID`（`isRequired`）与
  `MEMORY_BRIDGE_MCP_TOKEN`——MCP 进程在两者都缺时直接拒绝启动，此前的声明会导致
  照它配置的客户端一启动就失败。
- `Dockerfile` 与 `.dockerignore`：两阶段容器镜像。构建阶段 `npm ci` + `npm run build`，
  运行阶段只保留 `--omit=dev` 依赖（编译产物实际只依赖 `@modelcontextprotocol/sdk` 与
  `zod`）与 `dist/`。默认入口是 stdio MCP；HTTP 模式把 CMD 换成 `dist/server/index.js`。
  镜像内置 `MEMORY_BRIDGE_USER_ID=default`（否则 MCP 启动即失败）与指向宿主机的
  `MEMORY_BRIDGE_OLLAMA_URL`。**容器约束**：服务只监听回环地址，容器内 HTTP 模式不能用
  `-p` 端口映射（映射到的是容器自己的回环），须改用 `--network host`；Ollama 不在镜像内；
  数据目录必须挂卷。

### 变更

- npm 包名定为 `mcp-memory-bridge`（不带 scope）。原候选 `memory-bridge` 在 npm 上已被
  一个无关项目占用；改用无 scope 名后无需注册 scope 账号，官方 Registry 的归属校验由
  `mcpName`（`io.github.yanglinfeng/mcp-memory-bridge`）承担。同时补 `bin`
  （`mcp-memory-bridge` 与 `memory-bridge` 两个命令名均指向 `dist/server/mcp-stdio.js`，
  该入口补了 shebang）与 `files` 白名单。
  **白名单是必需的**：此前 `npm pack` 一个 `dist/` 产物都不含（包装上根本跑不起来），
  却把 `src/`、`tests/`、`scripts/`、`benchmarks/` 一起打了进去（约 360 个文件）；
  现在只发 `dist/`、`docs/`、`examples/`、`sidecar/` 与根级说明文件（约 275 个）。
- npm 包名改名不影响 MCP 工具名（`memory_remember` 等 7 个不带包名前缀）、环境变量名
  或数据库文件名，但**会**影响两处打包侧的所有权校验，已一并修正：`EXPECTED_PACKAGE`
  常量此前同时承担「package.json 的 name」与「HTTP `/api/health` 的 service 身份」两个
  语义，改名后 `npm run bundle:pinokio`（`npm test` 的 `pretest` 钩子）与生命周期用例会
  直接失败。现拆成 `EXPECTED_PACKAGE`（校验包名，随包名变化）与
  `EXPECTED_SERVICE_IDENTITY`（校验服务身份，固定 `memory-bridge`），后者对应
  `src/server/http-server.ts` 里硬编码的 service 字段，是协议契约，不随包名走。
- **升级提示**：改包名后需先删除 `packaging/pinokio/memory-bridge/bundle/`（构建产物，
  已被 `.gitignore`）再重建。该目录的 canonical marker 记录了包名，旧 marker 会让重建
  被所有权校验拒绝（这是防误删保护，不是缺陷）。全新 clone 不受影响。

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
- **中文短查询此前在词法通道静默空转**。FTS5 表用 `tokenize='trigram'`，而查询词按 3-gram
  生成，于是压缩后不足 3 字的查询——中文两字词（`差旅` / `补贴`）与两字母缩写（`AI`）——
  一个 FTS 词都取不到，整条词法通道返回空，只能靠概念倒排通道兜底。活库实测 8 条中文查询
  有 7 条词法命中为 0，且**不报错**，属于最难发现的一类。现改为按词切分生成查询计划
  （Node 内置 `Intl.Segmenter`，零新增依赖）：长度 ≥3 的词仍走 FTS 短语并保留 bm25 排序，
  两字中文词与短缩写改走基表子串匹配（trigram 索引做不到这件事）。修后同类查询 8/8 全部命中。
- **管理台登录门反复重挂载，第一次打开几乎不可用**。`/api/health` 匿名返回 200 会撤下登录门，
  受保护组件随即以无令牌状态发请求收到 401，于是又挂回登录门——形成「撤门 → 401 → 挂门 →
  health 200 → …」的循环，且用户刚输入的令牌会被每次 401 回调清掉。实测旧构建 8 秒内刷出
  **8836 次 401**。现把门闩逻辑抽成显式状态机：唯一判据是 `/api/identity` 是否 401，503 表示
  该实例未启用身份服务、不拦人；连通性探针只驱动状态指示灯，不再参与登录态判定。
  复测 401 稳定在 4 次、登录后为 0。
- 文档与协作事实对齐：`CONTRIBUTING.md` §3.1「已知失败用例」清单已过时（全量套件现为全绿，
  1 例已修、2 例是 Node 版本低于 `engines` 所致），改为如实说明；README 两个语言版本与
  `CONTRIBUTING.md` 补齐对外联系入口；§6 记入发布期操作禁忌——本地 `dev-history` /
  `pre-refactor-backup` / `archive/master` 等 ref 含有本机绝对路径的历史，不在 `main` 的
  发布范围内，但 `git push --all` / `--mirror` 会把它们推出去。

### 已知问题

- 无未决的测试红灯。此前登记的两条已全部收口：

  - 迁移备份的写锁顺序缺口已修（见上方修复条目），守卫测试改为验证新的复检机制。
  - `npm run test:lifecycle` 的 2 例 doctor 失败经查为**运行环境不满足 `engines`**：doctor 的
    `runtime.node` 检查要求 Node ≥ 24，用 Node 22 运行必然判 fail 并连带拉低 `daily.passed`，
    被测的 warn / info 逻辑其实完全正常。换用满足要求的解释器即 **36/36 通过**，非代码缺陷。

### 核心能力

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
