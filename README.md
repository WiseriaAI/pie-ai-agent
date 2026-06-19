<div align="center">
  <img src="public/icons/icon-128.svg" alt="Pie" width="96" height="96" />
  <h1>Pie</h1>
  <p><strong>An open-source AI agent that lives in your Chrome sidebar. Tell it what you want in plain language — it reads pages, clicks, types, and gets things done across your tabs.</strong></p>
  <p>
    <a href="https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed"><img src="https://img.shields.io/chrome-web-store/v/gpccjhdgjkmalnepmeclooflliiocfed?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white" alt="Available in the Chrome Web Store" /></a>
  </p>
  <p>
    <strong>English</strong> ·
    <a href="docs/localization/README.zh-CN.md">简体中文</a> ·
    <a href="docs/localization/README.zh-TW.md">繁體中文</a> ·
    <a href="docs/localization/README.es-419.md">Español (Latinoamérica)</a> ·
    <a href="docs/localization/README.ja.md">日本語</a> ·
    <a href="docs/localization/README.pt-BR.md">Português (Brasil)</a>
  </p>
  <p>
    <a href="#install">Install</a> ·
    <a href="#connect-a-model">Connect a model</a> ·
    <a href="PRIVACY.md">Privacy</a> ·
    <a href="https://github.com/WiseriaAI/pie-ai-agent/releases">Changelog</a> ·
    <a href="docs/ROADMAP.md">Roadmap</a> ·
    <a href="docs/ARCHITECTURE.md">Architecture</a> ·
    <a href="https://wiseriaai.github.io/pie-ai-agent/">Archive</a>
  </p>
</div>

---

## What is Pie

Pie is an AI assistant that *uses* your browser, not just chats in it. It
opens in Chrome's side panel and stays there while you work. Describe a task
in everyday language and Pie figures out the steps and carries them out on the
page in front of you — reading, clicking, typing, switching tabs — so you don't
have to click through it yourself.

It's free and open source. Bring your own model key from any of 11 providers,
or subscribe to Pie and skip the setup.

## What you can do

- **Ask about the page you're on.** Summarize a long article, pull out the key
  points, answer questions about it — **including PDFs**, not just regular web
  pages.
- **Hand off multi-step tasks.** "Compare these three products and tell me
  which is the best value." "Fill in this form from my notes." Pie plans the
  steps and does the clicking, typing, and scrolling for you.
- **Work across all your tabs.** Gather information from several open tabs at
  once, and keep them tidy — group related tabs, close duplicates, clear out
  the ones you're done with.
- **Search the web.** When the current page isn't enough, Pie looks things up
  to get current information.
- **Write inside real editors.** Pie can type into rich editors that normally
  ignore automation — Google Docs, Lark Docs, and code editors — not just plain
  text boxes.
- **Turn pages into files.** Extract structured data from a page and export it
  as a file you can download.
- **Save and replay your workflows (Skills).** Turn a task you do often into a
  reusable `/command`, or just record yourself doing it once and let Pie build
  the Skill for you.
- **Run tasks on a schedule.** Have Pie run a task automatically — daily,
  weekly, or every few hours — even in the background while you're away.

## Connect a model

Pie needs an AI model to think. Pick whichever suits you — you can switch any
time, or keep several side by side.

- **Bring your own key (BYOK).** Paste an API key from any provider below.
  It's free to use and fully private: your key is encrypted on your device and
  sent only to that provider — never to a Pie server.
- **Pie official subscription (optional).** Don't want to manage keys? Sign in
  with Google and subscribe — everything works out of the box. (This is the one
  path where your requests go through Pie's own service.)

Supported BYOK providers: **Anthropic Claude · OpenAI · Google Gemini ·
OpenRouter · DeepSeek · MiniMax · GLM (Zhipu) · Bailian · Mimo (Xiaomi) ·
Moonshot (Kimi — international & China) · StepFun**. Local models via Ollama are
on the [roadmap](docs/ROADMAP.md).

## Privacy

- **Your data stays yours.** With BYOK, your API key is encrypted on your
  device and only ever sent to the provider you chose — Pie runs no server in
  the loop and collects no telemetry or analytics.
- **The subscription is the one exception.** If you use the official Pie
  subscription, your chat requests pass through Pie's service (that's how
  billing works) — but Pie still collects no product telemetry.
- **Pie only looks at a page while it's working on your task,** and treats
  everything on a page as untrusted, so a malicious page can't trick it into
  doing something you never asked for.

Full policy: [PRIVACY.md](PRIVACY.md).

## Install

Works in any Chromium browser with side-panel support — Chrome 114+, Edge,
Brave, Arc, and others.

### Option 1 — Chrome Web Store (recommended)

Install from the **[Chrome Web Store](https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed)**, click **Add to Chrome**, and pin Pie to the toolbar. Chrome keeps it updated automatically.

### Option 2 — GitHub Release zip

For an offline or self-managed install of the same build:

1. Download the latest `pie-x.y.z.zip` from the [Releases page](https://github.com/WiseriaAI/pie-ai-agent/releases)
2. Unzip it to a folder you'll keep (Chrome loads from this folder — don't delete it)
3. Open `chrome://extensions`, turn on **Developer mode**
4. Click **Load unpacked** and select the folder
5. Pin Pie to the toolbar and click the icon to open the side panel

> **Upgrading:** to keep your chats and saved keys, unzip the new release
> *into the same folder* and click **↻ reload** on Pie's card. Don't click
> **Remove** — that erases everything stored on your device, including your
> encrypted keys and chat history.

### Option 3 — Build from source

```bash
git clone https://github.com/WiseriaAI/pie-ai-agent.git
cd Pie
pnpm install
pnpm build
```

Then load the generated `dist/` folder as an unpacked extension (steps 3–5 above).

## Configure

1. Open the side panel and go to **Settings**
2. Add a model — paste your API key (BYOK) or sign in for the official subscription
3. Switch to **Chat** and send your first message

## Build & contribute

```bash
pnpm install
pnpm dev          # dev server with hot reload
pnpm test         # run tests
pnpm build        # production build to dist/
```

Pie is a Manifest V3 extension built with React 19, TypeScript, and Vite.
Architecture notes and contributor guidance live in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`CLAUDE.md`](CLAUDE.md).

## Roadmap

See [`docs/ROADMAP.md`](docs/ROADMAP.md). Highlights:

- Local models via Ollama
- Keyboard shortcuts
- Skills that auto-trigger on matching page URLs

## License

[Apache License, Version 2.0](LICENSE) — © 2026 Pie Project Contributors.
