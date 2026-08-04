/**
 * 原型参考 — issue #342 新增 i18n 词条六语言参考值（不参与构建）。
 * 落库时按 src/lib/i18n/dictionaries/ 各字典的结构展开，parity 测试会强制
 * 六字典键对齐；非中英语言以母语审校为准，此处为可用的初值。
 */
export const RECORDING_I18N_KEYS = {
  "recording.kind.button": {
    en: "button", "zh-CN": "按钮", "zh-TW": "按鈕",
    ja: "ボタン", "es-419": "botón", "pt-BR": "botão",
  },
  "recording.kind.link": {
    en: "link", "zh-CN": "链接", "zh-TW": "連結",
    ja: "リンク", "es-419": "enlace", "pt-BR": "link",
  },
  "recording.kind.tab": {
    en: "tab", "zh-CN": "标签页", "zh-TW": "分頁",
    ja: "タブ", "es-419": "pestaña", "pt-BR": "aba",
  },
  "recording.kind.checkbox": {
    en: "checkbox", "zh-CN": "复选框", "zh-TW": "核取方塊",
    ja: "チェックボックス", "es-419": "casilla", "pt-BR": "caixa de seleção",
  },
  "recording.kind.radio": {
    en: "radio", "zh-CN": "单选框", "zh-TW": "單選按鈕",
    ja: "ラジオボタン", "es-419": "botón de opción", "pt-BR": "botão de opção",
  },
  "recording.kind.switch": {
    en: "switch", "zh-CN": "开关", "zh-TW": "開關",
    ja: "スイッチ", "es-419": "interruptor", "pt-BR": "interruptor",
  },
  "recording.kind.menuitem": {
    en: "menu item", "zh-CN": "菜单项", "zh-TW": "選單項",
    ja: "メニュー項目", "es-419": "elemento de menú", "pt-BR": "item de menu",
  },
  "recording.kind.option": {
    en: "option", "zh-CN": "下拉选项", "zh-TW": "下拉選項",
    ja: "選択肢", "es-419": "opción", "pt-BR": "opção",
  },
  "recording.kind.input": {
    en: "input", "zh-CN": "输入框", "zh-TW": "輸入框",
    ja: "入力欄", "es-419": "campo", "pt-BR": "campo",
  },
  "recording.kind.textarea": {
    en: "text area", "zh-CN": "文本框", "zh-TW": "文字框",
    ja: "テキストエリア", "es-419": "área de texto", "pt-BR": "área de texto",
  },
  "recording.kind.dropdown": {
    en: "dropdown", "zh-CN": "下拉框", "zh-TW": "下拉選單",
    ja: "ドロップダウン", "es-419": "menú desplegable", "pt-BR": "menu suspenso",
  },
  "recording.kind.summary": {
    en: "disclosure", "zh-CN": "折叠标签", "zh-TW": "摺疊標籤",
    ja: "折りたたみ", "es-419": "plegable", "pt-BR": "expansor",
  },
  "recording.kind.element": {
    en: "element", "zh-CN": "元素", "zh-TW": "元素",
    ja: "要素", "es-419": "elemento", "pt-BR": "elemento",
  },
  "recording.kind.editor": {
    en: "editor", "zh-CN": "编辑器", "zh-TW": "編輯器",
    ja: "エディタ", "es-419": "editor", "pt-BR": "editor",
  },
  "recording.region.main": {
    en: "main", "zh-CN": "主区", "zh-TW": "主區",
    ja: "メイン", "es-419": "principal", "pt-BR": "principal",
  },
  "recording.region.nav": {
    en: "nav", "zh-CN": "导航区", "zh-TW": "導覽區",
    ja: "ナビ", "es-419": "navegación", "pt-BR": "navegação",
  },
  "recording.region.header": {
    en: "header", "zh-CN": "页头", "zh-TW": "頁首",
    ja: "ヘッダー", "es-419": "encabezado", "pt-BR": "cabeçalho",
  },
  "recording.region.footer": {
    en: "footer", "zh-CN": "页脚", "zh-TW": "頁尾",
    ja: "フッター", "es-419": "pie", "pt-BR": "rodapé",
  },
  "recording.region.aside": {
    en: "sidebar", "zh-CN": "侧栏", "zh-TW": "側欄",
    ja: "サイド", "es-419": "lateral", "pt-BR": "lateral",
  },
  "recording.region.other": {
    en: "other", "zh-CN": "其他", "zh-TW": "其他",
    ja: "その他", "es-419": "otra", "pt-BR": "outra",
  },
  "recording.checkedOn": {
    en: "checked", "zh-CN": "勾选", "zh-TW": "勾選",
    ja: "チェック", "es-419": "marcado", "pt-BR": "marcado",
  },
  "recording.checkedOff": {
    en: "unchecked", "zh-CN": "取消勾选", "zh-TW": "取消勾選",
    ja: "チェック解除", "es-419": "desmarcado", "pt-BR": "desmarcado",
  },
} as const;
