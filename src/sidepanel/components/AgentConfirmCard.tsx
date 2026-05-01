import type { ResolvedElement } from "@/types";
import type { SkillDefinition } from "@/lib/skills";

interface AgentConfirmCardProps {
  tool: string;
  args: unknown;
  resolvedElement: ResolvedElement;
  riskReason: string;
  resolved?: "approved" | "rejected";
  onApprove: () => void;
  onReject: () => void;
  /** Phase 2.6 — for create_skill / update_skill confirms, the SW pre-computes
   *  the effective skill so the card can render full merged content. Without
   *  this, update_skill confirms would only show the patch fields and hide
   *  the persistent allowedTools / parameters / etc. (P0-D / adv-1). */
  metaSkillPreview?: {
    existing: SkillDefinition | null;
    effective: SkillDefinition;
  };
}

/**
 * Redact sensitive values before display. The risk classifier already flagged
 * this as high-risk because the target is a sensitive field (password/CC/OTP).
 * Showing the plaintext value in the confirm card would defeat the redaction
 * that type.ts already applies to the tool_result observation.
 */
function redactArgsForDisplay(tool: string, args: unknown, riskReason: string): unknown {
  if (tool !== "type") return args;
  if (!riskReason.toLowerCase().includes("sensitive")) return args;
  if (!args || typeof args !== "object") return args;
  const redacted: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  if ("text" in redacted) redacted.text = "[redacted]";
  return redacted;
}

function safeStringifyArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args, null, 2) ?? "null";
    return s.length > 2000 ? s.slice(0, 2000) + "\n... (truncated)" : s;
  } catch {
    return "(non-serializable)";
  }
}

/** Phase 2.6 — meta tool detection (P0-D). For create_skill / update_skill the
 *  args object IS the trust-decision artifact, so the 2000-char cap and the
 *  generic args block must be bypassed in favor of full-content per-field
 *  rendering. */
function isSkillMetaTool(tool: string): boolean {
  return tool === "create_skill" || tool === "update_skill";
}

function safeStringifyForPanel(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return "(non-serializable)";
  }
}

/**
 * Render the EFFECTIVE skill content under review for a create_skill /
 * update_skill confirm card — the merged result that will actually persist
 * if the user approves. NO 2000-char cap (P0-D). Each field is a dedicated
 * scrollable panel with max-h so the card stays manageable.
 *
 * For update_skill, fields whose value is unchanged from the existing skill
 * are tagged "(unchanged)" so the user can quickly see what is being
 * modified without losing sight of what is being re-approved (this closes
 * adv-1, where rendering only the patch hid persistent broad capabilities
 * the user implicitly retained).
 */
function SkillContentDetails({
  tool,
  metaSkillPreview,
}: {
  tool: string;
  metaSkillPreview: {
    existing: SkillDefinition | null;
    effective: SkillDefinition;
  };
}) {
  const isUpdate = tool === "update_skill";
  const eff = metaSkillPreview.effective;
  const existing = metaSkillPreview.existing;

  // Helper: is this field unchanged from existing? Only meaningful for update_skill.
  const unchanged = (key: "name" | "description" | "promptTemplate") =>
    isUpdate && existing !== null && existing[key] === eff[key];
  const parametersUnchanged =
    isUpdate &&
    existing !== null &&
    safeStringifyForPanel(existing.toolSchema.parameters) === safeStringifyForPanel(eff.toolSchema.parameters);
  const allowedToolsUnchanged =
    isUpdate &&
    existing !== null &&
    JSON.stringify(existing.allowedTools ?? null) === JSON.stringify(eff.allowedTools ?? null);

  const allowedTools = eff.allowedTools;

  return (
    <div className="space-y-2.5">
      <div className="rounded bg-amber-950/40 border border-amber-700/60 px-2 py-1 text-xs text-amber-300">
        {isUpdate ? (
          <>
            Updating <code className="font-mono">{existing?.id ?? eff.id}</code>. After approval the skill is re-marked as agent-authored and the user will be asked to re-confirm on its next execution. Fields tagged "(unchanged)" stay as they were.
          </>
        ) : (
          <>Creating a new agent-authored skill. The user will be asked to re-confirm on its first execution.</>
        )}
      </div>
      {isUpdate && existing !== null && (
        <div>
          <div className="text-xs text-neutral-500">id:</div>
          <code className="font-mono text-xs text-neutral-300 break-all">{existing.id}</code>
        </div>
      )}
      <div>
        <div className="text-xs text-neutral-500">
          name: {unchanged("name") && <span className="text-neutral-600">(unchanged)</span>}
        </div>
        <div className="text-neutral-200">{eff.name}</div>
      </div>
      <div>
        <div className="text-xs text-neutral-500">
          description: {unchanged("description") && <span className="text-neutral-600">(unchanged)</span>}
        </div>
        <div className="text-neutral-300 whitespace-pre-wrap break-words">{eff.description}</div>
      </div>
      <div>
        <div className="text-xs text-neutral-500">
          promptTemplate ({eff.promptTemplate.length} chars){" "}
          {unchanged("promptTemplate") && <span className="text-neutral-600">(unchanged)</span>}
        </div>
        <pre className="max-h-64 overflow-auto rounded bg-neutral-950 p-2 font-mono text-xs text-neutral-300 whitespace-pre-wrap break-words">
          {eff.promptTemplate}
        </pre>
      </div>
      <div>
        <div className="text-xs text-neutral-500">
          parameters (JSON Schema):{" "}
          {parametersUnchanged && <span className="text-neutral-600">(unchanged)</span>}
        </div>
        <pre className="max-h-48 overflow-auto rounded bg-neutral-950 p-2 font-mono text-xs text-neutral-300">
          {safeStringifyForPanel(eff.toolSchema.parameters)}
        </pre>
      </div>
      <div>
        <div className="text-xs text-neutral-500">
          allowedTools: {allowedToolsUnchanged && <span className="text-neutral-600">(unchanged)</span>}
        </div>
        {allowedTools === null || allowedTools === undefined ? (
          <div className="text-xs italic text-neutral-500">(legacy: no scope restriction)</div>
        ) : allowedTools.length === 0 ? (
          <div className="text-xs italic text-neutral-500">(empty — only done / fail callable inside this skill's scope)</div>
        ) : (
          <div className="mt-1 flex flex-wrap gap-1">
            {allowedTools.map((t, i) => (
              <code
                key={i}
                className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-xs text-neutral-300"
              >
                {t}
              </code>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AgentConfirmCard({
  tool,
  args,
  resolvedElement,
  riskReason,
  resolved,
  onApprove,
  onReject,
  metaSkillPreview,
}: AgentConfirmCardProps) {
  function handleKeyDown(e: React.KeyboardEvent) {
    // Prevent Enter from accidentally triggering Approve
    if (e.key === "Enter") {
      e.preventDefault();
    }
  }

  const isMeta = isSkillMetaTool(tool);

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="rounded bg-red-950/30 border border-red-800 p-3 text-sm"
      onKeyDown={handleKeyDown}
    >
      {/* Heading */}
      <div className="mb-2 font-semibold text-red-400">
        [!] Confirm action
      </div>

      {/* Risk reason */}
      <div className="mb-2 text-xs text-red-300">{riskReason}</div>

      {/* Tool name */}
      <div className="mb-2">
        <span className="text-neutral-400 text-xs">Tool: </span>
        <code className="font-mono text-neutral-200">{tool}</code>
      </div>

      {/* Resolved element — only for DOM-targeted tools (skip for meta tools whose
          resolvedElement is a placeholder { text: "", tag: "" } or { text: skill.name, tag: "skill" }) */}
      {!isMeta && (
        <div className="mb-2 space-y-0.5 text-xs">
          <div>
            <span className="text-neutral-500">tag: </span>
            <code className="font-mono text-neutral-300">
              {"<"}
              {resolvedElement.tag}
              {">"}
            </code>
          </div>
          {resolvedElement.text && (
            <div>
              <span className="text-neutral-500">text: </span>
              <span className="text-neutral-300">{resolvedElement.text}</span>
            </div>
          )}
          {resolvedElement.ariaLabel && (
            <div>
              <span className="text-neutral-500">aria-label: </span>
              <span className="text-neutral-300">{resolvedElement.ariaLabel}</span>
            </div>
          )}
          {resolvedElement.type && (
            <div>
              <span className="text-neutral-500">type: </span>
              <span className="text-neutral-300">{resolvedElement.type}</span>
            </div>
          )}
          {resolvedElement.href && (
            <div>
              <span className="text-neutral-500">href: </span>
              <span className="text-neutral-300 break-all">{resolvedElement.href}</span>
            </div>
          )}
        </div>
      )}

      {/* Args — meta tools render the EFFECTIVE merged skill (P0-D no cap,
          adv-1 closure: update_skill must show retained fields, not just
          the patch). Falls back to the generic args dump only when the
          metaSkillPreview is missing (defensive: shouldn't happen for
          meta tools because loop.ts always provides it). */}
      <div className="mb-3">
        {isMeta && metaSkillPreview ? (
          <SkillContentDetails tool={tool} metaSkillPreview={metaSkillPreview} />
        ) : (
          <>
            <div className="mb-0.5 text-xs text-neutral-500">args:</div>
            <pre className="overflow-x-auto rounded bg-neutral-950 p-1.5 font-mono text-xs text-neutral-300">
              {safeStringifyArgs(redactArgsForDisplay(tool, args, riskReason))}
            </pre>
          </>
        )}
      </div>

      {/* Action buttons or resolved status */}
      {resolved ? (
        <div
          className={`text-xs font-mono ${
            resolved === "approved" ? "text-green-400" : "text-neutral-400"
          }`}
        >
          {resolved === "approved" ? "Approved" : "Rejected"}
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={onReject}
            autoFocus
            className="rounded bg-neutral-700 px-3 py-1.5 text-xs text-neutral-100 hover:bg-neutral-600 focus:outline focus:outline-2 focus:outline-neutral-500"
          >
            Reject
          </button>
          <button
            onClick={onApprove}
            className="rounded bg-red-700 px-3 py-1.5 text-xs text-white hover:bg-red-600 focus:outline focus:outline-2 focus:outline-red-500"
          >
            Approve
          </button>
        </div>
      )}
    </div>
  );
}
