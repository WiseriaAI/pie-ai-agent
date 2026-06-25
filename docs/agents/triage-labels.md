# Triage Labels（issue 状态机）

`WiseriaAI/pie-ai-agent` 的 issue 用一套标签状态机管理任务推进。云端分诊 routine（claude.ai，cron 每 4h）按它归类、分级、定阶段；实现链（云端 Loop）只在下游状态上往前走。**它是「某任务现在走到哪」的唯一事实源** —— 只看 open issue，非 open 不管。

## 标签

| 维度 | 标签 | 含义 |
| --- | --- | --- |
| 分类 | `bug` / `feature` | 缺陷 / 新功能 |
| 分级 | `P0` / `P1` / `P2` | 优先级（routine 按需创建） |
| 阶段 | `need-design` | 需要人牵头做产品化设计（设计阶段） |
| 阶段 | `need-confirm` | 方案已提出，待人拍板选项 / 取舍后进入实现 |
| 阶段 | `ready-for-agent` | 已充分指定，可交云端 Loop 实现 |
| 人工信号 | `confirmed` | 人对 `need-confirm` 拍板后打上；routine 据此补最终方案并推进 |
| 下游状态 | `agent-handling` | 已有 Loop 处理中 |
| 下游状态 | `PR` | 已提 PR，等待合入 |

## 状态机

```
新 issue ─分诊─► 分类(bug/feature) + 分级(P0/P1/P2) + 阶段
                              │
        ┌─────────────────────┼─────────────────────┐
   need-design           need-confirm          ready-for-agent
   (待人设计)        (人打 confirmed 拍板)            │
                          │ routine 读 confirmed     │
                          │ 补方案、去 need-confirm   │
                          └──────────────────────────┤
                                                      ▼
                                          agent-handling ─► PR ─► (人 merge)
```

约定：
- **「未分诊」** = open 且无任何阶段标签、无 `confirmed`、无下游状态标签。
- `need-confirm` **只认显式 `confirmed`** 才推进（不靠机器猜评论是否算确认，防误判提前放行）。
- 下游状态（`agent-handling` / `PR`）由实现链产出，分诊**只识别、跳过、绝不回退**。
- routine 缺标签会按需创建（`confirmed` / `P0` / `P1` 等首次用到时建）。

## 改规则 / 排查

分诊逻辑写在云端 routine 的 prompt 里（不是本仓库代码）。改规则 = 编辑 routine（管理页或 RemoteTrigger update）；删除只能去管理页。当前 routine：`trig_01VRZKPiEKVovSUHkuJ4Mvfs`。
