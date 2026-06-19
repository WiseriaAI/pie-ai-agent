<div align="center">
  <img src="../../public/icons/icon-128.svg" alt="Pie" width="96" height="96" />
  <h1>Pie</h1>
  <p><strong>Um agente de IA de código aberto que mora no painel lateral do Chrome. Diga o que você quer em linguagem natural — ele lê páginas, clica, digita e resolve tarefas entre as suas abas.</strong></p>
  <p>
    <a href="https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed"><img src="https://img.shields.io/chrome-web-store/v/gpccjhdgjkmalnepmeclooflliiocfed?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white" alt="Disponível na Chrome Web Store" /></a>
  </p>
  <p>
    <a href="../../README.md">English</a> ·
    <a href="README.zh-CN.md">简体中文</a> ·
    <a href="README.zh-TW.md">繁體中文</a> ·
    <a href="README.es-419.md">Español (Latinoamérica)</a> ·
    <a href="README.ja.md">日本語</a> ·
    <strong>Português (Brasil)</strong>
  </p>
  <p>
    <a href="#instalação">Instalação</a> ·
    <a href="#conectar-um-modelo">Conectar um modelo</a> ·
    <a href="../../PRIVACY.md">Privacidade</a> ·
    <a href="https://github.com/WiseriaAI/pie-ai-agent/releases">Changelog</a> ·
    <a href="../ROADMAP.md">Roadmap</a> ·
    <a href="../ARCHITECTURE.md">Arquitetura</a> ·
    <a href="https://wiseriaai.github.io/pie-ai-agent/">Arquivo</a>
  </p>
</div>

---

## O que é o Pie

O Pie é um assistente de IA que *usa* o seu navegador, em vez de apenas conversar
dentro dele. Ele abre no painel lateral do Chrome e fica ali enquanto você
trabalha. Descreva uma tarefa em linguagem do dia a dia e o Pie descobre os
passos e os executa na página à sua frente — lendo, clicando, digitando, trocando
de abas — para você não precisar fazer isso clique a clique.

É gratuito e de código aberto. Traga a chave do seu próprio modelo de qualquer um
dos 11 provedores, ou assine o Pie e pule toda a configuração.

## O que você pode fazer

- **Pergunte sobre a página em que você está.** Resuma um artigo longo, extraia os
  pontos principais, tire dúvidas sobre o conteúdo — **inclusive PDFs**, não só
  páginas web comuns.
- **Delegue tarefas de vários passos.** "Compare estes três produtos e diga qual
  tem o melhor custo-benefício." "Preencha este formulário com as minhas
  anotações." O Pie planeja os passos e faz os cliques, a digitação e a rolagem
  por você.
- **Trabalhe entre todas as suas abas.** Reúna informações de várias abas abertas
  de uma vez e mantenha tudo organizado — agrupe abas relacionadas, feche
  duplicadas, limpe as que você já não usa.
- **Pesquise na web.** Quando a página atual não basta, o Pie busca para trazer
  informações atualizadas.
- **Escreva dentro de editores de verdade.** O Pie consegue digitar em editores
  ricos que normalmente ignoram automação — Google Docs, Lark Docs e editores de
  código —, não apenas em caixas de texto simples.
- **Transforme páginas em arquivos.** Extraia dados estruturados de uma página e
  exporte como um arquivo para baixar.
- **Salve e reaproveite seus fluxos (Skills).** Transforme uma tarefa frequente em
  um `/comando` reutilizável, ou apenas faça-a uma vez gravando e deixe o Pie
  montar a Skill para você.
- **Rode tarefas no horário marcado.** Faça o Pie executar uma tarefa
  automaticamente — diariamente, semanalmente ou a cada poucas horas — até em
  segundo plano enquanto você está fora.

## Conectar um modelo

O Pie precisa de um modelo de IA para pensar. Escolha o que preferir — você pode
trocar a qualquer momento ou manter vários lado a lado.

- **Traga a sua chave (BYOK).** Cole uma chave de API de qualquer provedor abaixo.
  É gratuito de usar e totalmente privado: a sua chave é criptografada no seu
  dispositivo e enviada apenas para aquele provedor — nunca para um servidor do Pie.
- **Assinatura oficial do Pie (opcional).** Não quer gerenciar chaves? Entre com o
  Google e assine — tudo funciona de imediato. (Esse é o único caminho em que as
  suas solicitações passam pelo serviço do próprio Pie.)

Provedores BYOK suportados: **Anthropic Claude · OpenAI · Google Gemini ·
OpenRouter · DeepSeek · MiniMax · GLM (Zhipu) · Bailian · Mimo (Xiaomi) ·
Moonshot (Kimi — internacional e China) · StepFun**. Modelos locais via Ollama
estão no [roadmap](../ROADMAP.md).

## Privacidade

- **Seus dados são seus.** Com o BYOK, a sua chave de API é criptografada no seu
  dispositivo e enviada somente ao provedor que você escolheu — o Pie não tem
  servidor no meio do caminho e não coleta telemetria nem análises.
- **A assinatura é a única exceção.** Se você usar a assinatura oficial do Pie, as
  suas solicitações de chat passam pelo serviço do Pie (é assim que a cobrança
  funciona) — mas o Pie ainda assim não coleta telemetria de produto.
- **O Pie só olha para uma página enquanto executa a tarefa que você pediu** e
  trata tudo na página como não confiável, de modo que uma página maliciosa não
  consegue enganá-lo para fazer algo que você nunca pediu.

Política completa: [PRIVACY.md](../../PRIVACY.md).

## Instalação

Funciona em qualquer navegador baseado em Chromium com suporte a painel lateral —
Chrome 114+, Edge, Brave, Arc e outros.

### Opção 1 — Chrome Web Store (recomendada)

Instale pela **[Chrome Web Store](https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed)**, clique em **Add to Chrome** e fixe o Pie na barra de ferramentas. O Chrome mantém tudo atualizado automaticamente.

### Opção 2 — zip do GitHub Release

Para uma instalação offline ou autogerenciada da mesma versão:

1. Baixe o `pie-x.y.z.zip` mais recente na [página de Releases](https://github.com/WiseriaAI/pie-ai-agent/releases)
2. Descompacte em uma pasta que você vai manter (o Chrome carrega a partir dela — não apague)
3. Abra `chrome://extensions` e ative o **Modo do desenvolvedor**
4. Clique em **Carregar sem compactação** e selecione a pasta
5. Fixe o Pie na barra de ferramentas e clique no ícone para abrir o painel lateral

> **Atualização:** para manter seus chats e chaves salvas, descompacte a nova
> versão *na mesma pasta* e clique em **↻ recarregar** no cartão do Pie. Não
> clique em **Remover** — isso apaga tudo o que está guardado no seu dispositivo,
> incluindo as chaves criptografadas e o histórico de conversas.

### Opção 3 — Compilar a partir do código-fonte

```bash
git clone https://github.com/WiseriaAI/pie-ai-agent.git
cd Pie
pnpm install
pnpm build
```

Depois carregue a pasta `dist/` gerada como extensão sem compactação (passos 3–5 acima).

## Configuração

1. Abra o painel lateral e vá em **Settings**
2. Adicione um modelo — cole a sua chave de API (BYOK) ou entre para usar a assinatura oficial
3. Mude para **Chat** e envie a sua primeira mensagem

## Compilar e contribuir

```bash
pnpm install
pnpm dev          # servidor de desenvolvimento com hot reload
pnpm test         # roda os testes
pnpm build        # build de produção para dist/
```

O Pie é uma extensão Manifest V3 feita com React 19, TypeScript e Vite. Notas de
arquitetura e orientação para contribuidores estão em
[`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) e [`CLAUDE.md`](../../CLAUDE.md).

## Roadmap

Veja [`docs/ROADMAP.md`](../ROADMAP.md). Destaques:

- Modelos locais via Ollama
- Atalhos de teclado
- Skills que disparam automaticamente em URLs de página correspondentes

## Licença

[Apache License, Version 2.0](../../LICENSE) — © 2026 Pie Project Contributors.
