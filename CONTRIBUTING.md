# 参与贡献

感谢你愿意参与忆桥（Memory Bridge）。本文档说明环境要求、开发循环和提交约定。

忆桥的定位是**可信层**：回答要带出处、变更要留审计、隔离要经得起检查。这个定位对代码和
文档的要求比一般项目更高——**"看起来对"不算对，要能被复核**。本仓库的评审标准也据此设定。

参与本项目即表示你同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

---

## 1. 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | **≥ 24** | 见 `package.json` 的 `engines`。项目使用 `node:sqlite`，需要该版本提供的稳定实现 |
| Ollama | 任意近期版本 | 默认生成 `qwen2.5:14b`、embedding `bge-m3:latest` |
| Git | 任意 | — |

```bash
ollama pull qwen2.5:14b
ollama pull bge-m3:latest
```

首次索引与重排需要下载/加载模型，机器内存建议 32 GB 以上（14B 模型 + embedding + 重排并发 2）。

可选：启用 Cross-Encoder 重排需额外启动 `sidecar/ce-rerank`（模型权重约 2.1 GB，端口 3798），
见 [sidecar/ce-rerank/README.md](sidecar/ce-rerank/README.md)。不启动不影响主链路。

## 2. 起步

```bash
git clone https://github.com/yanglinfeng/memory-bridge.git
cd memory-bridge
npm install
npm run build
npm start            # HTTP 服务 + 管理台：http://127.0.0.1:3789
```

首次启动是**空记忆库**——没有演示数据，管理台只展示真实写入的内容。

配置方式是环境变量（**不读 `.env` 文件**）。可复制的变量清单见 [.env.example](.env.example)，
完整清单与取值边界见 [配置参考](docs/configuration-reference.md)，默认值的唯一事实源是
`src/server/config.ts`。

## 3. 开发循环

```bash
npm run dev            # 前后端热更新
npm run dev:server     # 只跑后端（tsx watch）
npm run dev:web        # 只跑前端（vite）

npm run typecheck      # 必跑：tsc 双配置校验（前端 + 服务端）
npm run check:docs     # 必跑：文档 ↔ 代码一致性对撞
npm test               # 构建服务端 + 跑全量测试
```

单项测试：

```bash
node --test --import tsx tests/<name>.test.ts
node --test --import tsx --test-name-pattern="关键词" tests/<name>.test.ts
```

本仓库**没有 lint / 格式化配置**。请不要在贡献里顺带引入 ESLint + Prettier 全库重排——那会让
diff 淹没真实改动。风格上跟随周围代码即可。

> `npm test` 会先触发 `pretest`，自动重建 Pinokio bundle（`scripts/build-pinokio-bundle.mjs`）。
> `packaging/pinokio/memory-bridge/bundle/` 是**构建产物，不入库**——它是源码镜像，改动源码后
> 必须由脚本重新生成，不要手改或提交。

### 3.1 关于失败用例

当前全量套件（`npm test`，1043 例）是**全绿**的，没有已知失败。曾经长期挂着的 3 例已结清：

- `tests/database.test.ts` 迁移备份与 `BEGIN IMMEDIATE` 写锁顺序 —— 已修（改为取锁后复检
  数据库文件家族，堵住备份与写锁之间的并发写窗口）
- `npm run test:lifecycle` 的 2 例 doctor —— 经查是 **Node 版本低于 `engines >= 24`** 所致，
  非代码缺陷。跑之前先确认 `node -v`。

所以一旦看到红灯，默认就是你的改动引起的。判断一次失败是否由你的改动引入，**不要只看工作区**
（工作区可能同时有别人的改动）。可靠做法是在改动前的提交上建一份纯净副本复跑同一用例：

```bash
git archive <改动前的完整 SHA> | tar -x -C /tmp/mb-pre
ln -s "$PWD/node_modules" /tmp/mb-pre/node_modules
cd /tmp/mb-pre && node --test --import tsx --test-name-pattern="关键词" tests/<name>.test.ts
```

## 4. 代码约定

**模块边界要写清楚。** 服务端规模较大，`src/server/` 已按职责拆分：存储层 `memory-store*.ts`、
会话层 `conversation-*.ts`、schema 层 `database.ts` + `migrations/` + `schema-sql.ts` +
`schema-*.ts`。新增代码请放进职责匹配的模块，不要在既有大文件里继续堆积。

**Schema 变更必须写成注册式迁移。** 在 `src/server/migrations/` 新增 `vNN-<描述>.ts` 并按版本号
注册；不要修改已发布版本的迁移文件（已部署实例不会重跑它）。每个新版本块开头必须重装
v32/v33/v35/v36 的会话触发器——这是既有约定，漏掉会破坏会话约束。同时更新
`SCHEMA_VERSION`，并同步 `docs/data-model.md` 与 `docs/technical-reference.md`。

**不要动历史文档里的数字。** `docs/acceptance-report-*.md` 与 `docs/prd-*.md` 是**写作时刻的证据
快照**，其中的 627/627、33%、P95 等数字是当时环境的实测记录，有意保留原值。它们不描述当前
代码，也不参与口径对撞。当前口径请写进手册类文档（`docs/*.md` 的其余部分）——判据见
[docs/README.md](docs/README.md)。

**不要主张不可复现的分数。** 评测分数只有在复现脚本与完整条件一并提供时才能写进对外文档；
在此之前，README 与手册不主张任何分数。这是"可信层"定位的一部分。

**安全默认不可放宽。** 涉及 scope、密级、tombstone、证据绑定的代码路径默认 fail-closed。
放宽门槛（环境变量、档位）只能改变资源上限与召回宽严，**不能**改变隔离与证据规则。改这类代码
请在 PR 描述里写清"改变了什么默认、为什么安全"。

## 5. 提交与 PR

提交信息用 Conventional Commits：

```
<type>(<scope>): <subject>
```

- `type`：`feat` / `fix` / `refactor` / `docs` / `test` / `perf` / `chore` / `release`
- `scope`：模块名，如 `store` / `conversation` / `db` / `retrieval` / `mcp` / `docs`
- `subject`：祈使句、不带句号，英文；正文用中文或英文均可

示例：

```
fix(retrieval): 语料域门槛对 filler 条目不生效
refactor(store): extract backup validation cluster into memory-store-backup.ts
docs(api): 补齐 corpusDomain / classification 入库契约
```

提交 PR 前请确认：

- [ ] `npm run typecheck` 通过
- [ ] `npm run check:docs` 通过（若你改了配置项、npm 脚本、HTTP 路由或 schema 版本）
- [ ] `npm test` 没有**新增**失败（对照 §3.1 的已知失败清单）
- [ ] `npm run verify:release-scan` 无阻断项（没把令牌、内网地址、真实业务数据带进来）
- [ ] 若改了数据库结构：迁移可重入、`SCHEMA_VERSION` 已更新、`docs/data-model.md` 已同步
- [ ] 若改了默认值：`docs/configuration-reference.md` 已同步
- [ ] PR 描述里说明了「动机」和「怎么验证」

**纯搬移重构请单独成 PR**，并在描述里说明"零逻辑改写"。评审会按字符级比对验证，混入行为改动
会让重构无法验证。

## 6. 不要提交的东西

`.gitignore` 已覆盖大部分，但请留意：

- 密钥与令牌：`kb-tokens.json`、`*.token`、`*.pem`、`*.key`、`.env`
- 数据库与运行数据：`*.db` / `*.sqlite*`、`data/`、`logs/`
- 构建产物：`dist/`、`packaging/pinokio/memory-bridge/bundle/`
- 本地调研缓存：`.firecrawl/`

发现**已经**被提交的敏感文件，请不要只在本地删除——那不会从历史里移除。按
[SECURITY.md](SECURITY.md) 的方式私下报告，我们会处理历史。

提交前跑一次发布闸门（退出码 0 才算过）：

```bash
npm run verify:release-scan            # 工作区跟踪文件
npm run verify:release-scan:history    # 追加扫描待发布历史
```

> **维护者注意**：本仓库的本地 ref（`dev-history`、`pre-refactor-backup`、`archive/master`、
> codex checkpoint 等）里存在带本机绝对路径的历史提交。它们**不在** `main` 的待发布范围内
> （`--all-refs` 会扫出来），所以 `git push origin main` 是安全的。
> 但 **`git push --all` 与 `git push --mirror` 会把这些内容一并推上去**——发布期请只用
> `git push origin main`。

## 7. 报告缺陷与提需求

| 事项 | 通道 |
|---|---|
| 缺陷 | [Issues · 缺陷报告模板](https://github.com/yanglinfeng/memory-bridge/issues/new?template=bug_report.yml)，请带上复现步骤、`node -v` 与 `npm run doctor` 的输出 |
| 新能力 | [Issues · 功能建议模板](https://github.com/yanglinfeng/memory-bridge/issues/new?template=feature_request.yml) |
| 私有化部署 / 商用授权 / 定制开发 | [Issues · 商业合作模板](https://github.com/yanglinfeng/memory-bridge/issues/new?template=commercial_inquiry.yml) |
| 用法讨论与部署求助 | [GitHub Discussions](https://github.com/yanglinfeng/memory-bridge/discussions) |
| 安全漏洞 | **不要**开公开 Issue，见 [SECURITY.md](SECURITY.md) |

排障顺序：`npm run doctor` → `docs/operator-guide.md` → `docs/logging-guide.md`。

提问前请先跑一次 `npm run check:docs` 与 `npm run typecheck`——很多"文档说的和实际不一致"是
本地分支落后导致的。
