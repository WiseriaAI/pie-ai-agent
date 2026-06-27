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

/**
 * 一条用户操作记录。capture 在用户每次操作时构造，发回 SW。所有字段都已经过
 * sanitize（控制字符已剥；wrapper 标签已 escape；redacted 时 value 已替换为
 * placeholder 名）。
 */
export interface RecordedAction {
  type: RecordedActionType;
  /** 主标签：人类可读 element 描述。serialize.ts 据此构造步骤句子。
   *  例："按钮 'Submit'" / "输入框 'Email 邮箱'" / "导航区第 3 个链接"。 */
  label: string;
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
  /** capture phase 算出来的 element 所在 region：'main' / 'nav' / 'header' / 'footer' /
   *  'aside' / 'other'。serialize 用于歧义消解。 */
  region: string;
  /** 该 action 是否被 selector 算法标记为不稳定（fallback 到 nth-of-type）。
   *  serialize 在该 step 的 promptTemplate 加 [可能不稳定] 警告。 */
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
  label: string;
  selectorHint?: string;
  value?: string;
  redacted?: boolean;
  placeholderName?: string;
  url: string;
  region: string;
  unstable?: boolean;
  checked?: boolean;
  fromPopup?: boolean;
}
