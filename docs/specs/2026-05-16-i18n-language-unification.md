# Spec: Language Unification & UI i18n

- **Date:** 2026-05-16
- **Status:** Draft (awaiting user review)
- **Owner:** wenkang.xie
- **Scope:** sidepanel UI i18n + skill/tool description 语言统一 + builtin skill 可见性收敛

## 1. Background & Motivation

当前项目语言现状（调研结论）：

| 层 | 状态 |
|---|---|
| Agent system prompt / tool description / 大部分 builtin skill | 已统一英文 |
| `src/lib/skills/builtin.ts` 的 `create_skill_from_recording` | description / parameter description / 注释中英文混用 |
| `src/sidepanel/**` 组件 | ~30% 硬编码中文（按钮、占位符、错误、status label），与英文 ASCII label 混存 |
| Manifest name / description | 写死英文，无 `default_locale`，无 `_locales/` |
| chrome.i18n API / i18n library | 完全未使用 |

目标：
1. **LLM 可见字符串统一英文**——skill / tool description / system prompt 等所有进入 LLM context 的文本固定英文（保稳定语义）。
2. **UI 字符串走 i18n**——所有 sidepanel 用户可见字符串通过运行时翻译机制；默认英文，跟随 Chrome UI 语言；Settings 提供手动 override。
3. **Builtin skill 可见性收敛**——builtin skill/tool 不展示在 Skills 列表中、默认全部启用；老用户 storage 中遗留的显式禁用条目通过一次性 migration 清理。

不在 scope：
- AI 回答语言（保持现状由用户输入隐式决定，不在 prompt 注入语言指令）。
- 数字 / 日期 / 时间格式化。
- 多于 `en` / `zh-CN` 的语言（架构预留可扩展位但不立即实现）。
- background / docs / release notes / Chrome Web Store listing 的多语言翻译。

## 2. Architecture & Module Boundaries

新增模块：`src/lib/i18n/`，自成叶子模块，仅依赖 `chrome` API。

```
src/lib/i18n/
  index.ts                ← public API: t, I18nProvider, useT, setLocale, getLocale
  locale-resolver.ts      ← resolve 顺序：storage override → chrome.i18n.getUILanguage() → 'en'
  types.ts                ← Dictionary type + Locale enum + key 类型推导
  use-t.ts                ← React Context + Provider + useT hook
  dictionaries/
    en.ts                 ← source of truth；其它语言以它为类型基准
    zh-CN.ts              ← satisfies Dictionary，缺 key = 编译失败
  __tests__/
    locale-resolver.test.ts
    t.test.ts
    dictionary-parity.test.ts
```

依赖关系：
- `src/sidepanel/**` 单向依赖 `src/lib/i18n/`；通过 `<I18nProvider>` 包 root，组件用 `const t = useT()`。
- `src/background/**` 不接入（无 UI 字符串）。
- `src/lib/agent/**` / `src/lib/skills/**` / `src/lib/agent/tools/**` **不接入**——它们的描述是 LLM 可见的，硬编码英文。
- Manifest `name` / `description` 单点走 `chrome.i18n` 的 `__MSG__` 机制（`_locales/{en,zh_CN}/messages.json` + `default_locale: "en"`）；和 `src/lib/i18n/` 在代码层互不相交。

Locale 标识：
- 内部统一 BCP-47：`'en'` / `'zh-CN'`。
- `chrome.i18n.getUILanguage()` 归一规则：前缀 `zh` → `'zh-CN'`；其余一律 fallback `'en'`。
- Storage key：`ui_locale`，值 `'auto' | 'en' | 'zh-CN'`；`'auto'` 表示跟随 Chrome。

## 3. UI Migration Scope

**入场（必须走 `t(key)`）：**
- `src/sidepanel/**` 下所有用户可见硬编码字符串。
- 包括但不限于：button label、placeholder、aria-label、title、toast、dialog、错误/状态提示、ASCII 风格 section header（`STEP 1 — SELECT PROVIDER`、`PROVIDER`、`MODEL` 等）。

**不入场：**
- `src/lib/agent/tools/**` 的 tool description / parameter description。
- `src/lib/skills/builtin.ts` 的 skill description / instructions / parameter description / 注释（顺手将 `create_skill_from_recording` 仍残留的中文翻为英文）。
- `src/lib/agent/prompt.ts` 等 system prompt 模板。
- `src/background/**` 的 console.log / dev-facing 错误信息。
- 数字 / 日期 / 时间格式（暂不入 scope）。

**Key 命名约定：**
- 按面板/组件分 namespace，扁平 dot-path：
  - `chat.elementPicker.idle`、`chat.elementPicker.active`
  - `settings.provider.title`、`settings.language.label`
  - `skills.empty.cta`
  - `errors.modelLoadFailed`、`errors.copyFailed`
  - 共享：`common.cancel`、`common.confirm`、`common.delete`、`common.save`

## 4. Builtin Skill 可见性 & Default-On 行为

### 4.1 现状

`src/lib/skills/builtin.ts` 中 5 个 builtin skill 的 `enabled` 字段：

| Skill ID | 当前 default |
|---|---|
| `extract_structured_data` | true |
| `auto_group_tabs` | true |
| `create_skill_from_recording` | true |
| `close_duplicate_tabs` | **false** |
| `close_inactive_tabs` | **false** |

`SkillsList.tsx` 同时展示 BUILT-IN + YOURS 分组，用户可对 builtin 做 toggle。`getEnabledSkills()` 读 storage `enabled_skills` 数组：纯 id = 启用，`'!<id>'` = 显式禁用。

### 4.2 变更后

- `builtin.ts`：5 个 skill 全部 `enabled: true`（含上面两个原 default-off 的 destructive skill）。
- `SkillsList.tsx`：移除 `BUILT-IN` 分组渲染，只展示 `YOURS`。Builtin skill 不再以任何形式出现在 UI；用户无法通过 UI 关闭。
- `getEnabledSkills()` 逻辑保持不变（继续尊重 storage 中 `'!<id>'` 条目，作为 dev/storage 手编后门）。

### 4.3 一次性 Migration: `enabled_skills_migrated_v1`

新文件 `src/lib/skills/migration-enabled-v1.ts`，在 sidepanel boot 入口跑一次：

```ts
async function migrateSkillsEnabledAllOn() {
  const { enabled_skills_migrated_v1 } = await chrome.storage.local.get('enabled_skills_migrated_v1');
  if (enabled_skills_migrated_v1) return;
  const { enabled_skills } = await chrome.storage.local.get('enabled_skills');
  const next = (enabled_skills ?? []).filter(
    (id: string) => typeof id === 'string' && !id.startsWith('!'),
  );
  await chrome.storage.local.set({
    enabled_skills: next,
    enabled_skills_migrated_v1: true,
  });
}
```

- 老用户 storage 中 `'!close_duplicate_tabs'` / `'!close_inactive_tabs'` 等遗留显式禁用项被清理，结果与新装用户一致：所有 builtin 跑起来。
- Flag 防重复执行；migration 失败不阻塞 boot（catch 后记 warn）。

## 5. Runtime Data Flow

### 5.1 启动 (sidepanel mount)

```
<I18nProvider> mount:
  1. resolveLocale():
       a. read chrome.storage.local['ui_locale']
            'en' / 'zh-CN' → 用之
            'auto' or 未定义 → 走 b
       b. chrome.i18n.getUILanguage() → normalize:
            startsWith('zh') → 'zh-CN'
            else → 'en'
  2. state = { locale, dict: dictionaries[locale] }
  3. children render via useT()
```

### 5.2 Settings 切换 locale

```
Settings <select onChange={(v) => setLocale(v)}>:
  setLocale(v):
    chrome.storage.local.set({ ui_locale: v })
    setState({ locale: resolved(v), dict: dictionaries[resolved(v)] })
```

- 即时重渲染，无需 reload。
- 多窗口同步：`chrome.storage.onChanged` 监听 `ui_locale`；同一 sidepanel 进程内已通过 setState 反映；其它 sidepanel 窗口收到 storage 事件后更新自身 state。

### 5.3 `t(key, params?)` 语义

- 命中当前 dict → 返回翻译值。
- 当前 dict 未命中 → fallback `en` dict → 命中返回；
- `en` dict 也未命中 → dev 模式 `console.warn`，返回 key 字符串本身。
- params 替换：`t('hello', { name: 'Alice' })` 对应 dict 值 `'Hello, {name}!'`，做简单字符串替换。不支持 plural / gender / ICU。

### 5.4 类型保证

- `Dictionary` 类型从 `en.ts` 推导（`as const` + deep readonly）。
- `zh-CN.ts` 必须 `satisfies Dictionary`，缺 key 编译报错、值类型不匹配编译报错。
- `t` 函数签名 `t<K extends DictKey>(key: K, params?: ParamsOf<K>)`：未注册 key 编译报错。
- Runtime parity test 作为额外兜底（防止 dict 文件用 `any` 或 type assertion 绕过）。

## 6. Settings UI Addition

`Settings.tsx` 顶部新增 "General" / "Appearance" 分组（若无则新建），加 `Language` 字段：

```
[ Language ]  ( ⌄  Auto (Follow Browser)  )
              ( ⌄  English                 )
              ( ⌄  中文                    )
```

- value 写入 `chrome.storage.local.ui_locale`；
- 切到 `Auto` 时显式写 `'auto'`（而非 delete key），保证 `chrome.storage.onChanged` 触发。

## 7. Manifest & Chrome Web Store Display

`manifest.json` 改动：

```diff
+ "default_locale": "en",
- "name": "Pie",
- "description": "BYOK Chrome Extension — ...",
+ "name": "__MSG_extension_name__",
+ "description": "__MSG_extension_description__",
```

新增：

```
_locales/en/messages.json
_locales/zh_CN/messages.json
```

每份只含：
- `extension_name`
- `extension_description`

（其它字符串走 `src/lib/i18n/`，不进入 `_locales/`，避免维护两套 i18n 来源。）

## 8. Testing Strategy

vitest + happy-dom + @testing-library/react。

新增测试：

- `src/lib/i18n/__tests__/locale-resolver.test.ts`
  - storage override 命中 'en' / 'zh-CN' / 'auto'
  - chrome.i18n.getUILanguage 返回 'zh-CN' / 'zh-TW' / 'en-US' / 'fr-FR'
  - 期望归一：zh-* → 'zh-CN'，其它 → 'en'
- `src/lib/i18n/__tests__/t.test.ts`
  - key 命中
  - key 未命中走 fallback dict
  - 两份都未命中 → 返回 key 字符串 + `console.warn` 被调用
  - params 替换正确
- `src/lib/i18n/__tests__/dictionary-parity.test.ts`
  - 深递归遍历 keys，断言 `zh-CN` 与 `en` 同构（防止 type assertion 绕过类型检查）
- `src/lib/skills/__tests__/migration-enabled-v1.test.ts`
  - storage 含 `'!close_duplicate_tabs'` → 跑 migration → 不含、flag 写入
  - 二次调用 → noop
  - 失败场景：storage.get throw → 不抛出、不写 flag
- `src/sidepanel/components/__tests__/Settings.test.tsx`（扩展或新建）
  - 切 Language select → `chrome.storage.local.set` 被以 `{ ui_locale: 'zh-CN' }` 调
  - I18nProvider 重新渲染 → `common.cancel` 节点文本变中文

不写：全量"每个组件用中文渲染"快照测试 —— dict parity test 已覆盖完整性，逐组件渲染重复价值低。

## 9. File-level Change List

**新增：**
```
manifest.json                                       (改: + default_locale + __MSG_*__)
_locales/en/messages.json                           (新)
_locales/zh_CN/messages.json                        (新)
src/lib/i18n/index.ts                               (新)
src/lib/i18n/locale-resolver.ts                     (新)
src/lib/i18n/types.ts                               (新)
src/lib/i18n/use-t.ts                               (新)
src/lib/i18n/dictionaries/en.ts                     (新)
src/lib/i18n/dictionaries/zh-CN.ts                  (新)
src/lib/i18n/__tests__/locale-resolver.test.ts      (新)
src/lib/i18n/__tests__/t.test.ts                    (新)
src/lib/i18n/__tests__/dictionary-parity.test.ts    (新)
src/lib/skills/migration-enabled-v1.ts              (新)
src/lib/skills/__tests__/migration-enabled-v1.test.ts (新)
```

**修改：**
```
src/lib/skills/builtin.ts                           (5 个 skill enabled = true; create_skill_from_recording 中文 → 英文)
src/sidepanel/main.tsx                              (包 <I18nProvider> + 启动跑 migration)
src/sidepanel/components/SkillsList.tsx             (移除 BUILT-IN 分组)
src/sidepanel/components/Settings.tsx               (新增 Language select; 全文 t-ify)
src/sidepanel/components/Chat.tsx                   (t-ify)
src/sidepanel/components/ModelDropdown.tsx          (t-ify)
src/sidepanel/components/NewConfigWizard.tsx        (t-ify)
src/sidepanel/components/SessionDrawer.tsx          (t-ify)
其它 sidepanel 组件                                 (按 grep 结果 t-ify)
```

最终 `grep -rn '[一-鿿]' src/sidepanel/` 应仅命中 `dictionaries/zh-CN.ts`。

## 10. Implementation Sequence (planning 阶段细化)

建议顺序（每一步独立可验证）：

1. 写 `src/lib/i18n/` 模块 + 单元测试。孤立验证，不接 UI。
2. 写 `migration-enabled-v1.ts` + 测试。
3. 改 `builtin.ts`：5 个 skill `enabled: true`、翻译 `create_skill_from_recording` 残留中文。
4. 改 `SkillsList.tsx`：隐藏 BUILT-IN 分组。
5. 在 `sidepanel/main.tsx` 包 `<I18nProvider>` + boot 时 `await migrateSkillsEnabledAllOn()`。
6. `Settings.tsx` 新增 Language select + 全文 t-ify。
7. 按组件 t-ify（Chat / ModelDropdown / NewConfigWizard / SessionDrawer 等），同步往两份 dictionary 加 key。
8. 改 `manifest.json` + 加 `_locales/{en,zh_CN}/messages.json`。
9. `pnpm test` + `pnpm build` + Chrome reload 手工冒烟。

## 11. Acceptance Criteria

- [ ] `pnpm test` 全绿（含本 spec 新增的所有 test）。
- [ ] `pnpm build` 通过（含 `risk.ts` / `tool-names.ts` 等 build-time invariants）。
- [ ] `grep -rn '[一-鿿]' src/sidepanel/` 命中数 = 仅 `dictionaries/zh-CN.ts`。
- [ ] `grep -rn '[一-鿿]' src/lib/agent/ src/lib/skills/` 命中数 = 0。
- [ ] 手工：Chrome UI 设 `en`，扩展全 UI 英文；Chrome UI 设 `zh-CN`，扩展全 UI 中文。
- [ ] 手工：Settings → Language 切换即时生效，无需 reload。
- [ ] 手工：装一个全新 profile，Skills 列表只有 YOURS 分组（空状态），agent 自动跑 close_duplicate_tabs 类指令可命中 skill prompt。
- [ ] 手工：模拟老用户 storage（含 `'!close_duplicate_tabs'`），首次启动后该项被清理、`enabled_skills_migrated_v1: true` 写入。

## 12. Out-of-Scope / Future Work

- AI 回答语言策略（如未来需要"跟随 UI 语言"或"用户在 Settings 单独选"，本 spec 的 `src/lib/i18n/` 已经提供 `getLocale()` 入口供 prompt builder 注入）。
- 多于 `en` / `zh-CN` 的语言：架构上 `dictionaries/` 目录可直接增文件 + 在 `Locale` 枚举增成员，但翻译工作量与质量保证另立 spec。
- 数字 / 日期 / 时间格式化（`Intl.NumberFormat` / `Intl.DateTimeFormat` 入场时点未到）。
- `docs/`、release notes、Chrome Web Store listing 翻译。
