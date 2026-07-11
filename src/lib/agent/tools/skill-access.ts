import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import type { SkillSource } from "../../skills/source";
import { stripFrontmatter } from "../../skills/source";
import { getActiveSkillSource } from "@/background/skill-source";
import { escapeUntrustedWrappers } from "../untrusted-wrappers";

function wrap(content: string): string {
  return `<untrusted_skill_content>${escapeUntrustedWrappers(content)}</untrusted_skill_content>`;
}

export interface SkillAccessDeps {
  getSource: () => SkillSource;
}

export function buildSkillAccessTools(deps: SkillAccessDeps): Tool[] {
  return [
    {
      name: "use_skill",
      description:
        "Load a skill's instructions when the user's request matches an enabled skill from the skill catalog. Returns the skill's SKILL.md guidance; then carry out the task using the regular tools as the guidance directs. Takes no business parameters — gather any inputs the skill needs from the conversation and page.",
      parameters: {
        type: "object",
        properties: {
          skillId: {
            type: "string",
            description:
              "The id of the skill to load (from the skill catalog in the system prompt).",
          },
        },
        required: ["skillId"],
        additionalProperties: false,
      },
      handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
        const { skillId } = (args ?? {}) as { skillId?: string };
        if (!skillId) return { success: false, error: "use_skill requires skillId" };
        const source = deps.getSource();
        const entry = (await source.list()).find((e) => e.id === skillId);
        if (!entry) return { success: false, error: `Unknown skill: ${skillId}` };
        const md = await source.readFile(skillId, "SKILL.md");
        if (md === null) return { success: false, error: `Skill has no SKILL.md: ${skillId}` };
        const body = stripFrontmatter(md);
        const refs = entry.files.filter((p) => p !== "SKILL.md");
        const refNote = refs.length
          ? `\n\nAdditional files available via read_skill_file: ${refs.join(", ")}`
          : "";
        const scriptNote = entry.runnableScripts.length
          ? `\n\nBundled scripts runnable via run_skill_script: ${entry.runnableScripts.join(", ")}`
          : "";
        return { success: true, observation: wrap(body + refNote + scriptNote) };
      },
    },
    {
      name: "read_skill_file",
      description:
        "Read an additional reference file bundled with a skill (paths listed when you call use_skill). Use only when the loaded skill instructions point you to a specific file.",
      parameters: {
        type: "object",
        properties: {
          skillId: {
            type: "string",
            description: "The skill id.",
          },
          path: {
            type: "string",
            description:
              "Relative file path inside the skill package, e.g. references/foo.md.",
          },
        },
        required: ["skillId", "path"],
        additionalProperties: false,
      },
      handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
        const { skillId, path } = (args ?? {}) as {
          skillId?: string;
          path?: string;
        };
        if (!skillId || !path)
          return { success: false, error: "read_skill_file requires skillId and path" };
        const content = await deps.getSource().readFile(skillId, path);
        if (content === null)
          return { success: false, error: `No such file: ${skillId}/${path}` };
        return { success: true, observation: wrap(content) };
      },
    },
  ];
}

export const SKILL_ACCESS_TOOLS: Tool[] = buildSkillAccessTools({ getSource: getActiveSkillSource });
