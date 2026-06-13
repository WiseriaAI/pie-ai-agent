import { getConfig, setConfig } from "@/lib/idb/config-store";

export const PROGRESSIVE_TOOL_DISCLOSURE_KEY = "progressive_tool_disclosure";

/**
 * Experimental progressive tool disclosure. DEFAULTS TO ON (true) when the
 * key is unset — only an explicit stored `false` disables it (full disclosure).
 */
export async function getProgressiveDisclosureFlag(): Promise<boolean> {
  const v = await getConfig<boolean>(PROGRESSIVE_TOOL_DISCLOSURE_KEY);
  return v === false ? false : true;
}

export async function setProgressiveDisclosureFlag(value: boolean): Promise<void> {
  await setConfig(PROGRESSIVE_TOOL_DISCLOSURE_KEY, !!value);
}
