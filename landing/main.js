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
    "s1.tag":"· PAGE & PDF Q&A", "s1.cmd":"“What’s the refund policy on this page?”",
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
