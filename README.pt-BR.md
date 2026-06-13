<div align="center">
  <img src="public/icons/icon-128.svg" alt="Pie" width="96" height="96" />
  <h1>Pie</h1>
  <p><strong>Agente de automação do navegador para Chrome, com tarefas em linguagem natural, ferramentas nativas e um modelo local-first.</strong></p>
  <p>
    <a href="https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed"><img src="https://img.shields.io/chrome-web-store/v/gpccjhdgjkmalnepmeclooflliiocfed?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white" alt="Disponível na Chrome Web Store" /></a>
  </p>
  <p>
    <a href="README.md">English</a> ·
    <a href="README.zh-CN.md">简体中文</a> ·
    <a href="README.es-419.md">Español (Latinoamérica)</a> ·
    <a href="README.ja.md">日本語</a> ·
    <strong>Português (Brasil)</strong>
  </p>
  <p>
    <a href="#instalacao">Instalação</a> ·
    <a href="#primeira-configuracao">Configuração</a> ·
    <a href="PRIVACY.md">Privacidade</a> ·
    <a href="CHANGELOG.md">Changelog</a> ·
    <a href="docs/ROADMAP.md">Roadmap</a> ·
    <a href="docs/ARCHITECTURE.md">Arquitetura</a> ·
    <a href="https://wiseriaai.github.io/pie-ai-agent/">Arquivo</a>
  </p>
</div>

---

## O que é o Pie

Pie é um agente de IA aberto para Chrome. Ele funciona no painel lateral, lê a página atual e ajuda a automatizar tarefas do navegador.

Descreva uma tarefa em linguagem natural e o Pie usa ferramentas do navegador para ler páginas, clicar, digitar, organizar abas e transformar conteúdo em dados úteis.

## Instalação

### Opção 1 — Chrome Web Store

Instale pela **[Chrome Web Store](https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed)**, clique em **Add to Chrome** e fixe o Pie na barra de ferramentas.

### Opção 2 — GitHub Release zip

1. Baixe o `pie-x.y.z.zip` mais recente na [página de Releases](https://github.com/WiseriaAI/pie-ai-agent/releases).
2. Descompacte em uma pasta que você vai manter.
3. Abra `chrome://extensions`.
4. Ative **Developer mode**.
5. Clique em **Load unpacked** e selecione a pasta.
6. Fixe o Pie na barra de ferramentas e abra o painel lateral.

### Opção 3 — Compilar do código-fonte

```bash
git clone https://github.com/WiseriaAI/pie-ai-agent.git
cd Pie
pnpm install
pnpm build
```

Depois carregue a pasta `dist/` como extensão unpacked.

## Primeira configuração

1. Abra o painel lateral do Pie.
2. Entre em **Settings**.
3. Adicione um provedor, cole sua API key e escolha um modelo.
4. Volte para **Chat**.

Sua API key é criptografada antes de ser salva localmente.

## Execute sua primeira tarefa

Abra uma página, escreva algo como "resuma esta página em três pontos" e deixe o Pie trabalhar com a página atual.

## Modelo de privacidade

Você usa sua própria chave de modelo. Pie não opera um backend, não faz proxy das suas solicitações e não coleta telemetria do produto.

Sua API key é criptografada localmente e enviada apenas ao provedor escolhido. Leia a política completa em [PRIVACY.md](PRIVACY.md).

## Feedback

Relate problemas ou sugestões em [GitHub Issues](https://github.com/WiseriaAI/pie-ai-agent/issues).
