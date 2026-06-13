import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { I18nProvider, STORAGE_KEY_UI_LOCALE } from "@/lib/i18n";
import { setConfig } from "@/lib/idb/config-store";
import { _resetForTests } from "@/lib/idb/db";
import ScheduleRunHistory from "./ScheduleRunHistory";
import type { ScheduleRunRecord } from "@/lib/schedules/types";

// Mock the store getRun used to hydrate the run list.
const runs = new Map<string, ScheduleRunRecord>();
vi.mock("@/lib/schedules/store", () => ({
  getRun: vi.fn(async (id: string) => runs.get(id) ?? null),
  updateRun: vi.fn(async () => {}),
}));

import { getRun, updateRun } from "@/lib/schedules/store";

function makeRun(o: Partial<ScheduleRunRecord> & { recordId: string }): ScheduleRunRecord {
  return {
    scheduleId: "sched_1",
    runIndex: 1,
    startedAt: Date.UTC(2026, 5, 12, 9, 0, 0),
    status: "success",
    ...o,
  };
}

beforeEach(async () => {
  await _resetForTests();
  runs.clear();
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("ScheduleRunHistory", () => {
  it("renders runs with index and outcome", async () => {
    runs.set("run_a", makeRun({ recordId: "run_a", runIndex: 2, status: "failed", summary: "boom" }));
    render(<ScheduleRunHistory runIds={["run_a"]} onOpenSession={vi.fn()} />);
    await screen.findByText(/boom/i);
    expect(screen.getByText(/failed/i)).toBeTruthy();
    expect(screen.getByText(/#2/)).toBeTruthy();
  });

  it("highlights an unread run", async () => {
    runs.set("run_u", makeRun({ recordId: "run_u", unread: true, sessionId: "sess_1" }));
    render(<ScheduleRunHistory runIds={["run_u"]} onOpenSession={vi.fn()} />);
    const row = await screen.findByTestId("run-row-run_u");
    expect(row.getAttribute("data-unread")).toBe("true");
  });

  it("clicking a run with a session opens it and clears unread", async () => {
    const onOpenSession = vi.fn();
    runs.set("run_o", makeRun({ recordId: "run_o", unread: true, sessionId: "sess_42" }));
    render(<ScheduleRunHistory runIds={["run_o"]} onOpenSession={onOpenSession} />);
    const row = await screen.findByTestId("run-row-run_o");
    fireEvent.click(row);
    expect(onOpenSession).toHaveBeenCalledWith("sess_42");
    await waitFor(() => expect(updateRun).toHaveBeenCalledWith("run_o", { unread: false }));
  });

  it("shows an empty state when there are no runs", async () => {
    render(<ScheduleRunHistory runIds={[]} onOpenSession={vi.fn()} />);
    expect(await screen.findByText(/no runs yet/i)).toBeTruthy();
  });

  it("does not call getRun for an empty list", async () => {
    render(<ScheduleRunHistory runIds={[]} onOpenSession={vi.fn()} />);
    await waitFor(() => expect(getRun).not.toHaveBeenCalled());
  });

  it("formats run index with the effective locale", async () => {
    await setConfig(STORAGE_KEY_UI_LOCALE, "pt-BR");
    runs.set("run_locale", makeRun({ recordId: "run_locale", runIndex: 1234 }));

    render(
      <I18nProvider>
        <ScheduleRunHistory runIds={["run_locale"]} onOpenSession={vi.fn()} />
      </I18nProvider>,
    );

    expect(await screen.findByText("#1.234")).toBeTruthy();
  });
});
