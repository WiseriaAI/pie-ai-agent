/**
 * SkillsList — Task 9 RPC rewire
 *
 * The settings Skills list used to read skill content straight from IDB
 * (getAllSkillPackages / putPackage / deletePackage). That data source is
 * stale in disk mode (the daemon owns the real files), so the component now
 * goes through the skills-action RPC channel (panel-actions.ts) for
 * list/read/write/delete, keeping only the enabled-marker toggle as a direct
 * IDB read/write (storage.ts) — that marker is an extension-side pref valid
 * in both modes.
 *
 * These tests mock the RPC boundary (panel-actions) and the enabled-marker
 * storage functions, but use the REAL `filterEnabled` (source.ts) so the
 * default-on semantics (builtin/disk origin default on, explicit markers
 * override) are exercised for real, not re-asserted against a mock.
 */

import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import SkillsList from "../SkillsList";
import type { SkillEntry } from "@/lib/skills/source";

vi.mock("@/lib/skills/panel-actions", () => ({
  listSkillEntries: vi.fn(),
  readSkillFileRpc: vi.fn(),
  writeSkillRpc: vi.fn(),
  deleteSkillRpc: vi.fn(),
}));

// queryGrants/revokeGrant hit chrome.runtime.sendMessage's callback form,
// which the test-setup mock never invokes (the promise would hang). Stub them
// so loadSkills() fully resolves — needed by the import tests that assert on
// post-loadSkills state (success notice). Harmless for the pre-existing tests.
vi.mock("@/lib/local-grants", () => ({
  queryGrants: vi.fn().mockResolvedValue([]),
  revokeGrant: vi.fn().mockResolvedValue(true),
}));

// Partial mock — only override the enabled-marker functions; leave
// generateUserSkillId etc. as the real (pure, crypto.randomUUID-based) impl.
vi.mock("@/lib/skills/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/skills/storage")>();
  return {
    ...actual,
    getEnabledSkillIds: vi.fn(),
    setSkillEnabled: vi.fn(),
  };
});

import {
  listSkillEntries,
  readSkillFileRpc,
  writeSkillRpc,
  deleteSkillRpc,
} from "@/lib/skills/panel-actions";
import { getEnabledSkillIds, setSkillEnabled } from "@/lib/skills/storage";

afterEach(() => {
  cleanup();
});

const DISK_ENTRY: SkillEntry = {
  id: "skill_disk_1",
  name: "Disk Skill",
  description: "A skill living on disk",
  builtIn: false,
  origin: "disk",
  files: ["SKILL.md"],
  runnableScripts: [],
  createdAt: 1000,
};

const IDB_ENTRY: SkillEntry = {
  id: "skill_user_2",
  name: "IDB Skill",
  description: "A skill living in IndexedDB",
  builtIn: false,
  origin: "idb",
  files: ["SKILL.md"],
  runnableScripts: [],
  createdAt: 2000,
};

describe("SkillsList", () => {
  beforeEach(() => {
    vi.mocked(listSkillEntries).mockReset();
    vi.mocked(readSkillFileRpc).mockReset();
    vi.mocked(writeSkillRpc).mockReset();
    vi.mocked(deleteSkillRpc).mockReset();
    vi.mocked(getEnabledSkillIds).mockReset().mockResolvedValue([]);
    vi.mocked(setSkillEnabled).mockReset().mockResolvedValue(undefined);
  });

  it("a disk-origin entry with no marker renders enabled; an IDB-origin entry with no marker renders disabled", async () => {
    vi.mocked(listSkillEntries).mockResolvedValue({ ok: true, skills: [DISK_ENTRY, IDB_ENTRY] });

    render(<SkillsList onRunSkill={vi.fn()} />);

    const diskSwitch = await screen.findByRole("switch", { name: "Disable Disk Skill" });
    expect(diskSwitch.getAttribute("aria-checked")).toBe("true");

    const idbSwitch = screen.getByRole("switch", { name: "Enable IDB Skill" });
    expect(idbSwitch.getAttribute("aria-checked")).toBe("false");
  });

  it("an explicit disable marker overrides the disk default-on", async () => {
    vi.mocked(listSkillEntries).mockResolvedValue({ ok: true, skills: [DISK_ENTRY] });
    vi.mocked(getEnabledSkillIds).mockResolvedValue(["!skill_disk_1"]);

    render(<SkillsList onRunSkill={vi.fn()} />);

    const diskSwitch = await screen.findByRole("switch", { name: "Enable Disk Skill" });
    expect(diskSwitch.getAttribute("aria-checked")).toBe("false");
  });

  it("toggling a default-on disk entry calls setSkillEnabled(id, false)", async () => {
    vi.mocked(listSkillEntries).mockResolvedValue({ ok: true, skills: [DISK_ENTRY] });

    render(<SkillsList onRunSkill={vi.fn()} />);
    const diskSwitch = await screen.findByRole("switch", { name: "Disable Disk Skill" });

    fireEvent.click(diskSwitch);

    await waitFor(() => {
      expect(setSkillEnabled).toHaveBeenCalledWith("skill_disk_1", false);
    });
  });

  it("delete calls deleteSkillRpc(id) then setSkillEnabled(id, false)", async () => {
    vi.mocked(listSkillEntries).mockResolvedValue({ ok: true, skills: [DISK_ENTRY] });
    vi.mocked(deleteSkillRpc).mockResolvedValue({ ok: true, deleted: true });

    render(<SkillsList onRunSkill={vi.fn()} />);
    await screen.findByRole("switch", { name: "Disable Disk Skill" });

    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Confirm"));

    await waitFor(() => {
      expect(deleteSkillRpc).toHaveBeenCalledWith("skill_disk_1");
      expect(setSkillEnabled).toHaveBeenCalledWith("skill_disk_1", false);
    });
  });

  it("edit reads the body via readSkillFileRpc + stripFrontmatter and populates the form", async () => {
    vi.mocked(listSkillEntries).mockResolvedValue({ ok: true, skills: [DISK_ENTRY] });
    vi.mocked(readSkillFileRpc).mockResolvedValue({
      ok: true,
      content: "---\nname: Disk Skill\ndescription: A skill living on disk\n---\nDo the thing.",
    });

    render(<SkillsList onRunSkill={vi.fn()} />);
    await screen.findByRole("switch", { name: "Disable Disk Skill" });

    fireEvent.click(screen.getByText("Edit"));

    await waitFor(() => {
      expect(readSkillFileRpc).toHaveBeenCalledWith("skill_disk_1", "SKILL.md");
    });
    const instructions = (await screen.findByPlaceholderText(
      /instructions/i,
    )) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(instructions.value).toBe("Do the thing.");
    });
  });

  it("a readSkillFileRpc failure still opens the form (name/description prefilled, empty body) with the error visible", async () => {
    vi.mocked(listSkillEntries).mockResolvedValue({ ok: true, skills: [DISK_ENTRY] });
    vi.mocked(readSkillFileRpc).mockResolvedValue({ ok: false, error: "daemon unreachable" });

    render(<SkillsList onRunSkill={vi.fn()} />);
    await screen.findByRole("switch", { name: "Disable Disk Skill" });

    fireEvent.click(screen.getByText("Edit"));

    // The form must mount (not a silent no-op) — prefilled from the
    // already-loaded entry, with an empty body...
    const instructions = (await screen.findByPlaceholderText(
      /instructions/i,
    )) as HTMLTextAreaElement;
    expect(instructions.value).toBe("");
    expect(screen.getByDisplayValue("Disk Skill")).toBeTruthy();
    expect(screen.getByDisplayValue("A skill living on disk")).toBeTruthy();
    // ...and the RPC error surfaced through the existing formError banner.
    expect(screen.getByText(/daemon unreachable/)).toBeTruthy();
  });

  it("edit save preserves hand-authored frontmatter (metadata.pie survives; only name/description/author/body change)", async () => {
    vi.mocked(listSkillEntries).mockResolvedValue({ ok: true, skills: [DISK_ENTRY] });
    vi.mocked(readSkillFileRpc).mockResolvedValue({
      ok: true,
      content:
        "---\nname: Disk Skill\ndescription: A skill living on disk\nlicense: MIT\nmetadata:\n  pie:\n    network: [api.example.com]\n---\nDo the thing.",
    });
    vi.mocked(writeSkillRpc).mockResolvedValue({ ok: true });

    render(<SkillsList onRunSkill={vi.fn()} />);
    await screen.findByRole("switch", { name: "Disable Disk Skill" });

    fireEvent.click(screen.getByText("Edit"));
    const instructions = (await screen.findByPlaceholderText(
      /instructions/i,
    )) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(instructions.value).toBe("Do the thing.");
    });

    fireEvent.change(instructions, { target: { value: "Do it better." } });
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(writeSkillRpc).toHaveBeenCalledTimes(1);
    });
    const [, files] = vi.mocked(writeSkillRpc).mock.calls[0];
    const written = files[0].content;
    expect(written).toContain("license: MIT");
    expect(written).toContain("network: [api.example.com]"); // 能力声明存活
    expect(written).toContain("Do it better.");
    expect(written).not.toContain("Do the thing.");
  });

  it("renders an invalid-network warning badge for a disk entry carrying invalidNetwork", async () => {
    vi.mocked(listSkillEntries).mockResolvedValue({
      ok: true,
      skills: [{ ...DISK_ENTRY, invalidNetwork: ["not a domain!", "例え.テスト"] }],
    });

    render(<SkillsList onRunSkill={vi.fn()} />);
    await screen.findByRole("switch", { name: "Disable Disk Skill" });

    // count 插值到 badge 文案
    const badge = screen.getByText(/2 invalid network domain/i);
    expect(badge).toBeTruthy();
    // 被丢弃的原始条目挂在 title 上供作者排查
    expect(badge.getAttribute("title")).toBe("not a domain!, 例え.テスト");
  });

  it("no badge when a skill has no invalidNetwork", async () => {
    vi.mocked(listSkillEntries).mockResolvedValue({ ok: true, skills: [DISK_ENTRY] });

    render(<SkillsList onRunSkill={vi.fn()} />);
    await screen.findByRole("switch", { name: "Disable Disk Skill" });

    expect(screen.queryByText(/invalid network domain/i)).toBeNull();
  });

  it("a listSkillEntries RPC failure renders an empty list instead of throwing", async () => {
    vi.mocked(listSkillEntries).mockResolvedValue({ ok: false, error: "daemon unreachable" });

    render(<SkillsList onRunSkill={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByRole("switch")).toBeNull();
    });
  });
});

// --- External skill folder import (#321) ---

const VALID_MD = "---\nname: Imported Skill\ndescription: A folder import\n---\nDo the thing.";

function makeFile(relPath: string, content: string): File {
  const name = relPath.split("/").pop() as string;
  const f = new File([content], name, { type: "text/plain" });
  Object.defineProperty(f, "webkitRelativePath", { value: relPath });
  return f;
}

function selectFolder(container: HTMLElement, files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
}

describe("SkillsList — folder import", () => {
  beforeEach(() => {
    vi.mocked(listSkillEntries).mockReset().mockResolvedValue({ ok: true, skills: [] });
    vi.mocked(writeSkillRpc).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(deleteSkillRpc).mockReset().mockResolvedValue({ ok: true, deleted: true });
    vi.mocked(getEnabledSkillIds).mockReset().mockResolvedValue([]);
    vi.mocked(setSkillEnabled).mockReset().mockResolvedValue(undefined);
  });

  it("imports a valid folder: writes files + enables the skill + shows a success notice", async () => {
    const { container } = render(<SkillsList onRunSkill={vi.fn()} />);
    await waitFor(() => expect(listSkillEntries).toHaveBeenCalled());

    selectFolder(container, [
      makeFile("my-skill/SKILL.md", VALID_MD),
      makeFile("my-skill/reference/notes.md", "notes"),
    ]);

    // Confirm card renders with parsed metadata.
    await screen.findByText("Imported Skill");
    expect(screen.getByText("A folder import")).toBeTruthy();
    expect(screen.getByText("reference/notes.md")).toBeTruthy();

    fireEvent.click(screen.getByText("Import"));

    await waitFor(() => {
      expect(writeSkillRpc).toHaveBeenCalledWith("my-skill", [
        { path: "SKILL.md", content: VALID_MD },
        { path: "reference/notes.md", content: "notes" },
      ]);
      expect(setSkillEnabled).toHaveBeenCalledWith("my-skill", true);
    });
    // No overwrite path on a fresh id.
    expect(deleteSkillRpc).not.toHaveBeenCalled();
    await screen.findByText(/Imported .Imported Skill./);
  });

  it("rejects a folder with no SKILL.md and surfaces an error (no confirm card, no write)", async () => {
    const { container } = render(<SkillsList onRunSkill={vi.fn()} />);
    await waitFor(() => expect(listSkillEntries).toHaveBeenCalled());

    selectFolder(container, [makeFile("my-skill/readme.md", "just a readme")]);

    await screen.findByText(/No SKILL.md found/);
    expect(screen.queryByText("Import")).toBeNull();
    expect(writeSkillRpc).not.toHaveBeenCalled();
  });

  it("same-id import shows an overwrite warning and does delete-then-write", async () => {
    const existing: SkillEntry = {
      id: "my-skill",
      name: "Old",
      description: "old one",
      builtIn: false,
      origin: "idb",
      files: ["SKILL.md"],
      runnableScripts: [],
      createdAt: 1,
    };
    vi.mocked(listSkillEntries).mockResolvedValue({ ok: true, skills: [existing] });

    const { container } = render(<SkillsList onRunSkill={vi.fn()} />);
    await screen.findByRole("switch", { name: "Enable Old" });

    selectFolder(container, [makeFile("my-skill/SKILL.md", VALID_MD)]);

    await screen.findByText(/already exists/);
    fireEvent.click(screen.getByText("Overwrite & import"));

    await waitFor(() => {
      expect(deleteSkillRpc).toHaveBeenCalledWith("my-skill");
      expect(writeSkillRpc).toHaveBeenCalledWith("my-skill", [
        { path: "SKILL.md", content: VALID_MD },
      ]);
    });
  });

  it("shows the scripts authorization hint when the folder bundles scripts/", async () => {
    const { container } = render(<SkillsList onRunSkill={vi.fn()} />);
    await waitFor(() => expect(listSkillEntries).toHaveBeenCalled());

    selectFolder(container, [
      makeFile("my-skill/SKILL.md", VALID_MD),
      makeFile("my-skill/scripts/run.py", "print(1)"),
    ]);

    await screen.findByText(/authorization card/);
  });
});
