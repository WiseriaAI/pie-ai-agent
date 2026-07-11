import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "@/lib/dom-actions/types";
import { sendToOffscreen } from "@/background/offscreen-manager";
import { resolveSkillPackage } from "../../skills";
import { findScriptDecl, isPureCompute, parseScriptDecls } from "../../skills/script-decl";
import { escapeUntrustedWrappers } from "../untrusted-wrappers";
import type { SkillSource } from "../../skills/source";
import { getActiveSkillSource } from "@/background/skill-source";
import { requestRunSkillScript, type RunSkillScriptOutcome } from "@/background/local-bridge";

export interface SkillScriptDeps {
  /** 纯计算路径：送 offscreen sandbox 执行，返回 JSON string。 */
  runInSandbox: (code: string, input: unknown) => Promise<string>;
  /** 真源查询：entry.origin 判路由——disk 走 daemon，builtin/idb 走既有 sandbox 路径。 */
  getSource: () => SkillSource;
  /** 磁盘 skill 特权脚本执行器：走本地 daemon 的 OS 沙箱。 */
  runOnDaemon: (p: { name: string; entry: string; args?: string[] }) => Promise<RunSkillScriptOutcome>;
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
      "the script's return value comes back as JSON. You cannot supply code — only scripts declared by " +
      "the installed skill package can run.",
    parameters: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "The skill id (from the skill catalog)." },
        entry: {
          type: "string",
          description:
            "Script entry exactly as listed by use_skill (e.g. hello.ts; older packaged skills may list paths like scripts/dedupe.js).",
        },
        input: { description: "JSON input passed to the script's default export." },
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
      const a = (args ?? {}) as { skillId?: unknown; entry?: unknown; input?: unknown; args?: unknown };
      if (typeof a.skillId !== "string" || !a.skillId)
        return { success: false, error: "run_skill_script requires skillId" };
      if (typeof a.entry !== "string" || !a.entry)
        return { success: false, error: "run_skill_script requires entry" };
      const argv = a.args;
      if (argv !== undefined && !isStringArray(argv))
        return { success: false, error: "run_skill_script args must be an array of strings" };

      // 真源合并列表（builtin+idb+disk）判定路由——磁盘 skill 走 daemon，其余走既有 sandbox 路径。
      const skillEntry = (await deps.getSource().list()).find((e) => e.id === a.skillId);
      if (!skillEntry) return { success: false, error: `Unknown skill: ${a.skillId}` };

      if (skillEntry.origin === "disk") {
        // 磁盘可执行集是 scripts/ 目录下的裸文件名（daemon readdirSync 语义），但
        // LLM 被 2a 惯例/schema 示例教成传 "scripts/xxx"——两种形式都接受，送
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
        const finalArgs = argv ?? (a.input !== undefined ? [JSON.stringify(a.input)] : []);
        const outcome = await deps.runOnDaemon({ name: a.skillId, entry, args: finalArgs });
        if (outcome.ok) {
          const suffix = outcome.result.truncated ? " [output truncated]" : "";
          return {
            success: true,
            observation:
              `<untrusted_skill_content>${escapeUntrustedWrappers(outcome.result.output)}` +
              `</untrusted_skill_content>${suffix}`,
          };
        }
        if (outcome.needsAuth) {
          return {
            success: false,
            error:
              "authorization_required: this skill needs your approval to run scripts on this machine. " +
              "The authorization card UI ships in the next update — for now the user can pre-authorize via daemon tooling.",
          };
        }
        return { success: false, error: `run_skill_script failed: ${outcome.error}` };
      }

      // builtin / idb：既有 2a offscreen sandbox 路径，逐字保留。
      const pkg = await resolveSkillPackage(a.skillId);
      if (!pkg) return { success: false, error: `Unknown skill: ${a.skillId}` };
      // 门禁：只有 capabilities.scripts 声明过的 entry 可执行。LLM 传不了代码，
      // 包内未声明的文件也不行——声明是唯一执行权威（对齐 daemon 静态表模式）。
      const decls = parseScriptDecls(pkg.frontmatter.capabilities?.scripts);
      const decl = findScriptDecl(decls, a.entry);
      if (!decl) {
        const declared = decls.map((d) => d.entry);
        return {
          success: false,
          error: declared.length
            ? `Script not declared by skill ${a.skillId}. Declared scripts: ${declared.join(", ")}`
            : `Skill ${a.skillId} declares no scripts.`,
        };
      }
      const code = pkg.files[decl.entry];
      if (typeof code !== "string")
        return { success: false, error: `Script file missing from package: ${decl.entry}` };
      if (!isPureCompute(decl)) {
        // 特权脚本（fs/network）走 daemon 执行器 —— Slice 2b。
        return {
          success: false,
          error:
            `privileged_script: ${decl.entry} declares fs/network permissions and requires the ` +
            `Pie local daemon; privileged script execution is not available yet. ` +
            `Only pure-compute scripts can run today.`,
        };
      }
      try {
        const json = await deps.runInSandbox(code, a.input);
        return {
          success: true,
          observation: `<untrusted_skill_content>${escapeUntrustedWrappers(json)}</untrusted_skill_content>`,
        };
      } catch (e) {
        return {
          success: false,
          error: `run_skill_script failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}

/** 默认实例：builtin/idb 走 offscreen sandbox，disk 走本地 daemon。 */
export const RUN_SKILL_SCRIPT_TOOL: Tool = buildRunSkillScriptTool({
  runInSandbox: (code, input) => sendToOffscreen<string>({ type: "skill:run_script", code, input }),
  getSource: getActiveSkillSource,
  runOnDaemon: requestRunSkillScript,
});
