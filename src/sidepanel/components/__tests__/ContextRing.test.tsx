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
          lastBreakdown={{ system: 2_000, tools: 22_000, messages: 100_000 }}
        />
      </MotionProvider>,
    );
  }

  it("popover is closed by default", () => {
    renderRing();
    expect(screen.queryByTestId("context-ring-popover")).toBeNull();
  });

  it("click opens the popover showing the context composition", () => {
    renderRing();
    fireEvent.click(screen.getByTestId("context-ring"));
    const popover = screen.getByTestId("context-ring-popover");
    // Header: current context / window.
    expect(popover.textContent).toContain("124,000 / 200,000");
    // Composition rows sum to the header total; free is the remainder.
    expect(popover.textContent).toContain("2,000");
    expect(popover.textContent).toContain("22,000");
    expect(popover.textContent).toContain("100,000");
    expect(popover.textContent).toContain("76,000");
    // Cumulative cost stays as a single footer row (8,243 + 1,402).
    expect(popover.textContent).toContain("9,645");
  });

  it("omits the composition rows when the SW reported no breakdown", () => {
    render(
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
    fireEvent.click(screen.getByTestId("context-ring"));
    const popover = screen.getByTestId("context-ring-popover");
    expect(popover.textContent).toContain("124,000 / 200,000");
    expect(popover.textContent).toContain("76,000");
    expect(popover.textContent).not.toContain("22,000");
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

describe("ContextRing — cache hit display", () => {
  const baseProps = {
    lastInputTokens: 10_000,
    lastOutputTokens: 500,
    totalInputTokens: 20_000,
    totalOutputTokens: 800,
    maxContextTokens: 200_000,
  };

  it("shows the hit pct inside the ring and a popover row when cache stats exist", () => {
    render(
      <MotionProvider>
        <ContextRing
          {...baseProps}
          lastCachedTokens={8_700}
          lastPromptTotalTokens={10_000}
        />
      </MotionProvider>,
    );
    // Ring center shows the rounded pct (8700/10000 = 87).
    expect(screen.getByTestId("context-ring-cache-pct").textContent).toBe("87");
    // Tooltip carries the hit pct too.
    expect(screen.getByTestId("context-ring").getAttribute("title")).toContain("87%");

    fireEvent.click(screen.getByTestId("context-ring"));
    const popover = screen.getByTestId("context-ring-popover");
    expect(popover.textContent).toContain("87%");
    expect(popover.textContent).toContain("8,700/10,000");
  });

  it("hides cache UI entirely when the provider reports no cache info", () => {
    render(
      <MotionProvider>
        <ContextRing {...baseProps} />
      </MotionProvider>,
    );
    expect(screen.queryByTestId("context-ring-cache-pct")).toBeNull();
    expect(screen.getByTestId("context-ring").getAttribute("title")).not.toContain("87%");

    fireEvent.click(screen.getByTestId("context-ring"));
    const popover = screen.getByTestId("context-ring-popover");
    // Only the three usage rows — no cache row, no stray pct values.
    expect(popover.textContent).not.toContain("87%");
  });

  // Anthropic-wire providers report input_tokens EXCLUDING the cached portion,
  // so the ring must use promptTotalTokens as its numerator — otherwise a 90%
  // cache hit renders as 10% context usage.
  it("sizes the arc by promptTotalTokens, not the cache-excluded inputTokens", () => {
    render(
      <MotionProvider>
        <ContextRing
          {...baseProps}
          lastInputTokens={10_000}
          lastCachedTokens={90_000}
          lastPromptTotalTokens={100_000}
        />
      </MotionProvider>,
    );
    // 100_000 / 200_000 = 50%, not 10_000 / 200_000 = 5%.
    expect(screen.getByTestId("context-ring").getAttribute("title")).toContain("100,000");
    expect(screen.getByTestId("context-ring").getAttribute("title")).toContain("50");
  });

  it("hides cache UI when the denominator is zero", () => {
    render(
      <MotionProvider>
        <ContextRing {...baseProps} lastCachedTokens={0} lastPromptTotalTokens={0} />
      </MotionProvider>,
    );
    expect(screen.queryByTestId("context-ring-cache-pct")).toBeNull();
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
    expect(popover.textContent).toContain("124.000 / 200.000");
    expect(popover.textContent).toContain("76.000");
    expect(popover.textContent).toContain("9.645");
  });
});
