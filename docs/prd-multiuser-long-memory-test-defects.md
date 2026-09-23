# 多账号、多角色长期聊天验收缺陷 PRD

## 1. 文档状态

- 状态：`READY FOR DEVELOPMENT`
- 创建日期：2026-08-09
- 测试对象：Memory Bridge schema 28
- 模型：`legacy local generation model`、`bge-m3:latest`
- 发布结论：`FAIL`；P0 修复前不得宣称多角色长期记忆可发布
- 实现边界：本 PRD 只描述长记忆项目缺陷，不要求修改 AIRI/宝豆客户端

## 2. 验收背景与边界

目标是验证长记忆服务能否支持宝豆的核心承诺：同一设备上的多个账号、同一账号的多个角色和多个项目经过持续自然聊天后，能够跨会话、跨进程准确记忆，且不会串账号、串角色或串项目。

本轮使用独立数据库和独立端口，未触碰正式数据：

- 隔离服务：`http://127.0.0.1:3791`
- 隔离根目录：`/var/folders/cr/7qdkldp94bz2xtltrk5h_6y80000gn/T/memory-bridge-airi-final-v28.eYBqjH`
- 正式 `3789` 服务及正式数据库：未修改
- 测试身份：Alice、Bob 两个 credential principal
- 测试角色：`alice-star`、`alice-ink`、`bob-boat`、`bob-pine`
- 测试项目：`alice-starport`、`alice-morningboat`、`bob-greenmist`、`bob-northlight`
- 真实聊天请求：50 次，其中首轮 41 次、重启后探针 9 次
- 直接 MCP 调用：10 次，另有独立语义 MCP 重启/纠正/遗忘回归

### 2.1 总体结果

- 首轮长聊：28 项检查，26 PASS、2 FAIL。
- 服务重启后：9 项检查，6 PASS、3 FAIL。
- 两轮合计：37 项检查，32 PASS、5 FAIL；失败归并为 3 个独立缺陷族。
- SQLite `integrity_check=ok`，外键错误 0，未完成 outbox 0，异常 job 0。
- 已通过：账号隔离、项目隔离、自然纠正、自然遗忘、跨进程持久化、累积个性化建议。
- 未通过：角色隔离、带条件个人事实召回、严格重排负例安全性。

### 2.2 权威证据

- 首轮报告：`<隔离根目录>/receipts/multiuser-long-chat.json`
- 重启报告：`<隔离根目录>/receipts/restart-persistence-probe.json`
- 可重复脚本：`scripts/qa-multiuser-long-chat.mjs`
- 重启探针：`scripts/qa-restart-persistence-probe.mjs`
- 独立语义 MCP：`scripts/verify-semantic-mcp.mjs`

报告和数据库可能包含测试对话，不得复制到正式库或提交原始 credential。`acceptance-secrets.json` 只允许 mode 0600 本地读取，任何日志、PRD、提交和截图都不得包含原始 Token。

## 3. 缺陷总表

| ID | 优先级 | 缺陷 | 稳定性 | 主要影响 |
|---|---|---|---|---|
| LM-P0-001 | P0 | 角色限定记忆被保存为 `personal/self`，跨角色泄漏 | Alice、Bob 均复现；重启后仍复现 | 隐私边界、角色人格完整性 |
| LM-P1-002 | P1 | 时间/场景限定提取丢失，正确个人记忆被重排拒绝 | 同一问句两轮均复现 | 记得但答不出，破坏“越用越懂” |
| LM-P1-003 | P1 | 遗忘后无关 Dense 候选被严格重排误判为相关 | 独立临时库连续两次复现 | 无关记忆污染回答、遗忘回归不可靠 |
| LM-P1-004 | P1 | 非敏感稳定偏好提取任务成功但零候选、零记忆 | schema 31 真实 iPhone 生命周期复现 | 说了也不记得，核心自动记忆静默失效 |

---

## 4. LM-P0-001：角色限定记忆跨角色泄漏

### 4.1 用户影响

用户明确说“只在某个角色聊天时使用”的称呼或互动规则，会被另一个角色读取。对陪伴型应用而言，不同角色可能承担恋人、朋友、工作助理、老人照护等完全不同关系；串角色不仅破坏沉浸感，也可能把敏感称呼和私人倾诉暴露给不应看到的角色。

### 4.2 复现条件

1. 同一 principal 下至少有两个可信 persona。
2. namespace 处于自动记忆模式。
3. 使用真实提取、巩固、Dense 和重排模型。

### 4.3 复现步骤 A（Alice）

1. 在 `personaId=alice-star` 的会话中发送：`只在和星璃这个角色聊天时，请叫我小枫；我难过时先让我把话说完。`
2. 等待提取、解析、索引和巩固队列为空。
3. 新建 `personaId=alice-ink` 会话。
4. 询问：`星璃那个角色平时怎么称呼我？`
5. 重启 Memory Bridge，使用新 session 重复第 4 步。

### 4.4 实际结果

- 首轮回答：`根据不可信的记忆数据，你与星璃聊天时应被称作“小枫”。`
- 重启后回答：`星璃平时会叫你“小枫”。`
- 原子记忆 `afe29865-4505-4bc7-9ddc-ab1fc1c45485` 被保存为：
  - `scope_type=personal`
  - `scope_key=self`
  - 内容：`只在和星璃这个角色聊天时叫我小枫`
- 派生摘要 `c40576b2-7118-43cc-a0fb-9dd3290586ce` 同样位于 `personal/self`，并混入墨言与星璃两个角色的规则。
- 重启后 trace `cbd6ed58-1672-4d73-83f6-40da4ba8635c`：
  - 候选生成包含上述原子记忆；
  - 重排判定 `relevant=true, confidence=1`；
  - `scopeSuppressedCount=0`；
  - context 实际注入该 memory ID。

### 4.5 复现步骤 B（Bob）

1. 在 `personaId=bob-boat` 中发送：`只在和小舟这个角色聊天时叫我阿北，聊天语气可以轻松一点。`
2. 在 `personaId=bob-pine` 新会话询问：`小舟那个角色平时怎么称呼我？`

实际结果：Bob 的角色限定记忆 `cc197db1-6d4c-48cb-a658-59a0b61849f6` 也被保存为 `personal/self`；重启后 trace `f86e820c-493f-4f8e-b951-dc1fa789e7bd` 将其注入 `bob-pine`，回答泄漏“阿北”。派生摘要 `56078ca2-8f80-4b3e-aa0a-8a912ec32c77` 也在 personal 作用域内混合角色规则。

### 4.6 期望结果

- 明确包含“只在/仅在某角色”的事实必须保存到规范化的 `role/<persona_id>`。
- 当前角色以可信 session/persona 绑定为准，不能把自然语言角色名直接当作安全边界。
- 无法把自然语言角色名解析到可信 persona 时必须 fail closed：进入 quarantine/待确认，绝不能扩大为 `personal/self`。
- 其他 persona 的候选生成阶段就不应看到该记录；不能依赖回答模型自行保密。
- 派生摘要不得跨 access scope 合并，也不得把窄作用域扩大成 personal。

### 4.7 根因方向

重点检查：

- `src/server/memory-extractor.ts`
  - `normalizeScope()` 只拿候选文本和 turn content，缺少可信 session `persona_id`。
  - 不合法或无法匹配的 role scope 当前会回落到 `personal/self`，这是安全边界扩大。
  - 提取提示要求复制自然语言角色名，但运行时检索使用的是稳定 persona ID，两者没有规范映射。
- `src/server/airi-memory-lifecycle.ts`、`src/server/memory-worker.ts`
  - session 已保存可信 `persona_id`，但提取/解析链没有把该身份作为不可伪造的 scope 上下文传到底层。
- `src/server/memory-consolidator.ts`
  - 巩固会沿用源记忆的 access scope；一旦原子记忆误标为 personal，错误会被派生摘要放大并混合。

### 4.8 修改要求

1. 为提取任务附带服务端读取的 `principal_id`、`persona_id`、`project_id`、`session_id`，不得接受模型或请求正文覆盖。
2. 增加确定性的 role-only 语义识别。出现“只在/仅在/和某角色时”等排他限定时，候选不得为 personal。
3. 建立自然语言角色名到 canonical persona ID 的可信映射；没有映射时 quarantine，不得猜测或降级成 personal。
4. `normalizeScope()` 的降级策略改为“不确定即拒绝/隔离”，禁止窄作用域向宽作用域自动扩大。
5. 巩固前校验所有 source 的 access scope 完全一致；输出 scope 必须等于源 scope，禁止 widen。
6. 提供 schema 28 存量修复工具：
   - 扫描内容包含排他角色限定但 scope 为 personal 的原子记忆和派生摘要；
   - 基于原始 evidence 所属 session 的可信 persona 重新提取/迁移；
   - 多 persona 或证据不唯一时 quarantine；
   - 失效并重建受影响摘要、索引和关系边。
7. Memory Doctor 新增 `role_constraint_in_personal_scope` 和 `mixed_role_consolidation` 检查。

### 4.9 自动化回归测试

- 提取单测：当前 persona 为 `alice-star`，输入“只在和星璃这个角色聊天时叫我小枫”，结果必须是 `role/alice-star`。
- fail-closed 单测：文本指定未知角色或同时指定两个角色，结果必须 quarantine/无候选，不能 personal。
- 生命周期集成：同 principal 的 persona A 写入后，persona B 的 channels 阶段不得出现该 memory ID。
- 双账号同名 persona：Alice/Bob 使用相同角色显示名时仍按 principal 隔离。
- 巩固单测：不同 role access scope 的 source 永不进入同一摘要。
- 数据迁移测试：错误 personal 原子记忆、摘要、索引和关系引用被一致重建，SQLite/FK/ledger 保持健康。
- 真实模型 E2E：Alice/Bob 各两个角色，服务重启前后各重复 20 次负例查询，泄漏次数必须为 0。

### 4.10 验收标准

- P0 自动化和真实模型 E2E 全部通过。
- 数据库不存在“排他角色限定 + personal/self”的 active 记录。
- trace 中其他 persona 对该记忆的 `candidateIds`、`resultIds` 和 `injectedMemoryIds` 均不包含目标 ID。
- Memory Doctor 两项新增检查均为 0。
- 存量迁移可重复运行且幂等，不丢失原始 evidence。

---

## 5. LM-P1-002：条件丢失导致正确个人记忆召回假阴性

### 5.1 用户影响

系统数据库里确实有用户信息，但面对自然问法答不出来。该问题会让用户感觉“说了也白说”，直接破坏长期陪伴产品“越用越懂你”的核心体验。

### 5.2 复现步骤

1. Alice 在自然聊天中说：`早上还是桂花乌龙，这个习惯在工作日也一样。`
2. 等待队列完成。
3. 在同 principal 的另一个角色、新 session 中询问：`我工作日早上一般喝什么？`
4. 重启服务后再次使用新 session 询问同一问题。

### 5.3 实际结果

- 两轮回答均未提到“桂花乌龙”，而是泛化成“咖啡或茶”。
- 原始 evidence 完整保留了“早上”和“工作日”：
  - turn ID：`5b772136-18bb-4344-bba7-9ddc4f2ada64`
  - 原文：`早上还是桂花乌龙，这个习惯在工作日也一样。`
- 规范记忆 `673f4384-3012-448e-85ab-62cbdb01f523` 丢失了条件：
  - `predicate_key=用户::主要饮品`
  - `normalized_value=桂花乌龙`
  - 内容：`用户/主要饮品/桂花乌龙`
- 首轮 trace `080e5a98-b06f-4170-9524-3cc96d7375dd` 和重启后 trace `6d61f052-5552-49f9-91f0-27fbcbae6e79` 一致：
  - channels 均把该记忆列为第一候选；
  - semantic 阶段通过；
  - `legacy local generation model` 重排以 `confidence=1` 判定不能直接回答；
  - result/context 最终为 0 条。

### 5.4 期望结果

- “工作日”“早上”必须作为事实条件持久化，不能在原子化时丢失。
- 对“我工作日早上一般喝什么”应稳定召回“桂花乌龙”。
- 个人事实仍应在同 principal 的不同角色间可用，但不得跨账号。
- 如果旧记录缺少足够限定，不应猜答案；系统应能利用原 evidence 重建合格记录。

### 5.5 根因方向

- `src/server/memory-extractor.ts` 的提示已经要求保留条件，但当前结构化结果把“工作日早上”压缩掉，缺少确定性校验。
- 当前原子结构只有 subject/predicate/value，时间或场景限定没有独立、可校验的规范字段，模型漏掉条件后仍能通过 schema。
- `src/server/semantic-ranker.ts` 正确把不完整记忆判为无法直接回答，但决策只有二元 index，并把每个决策的 confidence 硬编码为 1，无法区分模型不确定与确定不相关。

### 5.6 修改要求

1. 原子 claim 增加可规范化的条件表达，至少覆盖时间、频率、场景和否定；可以扩展 schema，也可先把条件强制编码进 normalized value，但必须结构化可校验。
2. 增加 evidence coverage guard：sourceExcerpt 中存在“工作日/早上”等条件 token，而候选未保留时，候选不得进入 resolver，应重试提取或 quarantine。
3. 关系解析和 stable key 必须区分“早上饮品”“工作日早上饮品”“一般饮品”，避免错误合并或覆盖。
4. 查询改写必须保留“工作日 + 早上”两个条件，trace 中可核验。
5. 重排输出增加真实置信度或可解释分类，不得对所有模型选择/拒绝统一写死 `confidence=1`。
6. 提供存量 evidence 重提取流程，修复条件已保留在 turn、但 canonical memory 丢失条件的记录。

### 5.7 自动化回归测试

- 提取：`早上还是桂花乌龙，这个习惯在工作日也一样` 的候选必须保留两个条件。
- 原子化：同一用户“周末早上喝豆浆”和“工作日早上喝桂花乌龙”必须并存，不冲突覆盖。
- 检索：工作日查询只返回工作日事实；周末查询只返回周末事实。
- 跨角色正例：personal 条件事实在同 principal 的 persona A/B 均可召回。
- 跨账号负例：Bob 不得召回 Alice 的条件事实。
- 真实 `legacy local generation model` 回归固定包含本轮问句，连续 10 次结果均包含“桂花乌龙”。

### 5.8 验收标准

- canonical memory 或其结构化 qualifier 能完整表达“工作日早上”。
- channels、semantic、rerank、selection、context 九阶段均可看到正确记忆通过。
- 重启前后新 session 均准确回答“桂花乌龙”。
- 不引入周末/下午等相邻条件的错误召回。

---

## 6. LM-P1-003：遗忘后无关候选误召回

### 6.1 用户影响

目标记忆虽然已正确遗忘，但检索会拿一条仅共享“精炼/回答”表面词义的无关项目记录补位，导致回答被无关记忆污染。用户会看到“已经忘了目标，却又想起了不相干内容”。

### 6.2 独立复现步骤

运行：

```bash
node scripts/verify-semantic-mcp.mjs
```

脚本在全新临时数据库中：

1. 写入偏好：`用户回答偏好是简洁直接。`
2. 写入干扰项：`精炼版项目总结已经归档。`
3. 验证初始召回和跨进程召回。
4. 把偏好纠正为详细回答。
5. 遗忘该偏好。
6. 再问：`用户偏好回答简洁还是详细？`

### 6.3 实际结果

- 目标偏好 tombstone 生效，不再返回。
- 无关干扰项被返回，断言 `forgotten.memories=[]` 失败。
- 该问题在两个独立临时库中连续两次复现，不是隔离长聊数据库污染。
- 最近一次证据：
  - 干扰 memory ID：`4ceb9862-9380-4c94-a19d-81f19e5d5bf3`
  - trace ID：`b17d1c8e-bb4d-4b19-9f47-5605851a9921`
  - semantic similarity：`0.4865`
  - lexical rank：`null`
  - term rank：`null`
  - ANN rank：`1`
  - rerank confidence：`1`
  - 最终 score：`0.7656`

### 6.4 期望结果

- 目标 tombstone 后返回空记忆和“没有找到”上下文。
- “项目总结已经归档”不能回答“用户偏好回答简洁还是详细”。
- 零召回是合法结果，系统不得为了避免空结果而接纳主题相近但主体/谓词不匹配的候选。

### 6.5 根因方向

- `src/server/semantic-ranker.ts` 虽有负例提示，但 `legacy local generation model` 仍把“精炼版项目总结”误判为可回答“回答偏好”。
- `RERANK_FORMAT` 只返回相关 index，没有模型置信度、主体、谓词或蕴含证据；代码随后把 confidence 统一设为 1。
- Dense-only、低至中等相似候选在没有 lexical/term 支持时，只要模型误选就可获得很高最终分数。
- tombstone 过滤本身工作正常；不得通过放宽 tombstone 或恢复已删除目标来掩盖问题。

### 6.6 修改要求

1. 保留 tombstone 的 fail-closed 过滤，不允许 deleted/inactive 目标重新参与召回。
2. 重排结果必须携带并校验：主体匹配、谓词匹配、是否能直接蕴含答案、模型置信度；不能只返回 index。
3. 增加确定性主体/谓词一致性门：查询用户偏好时，项目文件状态、教程、公司或设备事实不得通过。
4. 对 Dense-only 且无 lexical/term/graph 支持的候选设置更严格的接纳条件；允许返回空结果。
5. 将本轮干扰对加入固定负例集和真实模型门禁，不能只做 mock prompt 断言。
6. trace 中区分“模型选择”“确定性约束拒绝”和“置信度不足”，便于诊断。

### 6.7 自动化回归测试

- `verify-semantic-mcp.mjs` 必须恢复通过，且测试保留原干扰句。
- 新增至少 20 组主体相近、关键词重叠但谓词不一致的 hard negatives。
- 覆盖纠正前、纠正后、遗忘后和进程重启后四个阶段。
- `legacy local generation model` 固定 seed 在全新临时库连续运行 10 次，误召回次数必须为 0。
- 单测确认 deleted/inactive 目标不会被任何 channel、graph 或 consolidation 重新带回。

### 6.8 验收标准

- 遗忘后 `memories=[]`，context 明确“没有找到”。
- 干扰项不得出现在 `resultIds` 或 `injectedMemoryIds`。
- 九阶段 trace 能证明目标 tombstone 被过滤、干扰项被主体/谓词或严格重排拒绝。
- 连续 10 次真实模型回归通过。

---

## 7. LM-P1-004：稳定偏好提取静默假阴性

### 7.1 用户影响

用户自然表达明确、非敏感且稳定的个人偏好，聊天回复正常、回合和提取任务也都显示成功，
但系统没有生成任何候选或规范记忆。该缺陷不会向用户显示错误，最容易形成“聊了很久却没有
越来越懂我”的静默失败。

### 7.2 复现环境

- 日期：2026-08-11。
- 客户端：iPhone 14 Pro 真机，`com.example.memorybridge.client`。
- 服务：Memory Bridge schema 31，全新隔离数据库，本机隔离端口。
- namespace：`phone-smoke`，`rollout_mode=auto`、`quality_state=bootstrap`、
  `override_kind=bootstrap_auto`。
- 模型：聊天、提取、关系和重排均为 `legacy local generation model`，embedding 为 `bge-m3:latest`。

### 7.3 复现步骤

1. 从真机通过安全桥和 AIRI OpenAI-compatible 生命周期发送：
   `My favorite number is 9472.`
2. 等待用户回复成功交付，并等待 `extract_turn` 完成。
3. 查询隔离数据库的 turn、extraction、candidate、memory 和 version 计数。

### 7.4 实际结果

- user turn 精确保存为 `My favorite number is9472.`；assistant 正常确认数字 9472。
- 生命周期日志为 `before_model_completed`、`after_turn_completed`、
  `proxy_result=success`，并生成 retrieval trace。
- 对应 `extract_turn` 为 `completed`，`extraction_runs` 也为 `completed`，无 dead job。
- 数据库最终为 `memory_candidates=0`、`memory_items=0`、`memory_versions=0`。
- 同轮“私密项目代码”没有形成候选符合凭据/秘密过滤预期；“最喜欢的数字”不属于密码、
  Token、私钥、验证码或高敏感信息，不能被相同策略静默丢弃。

### 7.5 期望结果

- 明确的个人偏好至少生成一个带原句 evidence 的候选。
- 处于 auto 且达到门槛时形成 `personal/self` 规范记忆；未达到门槛时必须留下可诊断的
  rejected/quarantined 原因，不能以“completed + 零输出”结束而没有原因。
- 新 session 询问 `What is my favorite number?` 时应召回 9472；不同 principal 必须为零召回。

### 7.6 根因排查要求

1. 为每次 extraction run 持久化去正文统计：模型 claim 数、schema 拒绝数、敏感过滤数、
   稳定性/重要度过滤数、coverage guard 拒绝数和最终 candidate 数。
2. 区分合法 `completed_noop` 与异常 `completed_empty`；后者进入可检索诊断事件和管理台告警。
3. 检查 `memory-extractor.ts` 的偏好分类和重要度阈值，确保“最喜欢的数字/颜色/饮料”等稳定偏好
   不会因单句、数字值或英文表达被当成闲聊。
4. 检查敏感信息过滤的边界，不得因为相邻测试回合出现 `private project code` 就污染下一轮的
   独立提取结果；过滤必须按 turn、claim 和 evidence 隔离。
5. 若模型确实返回零 claim，保存去正文的模型输出状态、finish reason 和 prompt 版本，并提供一次
   有界重试或进入待确认，而不是静默成功。

### 7.7 自动化与真实验收

- 单测：中英文“我最喜欢的数字是 9472 / My favorite number is 9472”均生成 personal 候选。
- 敏感对照：`My private project code is ZXQ947` 不进入记忆，但不得影响下一轮普通偏好。
- 生命周期集成：真实 after-turn、Worker、resolver 和 Dense 索引完成后，candidate/memory/version
  计数均大于 0，evidence 精确指向该 user turn。
- 跨会话：新 session 召回 9472；同 principal 另一个 persona 可按 personal 规则召回；Bob 为零结果。
- 重启：AIRI、忆桥和 Ollama 重启后结果不变，open outbox、异常 job 和 dead letter 均为 0。
- 可观测性：所有零候选 run 都有结构化 reason；管理台能区分“无可记内容”和“提取异常空结果”。

### 7.8 验收标准

- 固定偏好正例连续 20 次真实模型提取，candidate 生成率和最终记忆形成率均为 100%。
- 敏感对照 20 次进入记忆的次数为 0，且后续普通偏好不受污染。
- 新 session、跨 persona 正例和跨 principal 负例全部通过。
- 不通过降低全局敏感过滤或无条件记忆所有聊天来修复。

---

## 8. 统一发布门禁

修复完成后必须在全新隔离库执行以下顺序，不能只跑单元测试：

1. `npm run typecheck`
2. `npm run build`
3. `npm test`
4. `node scripts/verify-semantic-mcp.mjs`
5. `node scripts/qa-multiuser-long-chat.mjs`
6. 停止服务并使用同一数据库重启
7. `node scripts/qa-restart-persistence-probe.mjs`
8. SQLite integrity、FK、outbox、dead/retrying/stale/quarantined 全量检查
9. Memory Doctor 新增 scope 检查

发布必须同时满足：

- LM-P0-001、LM-P1-002、LM-P1-003、LM-P1-004 的全部验收标准通过。
- Alice/Bob 账号隔离、四角色隔离、四项目隔离均为 0 泄漏。
- 纠正后只返回新值，遗忘后目标和无关干扰均不返回。
- 服务重启不改变结果。
- 正式数据库不包含任何验收数据。
- 报告保留 trace ID、memory ID、模型版本、schema、延迟和数据库健康；不得包含 Token。

## 9. 非目标与禁止捷径

- 不通过在客户端 system prompt 中写“不要串角色”代替服务端 scope 修复。
- 不通过关闭 personal 跨角色共享掩盖 LM-P1-002；真正的个人习惯应在同账号角色间共享。
- 不通过降低所有召回阈值修复假阴性，这会扩大 LM-P1-003 的假阳性。
- 不通过提高所有召回阈值修复假阳性，这会扩大 LM-P1-002 的假阴性。
- 不删除原始 evidence；任何迁移必须可追溯、可重建、幂等。
- 不把未知 role/project scope 自动降级为 personal。
