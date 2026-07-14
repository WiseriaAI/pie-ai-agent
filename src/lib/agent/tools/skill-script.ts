import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "@/lib/dom-actions/types";
import { escapeUntrustedWrappers } from "../untrusted-wrappers";
import type { SkillSource } from "../../skills/source";
import type { RunSkillScriptOutcome } from "@/background/local-bridge";
import type { RunSkillScriptParams } from "@/types/local-bridge";

/** skill-grant 授权卡 payload：daemon SkillAuthPayload 的展开（卡片按行渲染）。 */
export interface SkillGrantRequest {
  skillName: string;
  displayName?: string;
  description: string;
  scripts: string[];
  network: string[];
  write: string[];
}

export interface SkillScriptDeps {
  /** 真源查询：只有 disk 来源的 skill 有可执行脚本（走 daemon）；builtin/idb 无脚本。 */
  getSource: () => SkillSource;
  /** 磁盘 skill 特权脚本执行器：走本地 daemon 的 OS 沙箱。 */
  runOnDaemon: (p: RunSkillScriptParams) => Promise<RunSkillScriptOutcome>;
  /** HITL 授权卡：展示信封原文，用户批/拒。panel 不在（headless/已关）时 reject。 */
  requestGrant: (p: SkillGrantRequest) => Promise<boolean>;
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

export function buildRunSkillScriptTool(deps: SkillScriptDeps): Tool {
  return {
    name: "run_skill_script",
    description:
      "Run a script bundled with an enabled skill (available entries are listed when you call use_skill). " +
      "Pure-compute scripts (parse/transform/validate data) run in an isolated sandbox with no page, " +
      "network, or browser access. Pass `input` as the JSON argument the skill's documentation asks for; " +
      "the script's return value comes back as JSON. Scripts from disk-based skills may pause for the " +
      "user to approve the skill on an authorization card the first time. You cannot supply code — only " +
      "scripts declared by the installed skill package can run.",
    parameters: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "The skill id (from the skill catalog)." },
        entry: {
          type: "string",
          description:
            "Script entry exactly as listed by use_skill (e.g. hello.ts; older packaged skills may list paths like scripts/dedupe.js).",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "CLI-style string arguments for privileged (daemon-run) scripts.",
        },
      },
      required: ["skillId", "entry"],
      additionalProperties: false,
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as { skillId?: unknown; entry?: unknown; args?: unknown };
      if (typeof a.skillId !== "string" || !a.skillId)
        return { success: false, error: "run_skill_script requires skillId" };
      if (typeof a.entry !== "string" || !a.entry)
        return { success: false, error: "run_skill_script requires entry" };
      const argv = a.args;
      if (argv !== undefined && !isStringArray(argv))
        return { success: false, error: "run_skill_script args must be an array of strings" };

      // 真源合并列表（builtin+idb+disk）判定路由——只有磁盘 skill 有可执行脚本（走 daemon）；
      // builtin/idb 一律无脚本（没有任何路径能往其中塞 .js 文件）。
      const skillEntry = (await deps.getSource().list()).find((e) => e.id === a.skillId);
      if (!skillEntry) return { success: false, error: `Unknown skill: ${a.skillId}` };

      if (skillEntry.origin !== "disk") {
        return { success: false, error: `Skill ${a.skillId} declares no scripts.` };
      }

      // 磁盘可执行集是 scripts/ 目录下的裸文件名（daemon readdirSync 语义），但
      // LLM 可能被惯例/schema 示例教成传 "scripts/xxx"——两种形式都接受，送
      // daemon 用命中 allowlist 的那个（daemon 只认裸名）。先精确后剥前缀，
      // 老式声明（allowlist 本身含 scripts/ 前缀）不受影响。
      const stripped = a.entry.startsWith("scripts/") ? a.entry.slice("scripts/".length) : a.entry;
      const entry = skillEntry.runnableScripts.includes(a.entry)
        ? a.entry
        : skillEntry.runnableScripts.includes(stripped)
          ? stripped
          : null;
      if (entry === null) {
        const declared = skillEntry.runnableScripts;
        return {
          success: false,
          error: declared.length
            ? `Script not declared by skill ${a.skillId}. Declared scripts: ${declared.join(", ")}`
            : `Skill ${a.skillId} declares no scripts.`,
        };
      }
      const finalArgs = argv ?? [];
      let outcome = await deps.runOnDaemon({ name: a.skillId, entry, args: finalArgs });
      if (!outcome.ok && outcome.needsAuth) {
        const auth = outcome.auth;
        if (!auth) {
          return {
            success: false,
            error:
              "authorization_required: this skill needs user approval, but the connected Pie " +
              "daemon is too old to describe what it would grant. Ask the user to update the Pie daemon.",
          };
        }
        let approved = false;
        try {
          approved = await deps.requestGrant({
            skillName: auth.skillName,
            displayName: auth.displayName,
            description: auth.description,
            scripts: auth.envelope.runnableScripts,
            network: auth.envelope.allowedDomains,
            write: auth.envelope.extraWrites,
          });
        } catch {
          return {
            success: false,
            error:
              "authorization_required: no user present to approve (sidepanel closed or headless run).",
          };
        }
        if (!approved) return { success: false, error: "User declined skill authorization." };
        outcome = await deps.runOnDaemon({
          name: a.skillId,
          entry,
          args: finalArgs,
          grantApproved: true,
          approvedEnvelopeHash: auth.envelopeHash,
        });
        if (!outcome.ok && outcome.needsAuth) {
          return {
            success: false,
            error:
              "Skill declarations changed while awaiting approval — call run_skill_script again.",
          };
        }
      }
      if (outcome.ok) {
        const suffix = outcome.result.truncated ? " [output truncated]" : "";
        return {
          success: true,
          observation:
            `<untrusted_skill_content>${escapeUntrustedWrappers(outcome.result.output)}` +
            `</untrusted_skill_content>${suffix}`,
        };
      }
      return { success: false, error: `run_skill_script failed: ${(outcome as { error: string }).error}` };
    },
  };
}
