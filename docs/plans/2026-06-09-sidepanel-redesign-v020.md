# 侧栏体验重做 v0.20 · 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (推荐) 或 superpowers:executing-plans 逐任务实现。步骤用 `- [ ]` 复选框跟踪。

**Goal:** 在保持 slate 设计系统的前提下,重组设置页 IA(4 tab)、把组件语言现代化(方向 A「人性化通透」)、把 Chat 排队组件配色从洋红换成黄铜。

**Architecture:** 纯呈现层改造,不动数据流/功能。复用现有 `index.css` token(仅 `--c-pending` 改值)。设置页顶栏拆两行 + 通栏 4 格 tab;次要项迁入新「通用」tab;各子页从「一堆 bordered card」改为「统一面板 + `border-top` hairline 行」;section 标题人性化,mono 只留技术 meta。

**Tech Stack:** React 19 + TS · TailwindCSS v4(token 在 `src/sidepanel/index.css`)· vitest + happy-dom · i18n 双字典(`src/lib/i18n/dictionaries/{zh-CN,en}.ts`,parity 测试强制对齐)。

**设计依据:** `docs/specs/2026-06-09-sidepanel-redesign-v020.md`(含逐屏规格 + token 映射 + Paper 画板索引)。

---

## 测试哲学(本 plan 适用)

这是呈现层重做,纯 className/结构改动占多数。测试策略分两类:

1. **行为变更 → TDD**(先写失败测试):新「通用」tab 路由、语言下拉交互。
2. **纯视觉变更 → 回归网兜底**:每个任务后 `pnpm test`(1896 baseline)+ `pnpm typecheck` + `pnpm build` 必须全绿;视觉对照对应 Paper 画板(用 `get_jsx`/`get_computed_styles` 取精确 px,**不照截图估**)。改了结构导致现有组件测试断言失效的,**在同一任务里更新该测试**(注意是因结构合理变化而更新,不是为了让测试过而删断言)。

**精确视觉值来源**:文件 `Pie Frontend`(fileId `01KQH5T49RW8RTNMMSTKD1EQEZ`),画板 id 见 spec 第 8 节。`✦ R-FINAL` 开头为准,忽略 `✗` 开头。

**Token 速查(dark / 已在 index.css):** canvas `#0B0D10`=`bg-canvas` · surface `#14171C`=`bg-surface`(统一面板)· field `#1A1E25`=`bg-field`(输入/头像底)· surface-deep `#0E1216`=`bg-[var(--c-surface-deep)]`(表单内嵌抽屉)· line `#22272F`=`border-line`(面板内 hairline)· fg-1/2/3=`text-fg-1/2/3` · accent `#B8C8D6`=`text-accent`/`bg-accent` · accent-tint=`bg-accent-tint`(soft pill)。filled 主按钮=`bg-fg-1 text-canvas`。

---

## 文件结构(改动地图)

| 文件 | 职责 / 改动 |
|---|---|
| `src/sidepanel/index.css` | `--c-pending` 改黄铜值(dark+light)。**唯一 token 改动**。 |
| `src/lib/i18n/dictionaries/zh-CN.ts` · `en.ts` | 加 `tabs.general`、`settings.about.*`;humanize en 的全大写 section 值。两字典必须对齐。 |
| `src/sidepanel/components/Settings.tsx` | 顶栏两行;`Tab` 加 `"general"`;`SegmentedTabs` 4 格;新增「通用」tab(迁入语言/实验/反馈 + 新增 About);「配置」tab 卸掉这三块;`FeedbackSection` 去框;语言 `<select>`→自定义下拉。 |
| `src/sidepanel/components/LanguageSelect.tsx` | **新建**:下拉按钮 + 内联菜单(可扩展语言)。 |
| `src/sidepanel/components/InstancesList.tsx` | 统一面板 + hairline 行 + 36px 头像;去 active 呈现。 |
| `src/sidepanel/components/InstanceForm.tsx` | `Field` label 人性化;软 field;filled 保存;内嵌抽屉底色。 |
| `src/sidepanel/components/ProviderModelList.tsx` | model 行 → soft pill 标签(vision/tools)。 |
| `src/sidepanel/components/NewConfigWizard.tsx` | 容器 + actions 行套 A 语言。 |
| `src/sidepanel/components/SkillsList.tsx` | 容量头人性化;单一用户技能面板(hairline 行);pill + filled 按钮。 |
| `src/sidepanel/components/SearchProviderSection.tsx` | 去框 key 面板;人性化标题/状态;软 field。 |

> 不引入大型共享组件(沿用本仓库「每组件内联 Tailwind」惯例)。humanized section 标题就是 `text-[16px] font-semibold tracking-[-0.01em] text-fg-1`(子区 15px),各组件内联即可。

---

## Task 1：排队组件配色 → 黄铜(独立快赢)

**Files:**
- Modify: `src/sidepanel/index.css`(`--c-pending` 三处:`:root` dark? 见下、`@media dark`、`[data-theme=light]`、`[data-theme=dark]`)

`PendingInstructionList.tsx` 用 `bg-pending`/`text-pending`(映射 `--color-pending`→`--c-pending`),改 token 自动级联,**组件本身不用动**。

- [ ] **Step 1：确认 pending 用法范围**

Run: `grep -rn "pending\b\|c-pending\|color-pending" src/sidepanel/index.css src/sidepanel/components/PendingInstructionList.tsx`
Expected: 命中 index.css 的 `--c-pending` 定义 + `--color-pending` @theme 映射 + 组件里的 `bg-pending`/`text-pending`。确认无其它组件硬编码洋红。

- [ ] **Step 2：改 `--c-pending` 值**

`index.css` 里 `--c-pending` 出现在 4 处(`:root` 默认 = light、`@media (prefers-color-scheme: dark)`、`[data-theme="light"]`、`[data-theme="dark"]`)。改为黄铜:
- light 两处(`:root` + `[data-theme="light"]`):`#B040AC` → `#8A6D2E`
- dark 两处(`@media dark` + `[data-theme="dark"]`):`#C260BE` → `#B89968`

```css
/* light */  --c-pending: #8A6D2E;
/* dark  */  --c-pending: #B89968;
```

- [ ] **Step 3:对比度复核(light)**

light 黄铜 `#8A6D2E` 在 `#FAFBFC`(canvas)上做正文/小字对比度目测(原型只验过 dark)。若偏浅看不清,下调到 `#7A5F20` 量级。dark `#B89968` 已在原型 D2 验过。

- [ ] **Step 4:build + 视觉**

Run: `pnpm build`
Expected: 成功。对照 Paper `✦ R-FINAL · Composer 排队配色`(`2RJ-0`,取中间 D2 组)确认 dark 一致。

- [ ] **Step 5:commit**

```bash
git add src/sidepanel/index.css
git commit -m "feat(pending): recolor queued-send indicator magenta → brass"
```

---

## Task 2：i18n —— 新增 key + humanize en

**Files:**
- Modify: `src/lib/i18n/dictionaries/zh-CN.ts`(`settings` 段,~L43-103)
- Modify: `src/lib/i18n/dictionaries/en.ts`(对应段)
- Test: `src/lib/i18n/__tests__/dictionary-parity.test.ts`(已存在,自动校验对齐)

- [ ] **Step 1:跑 parity 测试确认起点绿**

Run: `pnpm test src/lib/i18n/__tests__/dictionary-parity.test.ts`
Expected: PASS。

- [ ] **Step 2:zh-CN 加 key**

在 `settings` 段内:
```ts
tabs: { configs: "配置", skills: "技能", search: "搜索", general: "通用" },
about: {
  sectionTitle: "关于",
  tagline: "BYOK · 本地优先 · 开源",
  changelog: "更新日志",
},
```
（`tabs` 在已有行上加 `general: "通用"`。)

- [ ] **Step 3:en 加 key + humanize 全大写值**

en 对应:
```ts
tabs: { configs: "Configs", skills: "Skills", search: "Search", general: "General" },
about: { sectionTitle: "About", tagline: "BYOK · Local-first · Open source", changelog: "Changelog" },
```
并把 en 里用作 section 标题的全大写值改成自然 Title case(配合方向 A 去 mono-caps):`experimental: "EXPERIMENTAL"`→`"Experimental"`;`searchProvider.caps: "WEB SEARCH"`→`"Web search"`(以实际现值为准,zh 多已是自然中文,不动)。

- [ ] **Step 4:parity + 全量 i18n 测试**

Run: `pnpm test src/lib/i18n`
Expected: PASS(parity 绿即证明两字典 key 对齐)。

- [ ] **Step 5:commit**

```bash
git add src/lib/i18n/dictionaries/zh-CN.ts src/lib/i18n/dictionaries/en.ts
git commit -m "i18n: add general-tab + about keys, humanize en section labels"
```

---

## Task 3：设置页顶栏(两行 + 4 格 tab)+「通用」tab 路由

**Files:**
- Modify: `src/sidepanel/components/Settings.tsx`(`Tab` 类型 L41、`SegmentedTabs` L334-373、header L134-153、configs/skills/search 渲染 L155-328、`FeedbackSection` L375-409、`CdpInputSection` L411-455)
- Test: `src/sidepanel/components/__tests__/SettingsTabs.test.tsx`(**新建**)

- [ ] **Step 1:写失败测试**

```tsx
// src/sidepanel/components/__tests__/SettingsTabs.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import Settings from "../Settings";

function renderSettings() {
  return render(<Settings onBack={() => {}} />);
}

test("通用 tab 承载语言/实验/反馈/关于,配置 tab 不含这些", async () => {
  renderSettings();
  // 默认在「配置」:不应出现语言/反馈区
  expect(screen.queryByText("实验性功能")).not.toBeInTheDocument();
  // 切到「通用」
  fireEvent.click(screen.getByRole("button", { name: "通用" }));
  expect(await screen.findByText("实验性功能")).toBeInTheDocument();
  expect(screen.getByText("反馈")).toBeInTheDocument();
  expect(screen.getByText("关于")).toBeInTheDocument();
});
```

- [ ] **Step 2:跑测试确认失败**

Run: `pnpm test src/sidepanel/components/__tests__/SettingsTabs.test.tsx`
Expected: FAIL(「通用」tab 不存在 / 切换后找不到「实验性功能」)。

- [ ] **Step 3:扩 Tab 类型 + 4 格 tab**

`Settings.tsx` L41:`type Tab = "configs" | "skills" | "search" | "general";`
`SegmentedTabs`(L334)加第 4 项 `{ id: "general", label: t("settings.tabs.general") }`,并把 tab 栏从 header 内移到 header 下方独立一行、改为通栏 `flex w-full` 各格 `flex-1`(精确样式取 Paper `2OR-0` 的 `TabBar Row`/`Segmented`)。header(L134)只留 back + 标题,标题升到 `text-[17px]`。

- [ ] **Step 4:迁移次要项到「通用」tab**

把 `CdpInputSection`、语言 `<section>`(L298-320)、`<FeedbackSection>`(L322)从 `tab === "configs"` 分支移除;新增 `tab === "general"` 分支按顺序渲染:语言(用 Task 4 的 `<LanguageSelect>`)、`<CdpInputSection>`、`<FeedbackSection>`、`<AboutSection>`(下条新建)。「配置」分支只剩 InstancesList + 新建按钮。

- [ ] **Step 5:新增 AboutSection + section 标题人性化**

在 `Settings.tsx` 末尾加:
```tsx
function AboutSection() {
  const t = useT();
  const v = chrome.runtime.getManifest().version;
  return (
    <section className="flex flex-col gap-3.5">
      <div className="h-px w-full bg-line" />
      <div className="flex items-center gap-2.5">
        {/* Pie mark + 版本 + 更新日志链接,取 Paper 2OR-0 About 区精确值 */}
        <span className="text-[13px] font-semibold text-fg-1">Pie</span>
        <span className="font-mono text-[11px] text-fg-2">v{v}</span>
        <span className="text-[11px] text-fg-3">· {t("settings.about.tagline")}</span>
        <div className="flex-1" />
        <a href="https://github.com/WiseriaAI/pie-ai-agent/releases" target="_blank" rel="noreferrer" className="text-[12px] text-fg-2">{t("settings.about.changelog")} ↗</a>
      </div>
    </section>
  );
}
```
各 section 的 caps 标题(`<div className="caps text-fg-3">`)改人性化:`<div className="text-[15px] font-semibold tracking-[-0.005em] text-fg-1">`(语言/实验性/反馈/关于)。`CdpInputSection` 内的 caps 同改。

- [ ] **Step 6:测试通过 + 回归**

Run: `pnpm test src/sidepanel/components/__tests__/SettingsTabs.test.tsx && pnpm test src/sidepanel/components/Chat.test.tsx`
Expected: PASS。

- [ ] **Step 7:commit**

```bash
git add src/sidepanel/components/Settings.tsx src/sidepanel/components/__tests__/SettingsTabs.test.tsx
git commit -m "feat(settings): 4-tab IA, move language/experimental/feedback into General tab"
```

---

## Task 4：语言下拉控件(替代原生 select)

**Files:**
- Create: `src/sidepanel/components/LanguageSelect.tsx`
- Test: `src/sidepanel/components/__tests__/LanguageSelect.test.tsx`(**新建**)
- Modify: `src/sidepanel/components/Settings.tsx`(「通用」tab 引用)

- [ ] **Step 1:写失败测试**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import LanguageSelect from "../LanguageSelect";
import * as i18n from "@/lib/i18n";

test("点开菜单选项 → 调 setLocale", () => {
  const spy = vi.spyOn(i18n, "setLocale").mockResolvedValue(undefined as never);
  render(<LanguageSelect />);
  fireEvent.click(screen.getByRole("button"));          // 展开
  fireEvent.click(screen.getByText("English"));         // 选 en
  expect(spy).toHaveBeenCalledWith("en");
});
```

- [ ] **Step 2:跑测试确认失败**

Run: `pnpm test src/sidepanel/components/__tests__/LanguageSelect.test.tsx`
Expected: FAIL(模块不存在)。

- [ ] **Step 3:实现 LanguageSelect**

下拉按钮(`bg-field rounded-[10px] px-3 py-2.5`,显当前值 + chevron)+ 点开 popover 菜单(`bg-surface rounded-[9px] border border-line`,选项行 `px-2.5 py-2 rounded-md`,当前项 `bg-accent-tint` + accent ✓)。选项 `auto/en/zh-CN`,标签取 `t("settings.language.optionAuto/optionEn/optionZhCN")`,初值读 `getConfig<string>("ui_locale")`,选中调 `setLocale(v)`。精确样式取 Paper `2QJ-0` Variant A。复用现有 `setLocale/getLocale` 与 `getConfig`(见旧 Settings L302-318)。

- [ ] **Step 4:接进「通用」tab + 测试通过**

Settings「通用」分支语言区改用 `<LanguageSelect />`。
Run: `pnpm test src/sidepanel/components/__tests__/LanguageSelect.test.tsx`
Expected: PASS。

- [ ] **Step 5:commit**

```bash
git add src/sidepanel/components/LanguageSelect.tsx src/sidepanel/components/__tests__/LanguageSelect.test.tsx src/sidepanel/components/Settings.tsx
git commit -m "feat(settings): scalable language dropdown replacing native select"
```

---

## Task 5：配置列表 InstancesList → 统一面板

**Files:**
- Modify: `src/sidepanel/components/InstancesList.tsx`(全量,61 行)
- Modify: `src/sidepanel/components/Settings.tsx`(L158-164 的 `<section>` 头改人性化「我的配置」16px)

- [ ] **Step 1:重写 InstancesList 为 A 面板**

容器从 `gap-px border bg-line`(描边盒子堆)改为单一面板:`flex flex-col rounded-[14px] bg-surface overflow-hidden`。每行:`flex items-center gap-3 px-[15px] py-[15px]`,非首行加 `border-t border-line`;头像 `ProviderIcon size={36}`(或 36px 圆角槽);名称 `text-[14px] font-medium`;masked key `font-mono text-[11px] text-fg-3`;右侧 chevron。**去掉任何 active/「使用中」呈现**(本来也没有,确认 `· {provider}` 副标题保留或并入 key 行)。展开区 `border-t border-line bg-[var(--c-surface-deep)]`。精确值取 Paper `35R-0`(含展开)+ `31N-0`(折叠)。

- [ ] **Step 2:检查/更新现有引用测试**

Run: `grep -rln "InstancesList" src/**/*.test.tsx; pnpm test src/sidepanel/components/Settings.tsx 2>/dev/null || true`
若有断言依赖旧结构(`border-line bg-line`),更新之。

- [ ] **Step 3:typecheck + build + 视觉**

Run: `pnpm typecheck && pnpm build`
Expected: 成功。对照 `31N-0`。

- [ ] **Step 4:commit**

```bash
git add src/sidepanel/components/InstancesList.tsx src/sidepanel/components/Settings.tsx
git commit -m "feat(settings): provider list as unified hairline panel (Modern A)"
```

---

## Task 6：编辑/新建表单 InstanceForm + 模型 pill

**Files:**
- Modify: `src/sidepanel/components/InstanceForm.tsx`(`Field` helper L247-257、各 field、actions L208-233)
- Modify: `src/sidepanel/components/ProviderModelList.tsx`(model 行 vision/tools → soft pill)
- Test: 现有 `src/sidepanel/components/InstanceForm.test.tsx`

- [ ] **Step 1:跑现有 InstanceForm 测试确认起点绿**

Run: `pnpm test src/sidepanel/components/InstanceForm.test.tsx`
Expected: PASS。

- [ ] **Step 2:`Field` label 人性化 + 软 field**

`Field`(L247)的 label 从 `font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3` 改 `text-[12px] font-medium text-fg-2`;hint 保留 mono `text-fg-3`(技术 meta)。各 input 从 `rounded border border-line bg-field` 改软 field `rounded-[10px] bg-field border border-transparent focus:border-accent-line`。Provider locked 行同步软化。

- [ ] **Step 3:actions 行套 A**

L208 默认 actions:`测试连接` ghost(`border border-line rounded-[10px]`)、`保存` filled(已是 `bg-fg-1 text-canvas`,圆角调 10、padding 加大)、`删除` 右对齐 warning 文字。精确取 Paper `35R-0` 的 Form Actions。

- [ ] **Step 4:模型 pill(ProviderModelList)**

`ProviderModelList.tsx` 里 vision/tools 标识改 soft pill:`font-mono text-[10px] text-fg-2 px-2 py-0.5 rounded-full bg-accent-tint`。自定义模型行底 `bg-accent-tint/40` + 编辑/× 图标。子面板容器 `rounded-[10px] bg-[#16191F]`/hairline 行。精确取 `35R-0` Models Panel。

- [ ] **Step 5:更新现有测试 + 回归**

更新 `InstanceForm.test.tsx` 中依赖旧 label 大小写/结构的断言(若有)。
Run: `pnpm test src/sidepanel/components/InstanceForm.test.tsx src/sidepanel/components/ProviderModelList.test.tsx`
Expected: PASS。

- [ ] **Step 6:typecheck + commit**

```bash
pnpm typecheck
git add src/sidepanel/components/InstanceForm.tsx src/sidepanel/components/ProviderModelList.tsx src/sidepanel/components/InstanceForm.test.tsx
git commit -m "feat(settings): edit/new config form in Modern A (soft fields, model pills)"
```

---

## Task 7：新建向导 NewConfigWizard 套壳

**Files:**
- Modify: `src/sidepanel/components/NewConfigWizard.tsx`(容器 L225、renderActions L393-420)
- Test: 现有 `src/sidepanel/components/NewConfigWizard.test.tsx`

- [ ] **Step 1:跑现有测试确认起点绿**

Run: `pnpm test src/sidepanel/components/NewConfigWizard.test.tsx`
Expected: PASS。

- [ ] **Step 2:容器 + actions 套 A**

外层 `rounded-lg border border-line bg-canvas`(L225)改 `rounded-[14px] bg-surface`(去描边、与列表面板一致)。`renderActions`(L394)按钮组套 A:取消/测试 ghost、创建 filled `bg-fg-1 text-canvas`。复用 InstanceForm 的新字段样式(Task 6 已改,自动继承)。provider 选择步骤(`ProviderDropdown`)外观对齐软 field。

- [ ] **Step 3:更新现有测试 + 回归**

更新依赖旧结构的断言(若有)。
Run: `pnpm test src/sidepanel/components/NewConfigWizard.test.tsx src/sidepanel/components/CustomProviderFields.test.tsx`
Expected: PASS。

- [ ] **Step 4:commit**

```bash
git add src/sidepanel/components/NewConfigWizard.tsx src/sidepanel/components/*.test.tsx
git commit -m "feat(settings): new-config wizard in Modern A"
```

---

## Task 8：技能 tab SkillsList → 单面板

**Files:**
- Modify: `src/sidepanel/components/SkillsList.tsx`(`CapacitySection` L323-367、`SkillsSection` L369-389、`SkillRow` L391-496)

- [ ] **Step 1:容量头人性化**

`CapacitySection`:caps `技能容量` → 人性化「技能」16px semibold + 副行 `N 个 · X KB / 1 MB`(mono fg-3);`新建技能` 按钮已是 `bg-fg-1 text-canvas`,圆角/padding 调 A。进度条保留。精确取 Paper `2WS-0`。

- [ ] **Step 2:用户技能单面板 + hairline 行**

`SkillsSection` 容器从 `gap-px border bg-line` 改单面板 `rounded-[14px] bg-surface overflow-hidden`;`SkillRow` 间用 `border-t border-line`。行内:启用圆点 + `/slug`(mono accent)+ USER/AGENT tag + 描述 + meta 行(工具数·KB,右侧 编辑/删除)。**确认无 built-in 段**(当前 `custom = !builtIn` 本就只渲染用户技能;若有残留 built-in 渲染,移除)。精确取 `2WS-0`。

- [ ] **Step 3:回归(SkillsList 无独立测试则跑全量相关)**

Run: `pnpm typecheck && pnpm build`
Expected: 成功。对照 `2WS-0`。

- [ ] **Step 4:commit**

```bash
git add src/sidepanel/components/SkillsList.tsx
git commit -m "feat(skills): single user-skill panel, humanized capacity (Modern A)"
```

---

## Task 9：搜索 tab SearchProviderSection → 去框

**Files:**
- Modify: `src/sidepanel/components/SearchProviderSection.tsx`(全量,272 行)
- Test: 现有 `src/sidepanel/components/SearchProviderSection.test.tsx`

- [ ] **Step 1:跑现有测试确认起点绿**

Run: `pnpm test src/sidepanel/components/SearchProviderSection.test.tsx`
Expected: PASS。

- [ ] **Step 2:重排为 A**

section 头改人性化「网页搜索」16px + 右侧状态(`● 已验证`/`未配置`);卡片从 `rounded-[9px] border border-line bg-surface`(L122)改去框面板 `rounded-[14px] bg-surface`(无描边);masked key 行软 field;操作 `更换密钥` ghost / `移除` warning 文字。emoji(`🙈/👁/🔒`,L216/220)换 SVG 图标。精确取 Paper `305-0`。

- [ ] **Step 3:更新现有测试 + 回归**

更新依赖旧 caps/结构/emoji 的断言。
Run: `pnpm test src/sidepanel/components/SearchProviderSection.test.tsx`
Expected: PASS。

- [ ] **Step 4:commit**

```bash
git add src/sidepanel/components/SearchProviderSection.tsx src/sidepanel/components/SearchProviderSection.test.tsx
git commit -m "feat(search): de-boxed search-provider panel (Modern A)"
```

---

## Task 10：全量验证 + 收尾

**Files:** 无新增(验证 + 可能的微调)

- [ ] **Step 1:全量测试**

Run: `pnpm test`
Expected: 205 files PASS,1896+ passed,0 失败(新增了 SettingsTabs/LanguageSelect 测试,总数略增)。

- [ ] **Step 2:typecheck + build(含构建期 invariant)**

Run: `pnpm typecheck && pnpm build`
Expected: 0 错;`tool-names.ts`/`tools.ts` 的 build-time invariant 不 throw。

- [ ] **Step 3:逐屏视觉对照**

`pnpm dev` 加载 `dist/`,逐 tab 对照 Paper `✦ R-FINAL` 6 张画板(配置列表/编辑表单/技能/搜索/通用 + 排队配色)。light + dark 都看(主题切换)。重点:① light 黄铜对比度;② 内嵌 hairline 用 `border-line` 是否偏重(偏重则引 `--c-hairline`);③ 4 格 tab 在 380px 不挤。

- [ ] **Step 4:更新 spec 的 Open items**

把 spec 第 7 节 Open items 里已敲定的(light 黄铜值、hairline 取舍)回填确定结论。

- [ ] **Step 5:最终 commit**

```bash
git add -A
git commit -m "chore(sidepanel-redesign): final verification + spec open-items resolved"
```

---

## Self-Review(spec 覆盖核对)

- IA 4-tab + 两行顶栏 → Task 3 ✓
- 次要项迁「通用」+ About → Task 3 ✓
- 语言下拉(可扩展)→ Task 4 ✓
- 反馈去框 → Task 3(FeedbackSection 改文字入口)✓
- 配置列表去盒子 + 无 active → Task 5 ✓
- 编辑/新建表单 A 化 + 模型 pill → Task 6/7 ✓
- 技能单面板 + 无内置段 → Task 8 ✓
- 搜索去框 → Task 9 ✓
- 排队黄铜(token light+dark)→ Task 1 ✓
- i18n 新 key + en humanize → Task 2 ✓
- 全量回归 + 视觉 + light 对比度 + hairline 取舍 → Task 10 ✓

非目标(不动):slate 调色板/字体、功能/数据流、Chat 消息流、会话抽屉、composer 主体。
