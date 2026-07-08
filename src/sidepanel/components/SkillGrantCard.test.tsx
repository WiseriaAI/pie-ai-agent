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
    expect(
      screen.getByText("Read files anywhere on your computer; write only in the skill's workspace"),
    ).toBeTruthy();
    // 2b: empty network list — only the fs perm row renders (no network perm row).
    // （semanticsNote 现在会提到 network「已断」，故断言改为盯 perms 列表项数量，
    // 而非任意 "network" 文本。）
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
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
