import { useState, useEffect } from "react";
import type { Provider } from "@/lib/model-router";
import { chat, PROVIDER_REGISTRY } from "@/lib/model-router";
import {
  saveProviderConfig,
  getProviderConfig,
  deleteProviderConfig,
  getActiveProvider,
  setActiveProvider,
} from "@/lib/storage";
import {
  isKeyboardSimulationEnabled,
  setKeyboardSimulationEnabled,
} from "@/lib/keyboard-simulation";
import SkillsList from "./SkillsList";

interface ProviderFormState {
  apiKey: string;
  model: string;
  baseUrl: string;
  configured: boolean;
  maskedKey: string;
  showKey: boolean;
}

function maskKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function makeInitialForms(): Record<string, ProviderFormState> {
  const forms: Record<string, ProviderFormState> = {};
  for (const p of PROVIDER_REGISTRY) {
    forms[p.id] = {
      apiKey: "",
      model: p.defaultModel,
      baseUrl: "",
      configured: false,
      maskedKey: "",
      showKey: false,
    };
  }
  return forms;
}

interface SettingsProps {
  onRunSkill?: (skillId: string, skillName: string) => void;
}

export default function Settings({ onRunSkill }: SettingsProps) {
  const [forms, setForms] = useState(makeInitialForms);
  const [activeProvider, setActiveProviderState] = useState<Provider | null>(
    null,
  );
  const [testing, setTesting] = useState<Provider | null>(null);
  const [testResult, setTestResult] = useState<
    Record<string, { ok: boolean; message: string }>
  >({});
  const [saving, setSaving] = useState<Provider | null>(null);
  const [needsReconfig, setNeedsReconfig] = useState(false);
  const [keyboardSimEnabled, setKeyboardSimEnabled] = useState(false);

  useEffect(() => {
    loadConfigs();
    isKeyboardSimulationEnabled().then(setKeyboardSimEnabled);
  }, []);

  async function handleKeyboardSimToggle(next: boolean) {
    setKeyboardSimEnabled(next);
    await setKeyboardSimulationEnabled(next);
  }

  async function loadConfigs() {
    const active = await getActiveProvider();
    setActiveProviderState(active);

    for (const p of PROVIDER_REGISTRY) {
      try {
        const config = await getProviderConfig(p.id);
        if (config) {
          setForms((prev) => ({
            ...prev,
            [p.id]: {
              ...prev[p.id],
              model: config.model,
              baseUrl: config.baseUrl || "",
              configured: true,
              maskedKey: maskKey(config.apiKey),
            },
          }));
        }
      } catch {
        setNeedsReconfig(true);
      }
    }
  }

  function updateForm(provider: Provider, updates: Partial<ProviderFormState>) {
    setForms((prev) => ({
      ...prev,
      [provider]: { ...prev[provider], ...updates },
    }));
  }

  async function handleTest(provider: Provider) {
    const form = forms[provider];
    const apiKey = form.apiKey || (form.configured ? undefined : "");
    if (!apiKey && !form.configured) return;

    setTesting(provider);
    setTestResult((prev) => ({ ...prev, [provider]: undefined! }));

    try {
      let config;
      if (apiKey) {
        config = {
          provider,
          model: form.model,
          apiKey,
          baseUrl: form.baseUrl || undefined,
          maxTokens: 1,
        };
      } else {
        config = await getProviderConfig(provider);
        if (!config) throw new Error("No configuration found");
        config = { ...config, maxTokens: 1 };
      }

      await chat(config, [{ role: "user", content: "Hi" }]);
      setTestResult((prev) => ({
        ...prev,
        [provider]: { ok: true, message: "Connection successful" },
      }));
    } catch (e) {
      setTestResult((prev) => ({
        ...prev,
        [provider]: {
          ok: false,
          message: e instanceof Error ? e.message : "Connection failed",
        },
      }));
    } finally {
      setTesting(null);
    }
  }

  async function handleSave(provider: Provider) {
    const form = forms[provider];
    if (!form.apiKey.trim()) return;

    setSaving(provider);
    try {
      await saveProviderConfig(
        provider,
        form.apiKey,
        form.model,
        form.baseUrl || undefined,
      );

      if (!activeProvider) {
        await setActiveProvider(provider);
        setActiveProviderState(provider);
      }

      updateForm(provider, {
        configured: true,
        maskedKey: maskKey(form.apiKey),
        apiKey: "",
        showKey: false,
      });
      setTestResult((prev) => ({ ...prev, [provider]: undefined! }));
    } catch (e) {
      setTestResult((prev) => ({
        ...prev,
        [provider]: {
          ok: false,
          message: e instanceof Error ? e.message : "Failed to save",
        },
      }));
    } finally {
      setSaving(null);
    }
  }

  async function handleDelete(provider: Provider) {
    await deleteProviderConfig(provider);
    const meta = PROVIDER_REGISTRY.find((p) => p.id === provider)!;
    updateForm(provider, {
      apiKey: "",
      model: meta.defaultModel,
      baseUrl: "",
      configured: false,
      maskedKey: "",
      showKey: false,
    });
    setTestResult((prev) => ({ ...prev, [provider]: undefined! }));

    if (activeProvider === provider) {
      const other = PROVIDER_REGISTRY.find(
        (p) => p.id !== provider && forms[p.id]?.configured,
      );
      if (other) {
        await setActiveProvider(other.id);
        setActiveProviderState(other.id);
      } else {
        await chrome.storage.local.remove("active_provider");
        setActiveProviderState(null);
      }
    }
  }

  async function handleSetActive(provider: Provider) {
    await setActiveProvider(provider);
    setActiveProviderState(provider);
  }

  return (
    <div className="flex flex-col gap-4">
      {needsReconfig && (
        <div className="rounded-lg border border-amber-700 bg-amber-950/50 px-4 py-3 text-sm text-amber-300">
          Browser was restarted. Please re-enter your API keys.
        </div>
      )}

      <h2 className="text-sm font-semibold text-neutral-300">Providers</h2>

      {PROVIDER_REGISTRY.map((provider) => {
        const form = forms[provider.id];
        if (!form) return null;

        const result = testResult[provider.id];
        const isActive = activeProvider === provider.id;
        const isTesting = testing === provider.id;
        const isSaving = saving === provider.id;

        return (
          <div
            key={provider.id}
            className="rounded-lg border border-neutral-800 bg-neutral-900 p-4"
          >
            {/* Header */}
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${form.configured ? "bg-green-500" : "bg-neutral-600"}`}
                />
                <span className="font-medium">{provider.name}</span>
              </div>
              {form.configured && (
                <button
                  onClick={() => handleSetActive(provider.id)}
                  className={`rounded px-2 py-1 text-xs ${
                    isActive
                      ? "bg-blue-600 text-white"
                      : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                  }`}
                >
                  {isActive ? "Active" : "Set Active"}
                </button>
              )}
            </div>

            {/* API Key */}
            <div className="mb-3">
              <label className="mb-1 block text-xs text-neutral-400">
                API Key
                {form.configured && (
                  <span className="ml-2 text-neutral-500">
                    Current: {form.maskedKey}
                  </span>
                )}
              </label>
              <div className="flex gap-2">
                <input
                  type={form.showKey ? "text" : "password"}
                  value={form.apiKey}
                  onChange={(e) =>
                    updateForm(provider.id, { apiKey: e.target.value })
                  }
                  placeholder={
                    form.configured
                      ? "Enter new key to update"
                      : provider.placeholder
                  }
                  className="flex-1 rounded border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:border-blue-600 focus:outline-none"
                />
                <button
                  onClick={() =>
                    updateForm(provider.id, { showKey: !form.showKey })
                  }
                  className="rounded border border-neutral-700 bg-neutral-800 px-3 text-xs text-neutral-400 hover:text-neutral-200"
                >
                  {form.showKey ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            {/* Model */}
            <div className="mb-3">
              <label className="mb-1 block text-xs text-neutral-400">
                Model
              </label>
              <input
                type="text"
                value={form.model}
                onChange={(e) =>
                  updateForm(provider.id, { model: e.target.value })
                }
                className="w-full rounded border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 focus:border-blue-600 focus:outline-none"
              />
            </div>

            {/* Base URL */}
            <div className="mb-3">
              <label className="mb-1 block text-xs text-neutral-400">
                Base URL{" "}
                <span className="text-neutral-600">
                  (default: {provider.defaultBaseUrl})
                </span>
              </label>
              <input
                type="text"
                value={form.baseUrl}
                onChange={(e) =>
                  updateForm(provider.id, { baseUrl: e.target.value })
                }
                placeholder={provider.defaultBaseUrl}
                className="w-full rounded border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:border-blue-600 focus:outline-none"
              />
            </div>

            {/* Test Result */}
            {result && (
              <div
                className={`mb-3 rounded px-3 py-2 text-xs ${
                  result.ok
                    ? "bg-green-950/50 text-green-400"
                    : "bg-red-950/50 text-red-400"
                }`}
              >
                {result.message}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2">
              <button
                onClick={() => handleTest(provider.id)}
                disabled={
                  isTesting || (!form.apiKey.trim() && !form.configured)
                }
                className="rounded bg-neutral-800 px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isTesting ? "Testing..." : "Test Connection"}
              </button>
              <button
                onClick={() => handleSave(provider.id)}
                disabled={isSaving || !form.apiKey.trim()}
                className="rounded bg-blue-600 px-3 py-2 text-xs text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? "Saving..." : "Save"}
              </button>
              {form.configured && (
                <button
                  onClick={() => handleDelete(provider.id)}
                  className="rounded bg-neutral-800 px-3 py-2 text-xs text-red-400 hover:bg-neutral-700"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        );
      })}

      {/* Keyboard simulation section (Phase 2.5) */}
      <h2 className="mt-2 text-sm font-semibold text-neutral-300">
        Keyboard simulation (experimental)
      </h2>
      <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <div className="flex items-center justify-between">
          <div className="pr-4">
            <p className="text-sm text-neutral-200">
              Enable CDP keyboard input
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              Lets the Agent type into canvas-rendered editors (Feishu Docs,
              Google Docs, Notion) via Chrome DevTools Protocol. Required only
              for those editors — regular sites work without this.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={keyboardSimEnabled}
            onClick={() => handleKeyboardSimToggle(!keyboardSimEnabled)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
              keyboardSimEnabled ? "bg-blue-600" : "bg-neutral-700"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                keyboardSimEnabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>
        {keyboardSimEnabled && (
          <div className="mt-3 rounded border border-amber-700 bg-amber-950/50 px-3 py-2 text-xs text-amber-300">
            <p className="font-medium">Heads up — debugger access is active</p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-amber-300/90">
              <li>
                Chrome shows a yellow debug bar on the target tab while the
                Agent uses keyboard tools. Each call requires your approval.
              </li>
              <li>
                If your Chrome window is minimized or the tab is on another
                display, you may not see the bar — the extension is still
                controlling that tab during the task.
              </li>
              <li>
                Click the yellow bar's "Cancel" anytime to revoke debugger
                access immediately.
              </li>
            </ul>
          </div>
        )}
      </div>

      {/* Skills section */}
      <h2 className="mt-2 text-sm font-semibold text-neutral-300">Skills</h2>
      <SkillsList onRunSkill={onRunSkill ?? (() => {})} />
    </div>
  );
}
