import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { it, expect, vi, afterEach } from "vitest";
import { TierSelector } from "./TierSelector";

afterEach(() => { cleanup(); });

const tiers = [{ tierId: "default", displayName: "标准" }, { tierId: "advanced", displayName: "深度" }];

it("renders display names, not tier ids", () => {
  render(<TierSelector tiers={tiers} value="default" onChange={() => {}} />);
  expect(screen.getByText("标准")).toBeTruthy();
  expect(screen.queryByText("default")).toBeNull();
});

it("calls onChange with tierId on select", () => {
  const onChange = vi.fn();
  render(<TierSelector tiers={tiers} value="default" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button"));        // expand
  fireEvent.click(screen.getByText("深度"));
  expect(onChange).toHaveBeenCalledWith("advanced");
});

it("free user with single tier renders a locked single option", () => {
  render(<TierSelector tiers={[tiers[0]]} value="default" onChange={() => {}} />);
  expect(screen.getByText("标准")).toBeTruthy();
});
