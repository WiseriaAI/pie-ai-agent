/**
 * Recording v1 — 类型定义。RecordingSession 是 SW in-memory 状态，
 * **绝不**写入 chrome.storage（spec invariant；Unit 8 build-time grep gate
 * 验证）。
 */

export type RecordedActionType =
  | "click"
  | "type"
  | "select"
  | "scroll"
  | "navigate"
  | "submit"
  | "keypress";

/** 目标元素的种类码（语言中立枚举）。渲染/序列化时经字典查词，不烤进采集数据。 */
export type TargetKindKey =
  | "button" | "link" | "tab" | "checkbox" | "radio" | "switch"
  | "menuitem" | "option" | "input" | "textarea" | "dropdown"
  | "summary" | "element" | "editor";

/** 元素所在区域码（语言中立枚举）。 */
export type RegionKey = "main" | "nav" | "header" | "footer" | "aside" | "other";

/**
 * 结构化目标描述 —— 取代旧的烤进采集数据的自然语言 label。**只含结构码 + 页面
 * 原文**（name/value 是页面文本，已 sanitize；kindKey/regionKey 是枚举码）。任何
 * 自然语言词（"按钮" / "第 3 个" / "导航区"）都在渲染层（RecordingMode.tsx，随 UI
 * locale）与序列化层（serialize.ts，固定英文 scaffold）组装，不在此。
 */
export interface RecordedTarget {
  kindKey: TargetKindKey;
  /** aria/text/(placeholder='..')/(name='..') 主标识，已 sanitize；括号形态语言中立、保留。 */
  name?: string;
  /** 无 name 时的兜底序号（1-based），与 regionKey 联用。 */
  nth?: number;
  regionKey?: RegionKey;
  /** kindKey==="editor" 时的引擎名："Monaco" | "CodeMirror" | "TinyMCE" | "editor"。 */
  editorEngine?: string;
}

/**
 * 一条用户操作记录。capture 在用户每次操作时构造，发回 SW。所有字段都已经过
 * sanitize（控制字符已剥；wrapper 标签已 escape；redacted 时 value 已替换为
 * placeholder 名）。
 */
export interface RecordedAction {
  type: RecordedActionType;
  /** 结构化目标（click/type/select/submit 带；navigate/keypress/scroll 无）。
   *  serialize.ts / RecordingMode.tsx 据此在各自语言层组装步骤描述。 */
  target?: RecordedTarget;
  /** 可选 CSS selector hint。仅当存在强标识（data-testid / id / name）时附加；
   *  弱标识或敏感字段不附加。供 LLM 在 promptTemplate 里作为 fallback 使用。 */
  selectorHint?: string;
  /** type / select 的值。redacted=true 时此字段被替换为 placeholderName 字面量。 */
  value?: string;
  /** 是否被 redact。true 表示 value 已替换为 placeholder 名（不是原值）。 */
  redacted?: boolean;
  /** redact 后的 placeholder 名（"password" / "cc_number" / "verification_code"）。 */
  placeholderName?: string;
  /** action 时所在 URL（origin tracking）。 */
  url: string;
  /** scroll 方向码（语言中立）。仅 type==="scroll" 时出现；value 存 |delta| px。 */
  direction?: "down" | "up";
  /** 该 action 是否被 selector 算法标记为不稳定（fallback 到 nth-of-type）。
   *  serialize 在该 step 的 promptTemplate 加 [possibly unstable] 警告。 */
  unstable?: boolean;
  /** checkbox/radio/switch 勾选后的最终状态。仅 type==="click" 且目标是可勾选
   *  元素时出现；serialize 据此渲染「勾选/取消勾选」。 */
  checked?: boolean;
  /** 点击目标落在弹出菜单/下拉容器内（role=menu/listbox/menuitem/option…）。
   *  serialize 据此追加"回放前可能需先悬停/点击触发器展开"的提示——因为这类项
   *  在回放快照里常不可见或无 data-pie-idx，LLM 需先揭示才能操作。 */
  fromPopup?: boolean;
  /** v1.1 cross-tab —— 该 action 发生在流程标签页集合里的哪个标签页（内部 key，
   *  按标签页出现顺序分配，0=起始页）。单标签页录制时省略。运行期不靠它（会漂），
   *  仅供 serialize 推断 spawn/switch 转换。 */
  tabRef?: number;
  timestamp: number;
}

/**
 * v1.1 cross-tab —— tabRef → 标签页身份。origin 作运行期匹配 hint，firstUrl 仅可读。
 * 由 recording-orchestrator 在标签页首次 commit 时填充；serialize 作"本流程用到哪些
 * 标签页"的清单参考（逐步精确 origin 取自每条 action 自带的 url，见 serialize.ts）。
 */
export type TabRegistry = Record<number, { origin: string; firstUrl: string }>;

/**
 * 录制会话。**仅活在 SW 内存里**。SW restart / panel disconnect / session 切换
 * 任一发生 → recordingSessions Map 丢失 → 自动 abort。
 *
 * Build-time invariant：本类型**绝不**作为 chrome.storage.local.set payload
 * 出现（Unit 8 grep gate）。
 */
export interface RecordingSession {
  /** 绑定到 active sessionId（M3 multi-session sandbox）。 */
  sessionId: string;
  /** 起始标签页。v1.1 起它只是流程集合的种子 + recording-started 广播展示用；
   *  录制逻辑改用下面的流程集合判定归属。 */
  tabId: number;
  /** 起始 origin。惰性：仅 recording-started 广播展示用，录制逻辑不读它。 */
  origin: string;
  startedAt: number;
  /** v1.1 cross-tab —— 流程标签页集合：tabId → tabRef（出现顺序，0=起始页）。 */
  tabRefByTabId: Map<number, number>;
  /** 下一个待分配的 tabRef。 */
  nextTabRef: number;
  /** tabRef → 标签页身份。标签页首次 commit 时填充。 */
  tabRegistry: TabRegistry;
  actions: RecordedAction[];
}

/**
 * Capture → SW 消息载荷的子集（capture 端构造时还没有 sessionId / tabId 等
 * 上下文；SW orchestrator 据 sender.tab.id 关联到 RecordingSession 后填充剩余
 * 字段写入 actions[]）。
 */
export interface CapturedActionPayload {
  type: RecordedActionType;
  target?: RecordedTarget;
  selectorHint?: string;
  value?: string;
  redacted?: boolean;
  placeholderName?: string;
  url: string;
  direction?: "down" | "up";
  unstable?: boolean;
  checked?: boolean;
  fromPopup?: boolean;
}
