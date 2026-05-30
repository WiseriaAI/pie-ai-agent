import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QuotaExhaustedCard } from "./QuotaExhaustedCard";

afterEach(cleanup);

describe("QuotaExhaustedCard", () => {
  it("renders BYOK + buy actions", () => {
    const onByok = vi.fn();
    const onBuy = vi.fn();
    render(<QuotaExhaustedCard kind="quota" onByok={onByok} onBuy={onBuy} />);
    expect(screen.getByText(/额度用尽|用完/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /自带 key|BYOK/i }));
    expect(onByok).toHaveBeenCalled();
  });

  it("kind=upgrade shows upgrade copy", () => {
    render(<QuotaExhaustedCard kind="upgrade" onByok={() => {}} onBuy={() => {}} />);
    expect(screen.getByText(/升级|高级档/)).toBeTruthy();
  });
});
