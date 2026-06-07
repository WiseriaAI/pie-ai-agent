// src/lib/store-bus.ts
//
// Cross-context (SW + panel) change notification bus, replacing the lost
// `chrome.storage.local.onChanged` signal after the IndexedDB migration.
// One BroadcastChannel; each store's write path publishes after the IDB
// transaction commits; consumers subscribe per store name.

import type { StoreName } from "./idb/db";

export interface StoreChange {
  store: StoreName;
  op: "put" | "remove" | "clear";
  id?: string;
}

const CHANNEL = "pie-store";

type Bus = {
  post: (c: StoreChange) => void;
  listen: (cb: (c: StoreChange) => void) => () => void;
};

function makeBus(): Bus {
  // happy-dom / some test envs lack BroadcastChannel — degrade to in-process.
  if (typeof BroadcastChannel === "undefined") {
    const listeners = new Set<(c: StoreChange) => void>();
    return {
      post: (c) => listeners.forEach((l) => l(c)),
      listen: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
  }
  const ch = new BroadcastChannel(CHANNEL);
  const local = new Set<(c: StoreChange) => void>();
  ch.onmessage = (e: MessageEvent<StoreChange>) => local.forEach((l) => l(e.data));
  return {
    // BroadcastChannel does NOT echo to the sender, so notify local listeners too.
    post: (c) => {
      ch.postMessage(c);
      local.forEach((l) => l(c));
    },
    listen: (cb) => {
      local.add(cb);
      return () => local.delete(cb);
    },
  };
}

const bus = makeBus();

export function publishChange(store: StoreName, op: StoreChange["op"], id?: string): void {
  bus.post({ store, op, id });
}

export function onStoreChange(store: StoreName, cb: (c: StoreChange) => void): () => void {
  return bus.listen((c) => {
    if (c.store === store) cb(c);
  });
}
