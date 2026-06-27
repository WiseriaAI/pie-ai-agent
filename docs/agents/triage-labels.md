# Triage Labels（issue 状态机）

`WiseriaAI/pie-ai-agent` 的 issue 用一套标签状态机管理任务推进。云端分诊 routine（claude.ai，cron 每 4h）按它归类、分级、定阶段；实现链（云端 Loop）只在下游状态上往前走。**它是「某任务现在走到哪」的唯一事实源** —— 只看 open issue，非 open 不管。

## 标签

| 维度 | 标签 | 含义 |
| --- | --- | --- |
| 分类 | `bug` / `feature` | 缺陷 / 新功能 |
| 分级 | `P0` / `P1` / `P2` | 优先级（routine 按需创建） |
| 阶段 | `need-design` | 需要人牵头做产品化设计（设计阶段） |
| 阶段 | `need-confirm` | 方案已提出，待人拍板选项 / 取舍后进入实现 |
| 阶段 | `ready-for-implement` | 已充分指定，可交云端 Loop 实现 |
| 人工信号 | `confirmed` | 人对 `need-confirm` 拍板后打上；routine 据此补最终方案并推进 |
| 下游状态 | `agent-handling` | 已有 Loop 处理中 |
| 下游状态 | `PR` | 已提 PR，等待合入 |
| PR 复审 | `need-to-solve` | Reviewer 判定 PR 需修改，交回 implementer |
| PR 复审 | `solved` | implementer 已按意见改完，等 Reviewer 复审 |
| PR 复审 | `need-human-test` | 通过 code review，需人工真机验收 |
| PR 复审 | `human-approved` | 人已真机验收通过，可直接合并（由人打上） |

## 状态机

```
新 issue ─分诊─► 分类(bug/feature) + 分级(P0/P1/P2) + 阶段
                              │
        ┌─────────────────────┼─────────────────────┐
   need-design           need-confirm          ready-for-implement
   (待人设计)        (人打 confirmed 拍板)            │
                          │ routine 读 confirmed     │
                          │ 补方案、去 need-confirm   │
                          └──────────────────────────┤
                                                      ▼
                                          agent-handling ─► PR ─► (见下 · PR 复审)
```

## PR 复审与合并（Step4 Reviewer loop）

implementer 提 PR 后，由云端 **Step4 Reviewer loop**（每 4h，与实现链错开 2h）复审代码质量 / 设计符合度 / 单测覆盖，并分诊是否需要人工真机验收：

```
PR 提出 ─► Step4 复审（代码质量 / 设计符合 / 单测 + 跑 gate）
            ├─ 需要修改       → need-to-solve ─► implementer 修复 ─► solved ─► Step4 复审 ↺
            ├─ 过·需真机      → need-human-test ─► 人真机验收 ─► human-approved ─► Step4 admin 合并 main
            └─ 过·无需真机    → Step4 直接 admin 合并 main（仅纯文档/注释/测试/CI，或纯重构且单测足够）
```

- Reviewer 与 implementer 是**同一个云端 gh 身份**，GitHub 禁止自审自批，故 review 意见走 `gh pr comment`、**状态机靠标签驱动**（不靠 GitHub 原生 review 状态）；合并用 `--admin` 绕过 main 分支保护。
- `need-to-solve` 的 PR 由 **implementer loop（Step3）优先接走**（先收尾在途 PR，再实现新 issue），不单设 PR Solver。
- `human-approved` 只由**人**打（真机验收通过的信号），Reviewer 见到即 admin 合并。
- 自动合并走**保守白名单**：仅纯文档 / 注释 / 纯测试 / CI 配置、或纯内部重构且单测充分才直接合；碰 `src/**` 运行时代码一律 `need-human-test`。

约定：
- **「未分诊」** = open 且无任何阶段标签、无 `confirmed`、无下游状态标签。
- `need-confirm` **只认显式 `confirmed`** 才推进（不靠机器猜评论是否算确认，防误判提前放行）。
- 下游状态（`agent-handling` / `PR`）由实现链产出，分诊**只识别、跳过、绝不回退**。
- routine 缺标签会按需创建（`confirmed` / `P0` / `P1` 等首次用到时建）。

## 改规则 / 排查

整条流水线由 4 条云端 routine 串成（claude.ai，cron 每 4h），逻辑写在各自的 prompt 里（不是本仓库代码）。改规则 = 编辑 routine（管理页或 RemoteTrigger update，**注意 update 非真 partial，须连 `cron_expression` + 完整 `job_config` 一起重发**，否则 cron 被重置）；删除只能去管理页。

| Step | routine id | 职责 |
| --- | --- | --- |
| Step1 | `trig_01VRZKPiEKVovSUHkuJ4Mvfs` | issue 分诊（归类/分级/定阶段） |
| Step2 | `trig_01LJRAhec9QFhs6Y7mp5Qhss` | `need-confirm` + `confirmed` → 补方案推进到 `ready-for-implement` |
| Step3 | `trig_01CwqcqtPHZyh88NmeMf5Uew` | implementer：优先修 `need-to-solve` PR，其次实现 `ready-for-implement` issue → 提 PR |
| Step4 | `trig_01G5rg8KJeTF6kRomn15pyyh` | PR Reviewer：复审 + 合并（错开 2h 跑） |
