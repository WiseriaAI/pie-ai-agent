// ── i18n dictionary (verbatim from Paper artboards) ──────────────────
const I18N = {
  en: {
    "nav.install":"Add to Chrome", "nav.star":"Star",
    "hero.eyebrow":"AI in your browser",
    "hero.title":"Tell your browser what to do.",
    "hero.sub":"Pie is an open-source browser agent that can read pages, operate websites, turn messy page content into usable data, and replay your own workflows as skills — all with your own model key.",
    "hero.cta":"Add to Chrome", "hero.star":"Star on GitHub",
    "hero.micro":"Open-source  ·  BYOK  ·  No telemetry",
    "panel.title":"Summarize page",
    "panel.user":"Summarize this page in 3 points",
    "panel.done":"Done · 3 steps",
    "panel.b1":"Understands the current page instead of asking you to copy text around.",
    "panel.b2":"Uses browser tools to click, type, search, read, and move across tabs.",
    "panel.b3":"Turns repeated work into reusable skills you can run again.",
    "panel.input":"Ask or describe a task…",
    "tour.eyebrow":"How it works", "tour.title":"Say this. Get that.",
    "tour.sub":"No scripts, no setup ritual. Ask for the outcome; Pie reads the page, chooses the right tools, and works through the steps.",
    "you":"You say",
    "s1.tag":"· PAGE & PDF Q&A", "s1.cmd":"“What’s the refund policy on this page?”",
    "s1.out":"Ask anything about the current page, a long app screen, or a PDF. Pie pulls out the relevant content so you don't have to copy, paste, or hunt through the DOM.",
    "s1.done":"Done · 2 steps",
    "s1.ans":"Refunds are accepted within 30 days of delivery. Opened items qualify only if the original seal is intact, and shipping costs are non-refundable.",
    "s2.tag":"· DATA EXTRACTION", "s2.cmd":"“Pull the price from each of these tabs into a table.”",
    "s2.out":"Pie can collect structured facts from pages, compare them, clean them up, and hand back a table or file when the answer needs more than plain text.",
    "s2.done":"Done · 6 steps", "s2.colA":"Product", "s2.colB":"Price",
    "s3.tag":"· SKILLS & AUTOMATION", "s3.cmd":"“This one's hard to explain — let me just show you.”",
    "s3.out":"Some workflows are easier to demonstrate. Walk through one once and Pie saves it as a skill — then runs the whole routine from a single /command, scoped to only the tools it needs.",
    "pop.count":"2 skills",
    "pop.d1":"Collects this week's open tabs and summarizes each one.",
    "pop.d2":"Draft a standup note from yesterday's tabs and docs.",
    "pop.tag":"User", "pop.nav":"↑↓ navigate", "pop.run":"↵ run", "pop.esc":"esc",
    "rec.label":"RECORDING", "rec.steps":"8 STEPS", "rec.cancel":"Cancel", "rec.finish":"Finish",
    "trust.byok":"BYOK", "trust.byok.d":"Use your own model key. It stays encrypted on your device.",
    "trust.oss":"Open-source", "trust.oss.d":"Code, license, and release history are public on GitHub.",
    "trust.tel":"No telemetry", "trust.tel.d":"No backend, no proxy. Nothing routes through us.",
    "trust.prov":"11 providers", "trust.prov.d":"Claude, GPT, Gemini, DeepSeek, Kimi, StepFun & more.",
    "cap.eyebrow":"Capabilities", "cap.title":"What Pie is good at.",
    "cap.sub":"The important bit is not a longer prompt box. It is a browser agent with page context, tools, skills, data output, and privacy defaults you can understand.",
    "cap.1":"Agent work", "cap.1d":"Pie plans multi-step tasks and uses browser tools for reading, clicking, typing, searching, scrolling, tabs, PDFs, and page editors.",
    "cap.2":"Page content", "cap.2d":"Ask about the page you're on. Pie can read long pages, app screens, PDFs, tables, selected text, and open-tab content.",
    "cap.3":"Data processing", "cap.3d":"Extract fields, compare items, reshape page content into tables, and produce downloadable CSV, JSON, Markdown, or text files.",
    "cap.4":"Skills", "cap.4d":"Save repeatable workflows as slash commands. Record a task once, then run it again without explaining every tiny step.",
    "cap.5":"Web automation", "cap.5d":"Use it for the boring browser work: filling forms, collecting research, moving across tabs, and operating complex web apps.",
    "cap.6":"Security & privacy", "cap.6d":"Bring your own key, keep secrets encrypted locally, avoid Pie-operated backends, and keep untrusted page content isolated.",
    "project.eyebrow":"Open project", "project.title":"Transparent by default.",
    "project.sub":"Pie is developed in the open. The license, release notes, and historical versions are easy to inspect before you install or upgrade.",
    "project.license.k":"License", "project.license.t":"Apache-2.0", "project.license.d":"A permissive open-source license with an explicit patent grant.",
    "project.latest.k":"Latest notes", "project.latest.t":"v1.0.0", "project.latest.d":"Pie's first stable major — long-horizon task tooling, a rebuilt storage layer, and a redesigned side panel.",
    "project.history.k":"Version history", "project.history.t":"All releases", "project.history.d":"Browse tagged releases, assets, and older notes directly on GitHub.",
    "version.100":"First stable major: long-horizon task memory, a new storage foundation, and a redesigned side panel.",
    "version.0195":"Model picker, in-page editor read/write, and resumable abort.",
    "version.0192":"Better large-page reading, search, recording fidelity, and pinned-tab safety.",
    "version.0190":"Kimi provider, thinking display, search_page, and per-model attributes.",
    "cta.eyebrow":"Get started", "cta.title":"Put your browser to work",
    "cta.sub":"Install Pie, describe a task, and let it handle the steps.",
    "cta.install":"Add to Chrome", "cta.star":"Star on GitHub", "cta.meta":"Chrome · Manifest V3 · v1.0.0",
    "foot.tagline":"An open-source AI agent that lives in your browser.",
    "foot.privacy":"Privacy", "foot.license":"License", "foot.release":"Release notes",
    "foot.releases":"Versions", "foot.roadmap":"Roadmap", "foot.github":"GitHub", "foot.store":"Chrome Web Store",
    "foot.copy":"© 2026 Pie · Open-source · Apache-2.0", "foot.made":"Made for Chrome",
  },
  zh: {
    "nav.install":"添加到 Chrome", "nav.star":"Star",
    "hero.eyebrow":"浏览器里的 AI Agent",
    "hero.title":"说一句话，浏览器替你干完。",
    "hero.sub":"Pie 是一个开源浏览器 Agent：能读网页、操作网站、把页面内容整理成可用数据，也能把你演示过的流程保存成技能。模型用你自己的 key。",
    "hero.cta":"添加到 Chrome", "hero.star":"在 GitHub 上 Star",
    "hero.micro":"开源  ·  BYOK  ·  无遥测",
    "panel.title":"总结这页",
    "panel.user":"把这页总结成 3 点",
    "panel.done":"完成 · 3 步",
    "panel.b1":"它直接理解当前页面，不用你到处复制粘贴。",
    "panel.b2":"会用浏览器工具去点击、输入、搜索、读取和切换标签。",
    "panel.b3":"重复工作可以沉淀成技能，下次直接运行。",
    "panel.input":"问点什么，或者说个任务…",
    "tour.eyebrow":"怎么用", "tour.title":"说句话，就有结果。",
    "tour.sub":"不用写脚本，也不用研究一堆设置。你说想要的结果，Pie 读取页面、选择工具，然后一步步做完。",
    "you":"你说",
    "s1.tag":"· 网页 & PDF 问答", "s1.cmd":"「这页的退款政策是啥？」",
    "s1.out":"当前网页、长应用页面、打开的 PDF，都可以直接问。Pie 会抓出相关内容，不用你复制粘贴，也不用自己翻 DOM。",
    "s1.done":"完成 · 2 步",
    "s1.ans":"支持自收货起 30 天内退款。已拆封商品需原封条完好；运费不予退还。",
    "s2.tag":"· 数据提取", "s2.cmd":"「把这几个标签页里的价格扒下来，弄成一张表。」",
    "s2.out":"Pie 可以从页面里提取字段、对比信息、清理格式，需要时还能输出表格或文件，不只是回一段文字。",
    "s2.done":"完成 · 6 步", "s2.colA":"商品", "s2.colB":"价格",
    "s3.tag":"· 技能 & 自动化", "s3.cmd":"「这个不好描述，我直接录一遍给你看。」",
    "s3.out":"有些流程讲半天不如演一遍。你亲手走一遍，Pie 就把它存成技能——下次一个 /命令，整套流程重跑，而且只拿它需要的工具权限。",
    "pop.count":"2 个技能",
    "pop.d1":"把这周开过的标签收拢一遍，挨个总结。",
    "pop.d2":"照着昨天的标签和文档，起草一份站会要点。",
    "pop.tag":"用户", "pop.nav":"↑↓ 选择", "pop.run":"↵ 运行", "pop.esc":"esc 关闭",
    "rec.label":"录制中", "rec.steps":"8 步", "rec.cancel":"取消", "rec.finish":"完成",
    "trust.byok":"BYOK", "trust.byok.d":"用你自己的模型 key，并加密保存在本地。",
    "trust.oss":"开源", "trust.oss.d":"代码、许可证、历史版本都公开在 GitHub。",
    "trust.tel":"无遥测", "trust.tel.d":"没后端也没代理，啥都不过我们的手。",
    "trust.prov":"11 家 provider", "trust.prov.d":"Claude、GPT、Gemini、DeepSeek、Kimi、阶跃等。",
    "cap.eyebrow":"能力", "cap.title":"Pie 主要能做什么。",
    "cap.sub":"重点不是多一个聊天框，而是一个有页面上下文、会用工具、能沉淀技能、能处理数据、也尊重隐私的浏览器 Agent。",
    "cap.1":"Agent 能力", "cap.1d":"Pie 会规划多步任务，并使用读取、点击、输入、搜索、滚动、标签页、PDF、页面编辑器等浏览器工具。",
    "cap.2":"页面内容获取", "cap.2d":"当前页面可以直接问。长网页、应用界面、PDF、表格、选中文本、打开的标签内容都能读。",
    "cap.3":"数据处理", "cap.3d":"从页面提字段、比信息、整理格式，把散乱内容变成表格，也可以生成 CSV、JSON、Markdown 或文本文件。",
    "cap.4":"技能", "cap.4d":"把重复流程保存成 slash command。演示一次，以后不用再把每个小步骤重新讲一遍。",
    "cap.5":"网页自动化", "cap.5d":"适合处理浏览器里的琐事：填表、收集资料、跨标签整理、操作复杂 Web App。",
    "cap.6":"安全与隐私", "cap.6d":"自带 key、本地加密、不走 Pie 的后端；网页内容按不可信输入隔离，减少提示注入风险。",
    "project.eyebrow":"开源项目", "project.title":"信息默认透明。",
    "project.sub":"Pie 在 GitHub 上开放开发。安装或升级前，你可以直接查看许可证、release notes 和历史版本。",
    "project.license.k":"许可证", "project.license.t":"Apache-2.0", "project.license.d":"宽松的开源许可证，并带有明确的专利授权。",
    "project.latest.k":"最新更新", "project.latest.t":"v1.0.0", "project.latest.d":"Pie 首个稳定大版本——长程任务工具链、重建的存储层、重做的侧边栏。",
    "project.history.k":"历史版本", "project.history.t":"全部 Releases", "project.history.d":"在 GitHub 上查看 tag、安装包、旧版本说明和历史变更。",
    "version.100":"首个稳定大版本：长程任务记忆、全新存储底座、重做的侧边栏。",
    "version.0195":"模型选择器、页面编辑器读写、停止任务后可续接。",
    "version.0192":"大型页面读取、搜索、录制还原度和 pinned tab 安全增强。",
    "version.0190":"Kimi provider、thinking 展示、search_page 和模型属性编辑。",
    "cta.eyebrow":"开始使用", "cta.title":"让浏览器替你干活",
    "cta.sub":"装上 Pie，说出任务，剩下的步骤交给它。",
    "cta.install":"添加到 Chrome", "cta.star":"在 GitHub 上 Star", "cta.meta":"Chrome · Manifest V3 · v1.0.0",
    "foot.tagline":"一个住在你浏览器里的开源 AI agent。",
    "foot.privacy":"隐私", "foot.license":"许可证", "foot.release":"更新日志",
    "foot.releases":"历史版本", "foot.roadmap":"路线图", "foot.github":"GitHub", "foot.store":"Chrome 应用商店",
    "foot.copy":"© 2026 Pie · 开源 · Apache-2.0", "foot.made":"为 Chrome 打造",
  },
  "es-419": {
    "nav.install":"Agregar a Chrome", "nav.star":"Star",
    "hero.eyebrow":"IA en tu navegador",
    "hero.title":"Dile a tu navegador qué hacer.",
    "hero.sub":"Pie es un agente de navegador abierto que puede leer páginas, operar sitios, convertir contenido desordenado en datos útiles y repetir tus flujos como habilidades, todo con tu propia clave de modelo.",
    "hero.cta":"Agregar a Chrome", "hero.star":"Star en GitHub",
    "hero.micro":"Código abierto  ·  BYOK  ·  Sin telemetría",
    "panel.title":"Resumir página",
    "panel.user":"Resume esta página en 3 puntos",
    "panel.done":"Listo · 3 pasos",
    "panel.b1":"Entiende la página actual sin pedirte que copies texto de un lado a otro.",
    "panel.b2":"Usa herramientas del navegador para hacer clic, escribir, buscar, leer y moverse entre pestañas.",
    "panel.b3":"Convierte trabajo repetido en habilidades reutilizables que puedes volver a ejecutar.",
    "panel.input":"Pregunta o describe una tarea…",
    "tour.eyebrow":"Cómo funciona", "tour.title":"Di esto. Obtén eso.",
    "tour.sub":"Sin scripts ni rituales de configuración. Pide el resultado; Pie lee la página, elige las herramientas correctas y avanza paso a paso.",
    "you":"Tú dices",
    "s1.tag":"· PREGUNTAS SOBRE PÁGINAS Y PDF", "s1.cmd":"“¿Cuál es la política de reembolso en esta página?”",
    "s1.out":"Pregunta cualquier cosa sobre la página actual, una pantalla larga de una app o un PDF. Pie extrae el contenido relevante para que no tengas que copiar, pegar ni buscar en el DOM.",
    "s1.done":"Listo · 2 pasos",
    "s1.ans":"Se aceptan reembolsos dentro de los 30 días posteriores a la entrega. Los artículos abiertos califican solo si el sello original está intacto, y los costos de envío no son reembolsables.",
    "s2.tag":"· EXTRACCIÓN DE DATOS", "s2.cmd":"“Saca el precio de cada una de estas pestañas y ponlo en una tabla.”",
    "s2.out":"Pie puede recopilar datos estructurados de páginas, compararlos, limpiarlos y devolverte una tabla o archivo cuando la respuesta necesita más que texto plano.",
    "s2.done":"Listo · 6 pasos", "s2.colA":"Producto", "s2.colB":"Precio",
    "s3.tag":"· HABILIDADES Y AUTOMATIZACIÓN", "s3.cmd":"“Esto es difícil de explicar; mejor te lo muestro.”",
    "s3.out":"Algunos flujos son más fáciles de demostrar. Hazlo una vez y Pie lo guarda como habilidad; después ejecuta toda la rutina con un solo /comando, limitado a las herramientas que necesita.",
    "pop.count":"2 habilidades",
    "pop.d1":"Reúne las pestañas abiertas de esta semana y resume cada una.",
    "pop.d2":"Redacta una nota de standup con las pestañas y documentos de ayer.",
    "pop.tag":"Usuario", "pop.nav":"↑↓ navegar", "pop.run":"↵ ejecutar", "pop.esc":"esc",
    "rec.label":"GRABANDO", "rec.steps":"8 PASOS", "rec.cancel":"Cancelar", "rec.finish":"Finalizar",
    "trust.byok":"BYOK", "trust.byok.d":"Usa tu propia clave de modelo. Permanece cifrada en tu dispositivo.",
    "trust.oss":"Código abierto", "trust.oss.d":"El código, la licencia y el historial de versiones son públicos en GitHub.",
    "trust.tel":"Sin telemetría", "trust.tel.d":"Sin backend ni proxy. Nada pasa por nosotros.",
    "trust.prov":"11 proveedores", "trust.prov.d":"Claude, GPT, Gemini, DeepSeek, Kimi, StepFun y más.",
    "cap.eyebrow":"Capacidades", "cap.title":"En qué es bueno Pie.",
    "cap.sub":"Lo importante no es una caja de prompt más larga. Es un agente de navegador con contexto de página, herramientas, habilidades, salida de datos y valores de privacidad que puedes entender.",
    "cap.1":"Trabajo de agente", "cap.1d":"Pie planifica tareas de varios pasos y usa herramientas del navegador para leer, hacer clic, escribir, buscar, desplazarse, manejar pestañas, PDFs y editores de página.",
    "cap.2":"Contenido de página", "cap.2d":"Pregunta sobre la página donde estás. Pie puede leer páginas largas, pantallas de apps, PDFs, tablas, texto seleccionado y contenido de pestañas abiertas.",
    "cap.3":"Procesamiento de datos", "cap.3d":"Extrae campos, compara elementos, reorganiza contenido de páginas en tablas y produce archivos CSV, JSON, Markdown o texto descargables.",
    "cap.4":"Habilidades", "cap.4d":"Guarda flujos repetibles como comandos slash. Graba una tarea una vez y vuelve a ejecutarla sin explicar cada paso pequeño.",
    "cap.5":"Automatización web", "cap.5d":"Úsalo para el trabajo aburrido del navegador: llenar formularios, recopilar investigación, moverte entre pestañas y operar apps web complejas.",
    "cap.6":"Seguridad y privacidad", "cap.6d":"Trae tu propia clave, mantén secretos cifrados localmente, evita backends operados por Pie y mantén aislado el contenido no confiable de las páginas.",
    "project.eyebrow":"Proyecto abierto", "project.title":"Transparente por defecto.",
    "project.sub":"Pie se desarrolla en abierto. La licencia, las notas de versión y las versiones históricas son fáciles de revisar antes de instalar o actualizar.",
    "project.license.k":"Licencia", "project.license.t":"Apache-2.0", "project.license.d":"Una licencia permisiva de código abierto con una concesión explícita de patentes.",
    "project.latest.k":"Notas recientes", "project.latest.t":"v1.0.0", "project.latest.d":"El primer major estable de Pie: herramientas para tareas de largo alcance, una capa de almacenamiento reconstruida y un panel lateral rediseñado.",
    "project.history.k":"Historial de versiones", "project.history.t":"Todas las versiones", "project.history.d":"Explora etiquetas, assets y notas anteriores directamente en GitHub.",
    "version.100":"Primer major estable: memoria para tareas de largo alcance, nueva base de almacenamiento y panel lateral rediseñado.",
    "version.0195":"Selector de modelo, lectura/escritura en editores de página y reanudación tras abortar.",
    "version.0192":"Mejor lectura de páginas grandes, búsqueda, fidelidad de grabación y seguridad en pestañas fijadas.",
    "version.0190":"Proveedor Kimi, visualización de pensamiento, search_page y atributos por modelo.",
    "cta.eyebrow":"Empieza", "cta.title":"Pon tu navegador a trabajar",
    "cta.sub":"Instala Pie, describe una tarea y deja que se encargue de los pasos.",
    "cta.install":"Agregar a Chrome", "cta.star":"Star en GitHub", "cta.meta":"Chrome · Manifest V3 · v1.0.0",
    "foot.tagline":"Un agente de IA abierto que vive en tu navegador.",
    "foot.privacy":"Privacidad", "foot.license":"Licencia", "foot.release":"Notas de versión",
    "foot.releases":"Versiones", "foot.roadmap":"Roadmap", "foot.github":"GitHub", "foot.store":"Chrome Web Store",
    "foot.copy":"© 2026 Pie · Código abierto · Apache-2.0", "foot.made":"Hecho para Chrome",
  },
  ja: {
    "nav.install":"Chrome に追加", "nav.star":"Star",
    "hero.eyebrow":"ブラウザ内の AI",
    "hero.title":"ブラウザにやってほしいことを伝えるだけ。",
    "hero.sub":"Pie は、ページを読み、サイトを操作し、散らかったページ内容を使えるデータに変え、自分の作業手順をスキルとして再実行できるオープンなブラウザエージェントです。使うのは自分のモデルキーです。",
    "hero.cta":"Chrome に追加", "hero.star":"GitHub で Star",
    "hero.micro":"オープンソース  ·  BYOK  ·  テレメトリなし",
    "panel.title":"ページを要約",
    "panel.user":"このページを3点で要約して",
    "panel.done":"完了 · 3ステップ",
    "panel.b1":"テキストをコピーして渡さなくても、現在のページを理解します。",
    "panel.b2":"ブラウザツールでクリック、入力、検索、読み取り、タブ移動を行います。",
    "panel.b3":"繰り返し作業を再利用できるスキルに変え、次回も実行できます。",
    "panel.input":"質問する、またはタスクを書く…",
    "tour.eyebrow":"使い方", "tour.title":"こう言う。こう返る。",
    "tour.sub":"スクリプトも面倒な設定も不要です。ほしい結果を伝えると、Pie がページを読み、適切なツールを選び、手順を進めます。",
    "you":"あなたの指示",
    "s1.tag":"· ページ & PDF Q&A", "s1.cmd":"「このページの返金ポリシーは？」",
    "s1.out":"現在のページ、長いアプリ画面、PDF について何でも質問できます。Pie が関連内容を取り出すので、コピー、貼り付け、DOM 探しは不要です。",
    "s1.done":"完了 · 2ステップ",
    "s1.ans":"返金は配送日から30日以内に受け付けます。開封済み商品は元の封印が無傷の場合のみ対象で、送料は返金されません。",
    "s2.tag":"· データ抽出", "s2.cmd":"「これらのタブから価格を抜き出して表にして。」",
    "s2.out":"Pie はページから構造化された事実を集め、比較し、整え、プレーンテキストだけでは足りないときに表やファイルとして返せます。",
    "s2.done":"完了 · 6ステップ", "s2.colA":"商品", "s2.colB":"価格",
    "s3.tag":"· スキル & 自動化", "s3.cmd":"「説明しづらいから、一度見せるね。」",
    "s3.out":"説明するより実演した方が早い作業があります。一度手順を進めると Pie がスキルとして保存し、次回は必要なツールだけに絞って1つの /コマンドで実行します。",
    "pop.count":"2個のスキル",
    "pop.d1":"今週開いたタブを集め、それぞれを要約します。",
    "pop.d2":"昨日のタブとドキュメントからスタンドアップメモを下書きします。",
    "pop.tag":"ユーザー", "pop.nav":"↑↓ 移動", "pop.run":"↵ 実行", "pop.esc":"esc",
    "rec.label":"記録中", "rec.steps":"8ステップ", "rec.cancel":"キャンセル", "rec.finish":"完了",
    "trust.byok":"BYOK", "trust.byok.d":"自分のモデルキーを使います。キーはデバイス上で暗号化されたままです。",
    "trust.oss":"オープンソース", "trust.oss.d":"コード、ライセンス、リリース履歴は GitHub で公開されています。",
    "trust.tel":"テレメトリなし", "trust.tel.d":"バックエンドもプロキシもありません。何も私たちを経由しません。",
    "trust.prov":"11プロバイダー", "trust.prov.d":"Claude、GPT、Gemini、DeepSeek、Kimi、StepFun など。",
    "cap.eyebrow":"機能", "cap.title":"Pie が得意なこと。",
    "cap.sub":"大事なのは長いプロンプト欄ではありません。ページ文脈、ツール、スキル、データ出力、理解しやすいプライバシー既定値を備えたブラウザエージェントです。",
    "cap.1":"エージェント作業", "cap.1d":"Pie は複数ステップのタスクを計画し、読み取り、クリック、入力、検索、スクロール、タブ、PDF、ページエディタ向けのブラウザツールを使います。",
    "cap.2":"ページ内容", "cap.2d":"今見ているページについて質問できます。長いページ、アプリ画面、PDF、表、選択テキスト、開いているタブの内容を読めます。",
    "cap.3":"データ処理", "cap.3d":"フィールド抽出、項目比較、ページ内容の表への整形を行い、CSV、JSON、Markdown、テキストファイルとしてダウンロードできます。",
    "cap.4":"スキル", "cap.4d":"繰り返し可能な作業をスラッシュコマンドとして保存します。一度記録すれば、細かい手順を毎回説明せずに再実行できます。",
    "cap.5":"Web 自動化", "cap.5d":"フォーム入力、調査の収集、タブ間の移動、複雑な Web アプリ操作など、退屈なブラウザ作業に使えます。",
    "cap.6":"セキュリティ & プライバシー", "cap.6d":"自分のキーを使い、秘密情報をローカルで暗号化し、Pie 運営のバックエンドを避け、信頼できないページ内容を隔離します。",
    "project.eyebrow":"オープンプロジェクト", "project.title":"最初から透明。",
    "project.sub":"Pie はオープンに開発されています。インストールやアップグレードの前に、ライセンス、リリースノート、過去バージョンを確認できます。",
    "project.license.k":"ライセンス", "project.license.t":"Apache-2.0", "project.license.d":"明示的な特許許諾を含む、寛容なオープンソースライセンスです。",
    "project.latest.k":"最新ノート", "project.latest.t":"v1.0.0", "project.latest.d":"Pie 初の安定メジャー版。長期タスク向けツール、再構築されたストレージ層、刷新されたサイドパネルを含みます。",
    "project.history.k":"バージョン履歴", "project.history.t":"すべてのリリース", "project.history.d":"タグ、アセット、過去のノートを GitHub で直接確認できます。",
    "version.100":"初の安定メジャー版: 長期タスクメモリ、新しいストレージ基盤、刷新されたサイドパネル。",
    "version.0195":"モデルピッカー、ページエディタの読み書き、中断後の再開。",
    "version.0192":"大きなページの読み取り、検索、記録の再現性、固定タブの安全性を改善。",
    "version.0190":"Kimi プロバイダー、thinking 表示、search_page、モデル別属性。",
    "cta.eyebrow":"はじめる", "cta.title":"ブラウザに仕事を任せよう",
    "cta.sub":"Pie をインストールし、タスクを説明すれば、残りの手順は Pie が処理します。",
    "cta.install":"Chrome に追加", "cta.star":"GitHub で Star", "cta.meta":"Chrome · Manifest V3 · v1.0.0",
    "foot.tagline":"ブラウザで動くオープンな AI エージェント。",
    "foot.privacy":"プライバシー", "foot.license":"ライセンス", "foot.release":"リリースノート",
    "foot.releases":"バージョン", "foot.roadmap":"ロードマップ", "foot.github":"GitHub", "foot.store":"Chrome Web Store",
    "foot.copy":"© 2026 Pie · オープンソース · Apache-2.0", "foot.made":"Chrome 向け",
  },
  "pt-BR": {
    "nav.install":"Adicionar ao Chrome", "nav.star":"Star",
    "hero.eyebrow":"IA no seu navegador",
    "hero.title":"Diga ao navegador o que fazer.",
    "hero.sub":"Pie é um agente de navegador aberto que lê páginas, opera sites, transforma conteúdo bagunçado em dados úteis e repete seus fluxos como habilidades, tudo com sua própria chave de modelo.",
    "hero.cta":"Adicionar ao Chrome", "hero.star":"Star no GitHub",
    "hero.micro":"Open source  ·  BYOK  ·  Sem telemetria",
    "panel.title":"Resumir página",
    "panel.user":"Resuma esta página em 3 pontos",
    "panel.done":"Concluído · 3 etapas",
    "panel.b1":"Entende a página atual sem pedir que você copie texto de um lado para outro.",
    "panel.b2":"Usa ferramentas do navegador para clicar, digitar, buscar, ler e mover-se entre abas.",
    "panel.b3":"Transforma trabalho repetido em habilidades reutilizáveis que você pode rodar de novo.",
    "panel.input":"Pergunte ou descreva uma tarefa…",
    "tour.eyebrow":"Como funciona", "tour.title":"Diga isto. Receba aquilo.",
    "tour.sub":"Sem scripts, sem ritual de configuração. Peça o resultado; Pie lê a página, escolhe as ferramentas certas e percorre as etapas.",
    "you":"Você diz",
    "s1.tag":"· PÁGINA & PDF Q&A", "s1.cmd":"“Qual é a política de reembolso nesta página?”",
    "s1.out":"Pergunte qualquer coisa sobre a página atual, uma tela longa de app ou um PDF. Pie extrai o conteúdo relevante para você não precisar copiar, colar ou vasculhar o DOM.",
    "s1.done":"Concluído · 2 etapas",
    "s1.ans":"Reembolsos são aceitos em até 30 dias após a entrega. Itens abertos se qualificam apenas se o lacre original estiver intacto, e custos de envio não são reembolsáveis.",
    "s2.tag":"· EXTRAÇÃO DE DADOS", "s2.cmd":"“Pegue o preço de cada uma destas abas e coloque em uma tabela.”",
    "s2.out":"Pie pode coletar fatos estruturados de páginas, compará-los, limpá-los e devolver uma tabela ou arquivo quando a resposta precisa de mais que texto simples.",
    "s2.done":"Concluído · 6 etapas", "s2.colA":"Produto", "s2.colB":"Preço",
    "s3.tag":"· HABILIDADES & AUTOMAÇÃO", "s3.cmd":"“Isso é difícil de explicar; vou mostrar uma vez.”",
    "s3.out":"Alguns fluxos são mais fáceis de demonstrar. Faça uma vez e Pie salva como habilidade; depois executa a rotina inteira com um único /comando, limitado às ferramentas necessárias.",
    "pop.count":"2 habilidades",
    "pop.d1":"Reúne as abas abertas desta semana e resume cada uma.",
    "pop.d2":"Rascunha uma nota de standup a partir das abas e docs de ontem.",
    "pop.tag":"Usuário", "pop.nav":"↑↓ navegar", "pop.run":"↵ executar", "pop.esc":"esc",
    "rec.label":"GRAVANDO", "rec.steps":"8 ETAPAS", "rec.cancel":"Cancelar", "rec.finish":"Concluir",
    "trust.byok":"BYOK", "trust.byok.d":"Use sua própria chave de modelo. Ela fica criptografada no seu dispositivo.",
    "trust.oss":"Open source", "trust.oss.d":"Código, licença e histórico de versões são públicos no GitHub.",
    "trust.tel":"Sem telemetria", "trust.tel.d":"Sem backend, sem proxy. Nada passa por nós.",
    "trust.prov":"11 provedores", "trust.prov.d":"Claude, GPT, Gemini, DeepSeek, Kimi, StepFun e mais.",
    "cap.eyebrow":"Capacidades", "cap.title":"No que Pie é bom.",
    "cap.sub":"O ponto principal não é uma caixa de prompt mais longa. É um agente de navegador com contexto de página, ferramentas, habilidades, saída de dados e padrões de privacidade que você entende.",
    "cap.1":"Trabalho de agente", "cap.1d":"Pie planeja tarefas de várias etapas e usa ferramentas do navegador para ler, clicar, digitar, buscar, rolar, lidar com abas, PDFs e editores de página.",
    "cap.2":"Conteúdo da página", "cap.2d":"Pergunte sobre a página em que você está. Pie lê páginas longas, telas de apps, PDFs, tabelas, texto selecionado e conteúdo de abas abertas.",
    "cap.3":"Processamento de dados", "cap.3d":"Extraia campos, compare itens, reorganize conteúdo de páginas em tabelas e gere arquivos CSV, JSON, Markdown ou texto para download.",
    "cap.4":"Habilidades", "cap.4d":"Salve fluxos repetíveis como comandos slash. Grave uma tarefa uma vez e rode novamente sem explicar cada pequeno passo.",
    "cap.5":"Automação web", "cap.5d":"Use para o trabalho chato do navegador: preencher formulários, coletar pesquisa, mover-se entre abas e operar apps web complexos.",
    "cap.6":"Segurança & privacidade", "cap.6d":"Traga sua própria chave, mantenha segredos criptografados localmente, evite backends operados pela Pie e isole conteúdo não confiável das páginas.",
    "project.eyebrow":"Projeto aberto", "project.title":"Transparente por padrão.",
    "project.sub":"Pie é desenvolvido em aberto. Licença, notas de versão e versões históricas são fáceis de inspecionar antes de instalar ou atualizar.",
    "project.license.k":"Licença", "project.license.t":"Apache-2.0", "project.license.d":"Uma licença open source permissiva com concessão explícita de patente.",
    "project.latest.k":"Notas recentes", "project.latest.t":"v1.0.0", "project.latest.d":"O primeiro major estável do Pie: ferramentas para tarefas longas, camada de armazenamento reconstruída e painel lateral redesenhado.",
    "project.history.k":"Histórico de versões", "project.history.t":"Todos os releases", "project.history.d":"Veja tags, assets e notas antigas diretamente no GitHub.",
    "version.100":"Primeiro major estável: memória para tarefas longas, nova base de armazenamento e painel lateral redesenhado.",
    "version.0195":"Seletor de modelo, leitura/escrita em editor na página e retomada após abortar.",
    "version.0192":"Melhor leitura de páginas grandes, busca, fidelidade de gravação e segurança em abas fixadas.",
    "version.0190":"Provedor Kimi, exibição de thinking, search_page e atributos por modelo.",
    "cta.eyebrow":"Comece", "cta.title":"Coloque seu navegador para trabalhar",
    "cta.sub":"Instale Pie, descreva uma tarefa e deixe que ele cuide das etapas.",
    "cta.install":"Adicionar ao Chrome", "cta.star":"Star no GitHub", "cta.meta":"Chrome · Manifest V3 · v1.0.0",
    "foot.tagline":"Um agente de IA aberto que vive no seu navegador.",
    "foot.privacy":"Privacidade", "foot.license":"Licença", "foot.release":"Notas de versão",
    "foot.releases":"Versões", "foot.roadmap":"Roadmap", "foot.github":"GitHub", "foot.store":"Chrome Web Store",
    "foot.copy":"© 2026 Pie · Open source · Apache-2.0", "foot.made":"Feito para Chrome",
  },
};

// 外链常量（实施时确认）
const LINKS = {
  store:"https://chromewebstore.google.com/detail/pie-%C2%B7-open-source-ai-agen/gpccjhdgjkmalnepmeclooflliiocfed",
  github:"https://github.com/WiseriaAI/pie-ai-agent",
  privacy:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/PRIVACY.md",
  license:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/LICENSE",
  changelog:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/CHANGELOG.md",
  releases:"https://github.com/WiseriaAI/pie-ai-agent/releases",
  releaseLatest:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/docs/release-notes/v1.0.0.md",
  release100:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/docs/release-notes/v1.0.0.md",
  release0195:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/docs/release-notes/v0.19.5.md",
  release0192:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/docs/release-notes/v0.19.2.md",
  release0190:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/docs/release-notes/v0.19.0.md",
  roadmap:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/docs/ROADMAP.md",
  arch:"https://github.com/WiseriaAI/pie-ai-agent/blob/main/docs/ARCHITECTURE.md",
};

// ── i18n apply ───────────────────────────────────────────────────────
let langTransitionTimers = [];

function normalizedLang(lang) {
  if (lang === "zh" || lang === "zh-CN") return "zh";
  if (lang === "es-419") return "es-419";
  if (lang === "ja") return "ja";
  if (lang === "pt-BR") return "pt-BR";
  return "en";
}

function currentLang() {
  const lang = document.documentElement.lang;
  if (lang === "zh-CN") return "zh";
  if (lang === "es-419" || lang === "ja" || lang === "pt-BR") return lang;
  return "en";
}

function clearLangTransition() {
  langTransitionTimers.forEach(timer => clearTimeout(timer));
  langTransitionTimers = [];
  document.documentElement.classList.remove("lang-animating", "lang-fade-out", "lang-fade-in");
}

function setLangContent(lang, options = {}) {
  lang = normalizedLang(lang);
  const persist = options.persist !== false;
  const dict = I18N[lang] || I18N.en;
  document.documentElement.lang =
    lang === "zh" ? "zh-CN" :
    lang === "es-419" ? "es-419" :
    lang === "ja" ? "ja" :
    lang === "pt-BR" ? "pt-BR" :
    "en";
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const v = dict[el.dataset.i18n]; if (v != null) el.textContent = v;
  });
  document.querySelectorAll("[data-i18n-attr]").forEach(el => {
    el.dataset.i18nAttr.split(",").forEach(pair => {
      const [attr, key] = pair.split(":"); const v = dict[key];
      if (v != null) el.setAttribute(attr, v);
    });
  });
  document.querySelectorAll("[data-lang-option]").forEach(option => {
    const active = option.dataset.langOption === lang;
    if (option.tagName === "BUTTON") {
      option.setAttribute("aria-pressed", String(active));
    }
    if (active) {
      option.setAttribute("aria-current", "page");
    } else {
      option.removeAttribute("aria-current");
    }
  });
  if (persist) {
    try { localStorage.setItem("pie-lang", lang); } catch {}
  }
}

function applyLang(lang, options = {}) {
  const nextLang = normalizedLang(lang);
  const persist = options.persist !== false;
  const reduceMotion = typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  const shouldAnimate = Boolean(options.animate) && nextLang !== currentLang() && !reduceMotion;

  clearLangTransition();

  if (!shouldAnimate) {
    setLangContent(nextLang, { persist });
    return;
  }

  document.documentElement.classList.add("lang-animating", "lang-fade-out");
  langTransitionTimers.push(setTimeout(() => {
    setLangContent(nextLang, { persist });
    document.documentElement.classList.remove("lang-fade-out");
    document.documentElement.classList.add("lang-fade-in");
    langTransitionTimers.push(setTimeout(() => {
      document.documentElement.classList.remove("lang-animating", "lang-fade-in");
    }, 240));
  }, 150));
}

function initLang() {
  let initialLang = "en";
  const firstPath = location.pathname.split("/").filter(Boolean)[0];
  if (["es-419", "ja", "pt-BR"].includes(firstPath)) {
    initialLang = firstPath;
  }
  applyLang(initialLang, { persist: false });
  const toggle = document.querySelector("[data-lang-toggle]");
  const panel = document.querySelector("[data-lang-panel]");
  const closeMenu = () => {
    if (!toggle || !panel) return;
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  };
  toggle?.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = panel?.hidden !== false;
    if (panel) panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  });
  panel?.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });
  document.querySelectorAll("[data-lang-btn]").forEach(b =>
    b.addEventListener("click", () => {
      applyLang(b.dataset.langBtn, { animate: true });
      closeMenu();
    }));
}

// ── scroll reveal (scenario rows slide in L/R; other blocks fade up) ──────
function initReveal() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!("IntersectionObserver" in window)) return;
  document.documentElement.classList.add("js-reveal");
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    });
  }, { threshold: 0.18, rootMargin: "0px 0px -10% 0px" });
  document.querySelectorAll(".srow, .reveal-up").forEach(el => io.observe(el));
}

// ── cursor spotlight (only motion effect; off for reduced-motion / touch) ──
function initSpotlight() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (matchMedia("(hover: none)").matches) return;
  document.querySelectorAll(".dotgrid, .dotgrid-dark").forEach(sec => {
    sec.classList.add("spotlight");
    sec.addEventListener("pointermove", e => {
      const r = sec.getBoundingClientRect();
      sec.style.setProperty("--mx", (e.clientX - r.left) + "px");
      sec.style.setProperty("--my", (e.clientY - r.top) + "px");
    });
    sec.addEventListener("pointerleave", () => {
      sec.style.setProperty("--mx", "-999px"); sec.style.setProperty("--my", "-999px");
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-href]").forEach(a => {
    const u = LINKS[a.dataset.href]; if (u) { a.href = u; a.target = "_blank"; a.rel = "noopener"; }
  });
  initLang();
  initReveal();
  initSpotlight();
  // 可选：拉取 GitHub star 数（失败静默）
  fetch("https://api.github.com/repos/WiseriaAI/pie-ai-agent")
    .then(r => r.ok ? r.json() : null)
    .then(d => { if (d && typeof d.stargazers_count === "number") {
      const el = document.getElementById("gh-stars");
      el.textContent = d.stargazers_count >= 1000 ? (d.stargazers_count/1000).toFixed(1)+"k" : String(d.stargazers_count);
      el.hidden = false;
    }}).catch(()=>{});
});
