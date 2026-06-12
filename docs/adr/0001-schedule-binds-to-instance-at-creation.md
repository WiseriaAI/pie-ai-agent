# Schedule 绑定到创建时选定的 provider instance

Schedule 是无人值守执行的定时 agent 任务，**可预测性优先于"自动跟随全局默认 instance"**。

**决定**：创建 Schedule 时，把当刻的 active `instanceId` 绑定到这条 Schedule（作为缺省值；agent / 用户也可显式指定别的）。绑定的是 instance 的**引用（id）而非配置快照**——所以该 instance 内部的 apiKey / model 更新对 Schedule 仍然生效（key 轮换不破）。若该 instance 被删除，Schedule **自动转 `paused` 并通知用户**，而不是静默回退到另一个 instance 上跑。

**被拒的备选**：
- **运行时读 global active**：换默认 instance 会 surprising 地改变一个无人值守任务的模型能力（vision / 长上下文 / 价格），用户不在场无从察觉。
- **强制显式必填**：太啰嗦，且 agent 在对话里建 schedule 时还得被逼着选 instance，违背"一句话建 schedule"的体验。

**下游影响**：需要一个"instance 被删 → 找出绑定它的 Schedule → 置 paused + 通知"的联动（删 instance 的路径上加 hook）。
