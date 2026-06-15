import { describe, expect, it, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ManagedStatusPill } from "./ManagedStatusPill";

afterEach(() => cleanup());

describe("ManagedStatusPill", () => {
  it("renders the label", () => {
    render(<ManagedStatusPill tone="neutral" label="Inactive" />);
    expect(screen.getByText("Inactive")).toBeTruthy();
  });

  it("applies tone classes (success)", () => {
    render(<ManagedStatusPill tone="success" label="Active" />);
    const el = screen.getByText("Active");
    expect(el.className).toContain("text-success");
  });
});
