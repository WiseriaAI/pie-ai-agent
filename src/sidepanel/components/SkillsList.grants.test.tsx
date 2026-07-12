import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import SkillsList from "./SkillsList";

const DISK_SKILL = {
  id: "gh-dashboard",
  name: "gh-dashboard",
  description: "Pulls repo metrics",
  builtIn: false,
  origin: "disk" as const,
  files: ["SKILL.md"],
  runnableScripts: ["fetch.ts"],
  createdAt: 2,
};

const GRANT = {
  key: "skill:gh-dashboard:abc",
  skillName: "gh-dashboard",
  envelope: { allowedDomains: [], extraWrites: [], runnableScripts: ["fetch.ts"] },
  grantedAt: 1700000000000,
};

vi.mock("@/lib/skills/panel-actions", () => ({
  listSkillEntries: vi.fn(async () => ({ ok: true, skills: [DISK_SKILL] })),
  readSkillFileRpc: vi.fn(async () => ({ ok: false, error: "nope" })),
  writeSkillRpc: vi.fn(async () => ({ ok: true })),
  deleteSkillRpc: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/skills", () => ({
  getEnabledSkillIds: vi.fn(async () => []),
  setSkillEnabled: vi.fn(async () => {}),
  generateUserSkillId: vi.fn(() => "u1"),
}));
vi.mock("@/lib/local-grants", () => ({
  queryGrants: vi.fn(async () => [GRANT]),
  revokeGrant: vi.fn(async () => true),
}));

import { queryGrants, revokeGrant } from "@/lib/local-grants";

afterEach(() => cleanup());
beforeEach(() => {
  vi.mocked(queryGrants).mockResolvedValue([GRANT]);
});

describe("SkillsList — grant pill + revoke", () => {
  it("granted disk skill row shows the authorized pill and revoke action", async () => {
    render(<SkillsList onRunSkill={() => {}} />);
    expect(await screen.findByText("Scripts authorized")).toBeTruthy();
    expect(screen.getByText("Revoke")).toBeTruthy();
  });

  it("revoke calls revokeGrant with the grant key and refreshes grants", async () => {
    // 撤销成功后 daemon 删除该 grant → 组件内部重查 queryGrants 返回空 → pill 消失。
    vi.mocked(revokeGrant).mockImplementation(async () => {
      vi.mocked(queryGrants).mockResolvedValue([]);
      return true;
    });
    render(<SkillsList onRunSkill={() => {}} />);
    fireEvent.click(await screen.findByText("Revoke"));
    await waitFor(() => expect(revokeGrant).toHaveBeenCalledWith("skill:gh-dashboard:abc"));
    await waitFor(() => expect(screen.queryByText("Scripts authorized")).toBeFalsy());
  });

  it("no grants → row renders without pill or revoke", async () => {
    vi.mocked(queryGrants).mockResolvedValue([]);
    render(<SkillsList onRunSkill={() => {}} />);
    expect(await screen.findByText(/gh-dashboard/)).toBeTruthy();
    expect(screen.queryByText("Scripts authorized")).toBeFalsy();
    expect(screen.queryByText("Revoke")).toBeFalsy();
  });
});
