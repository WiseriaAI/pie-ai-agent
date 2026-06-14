import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useRef } from "react";
import { useAnchorRect } from "./useAnchorRect";

afterEach(() => cleanup());

const fakeRect = (over: Partial<DOMRect> = {}): DOMRect =>
  ({
    left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON: () => ({}),
    ...over,
  }) as DOMRect;

function Harness({ open, onRect }: { open: boolean; onRect: (r: DOMRect | null) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const rect = useAnchorRect(ref, open);
  onRect(rect);
  return <button ref={ref}>anchor</button>;
}

describe("useAnchorRect", () => {
  it("returns null when closed", () => {
    let last: DOMRect | null = fakeRect();
    render(<Harness open={false} onRect={(r) => (last = r)} />);
    expect(last).toBeNull();
  });

  it("measures the anchor rect when open", () => {
    let last: DOMRect | null = null;
    const spy = vi
      .spyOn(HTMLButtonElement.prototype, "getBoundingClientRect")
      .mockReturnValue(fakeRect({ left: 5, top: 10, bottom: 30, width: 100 }));
    render(<Harness open={true} onRect={(r) => (last = r)} />);
    expect(last).not.toBeNull();
    expect(last!.left).toBe(5);
    expect(last!.width).toBe(100);
    spy.mockRestore();
  });

  it("re-measures on window resize while open", () => {
    let calls = 0;
    const spy = vi
      .spyOn(HTMLButtonElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => {
        calls++;
        return fakeRect();
      });
    render(<Harness open={true} onRect={() => {}} />);
    const initial = calls;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(calls).toBeGreaterThan(initial);
    spy.mockRestore();
  });
});
