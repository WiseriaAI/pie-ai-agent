<div align="center">
  <img src="../../public/icons/icon-128.svg" alt="Pie" width="96" height="96" />
  <h1>Pie</h1>
  <p><strong>Chrome 瀏覽器自動化 Agent —— 透過原生工具呼叫、Skill 系統、CDP 鍵盤控制，以及沙箱化、抗提示詞注入的執行模型，把自然語言任務變成可控的瀏覽器操作。</strong></p>
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
    <a href="#設定">設定</a> ·
    <a href="../../PRIVACY.md">隱私</a> ·
    <a href="../../CHANGELOG.md">更新紀錄</a> ·
    <a href="../ROADMAP.md">路線圖</a> ·
    <a href="../ARCHITECTURE.md">架構</a> ·
    <a href="https://wiseriaai.github.io/pie-ai-agent/">專案檔案</a>
  </p>
</div>

---

## 為什麼是 Pie

Pie 把 Chrome 變成一個瀏覽器自動化 Agent。用自然語言描述一個任務，LLM
拆解步驟，並透過型別化的工具註冊表執行 —— 包括 DOM 動作、跨分頁編排，
以及面向飛書文件、Google Docs 這類不回應標準 DOM 事件的 canvas 編輯器
的 CDP 鍵盤注入。工作流程可以儲存為帶明確工具白名單的 Skill。工具直接執行、不再有逐動作
確認卡片；頁面內容只在 `<untrusted_*>` 包覆內進入模型、工具按讀／寫
分類並對其他工作階段釘選的分頁加上寫入鎖、每個工作階段獨立沙箱 —— 自動化由此
受到約束。BYOK：把你現有的 API
key 貼進來即可（支援 11 家 LLM 供應商）—— 在本機加密儲存，無 Pie 後端，
無追蹤。

- **原生工具呼叫驅動的瀏覽器自動化。** LLM 透過 Anthropic `tool_use` 區塊或
  OpenAI `function_calling` 操控型別化的工具註冊表 —— DOM 動作（點擊、輸入、
  下拉選擇、捲動、結構化快照）、跨分頁編排（列出／啟用／關閉／分組／
  移動／擷取可讀內容），以及（需手動開啟的）面向 canvas 編輯器（飛書文件、
  Google Docs 等）的 CDP 鍵盤注入（`Input.dispatchKeyEvent`、
  `Input.insertText`）。
- **Skill 是一等公民。** Skill 是帶工具白名單的提示詞範本，對話裡輸入
  `/skill_name` 即可觸發。Agent 也能自己撰寫 Skill —— 但受 8 道能力授權
  不變量約束，無法越權擴張自身權限。
- **設計上即受限。** 工具直接執行，沒有逐動作的確認點擊。約束來自縱深
  防禦：頁面與第三方內容只在 `<untrusted_*>` 包覆內進入模型（防提示詞
  注入）、工具按讀／寫分類並對其他工作階段釘選的分頁加上寫入鎖、每個工作階段獨立
  沙箱（獨立 port、釘選分頁、CDP owner token）。CDP 鍵盤注入預設關閉，
  需手動開啟。
- **多工作階段持久化。** 對話狀態在 Service Worker 重啟後仍可恢復；
  工作階段 30 天後硬刪除，支援手動封存／還原。
- **側邊欄，不是彈出視窗。** Pie 常駐 Chrome 側邊欄，瀏覽過程中保持開啟 ——
  對話、Agent 任務、分頁管理可以同時進行而不遺失上下文。
- **BYOK。** 自帶 API key（支援 11 家 LLM 供應商）。透過 Web Crypto
  AES-GCM 加密後在本機儲存（IndexedDB）。Pie 沒有後端、沒有追蹤、
  不走代理。詳見 [PRIVACY.md](../../PRIVACY.md)。

## 功能

### 頁面理解
對目前頁面提問。Pie 擷取可見文字（憑證欄位會被加固清洗），僅把這部分
內容送給 LLM。Prompt 中所有頁面片段都用 `<untrusted_*>` 標籤包覆，用以
抵禦來自頁面 DOM 的提示詞注入攻擊。

### Agent 自動化與工具呼叫
用自然語言描述一個任務。LLM 拆解步驟，並透過 Pie 的工具註冊表執行 ——
全程使用供應商原生的工具呼叫協定：Claude 用 Anthropic `tool_use`
區塊，其他供應商走 OpenAI `function_calling`。內建工具集涵蓋：

- **DOM 動作** —— 點擊、輸入、下拉選擇、捲動，以及對可互動元素
  （連結、按鈕、輸入框）的結構化快照
- **跨分頁工具** —— 列出、啟用、關閉、分組／解組、移動、擷取另一個
  分頁的可讀內容
- **CDP 鍵盤**（預設關閉，需手動開啟）—— `Input.dispatchKeyEvent` 與
  `Input.insertText`，用於飛書文件、Google Docs 這類不回應標準 DOM 事件
  的 canvas 編輯器
- **Skill 元工具** —— Agent 可以自行 create / update / delete / list
  自己的 Skill（詳見下方 *Skill 系統*）

內建三個跨分頁 Skill：`auto_group_tabs`、`close_duplicate_tabs`、
`close_inactive_tabs`。

### Skill 系統
Skill 是帶明確工具白名單的提示詞範本。開啟 **設定 → Skills** 建立、
編輯、刪除你自己的 Skill —— 包括名稱、提示範本、參數 JSON Schema，以及
該 Skill 可呼叫的精確工具集合。在對話框內輸入 `/skill_name` 即可執行
任意 Skill。

Agent 自己也能透過 `create_skill` / `update_skill` / `delete_skill` 元工具
建立 Skill —— 適合把模型剛剛走通的工作流程捕捉下來，下一次工作階段直接重複使用。
Agent 建立的 Skill 會被標上 `author='agent'` 記號，並同樣受下文的能力
授權不變量約束 —— 它只能呼叫被授予的工具，無法自行擴張權限。

Skill 無法越過自己宣告的工具白名單。每次 Skill 寫入都會強制執行
8 道能力授權不變量 —— 硬上限（提示範本 ≤ 8 KB、參數 schema ≤ 2 KB）、
禁止巢狀元工具、單裝置 1 MB 儲存預算、對即時工具註冊表做名稱校驗 ——
失控的 Skill 無法自行擴張權限。

### 安全模型
Pie 直接執行工具 —— 主路徑上沒有逐動作的確認卡片。安全是分層的：

- **提示詞注入隔離。** 頁面內容、分頁中繼資料、Skill 參數只在
  `<untrusted_*>` 包覆內進入模型，且永不進入 system prompt —— 頁面 DOM
  裡的文字因此無法被當作可信任指令執行。
- **讀／寫工具分類。** 每個工具在建置期被宣告為讀或寫。寫類工具被禁止
  操作其他工作階段已釘選的分頁（跨工作階段寫入鎖），並行工作階段之間不會互相破壞。
- **依工作階段沙箱。** 每個工作階段有獨立的串流 port、獨立的釘選分頁集合，以及
  CDP owner token —— 一個任務無法劫持另一個任務的分頁或偵錯工作階段。
- **CDP 鍵盤注入預設關閉** —— 必須先在設定裡開啟才能附加。
- **Skill 無法自我提權** —— 由上文的能力授權不變量強制保證。

你仍會看到的唯一一次核准發生在**恢復任務**時：如果你暫停了任務、而其
釘選分頁已被關閉或導向到了不同 origin，Pie 會先彈出 drift 卡片再繼續，
避免在錯誤的頁面上動作。

### 支援的供應商

| 供應商 | 說明 |
|---|---|
| Anthropic Claude | 原生 API + 原生 `tool_use` |
| OpenAI | OpenAI `function_calling` |
| Gemini | 原生 API |
| OpenRouter | OpenAI 相容 |
| DeepSeek | Anthropic 相容 |
| MiniMax | Anthropic 相容 |
| GLM(智譜) | OpenAI 相容 |
| Bailian | OpenAI 相容 |
| Mimo(小米) | Anthropic 相容 |
| Moonshot(Kimi) | OpenAI 相容 · 國際區 `api.moonshot.ai` / 中國區 `api.moonshot.cn`（新建執行個體時選對應條目即選區） |
| StepFun | Anthropic 相容 |

新增一家供應商只需要一條 registry 條目加一條 host permission。本機
Ollama 見 [路線圖](../ROADMAP.md)。

## 安裝

Pie 提供兩種面向終端使用者的安裝管道，外加一種原始碼建置管道，按需挑選。

需要支援 side panel 的 Chromium 瀏覽器 —— Chrome 114+、Edge、Brave、
Arc 等均可。

### 方式一 —— Chrome Web Store（推薦）

從 **[Chrome Web Store](https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed)** 安裝 —— 點擊 **Add to Chrome**，隨後將 Pie 釘選到工具列。Chrome 會自動保持更新。

### 方式二 —— GitHub Release zip（解壓縮安裝）

適用於不想走 Web Store、但要裝同一份產物的使用者（如離線、自管或受政策限制的環境）：

1. 從 [Releases 頁面](https://github.com/WiseriaAI/pie-ai-agent/releases)
   下載最新的 `pie-x.y.z.zip`
2. 解壓縮到一個會長期保留的目錄（Chrome 執行時會從這個目錄載入，安裝後
   不要刪除）
3. 開啟 `chrome://extensions`
4. 開啟右上角 **開發人員模式**
5. 點 **載入未封裝項目**，選擇剛才解壓縮出來的目錄
6. 把 Pie 釘選到工具列；點擊圖示即可開啟側邊欄

#### 升級而不遺失歷史資料

Chrome 透過 unpacked 目錄的絕對路徑計算擴充功能 ID，而工作階段／加密的 API key /
Skill 都綁定在這個擴充功能 origin 下（IndexedDB + 本機儲存）。要在版本之間保留這些
資料，**必須就地升級** —— 不要把新版 zip 解壓縮到另一個資料夾。

1. 開啟 `chrome://extensions`，找到 Pie 卡片，記下它的 unpacked 目錄
   路徑（卡片下方或 **詳細資訊 → Source** 裡能看到）
2. 刪除該目錄裡的所有檔案，但保留目錄本身
3. 把新版 `pie-x.y.z.zip` 解壓縮到這個相同目錄
4. 點 Pie 卡片上的 **↻ 重新載入** 圖示

> ⚠️ 不要點 **移除**。移除會清除擴充功能的全部本機儲存（IndexedDB + chrome.storage），
> 包括加密的 API key 和聊天紀錄。如果已經移除了，需要從 Settings 重新
> 填入 API key；聊天紀錄無法復原。

走 Web Store（方式一）的使用者不用管這一節 —— Chrome 自動更新，
資料自動跟著走。

### 方式三 —— 從原始碼建置（貢獻者）

如果你想要 HMR、要發 PR，或者就是不信任預先編譯的產物：

```bash
git clone https://github.com/WiseriaAI/pie-ai-agent.git
cd Pie
pnpm install
pnpm build
```

把產生的 `dist/` 目錄作為未封裝擴充功能載入（步驟 3–6 同上）。日常開發循環
見下方 [開發](#開發)。

## 設定

1. 開啟側邊欄，切換到 **Settings** 分頁
2. 新增一條 provider —— 貼上 API key，選好模型
3. 切回 **Chat**，傳送一則訊息

你的 key 在本機儲存（IndexedDB）之前會先被加密。加密所用的金鑰在
首次啟動時於本機產生，永遠不會離開你的裝置。

## 隱私與安全

- BYOK：API key 永遠不離開你的裝置，僅作為 `Authorization` 標頭隨直連
  供應商的 API 請求一起傳送
- 所有送給 LLM 的頁面內容都包覆在 `<untrusted_*>` 標籤裡，硬擋來自頁面
  DOM 的提示詞注入
- 工具不再有逐動作的確認彈出視窗；約束來自讀／寫工具分類與跨工作階段寫入鎖，以及
  依工作階段的沙箱隔離（獨立 port、釘選分頁、CDP owner token）
- 無追蹤、無統計、無第三方

完整政策：[PRIVACY.md](../../PRIVACY.md)。

## 開發

```bash
pnpm install
pnpm dev          # Vite 開發伺服器，帶 HMR
pnpm test         # Vitest，單次執行
pnpm test:watch   # Vitest，監看模式
pnpm build        # 正式建置至 dist/
```

開發時把 `dist/` 當作未封裝擴充功能載入（首次 `pnpm dev` 之後），每次改完
service worker 後到 `chrome://extensions` 點 **重新載入**。

### 技術堆疊

- Chrome Extension Manifest V3
- React 19 + TypeScript 6
- TailwindCSS 4（Vite 外掛，無設定檔）
- Vite 8 + `@crxjs/vite-plugin` 2.4
- pnpm

### 專案結構

| 路徑 | 用途 |
|---|---|
| `src/background/` | Service Worker —— 訊息路由、Agent loop 派發、保持運作 |
| `src/sidepanel/` | React 側邊欄 UI（Chat、Settings、工作階段抽屜） |
| `src/lib/model-router/` | 統一 LLM 介面；依供應商封裝串流 + 工具呼叫 |
| `src/lib/agent/` | ReAct 迴圈、工具註冊表、讀／寫工具分類、untrusted 內容包覆、提示詞建構 |
| `src/lib/dom-actions/` | 透過 `executeScript` 注入的自包含 DOM 動作函式 |
| `src/lib/skills/` | Skill 框架：型別、儲存、內建 Skill |
| `src/lib/sessions/` | 工作階段生命週期：持久化、封存、多工作階段沙箱 |

架構說明與不變量追蹤文件放在 `docs/solutions/`。專案的 compound-engineering
說明與貢獻者指南見 [`CLAUDE.md`](../../CLAUDE.md)。

## 路線圖

延期里程碑列表見 [`docs/ROADMAP.md`](../ROADMAP.md)。重點：

- 透過 Ollama 接入本機模型
- 快捷鍵
- 依頁面 URL 比對自動觸發 Skill
- 操作錄製 → 自動產生 Skill

## 版本與發布

Pie 遵循 [Semantic Versioning](https://semver.org)。發布說明見
[CHANGELOG.md](../../CHANGELOG.md)。

## 授權

採用 [Apache License, Version 2.0](../../LICENSE) 開源 —— © 2026 Pie Project Contributors.
