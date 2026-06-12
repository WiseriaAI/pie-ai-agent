import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import SchedulesPanel from "./SchedulesPanel";
import type { ScheduleRecord } from "@/lib/schedules/types";
import type { DecryptedInstance } from "@/lib/instances";

// ── Mocks ──────────────────────────────────────────────────────────────────
const schedules: ScheduleRecord[] = [];
vi.mock("@/lib/schedules/store", () => ({
  listSchedules: vi.fn(async () => schedules.slice()),
  getRun: vi.fn(async () => null),
  updateRun: vi.fn(async () => {}),
}));

const actionMocks = vi.hoisted(() => ({
  createSchedule: vi.fn(async () => ({ ok: true, id: "sched_new" })),
  updateSchedule: vi.fn(async () => ({ ok: true })),
  deleteSchedule: vi.fn(async () => ({ ok: true })),
  toggleSchedule: vi.fn(async () => ({ ok: true })),
  runScheduleNow: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/schedules/panel-actions", () => actionMocks);

vi.mock("@/lib/instances", () => ({
  listInstances: vi.fn(async (): Promise<DecryptedInstance[]> => [
    { id: "inst_1", provider: "anthropic", nickname: "Claude", apiKey: "k", createdAt: 1 },
  ]),
  getActiveInstance: vi.fn(async () => "inst_1"),
}));

// store-bus subscription — return an unsubscribe noop.
vi.mock("@/lib/store-bus", () => ({
  onStoreChange: vi.fn(() => () => {}),
}));

import { listSchedules } from "@/lib/schedules/store";

function makeSched(o: Partial<ScheduleRecord> & { id: string }): ScheduleRecord {
  return {
    title: "My schedule",
    prompt: "do stuff",
    spec: { intervalMinutes: 60, maxRuns: 3 },
    instanceId: "inst_1",
    enabled: true,
    status: "active",
    createdAt: 1,
    runCount: 1,
    consecutiveFailures: 0,
    runIds: [],
    ...o,
  };
}

beforeEach(() => {
  schedules.length = 0;
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("SchedulesPanel", () => {
  it("shows an empty state when there are no schedules", async () => {
    render(<SchedulesPanel onOpenSession={vi.fn()} />);
    expect(await screen.findByText(/no schedules/i)).toBeTruthy();
  });

  it("lists schedules with title and run summary", async () => {
    schedules.push(makeSched({ id: "sched_1", title: "Daily digest" }));
    render(<SchedulesPanel onOpenSession={vi.fn()} />);
    expect(await screen.findByText("Daily digest")).toBeTruthy();
    expect(listSchedules).toHaveBeenCalled();
  });

  it("active 但 enabled=false → badge 显示 disabled（而非 active）", async () => {
    schedules.push(makeSched({ id: "sched_1", status: "active", enabled: false }));
    render(<SchedulesPanel onOpenSession={vi.fn()} />);
    // i18n labels (English fallback dict outside I18nProvider).
    expect(await screen.findByText("Disabled")).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
  });

  it("paused + enabled=true（系统自动暂停，未被用户关闭）→ 显示 paused", async () => {
    schedules.push(makeSched({ id: "sched_p", status: "paused", enabled: true }));
    render(<SchedulesPanel onOpenSession={vi.fn()} />);
    expect(await screen.findByText("Paused")).toBeTruthy();
    expect(screen.queryByText("Disabled")).toBeNull();
  });

  it("用户关闭优先级最高：completed/paused + enabled=false 都显示 disabled", async () => {
    schedules.push(makeSched({ id: "sched_c", status: "completed", enabled: false }));
    schedules.push(makeSched({ id: "sched_p2", status: "paused", enabled: false }));
    render(<SchedulesPanel onOpenSession={vi.fn()} />);
    expect(await screen.findAllByText("Disabled")).toHaveLength(2);
    expect(screen.queryByText("Completed")).toBeNull();
    expect(screen.queryByText("Paused")).toBeNull();
  });

  it("toggle switch calls toggleSchedule with the negated enabled", async () => {
    schedules.push(makeSched({ id: "sched_1", enabled: true }));
    render(<SchedulesPanel onOpenSession={vi.fn()} />);
    await screen.findByText("My schedule");
    fireEvent.click(screen.getByTestId("toggle-sched_1"));
    await waitFor(() => expect(actionMocks.toggleSchedule).toHaveBeenCalledWith("sched_1", false));
  });

  it("run-now button calls runScheduleNow", async () => {
    schedules.push(makeSched({ id: "sched_1" }));
    render(<SchedulesPanel onOpenSession={vi.fn()} />);
    await screen.findByText("My schedule");
    fireEvent.click(screen.getByTestId("runnow-sched_1"));
    await waitFor(() => expect(actionMocks.runScheduleNow).toHaveBeenCalledWith("sched_1"));
  });

  it("delete asks for confirm then calls deleteSchedule", async () => {
    schedules.push(makeSched({ id: "sched_1" }));
    render(<SchedulesPanel onOpenSession={vi.fn()} />);
    await screen.findByText("My schedule");
    fireEvent.click(screen.getByTestId("delete-sched_1"));
    // confirm button appears
    const confirm = await screen.findByTestId("delete-confirm-sched_1");
    fireEvent.click(confirm);
    await waitFor(() => expect(actionMocks.deleteSchedule).toHaveBeenCalledWith("sched_1"));
  });

  it("New schedule first offers a choice (manual vs chat) instead of the form", async () => {
    render(<SchedulesPanel onOpenSession={vi.fn()} />);
    await screen.findByText(/no schedules/i);
    fireEvent.click(screen.getByRole("button", { name: /new schedule/i }));
    // The choice menu appears; the form does NOT open yet.
    expect(await screen.findByTestId("new-schedule-choice")).toBeTruthy();
    expect(screen.queryByLabelText(/title/i)).toBeNull();
  });

  it("choosing 'fill in the form' opens the create form and submits through createSchedule", async () => {
    render(<SchedulesPanel onOpenSession={vi.fn()} />);
    await screen.findByText(/no schedules/i);
    fireEvent.click(screen.getByRole("button", { name: /new schedule/i }));
    fireEvent.click(await screen.findByTestId("new-choice-manual"));
    fireEvent.change(await screen.findByLabelText(/title/i), { target: { value: "Hourly" } });
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: "check feeds" } });
    fireEvent.change(screen.getByLabelText(/interval/i), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: /create schedule/i }));
    await waitFor(() => expect(actionMocks.createSchedule).toHaveBeenCalledTimes(1));
  });

  it("choosing 'describe it in chat' calls onCreateViaChat with the localized template and does not open the form", async () => {
    const onCreateViaChat = vi.fn();
    render(<SchedulesPanel onOpenSession={vi.fn()} onCreateViaChat={onCreateViaChat} />);
    await screen.findByText(/no schedules/i);
    fireEvent.click(screen.getByRole("button", { name: /new schedule/i }));
    fireEvent.click(await screen.findByTestId("new-choice-chat"));
    expect(onCreateViaChat).toHaveBeenCalledTimes(1);
    // The template is passed through (English fallback dict outside I18nProvider).
    expect(onCreateViaChat.mock.calls[0]![0]).toMatch(/scheduled task/i);
    // Form must NOT have opened.
    expect(screen.queryByLabelText(/title/i)).toBeNull();
    expect(actionMocks.createSchedule).not.toHaveBeenCalled();
  });
});
