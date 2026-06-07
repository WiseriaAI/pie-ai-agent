import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import SearchProviderSection from "./SearchProviderSection";
import * as searchProvider from "@/lib/search-provider";
import { getConfig } from "@/lib/idb/config-store";
import { _resetForTests } from "@/lib/idb/db";
import { _resetKeyForTests } from "@/lib/crypto";

// search_provider_* keys (encrypted) now live in the `pie` IDB config store,
// not chrome.storage.local. Reset the db + the cached crypto key per test so
// keys don't leak; assert presence via the IDB getter.
async function hasStoredKey(id: string): Promise<boolean> {
  return (await getConfig(`search_provider_${id}`)) !== undefined;
}

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("SearchProviderSection", () => {
  it("renders empty state with 'Add key' CTA when no key configured", async () => {
    render(<SearchProviderSection />);
    expect(await screen.findByText("Not set")).toBeTruthy();
    expect(screen.getByRole("button", { name: /add key/i })).toBeTruthy();
  });

  it("shows configured state with verified status when key present", async () => {
    await searchProvider.setSearchProviderKey("tavily", "tvly-prod-9k2pX7vqL8mNzR4tYZ12");
    await searchProvider.markVerified("tavily");
    render(<SearchProviderSection />);
    expect(await screen.findByText(/active/i)).toBeTruthy();
    expect(screen.getByText(/verified/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /replace key/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /forget/i })).toBeTruthy();
  });

  it("clicking + Add key opens editing state with focused input", async () => {
    render(<SearchProviderSection />);
    fireEvent.click(await screen.findByRole("button", { name: /add key/i }));
    expect(screen.getByPlaceholderText("tvly-...")).toBeTruthy();
    expect(screen.getByRole("button", { name: /save & test/i })).toBeTruthy();
  });

  it("Save & test stores the key and transitions to configured", async () => {
    vi.spyOn(searchProvider, "getSearchProvider").mockReturnValue({
      id: "tavily",
      search: async () => ({ query: "x", resultCount: 0, results: [] }),
      test: async () => ({ ok: true }),
    });
    render(<SearchProviderSection />);
    fireEvent.click(await screen.findByRole("button", { name: /add key/i }));
    fireEvent.change(screen.getByPlaceholderText("tvly-..."), {
      target: { value: "tvly-typed-key-9YZ12" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save & test/i }));
    await waitFor(() => expect(screen.getByText(/verified/i)).toBeTruthy());
    expect(await hasStoredKey("tavily")).toBe(true);
  });

  it("Forget clears the key after confirm", async () => {
    // happy-dom doesn't define confirm — assign directly
    window.confirm = () => true;
    await searchProvider.setSearchProviderKey("tavily", "tvly-x");
    render(<SearchProviderSection />);
    fireEvent.click(await screen.findByRole("button", { name: /forget/i }));
    await waitFor(() => expect(screen.getByText(/not set/i)).toBeTruthy());
    expect(await hasStoredKey("tavily")).toBe(false);
  });

  it("disables Save & test button while save is in flight", async () => {
    let resolveTest: ((v: { ok: boolean }) => void) | undefined;
    vi.spyOn(searchProvider, "getSearchProvider").mockReturnValue({
      id: "tavily",
      search: async () => ({ query: "x", resultCount: 0, results: [] }),
      test: () => new Promise((r) => { resolveTest = r; }),
    });
    render(<SearchProviderSection />);
    fireEvent.click(await screen.findByRole("button", { name: /add key/i }));
    fireEvent.change(screen.getByPlaceholderText("tvly-..."), {
      target: { value: "tvly-key-A1B2C3" },
    });
    const saveBtn = screen.getByRole("button", { name: /save & test/i }) as HTMLButtonElement;
    fireEvent.click(saveBtn);
    // Wait for BOTH: button disabled AND the test mock has been called (so
    // resolveTest is assigned). The handler awaits setSearchProviderKey before
    // calling provider.test(), so these two conditions become true at slightly
    // different times — polling on both avoids the race.
    await waitFor(() => {
      expect(saveBtn.disabled).toBe(true);
      expect(resolveTest).toBeDefined();
    });
    // Resolve the test → button becomes re-enabled (after transitioning out of editing mode)
    resolveTest!({ ok: true });
    await waitFor(() => expect(screen.getByText(/verified/i)).toBeTruthy());
  });

  it("shows neutral 'not set' status after rejected save (no verified pill)", async () => {
    vi.spyOn(searchProvider, "getSearchProvider").mockReturnValue({
      id: "tavily",
      search: async () => ({ query: "x", resultCount: 0, results: [] }),
      test: async () => ({ ok: false, reason: "Key rejected." }),
    });
    render(<SearchProviderSection />);
    fireEvent.click(await screen.findByRole("button", { name: /add key/i }));
    fireEvent.change(screen.getByPlaceholderText("tvly-..."), {
      target: { value: "tvly-bad-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save & test/i }));
    // Immediately: testResult = rejected
    await waitFor(() => expect(screen.getByText(/verification failed/i)).toBeTruthy());
    // Confirm the verified pill is NOT shown (the bug we're fixing)
    expect(screen.queryByText(/✓ verified/i)).toBeFalsy();
  });
});
