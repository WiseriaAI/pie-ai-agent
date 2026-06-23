/**
 * SessionDrawer — M2-U2 component tests
 *
 * Tests cover:
 * - Drawer renders only when isOpen=true
 * - Session rows render for each entry
 * - Resume button click fires onResumeSession(id)
 * - Select row fires onSelectSession(id) + onClose
 * - ESC key closes the drawer
 * - aria attributes (role=dialog, aria-modal, aria-label)
 * - Row aria-label contains title, status, and time text
 * - Backdrop click closes the drawer
 * - Storage indicator renders (progress bar and label)
 */

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chromeMock } from "@/test/setup";
import SessionDrawer from "./SessionDrawer";
import SessionConfirmCard from "./SessionConfirmCard";
import type { SessionIndexEntry } from "@/lib/sessions/types";
import type { PinnedTabDriftPayload } from "@/types";
import * as lifecycle from "@/lib/sessions/lifecycle";

vi.mock("@/lib/sessions/lifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sessions/lifecycle")>();
  return { ...actual, hardDeleteAllArchived: vi.fn(async () => ({ deleted: 2 })) };
});

// Helper to build a minimal SessionIndexEntry
function makeEntry(
  id: string,
  status: SessionIndexEntry["status"],
  title?: string,
): SessionIndexEntry {
  return {
    id,
    lastAccessedAt: Date.now() - 60_000,
    status,
    title,
  };
}

const BASE_PROPS = {
  isOpen: true,
  onClose: vi.fn(),
  sessions: [] as SessionIndexEntry[],
  activeSessionId: null as string | null,
  onSelectSession: vi.fn(),
  onResumeSession: vi.fn(),
};

beforeEach(() => {
  BASE_PROPS.onClose.mockReset();
  BASE_PROPS.onSelectSession.mockReset();
  BASE_PROPS.onResumeSession.mockReset();
  // onChanged listeners are reset by the global beforeEach in setup.ts
  // (local.__changedListeners = [])
});

afterEach(() => {
  cleanup();
});

describe("SessionDrawer — visibility", () => {
  it("does not render content when isOpen=false", () => {
    render(<SessionDrawer {...BASE_PROPS} isOpen={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders dialog when isOpen=true", () => {
    render(<SessionDrawer {...BASE_PROPS} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("has aria-modal=true and aria-label='Sessions'", () => {
    render(<SessionDrawer {...BASE_PROPS} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Sessions");
  });
});

describe("SessionDrawer — session rows", () => {
  it("renders one row per entry", () => {
    const sessions = [
      makeEntry("s1", "active", "Session Alpha"),
      makeEntry("s2", "paused", "Session Beta"),
      makeEntry("s3", "failed", "Session Gamma"),
    ];
    render(<SessionDrawer {...BASE_PROPS} sessions={sessions} />);
    expect(screen.getByText("Session Alpha")).toBeTruthy();
    expect(screen.getByText("Session Beta")).toBeTruthy();
    expect(screen.getByText("Session Gamma")).toBeTruthy();
  });

  it("renders resume button for paused sessions", () => {
    const sessions = [makeEntry("s1", "paused", "Paused Session")];
    render(<SessionDrawer {...BASE_PROPS} sessions={sessions} />);
    expect(screen.getByText(/Resume/)).toBeTruthy();
  });

  it("does not render resume button for active sessions", () => {
    const sessions = [makeEntry("s1", "active", "Active Session")];
    render(<SessionDrawer {...BASE_PROPS} sessions={sessions} />);
    expect(screen.queryByText(/Resume/)).toBeNull();
  });

  it("renders all rows in a list element", () => {
    const sessions = [
      makeEntry("s1", "active", "S1"),
      makeEntry("s2", "active", "S2"),
    ];
    render(<SessionDrawer {...BASE_PROPS} sessions={sessions} />);
    const list = screen.getByRole("list");
    expect(list).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBe(2);
  });
});

describe("SessionDrawer — interactions", () => {
  it("calls onResumeSession with sessionId when Resume is clicked", () => {
    const sessions = [makeEntry("s1", "paused", "My Session")];
    render(<SessionDrawer {...BASE_PROPS} sessions={sessions} />);
    fireEvent.click(screen.getByText(/Resume/));
    expect(BASE_PROPS.onResumeSession).toHaveBeenCalledWith("s1");
  });

  it("calls onSelectSession and onClose when a row title is clicked", () => {
    const sessions = [makeEntry("s1", "active", "Clickable Session")];
    render(<SessionDrawer {...BASE_PROPS} sessions={sessions} />);
    // Click the list item directly (not via title text which is inside a span)
    const item = screen.getByRole("listitem");
    fireEvent.click(item);
    expect(BASE_PROPS.onSelectSession).toHaveBeenCalledWith("s1");
    expect(BASE_PROPS.onClose).toHaveBeenCalled();
  });

  it("calls onClose when backdrop is clicked", () => {
    render(<SessionDrawer {...BASE_PROPS} sessions={[]} />);
    const backdrop = document.querySelector("[data-testid='drawer-backdrop']");
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(BASE_PROPS.onClose).toHaveBeenCalled();
  });

  it("calls onClose when ESC is pressed", () => {
    render(<SessionDrawer {...BASE_PROPS} />);
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    expect(BASE_PROPS.onClose).toHaveBeenCalled();
  });

  it("does not call onSelectSession when Resume button is clicked", () => {
    const sessions = [makeEntry("s1", "paused", "My Session")];
    render(<SessionDrawer {...BASE_PROPS} sessions={sessions} />);
    fireEvent.click(screen.getByText(/Resume/));
    // onSelectSession should NOT have been called (only onResumeSession)
    expect(BASE_PROPS.onSelectSession).not.toHaveBeenCalled();
  });
});

describe("SessionDrawer — a11y", () => {
  it("row aria-label contains title and status", () => {
    const sessions = [makeEntry("s1", "paused", "My Paused Task")];
    render(<SessionDrawer {...BASE_PROPS} sessions={sessions} />);
    // Find a listitem with aria-label containing title and status
    const listItems = screen.getAllByRole("listitem");
    const item = listItems.find(
      (el) =>
        el.getAttribute("aria-label")?.includes("My Paused Task") &&
        el.getAttribute("aria-label")?.toLowerCase().includes("paused"),
    );
    expect(item).toBeTruthy();
  });

  it("active session row aria-label includes 'active'", () => {
    const sessions = [makeEntry("s1", "active", "Active Session")];
    render(
      <SessionDrawer
        {...BASE_PROPS}
        sessions={sessions}
        activeSessionId="s1"
      />,
    );
    const listItems = screen.getAllByRole("listitem");
    const item = listItems.find((el) =>
      el.getAttribute("aria-label")?.includes("Active Session"),
    );
    expect(item?.getAttribute("aria-label")).toContain("active");
  });

  it("failed session row aria-label includes 'failed'", () => {
    const sessions = [makeEntry("s1", "failed", "Failed Task")];
    render(<SessionDrawer {...BASE_PROPS} sessions={sessions} />);
    const listItems = screen.getAllByRole("listitem");
    const item = listItems.find((el) =>
      el.getAttribute("aria-label")?.includes("Failed Task"),
    );
    expect(item?.getAttribute("aria-label")).toContain("failed");
  });
});

describe("SessionDrawer — storage indicator", () => {
  it("renders raw usage label (no progressbar)", () => {
    render(<SessionDrawer {...BASE_PROPS} />);
    // Progress bar is removed; a plain "X MB" usage span is shown instead.
    expect(screen.queryByRole("progressbar")).toBeNull();
    // The storage label is rendered via aria-label="Storage" span.
    const storageLabel = document.querySelector("[aria-label='Storage']");
    expect(storageLabel).toBeTruthy();
    // Usage value contains "MB"
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/MB/);
  });
});

describe("SessionDrawer — header", () => {
  it("shows active session count in header", () => {
    const sessions = [
      makeEntry("s1", "active", "S1"),
      makeEntry("s2", "paused", "S2"),
    ];
    render(<SessionDrawer {...BASE_PROPS} sessions={sessions} />);
    // Count "2" is displayed — find by aria-label on the count span
    const countEl = document.querySelector("[aria-label='2 sessions']");
    expect(countEl).toBeTruthy();
  });
});

describe("SessionConfirmCard — R14 drift card (image-bearing failed session)", () => {
  // R14: when a session that carried image attachments is force-transitioned to
  // `failed` (R14 path from Task 12), the drift card MUST show only the Discard
  // button — no Resume button. The existing DriftCard implementation is already
  // Discard-only (M1 invariant: R11 drift card single 'Discard' button), so this
  // test is a non-regression guard: we verify the card never shows a Resume
  // button, regardless of the underlying session status.
  const driftPayload: PinnedTabDriftPayload = {
    reason: "tab-closed",
    originalTask: "analyze this screenshot",
    lastPinnedTabTitle: "My Tab",
    pinnedOrigin: "https://example.com",
    lastStepIndex: 3,
  };

  it("R14 — pinned-tab-drift card shows Discard button", () => {
    render(
      <SessionConfirmCard
        kind="pinned-tab-drift"
        payload={driftPayload}
        onDiscard={vi.fn()}
      />,
    );
    // Discard button must be present
    expect(screen.getByText(/DISCARD TASK/i)).toBeTruthy();
  });

  it("R14 — pinned-tab-drift card has no Resume button (Discard-only invariant)", () => {
    render(
      <SessionConfirmCard
        kind="pinned-tab-drift"
        payload={driftPayload}
        onDiscard={vi.fn()}
      />,
    );
    // No Resume button — M1/R11/R14 Discard-only invariant.
    // Note: the card body mentions "Resume isn't safe", so we check
    // specifically for a button element with a resume label, not text content.
    expect(screen.queryByRole("button", { name: /^resume/i })).toBeNull();
    // There should be exactly one button: the Discard button
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toMatch(/DISCARD/i);
  });

  it("R14 — Discard button calls onDiscard handler", () => {
    const onDiscard = vi.fn();
    render(
      <SessionConfirmCard
        kind="pinned-tab-drift"
        payload={driftPayload}
        onDiscard={onDiscard}
      />,
    );
    fireEvent.click(screen.getByText(/DISCARD TASK/i));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("R14 — Discard button disabled after resolved='discarded'", () => {
    render(
      <SessionConfirmCard
        kind="pinned-tab-drift"
        payload={driftPayload}
        resolved="discarded"
        onDiscard={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: /discard/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.textContent).toMatch(/DISCARDED/i);
  });
});

describe("SessionDrawer — clear all archived", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("clears all archived after confirm", () => {
    (lifecycle.hardDeleteAllArchived as ReturnType<typeof vi.fn>).mockClear();
    vi.stubGlobal("confirm", vi.fn(() => true));
    const sessions = [
      makeEntry("a1", "archived", "Old A"),
      makeEntry("a2", "archived", "Old B"),
    ];
    render(<SessionDrawer {...BASE_PROPS} sessions={sessions} />);
    fireEvent.click(screen.getByText(/Show Archived/));
    fireEvent.click(screen.getByText("Delete all"));
    expect(lifecycle.hardDeleteAllArchived).toHaveBeenCalledTimes(1);
  });

  it("does NOT clear when confirm is cancelled", () => {
    (lifecycle.hardDeleteAllArchived as ReturnType<typeof vi.fn>).mockClear();
    vi.stubGlobal("confirm", vi.fn(() => false));
    const sessions = [makeEntry("a1", "archived", "Old A")];
    render(<SessionDrawer {...BASE_PROPS} sessions={sessions} />);
    fireEvent.click(screen.getByText(/Show Archived/));
    fireEvent.click(screen.getByText("Delete all"));
    expect(lifecycle.hardDeleteAllArchived).not.toHaveBeenCalled();
  });

  it("hides the Delete all button when there are no archived sessions", () => {
    const sessions = [makeEntry("s1", "active", "Active")];
    render(<SessionDrawer {...BASE_PROPS} sessions={sessions} />);
    fireEvent.click(screen.getByText(/Show Archived/));
    expect(screen.queryByText("Delete all")).toBeNull();
  });
});
