import { useEffect } from "react";

export interface FileAccessCardProps {
  onDismiss: () => void;
}

export function FileAccessCard({ onDismiss }: FileAccessCardProps) {
  useEffect(() => {
    async function recheck() {
      try {
        const allowed = await chrome.extension.isAllowedFileSchemeAccess();
        if (allowed) onDismiss();
      } catch {
        // chrome.extension may not exist outside MV3 context (tests / SSR)
      }
    }
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, [onDismiss]);

  function openExtensionSettings() {
    const id = chrome.runtime?.id ?? "";
    chrome.tabs.create({ url: `chrome://extensions/?id=${id}` });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning-line bg-warning-tint px-3 py-2.5 text-[12px] leading-[18px] text-warning">
      <div className="text-[13px] font-medium text-warning">
        Reading local files needs permission
      </div>
      <p className="text-warning/90">
        Pie can read local files once you turn on
        <span className="font-medium"> Allow access to file URLs</span> for this
        extension. Click below to open the extension settings, then flip the
        toggle and come back — Pie will pick it up automatically.
      </p>
      <div>
        <button
          type="button"
          onClick={openExtensionSettings}
          className="rounded border border-warning-line bg-warning-tint px-2.5 py-1 text-[11px] font-medium text-warning hover:bg-warning-line/30"
        >
          Allow access to file URLs…
        </button>
      </div>
    </div>
  );
}
