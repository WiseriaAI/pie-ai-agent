/**
 * SkillsList — v1.5 per-call approval badge tests
 *
 * The badge renders on any SkillRow whose allowedTools includes "open_url".
 * These tests mock the async loaders so the component can render without
 * real chrome.storage or provider config.
 */

import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import SkillsList from "./SkillsList";

// ── Mock storage + provider deps so component mounts without chrome.storage ──

vi.mock("@/lib/storage", () => ({
  getActiveProvider: vi.fn().mockResolvedValue("anthropic"),
}));

vi.mock("@/lib/model-router/providers/registry", () => ({
  getProviderMeta: vi.fn().mockReturnValue({ supportsVision: true }),
}));

vi.mock("@/lib/skills", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/skills")>();
  return {
    ...original,
    getAllSkills: vi.fn().mockResolvedValue([]),
    getEnabledSkillIds: vi.fn().mockResolvedValue([]),
    getSkillStorageBytes: vi.fn().mockResolvedValue(0),
    setSkillEnabled: vi.fn().mockResolvedValue(undefined),
    saveSkill: vi.fn().mockResolvedValue(undefined),
    deleteSkill: vi.fn().mockResolvedValue(undefined),
  };
});

// Grab the mocked getAllSkills so individual tests can override it.
import { getAllSkills } from "@/lib/skills";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SkillsList — open_url per-call approval badge", () => {
  it("shows per-call approval badge when skill includes open_url in allowedTools", async () => {
    (getAllSkills as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "s1",
        name: "Research helper",
        description: "Browses the web for the user",
        allowedTools: ["list_tabs", "get_tab_content", "open_url"],
        toolSchema: { parameters: { type: "object", properties: {}, required: [] } },
        promptTemplate: "Do research",
        enabled: true,
        builtIn: false,
        author: "user",
        createdAt: Date.now(),
      },
    ]);

    render(<SkillsList onRunSkill={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/per-call approval/i)).toBeTruthy();
    });
  });

  it("omits the badge when skill does NOT include open_url in allowedTools", async () => {
    (getAllSkills as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "s2",
        name: "Reader",
        description: "Reads tabs for the user",
        allowedTools: ["list_tabs", "get_tab_content"],
        toolSchema: { parameters: { type: "object", properties: {}, required: [] } },
        promptTemplate: "Read content",
        enabled: true,
        builtIn: false,
        author: "user",
        createdAt: Date.now(),
      },
    ]);

    render(<SkillsList onRunSkill={vi.fn()} />);

    // Wait for the async loadSkills to render the skill row (the description is
    // shown as plain text, whereas the name is rendered as "/reader" in a <code>).
    await waitFor(() => {
      expect(screen.getByText("Reads tabs for the user")).toBeTruthy();
    });

    expect(screen.queryByText(/per-call approval/i)).toBeNull();
  });
});
