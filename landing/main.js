// ── i18n dictionary (verbatim from Paper artboards) ──────────────────
const I18N = {
  en: {
    "nav.install":"Add to Chrome", "nav.star":"Star",
    "hero.eyebrow":"AI in your browser",
    "hero.title":"Tell your browser what to do.",
    "hero.sub":"Pie is an open-source browser agent that can read pages, operate websites, turn messy page content into usable data, and replay your own workflows as skills — all with your own model key.",
    "hero.cta":"Add to Chrome", "hero.star":"Star on GitHub",
    "hero.micro":"Open-source  ·  BYOK  ·  No telemetry",
    "panel.title":"Summarize page",
    "panel.user":"Summarize this page in 3 points",
    "panel.done":"Done · 3 steps",
    "panel.b1":"Understands the current page instead of asking you to copy text around.",
    "panel.b2":"Uses browser tools to click, type, search, read, and move across tabs.",
    "panel.b3":"Turns repeated work into reusable skills you can run again.",
    "panel.input":"Ask or describe a task…",
    "tour.eyebrow":"How it works", "tour.title":"Say this. Get that.",
    "tour.sub":"No scripts, no setup ritual. Ask for the outcome; Pie reads the page, chooses the right tools, and works through the steps.",
    "you":"You say",
    "s1.tag":"· PAGE & PDF Q&A", "s1.cmd":"“What’s the refund policy on this page?”",
    "s1.out":"Ask anything about the current page, a long app screen, or a PDF. Pie pulls out the relevant content so you don't have to copy, paste, or hunt through the DOM.",
    "s1.done":"Done · 2 steps",
    "s1.ans":"Refunds are accepted within 30 days of delivery. Opened items qualify only if the original seal is intact, and shipping costs are non-refundable.",
    "s2.tag":"· DATA EXTRACTION", "s2.cmd":"“Pull the price from each of these tabs into a table.”",
    "s2.out":"Pie can collect structured facts from pages, compare them, clean them up, and hand back a table or file when the answer needs more than plain text.",
    "s2.done":"Done · 6 steps", "s2.colA":"Product", "s2.colB":"Price",
    "s3.tag":"· SKILLS & AUTOMATION", "s3.cmd":"“This one's hard to explain — let me just show you.”",
    "s3.out":"Some workflows are easier to demonstrate. Walk through one once and Pie saves it as a skill — then runs the whole routine from a single /command, scoped to only the tools it needs.",
    "pop.count":"2 skills",
    "pop.d1":"Collects this week's open tabs and summarizes each one.",
    "pop.d2":"Draft a standup note from yesterday's tabs and docs.",
    "pop.tag":"User", "pop.nav":"↑↓ navigate", "pop.run":"↵ run", "pop.esc":"esc",
    "rec.label":"RECORDING", "rec.steps":"8 STEPS", "rec.cancel":"Cancel", "rec.finish":"Finish",
    "trust.byok":"BYOK", "trust.byok.d":"Use your own model key. It stays encrypted on your device.",
    "trust.oss":"Open-source", "trust.oss.d":"Code, license, and release history are public on GitHub.",
    "trust.tel":"No telemetry", "trust.tel.d":"No backend, no proxy. Nothing routes through us.",
    "trust.prov":"11 providers", "trust.prov.d":"Claude, GPT, Gemini, DeepSeek, Kimi, StepFun & more.",
    "cap.eyebrow":"Capabilities", "cap.title":"What Pie is good at.",
    "cap.sub":"The important bit is not a longer prompt box. It is a browser agent with page context, tools, skills, data output, and privacy defaults you can understand.",
    "cap.1":"Agent work", "cap.1d":"Pie plans multi-step tasks and uses browser tools for reading, clicking, typing, searching, scrolling, tabs, PDFs, and page editors.",
    "cap.2":"Page content", "cap.2d":"Ask about the page you're on. Pie can read long pages, app screens, PDFs, tables, selected text, and open-tab content.",
    "cap.3":"Data processing", "cap.3d":"Extract fields, compare items, reshape page content into tables, and produce downloadable CSV, JSON, Markdown, or text files.",
    "cap.4":"Skills", "cap.4d":"Save repeatable workflows as slash commands. Record a task once, then run it again without explaining every tiny step.",
    "cap.5":"Web automation", "cap.5d":"Use it for the boring browser work: filling forms, collecting research, moving across tabs, and operating complex web apps.",
    "cap.6":"Security & privacy", "cap.6d":"Bring your own key, keep secrets encrypted locally, avoid Pie-operated backends, and keep untrusted page content isolated.",
    "project.eyebrow":"Open project", "project.title":"Transparent by default.",
    "project.sub":"Pie is developed in the open. The license, release notes, and historical versions are easy to inspect before you install or upgrade.",
    "project.license.k":"License", "project.license.t":"Apache-2.0", "project.license.d":"A permissive open-source license with an explicit patent grant.",
    "project.latest.k":"Latest notes", "project.latest.t":"v1.0.0", "project.latest.d":"Pie's first stable major — long-horizon task tooling, a rebuilt storage layer, and a redesigned side panel.",
    "project.history.k":"Version history", "project.history.t":"All releases", "project.history.d":"Browse tagged releases, assets, and older notes directly on GitHub.",
    "version.100":"First stable major: long-horizon task memory, a new storage foundation, and a redesigned side panel.",
    "version.0195":"Model picker, in-page editor read/write, and resumable abort.",
    "version.0192":"Better large-page reading, search, recording fidelity, and pinned-tab safety.",
    "version.0190":"Kimi provider, thinking display, search_page, and per-model attributes.",
    "cta.eyebrow":"Get started", "cta.title":"Put your browser to work",
    "cta.sub":"Install Pie, describe a task, and let it handle the steps.",
    "cta.install":"Add to Chrome", "cta.star":"Star on GitHub", "cta.meta":"Chrome · Manifest V3 · v1.0.0",
    "foot.tagline":"An open-source AI agent that lives in your browser.",
    "foot.privacy":"Privacy", "foot.license":"License", "foot.release":"Release notes",
    "foot.releases":"Versions", "foot.roadmap":"Roadmap", "foot.github":"GitHub", "foot.store":"Chrome Web Store",
    "foot.copy":"© 2026 Pie · Open-source · Apache-2.0", "foot.made":"Made for Chrome",
  },
  zh: {
    "nav.install":"添加到 Chrome", "nav.star":"Star",
    "hero.eyebrow":"浏览器里的 AI Agent",
    "hero.title":"说一句话，浏览器替你干完。",
    "hero.sub":"Pie 是一个开源浏览器 Agent：能读网页、操作网站、把页面内容整理成可用数据，也能把你演示过的流程保存成技能。模型用你自己的 key。",
    "hero.cta":"添加到 Chrome", "hero.star":"在 GitHub 上 Star",
    "hero.micro":"开源  ·  BYOK  ·  无遥测",
    "panel.title":"总结这页",
    "panel.user":"把这页总结成 3 点",
    "panel.done":"完成 · 3 步",
    "panel.b1":"它直接理解当前页面，不用你到处复制粘贴。",
    "panel.b2":"会用浏览器工具去点击、输入、搜索、读取和切换标签。",
    "panel.b3":"重复工作可以沉淀成技能，下次直接运行。",
    "panel.input":"问点什么，或者说个任务…",
    "tour.eyebrow":"怎么用", "tour.title":"说句话，就有结果。",
    "tour.sub":"不用写脚本，也不用研究一堆设置。你说想要的结果，Pie 读取页面、选择工具，然后一步步做完。",
    "you":"你说",
    "s1.tag":"· 网页 & PDF 问答", "s1.cmd":"「这页的退款政策是啥？」",
    "s1.out":"当前网页、长应用页面、打开的 PDF，都可以直接问。Pie 会抓出相关内容，不用你复制粘贴，也不用自己翻 DOM。",
    "s1.done":"完成 · 2 步",
    "s1.ans":"支持自收货起 30 天内退款。已拆封商品需原封条完好；运费不予退还。",
    "s2.tag":"· 数据提取", "s2.cmd":"「把这几个标签页里的价格扒下来，弄成一张表。」",
    "s2.out":"Pie 可以从页面里提取字段、对比信息、清理格式，需要时还能输出表格或文件，不只是回一段文字。",
    "s2.done":"完成 · 6 步", "s2.colA":"商品", "s2.colB":"价格",
    "s3.tag":"· 技能 & 自动化", "s3.cmd":"「这个不好描述，我直接录一遍给你看。」",
    "s3.out":"有些流程讲半天不如演一遍。你亲手走一遍，Pie 就把它存成技能——下次一个 /命令，整套流程重跑，而且只拿它需要的工具权限。",
    "pop.count":"2 个技能",
    "pop.d1":"把这周开过的标签收拢一遍，挨个总结。",
    "pop.d2":"照着昨天的标签和文档，起草一份站会要点。",
    "pop.tag":"用户", "pop.nav":"↑↓ 选择", "pop.run":"↵ 运行", "pop.esc":"esc 关闭",
    "rec.label":"录制中", "rec.steps":"8 步", "rec.cancel":"取消", "rec.finish":"完成",
    "trust.byok":"BYOK", "trust.byok.d":"用你自己的模型 key，并加密保存在本地。",
    "trust.oss":"开源", "trust.oss.d":"代码、许可证、历史版本都公开在 GitHub。",
    "trust.tel":"无遥测", "trust.tel.d":"没后端也没代理，啥都不过我们的手。",
    "trust.prov":"11 家 provider", "trust.prov.d":"Claude、GPT、Gemini、DeepSeek、Kimi、阶跃等。",
    "cap.eyebrow":"能力", "cap.title":"Pie 主要能做什么。",
    "cap.sub":"重点不是多一个聊天框，而是一个有页面上下文、会用工具、能沉淀技能、能处理数据、也尊重隐私的浏览器 Agent。",
    "cap.1":"Agent 能力", "cap.1d":"Pie 会规划多步任务，并使用读取、点击、输入、搜索、滚动、标签页、PDF、页面编辑器等浏览器工具。",
    "cap.2":"页面内容获取", "cap.2d":"当前页面可以直接问。长网页、应用界面、PDF、表格、选中文本、打开的标签内容都能读。",
    "cap.3":"数据处理", "cap.3d":"从页面提字段、比信息、整理格式，把散乱内容变成表格，也可以生成 CSV、JSON、Markdown 或文本文件。",
    "cap.4":"技能", "cap.4d":"把重复流程保存成 slash command。演示一次，以后不用再把每个小步骤重新讲一遍。",
    "cap.5":"网页自动化", "cap.5d":"适合处理浏览器里的琐事：填表、收集资料、跨标签整理、操作复杂 Web App。",
    "cap.6":"安全与隐私", "cap.6d":"自带 key、本地加密、不走 Pie 的后端；网页内容按不可信输入隔离，减少提示注入风险。",
    "project.eyebrow":"开源项目", "project.title":"信息默认透明。",
    "project.sub":"Pie 在 GitHub 上开放开发。安装或升级前，你可以直接查看许可证、release notes 和历史版本。",
    "project.license.k":"许可证", "project.license.t":"Apache-2.0", "project.license.d":"宽松的开源许可证，并带有明确的专利授权。",
    "project.latest.k":"最新更新", "project.latest.t":"v1.0.0", "project.latest.d":"Pie 首个稳定大版本——长程任务工具链、重建的存储层、重做的侧边栏。",
    "project.history.k":"历史版本", "project.history.t":"全部 Releases", "project.history.d":"在 GitHub 上查看 tag、安装包、旧版本说明和历史变更。",
    "version.100":"首个稳定大版本：长程任务记忆、全新存储底座、重做的侧边栏。",
    "version.0195":"模型选择器、页面编辑器读写、停止任务后可续接。",
    "version.0192":"大型页面读取、搜索、录制还原度和 pinned tab 安全增强。",
    "version.0190":"Kimi provider、thinking 展示、search_page 和模型属性编辑。",
    "cta.eyebrow":"开始使用", "cta.title":"让浏览器替你干活",
    "cta.sub":"装上 Pie，说出任务，剩下的步骤交给它。",
    "cta.install":"添加到 Chrome", "cta.star":"在 GitHub 上 Star", "cta.meta":"Chrome · Manifest V3 · v1.0.0",
    "foot.tagline":"一个住在你浏览器里的开源 AI agent。",
    "foot.privacy":"隐私", "foot.license":"许可证", "foot.release":"更新日志",
    "foot.releases":"历史版本", "foot.roadmap":"路线图", "foot.github":"GitHub", "foot.store":"Chrome 应用商店",
    "foot.copy":"© 2026 Pie · 开源 · Apache-2.0", "foot.made":"为 Chrome 打造",
  },
};

// 外链常量（实施时确认）
const LINKS = {
  store:"https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed",
  github:"https://github.com/WiseriaAI/pie-ai-agent",
  privacy:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/PRIVACY.md",
  license:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/LICENSE",
  changelog:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/CHANGELOG.md",
  releases:"https://github.com/WiseriaAI/pie-ai-agent/releases",
  releaseLatest:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/docs/release-notes/v1.0.0.md",
  release100:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/docs/release-notes/v1.0.0.md",
  release0195:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/docs/release-notes/v0.19.5.md",
  release0192:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/docs/release-notes/v0.19.2.md",
  release0190:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/docs/release-notes/v0.19.0.md",
  roadmap:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/docs/ROADMAP.md",
  arch:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/docs/ARCHITECTURE.md",
};

// ── i18n apply ───────────────────────────────────────────────────────
let langTransitionTimers = [];

function normalizedLang(lang) {
  return lang === "zh" ? "zh" : "en";
}

function currentLang() {
  return document.documentElement.lang === "zh-CN" ? "zh" : "en";
}

function clearLangTransition() {
  langTransitionTimers.forEach(timer => clearTimeout(timer));
  langTransitionTimers = [];
  document.documentElement.classList.remove("lang-animating", "lang-fade-out", "lang-fade-in");
}

function setLangContent(lang) {
  lang = normalizedLang(lang);
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

function applyLang(lang, options = {}) {
  const nextLang = normalizedLang(lang);
  const reduceMotion = typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  const shouldAnimate = Boolean(options.animate) && nextLang !== currentLang() && !reduceMotion;

  clearLangTransition();

  if (!shouldAnimate) {
    setLangContent(nextLang);
    return;
  }

  document.documentElement.classList.add("lang-animating", "lang-fade-out");
  langTransitionTimers.push(setTimeout(() => {
    setLangContent(nextLang);
    document.documentElement.classList.remove("lang-fade-out");
    document.documentElement.classList.add("lang-fade-in");
    langTransitionTimers.push(setTimeout(() => {
      document.documentElement.classList.remove("lang-animating", "lang-fade-in");
    }, 240));
  }, 150));
}

function initLang() {
  let lang = "en";
  try { const s = localStorage.getItem("pie-lang"); if (s === "en" || s === "zh") lang = s; } catch {}
  applyLang(lang);
  document.querySelectorAll("[data-lang-btn]").forEach(b =>
    b.addEventListener("click", () => applyLang(b.dataset.langBtn, { animate: true })));
}

// ── scroll reveal (scenario rows slide in L/R; other blocks fade up) ──────
function initReveal() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!("IntersectionObserver" in window)) return;
  document.documentElement.classList.add("js-reveal");
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    });
  }, { threshold: 0.18, rootMargin: "0px 0px -10% 0px" });
  document.querySelectorAll(".srow, .reveal-up").forEach(el => io.observe(el));
}

// ── cursor spotlight (only motion effect; off for reduced-motion / touch) ──
function initSpotlight() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (matchMedia("(hover: none)").matches) return;
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

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-href]").forEach(a => {
    const u = LINKS[a.dataset.href]; if (u) { a.href = u; a.target = "_blank"; a.rel = "noopener"; }
  });
  initLang();
  initReveal();
  initSpotlight();
  // 可选：拉取 GitHub star 数（失败静默）
  fetch("https://api.github.com/repos/WiseriaAI/pie-ai-agent")
    .then(r => r.ok ? r.json() : null)
    .then(d => { if (d && typeof d.stargazers_count === "number") {
      const el = document.getElementById("gh-stars");
      el.textContent = d.stargazers_count >= 1000 ? (d.stargazers_count/1000).toFixed(1)+"k" : String(d.stargazers_count);
      el.hidden = false;
    }}).catch(()=>{});
});
