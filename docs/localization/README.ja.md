<div align="center">
  <img src="../../public/icons/icon-128.svg" alt="Pie" width="96" height="96" />
  <h1>Pie</h1>
  <p><strong>Chrome のサイドパネルに常駐するオープンソースの AI エージェント。やりたいことを普段の言葉で伝えるだけ —— ページを読み、クリックし、入力し、タブをまたいで作業をこなします。</strong></p>
  <p>
    <a href="https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed"><img src="https://img.shields.io/chrome-web-store/v/gpccjhdgjkmalnepmeclooflliiocfed?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white" alt="Chrome ウェブストアで入手可能" /></a>
  </p>
  <p>
    <a href="../../README.md">English</a> ·
    <a href="README.zh-CN.md">简体中文</a> ·
    <a href="README.zh-TW.md">繁體中文</a> ·
    <a href="README.es-419.md">Español (Latinoamérica)</a> ·
    <strong>日本語</strong> ·
    <a href="README.pt-BR.md">Português (Brasil)</a>
  </p>
  <p>
    <a href="#インストール">インストール</a> ·
    <a href="#モデルを接続する">モデルを接続</a> ·
    <a href="../../PRIVACY.md">プライバシー</a> ·
    <a href="https://github.com/WiseriaAI/pie-ai-agent/releases">変更履歴</a> ·
    <a href="../ROADMAP.md">ロードマップ</a> ·
    <a href="../ARCHITECTURE.md">アーキテクチャ</a> ·
    <a href="https://wiseriaai.github.io/pie-ai-agent/">アーカイブ</a>
  </p>
</div>

---

## Pie とは

Pie は、ブラウザの中で**実際に操作してくれる** AI アシスタントです。ただ会話する
だけではありません。Chrome のサイドパネルに開き、作業中はずっとそこにいます。
やりたいことを普段の言葉で伝えれば、Pie が手順を考え、目の前のページで実行します
—— 読む、クリックする、入力する、タブを切り替える。あなたが一つずつ操作する
必要はありません。

無料でオープンソースです。11 のプロバイダーから好きなモデルの key を持ち込むか、
Pie を購読してセットアップを丸ごと省くこともできます。

## できること

- **開いているページについて質問する。** 長い記事を要約したり、要点を抜き出したり、
  内容について答えてもらえます —— **PDF も対応**、通常のウェブページだけではありません。
- **複数ステップの作業を任せる。**「この 3 つの製品を比較して、一番お得なものを教えて」
  「このメモを元にフォームを埋めて」—— Pie が手順を組み立て、クリック・入力・
  スクロールを代わりに行います。
- **すべてのタブをまたいで作業する。** 複数の開いたタブから一度に情報を集め、
  さらに整理もします —— 関連するタブをグループ化し、重複を閉じ、見終わったものを片付けます。
- **ウェブを検索する。** 今のページだけでは足りないとき、Pie が最新の情報を調べます。
- **本物のエディタの中に書き込む。** 通常は自動化を受け付けないリッチエディタにも
  入力できます —— Google Docs、Lark Docs、コードエディタなど、ただの入力欄だけでは
  ありません。
- **ページをファイルに変える。** ページから構造化データを抽出し、ダウンロードできる
  ファイルとして書き出します。
- **作業フロー（Skill）を保存して再利用する。** よくやる作業を再利用できる `/コマンド`
  にしたり、一度やって見せるだけで Pie に Skill を作ってもらえます。
- **作業をスケジュール実行する。** Pie に作業を自動で実行させられます —— 毎日・毎週・
  数時間ごと —— あなたが離れている間もバックグラウンドで動きます。

## モデルを接続する

Pie が考えるには AI モデルが必要です。好きなものを選んでください —— いつでも切り替え
られますし、複数を並べて使うこともできます。

- **自分の key を使う（BYOK）。** 下記いずれかのプロバイダーの API key を貼り付ける
  だけ。無料で使え、完全にプライベートです。key は端末上で暗号化され、選んだプロバイダー
  にのみ送られます —— Pie のサーバーには一切送られません。
- **Pie 公式サブスクリプション（任意）。** key の管理をしたくない方は、Google で
  ログインして購読すれば、すぐに使えます。（リクエストが Pie 自身のサービスを経由する
  のは、この経路だけです。）

対応している BYOK プロバイダー：**Anthropic Claude · OpenAI · Google Gemini ·
OpenRouter · DeepSeek · MiniMax · GLM（Zhipu）· Bailian · Mimo（Xiaomi）·
Moonshot（Kimi —— 国際版および中国版）· StepFun**。Ollama によるローカルモデルは
[ロードマップ](../ROADMAP.md)にあります。

## プライバシー

- **あなたのデータはあなたのもの。** BYOK では、API key は端末上で暗号化され、
  選んだプロバイダーにのみ送られます —— Pie はサーバーを介在させず、テレメトリも
  分析も一切収集しません。
- **唯一の例外がサブスクリプションです。** Pie 公式サブスクリプションを使う場合、
  チャットのリクエストは Pie のサービスを経由します（課金に必要なため）—— それでも
  Pie は製品テレメトリを一切収集しません。
- **Pie がページを見るのは、あなたが指示した作業を実行している間だけです。** さらに
  ページ上のすべてを信頼できないものとして扱うため、悪意のあるページが Pie を騙して
  頼んでいないことをさせることはできません。

詳細なポリシーは [PRIVACY.md](../../PRIVACY.md) をご覧ください。

## インストール

サイドパネルに対応した Chromium 系ブラウザで動作します —— Chrome 114+、Edge、
Brave、Arc など。

### 方法 1 —— Chrome ウェブストア（推奨）

**[Chrome ウェブストア](https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed)** からインストールし、**Add to Chrome** をクリックして Pie をツールバーに固定します。Chrome が自動で最新に保ちます。

### 方法 2 —— GitHub Release の zip

オフラインや自己管理環境で、同じビルドをインストールする場合：

1. [Releases ページ](https://github.com/WiseriaAI/pie-ai-agent/releases)から最新の `pie-x.y.z.zip` をダウンロード
2. 残しておくフォルダーに解凍します（Chrome はこのフォルダーから読み込みます —— 削除しないこと）
3. `chrome://extensions` を開き、**デベロッパーモード**をオンにします
4. **パッケージ化されていない拡張機能を読み込む**をクリックし、そのフォルダーを選びます
5. Pie をツールバーに固定し、アイコンをクリックしてサイドパネルを開きます

> **アップグレード：** チャットや保存した key を残すには、新しいリリースを**同じ
> フォルダーに**解凍し、Pie のカードの **↻ 再読み込み** をクリックします。**削除**は
> 押さないでください —— 暗号化された key やチャット履歴を含め、端末に保存されたすべてが
> 消えます。

### 方法 3 —— ソースからビルド

```bash
git clone https://github.com/WiseriaAI/pie-ai-agent.git
cd Pie
pnpm install
pnpm build
```

生成された `dist/` フォルダーをパッケージ化されていない拡張機能として読み込みます（上記の手順 3〜5）。

## 設定

1. サイドパネルを開き、**Settings** に移動します
2. モデルを追加します —— API key を貼り付ける（BYOK）か、ログインして公式サブスクリプションを使います
3. **Chat** に切り替えて、最初のメッセージを送ります

## ビルドと貢献

```bash
pnpm install
pnpm dev          # ホットリロード付き開発サーバー
pnpm test         # テストを実行
pnpm build        # dist/ への本番ビルド
```

Pie は React 19、TypeScript、Vite で作られた Manifest V3 拡張機能です。アーキテクチャ
の解説や貢献ガイドは [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) と
[`CLAUDE.md`](../../CLAUDE.md) にあります。

## ロードマップ

[`docs/ROADMAP.md`](../ROADMAP.md) を参照してください。主な項目：

- Ollama によるローカルモデル対応
- キーボードショートカット
- ページ URL に一致したときに自動起動する Skill

## ライセンス

[Apache License, Version 2.0](../../LICENSE) —— © 2026 Pie Project Contributors.
