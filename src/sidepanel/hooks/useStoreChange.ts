import { useEffect, useRef } from "react";
import { onStoreChange, type StoreChange } from "@/lib/store-bus";
import type { StoreName } from "@/lib/idb/db";

export function useStoreChange(store: StoreName, cb: (c: StoreChange) => void): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => onStoreChange(store, (c) => ref.current(c)), [store]);
}
