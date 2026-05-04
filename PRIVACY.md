# Pie — Privacy Policy

Last updated: 2026-05-04
Extension version: 0.5.0
Contact: xiewkevo66@gmail.com

Pie is a BYOK (Bring Your Own Key) Chrome Extension. The Pie project does
not operate any backend service, does not collect telemetry, and has no
access to your data.

## What we don't do

- We don't have a server. Pie has no backend that could receive your data.
- We don't collect analytics, page contents, prompts, or browsing history.
- We don't read `chrome.history`, sync data across devices, or share
  anything with third parties.
- We don't track you across sites.

## What stays on your device

The following are stored only in `chrome.storage.local`, on the device
where you installed Pie:

- **API keys** — encrypted with AES-GCM (Web Crypto API). The encryption
  key is generated locally and stored alongside the ciphertext in
  `chrome.storage.local`. Pie never transmits your API key to anyone other
  than the LLM provider you configured.
- **Sessions** — your conversation history, pinned tab references, and
  user-authored skills.
- **Preferences** — UI settings (theme, CDP keyboard toggle, etc.).

## What gets sent off-device, and to whom

When you run a chat or an agent task, Pie sends data **only to the LLM
provider you configured** (Anthropic, OpenAI, OpenRouter, MiniMax, ZhiPu,
or Bailian). Specifically:

- The chat messages you typed.
- Page snippets the agent reads on your behalf to complete a task.
- Tool-call descriptions and tool results from agent actions.

These transmissions go directly from your browser to the provider's API
endpoint — Pie has no proxy in between. The data is then subject to that
provider's privacy policy:

- **Anthropic** — <https://www.anthropic.com/legal/privacy>
- **OpenAI** — <https://openai.com/policies/privacy-policy>
- **OpenRouter** — <https://openrouter.ai/privacy>
- **MiniMax** — <https://www.minimaxi.com/privacy-policy>
- **ZhiPu (智谱)** — <https://open.bigmodel.cn/proagreement>
- **Bailian (阿里云百炼)** — <https://help.aliyun.com/document_detail/2587688.html>

You are responsible for reviewing the privacy policy of the provider you
choose to use with your own API key.

## Permissions, and why each one is needed

| Permission | Why |
|---|---|
| `<all_urls>` host permission | Read page content and inject DOM action scripts |
| `tabs`, `tabGroups` | Multi-tab agent tools (list / activate / close / group) |
| `scripting` | `chrome.scripting.executeScript` for DOM operations |
| `debugger` | CDP keyboard simulation for canvas editors (e.g. Feishu Docs); off by default, opt-in toggle in Settings |
| `sidePanel` | Render the Pie UI |
| `storage` | Persist sessions, encrypted API keys, and preferences |
| `activeTab` | Required by some Chrome APIs even when `<all_urls>` is granted |

Pie deliberately does **not** request `incognito` access, `chrome.history`,
or any cross-device sync permission.

## Removing your data

Uninstalling Pie from `chrome://extensions` removes all
`chrome.storage.local` state, including encrypted API keys. There is
nothing to delete server-side because there is no server.

## Data retention

Sessions, skills, and preferences persist locally until you delete them
or uninstall Pie. Pie auto-archives least-recently-used sessions when
local storage approaches its quota, and sessions older than 30 days
become eligible for hard deletion. None of this data ever leaves your
device except as part of an LLM request you explicitly trigger.

## Children's privacy

Pie is not directed to children under 13. Because Pie does not collect
any user data on developer-operated servers, no data about any user —
adult or child — reaches the developer.

## Your rights (GDPR / CCPA)

Pie does not collect, transmit, or store any personal data on
developer-operated servers, so the developer holds no data to access,
port, correct, or delete on your behalf. All your data is on your own
device, under your direct control, and is erased by uninstalling the
extension. For data sent to third-party LLM providers using your own
API key, please contact those providers directly to exercise
data-subject rights against them.

## Changes to this policy

If this policy changes, the `Last updated` date at the top of this
document will be updated and the extension version bumped. The current
version is always available at:

<https://github.com/WiseriaAI/Pie/blob/main/PRIVACY.md>

## Contact

- Email: <xiewkevo66@gmail.com>
- Issues: <https://github.com/WiseriaAI/Pie/issues>
