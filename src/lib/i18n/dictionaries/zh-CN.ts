import type { EnDict } from "./en";

// `satisfies EnDict` enforces that the shape matches en exactly: missing keys
// or wrong-typed values = compile error. Cannot use direct `: EnDict` because
// that loses literal types for the resolver.
export const zhCNDict = {
  common: {
    cancel: "取消",
    save: "保存",
    confirm: "确认",
    delete: "删除",
    refresh: "刷新",
    back: "返回",
    copy: "复制",
    copyFailed: "复制失败",
  },
  errors: {
    connectBackgroundFailedRetry: "无法连接到后台服务，请重试",
  },
  settings: {
    language: {
      sectionTitle: "语言",
      label: "界面语言",
      optionAuto: "自动（跟随浏览器）",
      optionEn: "English",
      optionZhCN: "中文（简体）",
    },
    myConfigs: {
      title: "我的配置",
      countSuffix: "条配置",
      newConfigButton: "+ 新建配置",
    },
  },
  chat: {
    recording: {
      createSkillFromRecording: "📼 从录制创建 skill：{input}",
      createSkillFromRecordingWithStep: "📼 从录制创建 skill（{stepCount} 步）",
      sendHint: "Send → 由 LLM 调 create_skill_from_recording 创建 skill\n\n预览（前 200 字）...",
      composeHint: "写提示 → Send 让 LLM 创建 skill",
    },
    attachment: {
      imagePlaceholderTitle: "图片不持久化存储 — 切换会话或重启 SW 后释放",
      imageReleasedBadge: "[图已释放] {width}×{height}",
    },
  },
  modelDropdown: {
    selectModelPlaceholder: "(选择模型)",
    notFetched: "未拉取",
    fetching: "拉取中…",
    refresh: "↻ 刷新",
    searchPlaceholder: "搜索 {count} 个模型…",
    noMatch: "无匹配 ({count} total)",
    emptyUseAdd: "(空 — 用 + 添加自定义)",
    addCustomModel: "+ 添加自定义模型",
  },
  newConfigWizard: {
    step1Title: "STEP 1 — 选 PROVIDER",
    changeProvider: "← 改 provider",
  },
  agentStep: {
    callingToolPrefix: "正在调用",
    collapse: "收起",
    expand: "详情",
  },
  quoteChip: {
    removeQuote: "移除引用",
    screenshotUnavailable: "[截图不可用]",
  },
  instanceSelector: {
    newConfigOrManage: "+ 新建配置 / 管理配置",
  },
  skills: {
    empty: {
      cta: "显示可复用工作流（skill）。底层工具按 prompt 自动 resolve。",
    },
    section: {
      yours: {
        title: "YOURS",
        subtitleEditable: "{count} · editable",
      },
    },
  },
} as const satisfies EnDict;
