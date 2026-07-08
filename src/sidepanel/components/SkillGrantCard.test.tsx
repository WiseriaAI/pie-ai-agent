import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SkillGrantCard } from "./SkillGrantCard";

afterEach(() => {
  cleanup();
});

describe("SkillGrantCard", () => {
  it("renders skillName + entry verbatim, and fs perm line", () => {
    render(
      <SkillGrantCard
        payload={{
          skillId: "my-skill",
          skillName: "My Skill",
          entry: "scripts/run.ts",
          perms: { fs: true, network: [] },
        }}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByText("My Skill")).toBeTruthy();
    expect(screen.getByText("scripts/run.ts")).toBeTruthy();
    expect(screen.getByText("Read and write files in the skill's workspace")).toBeTruthy();
    // 2b: empty network list — no network row rendered
    expect(screen.queryByText(/network/i)).toBeNull();
  });

  it("allow calls onDecision(true)", () => {
    const onDecision = vi.fn();
    render(
      <SkillGrantCard
        payload={{
          skillId: "my-skill",
          skillName: "My Skill",
          entry: "scripts/run.ts",
          perms: { fs: true, network: [] },
        }}
        onDecision={onDecision}
      />,
    );
    fireEvent.click(screen.getByText("Allow"));
    expect(onDecision).toHaveBeenCalledWith(true);
  });

  it("deny calls onDecision(false)", () => {
    const onDecision = vi.fn();
    render(
      <SkillGrantCard
        payload={{
          skillId: "my-skill",
          skillName: "My Skill",
          entry: "scripts/run.ts",
          perms: { fs: true, network: [] },
        }}
        onDecision={onDecision}
      />,
    );
    fireEvent.click(screen.getByText("Deny"));
    expect(onDecision).toHaveBeenCalledWith(false);
  });
});
