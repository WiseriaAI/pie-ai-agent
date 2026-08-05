import { render, screen, act, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import AgentSummary from "./AgentSummary";
import { I18nProvider, STORAGE_KEY_UI_LOCALE } from "@/lib/i18n";
import { setConfig } from "@/lib/idb/config-store";
import { publishChange } from "@/lib/store-bus";
import { _resetForTests } from "@/lib/idb/db";

afterEach(() => {
  cleanup();
});

describe("AgentSummary Pie face", () => {
  it("默认渲染静止脸（无动画）", () => {
    const { container } = render(
      <AgentSummary success={true} summary="done" stepCount={2} />,
    );
    expect(container.querySelector('[data-pie-state="static"]')).toBeTruthy();
    expect(container.innerHTML).not.toContain("pie-hop");
  });

  it("celebrating + success → success 态脸", () => {
    const { container } = render(
      <AgentSummary success={true} summary="done" stepCount={2} celebrating />,
    );
    expect(container.querySelector('[data-pie-state="success"]')).toBeTruthy();
  });

  it("celebrating 但 success=false → 仍静止（失败不庆祝），warning 文字保留", () => {
    const { container } = render(
      <AgentSummary success={false} summary="failed" stepCount={2} celebrating />,
    );
    expect(container.querySelector('[data-pie-state="static"]')).toBeTruthy();
    expect(container.querySelector(".text-warning")).toBeTruthy();
  });
});

describe("AgentSummary abort summaryKey (#354)", () => {
  beforeEach(async () => {
    await _resetForTests();
  });

  function renderSummary(props: Parameters<typeof AgentSummary>[0]) {
    return render(
      <I18nProvider>
        <AgentSummary {...props} />
      </I18nProvider>,
    );
  }

  it("renders the English abort text by default when summaryKey is set", async () => {
    renderSummary({
      success: false,
      // Stale raw fallback — the key must win, so this text is NOT shown.
      summary: "任务已取消",
      summaryKey: "agentSummary.abort.stopped",
      stepCount: 2,
    });
    await waitFor(() => expect(screen.getByText("Task stopped.")).toBeTruthy());
    expect(screen.queryByText("任务已取消")).toBeNull();
  });

  it("re-renders the abort text in Chinese after a locale switch", async () => {
    renderSummary({
      success: false,
      summary: "Task stopped.",
      summaryKey: "agentSummary.abort.stopped",
      stepCount: 2,
    });
    await waitFor(() => expect(screen.getByText("Task stopped.")).toBeTruthy());

    await act(async () => {
      await setConfig(STORAGE_KEY_UI_LOCALE, "zh-CN");
      publishChange("config", "put", STORAGE_KEY_UI_LOCALE);
    });

    await waitFor(() => expect(screen.getByText("任务已取消")).toBeTruthy());
    expect(screen.queryByText("Task stopped.")).toBeNull();
  });

  it("renders the raw summary verbatim when no summaryKey is set (LLM output)", async () => {
    renderSummary({
      success: true,
      summary: "Found the price: $42",
      stepCount: 3,
    });
    await waitFor(() =>
      expect(screen.getByText("Found the price: $42")).toBeTruthy(),
    );
  });
});
