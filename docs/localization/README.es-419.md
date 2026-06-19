<div align="center">
  <img src="../../public/icons/icon-128.svg" alt="Pie" width="96" height="96" />
  <h1>Pie</h1>
  <p><strong>Un agente de IA de código abierto que vive en el panel lateral de Chrome. Dile lo que quieres en lenguaje natural — lee páginas, hace clic, escribe y resuelve tareas entre tus pestañas.</strong></p>
  <p>
    <a href="https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed"><img src="https://img.shields.io/chrome-web-store/v/gpccjhdgjkmalnepmeclooflliiocfed?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white" alt="Disponible en Chrome Web Store" /></a>
  </p>
  <p>
    <a href="../../README.md">English</a> ·
    <a href="README.zh-CN.md">简体中文</a> ·
    <a href="README.zh-TW.md">繁體中文</a> ·
    <strong>Español (Latinoamérica)</strong> ·
    <a href="README.ja.md">日本語</a> ·
    <a href="README.pt-BR.md">Português (Brasil)</a>
  </p>
  <p>
    <a href="#instalación">Instalación</a> ·
    <a href="#conectar-un-modelo">Conectar un modelo</a> ·
    <a href="../../PRIVACY.md">Privacidad</a> ·
    <a href="https://github.com/WiseriaAI/pie-ai-agent/releases">Changelog</a> ·
    <a href="../ROADMAP.md">Roadmap</a> ·
    <a href="../ARCHITECTURE.md">Arquitectura</a> ·
    <a href="https://wiseriaai.github.io/pie-ai-agent/">Archivo</a>
  </p>
</div>

---

## Qué es Pie

Pie es un asistente de IA que *usa* tu navegador, en vez de solo conversar dentro
de él. Se abre en el panel lateral de Chrome y se queda ahí mientras trabajas.
Describe una tarea en lenguaje cotidiano y Pie averigua los pasos y los ejecuta en
la página que tienes delante — leyendo, haciendo clic, escribiendo, cambiando de
pestaña — para que no tengas que hacerlo clic a clic.

Es gratis y de código abierto. Trae la clave de tu propio modelo de cualquiera de
los 11 proveedores, o suscríbete a Pie y olvídate de la configuración.

## Qué puedes hacer

- **Pregunta sobre la página en la que estás.** Resume un artículo largo, extrae
  los puntos clave, responde preguntas sobre el contenido — **incluidos PDF**, no
  solo páginas web normales.
- **Delega tareas de varios pasos.** "Compara estos tres productos y dime cuál
  conviene más." "Llena este formulario con mis notas." Pie planifica los pasos y
  hace los clics, la escritura y el desplazamiento por ti.
- **Trabaja entre todas tus pestañas.** Reúne información de varias pestañas
  abiertas a la vez y mantén todo en orden — agrupa pestañas relacionadas, cierra
  las duplicadas, despeja las que ya no usas.
- **Busca en la web.** Cuando la página actual no alcanza, Pie consulta para traer
  información actualizada.
- **Escribe dentro de editores de verdad.** Pie puede escribir en editores
  enriquecidos que normalmente ignoran la automatización — Google Docs, Lark Docs
  y editores de código —, no solo en cuadros de texto simples.
- **Convierte páginas en archivos.** Extrae datos estructurados de una página y
  expórtalos como un archivo que puedes descargar.
- **Guarda y reutiliza tus flujos (Skills).** Convierte una tarea frecuente en un
  `/comando` reutilizable, o simplemente hazla una vez grabándola y deja que Pie
  arme la Skill por ti.
- **Programa tareas.** Haz que Pie ejecute una tarea automáticamente — a diario,
  cada semana o cada pocas horas — incluso en segundo plano mientras no estás.

## Conectar un modelo

Pie necesita un modelo de IA para pensar. Elige el que prefieras — puedes cambiar
cuando quieras o tener varios a la vez.

- **Trae tu propia clave (BYOK).** Pega una clave de API de cualquier proveedor de
  abajo. Es gratis y totalmente privado: tu clave se cifra en tu dispositivo y se
  envía solo a ese proveedor — nunca a un servidor de Pie.
- **Suscripción oficial de Pie (opcional).** ¿No quieres lidiar con claves? Inicia
  sesión con Google y suscríbete — todo funciona de inmediato. (Este es el único
  camino en el que tus solicitudes pasan por el propio servicio de Pie.)

Proveedores BYOK compatibles: **Anthropic Claude · OpenAI · Google Gemini ·
OpenRouter · DeepSeek · MiniMax · GLM (Zhipu) · Bailian · Mimo (Xiaomi) ·
Moonshot (Kimi — internacional y China) · StepFun**. Los modelos locales vía
Ollama están en el [roadmap](../ROADMAP.md).

## Privacidad

- **Tus datos son tuyos.** Con BYOK, tu clave de API se cifra en tu dispositivo y
  solo se envía al proveedor que elegiste — Pie no tiene ningún servidor de por
  medio y no recopila telemetría ni analíticas.
- **La suscripción es la única excepción.** Si usas la suscripción oficial de Pie,
  tus solicitudes de chat pasan por el servicio de Pie (así funciona el cobro) —
  pero Pie sigue sin recopilar telemetría de producto.
- **Pie solo mira una página mientras ejecuta la tarea que le pediste** y trata
  todo lo que hay en la página como no confiable, de modo que una página maliciosa
  no pueda engañarlo para hacer algo que nunca pediste.

Política completa: [PRIVACY.md](../../PRIVACY.md).

## Instalación

Funciona en cualquier navegador basado en Chromium con panel lateral — Chrome
114+, Edge, Brave, Arc y otros.

### Opción 1 — Chrome Web Store (recomendada)

Instala desde **[Chrome Web Store](https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed)**, haz clic en **Add to Chrome** y fija Pie en la barra de herramientas. Chrome lo mantiene actualizado automáticamente.

### Opción 2 — zip de GitHub Release

Para una instalación offline o autogestionada de la misma versión:

1. Descarga el `pie-x.y.z.zip` más reciente desde la [página de Releases](https://github.com/WiseriaAI/pie-ai-agent/releases)
2. Descomprímelo en una carpeta que vayas a conservar (Chrome carga desde ella — no la borres)
3. Abre `chrome://extensions` y activa el **Modo de desarrollador**
4. Haz clic en **Cargar descomprimida** y selecciona la carpeta
5. Fija Pie en la barra de herramientas y haz clic en el ícono para abrir el panel lateral

> **Actualizar:** para conservar tus chats y claves guardadas, descomprime la
> nueva versión *en la misma carpeta* y haz clic en **↻ recargar** en la tarjeta
> de Pie. No hagas clic en **Quitar** — eso borra todo lo guardado en tu
> dispositivo, incluidas las claves cifradas y el historial de conversaciones.

### Opción 3 — Compilar desde el código fuente

```bash
git clone https://github.com/WiseriaAI/pie-ai-agent.git
cd Pie
pnpm install
pnpm build
```

Luego carga la carpeta `dist/` generada como extensión descomprimida (pasos 3–5 de arriba).

## Configuración

1. Abre el panel lateral y entra a **Settings**
2. Agrega un modelo — pega tu clave de API (BYOK) o inicia sesión para usar la suscripción oficial
3. Cambia a **Chat** y envía tu primer mensaje

## Compilar y contribuir

```bash
pnpm install
pnpm dev          # servidor de desarrollo con hot reload
pnpm test         # corre las pruebas
pnpm build        # build de producción a dist/
```

Pie es una extensión Manifest V3 hecha con React 19, TypeScript y Vite. Las notas
de arquitectura y la guía para contribuir están en
[`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) y [`CLAUDE.md`](../../CLAUDE.md).

## Roadmap

Consulta [`docs/ROADMAP.md`](../ROADMAP.md). Aspectos destacados:

- Modelos locales vía Ollama
- Atajos de teclado
- Skills que se activan automáticamente en URLs de página coincidentes

## Licencia

[Apache License, Version 2.0](../../LICENSE) — © 2026 Pie Project Contributors.
