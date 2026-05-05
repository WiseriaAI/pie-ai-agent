/**
 * M5 — PinnedTabDropdown tests.
 *
 * Covers tab listing, restricted-URL filter, pick / clear actions, ESC
 * close, and task-mode disable. Uses chromeMock from setup.ts which provides
 * tabs.query backed by `__tabsById`.
 */

import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chromeMock } from "@/test/setup";
import PinnedTabDropdown from "./PinnedTabDropdown";

beforeEach(() => {
  chromeMock.tabs.__tabsById.clear();
  chromeMock.tabs.query.mockClear();
});

afterEach(() => {
  cleanup();
});

function seedTabs(
  tabs: Array<{
    id: number;
    url: string;
    title?: string;
    active?: boolean;
    windowId?: number;
  }>,
) {
  for (const t of tabs) {
    chromeMock.tabs.__tabsById.set(t.id, {
      id: t.id,
      url: t.url,
      title: t.title ?? "",
      active: t.active ?? false,
      windowId: t.windowId ?? 1,
    });
  }
}

describe("PinnedTabDropdown — list rendering", () => {
  it("renders the Auto item plus pinnable tabs", async () => {
    seedTabs([
      { id: 1, url: "https://a.com/", title: "Site A", active: true },
      { id: 2, url: "https://b.com/", title: "Site B" },
    ]);

    await act(async () => {
      render(
        <PinnedTabDropdown
          pinMode="auto"
          pinnedTabs={null}
          streaming={false}
          onToggle={vi.fn()}
          onClearPin={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    // Auto item present
    expect(screen.getByText(/Auto \(follow active tab\)/i)).toBeTruthy();
    // Both tabs present
    expect(screen.getByText("Site A")).toBeTruthy();
    expect(screen.getByText("Site B")).toBeTruthy();
  });

  it("filters out restricted-URL tabs (chrome://, file://, etc.)", async () => {
    seedTabs([
      { id: 1, url: "https://ok.com/", title: "OK" },
      { id: 2, url: "chrome://settings", title: "Settings" },
      { id: 3, url: "file:///etc/passwd", title: "Local" },
      { id: 4, url: "javascript:void(0)", title: "JS" },
      { id: 5, url: "blob:https://x.com/abc", title: "Blob" },
      { id: 6, url: "data:text/html,<x>", title: "Data" },
    ]);

    await act(async () => {
      render(
        <PinnedTabDropdown
          pinMode="auto"
          pinnedTabs={null}
          streaming={false}
          onToggle={vi.fn()}
          onClearPin={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    expect(screen.getByText("OK")).toBeTruthy();
    expect(screen.queryByText("Settings")).toBeNull();
    expect(screen.queryByText("Local")).toBeNull();
    expect(screen.queryByText("JS")).toBeNull();
    expect(screen.queryByText("Blob")).toBeNull();
    expect(screen.queryByText("Data")).toBeNull();
  });

  it("shows empty-state message when no pinnable tabs", async () => {
    seedTabs([{ id: 1, url: "chrome://settings" }]); // restricted only

    await act(async () => {
      render(
        <PinnedTabDropdown
          pinMode="auto"
          pinnedTabs={null}
          streaming={false}
          onToggle={vi.fn()}
          onClearPin={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    expect(screen.getByText(/no pinnable tabs/i)).toBeTruthy();
  });
});

describe("PinnedTabDropdown — actions", () => {
  it("clicking a tab calls onToggle but does NOT close (multi-select stays open)", async () => {
    seedTabs([{ id: 42, url: "https://example.com/path", title: "Example" }]);
    const onToggle = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      render(
        <PinnedTabDropdown
          pinMode="auto"
          pinnedTabs={null}
          streaming={false}
          onToggle={onToggle}
          onClearPin={vi.fn()}
          onClose={onClose}
        />,
      );
    });

    const item = screen.getByText("Example").closest("li")!;
    await act(async () => {
      fireEvent.mouseDown(item);
    });

    expect(onToggle).toHaveBeenCalledWith(42, "https://example.com");
    // v1.5 multi-select: clicking a tab row DOES NOT close the dropdown
    expect(onClose).not.toHaveBeenCalled();
  });

  it("clicking Auto fires onClearPin + onClose", async () => {
    seedTabs([{ id: 1, url: "https://x.com/", title: "X" }]);
    const onClearPin = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      render(
        <PinnedTabDropdown
          pinMode="user"
          pinnedTabs={[{ tabId: 1, origin: "https://x.com" }]}
          streaming={false}
          onToggle={vi.fn()}
          onClearPin={onClearPin}
          onClose={onClose}
        />,
      );
    });

    const auto = screen.getByText(/Auto \(follow active tab\)/i).closest("li")!;
    await act(async () => {
      fireEvent.mouseDown(auto);
    });

    expect(onClearPin).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("ESC closes the dropdown", async () => {
    seedTabs([{ id: 1, url: "https://x.com/" }]);
    const onClose = vi.fn();

    await act(async () => {
      render(
        <PinnedTabDropdown
          pinMode="auto"
          pinnedTabs={null}
          streaming={false}
          onToggle={vi.fn()}
          onClearPin={vi.fn()}
          onClose={onClose}
        />,
      );
    });

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    expect(onClose).toHaveBeenCalled();
  });

  it("toggling a pinned tab calls onToggle and stays open", async () => {
    seedTabs([{ id: 12, url: "https://a.com/", title: "A" }]);
    const onToggle = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      render(
        <PinnedTabDropdown
          pinMode="user"
          pinnedTabs={[{ tabId: 12, origin: "https://a.com" }]}
          streaming={false}
          onToggle={onToggle}
          onClearPin={vi.fn()}
          onClose={onClose}
        />,
      );
    });

    const item = screen.getByText("A").closest("li")!;
    await act(async () => {
      fireEvent.mouseDown(item);
    });

    expect(onToggle).toHaveBeenCalled();
    // v1.5: dropdown stays open so user can continue multi-selecting
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("PinnedTabDropdown — task-mode disable", () => {
  it("task mode: tabs are aria-disabled and clicks are no-ops", async () => {
    seedTabs([{ id: 42, url: "https://example.com/", title: "Example" }]);
    const onToggle = vi.fn();
    const onClearPin = vi.fn();

    await act(async () => {
      render(
        <PinnedTabDropdown
          pinMode="task"
          pinnedTabs={[{ tabId: 42, origin: "https://example.com" }]}
          streaming={false}
          onToggle={onToggle}
          onClearPin={onClearPin}
          onClose={vi.fn()}
        />,
      );
    });

    // Banner indicating in-flight task
    expect(screen.getByText(/task is currently running/i)).toBeTruthy();

    const item = screen.getByText("Example").closest("li")!;
    expect(item.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      fireEvent.mouseDown(item);
    });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("streaming: items are disabled regardless of pinMode", async () => {
    seedTabs([{ id: 42, url: "https://example.com/", title: "Example" }]);
    const onToggle = vi.fn();

    await act(async () => {
      render(
        <PinnedTabDropdown
          pinMode="auto"
          pinnedTabs={null}
          streaming={true}
          onToggle={onToggle}
          onClearPin={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    const item = screen.getByText("Example").closest("li")!;
    expect(item.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.mouseDown(item);
    });
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("PinnedTabDropdown — checkmark", () => {
  it("user mode + matching tabId in pinnedTabs: tab row shows checkmark", async () => {
    seedTabs([
      { id: 1, url: "https://a.com/", title: "A" },
      { id: 2, url: "https://b.com/", title: "B" },
    ]);

    await act(async () => {
      render(
        <PinnedTabDropdown
          pinMode="user"
          pinnedTabs={[{ tabId: 2, origin: "https://b.com" }]}
          streaming={false}
          onToggle={vi.fn()}
          onClearPin={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    // The selected row has aria-selected=true
    const rows = screen.getAllByRole("option");
    const selected = rows.find((r) => r.getAttribute("aria-selected") === "true")!;
    expect(selected.textContent).toContain("B");
  });

  it("auto mode: Auto item shows checkmark", async () => {
    seedTabs([{ id: 1, url: "https://a.com/", title: "A" }]);

    await act(async () => {
      render(
        <PinnedTabDropdown
          pinMode="auto"
          pinnedTabs={null}
          streaming={false}
          onToggle={vi.fn()}
          onClearPin={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    const rows = screen.getAllByRole("option");
    const selected = rows.find((r) => r.getAttribute("aria-selected") === "true")!;
    expect(selected.textContent).toContain("Auto");
  });
});
