import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import SearchProviderSection from "./SearchProviderSection";
import * as searchProvider from "@/lib/search-provider";

const memStore = new Map<string, unknown>();

beforeEach(() => {
  memStore.clear();
  // @ts-expect-error happy-dom doesn't define chrome
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of arr) if (memStore.has(k)) out[k] = memStore.get(k);
          return out;
        },
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) memStore.set(k, v);
        },
        remove: async (keys: string | string[]) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) memStore.delete(k);
        },
      },
    },
  };
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
    expect(memStore.has("search_provider_tavily")).toBe(true);
  });

  it("Forget clears the key after confirm", async () => {
    // happy-dom doesn't define confirm — assign directly
    window.confirm = () => true;
    await searchProvider.setSearchProviderKey("tavily", "tvly-x");
    render(<SearchProviderSection />);
    fireEvent.click(await screen.findByRole("button", { name: /forget/i }));
    await waitFor(() => expect(screen.getByText(/not set/i)).toBeTruthy());
    expect(memStore.has("search_provider_tavily")).toBe(false);
  });
});
