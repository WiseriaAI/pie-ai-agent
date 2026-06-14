<div align="center">
  <img src="../../public/icons/icon-128.svg" alt="Pie" width="96" height="96" />
  <h1>Pie</h1>
  <p><strong>Agente de automatización del navegador para Chrome, con tareas en lenguaje natural, herramientas nativas y un modelo local-first.</strong></p>
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
    <a href="#instalacion">Instalación</a> ·
    <a href="#primera-configuracion">Configuración</a> ·
    <a href="../../PRIVACY.md">Privacidad</a> ·
    <a href="../../CHANGELOG.md">Changelog</a> ·
    <a href="../ROADMAP.md">Roadmap</a> ·
    <a href="../ARCHITECTURE.md">Arquitectura</a> ·
    <a href="https://wiseriaai.github.io/pie-ai-agent/">Archivo</a>
  </p>
</div>

---

## Qué es Pie

Pie es un agente de IA abierto para Chrome. Vive en el panel lateral, puede leer la página actual y ayuda a automatizar tareas del navegador.

Describe una tarea en lenguaje natural y Pie la ejecuta con herramientas del navegador: leer la página, hacer clic, escribir, organizar pestañas y convertir contenido en datos útiles.

## Instalación

### Opción 1 — Chrome Web Store

Instala Pie desde **[Chrome Web Store](https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed)**, haz clic en **Add to Chrome** y fija Pie en la barra de herramientas.

### Opción 2 — GitHub Release zip

1. Descarga el archivo `pie-x.y.z.zip` más reciente desde la [página de Releases](https://github.com/WiseriaAI/pie-ai-agent/releases).
2. Descomprímelo en una carpeta que conservarás.
3. Abre `chrome://extensions`.
4. Activa **Developer mode**.
5. Haz clic en **Load unpacked** y selecciona la carpeta.
6. Fija Pie en la barra de herramientas y abre el panel lateral.

### Opción 3 — Compilar desde el código fuente

```bash
git clone https://github.com/WiseriaAI/pie-ai-agent.git
cd Pie
pnpm install
pnpm build
```

Luego carga la carpeta `dist/` como extensión unpacked.

## Primera configuración

1. Abre el panel lateral de Pie.
2. Entra a **Settings**.
3. Agrega un proveedor, pega tu API key y elige un modelo.
4. Vuelve a **Chat**.

Tu API key se cifra antes de guardarse localmente.

## Ejecutar tu primera tarea

Abre una página, escribe una instrucción como "resume esta página en tres puntos" y deja que Pie trabaje con la página actual.

## Modelo de privacidad

Usas tu propia clave de modelo. Pie no opera un backend, no hace proxy de tus solicitudes y no recopila telemetría del producto.

Tu API key se cifra localmente y solo se envía al proveedor que elegiste. Consulta la política completa en [PRIVACY.md](../../PRIVACY.md).

## Comentarios

Reporta problemas o sugerencias en [GitHub Issues](https://github.com/WiseriaAI/pie-ai-agent/issues).
