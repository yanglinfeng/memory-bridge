# 术语表

## A–D

### AIRI

忆桥首要适配的 AI 角色桌面应用。它通过 MCP 获取工具，通过忆桥的
OpenAI-compatible Base URL 获得确定性的自动记忆生命周期。

### ANN

Approximate Nearest Neighbor，近似最近邻。忆桥 Dense 检索使用 sign-LSH
bucket 生成候选，再结合其他通道和严格重排。

### Attestation

对数据库关键结构的可信证明。忆桥验证 v26 列、索引、触发器 SQL 和迁移 ledger，
避免只改 schema 版本号伪造可信身份/project 绑定。

### Candidate（候选记忆）

从对话提取但尚未成为规范长期记忆的原子 claim。可能自动提交、进入人工审核、
被拒绝或被 tombstone 阻断。

### Canonical memory（规范记忆）

具有稳定 UUID、规范谓词、当前版本、证据和生命周期状态的长期事实。

### Consolidation（巩固）

把多条相关原子版本生成更紧凑的派生摘要。忆桥要求逐句来源，来源变化后摘要
stale，无支持句 quarantined。

### Dense generation

一套与 embedding 模型、维度、指纹和索引版本绑定的不可变 Dense 索引世代。
状态可以是 building、ready、active、previous 或 failed。

### Dead letter

超过自动重试策略的后台任务故障记录。恢复会创建新 recovery job，旧证据保留。

## E–M

### Embedding

把记忆或查询转换为向量的模型输出。默认模型为 `bge-m3:latest`。

### Evidence（证据）

支持某个 memory version 的原始 turn、摘录或外部 source reference。证据与版本
分离，允许追溯、TTL 和物理清除。

### FTS5

SQLite 全文检索模块，提供词面候选通道。

### Grounding

召回结果到 memory version 和 evidence 的来源映射，说明最终上下文依据什么。

### Idempotency（幂等）

同一请求或任务重放不会产生重复业务结果。忆桥使用 idempotency key、round/role
唯一约束、revision 和稳定 job ID。

### Job lease（任务租约）

Worker 在有限时间内取得任务执行权。进程崩溃后租约到期，其他 Worker 可重放。

### JSONL

每行一个 JSON 对象的日志格式。忆桥可把完成的 retrieval trace 旁路追加到按
日期/大小轮换的 JSONL 文件。

### Lifecycle（记忆生命周期）

AIRI 回答前召回、回答后入账、异步提取、关系解析、版本、巩固、保留和遗忘的
完整流程。

### LSH

Locality-Sensitive Hashing，局部敏感哈希。忆桥使用 sign-LSH 为 Dense 向量产生
近邻 bucket 候选。

### MCP

Model Context Protocol。忆桥用 stdio 暴露七个长期记忆工具；一个 MCP 进程固定
一个 principal。

### Memory Doctor

只读记忆健康检查，报告重复、冲突、孤儿、失效摘要、超大记忆和零结果热点，
不会自动修改数据。

### MRR

Mean Reciprocal Rank，平均倒数排名，衡量第一个正确结果出现得有多靠前。

## N–R

### Namespace

principal 内的逻辑业务分区，也是 shadow/auto 质量门禁和保留策略的维度。它不是
账户安全边界。

### nDCG

Normalized Discounted Cumulative Gain，考虑结果位置和分级相关性的排序指标。

### Outbox

与业务事务同提交的异步意图表。Worker 后续把 outbox 转为可重试任务，避免提交
真相后丢失异步工作。

### Persona

AIRI 角色的稳定身份。显示名可变，安全隔离使用 persona ID；schema 28 绑定同时
包含 principal。

### Principal

本地账户的强安全边界。HTTP 由 Bearer 凭据确定，MCP 在进程启动时固定。

### Project scope

与可信 session project 绑定匹配时可见的记忆作用域。project 归属不能从旧
metadata 或自然语言猜测。

### Purge（物理清除）

显式异步删除正文、证据、索引、关系和受影响派生数据。不同于可恢复软删除。

### Quarantined

内容存在但因缺少来源、质量不可信或异常而隔离，不参与可靠召回。

### Recall

根据 query、principal、namespace 和可见 scopes 生成候选、严格筛选并返回有限
上下文的过程。

### Recall@K

正确目标是否出现在前 K 个结果中的比例。

### Rerank

对融合候选进行严格相关性判断和排序。默认使用 `qwen2.5:14b` 批量输出结构化
相关性结论。

### Revision / Version

Revision 是规范项的并发世代；version 是不可变内容快照。纠正通常保持 UUID 并
增加 revision/version。

## S–Z

### Scope

principal 内的可见范围：personal、project、role、session。相同谓词遮蔽优先级
为 session > role > project > personal。

### Semantic mode

`required` 要求可靠语义链，不可用时明确 abstain；`off` 仅用于受控测试，不是
生产默认。

### Shadow mode

运行提取和质量比较，但不把普通候选自动升级为规范记忆。

### Stable key

规范主体、谓词、scope 等生成的稳定身份键，用于去重和并发一致性；不等于可变
内容哈希。

### Stale

派生内容的来源已变化，当前摘要需要重建，不能按最新真相使用。

### Tombstone

遗忘阻断记录。软删除后立即停止召回，并阻止同义事实被旧任务或旧备份轻易复活。

### Trace / traceId

一次可靠召回的完整诊断链和唯一 ID。它覆盖 request 到 result 九种阶段，但不保证
恰好九条事件：质量补救会在同一个 traceId 中按 attempt 重复 rewrite～selection，
context/result 只写最终一次。

### TTL

Time To Live。可用于证据正文或单条记忆治理，到期行为由保留策略决定，不等于
无审计地直接物理删除。

### Worker

后台任务执行器，处理提取、候选解析、索引、Dense 回填/评测、巩固、保留和
物理清除。

### Zero-result hotspot

在一定时间内频繁产生零结果的 query hash。它是排障信号，负例测试也可能正常
产生，不应自动解释为召回故障。
