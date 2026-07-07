import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "@/lib/dom-actions/types";
import { sendToOffscreen } from "@/background/offscreen-manager";
import { resolveSkillPackage } from "../../skills";
import { findScriptDecl, isPureCompute, parseScriptDecls } from "../../skills/script-decl";
import { escapeUntrustedWrappers } from "../untrusted-wrappers";

export interface SkillScriptDeps {
  /** 纯计算路径：送 offscreen sandbox 执行，返回 JSON string。 */
  runInSandbox: (code: string, input: unknown) => Promise<string>;
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
          description: "Script path inside the skill package, e.g. scripts/dedupe.js.",
        },
        input: { description: "JSON input passed to the script's default export." },
      },
      required: ["skillId", "entry"],
      additionalProperties: false,
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as { skillId?: unknown; entry?: unknown; input?: unknown };
      if (typeof a.skillId !== "string" || !a.skillId)
        return { success: false, error: "run_skill_script requires skillId" };
      if (typeof a.entry !== "string" || !a.entry)
        return { success: false, error: "run_skill_script requires entry" };
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

/** 默认实例：wired 到 offscreen sandbox。 */
export const RUN_SKILL_SCRIPT_TOOL: Tool = buildRunSkillScriptTool({
  runInSandbox: (code, input) => sendToOffscreen<string>({ type: "skill:run_script", code, input }),
});
