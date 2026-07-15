import { describe, it, expect } from "vitest";
import {
  buildImportPlan,
  IMPORT_MAX_FILES,
  IMPORT_MAX_TOTAL_BYTES,
  type ImportRawFile,
} from "./import-skill";

const VALID_MD = "---\nname: My Skill\ndescription: Does a thing\n---\nStep 1. Do it.";

function file(relPath: string, content: string | null = "x", size?: number): ImportRawFile {
  return { relPath, content, size: size ?? (content?.length ?? 0) };
}

describe("buildImportPlan", () => {
  it("builds a plan from a minimal valid folder (top folder stripped, id = folder name)", () => {
    const res = buildImportPlan([file("my-skill/SKILL.md", VALID_MD)]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.id).toBe("my-skill");
    expect(res.plan.name).toBe("My Skill");
    expect(res.plan.description).toBe("Does a thing");
    expect(res.plan.files).toEqual([{ path: "SKILL.md", content: VALID_MD }]);
    expect(res.plan.skippedBinary).toEqual([]);
    expect(res.plan.hasScripts).toBe(false);
  });

  it("strips the top-level folder from nested file paths", () => {
    const res = buildImportPlan([
      file("my-skill/SKILL.md", VALID_MD),
      file("my-skill/reference/notes.md", "hi"),
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.files.map((f) => f.path).sort()).toEqual([
      "SKILL.md",
      "reference/notes.md",
    ]);
  });

  it("flags hasScripts when a scripts/ file is present", () => {
    const res = buildImportPlan([
      file("my-skill/SKILL.md", VALID_MD),
      file("my-skill/scripts/run.py", "print(1)"),
    ]);
    expect(res.ok && res.plan.hasScripts).toBe(true);
  });

  it("routes binary files (content=null) into skippedBinary, not files", () => {
    const res = buildImportPlan([
      file("my-skill/SKILL.md", VALID_MD),
      file("my-skill/logo.png", null, 1234),
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.skippedBinary).toEqual(["logo.png"]);
    expect(res.plan.files.map((f) => f.path)).toEqual(["SKILL.md"]);
  });

  it("skips .git / node_modules / dotfiles silently", () => {
    const res = buildImportPlan([
      file("my-skill/SKILL.md", VALID_MD),
      file("my-skill/.git/config", "junk"),
      file("my-skill/node_modules/pkg/index.js", "junk"),
      file("my-skill/.DS_Store", "junk"),
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.files.map((f) => f.path)).toEqual(["SKILL.md"]);
  });

  it("rejects an empty selection", () => {
    const res = buildImportPlan([]);
    expect(res).toEqual({ ok: false, error: "empty" });
  });

  it("rejects when SKILL.md is missing", () => {
    const res = buildImportPlan([file("my-skill/readme.md", "no frontmatter here")]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("missing-skill-md");
  });

  it("rejects when SKILL.md frontmatter is invalid (no fence)", () => {
    const res = buildImportPlan([file("my-skill/SKILL.md", "no frontmatter at all")]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("invalid-frontmatter");
  });

  it("rejects when SKILL.md frontmatter is missing required name", () => {
    const res = buildImportPlan([
      file("my-skill/SKILL.md", "---\ndescription: only desc\n---\nbody"),
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("invalid-frontmatter");
  });

  it("rejects an illegal folder name (id) — not kebab-case", () => {
    const res = buildImportPlan([file("My Skill/SKILL.md", VALID_MD)]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("invalid-id");
    expect(res.detail).toBe("My Skill");
  });

  it("rejects a path traversal segment (fail-closed, no partial plan)", () => {
    const res = buildImportPlan([
      file("my-skill/SKILL.md", VALID_MD),
      file("my-skill/../escape.md", "evil"),
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("unsafe-path");
  });

  it("rejects mixed top-level roots", () => {
    const res = buildImportPlan([
      file("skill-a/SKILL.md", VALID_MD),
      file("skill-b/SKILL.md", VALID_MD),
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("multiple-roots");
  });

  it("rejects too many files (cap on the raw selection)", () => {
    const raw = [file("my-skill/SKILL.md", VALID_MD)];
    for (let i = 0; i < IMPORT_MAX_FILES; i++) raw.push(file(`my-skill/f${i}.txt`, "x"));
    const res = buildImportPlan(raw);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("too-many-files");
  });

  it("rejects a total size over the byte cap", () => {
    const res = buildImportPlan([
      file("my-skill/SKILL.md", VALID_MD),
      file("my-skill/big.bin", null, IMPORT_MAX_TOTAL_BYTES + 1),
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("too-large");
  });
});
