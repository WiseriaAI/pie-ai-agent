import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import SkillsList from "./SkillsList";
import type { SkillEntry } from "@/lib/skills/source";

const listSkillEntries = vi.fn();
vi.mock("@/lib/skills/panel-actions", () => ({
  listSkillEntries: (...a: unknown[]) => listSkillEntries(...a),
  readSkillFileRpc: vi.fn(),
  writeSkillRpc: vi.fn(),
  deleteSkillRpc: vi.fn(),
}));
vi.mock("@/lib/skills", () => ({
  getEnabledSkillIds: vi.fn().mockResolvedValue([]),
  setSkillEnabled: vi.fn(),
  generateUserSkillId: () => "skill_user_test",
}));
const getConfig = vi.fn();
const setConfig = vi.fn();
vi.mock("@/lib/idb/config-store", () => ({
  getConfig: (...a: unknown[]) => getConfig(...a),
  setConfig: (...a: unknown[]) => setConfig(...a),
}));

function entry(over: Partial<SkillEntry>): SkillEntry {
  return {
    id: "x", name: "x", description: "d", builtIn: false, origin: "disk",
    files: [], runnableScripts: [], ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getConfig.mockResolvedValue(true); // 向导已提示过（Task 7 之前恒 true 不弹）
});
afterEach(cleanup);

describe("SkillsList 副根只读行", () => {
  it("agents 行显示来源 badge，无编辑/删除按钮；pie 行保留", async () => {
    listSkillEntries.mockResolvedValue({
      ok: true,
      skills: [
        entry({ id: "mine", name: "mine", source: "pie" }),
        entry({ id: "shared", name: "shared", source: "agents" }),
      ],
    });
    render(<SkillsList onRunSkill={() => {}} />);
    await waitFor(() => expect(screen.getByText("/shared")).toBeTruthy());
    expect(screen.getByText("~/.agents")).toBeTruthy(); // 来源 badge
    const editButtons = screen.getAllByText("Edit");
    expect(editButtons).toHaveLength(1); // 只有 pie 行有
    expect(screen.getAllByText("Delete")).toHaveLength(1);
  });
});

describe("首连导入向导", () => {
  const twoAgents = {
    ok: true,
    skills: [
      entry({ id: "s1", name: "s1", source: "agents" }),
      entry({ id: "s2", name: "s2", source: "agents" }),
    ],
  };

  it("条件满足（有 agents skill 且未提示过）→ 弹卡", async () => {
    getConfig.mockResolvedValue(undefined); // 未提示过
    listSkillEntries.mockResolvedValue(twoAgents);
    render(<SkillsList onRunSkill={() => {}} />);
    await waitFor(() => expect(screen.getByText(/local skills/i)).toBeTruthy());
  });

  it("已提示过 → 不弹", async () => {
    getConfig.mockResolvedValue(true);
    listSkillEntries.mockResolvedValue(twoAgents);
    render(<SkillsList onRunSkill={() => {}} />);
    await waitFor(() => expect(screen.getByText("/s1")).toBeTruthy());
    expect(screen.queryByText(/local skills/i)).toBeNull();
  });

  it("无 agents skill → 不弹", async () => {
    getConfig.mockResolvedValue(undefined);
    listSkillEntries.mockResolvedValue({ ok: true, skills: [entry({ id: "mine", name: "mine", source: "pie" })] });
    render(<SkillsList onRunSkill={() => {}} />);
    await waitFor(() => expect(screen.getByText("/mine")).toBeTruthy());
    expect(screen.queryByText(/local skills/i)).toBeNull();
  });

  it("勾选 + 确认 → setSkillEnabled(true) × 勾选数 + 落标记", async () => {
    const { setSkillEnabled } = await import("@/lib/skills");
    getConfig.mockResolvedValue(undefined);
    listSkillEntries.mockResolvedValue(twoAgents);
    const { getByText, getAllByRole } = render(<SkillsList onRunSkill={() => {}} />);
    await waitFor(() => expect(getByText(/local skills/i)).toBeTruthy());
    fireEvent.click(getAllByRole("checkbox")[0]); // 勾 s1
    fireEvent.click(getByText("Enable selected"));
    await waitFor(() => expect(setConfig).toHaveBeenCalledWith("agents_import_prompted", true));
    expect(setSkillEnabled).toHaveBeenCalledTimes(1);
    expect(setSkillEnabled).toHaveBeenCalledWith("s1", true);
  });

  it("暂不 → 只落标记，不启用任何 skill", async () => {
    const { setSkillEnabled } = await import("@/lib/skills");
    getConfig.mockResolvedValue(undefined);
    listSkillEntries.mockResolvedValue(twoAgents);
    const { getByText } = render(<SkillsList onRunSkill={() => {}} />);
    await waitFor(() => expect(getByText(/local skills/i)).toBeTruthy());
    fireEvent.click(getByText("Not now"));
    await waitFor(() => expect(setConfig).toHaveBeenCalledWith("agents_import_prompted", true));
    expect(setSkillEnabled).not.toHaveBeenCalled();
  });
});
