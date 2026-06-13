<div align="center">
  <img src="public/icons/icon-128.svg" alt="Pie" width="96" height="96" />
  <h1>Pie</h1>
  <p><strong>Chrome 用のブラウザ自動化エージェント。自然言語のタスクを、ネイティブなツール呼び出しと local-first な設計で実行します。</strong></p>
  <p>
    <a href="https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed"><img src="https://img.shields.io/chrome-web-store/v/gpccjhdgjkmalnepmeclooflliiocfed?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white" alt="Chrome Web Store で入手" /></a>
  </p>
  <p>
    <a href="README.md">English</a> ·
    <a href="README.zh-CN.md">简体中文</a> ·
    <a href="README.es-419.md">Español (Latinoamérica)</a> ·
    <strong>日本語</strong> ·
    <a href="README.pt-BR.md">Português (Brasil)</a>
  </p>
  <p>
    <a href="#インストール">インストール</a> ·
    <a href="#初期設定">設定</a> ·
    <a href="PRIVACY.md">プライバシー</a> ·
    <a href="CHANGELOG.md">Changelog</a> ·
    <a href="docs/ROADMAP.md">Roadmap</a> ·
    <a href="docs/ARCHITECTURE.md">Architecture</a> ·
    <a href="https://wiseriaai.github.io/pie-ai-agent/">Archive</a>
  </p>
</div>

---

## Pie とは

Pie は Chrome 用のオープンな AI エージェントです。サイドパネルで動作し、現在のページを読み取ってブラウザ上のタスクを自動化できます。

自然言語でタスクを入力すると、Pie はページの読み取り、クリック、入力、タブ整理、情報の構造化などをブラウザツールで実行します。

## インストール

### 方法 1 — Chrome Web Store

**[Chrome Web Store](https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed)** から Pie をインストールし、**Add to Chrome** をクリックしてからツールバーに固定します。

### 方法 2 — GitHub Release zip

1. [Releases ページ](https://github.com/WiseriaAI/pie-ai-agent/releases)から最新の `pie-x.y.z.zip` をダウンロードします。
2. 継続して保存するフォルダに展開します。
3. `chrome://extensions` を開きます。
4. **Developer mode** を有効にします。
5. **Load unpacked** をクリックし、展開したフォルダを選択します。
6. Pie をツールバーに固定し、サイドパネルを開きます。

### 方法 3 — ソースからビルド

```bash
git clone https://github.com/WiseriaAI/pie-ai-agent.git
cd Pie
pnpm install
pnpm build
```

生成された `dist/` フォルダを unpacked extension として読み込みます。

## 初期設定

1. Pie のサイドパネルを開きます。
2. **Settings** を開きます。
3. プロバイダーを追加し、APIキーを貼り付け、モデルを選択します。
4. **Chat** に戻ります。

APIキーはローカルに保存される前に暗号化されます。

## 最初のタスクを実行

ページを開き、「このページを3点で要約して」のように入力すると、Pie が現在のページで作業します。

## プライバシーモデル

モデルプロバイダーのAPIキーはユーザー自身が設定します。Pie はバックエンドを運用せず、リクエストをプロキシせず、プロダクト分析用のテレメトリーを収集しません。

APIキーはローカルで暗号化され、選択したプロバイダーにのみ送信されます。詳細は [PRIVACY.md](PRIVACY.md) を確認してください。

## フィードバック

不具合や提案は [GitHub Issues](https://github.com/WiseriaAI/pie-ai-agent/issues) に投稿してください。
