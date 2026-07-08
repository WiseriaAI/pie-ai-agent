import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "@/lib/dom-actions/types";
import { resolveSkillPackage } from "../../skills";
import { findScriptDecl, isPureCompute, parseScriptDecls } from "../../skills/script-decl";
import { escapeUntrustedWrappers } from "../untrusted-wrappers";

export interface SkillScriptDeps {
  /** 纯计算路径：送 offscreen sandbox 执行，返回 JSON string。 */
  runInSandbox: (code: string, input: unknown) => Promise<string>;
  /** fs-only 特权路径：调 daemon。缺省（无 daemon 能力）→ 特权脚本报「需要本地组件」。 */
  runPrivileged?: (params: {
    skillId: string;
    entry: string;
    code: string;
    perms: { fs: boolean; network: string[] };
    input: unknown;
    grantApproved?: boolean;
  }) => Promise<
    { ok: true; result: { output: string; truncated?: boolean } } | { ok: false; needsAuth: boolean; error: string }
  >;
  /** HITL 卡：展示 perms 原文，返回是否批准。 */
  requestGrantConsent?: (p: { skillId: string; skillName: string; entry: string; perms: { fs: boolean; network: string[] } }) => Promise<boolean>;
  /** 2b 前置项：skill 是否已启用（禁用 skill 的脚本不放行 daemon 执行）。 */
  isSkillEnabled?: (skillId: string) => Promise<boolean>;
  /** skill 展示名（授权卡用）。缺省用 skillId。 */
  skillName?: (skillId: string) => Promise<string>;
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
        // network 声明 → 2c，不在 2b 执行（sandbox-exec 做不到 per-domain）
        if (decl.network.length > 0) {
          return {
            success: false,
            error:
              `privileged_script: ${decl.entry} declares network access, which is not available yet ` +
              `(planned for a later release). Only filesystem-capable scripts can run today.`,
          };
        }
        // fs-only：走 daemon。无 daemon 能力 → 结构化「需要本地组件」。
        if (!deps.runPrivileged || !deps.requestGrantConsent) {
          return {
            success: false,
            error:
              `privileged_script: ${decl.entry} needs the Pie local daemon to run (filesystem access). ` +
              `Install/enable the local bridge in Settings.`,
          };
        }
        // 2b 前置项：禁用 skill 不放行
        if (deps.isSkillEnabled && !(await deps.isSkillEnabled(a.skillId))) {
          return { success: false, error: `Skill ${a.skillId} is not enabled; enable it before running its scripts.` };
        }
        const perms = { fs: decl.fs, network: decl.network };
        let res = await deps.runPrivileged({ skillId: a.skillId, entry: decl.entry, code, perms, input: a.input });
        if (!res.ok && res.needsAuth) {
          const skillName = deps.skillName ? await deps.skillName(a.skillId) : a.skillId;
          const approved = await deps.requestGrantConsent({ skillId: a.skillId, skillName, entry: decl.entry, perms });
          if (!approved) return { success: false, error: "User declined the skill script authorization." };
          res = await deps.runPrivileged({ skillId: a.skillId, entry: decl.entry, code, perms, input: a.input, grantApproved: true });
        }
        if (!res.ok) {
          return { success: false, error: `run_skill_script failed: ${res.error}` };
        }
        return {
          success: true,
          observation: `<untrusted_skill_content>${escapeUntrustedWrappers(res.result.output)}</untrusted_skill_content>`,
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
