import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CdpOnboardingCard } from "./CdpOnboardingCard";

afterEach(() => {
  cleanup();
});

describe("CdpOnboardingCard", () => {
  it("renders enable + decline buttons", () => {
    render(<CdpOnboardingCard onAnswer={() => {}} />);
    expect(screen.getByRole("button", { name: /enable|启用/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /not now|不启用/i })).toBeTruthy();
  });

  it("calls onAnswer(true) when Enable clicked", () => {
    const onAnswer = vi.fn();
    render(<CdpOnboardingCard onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: /enable|启用/i }));
    expect(onAnswer).toHaveBeenCalledWith(true);
  });

  it("calls onAnswer(false) when Not now clicked", () => {
    const onAnswer = vi.fn();
    render(<CdpOnboardingCard onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: /not now|不启用/i }));
    expect(onAnswer).toHaveBeenCalledWith(false);
  });

  it("mentions yellow bar in body copy", () => {
    render(<CdpOnboardingCard onAnswer={() => {}} />);
    expect(screen.getByText(/yellow.*bar|黄条/i)).toBeTruthy();
  });
});
