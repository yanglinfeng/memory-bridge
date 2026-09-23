# 命令参考

所有命令默认在项目根 `~/memory-bridge` 执行。正式数据
操作前确认 `MEMORY_BRIDGE_DATA_DIR` 指向正确环境。

## 1. npm 脚本

| 命令 | 作用 | 依赖/说明 |
|---|---|---|
| `npm run dev` | 同时启动服务端 watch 与 Vite | 开发；3789 + 5173 |
| `npm run dev:server` | 仅服务端 watch | `tsx watch` |
| `npm run dev:web` | 仅 Vite 管理台 | 默认 5173 |
| `npm run build` | 构建服务端和前端 | 生成 `dist/` |
| `npm run build:server` | TypeScript 服务端构建 | `tsconfig.server.json` |
| `npm run build:web` | Vite 前端构建 | 生成 `dist/web` |
| `npm run bundle:pinokio` | 从项目 root 原子刷新 canonical Pinokio bundle | 自动排除私有、运行时和测试数据并重算 marker |
| `npm run bundle:pinokio:check` | 只读验证 root 与 canonical bundle 一致 | 不修改 bundle；发布门禁使用 |
| `npm start` | 运行构建后的 HTTP/Worker | 需先 build |
| `npm run mcp` | 源码 MCP stdio | 需固定 principal |
| `npm run mcp:built` | 构建后 MCP stdio | 需先 build、固定 principal |
| `npm run identity -- …` | 身份与凭据 CLI | 默认正式 databasePath |
| `npm run lifecycle:business-hash -- --database FILE` | 只读计算 lifecycle 业务逻辑哈希 | 仅输出计数和哈希；不输出正文、Token 或身份值 |
| `npm run prepare:airi-acceptance` | 创建隔离 AIRI 验收环境 | 正式验收先设置持久私有父目录；不应指向正式 profile |
| `npm run typecheck` | 前后端 TypeScript 类型检查 | 不写构建产物 |
| `npm test` | 构建服务端并运行全自动化 | Node test runner |
| `npm run benchmark:rerank` | 真实模型重排 benchmark | Ollama |
| `npm run benchmark:scale -- --receipt PATH` | 规模 benchmark | 使用隔离数据并原子保存 JSON 回执 |
| `npm run evaluate:dense` | Dense 固定评测 | Ollama embedding |
| `npm run evaluate:retrieval-p1` | P1 检索固定集 | 构建后运行 |
| `npm run verify:dense-switch-rollback` | Dense alias 切换/回滚 | 构建后运行 |
| `npm run evaluate:consolidation-quality` | 巩固质量 | Ollama |
| `npm run evaluate:explicit-correction-quality` | 自然纠正质量 | Ollama |
| `npm run evaluate:namespace-quality` | namespace auto 质量门禁 | 固定 fixtures |
| `npm run evaluate:context-reflection` | 120 查询 + 100 历史窗口质量门禁 | Ollama；可分 section |
| `npm run soak:reliability` | 长时间多会话/Worker 稳定性 | 默认按 PRD 长跑 |
| `npm run verify:crash-recovery` | 崩溃恢复 | 使用隔离子进程/数据 |
| `npm run verify:storage-refinement` | 在显式数据库副本验证冷热精炼、重启和可选 VACUUM | 会修改目标库；禁止指向正式运行库 |

## 2. 安装、构建和启动

```bash
npm install
npm run typecheck
npm run build
MEMORY_BRIDGE_AUTOMATION_MODE=shadow npm start
```

开发：

```bash
npm run dev
```

安全关闭：在前台按 Ctrl-C，或让 supervisor 发送 SIGTERM。服务会停止 Worker、
关闭 HTTP 和 SQLite。

正式 AIRI 验收环境：

```bash
mkdir -p .memory-bridge-private/acceptance
chmod 700 .memory-bridge-private/acceptance
export MEMORY_BRIDGE_ACCEPTANCE_PARENT_DIR="$PWD/.memory-bridge-private/acceptance"
npm run prepare:airi-acceptance
```

该目录已由 `.gitignore` 排除。命令输出的单次 root 会包含 secrets、隔离 profile、
数据库和不可变回执；只允许在受控私有存储中保留。

## 3. Ollama

```bash
ollama serve
ollama pull qwen2.5:14b
ollama pull bge-m3:latest
curl -sS http://127.0.0.1:11434/api/tags
```

如果 Ollama 桌面进程已经监听 11434，不要启动第二个 `ollama serve`。

## 4. 身份 CLI

查看帮助：

```bash
npm run identity -- --help
```

### 初始化首个账户

```bash
npm run identity -- init \
  --display-name "本机主人" \
  --label "AIRI desktop"
```

可选 `--id` 和 `--expires-at ISO`。全库已经签发过凭据后，init 会拒绝重复执行。

### 列出 principal

```bash
npm run identity -- list-principals
```

### 创建额外 principal

```bash
npm run identity -- create-principal \
  --display-name "第二账户"
```

可选 `--id`。

### 签发 Token

```bash
npm run identity -- issue-token \
  --principal ACCOUNT_ID \
  --label "AIRI desktop"
```

可选 `--expires-at ISO`。完整 Token 只在这次 stdout 输出；不要录屏或让 CI 收集。

### 列出凭据

```bash
npm run identity -- list-credentials \
  --principal ACCOUNT_ID
```

只显示不可恢复的 hint，不显示完整 Token。

### 撤销凭据

```bash
npm run identity -- revoke-credential \
  --principal ACCOUNT_ID \
  --credential CREDENTIAL_ID \
  --reason "设备退役"
```

### persona 与账户总览

```bash
npm run identity -- list-personas --principal ACCOUNT_ID
npm run identity -- overview --principal ACCOUNT_ID
```

### 指定隔离数据库

所有身份命令可加二选一：

```text
--data-dir /absolute/path/to/data
--database /absolute/path/to/memory-bridge.sqlite3
```

不要同时传两者。执行签发/撤销前务必确认路径不是正式库的错误副本。

## 5. 安全读取 Token

避免把 Token 直接放进 shell 历史：

```bash
read -s MEMORY_BRIDGE_ACCESS_TOKEN
export MEMORY_BRIDGE_ACCESS_TOKEN
```

粘贴后按 Enter，输入不会回显。

## 6. HTTP 健康检查

```bash
curl -sS http://127.0.0.1:3789/api/health \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
curl -sS http://127.0.0.1:3789/api/system-health \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
curl -sS http://127.0.0.1:3789/api/retrieval-log/health \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
curl -sS -X POST http://127.0.0.1:3789/api/memory-doctor \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sampleLimit":20}'
```

`/api/health` 只证明基础进程；发布判断使用后三个接口和数据库完整性。

## 7. 备份与恢复

```bash
curl -sS http://127.0.0.1:3789/api/export \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN" \
  -o memory-bridge-backup.json

curl -sS -X POST http://127.0.0.1:3789/api/import \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @memory-bridge-backup.json
```

导入是替换当前 principal 状态。详见[备份恢复手册](backup-and-restore.md)。

## 8. 检索 trace

```bash
curl -sS 'http://127.0.0.1:3789/api/retrieval-traces?limit=100&offset=0' \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"

curl -sS "http://127.0.0.1:3789/api/retrieval-traces/$TRACE_ID" \
  -H "Authorization: Bearer $MEMORY_BRIDGE_ACCESS_TOKEN"
```

完整日志命令见[日志查看总览](logging-guide.md)。

## 9. MCP 启动

凭据方式：

```bash
MEMORY_BRIDGE_MCP_TOKEN='mb1.…' npm run mcp:built
```

受信任 principal 方式：

```bash
MEMORY_BRIDGE_USER_ID='stable-principal-id' npm run mcp:built
```

正式客户端应通过安全环境注入，不要把真实 Token 固化到可提交配置。MCP 参数
和客户端 JSON 见[MCP 手册](mcp-guide.md)。

## 10. 验收命令顺序

从便宜到昂贵：

```bash
npm run typecheck
npm test
npm run build
npm run evaluate:retrieval-p1
npm run evaluate:context-reflection -- --validate-fixture
npm run evaluate:dense
npm run benchmark:rerank
npm run benchmark:scale -- \
  --receipt /private/tmp/memory-bridge-scale-schema31.json
npm run verify:dense-switch-rollback
npm run verify:crash-recovery
npm run soak:reliability
```

最后按[AIRI 接入文档](airi-integration.md)执行真实桌面闭环。

## 11. 查询理解与历史重提炼

只校验固定集结构：

```bash
npm run evaluate:context-reflection -- --validate-fixture
```

分开运行并写去正文回执：

```bash
npm run evaluate:context-reflection -- \
  --section query \
  --receipt /private/tmp/query-quality.json

npm run evaluate:context-reflection -- \
  --section reflection \
  --receipt /private/tmp/reflection-quality.json
```

查看双 pipeline 状态和运行：

```bash
curl -sS "$BASE/api/reflection/status?namespace=personal" \
  -H "Authorization: Bearer $TOKEN"
curl -sS "$BASE/api/reflection/runs?limit=20" \
  -H "Authorization: Bearer $TOKEN"
curl -sS "$BASE/api/reflection/runs/$RUN_ID" \
  -H "Authorization: Bearer $TOKEN"
```

预览和排队示例见[HTTP API 第 14 节](api-reference.md#14-上下文理解与历史重提炼接口)。
不要让脚本或 curl 指向正式数据目录；模型评测器会自行创建临时隔离 SQLite，
回执只写到显式 `--receipt` 路径。
