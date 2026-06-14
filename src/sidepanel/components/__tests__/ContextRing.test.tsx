import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  waitForElementToBeRemoved,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, STORAGE_KEY_UI_LOCALE } from "@/lib/i18n";
import { setConfig } from "@/lib/idb/config-store";
import { _resetForTests } from "@/lib/idb/db";
import { MotionProvider } from "../ui/motion";
import ContextRing from "../ContextRing";

afterEach(cleanup);

beforeEach(async () => {
  await _resetForTests();
});

describe("ContextRing — render gates (#59)", () => {
  it("renders nothing when lastInputTokens is undefined", () => {
    const { container } = render(
      <ContextRing
        lastInputTokens={undefined}
        lastOutputTokens={undefined}
        totalInputTokens={0}
        totalOutputTokens={0}
        maxContextTokens={200_000}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when lastInputTokens is 0", () => {
    const { container } = render(
      <ContextRing
        lastInputTokens={0}
        lastOutputTokens={0}
        totalInputTokens={0}
        totalOutputTokens={0}
        maxContextTokens={200_000}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when maxContextTokens is missing", () => {
    const { container } = render(
      <ContextRing
        lastInputTokens={1000}
        lastOutputTokens={50}
        totalInputTokens={1000}
        totalOutputTokens={50}
        maxContextTokens={undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the ring when usage and max are present", () => {
    render(
      <ContextRing
        lastInputTokens={1000}
        lastOutputTokens={50}
        totalInputTokens={1000}
        totalOutputTokens={50}
        maxContextTokens={200_000}
      />,
    );
    expect(screen.getByTestId("context-ring")).toBeTruthy();
  });
});

describe("ContextRing — color thresholds", () => {
  function getStroke(): string | null {
    const ring = screen.getByTestId("context-ring");
    const circles = ring.querySelectorAll("circle");
    return circles[1]?.getAttribute("stroke") ?? null;
  }

  it("uses slate color below 60%", () => {
    render(
      <ContextRing
        lastInputTokens={48_000}
        lastOutputTokens={500}
        totalInputTokens={48_000}
        totalOutputTokens={500}
        maxContextTokens={200_000}
      />,
    );
    expect(getStroke()).toBe("#6E767D");
  });

  it("uses amber color in [60%, 80%)", () => {
    render(
      <ContextRing
        lastInputTokens={124_000}
        lastOutputTokens={1400}
        totalInputTokens={124_000}
        totalOutputTokens={1400}
        maxContextTokens={200_000}
      />,
    );
    expect(getStroke()).toBe("#E07A4A");
  });

  it("uses red color at or above 80%", () => {
    render(
      <ContextRing
        lastInputTokens={174_000}
        lastOutputTokens={1400}
        totalInputTokens={174_000}
        totalOutputTokens={1400}
        maxContextTokens={200_000}
      />,
    );
    expect(getStroke()).toBe("#D9544A");
  });
});

describe("ContextRing — popover interaction", () => {
  function renderRing() {
    return render(
      <MotionProvider>
        <ContextRing
          lastInputTokens={124_000}
          lastOutputTokens={1400}
          totalInputTokens={8_243}
          totalOutputTokens={1_402}
          maxContextTokens={200_000}
        />
      </MotionProvider>,
    );
  }

  it("popover is closed by default", () => {
    renderRing();
    expect(screen.queryByTestId("context-ring-popover")).toBeNull();
  });

  it("click opens the popover with the three rows", () => {
    renderRing();
    fireEvent.click(screen.getByTestId("context-ring"));
    const popover = screen.getByTestId("context-ring-popover");
    expect(popover.textContent).toContain("8,243");
    expect(popover.textContent).toContain("1,402");
    expect(popover.textContent).toContain("9,645");
  });

  it("ESC closes the popover", async () => {
    renderRing();
    fireEvent.click(screen.getByTestId("context-ring"));
    expect(screen.queryByTestId("context-ring-popover")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    // DropdownPanel animates out then unmounts (AnimatePresence) — await removal.
    await waitForElementToBeRemoved(() =>
      screen.queryByTestId("context-ring-popover"),
    );
  });

  it("second click on ring closes the popover (toggle)", async () => {
    renderRing();
    fireEvent.click(screen.getByTestId("context-ring"));
    fireEvent.click(screen.getByTestId("context-ring"));
    await waitForElementToBeRemoved(() =>
      screen.queryByTestId("context-ring-popover"),
    );
  });

  it("click outside closes the popover", async () => {
    render(
      <MotionProvider>
        <div>
          <button data-testid="outside-button">outside</button>
          <ContextRing
            lastInputTokens={124_000}
            lastOutputTokens={1400}
            totalInputTokens={8_243}
            totalOutputTokens={1_402}
            maxContextTokens={200_000}
          />
        </div>
      </MotionProvider>,
    );
    fireEvent.click(screen.getByTestId("context-ring"));
    expect(screen.queryByTestId("context-ring-popover")).not.toBeNull();
    // Wait a tick so the deferred listener registration happens.
    await new Promise((resolve) => setTimeout(resolve, 10));
    fireEvent.mouseDown(screen.getByTestId("outside-button"));
    await waitForElementToBeRemoved(() =>
      screen.queryByTestId("context-ring-popover"),
    );
  });
});

describe("ContextRing — locale formatting", () => {
  it("formats tooltip and popover numbers with the effective locale", async () => {
    await setConfig(STORAGE_KEY_UI_LOCALE, "pt-BR");
    render(
      <MotionProvider>
        <I18nProvider>
          <ContextRing
            lastInputTokens={124_000}
            lastOutputTokens={1400}
            totalInputTokens={8_243}
            totalOutputTokens={1_402}
            maxContextTokens={200_000}
          />
        </I18nProvider>
      </MotionProvider>,
    );

    const ring = await screen.findByTestId("context-ring");
    await waitFor(() => expect(ring.getAttribute("title")).toContain("124.000"));
    expect(ring.getAttribute("title")).toContain("200.000");

    fireEvent.click(ring);
    const popover = screen.getByTestId("context-ring-popover");
    expect(popover.textContent).toContain("8.243");
    expect(popover.textContent).toContain("1.402");
    expect(popover.textContent).toContain("9.645");
  });
});
