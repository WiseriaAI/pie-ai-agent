# Pie — Privacy Policy

Last updated: 2026-08-07
Extension version: 1.1.0
Contact: xiewkevo66@gmail.com

Pie is, by default, a BYOK (Bring Your Own Key) Chrome extension: it runs
entirely on your device and talks directly to the model provider whose key
you supply, with no Pie server in between. Pie also offers an **optional**
official subscription. If you choose it, some data passes through Pie's own
service — described in detail below. In **neither** mode does Pie collect
analytics, telemetry, or track you.

## What we never do

- We don't collect analytics, telemetry, or usage tracking of any kind.
- We don't read `chrome.history`, sync your data across devices, or sell or
  share your data with third parties for their own purposes.
- We don't track you across sites.
- We never send your conversations anywhere on our own initiative. The one
  path that transmits a conversation to Pie is **Report a problem**, and it
  only ever runs when you click Send on it — see below.

## Reporting a problem (you choose, every time)

Each agent reply has a **Report a problem** button. It is the only feature
that sends conversation content to Pie's servers, and it is entirely opt-in:
nothing is sent unless you open it and click Send, every single time. There
is no background reporting, no crash uploader, and no sampling.

When you do send a report, it includes:

- your description of the problem (optional),
- the conversation it was sent from — your messages, the agent's replies, the
  tools it called with their arguments, and the results those tools returned.
  **Tool results include content read from the pages the agent visited**, so
  if the agent read a page with personal or confidential information on it,
  that text can be part of the report,
- the same environment details as any other feedback (extension version,
  browser user-agent, active provider, UI language),
- your account email, if you are signed in to the optional subscription.

Screenshots are not included — images are reduced to a `[image 800x600]`
placeholder. The report is capped at roughly 150 KB; longer conversations are
trimmed from the beginning.

The drawer states this before you send. If a conversation touched something
you would rather not share, don't report from it — send feedback from
Settings instead, which never attaches conversation content.

Reports are stored by Pie and used only to diagnose the problem you reported.
Contact us to have one deleted.

## What stays on your device

The following are stored only in a local IndexedDB database (named `pie`) on
the device where you installed Pie:

- **API keys** — encrypted with AES-GCM (Web Crypto API). The encryption key
  is generated locally and stored alongside the ciphertext. Pie never
  transmits your BYOK API key to anyone other than the model provider you
  configured.
- **Sessions** — your conversation history, pinned tab references, scheduled
  tasks, and skills you (or the agent) authored.
- **Preferences** — UI settings (theme, language, CDP keyboard toggle, etc.).

## What gets sent off-device, and to whom

### Bring your own key (BYOK) — the default

When you run a chat or an agent task with your own key, Pie sends data
**only to the model provider you configured**:

- The chat messages you typed.
- Page or PDF snippets the agent reads on your behalf to complete a task.
- Tool-call descriptions and tool results from agent actions.
When you ask the agent to search the web, the query is sent **directly to
Tavily** using a Tavily API key you add in Settings → Search (subject to
<https://www.tavily.com/privacy>).

These transmissions go **directly from your browser to the provider's API
endpoint — Pie has no proxy in between.** Supported model providers are Anthropic
Claude, OpenAI, Google Gemini, OpenRouter, DeepSeek, MiniMax, GLM (Zhipu),
Bailian, Mimo (Xiaomi), Moonshot (Kimi), and StepFun. Your data is then
subject to that provider's own privacy policy — review the policy of whichever
one you use. Examples:

- **Anthropic** — <https://www.anthropic.com/legal/privacy>
- **OpenAI** — <https://openai.com/policies/privacy-policy>
- **Google** — <https://policies.google.com/privacy>
- **OpenRouter** — <https://openrouter.ai/privacy>
- **MiniMax** — <https://www.minimaxi.com/privacy-policy>
- **GLM / Zhipu (智谱)** — <https://open.bigmodel.cn/proagreement>
- **Bailian (阿里云百炼)** — <https://help.aliyun.com/document_detail/2587688.html>

You are responsible for reviewing the privacy policy of the provider you
choose to use with your own API key.

### Official Pie subscription — optional

If you opt in to the official Pie subscription instead of BYOK, the following
data passes through Pie's own service:

- **Sign-in** — you sign in with Google. Pie's account service
  (`account.pie.chat`) receives your **email address** to identify your
  account. Pie does not receive your Google password.
- **Billing** — payments are handled by **Stripe**. Pie does not see or store
  your card details; it keeps the subscription state Stripe reports back
  (active / canceled / renewal date) and a usage count needed to enforce your
  plan's quota.
- **Chat** — your chat and agent requests are **forwarded** through Pie's
  gateway (`api.pie.chat`) to the model provider. **Pie does not retain or log
  the content of your prompts or the model's responses — the gateway only
  passes them through.**

So the data Pie's service stores for a subscriber is your email, subscription
status, and a quota usage count. Chat content is never retained from ordinary
use — the only way a conversation reaches Pie's storage is if you explicitly
send it via **Report a problem** (see above). Stripe's handling of payment
data is governed by <https://stripe.com/privacy>; Google sign-in by
<https://policies.google.com/privacy>.

## Permissions, and why each one is needed

| Permission | Why |
|---|---|
| `<all_urls>` host permission | Read page content and inject DOM action scripts |
| `tabs`, `tabGroups` | Multi-tab agent tools (list / activate / close / group) |
| `scripting` | `chrome.scripting.executeScript` for DOM operations |
| `webNavigation` | Detect when a pinned tab navigates, so a task acts on the right page |
| `debugger` | CDP keyboard simulation and editor read/write for canvas editors (e.g. Lark Docs); off by default, opt-in toggle in Settings |
| `offscreen` | Parse text from PDFs in an offscreen document |
| `downloads` | Save files the agent produces to your Downloads folder |
| `identity` | Google sign-in for the **optional** official subscription only |
| `alarms` | Wake the extension to run scheduled tasks |
| `notifications` | Notify you when a scheduled task finishes |
| `sidePanel` | Render the Pie UI |
| `storage` | Persist sessions, encrypted API keys, and preferences |
| `activeTab` | Required by some Chrome APIs even when `<all_urls>` is granted |

Pie deliberately does **not** request `incognito` access, `chrome.history`,
or any cross-device sync permission.

## Removing your data

Uninstalling Pie from `chrome://extensions` removes all local state,
including encrypted API keys, sessions, and skills.

If you used the official subscription, your account (email + subscription
state) also lives on Pie's service. Cancel anytime from the in-app billing
portal; to delete the remaining account data, contact us at the address below.

## Data retention

- **On your device:** sessions, skills, and preferences persist locally until
  you delete them or uninstall Pie. Sessions older than 30 days become
  eligible for hard deletion. None of this leaves your device except as part
  of a model request you explicitly trigger.
- **Pie's gateway (subscription only):** does **not** retain the content of
  your prompts or responses — it forwards them and keeps nothing.
- **Pie's account service (subscription only):** keeps your email,
  subscription status, and quota usage count for as long as your account
  exists.

## Children's privacy

Pie is not directed to children under 13. For BYOK users, Pie holds no user
data at all. For subscribers, the only data Pie holds is the account email and
subscription state described above.

## Your rights (GDPR / CCPA)

- **BYOK users:** Pie collects, transmits, and stores no personal data on
  Pie-operated servers — all your data is on your own device, under your direct
  control, and is erased by uninstalling the extension. The single exception is
  a problem report you choose to send (see "Reporting a problem"); contact us
  to have one deleted.
- **Subscribers:** the personal data Pie holds is your email and
  subscription/usage state, plus any problem reports you chose to send.
  Contact us to access, correct, or delete it.
- For data sent to third-party model providers (using your own key) or to
  Stripe (for billing), contact those parties directly to exercise data-subject
  rights against them.

## Changes to this policy

If this policy changes, the `Last updated` date at the top of this document
will be updated and the extension version bumped. The current version is
always available at:

<https://github.com/WiseriaAI/pie-ai-agent/blob/main/PRIVACY.md>

## Contact

- Email: <xiewkevo66@gmail.com>
- Issues: <https://github.com/WiseriaAI/pie-ai-agent/issues>
