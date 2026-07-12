import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SkillGrantCard } from "./SkillGrantCard";

afterEach(() => cleanup());

const PAYLOAD = {
  skillName: "fetch-report",
  description: "Fetches the weekly report",
  scripts: ["fetch.ts", "clean.ts"],
  network: ["api.example.com"],
  write: [],
};

describe("SkillGrantCard", () => {
  it("renders name-in-title, description, scripts and declared domains", () => {
    render(<SkillGrantCard payload={PAYLOAD} onDecision={() => {}} />);
    // title 模板 "{name} asks to run scripts on your computer"
    expect(screen.getByText(/fetch-report asks to run scripts/)).toBeTruthy();
    expect(screen.getByText("Fetches the weekly report")).toBeTruthy();
    expect(screen.getByText("fetch.ts")).toBeTruthy();
    expect(screen.getByText("api.example.com")).toBeTruthy();
  });

  it("shows displayName in the title when present", () => {
    render(
      <SkillGrantCard payload={{ ...PAYLOAD, displayName: "周报抓取" }} onDecision={() => {}} />,
    );
    expect(screen.getByText(/周报抓取 asks to run scripts/)).toBeTruthy();
    expect(screen.queryByText(/fetch-report asks/)).toBeFalsy();
  });

  it("empty network shows the sandbox-blocked line; empty write hides the write block", () => {
    render(<SkillGrantCard payload={{ ...PAYLOAD, network: [] }} onDecision={() => {}} />);
    expect(screen.getByText("None — network is blocked by the default sandbox")).toBeTruthy();
    expect(screen.queryByText("Extra write locations (outside its workspace)")).toBeFalsy();
  });

  it("non-empty write shows the write block", () => {
    render(<SkillGrantCard payload={{ ...PAYLOAD, write: ["/tmp/out"] }} onDecision={() => {}} />);
    expect(screen.getByText("Extra write locations (outside its workspace)")).toBeTruthy();
    expect(screen.getByText("/tmp/out")).toBeTruthy();
  });

  it("allow → onDecision(true), deny → onDecision(false)", () => {
    const onDecision = vi.fn();
    render(<SkillGrantCard payload={PAYLOAD} onDecision={onDecision} />);
    fireEvent.click(screen.getByText("Allow & run"));
    expect(onDecision).toHaveBeenCalledWith(true);
    onDecision.mockClear();
    fireEvent.click(screen.getByText("Deny"));
    expect(onDecision).toHaveBeenCalledWith(false);
  });

  it("warning register: caps label styled text-warning; no tool name in the card", () => {
    const { container } = render(<SkillGrantCard payload={PAYLOAD} onDecision={() => {}} />);
    expect(screen.getByText("Skill authorization").className).toContain("text-warning");
    expect(container.textContent).not.toContain("run_skill_script");
  });
});
