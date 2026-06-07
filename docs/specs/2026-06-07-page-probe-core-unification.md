# 网页探查/定位能力统一:单一注入 + op 的探查核心

- 日期:2026-06-07
- 状态:设计已批准,待出实施计划
- 分支:`feat/page-probe-core-unification`
- 类型:结构性重构(有行为变更,无数据迁移)

## 1. 背景与问题

最近几轮 editor 增强(#124/#125/#126 Monaco/CodeMirror CDP、#143 TinyMCE)只落在 `read_page` 这一侧,`search_page` 与定位侧完全没跟上。根因是:**网页探查/识别能力散落在多个注入函数里,靠手工 VERBATIM 复制 + 不完整的 parity 测试维持一致**,已经发生多处漂移。

### 1.1 承载点全景(谁在做"探查/定位")

| 承载点 | 性质 | 能否 import |
|---|---|---|
| `pageSnapshotInjected` (`dom-actions/page-snapshot.ts`) | 注入·探查 | ❌ executeScript 序列化函数体 |
| `searchPageInjected` (`dom-actions/search-page.ts`) | 注入·探查 | ❌ |
| `installCaptureListener` (`recording/capture.ts`) | 注入·录制识别 | ❌ |
| action 定位(`type.ts`/`select.ts`/`geometry.ts`/`keyboard.ts` 的 `focusClickByIndex`) | 注入·消费 idx(executeScript-func) | ❌ |
| `editor.ts` 的 `locatorFragment` | 注入·消费 idx(CDP-evaluate-string) | ❌ |
| 模块侧(`dom-walk.ts`/`_shared/interactive.ts`/`recording/selector.ts`) | 可 import 的权威源 | ✅ |

根本障碍:注入函数不能 import 任何外部模块(executeScript 序列化函数体),所以基础 helper 被迫各处内联复制。

### 1.2 已确认的不对齐缺口(🔴严重 🟡中 ⚪轻)

| 能力 | snapshot | search | capture | action 定位 | 缺口 |
|---|---|---|---|---|---|
| INTERACTIVE_SELECTOR | 内联 | 内联 | 内联 | — | ⚪ `interactive-parity.test` 守字面量,目前一致 |
| Editor 识别 | `EDITOR_SELECTOR`(5 宿主) | ❌无 | ❌无 | `type.ts` `detectEditor`(9)/`editor.ts` adapter(4) | 🔴 三套互不相同,search/capture 完全不认 |
| idx stamp 算法 | 含 editor 单一化 + rescue | 纯 selector + rescue,**无 editor** | — | — | 🔴 parity 只守 selector 字面量,**不守 editor 分支**;两者都在 live DOM stamp 会互相覆盖 |
| 语义抽取(role/name/label/section) | 4 函数(含 editor 特例) | 同名 4 函数复制,**漏 editor 特例** | 另一套(中文 label) | — | 🔴 search 复制版缺 editor;另有 `selector.ts` describeElement 第 4 套 |
| shadow DOM | ✅穿透 stamp | ✅穿透 stamp | ❌不处理 | ❌全用 `querySelector` 不穿透 | 🔴 **shadow 内元素可探查、不可操作** |
| isVisible | 内联 | 内联 | — | — | 🟡 + `dom-walk.ts` 共 3 份,逻辑现一致但无测试守 |
| rescue label(隐藏 checkbox→label) | ✅ | ✅复制 | 另套逻辑 | — | 🟡 snapshot/search 靠复制对齐 |
| WRAPPER 转义表 | 16 项**含** `untrusted_editor_content` | 15 项**缺** `untrusted_editor_content` | 仅 6 项 | — | 🔴 **安全**:search/capture 转义表不全,注入串可能逃逸 |
| 隐藏 textarea 不泄漏(#143) | ✅ Step B isVisible 守 | ⚠️ directText 读 text-node | — | — | 🟡 search 可能泄漏 editor 隐藏源 HTML |

### 1.3 两处需点名的后果

- **idx 索引空间发散 + stamp 互相覆盖(静默危险)**:含 editor 的页面上,read_page 把宿主标成 1 个 idx 并跳过内部;search_page 不标宿主却给内部碎片标号。两者都 clear+重 stamp live DOM,顺序一变,`read_editor(N)` 用 `[data-pie-idx=N]` 会定位到另一个元素 → 误操作或 not_found。
- **功能自相矛盾**:`search_page` 描述专门推销 `search_by="role"` 找 blank editors,但对 Monaco/CM/TinyMCE 搜 `role="editor"` 恒 0 命中(其 `inferredRole` 无 editor 分支)。

## 2. 目标与非目标

### 2.1 目标(本轮范围)

1. 合并 `pageSnapshotInjected` 与 `searchPageInjected` 为单一探查核心 `probePageInjected({op})`,消除 editor 识别 / stamp 算法 / 语义抽取 / WRAPPER 转义四类漂移。
2. 合并四个 executeScript-func 定位点为单一动作核心 `actByIdxInjected({op})`,统一 shadow-aware locator,闭合 shadow「可读不可操作」缺口。
3. editor 的 CDP-string locator 改用与动作核心同源的共享 fragment 常量,保留 subframe 检测。
4. 统一 WRAPPER 转义表(权威全表),修掉 search 的逃逸面;**顺手补** capture 的转义表安全缺口(隔离改动)。
5. 留好 op 扩展口子,供后续 capture/selector 归一。

### 2.2 非目标(后置,另起 issue)

- `capture.ts` 的整体归一(shadow 穿透、editor 识别、语义描述)——本轮只补它的 WRAPPER 转义表这一项安全修复,其余进后续 issue。
- `recording/selector.ts` 的 `describeElement` 与 capture `buildLabelFor` 的语义描述归一。
- 升级到方案 B(构建期内联 transform)——本轮用方案 A(运行时合并 + 强化测试),结构上为方案 B 留好升级口子,但不实施。

## 3. 关键设计决策(已确认)

1. **单一注入 + op**:采用「共享 helper 层 + 按 op 分叉产出」,**不是**「统一中间模型再投影」——避免 search 背上 read_page 的 HTML 序列化成本。
2. **idx 一致性靠算法同源**:两个 op 共享同一份 stamp 代码,同一页面状态下必然产出相同 idx;不引入跨注入状态共享/缓存。残留风险(两次调用间页面 DOM 变化导致 idx 漂移)是现状固有,LLM 已习惯重读。
3. **统一共享 locator**:executeScript-func 类合并进动作核心共享一份;CDP-string 类(editor)用同源 fragment 字符串常量。
4. **方案 A:运行时双核心 + 强化测试**:同类逻辑物理合并消除复制;跨核心的底层件(walkDeep/isVisible/selector/locator)用「往返行为 parity + 关键字面量 parity」守住。不引入构建期内联机制。
5. **editor 清单双轨**:`EDITOR_SELECTOR`(role=editor,仅 CDP 可操作的 Monaco/CM/TinyMCE)与 `type.ts` 的 `detectEditor`(9 种,含 canvas,用于 type 失败诊断)语义不同,不强行合并,只各自收进权威层并命名区分。

## 4. 架构与文件组织

### 4.1 权威常量层(可 import,模块侧)

```
src/lib/dom-actions/_shared/
  interactive.ts   [扩充] 已有 INTERACTIVE_SELECTOR / ROLE_TO_CN / TAG_TO_CN
                   → 新增 EDITOR_SELECTOR、EDITOR_ENGINE_MAP、WRAPPER_TAGS_LIST、TYPE_EDITOR_MARKERS
                   (全部可 import 的权威常量,供注入函数内联 + parity 测试比对)
  locate.ts        [新] LOCATE_BY_IDX_FRAGMENT 字符串常量(给 CDP-string 类拼接)
```

注:模块侧权威只能放「可被 parity 测试比对的源码片段」(选择器字符串、正则、引擎 map、字符串 fragment)。整段 helper(walkDeep/isVisible/语义抽取)仍内联在各注入函数内,用测试守。

### 4.2 两个注入核心

```
src/lib/dom-actions/
  probe-core.ts    [新] probePageInjected({op:"snapshot"|"search", ...})
                   —— op:"snapshot" 走「序列化 HTML + interactive index」分支
                   —— op:"search"   走「页内匹配 + 只回传 matches」分支
                   —— 两分支共享同一段:walkDeep / isVisible / stamp(含 editor 宿主
                      单一化 + insideEditor skip)/ 语义抽取 / editor 识别 / WRAPPER 转义
  act-core.ts      [新] actByIdxInjected({op:"type"|"select"|"rect"|"focusClick", idx, ...})
                   —— 四个 op 共享唯一一份 shadow-aware locator(deepQuerySelector by idx,
                      穿透 open shadow root)——闭合 shadow「可读不可操作」缺口
                   —— type/select 各自操作策略(React native setter、IME-buffer 检测、
                      execCommand、option 校验)在各自分支内逐字保留
  dom-walk.ts      [保留] 模块侧 walkDeep / isVisibleDeep(SW/测试侧 import,非注入)
```

返回类型用 discriminated union(`ProbeResult` 按 op 决定形状),保留 `PageSnapshotResult` / `SearchPageResult` 作为各 op 的结果型。

### 4.3 tool 层薄改(不重写)

| 文件 | 改动 |
|---|---|
| `agent/tools/read-page.ts` | `func: pageSnapshotInjected` → `probePageInjected`,`args:[{op:"snapshot",...}]` |
| `agent/tools/search-page.ts` | `func: searchPageInjected` → `probePageInjected`,`args:[{op:"search",...}]` |
| `agent/tools/editor.ts` | `locatorFragment` 改用共享 `LOCATE_BY_IDX_FRAGMENT`(穿 shadow + 保留 `in_subframe`/`not_found` sentinel) |
| `agent/tools/keyboard.ts` | `focusClickByIndex` → `actByIdxInjected({op:"focusClick"})` |
| `dom-actions/geometry.ts` / `agent/tools/mouse.ts` | `elementToPagePoint` 内的 `readRectByIdx` → `actByIdxInjected({op:"rect"})`;SW 侧 `elementToPagePoint`/`resolveChromeToCdpFrameId` 保留 |

合并后删除:`page-snapshot.ts`、`search-page.ts`(dom-actions 侧注入函数)、`type.ts`、`select.ts` 的注入函数;`geometry.ts` 的 `readRectByIdx` 并入动作核心。

### 4.4 editor 清单双轨

- `EDITOR_SELECTOR`(探查核心,role=editor):仅 `.monaco-editor, .cm-editor, .CodeMirror, .tox-tinymce, .mce-tinymce`——标了 role=editor 即承诺 `read_editor`/`set_editor_value` 可用。
- `TYPE_EDITOR_MARKERS`(动作核心 type 分支,原 `detectEditor` 的 9 种,含 Slate/Quill/ProseMirror/Lexical/Notion/GoogleDocs/Feishu canvas):用途是 type 失败时诊断并引导到键盘,范围必须更广。
- 两者都收进权威层、命名区分,`detectEditor` 随动作核心合并迁入但**不改语义**。

## 5. 行为变更清单(均为修复,无数据迁移)

| # | 变更 | 性质 |
|---|---|---|
| 1 | `search_page` 把 Monaco/CM/TinyMCE 宿主标成单一 role=editor entry、跳过内部碎片 → idx 序列向 read_page 看齐 | 修复 |
| 2 | `search_by="role" query="editor"` 现在能命中 editor 宿主(之前恒 0) | 修复 |
| 3 | `search_page` 对 editor 宿主给 "use read_editor/set_editor_value" 引导 | 修复 |
| 4 | `search_page` 不再泄漏 TinyMCE 隐藏 `<textarea>` 的序列化 HTML | 修复 |
| 5 | shadow DOM 内元素现在 type/select/click/keyboard/editor 都能定位操作 | 修复 |

`data-pie-idx` 每次注入重新 stamp、不持久化;session 持久化的是历史 observation 文本,不含 live idx → **纯代码重构,无 storage 影响**。`read_page` 行为基本不变(底层换核心)。

## 6. 安全:WRAPPER 转义表统一

- 权威全表 `WRAPPER_TAGS_LIST` 收进 `_shared/interactive.ts`,探查核心从它内联;parity 测试守「注入内联 == agent 层主表 `UNTRUSTED_WRAPPER_TAGS`」(dual-list invariant)。修掉 search 转义表缺 `untrusted_editor_content` 的逃逸面。
- **顺手补 capture**:`capture.ts` 的转义表(现 6 项)换成从权威全表生成(一行列表替换,不碰 capture 其余逻辑),消除录制 label 的注入逃逸面。

## 7. 留口子(为后续 capture/selector 归一)

- op 用 discriminated union:未来 capture 可作为 probe-core 新 op 或独立核心接入,签名不破。
- 权威常量层集中所有 selector/正则/转义表/引擎 map,capture 归一时直接 import 同一批常量内联。
- 语义抽取 helper 段命名清晰、内聚:未来升级到方案 B(构建期内联)可直接抽出,不推翻结构。

## 8. 测试策略

| 层 | 测试 | 守什么 |
|---|---|---|
| 探查核心内部 | 迁移现有 `page-snapshot.test`/`search-page.test` 行为断言到新核心 | snapshot/search 同一函数两 op,物理同源,无需 parity |
| **往返 parity**(新,最有价值) | 同一 fixture(含 shadow + editor):探查核心 stamp 的每个 idx,动作核心 locator 都能定位到同一元素 | 直接守「探查给的 idx 动作能用」 |
| 字面量 parity(扩展 `interactive-parity.test`) | 纳入 EDITOR_SELECTOR/引擎 map/WRAPPER 全表,断言 probe-core/act-core/capture/locate-fragment/editor-CDP-fragment 各处内联 == 权威 | 常量级漂移 |
| **editor fixture**(新,补当前空白) | Monaco/CM6/TinyMCE mock DOM:snapshot 宿主 role=editor + 单一 entry + 内部不 stamp;search(role=editor)命中且 idx == snapshot 同一 idx | `page-tools-locator-gap` 当前只覆盖原生 contenteditable |
| **shadow 闭合**(新) | shadow 内交互元素:探查给 idx,type/select/focusClick/editor-locator/rect 全能定位(之前 not_found) | 闭合核心证据 |
| 转义统一(新) | 页面文本注入 `<untrusted_editor_content>` 等全表标签 → search snippet / capture label 均被 `[filtered]` | 安全 |
| 回归 | 现有 read-page/search-page/type/select/editor/mouse/keyboard 全绿 | tool 层契约不变 |

## 9. 回归面与风险

- **动作核心合并是逐分支搬运,不是重写**:type 的 React native setter / IME-buffer 检测 / execCommand 策略、select 的 option 校验必须逐字保留。
- **editor CDP locator** 换共享 fragment 时,`in_subframe`/`not_found` sentinel 检测必须保留。
- **happy-dom 局限**:shadow DOM / `getComputedStyle` / `offsetParent` 支持有限,部分行为测试需标注「真机回归」(沿用 `editor.test.ts` 的 `new Function` 求值表达式模式)。
- 合并后注入函数体积变大——executeScript 无硬上限,可接受。
- 提交前硬门禁:`pnpm test` + `pnpm typecheck` + `pnpm build`(后两者 build-time invariants 会 throw)。

## 10. 后续 issue(本轮交付后创建)

> capture/selector 探查能力归一:为 `installCaptureListener` 补 shadow DOM 穿透 + editor 识别(role=editor/TYPE_EDITOR_MARKERS),并将 `recording/selector.ts` 的 `describeElement` 与 capture `buildLabelFor` 的语义描述归一到统一权威层(复用本轮 `_shared/` 常量)。评估是否升级到方案 B(构建期内联)以彻底消除跨注入函数的底层件复制。
