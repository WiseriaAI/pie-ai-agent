import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { LoginResult } from "@/lib/managed-auth";
import ManagedSubscribePanel from "./ManagedSubscribePanel";

afterEach(() => {
  cleanup();
});

describe("ManagedSubscribePanel", () => {
  it("already-active login creates the config immediately", async () => {
    const onCreated = vi.fn();
    render(<ManagedSubscribePanel
      onCreated={onCreated}
      deps={{
        login: vi.fn(async (): Promise<LoginResult> => ({ apiKey: "sk-v", entitlement: { plan: "active", email: "u@x.com", budgetRemainingUsd: 6 } })),
      }}
    />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("sk-v", "u@x.com"));
  });

  it("non-subscribed login shows a Subscribe button (does not create yet)", async () => {
    const onCreated = vi.fn();
    render(<ManagedSubscribePanel
      onCreated={onCreated}
      deps={{
        login: vi.fn(async (): Promise<LoginResult> => ({ apiKey: "sk-v", entitlement: { plan: "none", email: "u@x.com", budgetRemainingUsd: 0 } })),
        checkout: vi.fn(async () => {}),
      }}
    />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findByRole("button", { name: /subscribe/i });
    expect(onCreated).not.toHaveBeenCalled();
  });
});
