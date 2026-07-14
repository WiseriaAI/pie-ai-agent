import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "@/lib/dom-actions/types";
import { escapeUntrustedWrappers } from "../untrusted-wrappers";
import type { SkillSource } from "../../skills/source";
import type { RunSkillScriptOutcome } from "@/background/local-bridge";
import type {
  RunSkillScriptParams,
  RunSkillScriptResult,
  ReadSessionFileParams,
  ReadSessionFileResult,
} from "@/types/local-bridge";

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

/** 人类可读字节数（清单里让 LLM 判断值不值得读）。 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${Math.round(kb / 1024)} MB`;
}

/**
 * disk 脚本成功后的 observation（spec D9，四种形态）。信任规则：产物文件名是脚本
 * 控制的不可信数据 → 一律 escape 进 <untrusted_*> 块；框架句（我们写的）在块外。
 */
export function buildSkillOutputObservation(result: RunSkillScriptResult): string {
  const stdout = result.output ?? "";
  const hasStdout = stdout.trim().length > 0;
  const outputs = result.outputs ?? [];
  const parts: string[] = [];

  if (hasStdout) {
    parts.push(
      `<untrusted_skill_content>${escapeUntrustedWrappers(stdout)}</untrusted_skill_content>` +
        (result.truncated ? " [output truncated]" : ""),
    );
  }

  if (outputs.length > 0) {
    const list = outputs.map((o) => `${o.path} (${formatBytes(o.bytes)})`).join(", ");
    const framing = hasStdout
      ? "Files written to the session workspace (read them with read_skill_output):"
      : "(script exited 0 without printing to stdout)\n" +
        "Files written to the session workspace (read them with read_skill_output):";
    parts.push(
      `${framing}\n<untrusted_skill_output_list>${escapeUntrustedWrappers(list)}</untrusted_skill_output_list>` +
        (result.outputsTruncated ? " [file list truncated at 50]" : ""),
    );
  }

  if (parts.length === 0) {
    // stdout 空且无产物（#296 踩到的那个）→ 精确打死病根的可行动提示。
    return (
      "(script exited 0 but produced nothing: no stdout, no files written. Disk skill\n" +
      "scripts must print results to stdout or write files into the working directory —\n" +
      "a returned value is discarded.)"
    );
  }
  return parts.join("\n");
}

export function buildRunSkillScriptTool(deps: SkillScriptDeps): Tool {
  return {
    name: "run_skill_script",
    description:
      "Run a script bundled with an enabled skill (available entries are listed when you call use_skill). " +
      "The script runs as a local command-line process via the Pie daemon: the `args` you pass become the " +
      "script's process.argv, the script prints its result to stdout (returned to you), and any files it " +
      "writes into its working directory become session products that you can read back with " +
      "read_skill_output. A returned or exported value is discarded — only stdout and written files " +
      "survive. The first run of an unapproved skill pauses for the user to approve it on an authorization " +
      "card. You cannot supply code — only scripts declared by the installed skill package can run.",
    parameters: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "The skill id (from the skill catalog)." },
        entry: {
          type: "string",
          description: "Script entry exactly as listed by use_skill (e.g. hello.ts).",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "CLI-style string arguments passed to the script as process.argv.",
        },
      },
      required: ["skillId", "entry"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as { skillId?: unknown; entry?: unknown; args?: unknown };
      if (typeof a.skillId !== "string" || !a.skillId)
        return { success: false, error: "run_skill_script requires skillId" };
      if (typeof a.entry !== "string" || !a.entry)
        return { success: false, error: "run_skill_script requires entry" };
      const argv = a.args;
      if (argv !== undefined && !isStringArray(argv))
        return { success: false, error: "run_skill_script args must be an array of strings" };
      // fail-closed：产物按 session 隔离，缺 sessionId 不能落盘/定位（生产路径总有）。
      if (!ctx.sessionId)
        return { success: false, error: "run_skill_script requires an active session." };
      const sessionId = ctx.sessionId;

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
      let outcome = await deps.runOnDaemon({ name: a.skillId, entry, args: finalArgs, sessionId });
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
          sessionId,
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
        return { success: true, observation: buildSkillOutputObservation(outcome.result) };
      }
      return { success: false, error: `run_skill_script failed: ${(outcome as { error: string }).error}` };
    },
  };
}

export interface ReadSkillOutputDeps {
  /** 读回本 session workspace 内产物；走 daemon read_session_file RPC。 */
  readOutput: (p: ReadSessionFileParams) => Promise<ReadSessionFileResult>;
}

/** read_skill_output：读回 run_skill_script 写进 session workspace 的产物文件。
 *  read-class（tool-names.ts）。内容是脚本产物 → 不可信，包 <untrusted_skill_content>。 */
export function buildReadSkillOutputTool(deps: ReadSkillOutputDeps): Tool {
  return {
    name: "read_skill_output",
    description:
      "Read a file that a skill script wrote into the session workspace. The available paths are listed " +
      "in the observation right after run_skill_script. Reads only the current session's products.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Workspace-relative path exactly as listed after run_skill_script (e.g. out.csv).",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as { path?: unknown };
      if (typeof a.path !== "string" || !a.path)
        return { success: false, error: "read_skill_output requires path" };
      if (!ctx.sessionId)
        return { success: false, error: "read_skill_output requires an active session." };
      try {
        const r = await deps.readOutput({ sessionId: ctx.sessionId, path: a.path });
        return {
          success: true,
          observation: `<untrusted_skill_content>${escapeUntrustedWrappers(r.content)}</untrusted_skill_content>`,
        };
      } catch (e) {
        return {
          success: false,
          error: `read_skill_output failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}
