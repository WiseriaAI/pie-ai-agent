import "fake-indexeddb/auto";
import { beforeEach, vi } from "vitest";

// chrome.storage.local mock — backed by a single in-memory record reset
// between tests. Mirrors the subset of chrome.storage.local API actually
// used by src/lib/sessions/storage.ts and other M1+ surfaces:
//   - get(key | string[] | null)  → returns { [key]: value }
//   - set(items)                  → atomic batch; setting value=undefined removes
//   - remove(key | string[])      → bulk remove
//   - getBytesInUse(key | null)   → JSON-length approximation (real Chrome counts
//                                   utf-16 lengths; our approximation is good
//                                   enough for quota-threshold tests, which is the
//                                   only thing we're checking)
//
// `__store` is exposed for tests that want to seed state directly without going
// through the public API.

interface StorageRecord {
  [key: string]: unknown;
}

const local = {
  __store: {} as StorageRecord,

  get(
    keys?: string | string[] | null,
  ): Promise<Record<string, unknown>> {
    if (keys === null || keys === undefined) {
      return Promise.resolve({ ...local.__store });
    }
    if (typeof keys === "string") {
      return Promise.resolve(
        keys in local.__store ? { [keys]: local.__store[keys] } : {},
      );
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (k in local.__store) out[k] = local.__store[k];
    }
    return Promise.resolve(out);
  },

  set(items: Record<string, unknown>): Promise<void> {
    const changes: Record<string, chrome.storage.StorageChange> = {};
    for (const [k, v] of Object.entries(items)) {
      const oldValue = local.__store[k];
      if (v === undefined) {
        delete local.__store[k];
      } else {
        local.__store[k] = v;
      }
      changes[k] = { oldValue, newValue: v };
    }
    // Emit onChanged after the store is updated (non-blocking).
    Promise.resolve().then(() => {
      for (const l of local.__changedListeners) l(changes, "local");
    });
    return Promise.resolve();
  },

  remove(keys: string | string[]): Promise<void> {
    const arr = typeof keys === "string" ? [keys] : keys;
    for (const k of arr) delete local.__store[k];
    return Promise.resolve();
  },

  getBytesInUse(keys?: string | string[] | null): Promise<number> {
    let total = 0;
    const targets =
      keys === null || keys === undefined
        ? Object.keys(local.__store)
        : typeof keys === "string"
          ? [keys]
          : keys;
    for (const k of targets) {
      if (!(k in local.__store)) continue;
      total += k.length + JSON.stringify(local.__store[k]).length;
    }
    return Promise.resolve(total);
  },

  clear(): Promise<void> {
    local.__store = {};
    return Promise.resolve();
  },

  __changedListeners: [] as Array<(
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => void>,
  onChanged: {
    addListener(
      l: (
        changes: Record<string, chrome.storage.StorageChange>,
        areaName: string,
      ) => void,
    ) {
      local.__changedListeners.push(l);
    },
    removeListener(
      l: (
        changes: Record<string, chrome.storage.StorageChange>,
        areaName: string,
      ) => void,
    ) {
      local.__changedListeners = local.__changedListeners.filter((x) => x !== l);
    },
  },
  __emitChange(
    changes: Record<string, chrome.storage.StorageChange>,
    areaName = "local",
  ) {
    for (const l of local.__changedListeners) l(changes, areaName);
  },
};

// chrome.runtime.connect mock — returns a FakePort whose onMessage /
// onDisconnect listeners can be triggered by test code via `port.__emit(...)`
// / `port.__triggerDisconnect()`. Each connect() pushes the new port onto
// __ports so tests can inspect the most recent one.

type Listener<T> = (value: T) => void;

export interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (l: Listener<unknown>) => void };
  onDisconnect: { addListener: (l: Listener<unknown>) => void };
  /** Test-only: fire all registered onMessage listeners. */
  __emit: (msg: unknown) => void;
  /** Test-only: fire all registered onDisconnect listeners. */
  __triggerDisconnect: () => void;
  /** Test-only: the raw listener array (for tests that fire a specific listener). */
  __onMessageListeners: Array<Listener<unknown>>;
  /** Test-only: the raw disconnect listener array. */
  __onDisconnectListeners: Array<Listener<unknown>>;
}

function createFakePort(name: string): FakePort {
  const messageListeners: Array<Listener<unknown>> = [];
  const disconnectListeners: Array<Listener<unknown>> = [];

  return {
    name,
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: (l) => messageListeners.push(l),
    },
    onDisconnect: {
      addListener: (l) => disconnectListeners.push(l),
    },
    __emit: (msg) => {
      for (const l of messageListeners) l(msg);
    },
    __triggerDisconnect: () => {
      for (const l of disconnectListeners) l(undefined);
    },
    __onMessageListeners: messageListeners,
    __onDisconnectListeners: disconnectListeners,
  };
}

const runtime = {
  __ports: [] as FakePort[],
  connect: vi.fn((info: { name: string }) => {
    const port = createFakePort(info.name);
    runtime.__ports.push(port);
    return port;
  }),
  getPlatformInfo: vi.fn().mockResolvedValue({ os: "mac" }),
  getURL: vi.fn((p: string) => `chrome-extension://test/${p}`),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  onStartup: { addListener: vi.fn() },
  onInstalled: { addListener: vi.fn() },
  onConnect: { addListener: vi.fn() },
  // runtime.onMessage — capture listeners so tests can fire SW→panel runtime
  // broadcasts (e.g. quote-needs-reconnect). __emitMessage drives them.
  __messageListeners: [] as Array<Listener<unknown>>,
  onMessage: {
    addListener: (l: Listener<unknown>) => {
      runtime.__messageListeners.push(l);
    },
    removeListener: (l: Listener<unknown>) => {
      const i = runtime.__messageListeners.indexOf(l);
      if (i >= 0) runtime.__messageListeners.splice(i, 1);
    },
  },
  __emitMessage: (msg: unknown) => {
    for (const l of [...runtime.__messageListeners]) l(msg);
  },
};

// chrome.tabs mock — minimum surface for M3-U2 pin capture / pinned-tab
// registry tests. Tests can override `__activeTab` to control what
// `chrome.tabs.query({active:true,currentWindow:true})` returns.
interface FakeTab {
  id: number;
  url: string;
  title?: string;
  active?: boolean;
  windowId?: number;
}

const tabs = {
  __activeTab: null as FakeTab | null,
  __tabsById: new Map<number, FakeTab>(),
  query: vi.fn(async (info: chrome.tabs.QueryInfo): Promise<FakeTab[]> => {
    if (info.active && info.currentWindow) {
      return tabs.__activeTab ? [tabs.__activeTab] : [];
    }
    return Array.from(tabs.__tabsById.values());
  }),
  get: vi.fn(async (id: number): Promise<FakeTab> => {
    const t = tabs.__tabsById.get(id);
    if (!t) throw new Error(`No tab with id ${id}`);
    return t;
  }),
};

// chrome.webNavigation mock — wait-for-settle.ts adds onCommitted /
// onHistoryStateUpdated listeners around any DOM-touching action. Tests
// that exercise action handlers (click / type / keyboard) need the API to
// exist so the listener registration doesn't throw. Tests that want to
// drive nav events directly can call the exposed __emit* helpers.
type NavListener = (
  details: chrome.webNavigation.WebNavigationFramedCallbackDetails,
) => void;

const webNavigation = {
  __committedListeners: [] as NavListener[],
  __historyListeners: [] as NavListener[],
  getAllFrames: vi.fn(() => Promise.resolve([])),
  onCommitted: {
    addListener: (l: NavListener) => webNavigation.__committedListeners.push(l),
    removeListener: (l: NavListener) => {
      webNavigation.__committedListeners = webNavigation.__committedListeners.filter(
        (x) => x !== l,
      );
    },
  },
  onHistoryStateUpdated: {
    addListener: (l: NavListener) => webNavigation.__historyListeners.push(l),
    removeListener: (l: NavListener) => {
      webNavigation.__historyListeners = webNavigation.__historyListeners.filter(
        (x) => x !== l,
      );
    },
  },
};

const i18n = {
  __uiLanguage: "en" as string,
  getUILanguage: vi.fn(() => i18n.__uiLanguage),
  getMessage: vi.fn((key: string) => key),
};

const downloads = {
  download: vi.fn(async () => 1),
};

const extension = {
  isAllowedFileSchemeAccess: vi.fn(async () => true),
};

const chromeMock = {
  storage: {
    local,
    onChanged: {
      addListener: local.onChanged.addListener,
      removeListener: local.onChanged.removeListener,
    },
  },
  runtime,
  tabs,
  webNavigation,
  i18n,
  downloads,
  extension,
};

// Install on globalThis so `chrome.storage.local.get(...)` works in src code.
// Cast through unknown to avoid clashing with the official @types/chrome shape.
(globalThis as unknown as { chrome: typeof chromeMock }).chrome = chromeMock;

// happy-dom does not compute CSS layout — getBoundingClientRect() returns all zeros
// for every element. Injected snapshot functions use isVisible() which checks
// rect.width > 0 && rect.height > 0 to filter hidden elements. Without this stub,
// every element appears invisible and all snapshots come back empty in unit tests.
const _origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function () {
  const rect = _origGetBoundingClientRect.call(this);
  if (rect.width === 0 && rect.height === 0) {
    return { x: 0, y: 0, width: 100, height: 20, top: 0, right: 100, bottom: 20, left: 0 } as DOMRect;
  }
  return rect;
};

// happy-dom lacks the Web Animations API (no Element.prototype.animate).
//  - @formkit/auto-animate calls it directly inside a MutationObserver callback;
//    without the method it throws "el.animate is not a function" as an UNHANDLED
//    error that fails the whole run.
//  - motion (framer-motion) PREFERS WAAPI when Element.prototype.animate exists,
//    falling back to rAF otherwise. So once we add a stub, motion uses it — and a
//    "never finishes" stub would hang AnimatePresence exits forever (the node
//    never unmounts). The stub must therefore report the animation as INSTANTLY
//    finished: `finished` resolves immediately and `onfinish` fires on the next
//    microtask as soon as a handler is attached (covers both completion paths).
if (typeof Element !== "undefined" && typeof Element.prototype.animate !== "function") {
  Element.prototype.animate = function () {
    const anim = {
      finished: Promise.resolve(),
      oncancel: null,
      _onfinish: null as null | (() => void),
      get onfinish(): null | (() => void) {
        return this._onfinish;
      },
      set onfinish(fn: null | (() => void)) {
        this._onfinish = fn;
        if (fn) queueMicrotask(() => fn.call(this));
      },
      cancel() {},
      finish() {
        this._onfinish?.();
      },
      play() {},
      pause() {},
      reverse() {},
      addEventListener() {},
      removeEventListener() {},
    };
    return anim as unknown as Animation;
  };
}

beforeEach(() => {
  local.__store = {};
  local.__changedListeners = [];
  runtime.__ports = [];
  runtime.__messageListeners = [];
  runtime.connect.mockClear();
  runtime.sendMessage.mockClear();
  tabs.__activeTab = null;
  tabs.__tabsById.clear();
  tabs.query.mockClear();
  tabs.get.mockClear();
  webNavigation.__committedListeners = [];
  webNavigation.__historyListeners = [];
  i18n.__uiLanguage = "en";
  i18n.getUILanguage.mockClear();
  i18n.getMessage.mockClear();
  downloads.download.mockClear();
  extension.isAllowedFileSchemeAccess.mockReset();
  extension.isAllowedFileSchemeAccess.mockResolvedValue(true);
});

export { chromeMock };

// ── Phase 5 multimodal image input — happy-dom polyfill for SW environment ──
//
// happy-dom does not provide OffscreenCanvas / createImageBitmap. Tests that
// exercise resize-sw.ts use these fakes; the wrapper logic (validate → decode
// → downscale → encode) is what we test here, not the canvas pixel ops.

class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  getContext() {
    return { drawImage: () => {} };
  }
  async convertToBlob(opts?: { type?: string; quality?: number }): Promise<Blob> {
    const buf = new Uint8Array(245678);
    return new Blob([buf], { type: opts?.type ?? "image/jpeg" });
  }
}

class FakeImageBitmap {
  constructor(public width: number, public height: number) {}
  close(): void {}
}

(globalThis as unknown as { OffscreenCanvas: typeof FakeOffscreenCanvas }).OffscreenCanvas =
  FakeOffscreenCanvas;
(globalThis as unknown as {
  createImageBitmap: (src: Blob | { width: number; height: number }) => Promise<FakeImageBitmap>;
}).createImageBitmap = async (src) => {
  if ("width" in src && typeof src.width === "number") {
    return new FakeImageBitmap(src.width, src.height);
  }
  return new FakeImageBitmap(3000, 2000);
};
