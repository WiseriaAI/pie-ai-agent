# Atlas 容器型 target 取名修复 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** atlas 的 table/collection target label 不再被容器内容摘要污染，能从 caption / ARIA / tabpanel / 前置兄弟标题中取到真实语义标题（修复 eval task 127 可复现回归）。

**Architecture:** 只重写 `src/lib/dom-actions/probe-core.ts` 内的 `targetLabel`（其唯一两个调用方 table/collection 都是容器型），新增 4 个纯函数级 helper，全程禁用 `descendantText` 兜底。控件取名 `accessibleName` 不动。

**Tech Stack:** TypeScript（注入函数，必须 self-contained 无外部闭包依赖——helpers 全部定义在 `probePageInjected` 同一注入作用域内）、vitest + happy-dom。

**Spec:** `docs/specs/2026-06-10-atlas-container-label.md`

**Worktree 注意：** 实施在独立 worktree 分支 `feat/atlas-container-label`。⚠️ 派 subagent 时 prompt 必须强制 `cd <worktree绝对路径>`（subagent cwd 不随 EnterWorktree 切换，会在 main 误提交——见 memory `subagent-cwd-pins-to-main-repo`）。

---

### Task 0: 建 worktree

- [ ] **Step 1: 创建 worktree 分支**

```bash
cd /Users/wenkang/repos/pie/pie-ai-agent
git worktree add .claude/worktrees/atlas-container-label -b feat/atlas-container-label main
cd .claude/worktrees/atlas-container-label && pnpm install
```

- [ ] **Step 2: 把 spec 和本 plan 提交进分支**

```bash
git add docs/specs/2026-06-10-atlas-container-label.md docs/plans/2026-06-10-atlas-container-label.md
git commit -m "docs: atlas container label spec + plan"
```

（spec/plan 写在 main 工作区时，先 `git -C <主仓库> stash -- docs/` 再在 worktree `stash pop`，或直接复制两文件后在主仓库删除，保持 main 干净。）

---

### Task 1: 失败测试 — 取名链 7 用例

**Files:**
- Test: `src/lib/dom-actions/probe-core.test.ts`（追加到现有 atlas describe 块末尾）

- [ ] **Step 1: 写失败测试**

在 `probe-core.test.ts` 的 atlas 相关 `describe` 内追加（搭法与现有用例一致：set `document.body.innerHTML` → `probePageInjected({ op: "atlas" })` → 断言 `r.targets`）：

```ts
describe("container target labels (atlas)", () => {
  function atlasTargets() {
    const r = probePageInjected({ op: "atlas" });
    if (r.op !== "atlas") throw new Error("narrow");
    return r.targets;
  }
  const tableHtml = `
    <thead><tr><th>Search Term</th><th>Results</th><th>Uses</th></tr></thead>
    <tbody><tr><td>tanks</td><td>23</td><td>1</td></tr></tbody>
  `;

  it("aria-label 优先于 caption", () => {
    document.body.innerHTML = `
      <table aria-label="Named by aria">
        <caption>Named by caption</caption>${tableHtml}
      </table>`;
    const t = atlasTargets().find((x) => x.type === "table");
    expect(t!.label).toBe("Named by aria");
  });

  it("caption 作为表名", () => {
    document.body.innerHTML = `
      <table><caption>Quarterly Report</caption>${tableHtml}</table>`;
    const t = atlasTargets().find((x) => x.type === "table");
    expect(t!.label).toBe("Quarterly Report");
  });

  it("祖先 tabpanel 的 aria-labelledby 解析为页签标题", () => {
    document.body.innerHTML = `
      <span id="tab-top">Top Search Terms</span>
      <div role="tabpanel" aria-labelledby="tab-top">
        <table>${tableHtml}</table>
      </div>`;
    const t = atlasTargets().find((x) => x.type === "table");
    expect(t!.label).toBe("Top Search Terms");
  });

  it("Magento 形状：前置兄弟 div 标题；双表 label 互异（核心回归）", () => {
    document.body.innerHTML = `
      <div>
        <div>Last Search Terms</div>
        <div><table>${tableHtml}</table></div>
      </div>
      <div>
        <div>Top Search Terms</div>
        <div><table>${tableHtml}</table></div>
      </div>`;
    const tables = atlasTargets().filter((x) => x.type === "table");
    expect(tables.map((x) => x.label)).toEqual(["Last Search Terms", "Top Search Terms"]);
  });

  it("无任何线索时回退 Table N，且 label 不含单元格内容（防 descendantText 回归）", () => {
    document.body.innerHTML = `<div><table>${tableHtml}</table></div>`;
    const t = atlasTargets().find((x) => x.type === "table");
    expect(t!.label).toBe("Table 1");
    expect(t!.label).not.toContain("tanks");
  });

  it(">60 字符的前置 div 不当标题", () => {
    const long = "x".repeat(61);
    document.body.innerHTML = `
      <div>
        <div>${long}</div>
        <div><table>${tableHtml}</table></div>
      </div>`;
    const t = atlasTargets().find((x) => x.type === "table");
    expect(t!.label).toBe("Table 1");
  });

  it("collection 容器同样取前置兄弟标题", () => {
    document.body.innerHTML = `
      <div>
        <div>Featured Items</div>
        <ul>
          <li><a href="/p/a">Alpha</a></li>
          <li><a href="/p/b">Beta</a></li>
          <li><a href="/p/c">Gamma</a></li>
        </ul>
      </div>`;
    const c = atlasTargets().find((x) => x.type === "collection");
    expect(c!.label).toBe("Featured Items");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/dom-actions/probe-core.test.ts`
Expected: 新 7 用例中至少 caption / tabpanel / Magento / Table N / >60 / collection 这 6 个 FAIL（aria-label 用例现状可能侥幸通过——accessibleName 本来就先查 aria-label）。失败形态应是 label 等于单元格文本拼接（如 `"Search Term Results Uses tanks 23 1"`）。

- [ ] **Step 3: 提交失败测试**

```bash
git add src/lib/dom-actions/probe-core.test.ts
git commit -m "test: atlas container label resolution cases (failing)"
```

---

### Task 2: 实现新取名链

**Files:**
- Modify: `src/lib/dom-actions/probe-core.ts:754-756`（`targetLabel`，在其上方新增 4 个 helper）

- [ ] **Step 1: 实现**

把 `targetLabel`（:754-756）替换为下面整段（helpers 与 targetLabel 同在注入作用域内，紧邻原位置；`normalizeSpace` / `textById` / `nearestSection` / `isAtlasVisible` / `safeText` 均为该作用域既有函数）：

```ts
    function explicitName(el: Element): string {
      const aria = normalizeSpace(el.getAttribute("aria-label") ?? "");
      if (aria) return aria;
      const labelled = el.getAttribute("aria-labelledby");
      if (labelled) {
        const text = normalizeSpace(labelled.split(/\s+/).map(textById).filter(Boolean).join(" "));
        if (text) return text;
      }
      return normalizeSpace(el.getAttribute("title") ?? "");
    }

    function captionText(el: Element): string {
      if (!(el instanceof HTMLTableElement) || !el.caption) return "";
      return normalizeSpace(el.caption.textContent ?? "");
    }

    function ancestorTabpanelLabel(el: Element): string {
      const panel = el.closest('[role="tabpanel"]');
      if (!panel) return "";
      const labelled = panel.getAttribute("aria-labelledby");
      if (labelled) {
        const text = normalizeSpace(labelled.split(/\s+/).map(textById).filter(Boolean).join(" "));
        if (text) return text;
      }
      return normalizeSpace(panel.getAttribute("aria-label") ?? "");
    }

    // 前置兄弟标题启发式：容器(表格/列表)的标题常是紧邻其前的短文本元素
    // (Magento 仪表盘形状：<div><div>Top Search Terms</div><div><table/></div></div>)。
    function shortTitleText(el: Element): string {
      if (el.querySelector("table, ul, ol, form, input, select, textarea, button")) return "";
      if (!isAtlasVisible(el)) return "";
      const text = normalizeSpace(el.textContent ?? "");
      return text && text.length <= 60 ? text : "";
    }

    function precedingSiblingTitle(el: Element): string {
      let node: Element | null = el;
      for (let depth = 0; node && node !== document.body && depth < 3; depth++) {
        for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
          const text = shortTitleText(sib);
          if (text) return text;
        }
        node = node.parentElement;
      }
      return "";
    }

    // 容器型 target(table/collection)取名：内容摘要(descendantText)永远不是名字——
    // 它既误导模型(eval task 127)又遮蔽 nearestSection，故此链不含 descendantText。
    function targetLabel(el: Element, fallback: string): string {
      return safeText(
        explicitName(el) ||
        captionText(el) ||
        ancestorTabpanelLabel(el) ||
        precedingSiblingTitle(el) ||
        nearestSection(el) ||
        fallback,
      );
    }
```

- [ ] **Step 2: 跑新用例确认通过**

Run: `pnpm test src/lib/dom-actions/probe-core.test.ts`
Expected: 新 7 用例全 PASS；同文件既有用例（`label: "Inventory"`、`label: "Featured products"` 等）也必须仍 PASS——它们的 label 来源（aria-label / 邻近 heading）在新链第 1/4/5 级仍可达。若有既有用例失败，逐个核对其 fixture 的 label 来源，按新链语义修正期望值前先确认不是实现 bug。

- [ ] **Step 3: 提交**

```bash
git add src/lib/dom-actions/probe-core.ts
git commit -m "fix(atlas): container target labels resolve semantic titles, never content digest"
```

---

### Task 3: 全量门禁

- [ ] **Step 1: 全量测试 + typecheck + build**

```bash
pnpm test && pnpm typecheck && pnpm build
```
Expected: 三个全绿（当前 main 基线 ~1891 测试全过、typecheck 0 错）。

- [ ] **Step 2: 若全绿则无需提交（无改动）；有修复则单独提交**

---

### Task 4: eval 实证验证（task 127 复跑）

**前置：** deepseek key 在 `/Users/wenkang/repos/pie/private/deepseek.key`；shopping_admin 容器须先重置（mutate 污染——见 memory `webarena-eval-methodology-lessons`）。

- [ ] **Step 1: 重建 eval 构建产物（在 worktree 内）**

```bash
pnpm build:eval
```

- [ ] **Step 2: 重置 WebArena 容器**

```bash
docker stop shopping_admin && docker rm shopping_admin
docker run --name shopping_admin -p 7780:80 -d shopping_admin_final_0719
# 等 php-fpm RUNNING 后配 base_url（完整命令见 eval/setup-webarena-site.sh:83-95）
```

- [ ] **Step 3: 复跑 task 127**

```bash
export PIE_EVAL_PROVIDER=deepseek PIE_EVAL_MODEL=deepseek-v4-pro
export PIE_EVAL_API_KEY="$(cat /Users/wenkang/repos/pie/private/deepseek.key)"
export PIE_EVAL_ENVIRONMENTS='{"shopping_admin":{"urls":["http://localhost:7780/admin"]}}'
export PIE_EVAL_AUTH="$(cat eval/auth/shopping-admin.json)"
rm -rf eval/runs/fix127
eval/run-batch.sh eval/runs/fix127 eval/tasks/127.json
```

Expected:
- `eval/runs/fix127/_summary.json` 中 task 127 `score: 1.0`；
- `agent-trace.json` 中 `read_table` 观察的两表 label 分别含 `Last Search Terms` / `Top Search Terms`（grep 验证）。

模型有运行波动：若 label 已正确而答案仍错，复跑一次；若 label 仍是内容摘要，则是实现 bug，回 Task 2。

- [ ] **Step 4: 完成分支**

验证通过后走 superpowers:finishing-a-development-branch（推 PR、两阶段 review）。

---

## Self-Review 记录

- Spec 覆盖：取名链 6 级 ↔ Task 2 实现逐级对应；测试计划 7 用例 ↔ Task 1 逐条落地；验证段 ↔ Task 3/4。无缺口。
- 占位符：无 TBD/TODO；所有代码步骤含完整代码。
- 类型一致性：helpers 仅用既有作用域函数（normalizeSpace/textById/nearestSection/isAtlasVisible/safeText），签名与 probe-core.ts 现状一致（已核对行号 285/306/326/691/744）。
- 注意点已内嵌：注入函数 self-contained 约束、subagent cwd 坑、容器重置前置。
