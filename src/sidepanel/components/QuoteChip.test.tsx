import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QuoteChip } from "./QuoteChip";
import type { Quote } from "@/types";

afterEach(() => {
  cleanup();
});

describe("QuoteChip", () => {
  it("text chip shows truncated label + remove button", () => {
    const q: Quote = {
      id: "q1",
      kind: "text",
      text: "Hello world this is a fairly long quote about something",
      sourceUrl: "https://example.com/page",
      sourceTabId: 1,
    };
    render(<QuoteChip quote={q} onRemove={vi.fn()} />);
    expect(screen.getByRole("button", { name: /remove quote/i })).toBeTruthy();
    expect(screen.getByText(/Hello world/)).toBeTruthy();
  });

  it("element chip shows role and accessibleName", () => {
    const q: Quote = {
      id: "q2",
      kind: "element",
      role: "button",
      accessibleName: "Create issue",
      textContent: "Create issue",
      outerHTMLTruncated: "<button>Create issue</button>",
      imageDataUrl: "data:image/jpeg;base64,xxxx",
      sourceUrl: "https://github.com",
      sourceTabId: 1,
    };
    render(<QuoteChip quote={q} onRemove={vi.fn()} />);
    expect(screen.getByText(/button/)).toBeTruthy();
    expect(screen.getByText(/Create issue/)).toBeTruthy();
  });

  it("element chip with null imageDataUrl shows [Screenshot unavailable]", () => {
    const q: Quote = {
      id: "q3",
      kind: "element",
      role: "button",
      accessibleName: "X",
      textContent: "X",
      outerHTMLTruncated: "<button>X</button>",
      imageDataUrl: null,
      sourceUrl: "https://example.com",
      sourceTabId: 1,
    };
    render(<QuoteChip quote={q} onRemove={vi.fn()} />);
    const chip = screen.getByText(/button/);
    fireEvent.mouseEnter(chip);
    expect(screen.getByText(/screenshot unavailable/i)).toBeTruthy();
  });

  it("× button calls onRemove with id", () => {
    const onRemove = vi.fn();
    const q: Quote = { id: "qr", kind: "text", text: "x", sourceUrl: "u", sourceTabId: 1 };
    render(<QuoteChip quote={q} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: /remove quote/i }));
    expect(onRemove).toHaveBeenCalledWith("qr");
  });
});
