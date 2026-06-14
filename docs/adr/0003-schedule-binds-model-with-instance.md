# Schedule 同时绑定 model（扩展 ADR 0001）

ADR 0001 让 Schedule 绑定创建时选定的 instance，运行时取该 instance 的**第一个**可用 model。issue #181 暴露两个问题：(1) 创建时"默认挑哪个 instance"裸读 config key `active_instance_id`，而它在正常 V2 使用中几乎从不被写（全新安装恒为 null）→ 创建直接报 "no active instance configured"；(2) 用户无法决定一条 Schedule 用该 instance 下的**哪个** model（总是第一个）。

**决定**：

1. **"默认挑哪个 instance"复用权威解析链 `resolveSelection({})`**（session pin → `last_model_selection` → 第一个 instance），与聊天同源、自带兜底，不再裸读 `active_instance_id`。chat 路径（agent 工具 `create_schedule`）进一步优先绑定**当前对话会话的 `(instance, model)`**——"你用哪个模型聊，定时任务就用哪个"。

2. **`ScheduleRecord` 新增可选 `model?`**。运行时解析改为 **`sched.model ?? firstModelForProvider(...)`**：有绑定值用绑定值，缺省回退 ADR 0001 的"第一个 model"。可选字段 = **零迁移**，旧记录与未绑定记录行为不变。

3. **写入来源**：手动表单用 Composer 的 `ModelPicker` 让用户显式选 `(instance, model)`（创建与编辑都可改）；chat 路径绑会话当前 `(instance, model)`（经 `AgentLoopContext.instanceId` + `modelConfig.model` 透入工具 ctx）。**agent 工具不加 `model` 参数**——模型选择属于 UI，LLM 不该猜模型 id。

**被拒的备选**：
- **只修裸读、不绑 model**：能修好创建报错，但 Schedule 仍只能用"第一个 model"，多模型 provider（如 anthropic opus/haiku、openrouter）下用户无从指定，体验缺口仍在。
- **chat 路径也弹"挂起式"模型选择卡片**：依赖把 loop 工具调用做成可持久化、跨 MV3 SW 回收恢复的 suspend 点。现成的 `cdp-input-onboarding` 端口级 pending-promise 范式可复用，但带 SW 回收脆弱性，工作量更大——延后至 **issue #184**，本期 chat 一律绑会话当前模型。
- **`model` 必填 / 运行时仍永远取第一个**：前者啰嗦且破坏"一句话建 schedule"；后者就是被本 ADR 取代的现状。

**下游影响**：`run.ts` 的模型解析、`schedule-ops` 的 create/update 写入、`panel-actions` payload、`ScheduleForm`（复用 ModelPicker）、`SchedulesPanel`（默认走 resolveSelection）、loop→工具 ctx 管线均需同步携带 `model`。删 instance 的 ADR 0001 联动（绑定它的 Schedule 转 paused）不变。
