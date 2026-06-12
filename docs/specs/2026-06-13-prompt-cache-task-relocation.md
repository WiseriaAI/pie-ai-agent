# Spec — Prompt cache 修复:task 移出 system prompt

- 日期:2026-06-13
- 关联 issue:[#175](https://github.com/WiseriaAI/pie-ai-agent/issues/175)
- 状态:设计已获批,待实施
- 分支:`feat/prompt-cache-task-relocation`

## 背景与问题

`buildAgentSystemPrompt`(`src/lib/agent/prompt.ts:348`)把 `<user_task>${task}</user_task>` 拼在 system prompt 末尾;`anthropic-sdk-core.ts:133` 把整个 system text 作为**单个 block**、`cache_control: { type: "ephemeral" }` 标在末尾。

Anthropic prompt cache 是**精确前缀匹配**——命中要求从开头到 cache_control 断点逐字节一致。task 位于断点之前,所以缓存失效。

比 issue 描述更严重的一点(实施时核实):`task = messages[messages.length - 1].content`(`src/background/index.ts:1252`)——task 恒为**最新一条**用户消息,system prompt 每个用户回合都用新 task 重建。所以缓存不是"每对话 miss 一次",而是**每个回合都 miss 整个 system block**(数千 token 的 STATIC 指令)。

同一句最新消息当前同时出现两份:
- system 里 trusted 的 `<user_task>`;
- 会话尾部 untrusted 的 `<untrusted_user_message>`(`chatMessageToAgentMessage`,`src/lib/agent/loop.ts:301`)。

受影响:所有开了 `promptCache` 的 Anthropic-wire provider(anthropic / deepseek / minimax / mimo)。

## 当前的信任分配(关键事实)

> 今天的实际信任分配 = **最新一条**用户消息被逐字复制进 trusted `<user_task>`(= 完全信任它的字面文本);更早的回合只在会话里、untrusted。

`STATIC_AGENT_SYSTEM_PROMPT`(`prompt.ts:60` 注释)本就声明 "Never contains page data or user task" ——静态块本来就是纯的,task 是在 `buildAgentSystemPrompt` 里**额外拼**上去的。

## 目标

让 system block 跨回合逐字节恒定,恢复 prompt cache 对 STATIC 指令 + tools 前缀的命中,**不削弱** trusted/untrusted 防注入边界。

## 范围

**范围内:** task 从 system 移到**最新一条用户消息**的 trusted `<user_task>` 包裹(方案 A)。这是 prompt 装配层改动,**对所有 provider 生效**(OpenAI-compat 也会变 message 结构,只是缓存增益仅 Anthropic-wire 四家可见)。

**范围外(诚实声明,留 follow-up):** system block 里还有 `pinnedContext`(`buildPinnedContextBlock`)/ `skillCatalog`(`buildSkillCatalogBlock`)两个**会变**的块。它们跟随会话的固定标签页 / 焦点 / 技能目录:在同一会话稳定标签页下跨回合不变 → 仍命中;只有切焦点 / 加标签页 / 改技能目录时才 miss(远比"每回合换 task"罕见)。把这两块也挪到缓存断点后属于更大重构,本 spec 不做。

## 选定方案:A — 活动消息加 trusted 包裹

把**最新一条**用户消息从 `<untrusted_user_message>` 改包成 `<user_task>`(trusted);更早回合保持 `<untrusted_user_message>`。system 变纯 STATIC。

```
system: [STATIC 指令 + tools]            ← 逐字节恒定 → 每回合命中缓存
messages:
  user: <untrusted_user_message>上一回合</untrusted_user_message>
  assistant: ...
  user: <current_time>…</current_time>
        <user_task>最新提示</user_task>   ← TRUSTED,本回合任务
```

**为何安全:** 逐条信任分配 == 今天(今天就是"最新一条逐字进 trusted `<user_task>`,更早回合 untrusted")。方案 A 原样保留这套分配,只去掉 system 里的重复拷贝。**不是放宽,是平移。** 唯一真未知:`<user_task>` 标签放在 user role 时 LLM 是否仍当 trusted —— 契约上信任信号是标签本身、与 role 无关(`prompt.ts:80` 的声明不限定 role),靠 injection 测试坐实。

被否的方案 B(会话尾部追加 trusted 副本):保留今天的双通道(会话里最新消息仍 untrusted 副本,另在尾部追加一条 `{role:"user", <user_task>…}` trusted 副本)。语义改动最小最保守,但保留了文本重复 + 出现两条相邻 user 消息,略显笨拙。

## 改动机制

| 位置 | 现状 | 改为 |
|---|---|---|
| `prompt.ts:348` `buildAgentSystemPrompt` | 末尾拼 `\n\n<user_task>${task}</user_task>\n\n${R15}` | **删掉 `<user_task>` 拼接**;`task` 参数移除。system = 纯 STATIC + guidance 块 |
| `R15_IMAGE_UNTRUSTED`(`prompt.ts:276`) | 注释称"放在 `<user_task>` 之后做最后一句" | 该理由失效(task 已不在 system)→ R15 并入 STATIC 安全段(`prompt.ts:62` 红线区附近),仍是静态文本 |
| `loop.ts:296` `chatMessageToAgentMessage` | **所有** user 消息包 `<untrusted_user_message>` | 不变(它处理通用历史)。trusted 包裹只在 seed 装配处对"最新一条"施加 |
| `loop.ts:1282` 前台 seed(path 2) | `[systemMsg, ...prependTimeToLastUserMessage(map(...))]` | 最新一条 user 消息改包 `<user_task>`(trusted)而非 `<untrusted_user_message>`;更早回合保持 untrusted。与 `<current_time>` 组合成 `<current_time>…</current_time>\n\n<user_task>…</user_task>`(`<current_time>` 在 trusted task 外、仍是 trusted runtime 内容) |
| `loop.ts:1300` headless seed(path 3) | `buildSeededTaskContent` = 时间块 + 裸 task | 裸 task 改为 `<user_task>` 包裹 |
| resume(path 1)`loop.ts:1284` | 逐字复用持久化 history(含 system 条目,`loop.ts:579` snapshot 整个 `history`) | **不动**。旧会话续接旧 system(旧形态,无缓存增益、也无回归);新会话持久化的已是新形态 → resume 也吃到缓存。**无需迁移持久化历史** |

**落点关键:** trusted 包裹**只施加于 seed 时的当前提示**,绝不施加于 loop 中途追加的观察(页面快照)或 `buildMidTaskUserMessage` / loop-drain 的中途指令 —— 后两者保持 `<untrusted_user_message source="mid_task">`,与今天一致。

**escape 防越狱:** 当前 system 内嵌路径未对 task 做 untrusted-wrapper escape(它在 trusted 区);方案 A 下 task 文本里若含 `<user_task>` / `</user_task>` 字面量,需做幂等转义防标签越狱(参照 `escapeUntrustedWrappers` 的思路,但目标标签是 `user_task`)。实施时确认转义策略并加测试。

## trust 不变量如何守住

- `prompt.ts:80` 已声明 `<user_task>` 为 trusted、且**不限定 role**(信任信号是标签本身)。这行保留,可微调措辞反映 `<user_task>` 现以"当前回合的包裹"出现而非 system 内嵌。
- `prompt.ts:86` "The first user message of each task begins with a trusted `<current_time>` block" 措辞可保留(time 块仍在最新 user 消息最前)。
- 逐条信任分配 == 今天(见上)。**不是放宽,是平移。**
- `<user_task>` 非 `untrusted_*` 标签,不进 `untrusted-wrappers.ts` 的 escape 表 / `recording/selector.ts` / `probe-core.ts` 等清单(它们扫的是 `untrusted_*`),这些不受影响。

## 缓存结果

- **主要修复:** 同一会话稳定标签页下,**跨回合** system + tools 前缀逐字节恒定 → `cache_read_input_tokens > 0`。这是 issue 抱怨的"每回合 miss 几千 token"的根因。
- **次要(受限):** 跨会话共享受 `pinnedContext` / `skillCatalog` 差异限制(本就如此,非本 spec 引入)。
- 四家受益:anthropic / deepseek / minimax / mimo。

## 测试与验收

**单测:**
- `buildAgentSystemPrompt` 输出与 `task` 无关:对任意两个不同 task 字符串,system 输出 byte-identical(且不含 `<user_task>`)。
- seed 装配 path 2:最新 user 消息含 `<user_task>` 且**不**含 `<untrusted_user_message>`;更早回合仍 `<untrusted_user_message>`;`<current_time>` 在 `<user_task>` 外。
- seed 装配 path 3:`buildSeededTaskContent` 输出含 `<user_task>` 包裹。
- escape 幂等:task 文本含 `<user_task>` 字面量时被转义。
- 中途指令 / 观察仍 untrusted(loop-drain / mid-task 回归不破)。
- resume path:旧形态持久化历史(system 内嵌 task)resume 不报错、行为不变。

**Injection 回归(核心安全门):** 一组 prompt-injection 用例,验证 trusted task 在 user role 仍被遵循、且 `<untrusted_*>` 页面内容里的指令仍被拒。

**真机(issue 已要求):** 全量前台回归 + 用量观察 `cache_read_input_tokens` 跨回合 > 0 + injection 探针实测(四家 Anthropic-wire 至少抽测 anthropic 本家)。

**全绿门槛:** `pnpm test` / `pnpm typecheck` / `pnpm build`。

## 风险

1. **`<user_task>`-in-user-role 是否被当 trusted** —— 唯一真未知,靠 injection 测试坐实;契约上标签即信任信号,理论成立。
2. **跨 provider 行为漂移** —— OpenAI-compat 家族 task 也从 system 挪到 user role,需顺带回归(虽无缓存利益)。
3. **time / seed 组合顺序** —— `<current_time>` 与 `<user_task>` 嵌套顺序需测试锁定,避免 time 块跑进 trusted task 内部语义。

## 关联

- issue #175(本 spec 的源头);schedule 时间注入 PR #173 过程中发现此问题。
- 时间注入已先按"放 first user message"实现(`prependTimeToLastUserMessage` / `buildSeededTaskContent`),不依赖本重构;本 spec 与之天然组合。
