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
  errors: {
    connectBackgroundFailedRetry: "Unable to reach the background service. Please retry.",
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
  chat: {
    recording: {
      createSkillFromRecording: "📼 Create skill from recording: {input}",
      createSkillFromRecordingWithStep: "📼 Create skill from recording ({stepCount} steps)",
      sendHint: "Send → the LLM will call create_skill_from_recording.\n\nPreview (first 200 chars)...",
      composeHint: "Write a prompt → Send to let the LLM create the skill",
    },
    attachment: {
      imagePlaceholderTitle: "Images are not persisted — released after switching sessions or SW restart",
      imageReleasedBadge: "[Image released] {width}×{height}",
    },
  },
  modelDropdown: {
    selectModelPlaceholder: "(select model)",
    notFetched: "not fetched",
    fetching: "fetching...",
    refresh: "↻ refresh",
    searchPlaceholder: "Search {count} models...",
    noMatch: "no match ({count} total)",
    emptyUseAdd: "(empty — use + to add custom)",
    addCustomModel: "+ add custom model",
  },
  newConfigWizard: {
    step1Title: "STEP 1 — SELECT PROVIDER",
    changeProvider: "← change provider",
  },
  agentStep: {
    callingToolPrefix: "Calling",
    collapse: "Collapse",
    expand: "Details",
  },
  quoteChip: {
    removeQuote: "Remove quote",
    screenshotUnavailable: "[Screenshot unavailable]",
  },
  instanceSelector: {
    newConfigOrManage: "+ New config / Manage configs",
  },
  skills: {
    empty: {
      cta: "Displays reusable workflows (skills). Underlying tools auto-resolve from the prompt.",
    },
    section: {
      yours: {
        title: "YOURS",
        subtitleEditable: "{count} · editable",
      },
    },
  },
} as const satisfies DictNode;

export type EnDict = typeof enDict;
