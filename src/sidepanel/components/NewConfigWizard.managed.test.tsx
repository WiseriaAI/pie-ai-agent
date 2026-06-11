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
            entitlement: { plan: "active", email: "u@x.com", budgetRemainingUsd: 6 },
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
});
