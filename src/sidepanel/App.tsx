import { useState, useEffect } from "react";
import Chat from "@/sidepanel/components/Chat";
import Settings from "@/sidepanel/components/Settings";
import { getActiveProvider, getProviderConfig } from "@/lib/storage";

type Tab = "chat" | "agent" | "tabs" | "settings";

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [providerLabel, setProviderLabel] = useState<string | null>(null);

  useEffect(() => {
    // Check first run
    chrome.storage.local.get("firstRun", (result) => {
      if (result.firstRun) {
        setActiveTab("settings");
        chrome.storage.local.remove("firstRun");
      }
    });

    loadProviderLabel();

    // Refresh label when storage changes (e.g. after saving settings)
    const listener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes.active_provider || Object.keys(changes).some((k) => k.startsWith("provider_"))) {
        loadProviderLabel();
      }
    };
    chrome.storage.local.onChanged.addListener(listener);
    return () => chrome.storage.local.onChanged.removeListener(listener);
  }, []);

  async function loadProviderLabel() {
    const active = await getActiveProvider();
    if (!active) {
      setProviderLabel(null);
      return;
    }
    try {
      const config = await getProviderConfig(active);
      if (config) {
        setProviderLabel(`${active === "anthropic" ? "Claude" : "GPT"} · ${config.model}`);
      } else {
        setProviderLabel(null);
      }
    } catch {
      setProviderLabel(null);
    }
  }

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      {/* Header */}
      <header className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3">
        <span className="text-lg font-semibold">Chrome AI Agent</span>
        {providerLabel && (
          <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
            {providerLabel}
          </span>
        )}
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto p-4">
        {activeTab === "chat" && (
          <Chat onGoToSettings={() => setActiveTab("settings")} />
        )}
        {activeTab === "agent" && <Placeholder label="Agent" />}
        {activeTab === "tabs" && <Placeholder label="Tabs" />}
        {activeTab === "settings" && <Settings />}
      </main>

      {/* Bottom Nav */}
      <nav className="flex border-t border-neutral-800">
        {(["chat", "agent", "tabs", "settings"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-3 text-center text-xs font-medium capitalize transition-colors ${
              activeTab === tab
                ? "bg-neutral-800 text-white"
                : "text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {tab}
          </button>
        ))}
      </nav>
    </div>
  );
}

function Placeholder({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center pt-20 text-neutral-500">
      <p className="text-sm">{label} — coming soon</p>
    </div>
  );
}
