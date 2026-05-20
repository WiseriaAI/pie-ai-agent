import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import { getPackage, getPackageFile } from "../../skills/skill-store";
import { parseSkillMarkdown } from "../../skills/frontmatter";
import { escapeUntrustedWrappers } from "../untrusted-wrappers";

function wrap(content: string): string {
  return `<untrusted_skill_content>${escapeUntrustedWrappers(content)}</untrusted_skill_content>`;
}

export const SKILL_ACCESS_TOOLS: Tool[] = [
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
      const pkg = await getPackage(skillId);
      if (!pkg) return { success: false, error: `Unknown skill: ${skillId}` };
      const { body } = parseSkillMarkdown(pkg.files["SKILL.md"]);
      const refs = Object.keys(pkg.files).filter((p) => p !== "SKILL.md");
      const refNote = refs.length
        ? `\n\nAdditional files available via read_skill_file: ${refs.join(", ")}`
        : "";
      return { success: true, observation: wrap(body + refNote) };
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
      const content = await getPackageFile(skillId, path);
      if (content === null)
        return { success: false, error: `No such file: ${skillId}/${path}` };
      return { success: true, observation: wrap(content) };
    },
  },
];
