# Pie Landing Page Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已在 Paper 定稿的方向 C 落成一个纯静态、中英双语的 Pie 落地页，部署到 Vercel。

**Architecture:** 单页长滚动，无框架/无构建步骤 —— 三个文件 `index.html` + `styles.css` + `main.js`，外加自托管字体与内联品牌 SVG。复用产品 `src/sidepanel/index.css` 的设计 token；i18n 用 `data-i18n` 属性 + 一份 JS 字典 + 顶部切换 + `localStorage` 记忆；背景点阵用 CSS 平铺 `radial-gradient`，唯一动效是 `pointermove` 驱动的悬浮聚光。所有「Agent 结果」视觉只复刻产品**已上线**的渲染（详见 spec §3.9 保真约束）。

**Tech Stack:** 静态 HTML5 + CSS（自定义属性 / flexbox，无预处理器）+ 原生 ES module JS；Inter + JetBrains Mono 自托管 woff2；Vercel 静态托管（Root Directory = `landing`）。

**权威来源：** 设计 spec `docs/specs/2026-06-03-landing-page-design.md`；视觉原型 Paper 文件 `https://app.paper.design/file/01KT6HEBSZ5JD8FG4FC7W8WN94`（画板 `Pie Landing — C (EN)` / `Pie Landing — C (中文)`）。token 权威 `src/sidepanel/index.css`。

**通用验证方式（无单测框架）：** 每个任务用 `cd landing && python3 -m http.server 8000` 起本地服务，浏览器开 `http://localhost:8000` 按该任务的清单肉眼核对（有 Playwright MCP 时用 `browser_navigate` + `browser_take_screenshot` 截图比对 Paper）。每任务以一次 commit 收尾。

**目录基址：** 所有路径相对 `/Users/wenkang/repos/pie/pie-ai-agent/`。

---

## File Structure

- `landing/index.html` —— 页面骨架，全部可译文本用 `data-i18n="<key>"` 标记；占位符/aria 用 `data-i18n-attr`。
- `landing/styles.css` —— 设计 token（:root 变量）、base、工具类、各 section 样式、响应式、reduced-motion。
- `landing/main.js` —— i18n 字典 + 语言切换 + `<html lang>` 同步 + localStorage；悬浮聚光；可选 GitHub star 数。
- `landing/assets/fonts/` —— 自托管 woff2（Inter 400/500/600、JetBrains Mono 400/500）+ `fonts.css` 的 `@font-face`（合进 styles.css）。
- `landing/assets/pie-mark.svg` —— 品牌标记（也内联进 HTML，文件留作 favicon / og）。
- `landing/favicon.svg` —— 同 mark。
- `landing/og-image.png` —— 社交分享图（占位，1200×630，后续替换）。
- `landing/vercel.json` —— 静态托管配置（cleanUrls、安全头）。
- `landing/README.md` —— 部署说明（Root Directory = landing）。

设计意图：CSS 单文件即可（页面规模不大，单文件便于一眼掌握 token 与 section 的关系）；JS 单文件（i18n + 两个交互）。若 `main.js` 超过 ~250 行再考虑拆 `i18n.js` / `effects.js`，当前不预拆（YAGNI）。

---

## Task 0: 脚手架与可部署的空壳

**Files:**
- Create: `landing/index.html`
- Create: `landing/styles.css`
- Create: `landing/main.js`
- Create: `landing/vercel.json`
- Create: `landing/.gitignore`

- [ ] **Step 1: 建最小可跑骨架** `landing/index.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pie — Tell your browser what to do.</title>
  <meta name="description" content="A browser-automation agent that runs on your own API key. Free, open-source, no telemetry." />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <main id="app"></main>
  <script type="module" src="/main.js"></script>
</body>
</html>
```

- [ ] **Step 2: 建占位 CSS** `landing/styles.css`

```css
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; }
body { background: #FAFBFC; color: #14181D; font-family: system-ui, sans-serif; }
#app { min-height: 100vh; }
```

- [ ] **Step 3: 建占位 JS** `landing/main.js`

```js
console.info("Pie landing booted");
```

- [ ] **Step 4: 建 `landing/vercel.json`**

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "cleanUrls": true,
  "trailingSlash": false,
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
      ]
    }
  ]
}
```

- [ ] **Step 5: 建 `landing/.gitignore`**

```
.vercel
node_modules
```

- [ ] **Step 6: 起服务核对**

Run: `cd landing && python3 -m http.server 8000`
Open: `http://localhost:8000`
Expected: 空白浅灰页面，控制台打印 `Pie landing booted`，无 404（favicon 暂缺会有一条 404，下个任务补）。

- [ ] **Step 7: Commit**

```bash
cd /Users/wenkang/repos/pie/pie-ai-agent
git add landing/
git commit -m "chore(landing): scaffold static site shell"
```

---

## Task 1: 设计 token、字体、base 样式

复刻 `src/sidepanel/index.css` 的浅色 token（v1 只做浅色）。字体自托管以贴合「无遥测/无外部请求」气质。

**Files:**
- Create: `landing/assets/pie-mark.svg`
- Create: `landing/favicon.svg`
- Create: `landing/assets/fonts/` （woff2 文件）
- Modify: `landing/styles.css`（整体替换占位内容）

- [ ] **Step 1: 写品牌 SVG** `landing/assets/pie-mark.svg`（同时复制为 `landing/favicon.svg`）

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="26" fill="#14181D"/><circle cx="64" cy="64" r="44" fill="#FAFBFC"/><circle cx="98" cy="30" r="22" fill="#14181D"/></svg>
```

- [ ] **Step 2: 取自托管字体 woff2**

需要：Inter 400/500/600、JetBrains Mono 400/500（拉丁子集即可；中文走系统字体栈，见下）。
Run（把 Google Fonts 提供的 woff2 落到本地）：

```bash
cd /Users/wenkang/repos/pie/pie-ai-agent/landing/assets/fonts
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
# Inter
curl -s -A "$UA" "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" -o inter.css
# JetBrains Mono
curl -s -A "$UA" "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" -o jbmono.css
# 下载 css 里引用的 latin woff2（取每个 @font-face 的 latin 区段 URL）
grep -oE 'https://[^)]+\.woff2' inter.css | sort -u | while read u; do curl -s "$u" -O; done
grep -oE 'https://[^)]+\.woff2' jbmono.css | sort -u | while read u; do curl -s "$u" -O; done
ls -1 *.woff2
```

Expected: 目录出现若干 `*.woff2`（Inter 3 档 + JBMono 2 档，可能含多子集，保留 latin 的即可）。记下文件名用于 Step 3 的 `@font-face`。删除 `inter.css` / `jbmono.css` 临时文件。

> 备选：若 curl 取字体不便，可改用 Google Fonts `<link>`（在 `index.html` 加 preconnect + stylesheet）。但这会让页面向 Google 发请求，与「无遥测」气质相悖，**仅作兜底**。

- [ ] **Step 3: 整体替换 `landing/styles.css` 为 token + base**（`@font-face` 的 `src` 文件名按 Step 2 实际产物填写）

```css
/* ── @font-face (filenames per assets/fonts/) ───────────────────────── */
@font-face { font-family:"Inter"; font-weight:400; font-display:swap; src:url("/assets/fonts/inter-latin-400.woff2") format("woff2"); }
@font-face { font-family:"Inter"; font-weight:500; font-display:swap; src:url("/assets/fonts/inter-latin-500.woff2") format("woff2"); }
@font-face { font-family:"Inter"; font-weight:600; font-display:swap; src:url("/assets/fonts/inter-latin-600.woff2") format("woff2"); }
@font-face { font-family:"JetBrains Mono"; font-weight:400; font-display:swap; src:url("/assets/fonts/jbmono-latin-400.woff2") format("woff2"); }
@font-face { font-family:"JetBrains Mono"; font-weight:500; font-display:swap; src:url("/assets/fonts/jbmono-latin-500.woff2") format("woff2"); }

/* ── tokens (mirror of src/sidepanel/index.css, light only) ─────────── */
:root {
  --c-canvas:#FAFBFC; --c-surface:#FFFFFF; --c-field:#F4F6F8; --c-line:#E4E8EC;
  --c-fg-1:#14181D; --c-fg-2:#5A6470; --c-fg-3:#98A1AC; --c-fg-4:#B8BFC8;
  --c-accent:#4A5C6E; --c-accent-tint:rgba(74,92,110,0.08); --c-warning:#B85A4D;
  --c-dot:rgba(20,24,29,0.05); --c-dot-dark:rgba(232,236,242,0.07);
  --font-sans:"Inter", ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-mono:"JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace;
  --maxw:1312px; /* 1440 - 64*2 内容宽 */
  --ease:cubic-bezier(0.32,0.72,0,1);
}

*, *::before, *::after { box-sizing:border-box; }
html { scroll-behavior:smooth; }
body {
  margin:0; background:var(--c-canvas); color:var(--c-fg-1);
  font-family:var(--font-sans); font-feature-settings:"ss01","cv11";
  -webkit-font-smoothing:antialiased; line-height:1.5;
}
a { color:inherit; text-decoration:none; }
img, svg { display:block; }

/* ── shared utilities ───────────────────────────────────────────────── */
.caps { font-family:var(--font-mono); font-size:10px; font-weight:500; letter-spacing:0.16em; text-transform:uppercase; }
.mono { font-family:var(--font-mono); }
.tabular { font-variant-numeric:tabular-nums; }
.hairline { height:1px; width:100%; background:var(--c-line); }
.section { width:100%; padding:104px 64px; }
.wrap { width:100%; max-width:var(--maxw); margin:0 auto; }

/* ── motion (Linear/Raycast easing) ─────────────────────────────────── */
@keyframes reveal { from { opacity:0; transform:translateY(8px);} to { opacity:1; transform:none; } }
.reveal { animation:reveal 480ms var(--ease) both; }
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior:auto; }
  *, *::before, *::after { animation-duration:0.01ms !important; transition-duration:0.01ms !important; }
}
```

- [ ] **Step 4: 起服务核对**

Open `http://localhost:8000`：页面仍空（无 #app 内容），但 favicon 出现、字体已加载（Network 面板可见 woff2 200）。

- [ ] **Step 5: Commit**

```bash
git add landing/assets landing/favicon.svg landing/styles.css
git commit -m "feat(landing): design tokens, self-hosted fonts, brand mark"
```

---

## Task 2: i18n 骨架 + 全量双语字典

先把 i18n 机制和**全部文案**（两种语言）定下来，后续 section 只写带 `data-i18n` 的结构、不再重复文案（DRY）。文案逐字取自 Paper 两块画板。

**Files:**
- Modify: `landing/main.js`（整体替换）
- Modify: `landing/index.html`（给 `<html>` 与 toggle 预留，见 Task 3）

- [ ] **Step 1: 整体替换 `landing/main.js`**

```js
// ── i18n dictionary (verbatim from Paper artboards) ──────────────────
const I18N = {
  en: {
    "nav.install":"Add to Chrome", "nav.star":"Star",
    "hero.eyebrow":"AI in your browser",
    "hero.title":"Tell your browser what to do.",
    "hero.sub":"One sentence — Pie plans the steps and does the work. Read pages, organize tabs, pull out data, even save it as a skill you can reuse.",
    "hero.cta":"Add to Chrome — free", "hero.star":"Star on GitHub",
    "hero.micro":"Free  ·  BYOK  ·  Open-source  ·  No telemetry",
    "panel.title":"Summarize page",
    "panel.user":"Summarize this page in 3 points",
    "panel.done":"Done · 3 steps",
    "panel.b1":"A privacy-first browser agent — your keys stay on-device.",
    "panel.b2":"Works across tabs, PDFs, and canvas editors.",
    "panel.b3":"Any workflow can be saved as a reusable skill.",
    "panel.input":"Ask or describe a task…",
    "tour.eyebrow":"How it works", "tour.title":"Say this. Get that.",
    "tour.sub":"No scripts, no settings to learn. Describe the outcome in plain language — Pie figures out the steps.",
    "you":"You say",
    "s1.tag":"· PAGE & PDF Q&A", "s1.cmd":"“What's the refund policy on this page?”",
    "s1.out":"Ask anything about the page — or a PDF you have open. Pie reads it for you, with password fields scrubbed before anything is sent.",
    "s1.done":"Done · 2 steps",
    "s1.ans":"Refunds are accepted within 30 days of delivery. Opened items qualify only if the original seal is intact, and shipping costs are non-refundable.",
    "s2.tag":"· TABS & DATA", "s2.cmd":"“Pull the price from each of these tabs into a table.”",
    "s2.out":"Pie reads every open tab, extracts exactly what you asked for, and lays it out — ready to copy as Markdown or CSV.",
    "s2.done":"Done · 6 steps", "s2.colA":"Product", "s2.colB":"Price",
    "s3.tag":"· REUSABLE SKILLS", "s3.cmd":"“Save what you just did as a skill.”",
    "s3.out":"Record a workflow once — it becomes a /slash command you can run anytime. Each skill stays scoped to just the tools it needs.",
    "pop.count":"2 skills",
    "pop.d1":"Collects this week's open tabs and summarizes each one.",
    "pop.d2":"Draft a standup note from yesterday's tabs and docs.",
    "pop.tag":"User", "pop.nav":"↑↓ navigate", "pop.run":"↵ run", "pop.esc":"esc",
    "trust.byok":"BYOK", "trust.byok.d":"Your API key, encrypted on-device with AES-GCM.",
    "trust.oss":"Open-source", "trust.oss.d":"Every line is on GitHub. Audit it yourself.",
    "trust.tel":"No telemetry", "trust.tel.d":"No backend, no proxy. Nothing routes through us.",
    "trust.prov":"10 providers", "trust.prov.d":"Claude, GPT, Gemini, DeepSeek & more.",
    "cap.eyebrow":"Capabilities", "cap.title":"And quite a bit more.",
    "cap.sub":"The same plain-language control — pointed at the fiddly parts of the browser.",
    "cap.1":"Multi-step tasks", "cap.1d":"Describe a goal; Pie plans and runs the clicks, typing, and scrolling.",
    "cap.2":"Cross-tab control", "cap.2d":"List, activate, close, group, and move tabs — or fetch their content.",
    "cap.3":"Form filling", "cap.3d":"Hand it a template and let it complete repetitive forms for you.",
    "cap.4":"Canvas editors", "cap.4d":"Real keystrokes for editors like Google Docs and Lark that ignore the usual events.",
    "cap.5":"Durable sessions", "cap.5d":"Conversations survive browser restarts. Pick any one back up later.",
    "cap.6":"Sandboxed", "cap.6d":"Page content is quarantined and tools are locked per session — injection-resistant by design.",
    "cta.eyebrow":"Get started", "cta.title":"Put your browser to work.",
    "cta.sub":"Free, open-source, and your keys never leave your machine. Install in one click and ask it something.",
    "cta.install":"Add to Chrome — free", "cta.star":"Star on GitHub", "cta.meta":"Chrome · Manifest V3 · v0.19",
    "foot.tagline":"A browser-automation agent that runs on your own API key.",
    "foot.privacy":"Privacy", "foot.changelog":"Changelog", "foot.roadmap":"Roadmap",
    "foot.arch":"Architecture", "foot.github":"GitHub", "foot.store":"Chrome Web Store",
    "foot.copy":"© 2026 Pie · Open-source · MIT", "foot.made":"Made for Chrome",
  },
  zh: {
    "nav.install":"添加到 Chrome", "nav.star":"Star",
    "hero.eyebrow":"浏览器里的 AI Agent",
    "hero.title":"说一句话，浏览器替你干完。",
    "hero.sub":"你说一句，剩下的交给 Pie——读网页、收拾标签页、扒数据，干完还能存成技能下次接着用。",
    "hero.cta":"免费添加到 Chrome", "hero.star":"在 GitHub 上 Star",
    "hero.micro":"免费  ·  BYOK  ·  开源  ·  无遥测",
    "panel.title":"总结这页",
    "panel.user":"把这页总结成 3 点",
    "panel.done":"完成 · 3 步",
    "panel.b1":"一个看重隐私的浏览器 agent，密钥只待在你电脑里。",
    "panel.b2":"网页、PDF、画布编辑器都能搞定。",
    "panel.b3":"顺手把整套操作存成技能，下次直接复用。",
    "panel.input":"问点什么，或者说个任务…",
    "tour.eyebrow":"怎么用", "tour.title":"说这句，得这个。",
    "tour.sub":"不用写脚本，也不用研究设置。想要啥结果直说，剩下的 Pie 自己搞定。",
    "you":"你说",
    "s1.tag":"· 网页 & PDF 问答", "s1.cmd":"「这页的退款政策是啥？」",
    "s1.out":"当前网页，或者你开着的 PDF，随便问。Pie 替你读，发出去之前还会先把密码这类字段抹掉。",
    "s1.done":"完成 · 2 步",
    "s1.ans":"支持自收货起 30 天内退款。已拆封商品需原封条完好；运费不予退还。",
    "s2.tag":"· 标签 & 数据", "s2.cmd":"「把这几个标签页里的价格扒下来，弄成一张表。」",
    "s2.out":"Pie 把开着的标签页一个个读一遍，挑出你要的排好——直接复制成 Markdown 或 CSV 就行。",
    "s2.done":"完成 · 6 步", "s2.colA":"商品", "s2.colB":"价格",
    "s3.tag":"· 可复用技能", "s3.cmd":"「把我刚才那一通操作存成个技能。」",
    "s3.out":"录一遍，它就成了个 /slash 命令，以后想用打一下就行。每个技能只拿它该用的那几样工具。",
    "pop.count":"2 个技能",
    "pop.d1":"把这周开过的标签收拢一遍，挨个总结。",
    "pop.d2":"照着昨天的标签和文档，起草一份站会要点。",
    "pop.tag":"用户", "pop.nav":"↑↓ 选择", "pop.run":"↵ 运行", "pop.esc":"esc 关闭",
    "trust.byok":"BYOK", "trust.byok.d":"你的 API key，在本地用 AES-GCM 加密存着。",
    "trust.oss":"开源", "trust.oss.d":"代码全在 GitHub，自己随便审。",
    "trust.tel":"无遥测", "trust.tel.d":"没后端也没代理，啥都不过我们的手。",
    "trust.prov":"10 家 provider", "trust.prov.d":"Claude、GPT、Gemini、DeepSeek 等。",
    "cap.eyebrow":"能力", "cap.title":"还能干不少别的。",
    "cap.sub":"还是那句大白话——专治浏览器里那些麻烦琐事。",
    "cap.1":"多步任务", "cap.1d":"说个目标就行，点哪儿、填啥、往哪滚，Pie 自己安排。",
    "cap.2":"跨标签操作", "cap.2d":"标签页列出来、切换、关掉、分组、挪位置——还能把里面内容抓出来。",
    "cap.3":"表单填写", "cap.3d":"给个模板，那些重复表单让它替你填。",
    "cap.4":"画布编辑器", "cap.4d":"飞书、Google Docs 这种不吃普通事件的编辑器，它直接敲真键盘。",
    "cap.5":"对话不丢", "cap.5d":"浏览器重启了对话也还在，回头接着聊就行。",
    "cap.6":"沙箱隔离", "cap.6d":"页面内容单独隔开、工具按会话锁住——天生不怕注入攻击。",
    "cta.eyebrow":"开始使用", "cta.title":"让浏览器替你干活。",
    "cta.sub":"免费、开源，密钥永远不离开你的设备。装上就能用，直接问它点啥试试。",
    "cta.install":"免费添加到 Chrome", "cta.star":"在 GitHub 上 Star", "cta.meta":"Chrome · Manifest V3 · v0.19",
    "foot.tagline":"一个用你自己 API key 跑的浏览器自动化 agent。",
    "foot.privacy":"隐私", "foot.changelog":"更新日志", "foot.roadmap":"路线图",
    "foot.arch":"架构", "foot.github":"GitHub", "foot.store":"Chrome 应用商店",
    "foot.copy":"© 2026 Pie · 开源 · MIT", "foot.made":"为 Chrome 打造",
  },
};

// 外链常量（实施时确认）
const LINKS = {
  store:"https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed",
  github:"https://github.com/WiseriaAI/pie-ai-agent",
  privacy:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/PRIVACY.md",
  changelog:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/CHANGELOG.md",
  roadmap:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/docs/ROADMAP.md",
  arch:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/docs/ARCHITECTURE.md",
};

// ── i18n apply ───────────────────────────────────────────────────────
function applyLang(lang) {
  const dict = I18N[lang] || I18N.en;
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const v = dict[el.dataset.i18n]; if (v != null) el.textContent = v;
  });
  document.querySelectorAll("[data-i18n-attr]").forEach(el => {
    el.dataset.i18nAttr.split(",").forEach(pair => {
      const [attr, key] = pair.split(":"); const v = dict[key];
      if (v != null) el.setAttribute(attr, v);
    });
  });
  document.querySelectorAll("[data-lang-btn]").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.langBtn === lang)));
  try { localStorage.setItem("pie-lang", lang); } catch {}
}

function initLang() {
  let lang = "en";
  try { const s = localStorage.getItem("pie-lang"); if (s === "en" || s === "zh") lang = s; } catch {}
  applyLang(lang);
  document.querySelectorAll("[data-lang-btn]").forEach(b =>
    b.addEventListener("click", () => applyLang(b.dataset.langBtn)));
}

document.addEventListener("DOMContentLoaded", () => { initLang(); });
```

- [ ] **Step 2: 起服务核对**

Open `http://localhost:8000`：控制台无报错（页面仍无内容，DOMContentLoaded 后 querySelectorAll 命中 0 个元素属正常）。

- [ ] **Step 3: Commit**

```bash
git add landing/main.js
git commit -m "feat(landing): i18n engine + full bilingual dictionary"
```

---

## Task 3: 顶栏（sticky + 磨砂 + 语言切换）

**Files:**
- Modify: `landing/index.html`（在 `#app` 内加 header）
- Modify: `landing/styles.css`（追加 .topbar 等）

- [ ] **Step 1: 在 `index.html` 的 `<main id="app">` 内首位插入 header**

```html
<header class="topbar">
  <div class="wrap topbar-in">
    <a class="brand" href="#top" aria-label="Pie">
      <svg width="28" height="28" viewBox="0 0 128 128"><rect width="128" height="128" rx="26" fill="#14181D"/><circle cx="64" cy="64" r="44" fill="#FAFBFC"/><circle cx="98" cy="30" r="22" fill="#14181D"/></svg>
      <span class="brand-word">Pie</span>
    </a>
    <nav class="nav-right">
      <div class="lang" role="group" aria-label="Language">
        <button class="lang-btn" data-lang-btn="en" aria-pressed="true">EN</button>
        <button class="lang-btn" data-lang-btn="zh" aria-pressed="false">中</button>
      </div>
      <a class="ghost gh-pill" data-href="github">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="#5A6470"><path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2 1-.3 2-.4 3-.4s2 .1 3 .4c2.3-1.6 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z"/></svg>
        <span data-i18n="nav.star">Star</span>
        <span class="gh-count tabular mono" id="gh-stars" hidden></span>
      </a>
      <a class="btn-ink" data-href="store" data-i18n="nav.install">Add to Chrome</a>
    </nav>
  </div>
</header>
```

> 注：`data-href="github|store|..."` 由 JS 统一映射到 `LINKS`（见 Step 3）。锚点 `#top` 需在 body/main 顶部加 `id="top"`：把 `<main id="app">` 改为 `<main id="app"><span id="top"></span>`。

- [ ] **Step 2: 追加 `styles.css`**

```css
.topbar { position:sticky; top:0; z-index:50; background:rgba(255,255,255,0.8); backdrop-filter:saturate(180%) blur(12px); border-bottom:1px solid var(--c-line); }
.topbar-in { display:flex; align-items:center; justify-content:space-between; padding:14px 64px; }
.brand { display:flex; align-items:center; gap:11px; }
.brand-word { font-weight:600; font-size:19px; letter-spacing:-0.01em; }
.nav-right { display:flex; align-items:center; gap:16px; }
.lang { display:flex; align-items:center; gap:2px; padding:3px; background:var(--c-field); border-radius:9px; }
.lang-btn { font-family:var(--font-mono); font-size:11px; font-weight:500; padding:5px 11px; border:0; background:transparent; color:var(--c-fg-3); border-radius:7px; cursor:pointer; }
.lang-btn[aria-pressed="true"] { background:#fff; color:var(--c-fg-1); box-shadow:0 1px 2px rgba(20,24,29,0.06); }
.ghost.gh-pill { display:flex; align-items:center; gap:8px; padding:9px 14px; border:1px solid var(--c-line); border-radius:10px; font-size:14px; font-weight:500; color:var(--c-fg-2); cursor:pointer; }
.gh-count { font-size:13px; color:var(--c-fg-3); }
.btn-ink { display:inline-flex; align-items:center; gap:9px; padding:10px 18px; background:var(--c-fg-1); color:var(--c-canvas); border-radius:10px; font-size:14px; font-weight:600; cursor:pointer; transition:transform 150ms var(--ease); }
.btn-ink:hover { transform:translateY(-1px); }
```

- [ ] **Step 3: 在 `main.js` 的 `initLang()` 之后加链接映射 + 可选 star 数**

在 `document.addEventListener("DOMContentLoaded", ...)` 回调里改为：

```js
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-href]").forEach(a => {
    const u = LINKS[a.dataset.href]; if (u) { a.href = u; a.target = "_blank"; a.rel = "noopener"; }
  });
  initLang();
  // 可选：拉取 GitHub star 数（失败静默）
  fetch("https://api.github.com/repos/WiseriaAI/pie-ai-agent")
    .then(r => r.ok ? r.json() : null)
    .then(d => { if (d && typeof d.stargazers_count === "number") {
      const el = document.getElementById("gh-stars");
      el.textContent = d.stargazers_count >= 1000 ? (d.stargazers_count/1000).toFixed(1)+"k" : String(d.stargazers_count);
      el.hidden = false;
    }}).catch(()=>{});
});
```

> 取舍：GitHub API 是一次外部请求，但**只读公共仓库、无任何用户数据**，与「无遥测」不冲突（不上报用户）。如要绝对零外链可删除此 fetch，star 数留空。

- [ ] **Step 4: 起服务核对**

Open `http://localhost:8000`：顶栏出现，sticky；点 `EN/中` 切换，`Star`/`添加到 Chrome` 文案随之变化，刷新后保持上次语言；GitHub/Install 链接指向正确 URL（hover 状态、新标签打开）。

- [ ] **Step 5: Commit**

```bash
git add landing/index.html landing/styles.css landing/main.js
git commit -m "feat(landing): sticky top bar with language toggle"
```

---

## Task 4: Hero（文案 + 风格化 side panel）

对照 Paper `Hero` / `Side Panel Mock`。side panel 的回复区遵守 spec §3.9：`· Done N steps` 徽标 + 真实 Markdown 风格要点，**无来源 chip/卡框**。

**Files:**
- Modify: `landing/index.html`（header 之后插入 hero section）
- Modify: `landing/styles.css`

- [ ] **Step 1: 在 header 后插入 hero**

```html
<section class="hero section dotgrid" id="hero">
  <div class="wrap hero-in">
    <div class="hero-copy">
      <span class="caps hero-eyebrow" data-i18n="hero.eyebrow">AI in your browser</span>
      <h1 class="hero-title" data-i18n="hero.title">Tell your browser what to do.</h1>
      <p class="hero-sub" data-i18n="hero.sub"></p>
      <div class="cta-row">
        <a class="btn-ink lg" data-href="store" data-i18n="hero.cta">Add to Chrome — free</a>
        <a class="btn-outline" data-href="github">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="#4A5C6E"><path d="M12 1.5l3.09 6.26 6.91 1-5 4.87 1.18 6.88L12 17.27 5.82 20.51 7 13.63l-5-4.87 6.91-1L12 1.5z"/></svg>
          <span data-i18n="hero.star">Star on GitHub</span>
        </a>
      </div>
      <span class="caps hero-micro" data-i18n="hero.micro"></span>
    </div>
    <div class="panel" aria-hidden="true">
      <div class="panel-bar">
        <div class="panel-title">
          <svg width="18" height="18" viewBox="0 0 128 128"><rect width="128" height="128" rx="26" fill="#14181D"/><circle cx="64" cy="64" r="44" fill="#FAFBFC"/><circle cx="98" cy="30" r="22" fill="#14181D"/></svg>
          <span data-i18n="panel.title">Summarize page</span>
        </div>
        <div class="panel-icons">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#98A1AC" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#98A1AC" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </div>
      </div>
      <div class="panel-body">
        <div class="bubble-user" data-i18n="panel.user">Summarize this page in 3 points</div>
        <div class="steps">
          <div class="step"><svg class="ck" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg><span class="mono">read_page</span></div>
          <div class="step"><svg class="ck" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg><span class="mono">extract main text</span></div>
          <div class="step"><svg class="ck" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg><span class="mono">summarize</span></div>
        </div>
        <div class="reply">
          <div class="reply-badge"><span class="dot"></span><span class="caps" data-i18n="panel.done">Done · 3 steps</span></div>
          <ul class="md-list">
            <li data-i18n="panel.b1"></li><li data-i18n="panel.b2"></li><li data-i18n="panel.b3"></li>
          </ul>
        </div>
      </div>
      <div class="panel-input">
        <span class="panel-field" data-i18n="panel.input">Ask or describe a task…</span>
        <span class="panel-send"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg></span>
      </div>
    </div>
  </div>
</section>
```

- [ ] **Step 2: 追加 hero + panel 样式到 `styles.css`**

```css
.hero-in { display:flex; gap:72px; align-items:center; }
.hero-copy { display:flex; flex-direction:column; align-items:flex-start; gap:24px; flex:1; max-width:600px; }
.hero-eyebrow { color:var(--c-accent); }
.hero-title { margin:0; font-size:66px; font-weight:600; line-height:1.03; letter-spacing:-0.025em; }
.hero-sub { margin:0; font-size:18px; line-height:1.55; color:var(--c-fg-2); max-width:500px; }
.cta-row { display:flex; align-items:center; gap:12px; padding-top:8px; }
.btn-ink.lg { padding:14px 22px; font-size:15px; }
.btn-outline { display:inline-flex; align-items:center; gap:8px; padding:13px 18px; background:#fff; border:1px solid var(--c-line); border-radius:11px; font-size:15px; font-weight:500; cursor:pointer; transition:border-color 150ms var(--ease); }
.btn-outline:hover { border-color:var(--c-fg-3); }
.hero-micro { color:var(--c-fg-3); font-size:12px; letter-spacing:0.02em; }

.panel { display:flex; flex-direction:column; width:432px; flex-shrink:0; background:#fff; border:1px solid var(--c-line); border-radius:16px; box-shadow:0 24px 60px -24px rgba(20,24,29,0.22), 0 4px 12px rgba(20,24,29,0.04); overflow:hidden; }
.panel-bar { display:flex; align-items:center; justify-content:space-between; padding:13px 16px; border-bottom:1px solid var(--c-line); }
.panel-title { display:flex; align-items:center; gap:9px; font-size:13px; font-weight:500; }
.panel-icons { display:flex; gap:14px; }
.panel-body { display:flex; flex-direction:column; gap:14px; padding:18px 16px 16px; background:var(--c-canvas); }
.bubble-user { align-self:flex-end; max-width:78%; padding:10px 14px; background:var(--c-fg-1); color:var(--c-canvas); border-radius:13px 13px 4px 13px; font-size:13px; line-height:1.46; }
.steps { display:flex; flex-direction:column; gap:8px; align-self:flex-start; padding-left:2px; }
.step { display:flex; align-items:center; gap:8px; }
.step .ck { width:13px; height:13px; fill:none; stroke:var(--c-accent); stroke-width:3; stroke-linecap:round; stroke-linejoin:round; }
.step .mono { font-size:11px; font-weight:500; letter-spacing:0.04em; color:var(--c-fg-2); }
.reply { display:flex; flex-direction:column; gap:10px; }
.reply-badge { display:flex; align-items:center; gap:8px; }
.reply-badge .dot { width:4px; height:4px; border-radius:50%; background:var(--c-accent); }
.reply-badge .caps { color:var(--c-fg-2); }
.md-list { margin:0; padding-left:20px; display:flex; flex-direction:column; gap:4px; }
.md-list li { font-size:13px; line-height:1.54; color:var(--c-fg-1); }
.panel-input { display:flex; align-items:center; gap:10px; padding:12px 14px; border-top:1px solid var(--c-line); }
.panel-field { flex:1; padding:10px 13px; background:var(--c-field); border-radius:10px; font-size:13px; color:var(--c-fg-3); }
.panel-send { display:flex; align-items:center; justify-content:center; width:36px; height:36px; flex-shrink:0; background:var(--c-accent); border-radius:9px; }
```

- [ ] **Step 3: 起服务核对（两种语言）**

Open `http://localhost:8000`：hero 左文案 + 右 side panel 与 Paper `Hero` 一致；切到「中」全部文案变中文、标题两行（中文标题 `说一句话，浏览器替你干完。`）；side panel 回复区是「· Done 3 steps」徽标 + 三条要点，无来源 chip。

- [ ] **Step 4: Commit**

```bash
git add landing/index.html landing/styles.css
git commit -m "feat(landing): hero with stylized side panel mock"
```

---

## Task 5: 场景导览（核心 —— 3 行铺满整行）

实现 spec §3.3 最终布局：每行命令列 520 + 间距 56 + 结果列 736 = 1312，定宽两列正好填满整行，命令恒在左。结果区严格按产品真实渲染（§3.9）：Markdown 表格用 `Markdown.tsx` 样式、Skill 复用入口用 `SkillSlashPopover` 复刻。

**Files:**
- Modify: `landing/index.html`
- Modify: `landing/styles.css`

- [ ] **Step 1: 插入 tour section（标题 + 3 行）**

```html
<section class="section dotgrid tour" id="tour">
  <div class="wrap">
    <div class="tour-head">
      <span class="caps" style="color:var(--c-accent)" data-i18n="tour.eyebrow">How it works</span>
      <h2 class="h-section" data-i18n="tour.title">Say this. Get that.</h2>
      <p class="sub" data-i18n="tour.sub"></p>
    </div>

    <!-- Scenario 01 -->
    <div class="srow">
      <div class="cmd">
        <div class="srow-tag"><span class="caps tag-n">SCENARIO 01</span><span class="caps tag-d" data-i18n="s1.tag"></span></div>
        <div class="prompt"><span class="caps you" data-i18n="you">You say</span><span class="prompt-q" data-i18n="s1.cmd"></span></div>
        <p class="srow-out" data-i18n="s1.out"></p>
      </div>
      <div class="res">
        <div class="reply-surface">
          <div class="reply-badge"><span class="dot"></span><span class="caps" data-i18n="s1.done">Done · 2 steps</span></div>
          <p class="reply-text" data-i18n="s1.ans"></p>
        </div>
      </div>
    </div>

    <!-- Scenario 02 -->
    <div class="srow">
      <div class="cmd">
        <div class="srow-tag"><span class="caps tag-n">SCENARIO 02</span><span class="caps tag-d" data-i18n="s2.tag"></span></div>
        <div class="prompt"><span class="caps you" data-i18n="you">You say</span><span class="prompt-q" data-i18n="s2.cmd"></span></div>
        <p class="srow-out" data-i18n="s2.out"></p>
      </div>
      <div class="res">
        <div class="reply-surface">
          <div class="reply-badge"><span class="dot"></span><span class="caps" data-i18n="s2.done">Done · 6 steps</span></div>
          <div class="md-table">
            <div class="md-tr md-th"><span class="td-a caps" data-i18n="s2.colA">Product</span><span class="td-b caps" data-i18n="s2.colB">Price</span></div>
            <div class="md-tr"><span class="td-a">Sony WH-1000XM5</span><span class="td-b">$348.00</span></div>
            <div class="md-tr"><span class="td-a">Kindle Paperwhite</span><span class="td-b">$139.99</span></div>
            <div class="md-tr"><span class="td-a">Anker 737 Power Bank</span><span class="td-b">$89.99</span></div>
            <div class="md-tr last"><span class="td-a">Logitech MX Master 3S</span><span class="td-b">$99.00</span></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Scenario 03 -->
    <div class="srow">
      <div class="cmd">
        <div class="srow-tag"><span class="caps tag-n">SCENARIO 03</span><span class="caps tag-d" data-i18n="s3.tag"></span></div>
        <div class="prompt"><span class="caps you" data-i18n="you">You say</span><span class="prompt-q" data-i18n="s3.cmd"></span></div>
        <p class="srow-out" data-i18n="s3.out"></p>
      </div>
      <div class="res">
        <div class="popover">
          <div class="pop-head"><span class="mono pop-q">/weekly</span><span class="pop-count" data-i18n="pop.count">2 skills</span></div>
          <div class="pop-item sel">
            <div class="pop-row"><span class="mono pop-slug">/weekly-report</span><span class="caps pop-tag" data-i18n="pop.tag">User</span></div>
            <span class="pop-desc" data-i18n="pop.d1"></span>
          </div>
          <div class="pop-item">
            <div class="pop-row"><span class="mono pop-slug">/weekly-standup</span><span class="caps pop-tag" data-i18n="pop.tag">User</span></div>
            <span class="pop-desc" data-i18n="pop.d2"></span>
          </div>
          <div class="pop-foot"><span class="caps" data-i18n="pop.nav">↑↓ navigate</span><span class="caps" data-i18n="pop.run">↵ run</span><span class="caps" data-i18n="pop.esc">esc</span></div>
        </div>
      </div>
    </div>
  </div>
</section>
```

- [ ] **Step 2: 追加 tour 样式**

```css
.tour .wrap { display:flex; flex-direction:column; gap:80px; }
.tour-head { display:flex; flex-direction:column; gap:16px; max-width:640px; }
.h-section { margin:0; font-size:46px; font-weight:600; line-height:1.08; letter-spacing:-0.02em; }
.sub { margin:0; font-size:17px; line-height:1.55; color:var(--c-fg-2); }

.srow { display:flex; gap:56px; align-items:flex-start; width:100%; }
.cmd { width:520px; flex:0 0 520px; display:flex; flex-direction:column; gap:18px; }
.res { width:736px; flex:0 0 736px; }
.srow-tag { display:flex; align-items:center; gap:8px; }
.tag-n { color:var(--c-accent); font-weight:600; letter-spacing:0.14em; }
.tag-d { color:var(--c-fg-3); letter-spacing:0.14em; }
.prompt { display:flex; flex-direction:column; gap:9px; width:100%; padding:18px 20px; background:var(--c-field); border-radius:16px; }
.prompt .you { color:var(--c-fg-3); }
.prompt-q { font-size:20px; font-weight:500; line-height:1.4; letter-spacing:-0.01em; }
.srow-out { margin:0; font-size:15px; line-height:1.53; color:var(--c-fg-2); }

.reply-surface { display:flex; flex-direction:column; gap:11px; width:100%; padding:18px 20px; background:#fff; border:1px solid var(--c-line); border-radius:14px; box-shadow:0 16px 40px -22px rgba(20,24,29,0.16); }
.reply-text { margin:0; font-size:13px; line-height:1.54; color:var(--c-fg-1); }

/* md table — mirrors src/sidepanel/components/Markdown.tsx (left-aligned, mono caps header) */
.md-table { width:100%; border:1px solid var(--c-line); border-radius:5px; overflow:hidden; }
.md-tr { display:flex; align-items:center; border-bottom:1px solid #EEF1F3; }
.md-tr.last { border-bottom:0; }
.md-th { border-bottom:1px solid var(--c-line); }
.md-tr .td-a { flex:1; padding:7px 10px; font-size:12px; color:var(--c-fg-1); }
.md-tr .td-b { width:96px; padding:7px 10px; font-size:12px; color:var(--c-fg-1); }
.md-th .td-a, .md-th .td-b { font-size:10px; letter-spacing:0.08em; color:var(--c-fg-3); }

/* slash popover — mirrors SkillSlashPopover.tsx */
.popover { width:100%; background:#fff; border:1px solid var(--c-line); border-radius:10px; box-shadow:0 8px 24px rgba(20,24,29,0.12); overflow:hidden; }
.pop-head { display:flex; align-items:center; gap:8px; padding:10px 14px; border-bottom:1px solid var(--c-line); }
.pop-q { font-size:11px; color:var(--c-accent); }
.pop-count { font-size:11px; color:var(--c-fg-3); }
.pop-item { display:flex; flex-direction:column; gap:4px; padding:10px 14px; border-bottom:1px solid var(--c-line); }
.pop-item:last-of-type { border-bottom:0; }
.pop-item.sel { border-left:2px solid var(--c-accent); padding-left:12px; background:var(--c-accent-tint); }
.pop-row { display:flex; align-items:center; }
.pop-slug { font-size:12px; color:var(--c-fg-1); }
.pop-tag { margin-left:auto; letter-spacing:0.08em; color:var(--c-fg-3); }
.pop-desc { font-size:12px; line-height:1.5; color:var(--c-fg-2); }
.pop-foot { display:flex; gap:14px; padding:6px 14px; border-top:1px solid var(--c-line); background:var(--c-canvas); }
.pop-foot .caps { letter-spacing:0.08em; color:var(--c-fg-3); }
```

- [ ] **Step 3: 起服务核对（关键回归点）**

Open `http://localhost:8000`，对照 Paper `Pie Landing — C (EN)` 的场景区：
- 每行命令(左)→结果(右)**铺满整行**、间距 ~56、**右侧无留白、中间无大洞**。
- 表格：圆角边框、等宽大写表头、左对齐 12px 单元格。
- popover：第一项高亮（左条 accent + 浅底）。
- 切「中」：全部文案中文、布局不变。

- [ ] **Step 4: Commit**

```bash
git add landing/index.html landing/styles.css
git commit -m "feat(landing): scenario tour, full-width pairs, product-faithful results"
```

---

## Task 6: 信任条（4 列顶对齐 + 竖分隔线）

**Files:** Modify `landing/index.html`, `landing/styles.css`

- [ ] **Step 1: 插入 trust section**

```html
<section class="trust" id="trust">
  <div class="wrap trust-in">
    <div class="trust-item">
      <svg class="ti" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      <span class="ti-t" data-i18n="trust.byok">BYOK</span><span class="ti-d" data-i18n="trust.byok.d"></span>
    </div>
    <div class="trust-div"></div>
    <div class="trust-item">
      <svg class="ti" viewBox="0 0 24 24"><path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/></svg>
      <span class="ti-t" data-i18n="trust.oss">Open-source</span><span class="ti-d" data-i18n="trust.oss.d"></span>
    </div>
    <div class="trust-div"></div>
    <div class="trust-item">
      <svg class="ti" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      <span class="ti-t" data-i18n="trust.tel">No telemetry</span><span class="ti-d" data-i18n="trust.tel.d"></span>
    </div>
    <div class="trust-div"></div>
    <div class="trust-item">
      <svg class="ti" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      <span class="ti-t" data-i18n="trust.prov">10 providers</span><span class="ti-d" data-i18n="trust.prov.d"></span>
    </div>
  </div>
</section>
```

- [ ] **Step 2: 追加样式**

```css
.trust { border-top:1px solid var(--c-line); border-bottom:1px solid var(--c-line); background:var(--c-canvas); }
.trust-in { display:flex; align-items:flex-start; padding:44px 64px; }
.trust-item { display:flex; flex-direction:column; gap:10px; flex:1; padding:0 40px; }
.trust-item:first-child { padding-left:0; } .trust-item:last-child { padding-right:0; }
.trust-item .ti { width:20px; height:20px; fill:none; stroke:var(--c-fg-1); stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
.ti-t { font-size:15px; font-weight:600; }
.ti-d { font-size:13px; line-height:1.46; color:var(--c-fg-2); }
.trust-div { width:1px; align-self:center; height:52px; background:var(--c-line); flex-shrink:0; }
```

- [ ] **Step 3: 核对** —— 四块图标/标题/说明各自在同一水平线；竖线垂直居中；切语言正常。

- [ ] **Step 4: Commit**

```bash
git add landing/index.html landing/styles.css
git commit -m "feat(landing): trust strip"
```

---

## Task 7: 能力网格（发丝线矩阵 3×2）

**Files:** Modify `landing/index.html`, `landing/styles.css`

- [ ] **Step 1: 插入 capabilities section**

```html
<section class="section dotgrid caps-sec" id="caps">
  <div class="wrap caps-wrap">
    <div class="cap-head">
      <span class="caps" style="color:var(--c-accent)" data-i18n="cap.eyebrow">Capabilities</span>
      <h2 class="h-section sm" data-i18n="cap.title">And quite a bit more.</h2>
      <p class="sub" data-i18n="cap.sub"></p>
    </div>
    <div class="cap-grid" id="cap-grid"></div>
  </div>
</section>
```

- [ ] **Step 2: 在 `main.js` 的 DOMContentLoaded 里（`initLang()` 之前）渲染 6 个 cell**（避免在 HTML 里手写 6 份重复结构；图标 path 内联）

```js
const CAP_ICONS = {
  1:'<path d="M4 4l6 16 2.2-6.8L19 11z"/>',
  2:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  3:'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/>',
  4:'<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.4M10 10h.4M14 10h.4M18 10h.4M8 14h8"/>',
  5:'<circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/>',
  6:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
};
function renderCaps() {
  const grid = document.getElementById("cap-grid"); if (!grid) return;
  grid.innerHTML = [1,2,3,4,5,6].map(n =>
    `<div class="cap-cell"><svg class="cap-ic" viewBox="0 0 24 24">${CAP_ICONS[n]}</svg>`+
    `<span class="cap-t" data-i18n="cap.${n}"></span>`+
    `<span class="cap-d" data-i18n="cap.${n}d"></span></div>`).join("");
}
```

在 DOMContentLoaded 回调里，`initLang()` 之前调用 `renderCaps();`（这样 applyLang 能填充新插入节点的文案）。

- [ ] **Step 3: 追加样式**

```css
.caps-wrap { display:flex; flex-direction:column; gap:44px; }
.cap-head { display:flex; flex-direction:column; gap:16px; max-width:640px; }
.h-section.sm { font-size:38px; }
.cap-grid { display:flex; flex-wrap:wrap; border-top:1px solid var(--c-line); border-left:1px solid var(--c-line); }
.cap-cell { display:flex; flex-direction:column; gap:12px; flex-basis:33.333%; box-sizing:border-box; border-right:1px solid var(--c-line); border-bottom:1px solid var(--c-line); padding:28px 26px; }
.cap-ic { width:20px; height:20px; fill:none; stroke:var(--c-fg-1); stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
.cap-t { font-size:16px; font-weight:600; }
.cap-d { font-size:13.5px; line-height:1.48; color:var(--c-fg-2); }
```

> 注：CSS `flex-basis:33.333%` 在真实浏览器里能正确换行成 3 列（这是 Paper 预览的局限，不是 CSS 的问题）。无需 Paper 里那套「行容器」hack。

- [ ] **Step 4: 核对** —— 干净 3×2 发丝线矩阵、闭合无双线；切语言正常。

- [ ] **Step 5: Commit**

```bash
git add landing/index.html landing/styles.css landing/main.js
git commit -m "feat(landing): capabilities hairline grid"
```

---

## Task 8: 深色 CTA 收束带

**Files:** Modify `landing/index.html`, `landing/styles.css`

- [ ] **Step 1: 插入 CTA section**

```html
<section class="cta-dark dotgrid-dark" id="cta">
  <div class="wrap cta-in">
    <svg class="cta-mark" width="44" height="44" viewBox="0 0 128 128"><rect width="128" height="128" rx="26" fill="#FAFBFC"/><circle cx="64" cy="64" r="44" fill="#14181D"/><circle cx="98" cy="30" r="22" fill="#FAFBFC"/></svg>
    <span class="caps cta-eyebrow" data-i18n="cta.eyebrow">Get started</span>
    <h2 class="cta-title" data-i18n="cta.title">Put your browser to work.</h2>
    <p class="cta-sub" data-i18n="cta.sub"></p>
    <div class="cta-row">
      <a class="btn-light" data-href="store" data-i18n="cta.install">Add to Chrome — free</a>
      <a class="btn-ghost-dark" data-href="github">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="#FAFBFC"><path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2 1-.3 2-.4 3-.4s2 .1 3 .4c2.3-1.6 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z"/></svg>
        <span data-i18n="cta.star">Star on GitHub</span>
      </a>
    </div>
    <span class="mono cta-meta" data-i18n="cta.meta">Chrome · Manifest V3 · v0.19</span>
  </div>
</section>
```

- [ ] **Step 2: 追加样式**

```css
.cta-dark { background:var(--c-fg-1); padding:104px 64px; }
.cta-in { display:flex; flex-direction:column; align-items:center; gap:22px; text-align:center; }
.cta-eyebrow { color:#B8C8D6; }
.cta-title { margin:0; font-size:46px; font-weight:600; line-height:1.08; letter-spacing:-0.02em; color:var(--c-canvas); }
.cta-sub { margin:0; font-size:17px; line-height:1.55; color:#8A929E; max-width:440px; }
.btn-light { display:inline-flex; align-items:center; padding:14px 24px; background:var(--c-canvas); color:var(--c-fg-1); border-radius:11px; font-size:15px; font-weight:600; cursor:pointer; transition:transform 150ms var(--ease); }
.btn-light:hover { transform:translateY(-1px); }
.btn-ghost-dark { display:inline-flex; align-items:center; gap:8px; padding:13px 20px; border:1px solid rgba(250,251,252,0.22); border-radius:11px; font-size:15px; font-weight:500; color:var(--c-canvas); cursor:pointer; }
.cta-meta { color:#525965; font-size:12px; }
```

- [ ] **Step 3: 核对 + Commit**

```bash
git add landing/index.html landing/styles.css
git commit -m "feat(landing): dark closing CTA band"
```

---

## Task 9: 页脚

**Files:** Modify `landing/index.html`, `landing/styles.css`

- [ ] **Step 1: 插入 footer**

```html
<footer class="foot">
  <div class="wrap">
    <div class="foot-top">
      <div class="foot-brand">
        <a class="brand" href="#top"><svg width="24" height="24" viewBox="0 0 128 128"><rect width="128" height="128" rx="26" fill="#14181D"/><circle cx="64" cy="64" r="44" fill="#FAFBFC"/><circle cx="98" cy="30" r="22" fill="#14181D"/></svg><span class="brand-word" style="font-size:17px">Pie</span></a>
        <span class="foot-tag" data-i18n="foot.tagline"></span>
      </div>
      <nav class="foot-links">
        <a data-href="privacy" data-i18n="foot.privacy">Privacy</a>
        <a data-href="changelog" data-i18n="foot.changelog">Changelog</a>
        <a data-href="roadmap" data-i18n="foot.roadmap">Roadmap</a>
        <a data-href="arch" data-i18n="foot.arch">Architecture</a>
        <a data-href="github" data-i18n="foot.github">GitHub</a>
        <a data-href="store" data-i18n="foot.store">Chrome Web Store</a>
      </nav>
    </div>
    <div class="hairline"></div>
    <div class="foot-bottom">
      <span class="mono" data-i18n="foot.copy">© 2026 Pie · Open-source · MIT</span>
      <span class="mono" data-i18n="foot.made">Made for Chrome</span>
    </div>
  </div>
</footer>
```

- [ ] **Step 2: 追加样式**

```css
.foot { background:var(--c-canvas); border-top:1px solid var(--c-line); padding:56px 64px 40px; }
.foot .wrap { display:flex; flex-direction:column; gap:28px; }
.foot-top { display:flex; align-items:flex-start; justify-content:space-between; }
.foot-brand { display:flex; flex-direction:column; gap:10px; }
.foot-tag { font-size:13px; line-height:1.46; color:var(--c-fg-3); max-width:280px; }
.foot-links { display:flex; flex-wrap:wrap; align-items:center; gap:26px; }
.foot-links a { font-size:14px; color:var(--c-fg-2); }
.foot-links a:hover { color:var(--c-fg-1); }
.foot-bottom { display:flex; align-items:center; justify-content:space-between; }
.foot-bottom .mono { font-size:11px; color:var(--c-fg-3); }
```

- [ ] **Step 3: 核对（链接指向正确）+ Commit**

```bash
git add landing/index.html landing/styles.css
git commit -m "feat(landing): footer"
```

---

## Task 10: 背景点阵 + 悬浮聚光动效

实现 spec §3.10：点阵铺 Hero/场景/能力区，深色 CTA 用浅色星点；唯一动效=悬浮聚光（`pointermove` 更新 CSS 变量，叠一层受 mask 约束的提亮层）；`prefers-reduced-motion` 关闭。

**Files:** Modify `landing/styles.css`, `landing/main.js`

- [ ] **Step 1: 追加点阵 + 聚光样式**

```css
.dotgrid { position:relative; }
.dotgrid::before {
  content:""; position:absolute; inset:0; z-index:0; pointer-events:none;
  background-image:radial-gradient(circle at 1px 1px, var(--c-dot) 1px, transparent 0);
  background-size:24px 24px;
}
.dotgrid > * { position:relative; z-index:1; }

.dotgrid-dark { position:relative; }
.dotgrid-dark::before {
  content:""; position:absolute; inset:0; z-index:0; pointer-events:none;
  background-image:radial-gradient(circle at 1px 1px, var(--c-dot-dark) 1px, transparent 0);
  background-size:26px 26px;
}
.dotgrid-dark > * { position:relative; z-index:1; }

/* 悬浮聚光：在点阵层上叠一圈跟随指针的提亮 mask */
.dotgrid.spotlight::after, .dotgrid-dark.spotlight::after {
  content:""; position:absolute; inset:0; z-index:0; pointer-events:none;
  background-image:radial-gradient(circle at 1px 1px, var(--c-accent) 1px, transparent 0);
  background-size:24px 24px;
  -webkit-mask-image:radial-gradient(220px circle at var(--mx,-999px) var(--my,-999px), #000 0%, transparent 70%);
  mask-image:radial-gradient(220px circle at var(--mx,-999px) var(--my,-999px), #000 0%, transparent 70%);
  opacity:0.5; transition:opacity 200ms var(--ease);
}
.dotgrid-dark.spotlight::after { background-image:radial-gradient(circle at 1px 1px, #B8C8D6 1px, transparent 0); background-size:26px 26px; }
```

- [ ] **Step 2: 在 `main.js` 加聚光逻辑（DOMContentLoaded 内）**

```js
function initSpotlight() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (matchMedia("(hover: none)").matches) return; // 触屏不启用
  document.querySelectorAll(".dotgrid, .dotgrid-dark").forEach(sec => {
    sec.classList.add("spotlight");
    sec.addEventListener("pointermove", e => {
      const r = sec.getBoundingClientRect();
      sec.style.setProperty("--mx", (e.clientX - r.left) + "px");
      sec.style.setProperty("--my", (e.clientY - r.top) + "px");
    });
    sec.addEventListener("pointerleave", () => {
      sec.style.setProperty("--mx", "-999px"); sec.style.setProperty("--my", "-999px");
    });
  });
}
```

在 DOMContentLoaded 回调末尾调用 `initSpotlight();`。

- [ ] **Step 3: 核对**

Open `http://localhost:8000`：各浅色区/深色 CTA 有若隐若现点阵；鼠标在区块上移动，指针周围一圈点轻微提亮（石板蓝/浅色），离开消失。系统开启「减少动态效果」时聚光不启用（点阵静态保留）。

- [ ] **Step 4: Commit**

```bash
git add landing/styles.css landing/main.js
git commit -m "feat(landing): dot-grid background + cursor spotlight"
```

---

## Task 11: 响应式（窄屏纵向堆叠）

桌面优先；在 ≤960px 与 ≤640px 两个断点收敛。核心：hero 与场景行从两列变单列堆叠；能力网格变 1 列；section 横向 padding 收小。

**Files:** Modify `landing/styles.css`

- [ ] **Step 1: 追加响应式**

```css
@media (max-width: 1024px) {
  .section, .trust-in, .cta-dark, .foot, .topbar-in { padding-left:40px; padding-right:40px; }
  .hero-title { font-size:52px; }
}
@media (max-width: 960px) {
  .hero-in { flex-direction:column; align-items:flex-start; gap:48px; }
  .panel { width:100%; max-width:432px; }
  .srow { flex-direction:column; gap:20px; }
  .cmd, .res { width:100%; flex:1 1 auto; }
  .cap-cell { flex-basis:50%; }
}
@media (max-width: 640px) {
  .section { padding-top:72px; padding-bottom:72px; padding-left:22px; padding-right:22px; }
  .topbar-in, .trust-in, .cta-dark, .foot { padding-left:22px; padding-right:22px; }
  .hero-title { font-size:40px; }
  .h-section { font-size:34px; } .h-section.sm { font-size:30px; }
  .trust-in { flex-wrap:wrap; gap:28px 0; } .trust-item { flex-basis:50%; flex:0 0 50%; padding:0 16px 0 0; } .trust-div { display:none; }
  .cap-cell { flex-basis:100%; }
  .foot-top { flex-direction:column; gap:24px; }
  .nav-right { gap:10px; } .gh-pill { display:none; }
}
```

- [ ] **Step 2: 核对**

DevTools 设备模拟 390px / 768px / 1280px：hero 与场景行单列堆叠、命令在结果之上；能力网格 768→2 列 / 390→1 列；信任条 390→2×2；无横向滚动条；切语言正常。

- [ ] **Step 3: Commit**

```bash
git add landing/styles.css
git commit -m "feat(landing): responsive layout"
```

---

## Task 12: SEO/OG/可访问性 + 全面验证

**Files:** Modify `landing/index.html`；Create `landing/og-image.png`、`landing/robots.txt`

- [ ] **Step 1: 在 `<head>` 补 OG / Twitter / theme-color**

```html
<meta name="theme-color" content="#FAFBFC" />
<meta property="og:type" content="website" />
<meta property="og:title" content="Pie — Tell your browser what to do." />
<meta property="og:description" content="A browser-automation agent that runs on your own API key. Free, open-source, no telemetry." />
<meta property="og:image" content="/og-image.png" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="canonical" href="https://pie.example.com/" />
```

> `og:image` 暂用 1200×630 占位（可用 Paper 导出 hero 截图）；canonical 域名在确定 Vercel 域名后更新。

- [ ] **Step 2: 建 `landing/robots.txt`**

```
User-agent: *
Allow: /
```

- [ ] **Step 3: 可访问性微调**

确认：`<html lang>` 随切换更新（已实现）；所有交互元素是 `<a>`/`<button>`；side panel 容器 `aria-hidden="true"`（装饰性）；图标 SVG 无语义文本不需 aria（装饰）；CTA 文字有真实文本。给 `.lang-btn` 加 `:focus-visible` 描边：

```css
.lang-btn:focus-visible, .btn-ink:focus-visible, .btn-outline:focus-visible, .btn-light:focus-visible, .foot-links a:focus-visible { outline:2px solid var(--c-accent); outline-offset:2px; }
```

- [ ] **Step 4: 全量验证（两种语言 + Lighthouse）**

- 浏览器逐区对照 Paper EN/中文两块画板：顶栏、hero、场景区(铺满整行)、信任条、能力网格、深色 CTA、页脚。
- 切语言：全部文案切换、`<html lang>` 变化、localStorage 记忆、刷新保持。
- 链接：Install→Chrome Web Store、GitHub/Privacy/Changelog/Roadmap/Architecture 均新标签打开且 URL 正确。
- Lighthouse（Chrome DevTools，Desktop）：Performance/Accessibility/Best-Practices/SEO 目标 ≥90；`prefers-reduced-motion` 下聚光关闭、点阵静态。
- 有 Playwright MCP 时：`browser_navigate` 到 localhost，`browser_take_screenshot` 全页，肉眼比对 Paper 全页截图。

- [ ] **Step 5: Commit**

```bash
git add landing/index.html landing/robots.txt landing/og-image.png landing/styles.css
git commit -m "feat(landing): SEO/OG meta, a11y focus states, robots"
```

---

## Task 13: Vercel 部署

**Files:** Create `landing/README.md`

- [ ] **Step 1: 写 `landing/README.md`**

````markdown
# Pie Landing Page

纯静态站（无构建步骤）。本地预览：`python3 -m http.server 8000`。

## Deploy (Vercel)
- 新建 Vercel 项目，连本仓库。
- **Root Directory = `landing`**，Framework Preset = **Other**（无 build command，Output 即根目录）。
- `vercel.json` 已配 cleanUrls + 安全头。
- 部署后更新 `index.html` 的 `og:image` / canonical 域名。
````

- [ ] **Step 2: 本地用 Vercel CLI 预演（可选）**

Run: `cd landing && npx vercel --prod`（首次会引导登录与项目设置；Root Directory 选 `landing` 或在该目录直接部署）。
Expected: 输出生产 URL，打开与本地一致。

> 若用 Dashboard：导入仓库 → Root Directory 设 `landing` → Deploy。

- [ ] **Step 3: 线上验收**

打开生产 URL：两种语言、链接、响应式、聚光、Lighthouse 复测一遍（同 Task 12）。

- [ ] **Step 4: Commit**

```bash
git add landing/README.md
git commit -m "docs(landing): deploy notes for Vercel"
```

---

## 验收标准（对应 spec §7）

- 视觉与扩展同源（token/字体/点阵/发丝线/圆角/动效一致）。✔ Task 1/4–10
- 中英可切换且记忆，`<html lang>` 正确。✔ Task 2/3
- 主 CTA → 真实 Chrome Web Store；GitHub 等链接正确。✔ Task 3/9
- 移动端可读（窄屏堆叠）。✔ Task 11
- Lighthouse ≥90，`prefers-reduced-motion` 生效。✔ Task 10/12
- Vercel 静态部署成功，Root Directory=`landing`。✔ Task 13
- 「Agent 结果」只复刻已上线 UI（§3.9）。✔ Task 4/5

## 仍待业务确认（非阻塞）

- `og:image` 实图、canonical 域名（Task 12 占位）。
- 是否保留 GitHub star fetch（Task 3，唯一外链请求）。
- 真实录屏 GIF 替换 hero 风格化复刻（后续增量）。
- 深色模式（token 已备，后续增量）。
