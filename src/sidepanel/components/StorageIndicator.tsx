import { useCallback, useEffect, useId, useState } from "react";
import { useT } from "@/lib/i18n";
import { getTotalBytes, listSessionsWithBytes, type SessionByteEntry } from "@/lib/sessions/storage";
import { humanSize } from "@/lib/files/mime-label";
import { useStoreChange } from "@/sidepanel/hooks/useStoreChange";
import { Collapse } from "./ui/Collapse";

const MONO = "'JetBrains Mono', monospace";

export function StorageIndicator() {
  const t = useT();
  const listId = useId();
  const [usedBytes, setUsedBytes] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<SessionByteEntry[]>([]);

  const loadTotal = useCallback(async () => { setUsedBytes(await getTotalBytes()); }, []);
  const loadRows = useCallback(async () => { setRows(await listSessionsWithBytes()); }, []);

  useEffect(() => { void loadTotal(); }, [loadTotal]);
  useEffect(() => { if (expanded) void loadRows(); }, [expanded, loadRows]);

  const refresh = useCallback(() => {
    void loadTotal();
    if (expanded) void loadRows();
  }, [loadTotal, loadRows, expanded]);
  useStoreChange("sessions", refresh);
  useStoreChange("config", () => { void loadTotal(); });
  useStoreChange("instances", () => { void loadTotal(); });

  const usedMB = usedBytes / (1024 * 1024);

  return (
    <div style={{ marginTop: "auto", padding: "14px 16px", borderTop: "1px solid var(--c-line)" }}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          background: "none", border: "none", padding: 0, cursor: "pointer",
        }}
      >
        <span
          style={{
            flex: 1, textAlign: "left", fontFamily: MONO, fontSize: 10, fontWeight: 500,
            color: "var(--c-fg-3)", letterSpacing: "0.12em", textTransform: "uppercase",
          }}
        >
          {t("sessions.storage")}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 500, color: "var(--c-fg-2)" }}>
          {usedMB.toFixed(1)} MB
        </span>
        <svg
          width="9" height="9" viewBox="0 0 12 12" aria-hidden="true"
          style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 150ms", color: "var(--c-fg-3)" }}
        >
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <Collapse open={expanded}>
        <ul
          id={listId}
          role="list"
          style={{ listStyle: "none", margin: "8px 0 0", padding: 0, maxHeight: 240, overflowY: "auto" }}
        >
          {rows.map((r) => (
            <li
              key={r.id}
              role="listitem"
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "6px 0",
                borderTop: "1px solid var(--c-line)",
              }}
            >
              <span
                style={{
                  flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
                  whiteSpace: "nowrap", fontSize: 12, color: "var(--c-fg-1)",
                }}
              >
                {r.title ?? t("sessions.untitled")}
              </span>
              <span style={{ flexShrink: 0, fontFamily: MONO, fontSize: 10, color: "var(--c-fg-3)" }}>
                {humanSize(r.bytes)}
              </span>
            </li>
          ))}
        </ul>
      </Collapse>
    </div>
  );
}
