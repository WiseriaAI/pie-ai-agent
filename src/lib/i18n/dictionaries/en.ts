import type { DictNode } from "../types";

export const enDict = {
  common: {
    cancel: "Cancel",
    save: "Save",
    confirm: "Confirm",
    delete: "Delete",
    refresh: "Refresh",
    back: "Back",
    copy: "Copy",
    copyFailed: "Copy failed",
  },
  settings: {
    language: {
      sectionTitle: "LANGUAGE",
      label: "UI language",
      optionAuto: "Auto (follow browser)",
      optionEn: "English",
      optionZhCN: "中文 (Simplified Chinese)",
    },
    myConfigs: {
      title: "MY CONFIGS",
      countSuffix: "configs",
      newConfigButton: "+ New config",
    },
  },
} as const satisfies DictNode;

export type EnDict = typeof enDict;
