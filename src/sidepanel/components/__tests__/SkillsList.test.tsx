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

  it("a listSkillEntries RPC failure renders an empty list instead of throwing", async () => {
    vi.mocked(listSkillEntries).mockResolvedValue({ ok: false, error: "daemon unreachable" });

    render(<SkillsList onRunSkill={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByRole("switch")).toBeNull();
    });
  });
});
