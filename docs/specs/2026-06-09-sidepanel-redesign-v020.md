# 侧栏体验重做 · v0.20 大版本

- 日期:2026-06-09
- 状态:设计已定稿(Paper 原型全部审过),待写实施 plan
- 范围:Side panel 的 **设置页(配置/技能/搜索/通用)** 重做 + **Chat 排队组件** 配色
- Paper 原型:文件 `Pie Frontend`(fileId `01KQH5T49RW8RTNMMSTKD1EQEZ`),画板见文末「Paper 索引」
- 相关:模型/Provider 解耦(PR #138)—— 本次的「provider 无 active 态」直接承接它

---

## 1. 动机

设置页存在两类问题:

1. **没有主次 / 杂乱**:「配置」tab 把 4 样异质内容平铺在一个滚动流里——Provider 配置(主)、实验性 CDP 开关、语言下拉、反馈卡片——同等视觉权重,用户找不到重点。反馈区还被一个重边框方框框住,突兀。
2. **样式偏「古早」**:满屏 1px 描边的盒子(每个 provider / skill 一个 bordered card)、满屏 JetBrains Mono 全大写小标签,是一种偏老的开发者工具气质。

Chat 侧:排队发送组件用洋红(`--c-pending` ≈ #B040AC/#C260BE),和整体 slate 灰蓝 accent 不协调,显得跳。

**目标**:在**保持现有 slate 设计系统**(配色 token + Inter / JetBrains Mono)的前提下,重组信息架构、现代化组件语言、修掉不协调的配色。

## 2. 已锁定的决策

| 决策 | 选择 |
|---|---|
| 视觉语言 | **保持现有 slate 系统**,只重组层级 + 现代化组件,不换配色/字体 |
| 设置页 IA | 顶栏拆两行;新增第 4 个 **「通用」** tab;次要项(语言/实验/反馈/关于)从「配置」抽出独立成区 |
| 组件语言 | **方向 A · 人性化通透**(落选:方向 B 精炼技术流) |
| 语言控件 | 下拉按钮 + 内联菜单(可无限扩展;不用分段控件) |
| 反馈 | 去掉重方框 → 两个文字入口 |
| 排队配色 | 洋红 → **黄铜/琥珀**(方向 D2) |
| Provider active 态 | **取消**(模型选择已解耦到 composer,设置里 provider 平等罗列) |
| 内置技能 | **不在技能 tab 列出**(走 system-prompt catalog / use_skill 中介);技能 tab 只显示用户技能 |

## 3. 设计语言 · 方向 A「人性化通透」

核心一句话:**去盒子、加留白、把系统标签人性化,mono 只留给技术数据。**

### 3.1 规则

1. **去盒子 → 统一面板**:同类条目(provider 列表、skill 列表)合并进**一个面板**(圆角 14,`surface` 填充,**无外描边**),条目之间用 `border-top` hairline 分隔——而不是每条一个 bordered card + gap。
2. **section 标题人性化**:用自然中文标题(顶级 16px / 子区 15px,Inter 600,letter-spacing ≈ -0.01em,`fg-1`),取代 mono 全大写小标签。
3. **mono 只留给技术 meta**:API key、计数、tools 列表、版本号、`AES-GCM` 这类才用 JetBrains Mono;且多为 `fg-3` 弱化。
4. **软 field**:输入框 / 下拉用 `field` 填充、**无边框**(focus 时才上 `accent-line`),圆角 10。
5. **filled 主按钮**:`fg-1` 填充 + `canvas` 文字(沿用现有 New skill 按钮风格);次按钮 = `line` 描边 ghost;危险操作 = `warning` 纯文字。
6. **大头像 / 大留白**:provider 头像 36px 圆角 11;条目竖向 padding 14–15px;section 间距 18–24px。
7. **soft pill 标签**:`vision` / `tools` 等用 `accent-tint` 填充的小胶囊(mono 10px,`fg-2`),不再用描边 tag。

### 3.2 Token 映射(关键:几乎全用现有 token,低改动)

A 语言用到的颜色基本都能落到 `index.css` 现有 token,**唯一需要改值的是 `--c-pending`**:

| 原型里的色 | 现有 token | 用途 |
|---|---|---|
| `#0B0D10`(dark) | `--c-canvas` | 页面底 |
| `#14171C` | `--c-surface` | 统一面板 / 卡片填充 |
| `#1A1E25` | `--c-field` | 输入框 / 下拉 / 头像底 |
| `#0E1216` | `--c-surface-deep` | 编辑表单内嵌「抽屉」底 |
| `#22272F` | `--c-line` | 面板内 hairline 分隔(原型用了更暗的 #1E232A;落地**优先复用 `--c-line`**,若显重再引入 `--c-hairline`) |
| `#E5E8EC` | `--c-fg-1` | 主文字 / filled 按钮底 |
| `#8A929E` / `#525965` | `--c-fg-2` / `--c-fg-3` | 次要 / 三级文字 |
| `#B8C8D6` | `--c-accent` | 强调、勾选、链接 |
| `rgba(184,200,214,0.08)` | `--c-accent-tint` | soft pill 底 |

> 落地不是「照抄 hex」,而是**用上表把原型的视觉翻译成现有 Tailwind class / token**。实现时对 Paper 节点用 `get_jsx` / `get_computed_styles` 取精确间距,再映射。

## 4. 信息架构 · 设置页顶栏

- **第 1 行(Header)**:`← 设置`(back 28×28 + 标题 17px/600)。
- **第 2 行(TabBar)**:**通栏 4 格分段** `配置 · 技能 · 搜索 · 通用`,各 `flex:1`,边框 `line` + 圆角 8,active 格 `field` 填充 + `fg-1`/500,非 active `fg-2`/400,格间 `border-left` 分隔。
- 替代现状:tab 挤在标题右侧的 3-tab(`Settings.tsx` 的 `SegmentedTabs`)。
- `Tab` 类型从 `"configs" | "skills" | "search"` 扩为加 `"general"`。

## 5. 逐屏规格

### 5.1 配置 tab(`✦ R-FINAL · 配置 · 列表` + `… · 编辑表单`)
- 顶部:`我的配置`(16/600)+ 右侧 `N 个 · M 个可接入`(`fg-3`)。
- **Provider 列表 = 一个统一面板**,每行:头像(36,首字母,`field` 底、`fg-2` 字)+ 名称(14/500)+ masked key(mono 11,`fg-3`)+ 右侧 chevron。**所有行平等**,无 active/「使用中」。行间 `border-top` hairline。
- 底部:`+ 新建配置` ghost 行(`line` 描边、圆角 12、accent 文字)。
- **展开编辑(行内抽屉)**:点行 → chevron 翻转朝上,行下方展开 `surface-deep` 内嵌区,含表单:
  - `昵称 · 可选` → 软 field
  - `API Key`(右侧 `AES-GCM · 本地加密` mono 提示)→ 软 field + `显示`
  - `模型`(右侧 `12 内置 · 1 自定义`)→ 子面板(圆角 10),每行 model id(mono)+ `vision`/`tools` soft pill;自定义行额外带 编辑/× 且底色微 accent-tint;末行 `+ 添加自定义模型`
  - 操作:`测试连接`(ghost)· `保存`(filled)· 右对齐 `删除`(warning 文字)
- **新建配置向导**(`NewConfigWizard`):**复用同一套表单**,差异 = 顶部多一个「从 8 个 provider 选 1」的选择步骤、无「删除」、按钮为「创建」。未单独出原型,落地照搬编辑表单语言即可。

### 5.2 技能 tab(`✦ R-FINAL · 技能`)
- 顶部容量头:`技能`(16/600)+ `N 个 · X KB / 1 MB`(mono `fg-3`)+ 右侧 `+ 新建技能`(filled);下方一条 4px 细进度条(`accent` 填充 / `field` 槽,≥80% 转 `warning`)。
- **只显示用户技能**(无「内置技能」段,无冗余「我的技能」子标题):一个统一面板,每行:启用圆点(开=`accent` 实心 / 关=`line` 描边)+ `/slug`(mono 12,`accent`)+ 右侧 `USER`/`AGENT` tag(mono `fg-3`)+ 描述(12,`fg-2`)+ meta 行(`N 个工具 · X KB` mono `fg-3`,右侧 `编辑` / `删除`)。
- 注:`SkillsList.tsx` 现状本就不渲染 built-in 段(只 `custom = !builtIn`),与本设计一致。

### 5.3 搜索 tab(`✦ R-FINAL · 搜索`)
- 顶部:`网页搜索`(16/600)+ 右侧状态(`● 已验证` accent / `未配置` fg-3);下方一句说明(12,`fg-2`)。
- **去框的 key 面板**(`surface`/圆角 14):`API Key` 标签 + `AES-GCM · 本地加密` mono 提示;masked key 软 field;`X 前验证` + 右侧 `重新测试` 链接。
- 操作:`更换密钥`(ghost)· `移除`(warning 文字)。
- 空态:同面板内 `tvly-····` 占位 + `+ 添加密钥`,下方说明 + `获取 key — 每月 1000 次免费 ↗`。

### 5.4 通用 tab(新)(`✦ R-FINAL · 通用`)
4 个独立区,自然中文标题(15/600):
- **语言**:下拉按钮(软 field,显示当前值 `跟随系统` + chevron),点开内联菜单,当前项 `accent` 勾选;**加语言只追加菜单行,布局不变**。
- **实验性功能**(右侧 `默认关闭` mono 提示):**去框**的一行(`surface` 填充、无描边、圆角 14)—— `CDP 键盘输入` 标题 + 说明 + 右侧开关;开启时下方展开 `warning-tint` 警告块(沿用现有文案)。
- **反馈**:**无方框** —— 一句说明 + 两个文字入口 `提交 GitHub Issue ↗`(accent)/ `发送邮件 ↗`(`fg-2`)。沿用 `buildGithubNewIssueUrl` / `buildFeedbackMailto`。
- **关于**:一条 hairline 分隔 + 版本页脚(Pie wordmark + `v0.20.0` mono + `BYOK · 本地优先 · 开源` + 右侧 `更新日志 ↗`)。

### 5.5 Chat 排队组件(`✦ R-FINAL · Composer 排队配色`,选 D2)
- `PendingInstructionList.tsx` 把洋红圆点 + caption 改成**黄铜/琥珀**;hover 边框等连带。
- `index.css` `--c-pending` 改值:
  - dark:`#C260BE` → **`#B89968`**(原型 D2 值)
  - light:`#B040AC` → **黄铜暗调,候选 ≈ `#8A6D2E`,需在 `#FAFBFC` 上做对比度复核后定**
- 语义不变(pending 仍是独立于 accent/warning 的状态色),只换色相。

## 6. 受影响文件(实施清单)

| 文件 | 改动 |
|---|---|
| `src/sidepanel/components/Settings.tsx` | 顶栏拆两行;`SegmentedTabs` 改通栏 4 格;`Tab` 加 `"general"`;新增「通用」tab 渲染(迁入 `CdpInputSection` + 语言 + `FeedbackSection` + 新增 About);「配置」tab 卸掉这三块;`FeedbackSection` 去框改文字入口;语言 `<select>` → 自定义下拉按钮+菜单 |
| `src/sidepanel/components/InstancesList.tsx` | provider 行改统一面板 + hairline + 大头像;去掉 active/「使用中」相关呈现 |
| `src/sidepanel/components/InstanceForm.tsx` | 表单改 A 语言:软 field、人性化 label、模型管理 soft pill、filled 保存按钮、内嵌抽屉底 |
| `src/sidepanel/components/NewConfigWizard.tsx` | 复用新表单语言;provider 选择步骤现代化;无删除 |
| `src/sidepanel/components/SkillsList.tsx` | 容量头 + 单一用户技能面板(hairline 行);soft pill / filled 按钮;确认无 built-in 段 |
| `src/sidepanel/components/SearchProviderSection.tsx` | 去框 key 面板 + 人性化标题/状态 + 软 field |
| `src/sidepanel/index.css` | **仅 `--c-pending` 改值(light + dark)**;视情况加 `--c-hairline` |
| i18n(`src/lib/i18n`) | 新增 `settings.tabs.general`、`settings.about.*`、语言/实验/反馈区的人性化文案 key;复核现有 key 是否仍贴合(去掉 mono caps 风味的英文短语) |

## 7. 非目标 / Open items

- **非目标**:不改 slate 调色板与字体;不改任何功能/数据流(纯呈现层);不动 Chat 消息流、会话抽屉、composer 主体。
- **Open items(已于实现期敲定)**:
  - ① light-mode `--c-pending` → **`#8A6D2E`**(在 `#FAFBFC` 上约 4.4:1,作为装饰性状态 caption/圆点够用;若真机要更严 AA,可下调到 `#7A5F20` 量级)。dark = `#B89968`。
  - ② 内嵌 hairline → **复用 `--c-line`**(未新增 `--c-hairline`);最终整体 review 确认 6 个组件的面板分隔一致、无需额外 token。
  - ③ 新建向导 provider 选择步骤 → 复用编辑表单的 Modern A 语言,**未出独立原型也未单独重做**(`ProviderDropdown`/`CustomProviderFields` 内部样式保持原样,作为后续 polish 备选,不阻塞本次)。
  - ④ 实现期发现并修掉:en 字典里 `LANGUAGE`/`FEEDBACK`/`CAPACITY`/`EDIT SKILL`/`NEW SKILL` 等全大写值在去 mono-caps 后会刺眼,已 humanize;`settings.about.sectionTitle` 死键已删。

## 8. Paper 索引(实现时打开取精确值)

文件 `Pie Frontend` · fileId `01KQH5T49RW8RTNMMSTKD1EQEZ`。**要落地的版本(画板名以 `✦ R-FINAL` 开头):**

| 画板名 | id | 对应 |
|---|---|---|
| ✦ R-FINAL · 配置 · 列表 (Modern A) | `31N-0` | 配置 tab 折叠列表 |
| ✦ R-FINAL · 配置 · 编辑表单 (Modern A) | `35R-0` | provider 行展开 = 编辑/新建表单 |
| ✦ R-FINAL · 技能 (Modern A) | `2WS-0` | 技能 tab |
| ✦ R-FINAL · 搜索 (Modern A) | `305-0` | 搜索 tab |
| ✦ R-FINAL · 通用 (Modern A) | `2OR-0` | 通用 tab(新) |
| ✦ R-FINAL · Composer 排队配色 (D2 黄铜) | `2RJ-0` | 排队组件配色(取中间 D2 那组) |

参考/留档:`2QJ-0`(语言控件 A/B 对比,选 A)。**忽略** `✗` 开头画板(`2TB-0` 旧样式、`33C-0` 落选 Modern B)。
