import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import NewConfigWizard from "./NewConfigWizard";

// custom-providers reads chrome.storage; stub list to empty for these tests.
vi.mock("@/lib/custom-providers", async (orig) => {
  const actual = await orig<typeof import("@/lib/custom-providers")>();
  return { ...actual, listCustomProviders: vi.fn(async () => []) };
});

afterEach(() => cleanup());

describe("NewConfigWizard managed toggle", () => {
  it("renders a BYOK/Official toggle and creates a managed config via the subscribe panel", async () => {
    const onCreate = vi.fn();
    render(
      <NewConfigWizard
        onCreate={onCreate}
        onCancel={() => {}}
        onTest={() => {}}
        __managedDeps={{
          login: vi.fn(async (): Promise<import("@/lib/managed-auth").LoginResult> => ({
            apiKey: "sk-v",
            entitlement: { plan: "active", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false }, quota: { weekly: { usedFraction: 0, resetAt: 1750400000 } }, models: [{ id: "default", name: "标准", vision: false, maxContextTokens: 200000, costLevel: 1 }] },
          })),
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /official subscription/i }));
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        "managed",
        expect.objectContaining({ apiKey: "sk-v", nickname: "u@x.com" }),
      ),
    );
  });

  it("shows an 'already configured' notice (and no Google sign-in) when a managed config exists", () => {
    render(
      <NewConfigWizard
        onCreate={() => {}}
        onCancel={() => {}}
        onTest={() => {}}
        existingProviderRefs={["managed"]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /official subscription/i }));
    expect(screen.getByText(/already configured/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /sign in with google/i })).toBeNull();
  });
});
