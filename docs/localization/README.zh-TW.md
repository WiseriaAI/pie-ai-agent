<div align="center">
  <img src="../../public/icons/icon-128.svg" alt="Pie" width="96" height="96" />
  <h1>Pie</h1>
  <p><strong>常駐 Chrome 側邊欄的開源 AI Agent。用大白話告訴它你想做什麼 —— 它會幫你讀網頁、點擊、輸入，跨分頁把事情辦好。</strong></p>
  <p>
    <a href="https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed"><img src="https://img.shields.io/chrome-web-store/v/gpccjhdgjkmalnepmeclooflliiocfed?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white" alt="Chrome Web Store 上架" /></a>
  </p>
  <p>
    <a href="../../README.md">English</a> ·
    <a href="README.zh-CN.md">简体中文</a> ·
    <strong>繁體中文</strong> ·
    <a href="README.es-419.md">Español (Latinoamérica)</a> ·
    <a href="README.ja.md">日本語</a> ·
    <a href="README.pt-BR.md">Português (Brasil)</a>
  </p>
  <p>
    <a href="#安裝">安裝</a> ·
    <a href="#接入模型">接入模型</a> ·
    <a href="../../PRIVACY.md">隱私</a> ·
    <a href="../../CHANGELOG.md">更新日誌</a> ·
    <a href="../ROADMAP.md">路線圖</a> ·
    <a href="../ARCHITECTURE.md">架構</a> ·
    <a href="https://wiseriaai.github.io/pie-ai-agent/">專案檔案</a>
  </p>
</div>

---

## Pie 是什麼

Pie 是一個會**動手用**瀏覽器、而不只是陪你聊天的 AI 助理。它開在 Chrome
側邊欄裡，你工作時一直在那兒。用日常語言描述一個任務，Pie 會自己想清楚步驟、
在你眼前的頁面上執行 —— 讀取、點擊、輸入、切換分頁 —— 這些活兒不用你再
一步步點了。

它免費、開源。你可以自帶 11 家供應商之一的模型 key，也可以訂閱 Pie、省去一切設定。

## 你能用它做什麼

- **對目前頁面提問。** 摘要一篇長文、提煉重點、回答關於它的問題 ——
  **PDF 也行**，不只是一般網頁。
- **把多步任務交給它。**「比較這三款產品，告訴我哪個最划算」「照我的筆記把這張表填了」——
  Pie 會拆解步驟，替你點擊、輸入、捲動。
- **跨所有分頁做事。** 一次從多個開啟的分頁彙整資訊，並幫你收拾整齊 ——
  把相關分頁分組、關掉重複的、清掉看完不用的。
- **連網搜尋。** 目前頁面不夠用時，Pie 會上網查最新資訊。
- **在真正的編輯器裡寫東西。** 那些通常拒絕自動化的富文字編輯器，Pie 也能輸入 ——
  飛書文件、Google Docs、程式碼編輯器，而不只是一般輸入框。
- **把頁面變成檔案。** 從頁面裡抽取結構化資料，匯出成一個可下載的檔案。
- **儲存並重複使用你的工作流程（Skill）。** 把常做的任務變成一條可重複使用的 `/指令`，
  或者你只示範一遍、讓 Pie 替你把 Skill 做出來。
- **定時跑任務。** 讓 Pie 自動執行某個任務 —— 每天、每週、或每隔幾小時 ——
  即使你不在、它也能在背景跑。

## 接入模型

Pie 需要一個 AI 模型來思考。挑你順手的那種就行 —— 隨時可切換，也可以同時設定好幾個。

- **自帶 key（BYOK）。** 貼上下方任一供應商的 API key 即可。免費使用、完全私密：
  你的 key 在本機加密保存，只發給你選的那家供應商 —— 絕不發往任何 Pie 伺服器。
- **Pie 官方訂閱（可選）。** 不想折騰 key？用 Google 登入並訂閱 ——
  開箱即用。（這是唯一一條請求會經過 Pie 自家服務的路徑。）

支援自帶 key 的供應商：**Anthropic Claude · OpenAI · Google Gemini ·
OpenRouter · DeepSeek · MiniMax · GLM（智譜）· Bailian · Mimo（小米）·
Moonshot（Kimi —— 國際區與中國區）· StepFun**。透過 Ollama 接入本機模型
見[路線圖](../ROADMAP.md)。

## 隱私

- **你的資料是你的。** 用 BYOK 時，你的 API key 在本機加密、只發給你選的那家
  供應商 —— Pie 沒有後端介入，也不收集任何埋點或統計。
- **唯一的例外是訂閱。** 如果你用 Pie 官方訂閱，聊天請求會經過 Pie 的服務
  （這是計費的必要環節）—— 但 Pie 仍然不收集任何產品埋點。
- **Pie 只在執行你交代的任務時才讀取頁面，** 並把頁面上的一切都當作不可信內容，
  這樣惡意頁面也無法騙它去做你沒要求的事。

完整政策見 [PRIVACY.md](../../PRIVACY.md)。

## 安裝

支援任何帶側邊欄的 Chromium 瀏覽器 —— Chrome 114+、Edge、Brave、Arc 等皆可。

### 方式一 —— Chrome Web Store（推薦）

從 **[Chrome Web Store](https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed)** 安裝，點 **Add to Chrome**，把 Pie 釘到工具列。Chrome 會自動保持更新。

### 方式二 —— GitHub Release zip

適合離線或自管環境，裝的是同一份產物：

1. 從 [Releases 頁面](https://github.com/WiseriaAI/pie-ai-agent/releases) 下載最新的 `pie-x.y.z.zip`
2. 解壓到一個會長期保留的資料夾（Chrome 從這個資料夾載入 —— 別刪）
3. 開啟 `chrome://extensions`，啟用 **開發人員模式**
4. 點 **載入未封裝項目**，選擇該資料夾
5. 把 Pie 釘到工具列，點擊圖示開啟側邊欄

> **升級：** 要保留聊天記錄和已存的 key，把新版解壓**到同一個資料夾**，
> 再點 Pie 卡片上的 **↻ 重新載入**。別點 **移除** —— 那會清掉裝置上存的一切，
> 包括加密的 key 和聊天記錄。

### 方式三 —— 從原始碼建置

```bash
git clone https://github.com/WiseriaAI/pie-ai-agent.git
cd Pie
pnpm install
pnpm build
```

然後把產生的 `dist/` 資料夾作為未封裝擴充功能載入（步驟 3–5 同上）。

## 設定

1. 開啟側邊欄，進入 **Settings**
2. 新增一個模型 —— 貼上你的 API key（BYOK），或登入使用官方訂閱
3. 切到 **Chat**，發出第一則訊息

## 建置與參與貢獻

```bash
pnpm install
pnpm dev          # 帶熱重載的開發伺服器
pnpm test         # 跑測試
pnpm build        # 生產建置至 dist/
```

Pie 是基於 React 19、TypeScript、Vite 的 Manifest V3 擴充功能。架構說明與貢獻者指南見
[`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) 和 [`CLAUDE.md`](../../CLAUDE.md)。

## 路線圖

見 [`docs/ROADMAP.md`](../ROADMAP.md)。重點：

- 透過 Ollama 接入本機模型
- 快捷鍵
- 按頁面 URL 比對自動觸發 Skill

## 授權條款

[Apache License, Version 2.0](../../LICENSE) —— © 2026 Pie Project Contributors.
