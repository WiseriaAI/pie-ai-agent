import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SkillGrantCard } from "./SkillGrantCard";

afterEach(() => {
  cleanup();
});

const PAYLOAD = {
  skillName: "fetch-report",
  description: "Fetches the weekly report",
  scripts: ["fetch.ts", "clean.ts"],
  network: ["api.example.com"],
  write: [],
};

describe("SkillGrantCard", () => {
  it("renders name, description, scripts and declared domains", () => {
    render(<SkillGrantCard payload={PAYLOAD} onDecision={() => {}} />);
    expect(screen.getByText("fetch-report")).toBeTruthy();
    expect(screen.getByText("Fetches the weekly report")).toBeTruthy();
    expect(screen.getByText("fetch.ts")).toBeTruthy();
    expect(screen.getByText("api.example.com")).toBeTruthy();
  });

  it("shows displayName when present", () => {
    render(
      <SkillGrantCard
        payload={{ ...PAYLOAD, displayName: "周报抓取" }}
        onDecision={() => {}}
      />,
    );
    expect(screen.getByText("周报抓取")).toBeTruthy();
    expect(screen.queryByText("fetch-report")).toBeFalsy();
  });

  it("empty network shows the sandbox-blocked line; empty write hides the write block", () => {
    render(
      <SkillGrantCard payload={{ ...PAYLOAD, network: [] }} onDecision={() => {}} />,
    );
    expect(
      screen.getByText("None — network is blocked by the default sandbox"),
    ).toBeTruthy();
    expect(screen.queryByText("Extra write locations (outside its workspace)")).toBeFalsy();
  });

  it("non-empty write shows the write block", () => {
    render(
      <SkillGrantCard
        payload={{ ...PAYLOAD, write: ["/tmp/out"] }}
        onDecision={() => {}}
      />,
    );
    expect(screen.getByText("Extra write locations (outside its workspace)")).toBeTruthy();
    expect(screen.getByText("/tmp/out")).toBeTruthy();
  });

  it("allow → onDecision(true), deny → onDecision(false)", () => {
    const onDecision = vi.fn();
    render(<SkillGrantCard payload={PAYLOAD} onDecision={onDecision} />);
    fireEvent.click(screen.getByText("Allow"));
    expect(onDecision).toHaveBeenCalledWith(true);
    onDecision.mockClear();
    fireEvent.click(screen.getByText("Deny"));
    expect(onDecision).toHaveBeenCalledWith(false);
  });
});
