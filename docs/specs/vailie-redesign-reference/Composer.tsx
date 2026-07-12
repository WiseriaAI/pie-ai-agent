/**
 * Composer — two forms, per the redesign (G2: expanded = today's composer):
 *
 *   unfocused  CAPSULE   height 52, radius 26 (pill). [+][text][send] ONLY —
 *                        no ModelPicker / ContextRing in this form; each
 *                        button's centre sits on the pill's end circle centre
 *                        (26px in from each edge).
 *   focused    EXPANDED  radius 18 rounded-rect, TWO FULL-WIDTH rows.
 *                        Top: text area (grows with content).
 *                        Bottom: the CURRENT composer action row, unchanged:
 *                        [＋ ToolsMenu(attach/pick-element/record)] ··spacer··
 *                        [ModelPicker chip] [ContextRing] [Send/Stop(+queue)]
 *                        Only the skin changes — functionality and order are
 *                        1:1 with today's Chat.tsx Composer (line ~2160).
 *
 * Transition capsule ↔ expanded: 150ms ease-out (border-radius + layout).
 * Focus feedback = ground lightens + soft blue glow (replaces the focus ring;
 * keyboard focus uses the same treatment). Buttons are bare icons, hover-lit.
 *
 * Send is disabled with no text AND no attachments. While the agent runs, the
 * send icon becomes a stop square and the queue button slides in (existing
 * behaviour). The `/` slash-skill popover behaviour is unchanged.
 */
import { useState, useRef, type ReactNode } from "react";

function PlusIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function SendIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V6M6 12l6-6 6 6" />
    </svg>
  );
}

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  placeholder?: string;
  /** Reference chips / attachments rendered above the field (see 屏N). */
  attachments?: ReactNode;
}

export function Composer({ value, onChange, onSend, placeholder = "问点什么，或描述一个任务…", attachments }: ComposerProps) {
  const [focused, setFocused] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const canSend = value.trim().length > 0; // + attachments in real impl

  // The two forms share the same field/buttons; only the wrapper layout swaps.
  const wrapper =
    "transition-[border-radius,background-color,box-shadow] duration-150 ease-out bg-field " +
    (focused
      ? "rounded-[18px] p-1 flex flex-col bg-surface-deep shadow-[0_6px_24px_rgba(29,107,214,0.10)]"
      : "rounded-[26px] h-[52px] flex items-center");

  return (
    <div className="flex flex-col gap-2">
      {attachments}
      <div
        className={wrapper}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false);
        }}
      >
        {focused ? (
          <>
            {/* top: full-width text row */}
            <textarea
              ref={taRef}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              rows={1}
              autoFocus
              className="w-full resize-none bg-transparent px-[14px] pt-3 pb-1 text-[14px] leading-[1.55] text-fg-1 placeholder:text-fg-3 outline-none"
            />
            {/* bottom: full-width action row — SAME lineup as today (G2).
                In the real implementation the three middle slots are the
                EXISTING components re-skinned, not rebuilt:
                  · ToolsMenu   (Chat.tsx — attach / pick element / record)
                  · ModelPicker (ModelPicker.tsx — bare text chip + popover)
                  · ContextRing (ContextRing.tsx — read-only usage ring)
                Streaming swaps Send → Stop square + sliding queue button
                (existing behaviour, keep as-is). */}
            <div className="flex items-center gap-2 px-1 pb-1">
              <IconSlot label="工具"><PlusIcon /></IconSlot>{/* → ToolsMenu */}
              <div className="flex-1" />
              <span className="text-[12px] text-fg-2">{/* → ModelPicker chip */}</span>
              <span aria-hidden>{/* → ContextRing */}</span>
              <button
                type="button"
                aria-label="发送"
                disabled={!canSend}
                onClick={onSend}
                className="w-11 h-11 flex items-center justify-center rounded-[12px] text-accent-strong disabled:text-fg-4 hover:bg-accent-tint transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
              >
                <SendIcon />
              </button>
            </div>
          </>
        ) : (
          <>
            <IconSlot label="附加" size={52}><PlusIcon /></IconSlot>
            <input
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onFocus={() => setFocused(true)}
              placeholder={placeholder}
              className="flex-1 min-w-0 bg-transparent text-[14px] text-fg-1 placeholder:text-fg-3 outline-none"
            />
            <button
              type="button"
              aria-label="发送"
              disabled={!canSend}
              onClick={onSend}
              className="w-[52px] h-[52px] flex items-center justify-center text-accent-strong disabled:text-fg-4 hover:text-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line rounded-[26px]"
            >
              <SendIcon />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Bare hover-lit icon slot used inside the composer. */
function IconSlot({ size = 44, label, children }: { size?: number; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      style={{ width: size, height: size }}
      className="flex items-center justify-center text-fg-2 hover:text-fg-1 hover:bg-field/60 rounded-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
    >
      {children}
    </button>
  );
}

export default Composer;
