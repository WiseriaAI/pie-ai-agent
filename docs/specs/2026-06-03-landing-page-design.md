# Pie Landing Page — 设计 Spec

- 日期：2026-06-03
- 方向：**C · 浅色场景分屏叙事**
- 状态：设计已确认，待写实施计划 / 出 Paper 原型

## 1. 目标与受众

| 维度 | 决策 |
|---|---|
| 主受众 | 普通效率用户（非纯开发者） |
| 主目标动作 | 安装（Chrome Web Store） |
| 次目标 | GitHub Star |
| 语气 | 结果 / 场景优先，弱化硬核架构；BYOK / 开源 / 安全作为信任背书下沉 |
| 语言 | 中英双语，默认 EN，顶部切换 |
| 部署 | Vercel 静态站 |

**一句话定位**：用一句自然语言，让浏览器替你把活干完。

## 2. 设计语言（复用产品 token）

落地页与扩展**一眼同源**，直接沿用 `src/sidepanel/index.css` 的 token。

### 配色（浅色，v1 only）
| token | 值 | 用途 |
|---|---|---|
| canvas | `#FAFBFC` | 页面底 |
| surface | `#FFFFFF` | 卡片 / 浮层 |
| field | `#F4F6F8` | 输入 / 次级面 |
| line | `#E4E8EC` | 发丝线 |
| fg-1 | `#14181D` | 主文 / 墨色 |
| fg-2 | `#5A6470` | 次文 |
| fg-3 | `#98A1AC` | 三级文 / 占位 |
| accent | `#4A5C6E` | 石板蓝点缀（链接 / 强调） |
| accent-tint | `rgba(74,92,110,0.08)` | 强调底 |
| warning | `#B85A4D` | 陶土色（极少用，告警/高亮节点） |
| dot-grid | `rgba(20,24,29,0.04)` | 点阵背景 |

> 深色模式：token 已在 `index.css` 备好（canvas `#0B0D10` 等），v1 不做，作为后续低成本增量。

### 字体
- 正文：**Inter**（`ui-sans-serif` 兜底），开启 `ss01`、`cv11`。
- 等宽：**JetBrains Mono**（眉题 / 标签 / 命令 / 数字）。
- `.caps` 处理：等宽、10px、`font-weight:500`、`letter-spacing:0.16em`、全大写——用于眉题与小标签。
- 数字一律 `tabular-nums`（表格、Star 数、场景编号）。

### 质感与动效
- **点阵网格**：`radial-gradient(circle at 1px 1px, dot-grid 1px, transparent 0)`，`background-size:24px 24px`，用于 hero 背景。
- **发丝线**：1px `line` 色，作 section 分隔与卡片描边。
- **圆角**：卡片 ~16–20px，呼应品牌图标 `rx=26 / 128 ≈ 20%`。
- **品牌标记**：内联 SVG（深色圆角方 + 白圆 + 右上"咬一口"的小圆），作页脚 / 顶栏 / 点缀母题。
- **动效**：`cubic-bezier(0.32,0.72,0,1)`，150–250ms；每行场景滚动进入时 translateY(8px)+淡入的轻揭示；`prefers-reduced-motion` 下塌缩为静态终态。

## 3. 信息架构（自上而下）

### 3.1 顶栏（sticky · 磨砂 · 底部发丝线）
`[Pie 标记 + 字标]  ······弹性留白······  [EN｜中]  [★ GitHub]  [Add to Chrome]`
- 主按钮 = accent 实心或墨色实心；GitHub 为次级文字链 + star 数（可选运行时 fetch，失败则隐藏数字）。

### 3.2 Hero（短）
- `.caps` 眉题：`AI IN YOUR BROWSER` / `浏览器里的 AI Agent`
- 大标题：
  - EN: **Tell your browser what to do.**
  - 中: **说一句话，浏览器替你干完。**
- 副文（一行）：
  - EN: One sentence. Pie plans the steps and does the work — read pages, organize tabs, extract data, even save it as a reusable skill.
  - 中: 一句自然语言，Pie 自己规划步骤并执行——读网页、整理标签、抽数据，还能存成可复用的技能。
- CTA：主 `[Add to Chrome — free]`，次 `★ Star on GitHub`
- 背景：点阵网格；右侧 / 下方露出一角风格化 side panel（暗示产品形态）。

### 3.3 场景导览（核心）—— 3 行「左命令 → 右结果」铺满整行
每行：左=自然语言命令气泡，右=产品**真实渲染**的结果；**两列铺满整行**（命令列 ~520 / 结果列 ~736 / 间距 56，内容各自填满本列），命令**恒在左**（读作 say→get，不交替）。两个要避免的坑：① 内容贴各自外边缘 → 中间空出大洞；② 收缩成对再左对齐 → 右侧留白。最终方案 = 定宽两列正好加起来等于整行内容宽，无空洞、无留白。配 `SCENARIO 0N` 小标签 + 一行结果副说明。

**SCENARIO 01 · 网页 & PDF 问答 / 总结**
- 命令：`"总结这页 / 这份 PDF" · "Summarize this page"`
- 结果：三点要点卡 + 来源 chip（`untrusted` 安全采集的暗示可省略，面向普通用户）
- 副说明：EN: Ask anything about the page or PDF you're on. / 中: 当前网页或 PDF，问什么答什么。

**SCENARIO 02 · 跨标签整理 & 数据提取**
- 命令：`"把这 10 个标签整理成表格" · "Pull these into a table"`
- 结果：整洁表格（列：title｜url），`tabular-nums`；或抽取出的价格 / 邮箱列表
- 副说明：EN: Tidy up tabs, or extract structured data to markdown. / 中: 整理一堆标签，或把数据结构化导出。

**SCENARIO 03 · 录制成 Skill 复用**（差异化亮点）
- 命令：`"把刚才这套操作存成技能" · "Save that as a skill"`
- 结果：`/my-skill` chip +「下次一句话复用」气泡
- 副说明：EN: Record a workflow once, replay it with one phrase. / 中: 录一次流程，下次一句话重放。

### 3.4 信任条（发丝线分隔 · 等宽小标签）
`BYOK — 你的 key，本地 AES-GCM 加密`｜`Open-source`｜`无后端 / 无遥测`｜`10 家 LLM providers`

### 3.5 完整能力表（可扫读网格）
承接未主打的部分，等宽微标签 + 一行说明：
- 多步任务自动化（点击 / 输入 / 选择 / 滚动，agent 自规划）
- 表单填写
- CDP 键盘（Lark / Google Docs 等画布编辑器）
- 跨标签编排（list / activate / close / group / move / fetch）
- 会话跨 Service Worker 重启续存
- Skills 带作用域工具白名单
- 抗 prompt 注入的沙箱执行

### 3.6 安全背书（轻触 · 2–3 行）
标题「Contained by design / 生来受控」：页面内容只在 `<untrusted_*>` 包裹中进模型；工具分读 / 写两类 + 跨会话写锁；每会话独立沙箱。**安抚而非说教**。

### 3.7 收尾 CTA
再来一个 `[Add to Chrome — free]`，微文案 `free · BYOK · open-source`，次级 GitHub 链接。

### 3.8 页脚
链接：Privacy · Changelog · Roadmap · Architecture · GitHub · Chrome Web Store；Pie 标记；顶部发丝线。

## 3.9 保真约束 — 只展示已上线的 UI（重要）

落地页里所有「Agent 结果」的视觉必须反映产品**当前真实渲染**，不得描绘尚未上线的组件（即使已有设计）：
- 真实回复 = `AgentSummary` 徽标（accent 小圆点 + `.caps` "Done · N steps"）+ `MarkdownContent` 渲染（remark-gfm：列表、加粗、代码、**表格**）。
- 表格按 `src/sidepanel/components/Markdown.tsx` 的真实样式：圆角边框容器、等宽大写 fg-3 表头、左对齐 12px 单元格、发丝线行分隔（**无右对齐、无 tabular-nums**，因为真实 th/td 不带对齐类也不是 mono）。
- 录制→Skill 的复用入口用真实的 `SkillSlashPopover`（输入 `/` 检索 `/skill`），**不是**虚构的「Skill saved 卡」。
- **禁止**：来源/引用 chip（产品无 citation 渲染）、带标题的「Summary/Answer 卡片框」、scoped-tools chip 等未上线组件。
- 待这些组件真正上线后再回头更新落地页。

## 3.10 背景纹理与动效

- **点阵纹理**：复用产品 `.dot-grid`（`radial-gradient(circle at 1px 1px, …)`，24px 间距），铺在 Hero / 场景区 / 能力区背景；深色 CTA 段用浅色点做「星点」。低透明度（浅色区 ~0.05 墨色、深色区 ~0.06–0.07 浅色），whisper 级、不抢内容。真实站点用 CSS 平铺即可；Paper 预览用 SVG `<pattern>` 近似（绝对定位铺底 + 内容层在上）。
- **动效（仅一种，克制）**：**悬浮聚光（cursor spotlight）**——一圈柔光跟随鼠标，让其下方的点轻微提亮。低强度。实现思路：`pointermove` 更新 CSS 变量 `--mx/--my`，叠一层受 `radial-gradient` mask 约束的提亮层；`prefers-reduced-motion` 下关闭。**不做**滚动视差、**不做**星点呼吸（用户只选了聚光）。

## 4. 双语机制
- 两套文案并存，顶栏切换翻转 `lang`（`en` / `zh`）。
- vanilla JS：按 `data-i18n` 或双节点显隐切换；`localStorage` 记忆选择；同步更新 `<html lang>`。
- 默认 `en`；无路由、无框架。

## 5. 技术与部署（已确认默认项）
- **纯静态**：`index.html` + `styles.css` + `main.js`（语言切换、滚动揭示、可选 GitHub star fetch）。**无框架、无构建步骤**。
- 字体：自托管 woff2 或 Google Fonts（二选一，实施时定）。
- 品牌 SVG 内联。
- 位置：pie-ai-agent 仓库新目录 **`landing/`**；Vercel 项目 Root Directory = `landing`，preset = Other/Static，与扩展构建隔离、随产品版本化。
- **不接任何 analytics**（呼应无遥测气质）。

## 6. 范围（YAGNI）
**做**：上述单页、双语、3 个主打场景、信任 / 能力 / 安全 / CTA / 页脚。
**不做**：blog、文档站、定价页、登录、真实截图（v1 全部风格化复刻，真实录屏后续可塞 hero）、analytics、深色模式（后续增量）。

## 7. 验收标准
- 视觉与扩展同源（配色 / 字体 / 点阵 / 发丝线 / 圆角 / 动效一致）。
- 中英可切换且记忆；`<html lang>` 正确。
- 主 CTA 指向真实 Chrome Web Store 链接；GitHub 链接正确。
- 移动端可读（分屏在窄屏纵向堆叠）。
- Lighthouse：无构建、零重 JS，性能 / 可访问性 ≥ 90；`prefers-reduced-motion` 生效。
- Vercel 静态部署成功，Root Directory = `landing`。

## 8. 待定 / 后续
- 字体托管方式（自托管 vs Google Fonts）——实施时定。
- 真实录屏 GIF / 截图——后续替换 hero 风格化复刻。
- 深色模式——token 已备，后续增量。
- 第二设计方向（A 或 B）——Paper 出原型时顺带一版供对比。

## 9. 链接素材（实施时填）
- Chrome Web Store: https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed
- GitHub repo: https://github.com/WiseriaAI/pie-ai-agent
- Privacy / Changelog / Roadmap / Architecture: 指向 repo 内对应文件
