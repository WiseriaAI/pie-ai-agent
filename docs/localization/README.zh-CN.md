<div align="center">
  <img src="../../public/icons/icon-128.svg" alt="Pie" width="96" height="96" />
  <h1>Pie</h1>
  <p><strong>常驻 Chrome 侧边栏的开源 AI Agent。用大白话告诉它你想做什么 —— 它会帮你读网页、点击、输入，跨标签页把事情办好。</strong></p>
  <p>
    <a href="https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed"><img src="https://img.shields.io/chrome-web-store/v/gpccjhdgjkmalnepmeclooflliiocfed?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white" alt="Chrome Web Store 上架" /></a>
  </p>
  <p>
    <a href="../../README.md">English</a> ·
    <strong>简体中文</strong> ·
    <a href="README.zh-TW.md">繁體中文</a> ·
    <a href="README.es-419.md">Español (Latinoamérica)</a> ·
    <a href="README.ja.md">日本語</a> ·
    <a href="README.pt-BR.md">Português (Brasil)</a>
  </p>
  <p>
    <a href="#安装">安装</a> ·
    <a href="#接入模型">接入模型</a> ·
    <a href="../../PRIVACY.md">隐私</a> ·
    <a href="https://github.com/WiseriaAI/pie-ai-agent/releases">更新日志</a> ·
    <a href="../ROADMAP.md">路线图</a> ·
    <a href="../ARCHITECTURE.md">架构</a> ·
    <a href="https://wiseriaai.github.io/pie-ai-agent/">项目档案</a>
  </p>
</div>

---

## Pie 是什么

Pie 是一个会**动手用**浏览器、而不只是陪你聊天的 AI 助手。它开在 Chrome
侧边栏里，你工作时一直在那儿。用日常语言描述一个任务，Pie 会自己想清楚步骤、
在你眼前的页面上执行 —— 读取、点击、输入、切换标签页 —— 这些活儿不用你再
一步步点了。

它免费、开源。你可以自带 11 家供应商之一的模型 key，也可以订阅 Pie、省去一切配置。

## 你能用它做什么

- **对当前页面提问。** 总结一篇长文、提炼要点、回答关于它的问题 ——
  **PDF 也行**，不只是普通网页。
- **把多步任务交给它。**「比较这三款产品，告诉我哪个最划算」「照我的笔记把这张表填了」——
  Pie 会拆解步骤，替你点击、输入、滚动。
- **跨所有标签页干活。** 一次性从多个打开的标签页汇总信息，并帮你收拾整齐 ——
  把相关标签页分组、关掉重复的、清掉看完不用的。
- **联网搜索。** 当前页面不够用时，Pie 会上网查最新信息。
- **在真正的编辑器里写东西。** 那些通常拒绝自动化的富文本编辑器，Pie 也能输入 ——
  飞书文档、Google Docs、代码编辑器，而不只是普通输入框。
- **把页面变成文件。** 从页面里抽取结构化数据，导出成一个可下载的文件。
- **保存并复用你的工作流（Skill）。** 把常做的任务变成一条可复用的 `/命令`，
  或者你只演示一遍、让 Pie 替你把 Skill 做出来。
- **定时跑任务。** 让 Pie 自动执行某个任务 —— 每天、每周、或每隔几小时 ——
  哪怕你不在、它也能在后台跑。

## 接入模型

Pie 需要一个 AI 模型来思考。挑你顺手的那种就行 —— 随时可切换，也可以同时配好几个。

- **自带 key（BYOK）。** 粘贴下方任一供应商的 API key 即可。免费使用、完全私密：
  你的 key 在本地加密保存，只发给你选的那家供应商 —— 绝不发往任何 Pie 服务器。
- **Pie 官方订阅（可选）。** 不想折腾 key？用 Google 登录并订阅 ——
  开箱即用。（这是唯一一条请求会经过 Pie 自家服务的路径。）

支持自带 key 的供应商：**Anthropic Claude · OpenAI · Google Gemini ·
OpenRouter · DeepSeek · MiniMax · GLM（智谱）· Bailian · Mimo（小米）·
Moonshot（Kimi —— 国际区与中国区）· StepFun**。通过 Ollama 接入本地模型
见[路线图](../ROADMAP.md)。

## 隐私

- **你的数据是你的。** 用 BYOK 时，你的 API key 在本地加密、只发给你选的那家
  供应商 —— Pie 没有后端介入，也不收集任何埋点或统计。
- **唯一的例外是订阅。** 如果你用 Pie 官方订阅，聊天请求会经过 Pie 的服务
  （这是计费的必要环节）—— 但 Pie 仍然不收集任何产品埋点。
- **Pie 只在执行你交代的任务时才读取页面，** 并把页面上的一切都当作不可信内容，
  这样恶意页面也无法骗它去做你没要求的事。

完整策略见 [PRIVACY.md](../../PRIVACY.md)。

## 安装

支持任何带侧边栏的 Chromium 浏览器 —— Chrome 114+、Edge、Brave、Arc 等均可。

### 方式一 —— Chrome Web Store（推荐）

从 **[Chrome Web Store](https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed)** 安装，点 **Add to Chrome**，把 Pie 钉到工具栏。Chrome 会自动保持更新。

### 方式二 —— GitHub Release zip

适合离线或自管环境，装的是同一份产物：

1. 从 [Releases 页面](https://github.com/WiseriaAI/pie-ai-agent/releases) 下载最新的 `pie-x.y.z.zip`
2. 解压到一个会长期保留的文件夹（Chrome 从这个文件夹加载 —— 别删）
3. 打开 `chrome://extensions`，开启 **开发者模式**
4. 点 **加载已解压的扩展程序**，选中该文件夹
5. 把 Pie 钉到工具栏，点击图标打开侧边栏

> **升级：** 要保留聊天记录和已存的 key，把新版解压**到同一个文件夹**，
> 再点 Pie 卡片上的 **↻ 重新加载**。别点 **移除** —— 那会清掉设备上存的一切，
> 包括加密的 key 和聊天记录。

### 方式三 —— 从源码构建

```bash
git clone https://github.com/WiseriaAI/pie-ai-agent.git
cd Pie
pnpm install
pnpm build
```

然后把生成的 `dist/` 文件夹作为已解压扩展加载（步骤 3–5 同上）。

## 配置

1. 打开侧边栏，进入 **Settings**
2. 添加一个模型 —— 粘贴你的 API key（BYOK），或登录使用官方订阅
3. 切到 **Chat**，发出第一条消息

## 构建与参与贡献

```bash
pnpm install
pnpm dev          # 带热重载的开发服务器
pnpm test         # 跑测试
pnpm build        # 生产构建至 dist/
```

Pie 是基于 React 19、TypeScript、Vite 的 Manifest V3 扩展。架构说明与贡献者指南见
[`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) 和 [`CLAUDE.md`](../../CLAUDE.md)。

## 路线图

见 [`docs/ROADMAP.md`](../ROADMAP.md)。要点：

- 通过 Ollama 接入本地模型
- 快捷键
- 按页面 URL 匹配自动触发 Skill

## 许可证

[Apache License, Version 2.0](../../LICENSE) —— © 2026 Pie Project Contributors.
