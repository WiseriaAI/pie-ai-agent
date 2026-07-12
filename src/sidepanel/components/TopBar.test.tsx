import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import TopBar, { type TopBarProps } from "./TopBar";

// usePinDisplay depends on chrome.tabs — mock it, directly controlling display.
vi.mock("@/sidepanel/hooks/usePinDisplay", () => ({
  usePinDisplay: vi.fn(({ pinnedTabs }) => ({
    displayPinnedOrigin: pinnedTabs?.[0]?.origin ?? null,
    isLocked: true,
  })),
}));
vi.mock("./PinnedTabDropdown", () => ({ default: () => <div data-testid="pin-dropdown" /> }));

afterEach(cleanup);

function make(over: Partial<TopBarProps> = {}): TopBarProps {
  return {
    view: "agent", settingsPage: "root", sessionTitle: "测试会话", pendingCount: 0,
    onToggleDrawer: vi.fn(), onNewSession: vi.fn(),
    onNavigate: vi.fn(), onBack: vi.fn(),
    pinnedTabs: null, pinMode: null, streaming: false,
    onTogglePinTab: vi.fn(), onClearUserPin: vi.fn(),
    ...over,
  };
}

describe("TopBar 六态", () => {
  it("chat：渲染抽屉/新会话/schedules/skills 按钮 + 会话标题，无 back", () => {
    const p = make();
    render(<TopBar {...p} />);
    expect(screen.getByTestId("topbar-drawer")).toBeTruthy();
    expect(screen.getByTestId("topbar-new")).toBeTruthy();
    expect(screen.getByText("测试会话")).toBeTruthy();
    expect(screen.getByTestId("topbar-schedules")).toBeTruthy();
    expect(screen.getByTestId("topbar-skills")).toBeTruthy();
    expect(screen.queryByTestId("topbar-back")).toBeNull();
  });

  it("chat：pendingCount>0 显示红点", () => {
    render(<TopBar {...make({ pendingCount: 2 })} />);
    expect(screen.getByTestId("topbar-pending-dot")).toBeTruthy();
  });

  it("schedules：back + schedules 按钮 aria-pressed，无抽屉/新会话", () => {
    render(<TopBar {...make({ view: "schedules" })} />);
    expect(screen.getByTestId("topbar-back")).toBeTruthy();
    expect(screen.getByTestId("topbar-schedules").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("topbar-drawer")).toBeNull();
    expect(screen.queryByTestId("topbar-new")).toBeNull();
  });

  it("skills：skills 按钮 aria-pressed；点 schedules 触发 onNavigate 互切", () => {
    const p = make({ view: "skills" });
    render(<TopBar {...p} />);
    expect(screen.getByTestId("topbar-skills").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("topbar-schedules"));
    expect(p.onNavigate).toHaveBeenCalledWith("schedules");
  });

  it("settings 根页：back + 标题，无 schedules/skills 按钮", () => {
    render(<TopBar {...make({ view: "settings" })} />);
    expect(screen.getByTestId("topbar-back")).toBeTruthy();
    expect(screen.queryByTestId("topbar-schedules")).toBeNull();
    expect(screen.queryByTestId("topbar-skills")).toBeNull();
  });

  it("back 点击触发 onBack", () => {
    const p = make({ view: "settings", settingsPage: "models" });
    render(<TopBar {...p} />);
    fireEvent.click(screen.getByTestId("topbar-back"));
    expect(p.onBack).toHaveBeenCalled();
  });
});

describe("TopBar pin 副行", () => {
  const pinned = [{ tabId: 1, origin: "news.ycombinator.com" }, { tabId: 2, origin: "github.com" }] as const;

  it("chat + pinnedTabs 渲染副行：origin + ×2 计数", () => {
    render(<TopBar {...make({ pinnedTabs: [...pinned], pinMode: "user" })} />);
    expect(screen.getByTestId("topbar-pin-row")).toBeTruthy();
    expect(screen.getByText("news.ycombinator.com")).toBeTruthy();
    expect(screen.getByText("×2")).toBeTruthy();
  });

  it("无 pin 不渲染副行；非 chat 视图不渲染副行", () => {
    render(<TopBar {...make()} />);
    expect(screen.queryByTestId("topbar-pin-row")).toBeNull();
    cleanup();
    render(<TopBar {...make({ view: "schedules", pinnedTabs: [...pinned], pinMode: "user" })} />);
    expect(screen.queryByTestId("topbar-pin-row")).toBeNull();
  });

  it("点击副行翻转 aria-expanded", () => {
    render(<TopBar {...make({ pinnedTabs: [...pinned], pinMode: "user" })} />);
    const row = screen.getByTestId("topbar-pin-row");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });
});
