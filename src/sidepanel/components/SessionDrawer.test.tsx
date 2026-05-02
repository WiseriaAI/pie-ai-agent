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
import type { SessionIndexEntry } from "@/lib/sessions/types";

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
  chromeMock.storage.local.onChanged.addListener.mockClear();
  chromeMock.storage.local.onChanged.removeListener.mockClear();
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
  it("renders a progressbar for storage usage", () => {
    render(<SessionDrawer {...BASE_PROPS} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toBeTruthy();
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
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
