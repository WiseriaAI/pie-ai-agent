// src/lib/extraction/skill-template.ts
import type { ExtractionField, ExtractionConfig } from "./types";

export function buildExtractionConfig(schema: ExtractionField[], stopCondition: string): ExtractionConfig {
  return { version: 1, schema, stopCondition, output: { formats: ["csv", "json"], includeSourceColumns: true } };
}

/** 保存的抽取 skill 的 SKILL.md:frontmatter + 运行时执行指令(全程 LLM-driven)。 */
export function buildExtractionSkillMd(name: string, description: string): string {
  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "version: 1.0.0",
    "author: agent",
    "capabilities:",
    "  tools: [read_page, read_skill_file, output_extraction]",
    "---",
    "",
  ].join("\n");

  const body = [
    "This is a saved data-extraction skill. Extract data fully yourself (LLM-driven) per the config.",
    "",
    "1. Call read_skill_file(\"extraction.json\") to load { schema, stopCondition, output }.",
    "2. Before starting, give the user a rough estimate of how many pages / model calls this may take.",
    "3. Per-page loop:",
    "   - Call read_page with mode=\"content\" and max_bytes=500000 on the current tab.",
    "   - Extract one object per data row matching the schema fields. Apply each field's `type` and `normalize` hint to clean values.",
    "   - Attach to each row `_source: { page: <1-based page number>, url: <current page URL> }`.",
    "   - Accumulate rows.",
    "   - Evaluate stopCondition (natural language) against this page. If satisfied, stop.",
    "   - Otherwise advance to the next page (click next / load more / scroll / change the URL page param) and repeat. There is NO hard page cap — rely on stopCondition; if it runs unusually long, check in with the user.",
    "4. When done, call output_extraction TWICE: once with format=\"json\" and once with format=\"csv\", each time passing { filename, schema, rows, pageCount, producedBy: { skillId, skillName, version } }.",
    "5. Tell the user the row count and page count, and that the files are ready as download cards.",
  ].join("\n");

  return frontmatter + body;
}
