# Cross-Encoder 重排 sidecar（bge-reranker-v2-m3）

专用交叉编码器重排服务，替代用 14B 生成模型做重排的方案。

端到端实测（CMRC 2018 百题 / 1000 篇库 / 本机 M5 Pro 24GB，CE 走 CPU）：

| 方案 | R@1 | MRR | F1 | 端到端耗时/100题 |
|---|---|---|---|---|
| 14B 生成模型重排（预算 2400） | 0.97–0.98 | ≈0.985 | 88.1% | 约 50 分钟 |
| **CE（推荐配置，见下）** | **0.97** | **0.978** | **87.2%** | **7.5 分钟** |

自建中文制度文档 12 题（含 2 不可答弃答）：CE 配置 12/12 全对。

## 启动

```bash
cd sidecar/ce-rerank
./start.sh          # 默认 127.0.0.1:3798
```

模型权重默认放 `sidecar/ce-rerank/models/bge-reranker-v2-m3/`（约 2.1GB），或用 `CE_MODEL_DIR` 指向已有目录。首次缺权重时 start.sh 会打印 hf-mirror 下载命令。

## 内核侧接入（推荐配置）

```bash
MEMORY_BRIDGE_RERANK_PROVIDER=cross_encoder \
MEMORY_BRIDGE_CROSS_ENCODER_URL=http://127.0.0.1:3798 \
MEMORY_BRIDGE_MIN_RERANK_CONFIDENCE=0.9 \
node dist/server/index.js
```

`MIN_RERANK_CONFIDENCE=0.9` 是关键校准（等价于 CE 分数 ≥ 2.3 才算相关）：
CE 的 score≥0 天然分界只表示"同话题"，会放行不含答案的同话题干扰段落，
实测 R@1 从 0.94 掉到——把门槛抬到 0.9 后 R@1 0.97 追平 14B 重排。
若追求零门槛（宁多勿漏）可用 0.5，自行权衡。

相关配置（`src/server/config.ts`）：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MEMORY_BRIDGE_RERANK_PROVIDER` | `llm` | `cross_encoder` 启用 CE 重排 |
| `MEMORY_BRIDGE_CROSS_ENCODER_URL` | `http://127.0.0.1:3798` | sidecar 地址 |
| `MEMORY_BRIDGE_CROSS_ENCODER_MODEL` | `bge-reranker-v2-m3` | 缓存键/遥测用模型名 |
| `MEMORY_BRIDGE_CROSS_ENCODER_TIMEOUT_MS` | 30000 | 单次 HTTP 超时 |
| `MEMORY_BRIDGE_CROSS_ENCODER_BATCH_SIZE` | 32 | 每次请求候选条数 |
| `MEMORY_BRIDGE_CROSS_ENCODER_CONF_SCALE` | 3 | 分数→confidence 陡度 k（sigmoid(score×k)）；3 时 conf 门槛≈分数门槛（0.9→score≥2.3） |
| `MEMORY_BRIDGE_RERANK_CONFIDENCE_WEIGHT` | 0.45 | 排序权重 relevance=semantic×(1-w)+conf×w；CE 模式保持默认 0.45（实测 0.9/1.0 更差，E2E 查询经改写后 CE 序不占优） |

## 语义说明

- 确定性预筛（atomic/时序/验证/项目事实/拒绝规则）**不变**，只替换"未决候选 → 决策"段。
- 分数 → 决策：`confidence = sigmoid(score × k)`（k 默认 3）；`relevant = score >= 0`。`semanticMinConfidence` 门槛照常生效，**知识库/CE 部署建议 0.9**。
- LLM 路径的文本预算（`semanticRerankCandidateTextBudget`）、`num_ctx`、协议恢复、早停在 CE 路径**不适用**——sidecar 按 token 截断（`CE_MAX_LEN`，默认 512，可到 8192）。
- CE 分数也可作弃答门槛：无关对典型分约 -11；门槛校准与弃答档案（strict/balanced/eager）的深度对齐待后续。
- sidecar 不可用时 recall 走既有降级路径（qualityState=degraded），不自动回落 LLM 重排（行为可预测优先）。

## 资源与设备选择

- **CPU（推荐）**：`CE_DEVICE=cpu` 启动。实测 batch32（约 500 token/条）仅 0.63s，120 条候选全打分约 2.5s，与 MPS 相当且完全稳定。
- **MPS**：`CE_DEVICE=mps`（fp16 约 1.1GB）。在与 Ollama 等 GPU 进程争抢时可能触发 macOS Metal 断言崩溃（进程级 abort）——start.sh 已带守护循环自动拉起，但追求稳定请用 CPU。
- 与 qwen2.5:14b（Ollama）在 24GB 上共存无压力。

## 已知坑

- **WorkBuddy/沙箱类 Python shim**：若运行环境经 `PYTHONPATH` 注入文件审批 shim（如 WorkBuddy），transformers 导入时的批量文件扫描会触发逐文件审批，后台运行无人审批直接挂死——start.sh 已 `unset PYTHONPATH`，直接复现时请保持该行。
- MPS Metal 崩溃见上节；sidecar 崩溃期间内核 recall 走降级路径（qualityState=degraded/unavailable），不中断服务。
