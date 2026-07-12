import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  HitlCardShell,
  HitlPrimaryButton,
  HitlSecondaryButton,
  HitlDetailBlock,
  HitlDetailGroup,
} from "./HitlCardShell";

afterEach(() => cleanup());

function renderShell(register: "local" | "browser") {
  return render(
    <HitlCardShell
      register={register}
      icon={<svg data-testid="hitl-icon" />}
      capsLabel="CAPS LABEL"
      title="Card title"
      description="Card description"
      actions={
        <>
          <HitlSecondaryButton onClick={() => {}}>No</HitlSecondaryButton>
          <HitlPrimaryButton register={register} onClick={() => {}}>Yes</HitlPrimaryButton>
        </>
      }
    >
      <HitlDetailBlock>
        <HitlDetailGroup label="Group label">
          <span>group value</span>
        </HitlDetailGroup>
      </HitlDetailBlock>
    </HitlCardShell>,
  );
}

describe("HitlCardShell", () => {
  it("renders caps label, title, description, children and actions", () => {
    renderShell("local");
    expect(screen.getByText("CAPS LABEL")).toBeTruthy();
    expect(screen.getByText("Card title")).toBeTruthy();
    expect(screen.getByText("Card description")).toBeTruthy();
    expect(screen.getByText("Group label")).toBeTruthy();
    expect(screen.getByText("group value")).toBeTruthy();
    expect(screen.getByText("Yes")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();
  });

  it("local register → warning caps + warning primary; browser → accent", () => {
    const { unmount } = renderShell("local");
    expect(screen.getByText("CAPS LABEL").className).toContain("text-warning");
    expect(screen.getByText("Yes").className).toContain("bg-warning");
    unmount();
    renderShell("browser");
    expect(screen.getByText("CAPS LABEL").className).toContain("text-accent");
    expect(screen.getByText("Yes").className).toContain("bg-accent-strong");
  });

  it("neutral card surface — the shell root has no warning tint/border", () => {
    const { container } = renderShell("local");
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("bg-surface");
    expect(root.className).toContain("border-line");
    expect(root.className).not.toContain("bg-warning-tint");
  });

  it("buttons fire onClick", () => {
    const onYes = vi.fn();
    render(
      <HitlCardShell
        register="browser"
        icon={<svg />}
        capsLabel="L"
        title="T"
        actions={<HitlPrimaryButton register="browser" onClick={onYes}>Go</HitlPrimaryButton>}
      />,
    );
    fireEvent.click(screen.getByText("Go"));
    expect(onYes).toHaveBeenCalledTimes(1);
  });
});
