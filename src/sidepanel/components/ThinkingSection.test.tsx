import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ThinkingSection from "./ThinkingSection";

describe("ThinkingSection", () => {
  it("renders collapsed by default; thinking text hidden until expanded", () => {
    render(<ThinkingSection thinking="secret reasoning" streaming={false} />);
    expect(screen.queryByText("secret reasoning")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("secret reasoning")).toBeTruthy();
  });

  it("renders nothing when thinking is empty and not streaming", () => {
    const { container } = render(<ThinkingSection thinking="" streaming={false} />);
    expect(container.firstChild).toBeNull();
  });
});
