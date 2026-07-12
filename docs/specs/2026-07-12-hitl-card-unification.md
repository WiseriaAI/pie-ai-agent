# HITL 卡片体系统一 + 本地打通设置区精修（issue #270）

- 日期：2026-07-12
- 状态：定稿（brainstorming + Paper 原型产出，用户已逐节确认）
- 原型：Paper「Pie Frontend」文件，`P7 —` 前缀五块板（SkillGrant 新旧对比 / 五卡统一骨架 / Chat 内联位置 / Settings 本地打通精修 / Skills 列表授权控制集成）
- 前置：#184 内联模型卡范式（PR #195，`hitl-panel-request` 原语）、Slice 3（PR #266，skill-grant 卡 + grants 设置区）

## 1. 背景与目标

五张 HITL 卡（cdp-consent / local-file / run-local-agent / handoff-to-agent / skill-grant）目前渲染在 Chat.tsx 消息列表与 Composer 之间的固定槽位，悬在输入框上方、与对话脱节；且五张卡样式同构地整卡染 warning 色，视觉过重。设置页「本地打通」区块 agent 行无品牌图标、grants/audit 平铺拉长卡片。

目标：五张卡全部迁入消息流内联（#184 范式），统一到共享卡骨架，warning 从"整卡染色"降级为"语义强调"；设置区收敛为固定高度的主卡 + 卡内管理子视图；grants 控制迁入 skill 列表行。`hitl-panel-request` 原语（SW 挂起 → 卡裁决 → resolve）零改动——这是纯 panel 渲染层工程。

## 2. 已拍板的决策

| 决策点 | 结论 |
|---|---|
| 内联范围 | **五张全内联**：消息流尾部（滚动区内）、AnimatePresence 进出场；Composer 上方固定槽位的 HITL 分支整体删除 |
| 决议留痕 | **瞬态，不留痕**：应答即退场，会话史零痕迹（与 #184 一致，零持久化改动）；授权事实源 = grants |
| 卡骨架 | 共享 `HitlCardShell`：中性卡（surface 底 + line 边框 + 10px 圆角）→ 卡头（14px 语义图标 + mono caps 标签）→ 15px semibold 标题 + 12px 描述 → 内容区 → 右对齐主次按钮 |
| 双色语义分档 | **本机执行**三张（skill-grant / run-local-agent / handoff）图标 + caps 标签 + 主按钮用 `warning` 珊瑚；**浏览器域**两张（local-file / cdp-consent）用 `accent` 冷蓝灰。主按钮是整卡唯一浓色块 |
| 工具名 | 卡头**不显示**内部工具名（`run_skill_script` 等一律不露出） |
| grants 控制入口 | 迁入 **SkillsList**：有 grant 的 skill 行显示「脚本已授权」pill + 行尾「撤销授权」动作；「本地打通」区不再放 grants 平行列表 |
| audit 展示 | **panel 展示整体移除**（查询 + 渲染都删）；daemon 侧 `list_audit` RPC 与 `audit.jsonl` 不动 |
| 设置 agent 区 | 主卡只列**已启用** agent（纯展示行，无开关）+「Agent 管理 ›」入口；点入**卡内子视图**（返回行 + 全量检测列表 + 启用开关），只替换卡片内容，不做整页覆盖 |
| 品牌图标 | inline SVG（MV3 CSP 禁外链），按 `AGENT_CANDIDATES` id **前缀**键控：`claude-*` → Claude 星芒 mark（brand 色 `#D97757`）、`codex-*` → Codex 六边形 mark、未知 id → 通用终端图标；HandoffCard 收件人列表与设置区共用同一映射 |
| 按钮尺寸 | 对齐 ScheduleDraftCard 代码事实标准（`px-4 py-2 text-[13px]`），不引入原型里略小的一档 |

## 3. 架构总览

```
usePanelRequest（不动）
   │ active: {requestId, kind, payload}
   ▼
Chat.tsx 消息流尾部（滚动区内，AnimatePresence 包裹）
   ├─ kind === "schedule-model"  → ScheduleDraftCard（现状，不改造）
   ├─ kind === "skill-grant"     → SkillGrantCard      ┐
   ├─ kind === "run-local-agent" → RunLocalAgentCard   ├─ 均基于 HitlCardShell
   ├─ kind === "handoff-to-agent"→ HandoffCard         │   register="local"(warning)
   ├─ kind === "local-file"      → LocalFileRequestCard├─ register="browser"(accent)
   └─ kind === "cdp-consent"     → CdpOnboardingCard   ┘
固定槽位：仅剩 FileAccessCard（非 panel-request，不动）与录制 chip
```

- **WorkingIndicator**：任意 panelRequest 挂起时隐藏（现状只对 `schedule-model` 隐藏，条件改为 `streaming && !panelRequest`）。
- **自动滚动**：panelRequest 出现时消息列表滚到底（把 panelRequest 加入现有 scroll-to-bottom effect 的依赖）。
- **ScheduleDraftCard 不改造**：它已是范式本尊；收编进 shell 属后续可选重构（YAGNI）。
- `local-file` 的隐藏 file input ref 留在 Chat.tsx，卡的「选择文件…」继续触发 `ref.click()`；60s 倒计时行为保留。

## 4. 组件设计

### 4.1 `HitlCardShell`（新，`src/sidepanel/components/hitl/HitlCardShell.tsx`）

```tsx
interface HitlCardShellProps {
  register: "local" | "browser";   // local=warning 珊瑚 / browser=accent 冷蓝灰
  icon: ReactNode;                 // 14px stroke 图标，色随 register
  capsLabel: string;               // 卡头 mono caps 标签（i18n）
  title: string;                   // 15px semibold
  description?: string;           // 12px fg-2
  children?: ReactNode;           // 内容区（明细块 / radio 组 / 备注）
  actions: ReactNode;             // 右对齐按钮组
}
```

- 外壳：`rounded-control border border-line bg-surface p-3.5 flex flex-col gap-3`，`m.div` 进出场（`opacity/y`，`DURATION.base` + `EASE_STANDARD`，与 ScheduleDraftCard 相同参数）；AnimatePresence wrapper 在 Chat.tsx。
- 卡头：`flex items-center gap-2`，图标与 caps 标签同色（`text-warning` / `text-accent`）。
- 主按钮两档：`local` → `bg-warning text-surface border border-warning-line`；`browser` → `bg-accent-strong text-surface border border-accent-line`（= ScheduleDraftCard 主按钮）；次按钮统一 `border border-line text-fg-2`。
- 明细块原语（shell 内导出或同文件小组件）：`rounded-lg border border-line bg-surface-deep px-3 py-2.5`，内部 caps 微标签（`caps text-fg-3`）+ mono 值（`font-mono text-[12px] text-fg-1`）。

### 4.2 五卡内容（改造现有组件为 shell 填充）

| 卡 | register | 图标 | caps 标签 | 标题 / 内容要点 |
|---|---|---|---|---|
| SkillGrantCard | local | 盾形 | SKILL 授权 | 标题模板「{name} 请求在你的电脑上运行脚本」+ 描述；明细块三组：可执行脚本 / 网络访问 / 工作区外写入（空值显示「无」，fg-3）；沙箱免责声明 11px fg-2；按钮 拒绝 / **允许运行** |
| RunLocalAgentCard | local | 终端 | 本地 AGENT | 标题 + semanticsNote；明细块两组：工作目录（mono）/ 任务（原文，Inter）；按钮 拒绝 / **允许运行** |
| HandoffCard | local | 转出箭头 | 交棒授权 | 标题 + semanticsNote；收件人 radio 组（品牌图标 + label，选中行 `bg-accent-tint border-accent-line`，右侧 radio 环）；上下文明细块（mono pre，max-h 滚动，含「随交棒文件：N」）；按钮 取消 / **交棒** |
| LocalFileRequestCard | browser | 文档 | 本地文件 | 标题 + 描述；无内容区；按钮 取消 (Ns) / **选择文件…** |
| CdpOnboardingCard | browser | 光标 | 输入模拟 | 标题 + body1 描述；body2 降为 11px fg-2 备注行；按钮 不启用 / **启用** |

### 4.3 `AgentBrandIcon`（新，`src/sidepanel/components/hitl/agent-brand-icons.tsx`）

```tsx
export function AgentBrandIcon({ agentId, size = 14 }: { agentId: string; size?: number }): JSX.Element
```

- `agentId.startsWith("claude")` → Claude 星芒 mark，stroke `#D97757`（brand 色硬编码，不进 theme token——品牌色不随主题翻转）；`agentId.startsWith("codex")` → Codex 六边形 mark，stroke `currentColor`；其余 → 通用终端图标，stroke `currentColor`。
- 原型里的 mark 是近似画法；实现时用官方 simplified 单色 SVG path 内联，viewBox 24。
- 消费方：HandoffCard 收件人行（16px 裸图标）、LocalBridgeSection agent 行（26px `rounded-chip bg-field` tile 内 14px 图标）。

### 4.4 Chat.tsx 接线

- 固定槽位五个 `panelRequest?.kind === …` 分支删除（`FileAccessCard`、`pendingRecording` chip 保留）。
- 消息流尾部现有 `<AnimatePresence>`（schedule-model 处）扩展为对全部 kind 的 switch；`key={panelRequest.requestId}` 保证换请求时重挂载。
- `WorkingIndicator` 条件：`streaming && !panelRequest`。
- scroll-to-bottom effect 依赖加入 `panelRequest?.requestId`。

### 4.5 LocalBridgeSection（Settings.tsx）

- 本地状态 `view: "main" | "agents"`，两视图共用外层卡容器，切换只替换卡内容（配 Collapse/SmoothHeight 原语做高度过渡）。
- **main**：开关 + 描述 + 状态行（`已连接` 前加 6px `bg-success` 圆点；未连接沿用现文案无点）→ 分隔线 → caps 标签「本地 AGENT · 已启用」→ 已启用 agent 展示行（26px 图标 tile + 名称 13px fg-1 + kind 副标 11px fg-3，无开关）→「Agent 管理 ›」入口（`border border-line rounded-lg` 整宽按钮）。无已启用 agent 时列表区不渲染，只剩入口。
- **agents（管理子视图）**：返回行（‹ chevron + 「Agent 管理」）→ 全量检测列表（含未安装行：图标与文字灰化、副标「Terminal · 未安装」、开关 disabled）+ 启用开关（复用现 `onAgentToggle`）。
- 删除：`queryGrants` / `queryAudit` 调用、grants 区、audit 折叠区及相关 state。
- agent 行文案：名称与 kind 拆分。现状 `ListAgentsResult.agents[]`（`src/types/local-bridge.ts`）只有 `{id, label, installed}`——wire **加法**补 `kind?: "app" | "terminal"`（daemon 从 `AGENT_CANDIDATES` 透出一行改动，optional，PROTOCOL_VERSION 不动），SW `local-agents:list` 响应透传，panel 据此拆「名称 + kind 副标」两行；旧 daemon 缺该字段时回退为整串 `label` 单行显示（兼容矩阵不炸）。

### 4.6 SkillsList grants 集成

- daemon 桥 ready 时查 grants，按 `grantRecord.skillName === skillEntry.name` 关联；`local-grants:list` / `local-grants:revoke` 查询与撤销助手从 Settings.tsx 抽到 `src/lib/local-grants.ts`（迁移后仅 SkillsList 消费，Settings 不再引用）。
- 有 grant 的行：meta 行前插「脚本已授权」pill（绿盾 10px 图标 + 11px 文案，`rounded-full border border-line bg-surface-deep px-2 py-0.5`）；行尾动作区（编辑/删除同排）前插「撤销授权」文本按钮 → `local-grants:revoke` → 成功后重查刷新。
- 无 grant / daemon-off（IDB 模式）：行完全不变，零查询。
- 孤儿 grant（skill 已删、grant 残留）在列表里自然不可见：无 skill 即无法执行，无危害；档案清理归 #273 sweep 管辖。

### 4.7 i18n（六字典 parity：en / zh-CN / zh-TW / ja / es-419 / pt-BR）

新增 key（zh-CN 文案为准，其余语言各自翻译）：
- 五卡 caps 标签：`hitl.caps.skillGrant`「SKILL 授权」/ `hitl.caps.runLocalAgent`「本地 AGENT」/ `hitl.caps.handoff`「交棒授权」/ `hitl.caps.localFile`「本地文件」/ `hitl.caps.cdp`「输入模拟」
- `skillGrant.title` 改模板：「{name} 请求在你的电脑上运行脚本」（沿用字典现有 `{name}` 占位符模式）；`skillGrant.allow` → 「允许运行」；`runLocalAgent.allow` → 「允许运行」；`handoff.targetLabel` → 「收件人」
- `settings.localBridge.agentsEnabledTitle`「本地 Agent · 已启用」/ `settings.localBridge.manageAgents`「Agent 管理」
- `skills.grant.granted`「脚本已授权」/ `skills.grant.revoke`「撤销授权」

删除 key：`settings.localBridge.grantsTitle` / `.revoke` / `.auditTitle` / `.auditOk` / `.auditFailed`（audit/grants 区随之消失）。

## 5. 明暗主题

参考代码与实现一律用 token 类（`text-warning` / `bg-accent-tint` / `bg-surface-deep` …），亮色主题由 token 体系自动生效——附录 JSX 里的 hex 是 Paper 暗色板的原始值，**实现时必须替换为对应 token 类**（映射表见附录 A0）。真机验收明暗两主题都过。

## 6. 错误处理与边界

- panelRequest 超时 / 带外 resolve（`panel-request-timeout` / `-resolved`）：`usePanelRequest` 已清 state，卡走 AnimatePresence 退场——行为不变，仅位置变化。
- 切 session：`usePanelRequest` 已清卡；内联位置不引入新边角。
- revoke 失败（daemon 掉线等）：pill 与按钮保持原状（重查不成功不变更 UI），无专门错误 UI（下次进入重查）。
- 管理子视图停留时桥断开：`status.ready` 变 false 时强制回 `main` 视图（agent 列表本来就依赖桥）。
- HandoffCard `agents` 为空数组：SW 侧已保证有候选才发卡（现状），panel 不加空态。

## 7. 测试要求（vitest）

- Chat 渲染：五 kind 各自渲染在消息滚动区尾部；固定槽位不再出现任何 panelRequest 卡；`key` 随 requestId 变化重挂载
- WorkingIndicator：任意 kind 挂起时不渲染；无 panelRequest 且 streaming 时渲染
- 决议后：respond 调用 + 卡从 DOM 消失，消息列表无残留节点
- HitlCardShell：两 register 的类名分档（warning / accent）；卡头无工具名文案
- AgentBrandIcon：`claude-*` / `codex-*` / 未知 id 三分支
- HandoffCard：radio 选择 + onDecision(target)（现有测试语义保留，选中行样式断言）
- SkillsList：有 grant 行显示 pill + 撤销授权；点击撤销发 revoke 消息并刷新；无 grant / daemon-off 行不变
- LocalBridgeSection：main 只列 enabled；点管理入口切子视图、返回行切回；桥断开强制回 main；不再发 `local-grants:list`（自身）/ `local-audit:list` 查询
- i18n：六字典键 parity（typecheck 强制）

## 8. 明确不做（YAGNI）

- 不做决议留痕（无新 message role、无持久化）
- 不改造 ScheduleDraftCard（已是范式本尊，收编 shell 属后续可选）
- 不做孤儿 grant 的展示与清理 UI（#273 管辖）
- 不做 per-agent 品牌色主题化；图标仅 Claude / Codex 两个 mark + 通用回退
- 不动 `hitl-panel-request` 原语与既有 wire 语义（`list_audit` RPC 保留，panel 停用）；唯一 wire 改动是 `ListAgentsResult.agents[]` 加法补 `kind?`（见 §4.5）
- 不改造 FileAccessCard（非 panel-request 常驻提示）

## 9. 验收标准（真机）

1. 逐一触发五张卡：都出现在消息流尾部（滚动区内），进出场有动画，决议后消失无残留；挂起期间 WorkingIndicator 隐藏、列表自动滚到底
2. skill-grant / run-local-agent / handoff 呈 warning 珊瑚强调（图标 + caps + 主按钮）；local-file / cdp-consent 呈 accent 冷蓝灰；明暗两主题都协调
3. 任何卡头都看不到 `run_skill_script` 等内部工具名
4. HandoffCard 收件人行有品牌图标，选中态清晰可辨
5. 设置「本地打通」：主卡只列已启用 agent（带品牌图标 tile）；「Agent 管理」子视图卡内切换、可返回；grants / audit 区不存在
6. Skills 列表：已授权 skill 行有「脚本已授权」pill 与「撤销授权」；撤销后 pill 消失，该 skill 下次跑脚本重新弹授权卡
7. `pnpm test` / `pnpm typecheck` / `pnpm build` 全绿

---

## 附录：参考实现代码（Paper design-to-code 导出，已翻译为库内惯例）

> 以下代码从 Paper 定稿板导出后按 A0 映射表翻译为 token 类，是实现参考而非逐字要求；结构、层级、间距、字号为准，类名以库内既有惯例为准。

### A0 · token 映射表（Paper 暗色 hex → 库内类）

| Paper hex / 值 | token 类 |
|---|---|
| `#0B0D10` | `canvas`（实心按钮字色用 `text-surface`，对齐 ScheduleDraftCard） |
| `#14171C` | `surface` |
| `#0E1216` | `surface-deep` |
| `#1A1E25` | `field` |
| `#22272F` | `line` |
| `#E5E8EC` / `#8A929E` / `#525965` | `fg-1` / `fg-2` / `fg-3` |
| `#B8C8D6` | `accent` / `accent-strong` |
| `#C26B5E` | `warning` |
| `rgba(184,200,214,.08/.3)` | `accent-tint` / `accent-line` |
| `rgba(194,107,94,.08/.45)` | `warning-tint` / `warning-line` |
| `#5FA37D` | `success` |
| `#3A4049` | `var(--c-fg-4)`（fg-4 无 Tailwind 类映射，库内惯例直接用 CSS 变量） |
| `#D97757` | Claude brand 色，硬编码于 `agent-brand-icons.tsx` |
| mono 10px/0.16em/uppercase | `.caps` 类 |
| `rounded-[10px]` | `rounded-control` |
| 图标 tile 6px 圆角 | `rounded-chip` |

### A1 · HitlCardShell

```tsx
const REGISTER = {
  local:   { caps: "text-warning", primary: "bg-warning text-surface border border-warning-line" },
  browser: { caps: "text-accent",  primary: "bg-accent-strong text-surface border border-accent-line" },
} as const;

export function HitlCardShell({ register, icon, capsLabel, title, description, children, actions }: HitlCardShellProps) {
  const r = REGISTER[register];
  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: DURATION.base, ease: EASE_STANDARD }}
      className="rounded-control border border-line bg-surface p-3.5 flex flex-col gap-3"
    >
      <div className="flex items-center gap-2">
        <span className={r.caps}>{icon}</span>
        <span className={`caps ${r.caps}`}>{capsLabel}</span>
      </div>
      <div className="flex flex-col gap-[3px]">
        <div className="text-[15px] font-semibold leading-[22px] tracking-[-0.005em] text-fg-1">{title}</div>
        {description && <div className="text-[12px] leading-[18px] text-fg-2">{description}</div>}
      </div>
      {children}
      <div className="flex justify-end gap-2 pt-0.5">{actions}</div>
    </m.div>
  );
}

/** 主/次按钮（尺寸对齐 ScheduleDraftCard 的代码事实标准） */
export function HitlPrimaryButton({ register, ...props }: { register: "local" | "browser" } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`${REGISTER[register].primary} rounded-lg px-4 py-2 text-[13px] font-semibold`} {...props} />;
}
export function HitlSecondaryButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className="border border-line rounded-lg px-4 py-2 text-fg-2 text-[13px] font-medium" {...props} />;
}

/** 明细块：caps 微标签 + 值行 */
export function HitlDetailBlock({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-line bg-surface-deep px-3 py-2.5 flex flex-col gap-2.5">{children}</div>;
}
export function HitlDetailGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="caps text-fg-3">{label}</span>
      {children}
    </div>
  );
}
```

### A2 · SkillGrantCard（warning 档实例）

```tsx
export function SkillGrantCard({ payload, onDecision }: Props) {
  const t = useT();
  return (
    <HitlCardShell
      register="local"
      icon={<ShieldIcon />}                             // 14px stroke-1.7 盾形
      capsLabel={t("hitl.caps.skillGrant")}
      title={t("skillGrant.title", { name: payload.displayName ?? payload.skillName })}
      description={payload.description}
      actions={<>
        <HitlSecondaryButton onClick={() => onDecision(false)}>{t("skillGrant.deny")}</HitlSecondaryButton>
        <HitlPrimaryButton register="local" onClick={() => onDecision(true)}>{t("skillGrant.allow")}</HitlPrimaryButton>
      </>}
    >
      <HitlDetailBlock>
        <HitlDetailGroup label={t("skillGrant.scriptsLabel")}>
          {payload.scripts.map((s) => (
            <span key={s} className="font-mono text-[12px] leading-[18px] text-fg-1">{s}</span>
          ))}
        </HitlDetailGroup>
        <HitlDetailGroup label={t("skillGrant.networkLabel")}>
          {payload.network.length > 0
            ? payload.network.map((d) => <span key={d} className="font-mono text-[12px] leading-[18px] text-fg-1">{d}</span>)
            : <span className="text-[12px] text-fg-3">{t("skillGrant.networkNone")}</span>}
        </HitlDetailGroup>
        {payload.write.length > 0 && (
          <HitlDetailGroup label={t("skillGrant.writeLabel")}>
            {payload.write.map((w) => <span key={w} className="font-mono text-[12px] leading-[18px] text-fg-1">{w}</span>)}
          </HitlDetailGroup>
        )}
      </HitlDetailBlock>
      <div className="text-[11px] leading-[17px] text-fg-2">{t("skillGrant.disclosure")}</div>
    </HitlCardShell>
  );
}
```

### A3 · HandoffCard 收件人 radio 行（品牌图标）

```tsx
<div className="flex flex-col gap-1.5">
  <span className="caps text-fg-3">{t("handoff.targetLabel")}</span>
  {payload.agents.map((a) => {
    const selected = a.id === selectedId;
    return (
      <label
        key={a.id}
        className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 ${
          selected ? "border-accent-line bg-accent-tint" : "border-line"
        }`}
      >
        <input type="radio" name="handoff-target" className="sr-only" checked={selected} onChange={() => setSelectedId(a.id)} />
        <AgentBrandIcon agentId={a.id} size={16} />
        <span className={`text-[13px] ${selected ? "text-fg-1" : "text-fg-2"}`}>{a.label}</span>
        <span
          aria-hidden
          className={`ml-auto h-3.5 w-3.5 shrink-0 rounded-full border ${
            selected ? "border-[4px] border-accent" : "border-[1.5px] border-[var(--c-fg-4)]"
          }`}
        />
      </label>
    );
  })}
</div>
```

### A4 · LocalFileRequestCard（accent 档实例，最小卡）

```tsx
<HitlCardShell
  register="browser"
  icon={<FileIcon />}                                  // 14px stroke-1.7 文档
  capsLabel={t("hitl.caps.localFile")}
  title={t("chat.files.requestTitle")}
  description={t("chat.files.requestBody")}
  actions={<>
    <HitlSecondaryButton onClick={onCancel}>
      {seconds > 0 ? `${t("chat.files.requestCancel")} (${seconds}s)` : t("chat.files.requestCancel")}
    </HitlSecondaryButton>
    <HitlPrimaryButton register="browser" onClick={onChoose}>{t("chat.files.requestChoose")}…</HitlPrimaryButton>
  </>}
/>
```

CdpOnboardingCard 同构：`icon=光标`、`capsLabel=t("hitl.caps.cdp")`、`description=body1`，body2 作为 children 备注行 `<div className="text-[11px] leading-[17px] text-fg-2">`。RunLocalAgentCard 同 A2 结构：明细块两组（工作目录 mono / 任务原文 Inter，`max-h-40 overflow-auto`）。

### A5 · Chat.tsx 尾部接线（形状示意）

```tsx
{streaming && !panelRequest && <WorkingIndicator />}
<AnimatePresence>
  {panelRequest?.kind === "schedule-model" && <ScheduleDraftCard key={panelRequest.requestId} … />}
  {panelRequest?.kind === "skill-grant" && <SkillGrantCard key={panelRequest.requestId} … />}
  {panelRequest?.kind === "run-local-agent" && <RunLocalAgentCard key={panelRequest.requestId} … />}
  {panelRequest?.kind === "handoff-to-agent" && <HandoffCard key={panelRequest.requestId} … />}
  {panelRequest?.kind === "local-file" && <LocalFileRequestCard key={panelRequest.requestId} … />}
  {panelRequest?.kind === "cdp-consent" && <CdpOnboardingCard key={panelRequest.requestId} … />}
</AnimatePresence>
```

### A6 · LocalBridgeSection 主视图（agents 区 + 管理入口）

```tsx
<div className="flex flex-col gap-2.5 border-t border-line pt-3">
  <span className="caps text-fg-3">{t("settings.localBridge.agentsEnabledTitle")}</span>
  {enabledAgents.map((a) => (
    <div key={a.id} className="flex items-center gap-2.5">
      <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-chip bg-field">
        <AgentBrandIcon agentId={a.id} size={14} />
      </span>
      <span className="text-[13px] text-fg-1">{a.name}</span>
      <span className="text-[11px] text-fg-3">{a.kindLabel}</span>
    </div>
  ))}
  <button
    type="button"
    onClick={() => setView("agents")}
    className="flex items-center justify-center gap-1.5 rounded-lg border border-line px-2.5 py-[7px] text-[12px] font-medium text-fg-2 hover:text-fg-1"
  >
    {t("settings.localBridge.manageAgents")}
    <ChevronRightIcon size={11} />
  </button>
</div>
```

管理子视图：返回行 `‹ + 标题`（13px medium fg-1），行结构同上但右侧带 `<Switch>`（未安装行图标/文字灰化、`Switch` disabled）。状态行圆点：`<span className="h-1.5 w-1.5 rounded-full bg-success" />` + 「已连接」12px fg-1。

### A7 · SkillsList 授权行（pill + 动作）

```tsx
{grant && (
  <span className="flex items-center gap-[5px] rounded-full border border-line bg-surface-deep px-2 py-0.5">
    <ShieldCheckIcon size={10} className="text-success" />
    <span className="text-[11px] text-fg-2">{t("skills.grant.granted")}</span>
  </span>
)}
…
{grant && (
  <button type="button" onClick={() => onRevoke(grant.key)} className="text-[12px] text-fg-2 hover:text-fg-1">
    {t("skills.grant.revoke")}
  </button>
)}
```

### A8 · AgentBrandIcon marks（近似 path，实现换官方 simplified 版）

```tsx
// Claude（星芒，brand 色）
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#D97757" strokeWidth="2" strokeLinecap="round" aria-hidden>
  <path d="M12 3v18" /><path d="M3 12h18" /><path d="M5.6 5.6l12.8 12.8" /><path d="M18.4 5.6L5.6 18.4" />
</svg>
// Codex（六边形，随文字色）
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
  <path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5L12 2.5z" /><path d="M12 7.2l4.1 2.4v4.8L12 16.8l-4.1-2.4V9.6L12 7.2z" />
</svg>
```
