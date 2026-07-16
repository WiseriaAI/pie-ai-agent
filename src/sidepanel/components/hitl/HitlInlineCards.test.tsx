import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { HitlInlineCards } from "./HitlInlineCards";

afterEach(() => cleanup());

const base = { instances: [], onChooseLocalFile: vi.fn() };

describe("HitlInlineCards", () => {
  it("renders nothing when request is null", () => {
    const { container } = render(<HitlInlineCards request={null} respond={vi.fn()} {...base} />);
    expect(container.textContent).toBe("");
  });

  it("skill-grant kind renders SkillGrantCard and resolves via respond", () => {
    const respond = vi.fn();
    render(
      <HitlInlineCards
        request={{
          requestId: "r1",
          kind: "skill-grant",
          payload: { skillName: "s1", description: "d", scripts: ["a.ts"], network: [], write: [] },
        }}
        respond={respond}
        {...base}
      />,
    );
    fireEvent.click(screen.getByText("Allow & run"));
    expect(respond).toHaveBeenCalledWith("r1", { ok: true, data: true });
  });

  it("run-local-agent kind resolves ok:true data:null on deny", () => {
    const respond = vi.fn();
    render(
      <HitlInlineCards
        request={{
          requestId: "r2",
          kind: "run-local-agent",
          payload: { prompt: "p", cwd: "/w", agents: [{ id: "claude-terminal", label: "Claude Code (Terminal)" }] },
        }}
        respond={respond}
        {...base}
      />,
    );
    fireEvent.click(screen.getByText("Deny"));
    expect(respond).toHaveBeenCalledWith("r2", { ok: true, data: null });
  });

  it("run-local-agent kind resolves with the picked backend id on allow", () => {
    const respond = vi.fn();
    render(
      <HitlInlineCards
        request={{
          requestId: "r2b",
          kind: "run-local-agent",
          payload: {
            prompt: "p",
            cwd: "/w",
            agents: [
              { id: "claude-terminal", label: "Claude Code (Terminal)" },
              { id: "codex-terminal", label: "Codex (Terminal)" },
            ],
          },
        }}
        respond={respond}
        {...base}
      />,
    );
    // 展开后端下拉（触发器显示默认选中）→ 选 Codex
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    fireEvent.click(screen.getByRole("option", { name: /Codex/ }));
    fireEvent.click(screen.getByText("Allow & run"));
    expect(respond).toHaveBeenCalledWith("r2b", { ok: true, data: "codex-terminal" });
  });

  it("handoff kind resolves with the picked agent id", () => {
    const respond = vi.fn();
    render(
      <HitlInlineCards
        request={{
          requestId: "r3",
          kind: "handoff-to-agent",
          payload: { context: "ctx", fileCount: 0, agents: [{ id: "claude-app", label: "Claude Code (App)" }] },
        }}
        respond={respond}
        {...base}
      />,
    );
    fireEvent.click(screen.getByText("Hand off"));
    expect(respond).toHaveBeenCalledWith("r3", { ok: true, data: "claude-app" });
  });

  it("local-file kind: choose routes to onChooseLocalFile; cancel resolves ok:false", () => {
    const respond = vi.fn();
    const onChooseLocalFile = vi.fn();
    render(
      <HitlInlineCards
        request={{ requestId: "r4", kind: "local-file", payload: undefined }}
        respond={respond}
        instances={[]}
        onChooseLocalFile={onChooseLocalFile}
      />,
    );
    fireEvent.click(screen.getByText(/Choose file/));
    expect(onChooseLocalFile).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText(/Cancel/));
    expect(respond).toHaveBeenCalledWith("r4", { ok: false, reason: "cancelled by user" });
  });

  it("cdp-consent kind resolves ok:true data:true on enable", () => {
    const respond = vi.fn();
    render(
      <HitlInlineCards
        request={{ requestId: "r5", kind: "cdp-consent", payload: undefined }}
        respond={respond}
        {...base}
      />,
    );
    fireEvent.click(screen.getByText("Enable"));
    expect(respond).toHaveBeenCalledWith("r5", { ok: true, data: true });
  });
});
