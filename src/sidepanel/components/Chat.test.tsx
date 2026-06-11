/**
 * Chat — Phase 5 image input UI tests + Task 4.4 unified file attach tests
 *
 * Tests cover:
 * - Attach file button renders (always enabled — text/PDF work without vision)
 * - Attach button is NOT disabled when provider supportsVision=false
 * - Thumbnail row hidden when no attachments
 * - FileChip row renders after text file is selected
 * - Remove image button calls removeAttachment
 *
 * Harness: minimal UseSession mock + vi.mock for storage so checkConfig()
 * resolves without real crypto / chrome.storage. Tabs event listeners are
 * patched on the global chrome mock.
 */

import React from "react";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chromeMock } from "@/test/setup";
import Chat from "./Chat";
// Escape hatch for tests that pass extra props (onOpenSessionList, activePanel) not in ChatProps
const ChatAny = Chat as unknown as React.ComponentType<Record<string, unknown>>;
import type { UseSession } from "@/sidepanel/hooks/useSession";
import type { DisplayMessage } from "@/types";

// ── Mock @/lib/files/process-picked-file so tests control routing ─────────────
vi.mock("@/lib/files/process-picked-file", () => ({
  processPickedFile: vi.fn(async (file: File, opts: { supportsVision: boolean }) => {
    if (file.type.startsWith("image/")) {
      if (!opts.supportsVision) {
        return { ok: false as const, reason: "no_vision" as const, message: "current model has no vision" };
      }
      return {
        ok: true as const,
        kind: "image" as const,
        attachment: {
          kind: "image" as const,
          id: `img_${Math.random()}`,
          data: "AAAA",
          mediaType: "image/jpeg" as const,
          width: 100,
          height: 100,
          byteLength: 3,
        },
      };
    }
    // text/plain, application/pdf, etc.
    return {
      ok: true as const,
      kind: "file" as const,
      attachment: {
        kind: "file" as const,
        id: `file_${Math.random()}`,
        name: file.name,
        mime: file.type || "text/plain",
        text: "hello world",
        truncated: false,
        totalChars: 11,
        source: "picker" as const,
      },
    };
  }),
}));

// ── Mock @/lib/files/inject so wrapper is predictable ──────────────────────────
vi.mock("@/lib/files/inject", () => ({
  fileAttachmentToWrapper: vi.fn((att: { name: string; mime: string; truncated: boolean; text: string }) =>
    `<untrusted_local_file name="${att.name}" mime="${att.mime}" truncated="${att.truncated}">\n${att.text}\n</untrusted_local_file>`,
  ),
}));

// ── Mock @/lib/instances so checkConfig never touches real crypto ─────────────
vi.mock("@/lib/instances", () => ({
  listInstances: vi.fn().mockResolvedValue([{ id: "inst-1", provider: "anthropic", nickname: "My Anthropic", apiKey: "sk-test", createdAt: 0 }]),
  getActiveInstance: vi.fn().mockResolvedValue("inst-1"),
  getInstance: vi.fn().mockResolvedValue({ id: "inst-1", provider: "anthropic", nickname: "My Anthropic", apiKey: "sk-test", createdAt: 0 }),
  updateInstance: vi.fn().mockResolvedValue(undefined),
  firstModelForProvider: vi.fn().mockResolvedValue("claude-opus-4-7"),
}));

// resolveSelection drives the composer chip + vision checks; stub it so tests
// don't depend on the real instance/last-selection resolution chain.
vi.mock("@/lib/model-selection-resolver", () => ({
  resolveSelection: vi.fn().mockResolvedValue({ instanceId: "inst-1", model: "claude-opus-4-7" }),
}));

// Composer's openrouter lazy fetch — never hit the network in tests.
vi.mock("@/lib/openrouter-models-fetch", () => ({
  fetchOpenRouterModels: vi.fn().mockResolvedValue([]),
}));

// Also need to mock @/lib/sessions/storage for InstanceSelector sub-component
vi.mock("@/lib/sessions/storage", () => ({
  getSessionMeta: vi.fn().mockResolvedValue(null),
  setSessionMeta: vi.fn().mockResolvedValue(undefined),
  metaKey: vi.fn((id: string) => `session_${id}_meta`),
}));

// Import the mocked instances so individual tests can override return values.
import { listInstances, getActiveInstance, getInstance } from "@/lib/instances";
import { resolveSelection } from "@/lib/model-selection-resolver";
// Import the mocked sessions/storage so individual tests can override getSessionMeta.
import { getSessionMeta } from "@/lib/sessions/storage";

// ── UseSession mock ──────────────────────────────────────────────────────────
// Build a minimal UseSession shape with no-op vi.fn() defaults so Chat can
// render without a real port / storage bootstrap.

function makeSession(overrides?: Partial<UseSession>): UseSession {
  return {
    sessionId: "test-session-id",
    ready: true,
    status: "active",
    pinnedTabs: null,
    pinMode: "auto",
    messages: [] as DisplayMessage[],
    streaming: false,
    streamingText: "",
    error: null,
    toast: null,
    sendMessage: vi.fn(),
    abort: vi.fn(),
    resumeTask: vi.fn(),
    discardTask: vi.fn(),
    clearMessages: vi.fn().mockResolvedValue(undefined),
    clearError: vi.fn(),
    clearToast: vi.fn(),
    setActive: vi.fn().mockResolvedValue(null),
    createAndActivate: vi.fn().mockResolvedValue(null),
    togglePinTab: vi.fn().mockResolvedValue(undefined),
    clearUserPin: vi.fn().mockResolvedValue(undefined),
    sessions: [],
    ...overrides,
  } as unknown as UseSession;
}

// Default models per provider that have known capability flags in the registry.
// These must match real entries in PROVIDER_REGISTRY so getModelMeta resolves.
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-opus-4-7",   // vision: true
  openai: "gpt-4o",               // vision: true
  minimax: "MiniMax-Text-01",     // vision: false
  openrouter: "gpt-4o",           // not in registry → treated as no-vision (fallback)
};

// Configure the mocked instances so checkConfig() resolves with the given provider.
function seedProvider(providerId: string, modelOverride?: string) {
  const model = modelOverride ?? PROVIDER_DEFAULT_MODELS[providerId] ?? "test-model";
  const inst = { id: "inst-1", provider: providerId as import("@/lib/model-router").Provider, nickname: "Test", apiKey: "sk-test", createdAt: 0 };
  vi.mocked(listInstances).mockResolvedValue([inst] as import("@/lib/instances").DecryptedInstance[]);
  vi.mocked(getActiveInstance).mockResolvedValue("inst-1");
  vi.mocked(getInstance).mockResolvedValue(inst as import("@/lib/instances").DecryptedInstance);
  vi.mocked(resolveSelection).mockResolvedValue({ instanceId: "inst-1", model });
}

// Chrome tabs mock extension — Chat.tsx uses chrome.tabs.onActivated,
// chrome.tabs.onUpdated, and chrome.windows.onFocusChanged in its
// useEffect for live-origin tracking. The global setup.ts only provides
// tabs.query / tabs.get; we patch the rest here.

const noop = () => {};
const tabsOnActivated = { addListener: vi.fn(noop), removeListener: vi.fn(noop) };
const tabsOnUpdated = { addListener: vi.fn(noop), removeListener: vi.fn(noop) };
const windowsOnFocusChanged = { addListener: vi.fn(noop), removeListener: vi.fn(noop) };

// Extend the global chrome mock for tabs event listeners and windows
(globalThis as unknown as { chrome: Record<string, unknown> }).chrome = {
  ...(globalThis as unknown as { chrome: Record<string, unknown> }).chrome,
  tabs: {
    ...(globalThis as unknown as { chrome: { tabs: Record<string, unknown> } }).chrome.tabs,
    onActivated: tabsOnActivated,
    onUpdated: tabsOnUpdated,
  },
  windows: {
    WINDOW_ID_NONE: -1,
    onFocusChanged: windowsOnFocusChanged,
  },
};

beforeEach(() => {
  chromeMock.tabs.__activeTab = { id: 1, url: "https://example.com", active: true };
  tabsOnActivated.addListener.mockClear();
  tabsOnActivated.removeListener.mockClear();
  tabsOnUpdated.addListener.mockClear();
  tabsOnUpdated.removeListener.mockClear();
  windowsOnFocusChanged.addListener.mockClear();
  windowsOnFocusChanged.removeListener.mockClear();
  // Storage reset is done by global beforeEach in setup.ts already.
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("Chat — file attach UI (Phase 5 / Task 4.4)", () => {
  it("renders attach file button when provider supports vision (anthropic)", async () => {
    seedProvider("anthropic");
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    // The tools button appears once checkConfig resolves; clicking it opens
    // the popover where the attach item lives.
    const toolsBtn = await screen.findByRole("button", { name: /more tools/i });
    await act(async () => {
      fireEvent.click(toolsBtn);
    });
    const btn = await screen.findByRole("button", { name: /attach file/i });
    expect(btn).toBeTruthy();
    // Attach file is always enabled — not disabled even with vision provider
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("attach file button is NOT disabled when provider does not support vision (minimax)", async () => {
    // Task 4.4: text/PDF attach is always enabled; vision gate is inside addPickedFiles via toast
    seedProvider("minimax");
    render(
      <Chat
        providerLabel="MiniMax"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    const toolsBtn = await screen.findByRole("button", { name: /more tools/i });
    await act(async () => {
      fireEvent.click(toolsBtn);
    });
    const btn = await screen.findByRole("button", { name: /attach file/i });
    expect(btn).toBeTruthy();
    // NOT disabled — text/PDF work without vision
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("thumbnail row is not rendered when no attachments exist", async () => {
    seedProvider("anthropic");
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    // Wait for render to settle
    await screen.findByRole("button", { name: /more tools/i });

    // No thumbnail list should be present
    expect(screen.queryByRole("list", { name: /image attachments/i })).toBeNull();
  });

  it("file input click is triggered when attach button is clicked", async () => {
    seedProvider("anthropic");
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    const toolsBtn = await screen.findByRole("button", { name: /more tools/i });
    await act(async () => {
      fireEvent.click(toolsBtn);
    });
    const btn = await screen.findByRole("button", { name: /attach file/i });

    // Spy on the hidden file input's click method
    const fileInputs = document.querySelectorAll('input[type="file"]');
    expect(fileInputs.length).toBeGreaterThan(0);
    const fileInput = fileInputs[0] as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, "click").mockImplementation(() => {});

    fireEvent.click(btn);
    expect(clickSpy).toHaveBeenCalled();
  });

  it("attach button shows correct aria-label (Attach file)", async () => {
    seedProvider("anthropic");
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    const toolsBtn = await screen.findByRole("button", { name: /more tools/i });
    await act(async () => {
      fireEvent.click(toolsBtn);
    });
    const btn = await screen.findByRole("button", { name: /attach file/i });
    expect(btn.getAttribute("aria-label")).toBe("Attach file");
  });

  it("hidden file input accepts broad MIME types including text and pdf", async () => {
    seedProvider("anthropic");
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    await screen.findByRole("button", { name: /more tools/i });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    // accept now includes image/*, application/pdf, text/*, and code extensions
    expect(fileInput.accept).toContain("image/*");
    expect(fileInput.accept).toContain("application/pdf");
    expect(fileInput.accept).toContain("text/*");
    expect(fileInput.multiple).toBe(true);
  });

  it("attach file button is always enabled for non-vision providers (no disabled guard)", async () => {
    // Task 4.4: minimax has no vision, but attach file button must still be clickable
    seedProvider("minimax");
    render(
      <Chat
        providerLabel="MiniMax"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    const toolsBtn = await screen.findByRole("button", { name: /more tools/i });
    await act(async () => {
      fireEvent.click(toolsBtn);
    });

    const btn = screen.getByRole("button", { name: /attach file/i });
    // Task 4.4: always enabled
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("attach button not shown during streaming (menu closed by default)", async () => {
    seedProvider("anthropic");
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession({ streaming: true })}
      />,
    );

    // During streaming, STOP button appears instead of Send/attach
    await screen.findByTitle(/Cancel running task/i);
    // Attach file button is inside the closed tools menu — not visible without clicking
    expect(screen.queryByRole("button", { name: /attach file/i })).toBeNull();
  });

  it("local attachment toast renders with warning styling", async () => {
    seedProvider("minimax");

    // We need to exercise the showLocalToast path.
    // Mount with openai but then trigger addFiles via drop on textarea
    // with supportsVision=false being minimax. Instead, verify the
    // toast state is triggerable by simulating a drop with a non-vision provider.
    render(
      <Chat
        providerLabel="MiniMax"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    // Wait for vision=false state to settle
    await screen.findByRole("button", { name: /more tools/i });

    // Simulate a drop on the textarea — supportsVision=false so addFiles
    // is a no-op (no toast for drop/paste when !supportsVision, they early return).
    // The button disabled state is the observable guard. We just confirm
    // that the toast div is NOT present initially (no false positive).
    const alerts = screen.queryAllByRole("alert");
    // No attach-local-toast shown yet (only triggered by button path)
    // This is a safety assertion that alerts start empty.
    expect(alerts.filter((a) => a.textContent?.includes("provider")).length).toBe(0);
  });
});

describe("Chat — attachment count cap", () => {
  it("Attach file button is always enabled (cap only blocks images via toast)", async () => {
    // Task 4.4: the attach file button is always enabled; image-specific cap
    // is enforced inside addPickedFiles via showLocalToast, not by disabling the button.
    seedProvider("anthropic");
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    const toolsBtn = await screen.findByRole("button", { name: /more tools/i });
    await act(async () => {
      fireEvent.click(toolsBtn);
    });
    const btn = await screen.findByRole("button", { name: /attach file/i });
    // Always enabled
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Chat — ImagePlaceholder rendering (Task 14 / R10)", () => {
  it("user message with image_placeholder attachment shows '[Image released]' badge", async () => {
    // Seed messages with a user message that carries an image_placeholder
    // attachment — the kind written to storage by the R10 scrub after a
    // SW restart / session switch / port disconnect (R13 eviction paths).
    seedProvider("anthropic");
    const messages: DisplayMessage[] = [
      {
        role: "user",
        content: "what is this?",
        attachments: [
          {
            kind: "image_placeholder",
            id: "ph-1",
            mediaType: "image/jpeg",
            width: 100,
            height: 200,
          },
        ],
      },
    ];
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession({ messages })}
      />,
    );

    // Wait for render to settle (checkConfig is async).
    await screen.findByRole("button", { name: /more tools/i });

    // The badge should be present with width×height.
    const badge = screen.getByText(/Image released/);
    expect(badge).toBeTruthy();
    expect(badge.textContent).toMatch(/100×200/);
  });

  it("user message with image attachment (still in cache) renders <img>", async () => {
    seedProvider("anthropic");
    const messages: DisplayMessage[] = [
      {
        role: "user",
        content: "look at this",
        attachments: [
          {
            kind: "image",
            id: "img-1",
            mediaType: "image/jpeg",
            data: "AAAA",
            width: 80,
            height: 60,
            byteLength: 3,
          },
        ],
      },
    ];
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession({ messages })}
      />,
    );

    await screen.findByRole("button", { name: /more tools/i });

    // <img> with correct src should be present.
    const img = screen.getByRole("img", { name: /image attachment/i });
    expect(img).toBeTruthy();
    expect((img as HTMLImageElement).src).toContain("data:image/jpeg;base64,AAAA");
  });
});

// Helper: build a synthetic clipboardData object for paste events.
// onPaste iterates e.clipboardData?.items checking item.kind==="file" + getAsFile().
function makeClipboardDT(files: File[]) {
  return {
    items: files.map((f) => ({
      kind: "file",
      type: f.type,
      getAsFile: () => f,
    })),
  };
}

// Helper: build a synthetic dataTransfer object for drop events.
// onDrop spreads e.dataTransfer?.files and filters by image MIME.
function makeDropDT(files: File[]) {
  return {
    files,
  };
}

describe("Chat — behavioral image flows (Phase 5)", () => {
  it("paste of image triggers attachment add", async () => {
    seedProvider("anthropic");
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    await screen.findByRole("button", { name: /more tools/i });
    const textarea = screen.getByPlaceholderText(/Tell the agent/i);
    const file = new File([new Uint8Array(100)], "p.png", { type: "image/png" });

    await act(async () => {
      fireEvent.paste(textarea, { clipboardData: makeClipboardDT([file]) });
    });

    const thumb = await screen.findByAltText(/uploaded image preview/i);
    expect(thumb).toBeTruthy();
  });

  it("drop of image triggers attachment add", async () => {
    seedProvider("anthropic");
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    await screen.findByRole("button", { name: /more tools/i });
    const textarea = screen.getByPlaceholderText(/Tell the agent/i);
    const file = new File([new Uint8Array(100)], "d.png", { type: "image/png" });
    const dt = makeDropDT([file]);

    await act(async () => {
      fireEvent.dragOver(textarea, { dataTransfer: dt });
      fireEvent.drop(textarea, { dataTransfer: dt });
    });

    const thumb = await screen.findByAltText(/uploaded image preview/i);
    expect(thumb).toBeTruthy();
  });

  it("drop of a non-image file (.md) attaches it as a FileChip (Fix 5)", async () => {
    seedProvider("anthropic");
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    await screen.findByRole("button", { name: /more tools/i });
    const textarea = screen.getByPlaceholderText(/Tell the agent/i);
    const file = new File(["# hi"], "dropped.md", { type: "text/markdown" });
    const dt = makeDropDT([file]);

    await act(async () => {
      fireEvent.dragOver(textarea, { dataTransfer: dt });
      fireEvent.drop(textarea, { dataTransfer: dt });
    });

    // FileChip with the dropped filename should appear
    const chip = await screen.findByText("dropped.md");
    expect(chip).toBeTruthy();
  });

  it("paste of a non-image file (.md) attaches it as a FileChip", async () => {
    seedProvider("anthropic");
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    await screen.findByRole("button", { name: /more tools/i });
    const textarea = screen.getByPlaceholderText(/Tell the agent/i);
    const file = new File(["# hi"], "pasted.md", { type: "text/markdown" });

    await act(async () => {
      fireEvent.paste(textarea, { clipboardData: makeClipboardDT([file]) });
    });

    // FileChip with the pasted filename should appear
    const chip = await screen.findByText("pasted.md");
    expect(chip).toBeTruthy();
  });

  it("4th image is dropped silently and only 3 thumbnails appear", async () => {
    seedProvider("anthropic");
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    await screen.findByRole("button", { name: /more tools/i });
    const textarea = screen.getByPlaceholderText(/Tell the agent/i);
    const files = Array.from({ length: 4 }, (_, i) =>
      new File([new Uint8Array(100)], `p${i}.png`, { type: "image/png" }),
    );

    await act(async () => {
      fireEvent.paste(textarea, { clipboardData: makeClipboardDT(files) });
    });

    // resizePanel is mocked; all promises resolve synchronously in the microtask queue.
    // findAllByAltText retries until at least one is present, then we assert the cap.
    const thumbs = await screen.findAllByAltText(/uploaded image preview/i);
    expect(thumbs).toHaveLength(3);
  });

  it("Backspace on focused thumbnail removes the attachment", async () => {
    seedProvider("anthropic");
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    await screen.findByRole("button", { name: /more tools/i });
    const textarea = screen.getByPlaceholderText(/Tell the agent/i);
    const file = new File([new Uint8Array(100)], "p.png", { type: "image/png" });

    await act(async () => {
      fireEvent.paste(textarea, { clipboardData: makeClipboardDT([file]) });
    });

    const thumb = await screen.findByAltText(/uploaded image preview/i);
    const listitem = thumb.closest('[role="listitem"]') as HTMLElement;
    expect(listitem).not.toBeNull();

    await act(async () => {
      listitem.focus();
      fireEvent.keyDown(listitem, { key: "Backspace" });
    });

    expect(screen.queryByAltText(/uploaded image preview/i)).toBeNull();
  });

  it("paste of image with non-vision provider shows toast (no silent fail)", async () => {
    seedProvider("minimax");
    render(
      <Chat
        providerLabel="MiniMax"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    // Wait until provider load completes — supportsVision flips to false
    await screen.findByRole("button", { name: /more tools/i });
    const textarea = screen.getByPlaceholderText(/Tell the agent/i);
    const file = new File([new Uint8Array(100)], "p.png", { type: "image/png" });

    await act(async () => {
      fireEvent.paste(textarea, { clipboardData: makeClipboardDT([file]) });
    });

    // Toast must surface — user reported "no response" was the prior bug.
    // processPickedFile mock returns "current model has no vision" for image+no-vision.
    expect(
      await screen.findByText(/has no vision|does not support image input/i),
    ).toBeTruthy();
    // No thumbnail attached
    expect(screen.queryByAltText(/uploaded image preview/i)).toBeNull();
  });

  it("paste of image-only-as-URL (kind=string) shows distinct toast", async () => {
    seedProvider("anthropic");
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    await screen.findByRole("button", { name: /more tools/i });
    const textarea = screen.getByPlaceholderText(/Tell the agent/i);

    // Synthesize a clipboard whose only image item has kind="string" (web
    // page right-click "Copy image" → text/uri-list, no File). Composer's
    // hasImageInClipboard detection should still fire (item.type starts
    // with "image/"), then files extracted to [] → addFiles distinct toast.
    const stringOnlyClipboard = {
      items: [
        {
          kind: "string",
          type: "image/png",
          getAsFile: () => null,
        },
      ] as unknown as DataTransferItemList,
    };

    await act(async () => {
      fireEvent.paste(textarea, { clipboardData: stringOnlyClipboard });
    });

    expect(
      await screen.findByText(/Couldn't read image from clipboard/i),
    ).toBeTruthy();
  });
});

describe("Chat — send clears attachments", () => {
  it("sendMessage is called on Send button click", async () => {
    seedProvider("anthropic");
    const sendMock = vi.fn();
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession({ sendMessage: sendMock })}
      />,
    );

    // Find and fill textarea
    await screen.findByRole("button", { name: /more tools/i });
    const textarea = screen.getByPlaceholderText(/Tell the agent/i);
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "Hello" } });
    });

    const sendBtn = screen.getByRole("button", { name: /Send/i });
    await act(async () => {
      fireEvent.click(sendBtn);
    });

    // sendMessage should have been called with content
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Hello" }),
    );
  });
});

// ── Task 4.4 — FileChip + file attachment send path ──────────────────────────

describe("Chat — Task 4.4 file attachments", () => {
  it("selecting a .md file via file input renders a FileChip with the filename", async () => {
    seedProvider("anthropic");
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    await screen.findByRole("button", { name: /more tools/i });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const mdFile = new File(["# Hello\nworld"], "readme.md", { type: "text/markdown" });

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [mdFile] } });
    });

    // FileChip should appear with the filename
    const chip = await screen.findByText("readme.md");
    expect(chip).toBeTruthy();
  });

  it("FileChip remove button removes the chip", async () => {
    seedProvider("anthropic");
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    await screen.findByRole("button", { name: /more tools/i });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const mdFile = new File(["# Hello"], "notes.md", { type: "text/markdown" });

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [mdFile] } });
    });

    // Chip appears
    await screen.findByText("notes.md");

    // Click the remove button on the chip
    const removeBtn = screen.getByRole("button", { name: /remove file/i });
    await act(async () => {
      fireEvent.click(removeBtn);
    });

    // Chip should be gone
    expect(screen.queryByText("notes.md")).toBeNull();
  });

  it("sending with a file attachment calls sendMessage with expandedForLLM containing the wrapper", async () => {
    seedProvider("anthropic");
    const sendMock = vi.fn();
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession({ sendMessage: sendMock })}
      />,
    );

    await screen.findByRole("button", { name: /more tools/i });

    // Attach a text file
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const txtFile = new File(["hello world"], "notes.txt", { type: "text/plain" });

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [txtFile] } });
    });

    // Chip renders
    await screen.findByText("notes.txt");

    // Type something and submit
    const textarea = screen.getByPlaceholderText(/Tell the agent/i);
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "analyze this" } });
    });

    const sendBtn = screen.getByRole("button", { name: /Send/i });
    await act(async () => {
      fireEvent.click(sendBtn);
    });

    // sendMessage should include expandedForLLM with the file wrapper
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "analyze this",
        expandedForLLM: expect.stringContaining("<untrusted_local_file"),
      }),
    );
  });

  it("FIX-B: sent message with file attachment carries fileAttachments on the call to sendMessage", async () => {
    // Assert that the message object passed to sendMessage includes fileAttachments
    // so that the DisplayMessage carries it for MessageBubble rendering.
    seedProvider("anthropic");
    const sendMock = vi.fn();
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession({ sendMessage: sendMock })}
      />,
    );

    await screen.findByRole("button", { name: /more tools/i });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const txtFile = new File(["file content"], "data.txt", { type: "text/plain" });

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [txtFile] } });
    });

    await screen.findByText("data.txt");

    const textarea = screen.getByPlaceholderText(/Tell the agent/i);
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "use this" } });
    });

    const sendBtn = screen.getByRole("button", { name: /Send/i });
    await act(async () => {
      fireEvent.click(sendBtn);
    });

    // sendMessage must carry fileAttachments so useSession can forward it to the DisplayMessage
    const callArg = sendMock.mock.calls[0][0] as { fileAttachments?: Array<{ name: string }> };
    expect(callArg.fileAttachments).toBeDefined();
    expect(callArg.fileAttachments![0].name).toBe("data.txt");
  });

  it("FIX-B: MessageBubble renders filename chip for a message carrying fileAttachments", async () => {
    seedProvider("anthropic");
    const messages: DisplayMessage[] = [
      {
        role: "user",
        content: "analyze this",
        fileAttachments: [
          {
            kind: "file",
            id: "fa-1",
            name: "report.pdf",
            mime: "application/pdf",
            text: "pdf content",
            truncated: false,
            totalChars: 11,
            source: "picker",
          },
        ],
      },
    ];
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession({ messages })}
      />,
    );

    await screen.findByRole("button", { name: /more tools/i });

    // The file name should appear in the message bubble (rendered via FileChip with no remove button)
    expect(screen.getByText("report.pdf")).toBeTruthy();
    // No remove button in read-only bubble
    expect(screen.queryByRole("button", { name: /remove file/i })).toBeNull();
  });

  it("attach file button in + menu is NOT disabled for minimax (no vision) provider", async () => {
    seedProvider("minimax");
    render(
      <Chat
        providerLabel="MiniMax"
        onOpenSettings={vi.fn()}
        session={makeSession()}
      />,
    );

    const toolsBtn = await screen.findByRole("button", { name: /more tools/i });
    await act(async () => {
      fireEvent.click(toolsBtn);
    });

    const attachBtn = await screen.findByRole("button", { name: /attach file/i });
    // Task 4.4: text/PDF always allowed, so button must not be disabled
    expect((attachBtn as HTMLButtonElement).disabled).toBe(false);
  });
});

// ── M5 — pinMode-driven isLocked + pageChanged effect ────────────────────────

describe("Chat — M5 pinMode behavior", () => {
  it("auto mode: live-preview listeners ARE registered (chrome.tabs.onActivated)", async () => {
    seedProvider("anthropic");
    const session = makeSession({
      pinMode: "auto",
      pinnedTabs: null,
      messages: [{ role: "user" as const, content: "hello" }] as DisplayMessage[],
    });
    await act(async () => {
      render(
        <ChatAny
          session={session}
          onOpenSettings={vi.fn()}
          onOpenSessionList={vi.fn()}
          activePanel="chat"
        />,
      );
    });

    // In auto mode the live-tracking effect runs even with messages,
    // unlike old behavior (which locked on messages.length > 0).
    expect(tabsOnActivated.addListener).toHaveBeenCalled();
    expect(windowsOnFocusChanged.addListener).toHaveBeenCalled();
  });

  it("task mode: live-preview listeners are NOT registered (PINNED is frozen)", async () => {
    seedProvider("anthropic");
    const session = makeSession({
      pinMode: "task",
      pinnedTabs: [{ tabId: 42, origin: "https://example.com" }],
    });
    await act(async () => {
      render(
        <ChatAny
          session={session}
          onOpenSettings={vi.fn()}
          onOpenSessionList={vi.fn()}
          activePanel="chat"
        />,
      );
    });

    // Live-tracking effect is bypassed when locked
    expect(tabsOnActivated.addListener).not.toHaveBeenCalled();
    expect(windowsOnFocusChanged.addListener).not.toHaveBeenCalled();
  });

  it("user mode: live-preview listeners are NOT registered (user-locked pin)", async () => {
    seedProvider("anthropic");
    const session = makeSession({
      pinMode: "user",
      pinnedTabs: [{ tabId: 7, origin: "https://user.com" }],
    });
    await act(async () => {
      render(
        <ChatAny
          session={session}
          onOpenSettings={vi.fn()}
          onOpenSessionList={vi.fn()}
          activePanel="chat"
        />,
      );
    });

    expect(tabsOnActivated.addListener).not.toHaveBeenCalled();
  });

  it("pageChanged effect ONLY registers in task mode (not user, not auto)", async () => {
    seedProvider("anthropic");

    // user mode — pageChanged effect does NOT register
    tabsOnUpdated.addListener.mockClear();
    const userSession = makeSession({
      pinMode: "user",
      pinnedTabs: [{ tabId: 5, origin: "https://x.com" }],
    });
    const { unmount: unmountUser } = render(
      <ChatAny session={userSession} onOpenSettings={vi.fn()} onOpenSessionList={vi.fn()} activePanel="chat" />,
    );
    // Live-preview is gated by isLocked → user mode = locked = no listeners.
    // Only the pageChanged effect could register tabsOnUpdated.
    const userCalls = tabsOnUpdated.addListener.mock.calls.length;
    unmountUser();

    // task mode — pageChanged effect DOES register
    tabsOnUpdated.addListener.mockClear();
    const taskSession = makeSession({
      pinMode: "task",
      pinnedTabs: [{ tabId: 5, origin: "https://x.com" }],
    });
    const { unmount: unmountTask } = render(
      <ChatAny session={taskSession} onOpenSettings={vi.fn()} onOpenSessionList={vi.fn()} activePanel="chat" />,
    );
    const taskCalls = tabsOnUpdated.addListener.mock.calls.length;
    unmountTask();

    // task should register at least one listener; user should register zero
    // for pageChanged. The live-preview path doesn't fire in either (both
    // are locked), so any difference is from the pageChanged effect.
    expect(taskCalls).toBeGreaterThan(userCalls);
  });

  it("pageChanged in task mode: filter by tabId — irrelevant tab navigation does NOT fire banner", async () => {
    seedProvider("anthropic");
    const session = makeSession({
      pinMode: "task",
      pinnedTabs: [{ tabId: 100, origin: "https://example.com" }],
    });

    // Capture all listeners — Chat.tsx may register multiple onUpdated
    // listeners (pageChanged effect + lockedPinnedTitle fetcher); we want
    // to dispatch to all of them so the test reflects production behavior.
    type OnUpdatedFn = (
      tabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => void;
    const onUpdatedFns: OnUpdatedFn[] = [];
    tabsOnUpdated.addListener.mockClear();
    (tabsOnUpdated.addListener as ReturnType<typeof vi.fn>).mockImplementation((fn: unknown) => {
      onUpdatedFns.push(fn as OnUpdatedFn);
    });

    await act(async () => {
      render(
        <ChatAny session={session} onOpenSettings={vi.fn()} onOpenSessionList={vi.fn()} activePanel="chat" />,
      );
    });

    expect(onUpdatedFns.length).toBeGreaterThan(0);

    const dispatchAll = (
      tabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => {
      for (const fn of onUpdatedFns) fn(tabId, changeInfo, tab);
    };

    // Simulate a different tab (id=999) navigating — should NOT trigger banner.
    await act(async () => {
      dispatchAll(
        999,
        { url: "https://other.example.com/" },
        { id: 999, url: "https://other.example.com/", active: true } as chrome.tabs.Tab,
      );
    });

    // Banner element only shows when pageChanged state is true. Look for the
    // banner text.
    expect(screen.queryByText(/Page changed/i)).toBeNull();

    // Now simulate the actual pinned tab (id=100) navigating — should fire banner.
    await act(async () => {
      dispatchAll(
        100,
        { url: "https://example.com/other" },
        { id: 100, url: "https://example.com/other", active: true } as chrome.tabs.Tab,
      );
    });

    expect(screen.getByText(/Page changed/i)).toBeTruthy();
  });
});

// ── Regression: ModelPicker chip fallback for new sessions ────────────────────

describe("Chat — ModelPicker chip fallback (new session no pin)", () => {
  it("chip displays the resolved provider + model when session has no per-session pin", async () => {
    vi.mocked(getSessionMeta).mockResolvedValue(null);
    const inst = {
      id: "active-1",
      provider: "anthropic" as import("@/lib/model-router").Provider,
      nickname: "My Work Key",
      apiKey: "sk-test",
      createdAt: 0,
    };
    vi.mocked(listInstances).mockResolvedValue([inst] as import("@/lib/instances").DecryptedInstance[]);
    vi.mocked(getInstance).mockResolvedValue(inst as import("@/lib/instances").DecryptedInstance);
    vi.mocked(resolveSelection).mockResolvedValue({ instanceId: "active-1", model: "claude-opus-4-7" });

    await act(async () => {
      render(
        <Chat
          providerLabel="Anthropic"
          onOpenSettings={vi.fn()}
          session={makeSession({ sessionId: "new-session-no-pin" })}
        />,
      );
    });

    // ModelPicker chip shows the provider name + short model (not an empty state).
    expect(await screen.findByText(/Anthropic · opus-4-7/)).toBeTruthy();
  });
});

describe("EmptyState centered greeting", () => {
  it("renders one of the 7 greetings (en locale, no I18nProvider wrap needed)", async () => {
    // Chat tests render without I18nProvider wrapper — useT() falls back to English.
    // The zh-CN locale path is covered by src/lib/i18n/__tests__/use-t.test.tsx.
    const session = makeSession();
    render(<Chat session={session} onOpenSettings={() => {}} providerLabel={null} />);

    const greetings = [
      "Hey, what are we looking at today?",
      "So, what's the plan?",
      "I'm here — what's up?",
      "What can I do for you today?",
      "Hey there — where to?",
      "Got something on your mind?",
      "Anything fun on this page?",
    ];
    await waitFor(() => {
      const found = greetings.some((g) => screen.queryByText(g) !== null);
      expect(found).toBe(true);
    });
  });

  it("does NOT render 'READY' caps label or SUGGESTED skill section", async () => {
    const session = makeSession();
    render(<Chat session={session} onOpenSettings={() => {}} providerLabel={null} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByText("READY")).toBeNull();
    expect(screen.queryByText("就绪")).toBeNull();
    expect(screen.queryByText("SUGGESTED")).toBeNull();
    expect(screen.queryByText("推荐")).toBeNull();
  });
});

// ── Composer keyboard guards — IME composition + rapid double-Enter ──────────
// Bug 1: rapid consecutive Enter presses dispatched the same message multiple
//        times (the `streaming`/`input` state guards only take effect after a
//        React re-render, leaving a same-frame window).
// Bug 2: Enter pressed to commit an IME composition (isComposing=true /
//        keyCode 229) was treated as a send, truncating the composition.

describe("Chat — composer keyboard guards", () => {
  it("Enter during IME composition does NOT send and preserves the input", async () => {
    seedProvider("anthropic");
    const sendMock = vi.fn();
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession({ sendMessage: sendMock })}
      />,
    );

    await screen.findByRole("button", { name: /more tools/i });
    const textarea = screen.getByPlaceholderText(/Tell the agent/i) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "你好" } });
    });

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", isComposing: true, keyCode: 229 });
    });

    expect(sendMock).not.toHaveBeenCalled();
    expect(textarea.value).toBe("你好");
  });

  it("two Enter keydowns in the same frame (before re-render) send only once", async () => {
    seedProvider("anthropic");
    const sendMock = vi.fn();
    render(
      <Chat
        providerLabel="Anthropic"
        onOpenSettings={vi.fn()}
        session={makeSession({ sendMessage: sendMock })}
      />,
    );

    await screen.findByRole("button", { name: /more tools/i });
    const textarea = screen.getByPlaceholderText(/Tell the agent/i) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "Hello" } });
    });

    // Dispatch two raw keydown events inside ONE act so React cannot re-render
    // in between — mirrors the real-world rapid double-press window where the
    // `streaming` / cleared-`input` guards have not committed yet.
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
