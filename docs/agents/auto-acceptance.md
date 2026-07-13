# 自动化真机验收（auto-acceptance）

> 用 Playwright 驱动真实 Chromium + 扩展 + daemon 全链路，自动跑 `need-human-test` PR 的真机验收清单，把人工从「全量跑清单」降级为「看报告 + 抽查结构性盲区」。
> 首个完整样本：PR #283（skill 多根目录），6/6 清单项全自动 PASS；参考脚本在 `eval/acceptance/pilot-283-*.mjs`。

## 适用范围与分工

| 类型 | 谁做 | 说明 |
|---|---|---|
| 功能回归流（UI 操作 → 状态断言） | 自动化 | Playwright 直驱 sidepanel 页 |
| daemon 桥全链路（native messaging / skill_fs / srt 沙箱） | 自动化 | scratch HOME 隔离，源码直跑 daemon |
| LLM 驱动项（工具调用、HITL 授权卡） | 自动化 | eval bridge + 真实模型，断言落磁盘证据 |
| 品牌 Chrome 特有差异（僵尸 frame 类） | **人工** | Playwright 跑的是 Chromium，结论不能外推（PR #264 前科） |
| optional 权限原生弹框流 | **人工** | Playwright 点不了浏览器级弹框，harness 靠权限提必选绕过 = 未覆盖 |
| 真实 OAuth / 支付、编译版二进制制品链路、视觉手感 | **人工** | |

**自动化全绿 ≠ 免人工**：报告必须显式列出本次未覆盖的盲区；人工只需抽查盲区项。PR #283 的教训——自动化 6/6 全绿后，人工用真实数据规模 30 秒撞出 8KB backpressure 发布阻断 bug（fixture 只有 3-4 个 skill，响应没过阈值）。

## 前置条件

- `pnpm install` 过的仓库（playwright 依赖 + `~/Library/Caches/ms-playwright/chromium-*`，缺则 `npx playwright install chromium`）
- bun（daemon 源码直跑）
- LLM 驱动批需 `~/.pie/acceptance.env`（chmod 600，`PIE_EVAL_PROVIDER/MODEL/API_KEY` 三元组，与 eval harness 同名；缺 key 提醒用户填，别擅自换 provider）

## 操作流程

1. **checkout 目标 PR 分支**（主仓库主目录，遵循「测试直接在主目录切分支」约定）。
2. **构建**：`pnpm build:eval` → `dist-eval`（`__PIE_EVAL__` 只多挂 `globalThis.__pieEval` bridge，其余同生产；prod 构建有 assert-no-eval-bridge 兜底）。
3. **准备隔离工作目录**（`export PIE_ACCEPT_BASE=<dir>`，建议放 job tmp）：
   - `dist-pilot/` = dist-eval 副本 + manifest 把 `nativeMessaging` 从 optional 提为**必选**（装载即授予 → SW 启动自动连桥，绕过 Playwright 点不了的原生权限弹框；副作用：桥开关流未覆盖，报告里必须声明）
   - `dist-orig/` = dist-eval 原样副本（未授权 → 不连桥，测 daemon-off / IDB 基线）
   - `home/` = scratch HOME：`home/.agents/skills/`、`home/.pie/` 全部落这里，**绝不碰真实 `~/.pie` / `~/.agents`**
   - `host-wrapper.sh`：`#!/bin/bash` + `export HOME=<scratch>` + `exec bun <repo>/daemon/src/cli.ts host`
4. **fixture**：造副根/主根 skill。**规模必须对齐真实环境**——至少一档 ≥30 个 skill（list 响应 >8KB 才能压出序列化/传输层问题）；带 `scripts/` 的 skill 用于脚本执行项（py/sh/ts 各一）。
5. **起 scratch daemon**（后台）：`HOME=<scratch> bun <repo>/daemon/src/cli.ts daemon`，确认 `<scratch>/.pie/daemon.sock` 出现。
6. **跑功能批**：`node eval/acceptance/pilot-<PR>-functional.mjs`（从 `pilot-283-functional.mjs` 复制改断言）。
7. **跑 LLM 批**：`set -a; source ~/.pie/acceptance.env; set +a && node eval/acceptance/pilot-<PR>-llm.mjs`。
8. **清理**：pkill scratch daemon（精确匹配 `daemon/src/cli.ts daemon`，别误伤真 daemon）；工作目录随 job 清理。

## 配方与坑（不遵守必踩）

- **扩展 ID 是商店固定 ID** `gpccjhdgjkmalnepmeclooflliiocfed`（manifest 带 `key`，不由路径推导）。
- **NM manifest 位置**：`<user-data-dir>/NativeMessagingHosts/ai.wiseria.pie.json`（跟随 `--user-data-dir`，**不是** `~/Library/Application Support/Chromium/...`）；`path` 指向 host-wrapper，`allowed_origins` 用上面的固定 ID。每个 profile 启动前写入。
- **locale 钉死**：launch 传 `locale:'en-US'` + `--lang=en-US`，否则 UI 跟系统语言走、文本断言全挂。
- **seedConfig 三坑**（eval bridge 只服务 SW loop，panel 不认）：
  1. 等 SW startup pipeline 落定（~3s）再 seed，否则 `createInstance` 写的 `instances_index` 被迁移初始化 RMW 抹掉（lost-update）；
  2. panel `hasConfig` = `listInstances()` 非空，走 index —— seed 后补写 `instances_index`；
  3. Composer 可用还需补 `last_model_selection`（registry 内置模型免 `pcm_` 补写，非内置模型还要 `pcm_<provider>`）。
- **设置页 skills 列表设计上不显示 builtin**（`custom = skills.filter(!builtIn)`）——IDB 模式空列表是正常现状，别当回归追。
- **HITL 卡（skill-grant / CDP / 文件访问）headless 走不通**：daemon 授权无 panel 时 fail-closed。必须开着 sidepanel 页（`chrome-extension://<id>/src/sidepanel/index.html` 当 tab 开）、从 composer 发任务、Playwright 点卡上按钮（如 `Allow`）。纯工具调用项（无 HITL）可走 `__pieEval.startTask` + `waitForDone` + `getTrace` headless。
- **齿轮按钮 aria 随视图翻转**（`Open settings` / `Close settings`），chat 空态 CTA 撞名 `Open Settings`——用 exact 大小写匹配。
- **sidepanel 以 tab 打开 ≈ 真 side panel**，但排版差异属人工盲区，viewport 建议 420×900。
- **`PIE_ACCEPT_BASE` 必须短**：daemon 的 unix socket 落 `<BASE>/home/.pie/daemon.sock`，受 macOS `sun_path` 104 字节上限；agent scratchpad 那种 100+ 字符的路径会让 daemon 直接 `Failed to listen`（表现为桥永远连不上、误判成回归）。用 `/tmp/pie<PR>` 一类短路径。

## 验收标准

- 每条清单项一条断言记录，状态 `PASS / FAIL / ERROR / SKIP`，FAIL/ERROR 附现场值。
- **断言落确定性证据**，优先级：磁盘（grants.json / audit.jsonl / workspace 目录 / 文件 hash）> DOM 状态（aria、文本存在性）> 对话文本。**LLM 驱动项禁止只断言对话文本**（非确定性）；LLM 行为异常（没按预期调工具）记 FAIL 并附 `getTrace` 的 steps。
- fixture 含真实规模档（≥30 skill）且该档跑过 list/滚动路径，否则报告必须标注「未验证真实规模」。
- 结构性盲区（本文件分工表的「人工」行）**不得标 PASS**，在报告「留人工」区显式列出。
- 断言失败先甄别「设计 vs 回归」：对照 clean main 跑同断言（main 也如此 = 现状/设计，不是本 PR 回归）。
- **状态跟随类清单项（UI 该跟着某个后台状态变）别只断言终态**：终态断言在「UI 本来就卡在那个值」时会假通过。改为双流采样——真值（SW RPC）与表现（DOM 文本）同时轮询，断言**跟随延迟**（表现滞后真值 ≤ 轮询周期），并全程不 reload / 不离开该页，排除「重挂载才更新」。同一脚本跑 clean main **必须 FAIL**，否则说明断言根本没测到东西。样本：`pilot-299-functional.mjs`（设置根页桥 badge）。

## 报告格式

产物：`$PIE_ACCEPT_BASE/report/`（截图按序号命名）+ `results*.json`。贴 PR 评论用以下模板：

```markdown
## 自动化真机验收报告 — PR #<n>

环境：Playwright Chromium + PR 分支源码 daemon（bun 直跑，scratch HOME 隔离）
模型（LLM 批）：<provider>/<model>

| 清单项 | 结果 | 证据 |
|---|---|---|
| 1. <清单原文摘要> | ✅ PASS | <断言现场值 / 截图名> |
| 3. <…> | ✅ PASS | audit.jsonl: py exit=0 353ms… / grants 信封 / workspace 出现 / fixture hash 未变 |
| … | ❌ FAIL | <现场值 + 判断是回归还是设计> |

**Fixture 规模**：<n> 个 skill（真实规模档已跑 / 未跑）
**留人工（本次未覆盖）**：品牌 Chrome 差异、optional 权限弹框流、<其他本次特有盲区>
**顺带发现**：<非本 PR 的问题，开 issue 链接>
```

结论行只有两种：「自动验收通过，建议人工抽查上列盲区后打 human-approved」或「存在 FAIL，建议打 need-to-solve」。
