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
} as const satisfies EnDict;
