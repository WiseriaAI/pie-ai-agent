// One-shot intent handed from the SW to the side panel after the panel is
// opened by a website "Subscribe" click. Stored in chrome.storage.session
// (in-memory, trusted contexts only) so it survives the gap while the panel
// mounts; the panel reads it once and clears it. Not used by content scripts.
export const DEEPLINK_KEY = "pie:deeplink";
export const DEEPLINK_MANAGED_SUBSCRIBE = "managed-subscribe";
