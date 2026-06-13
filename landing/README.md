# Pie Landing Page

纯静态站（无构建步骤）。本地预览：

```bash
cd landing && python3 -m http.server 8000
# open http://localhost:8000
```

## Localized Routes

Preview localized pages with the same static server:

- `/` English
- `/es-419/` Latin American Spanish
- `/ja/` Japanese
- `/pt-BR/` Brazilian Portuguese

The root path stays English and does not auto-redirect.

Localized route directories contain static `index.html` entry files that mirror the root page.
Keep them in sync with `landing/index.html`; `main.js` applies the locale from the path.

## 结构
- `index.html` — 页面骨架，所有可见文案用 `data-i18n="<key>"` 标记
- `styles.css` — 设计 token（复用扩展 `src/sidepanel/index.css`）、各 section 样式、点阵/聚光、响应式
- `main.js` — i18n 字典（中英）+ 语言切换 + 链接映射 + 悬浮聚光 + 可选 GitHub star 数
- `assets/fonts/` — 自托管 Inter / JetBrains Mono woff2
- `assets/pie-mark.svg` / `favicon.svg` — 品牌标记

## Deploy (Vercel)
- 新建 Vercel 项目，连本仓库
- **Root Directory = `landing`**，Framework Preset = **Other**（无 build command）
- `vercel.json` 已配 cleanUrls + 安全头
- 部署后把 `index.html` 的 `og:image` 换成真实分享图、`canonical` 换成真实域名
