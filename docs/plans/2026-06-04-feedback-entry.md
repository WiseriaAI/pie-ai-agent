# Feedback Entry + `/report-issue` Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Feedback section to Settings (prefilled GitHub issue + `mailto:` email) and a built-in `/report-issue` skill that drafts a session-specific bug report into a prefilled GitHub issue for the user to review and submit.

**Architecture:** A pure helper module (`src/lib/feedback.ts`) builds the env-info text and the GitHub/`mailto:` URLs from an injected `FeedbackEnv` object — no chrome/DOM access, fully unit-testable. `Settings.tsx` gathers runtime env (manifest version, UA, active instance provider·model, locale) and renders two buttons via `window.open`. A new built-in `SkillPackage` (`report_issue`) instructs the agent to summarize the current conversation and `open_url` a prefilled issue. Spec: `docs/specs/2026-06-04-feedback-entry-design.md`.

**Tech Stack:** React 19 + TS, vitest, existing i18n dictionary system (`src/lib/i18n`), existing skill framework (`src/lib/skills/builtin.ts`).

**Branch:** Create `feat/feedback-entry` off `main` before starting (current branch is `feat/landing-page` — do not commit there).

---

## File Structure

- **Create** `src/lib/feedback.ts` — constants (`GITHUB_REPO`, `FEEDBACK_EMAIL`) + pure builders (`buildEnvBlock`, `buildGithubNewIssueUrl`, `buildFeedbackMailto`). One responsibility: turn env facts into feedback URLs.
- **Create** `src/lib/feedback.test.ts` — unit tests for the builders.
- **Modify** `src/lib/i18n/dictionaries/en.ts` + `zh-CN.ts` — add `settings.feedback.*` keys (parity-enforced).
- **Modify** `src/sidepanel/components/Settings.tsx` — add a `FeedbackSection` component + render it in the `configs` tab.
- **Modify** `src/lib/skills/builtin.ts` — add the `report_issue` built-in package + update the `EXPECTED_BUILT_IN_SKILL_IDS` audit set.

---

## Task 1: `feedback.ts` helper module

**Files:**
- Create: `src/lib/feedback.ts`
- Test: `src/lib/feedback.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/feedback.test.ts
import { describe, it, expect } from "vitest";
import {
  GITHUB_REPO,
  FEEDBACK_EMAIL,
  buildEnvBlock,
  buildGithubNewIssueUrl,
  buildFeedbackMailto,
  type FeedbackEnv,
} from "./feedback";

const ENV: FeedbackEnv = {
  version: "0.19.4",
  userAgent: "Mozilla/5.0 Test",
  providerModel: "openai · gpt-4o",
  locale: "en",
};

describe("feedback builders", () => {
  it("env block includes version, UA, provider·model, locale", () => {
    const block = buildEnvBlock(ENV);
    expect(block).toContain("0.19.4");
    expect(block).toContain("Mozilla/5.0 Test");
    expect(block).toContain("openai · gpt-4o");
    expect(block).toContain("locale: en");
  });

  it("github url targets the repo's new-issue page with user-report label", () => {
    const url = buildGithubNewIssueUrl(ENV);
    expect(url.startsWith(`https://github.com/${GITHUB_REPO}/issues/new?`)).toBe(true);
    expect(url).toContain("labels=user-report");
    // body is percent-encoded — decode and check it carries the env block
    const body = decodeURIComponent(new URL(url).searchParams.get("body")!);
    expect(body).toContain("0.19.4");
    expect(body).toContain("/report-issue");
  });

  it("mailto targets FEEDBACK_EMAIL with subject + encoded body", () => {
    const url = buildFeedbackMailto(ENV);
    expect(url.startsWith(`mailto:${FEEDBACK_EMAIL}?`)).toBe(true);
    expect(url).toContain("subject=");
    const body = decodeURIComponent(new URL(url).searchParams.get("body")!);
    expect(body).toContain("0.19.4");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/feedback.test.ts`
Expected: FAIL — cannot resolve `./feedback`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/feedback.ts
// Zero-backend feedback helpers. Pure functions over an injected env object so
// they unit-test without chrome/DOM. Two surfaces consume these: the Settings
// Feedback section (full env, from React) and — conceptually — the report_issue
// skill (agent composes its own URL inline; see src/lib/skills/builtin.ts).

export const GITHUB_REPO = "WiseriaAI/pie-ai-agent";

// TODO: replace with the dedicated feedback address once decided (spec open item).
export const FEEDBACK_EMAIL = "feedback@example.com";

export interface FeedbackEnv {
  /** Extension version, e.g. chrome.runtime.getManifest().version */
  version: string;
  /** navigator.userAgent */
  userAgent: string;
  /** "provider · model" of the active config, or a placeholder when none */
  providerModel: string;
  /** Resolved UI locale, e.g. "en" | "zh-CN" */
  locale: string;
}

export function buildEnvBlock(env: FeedbackEnv): string {
  return [
    "## Environment",
    `- version: ${env.version}`,
    `- browser: ${env.userAgent}`,
    `- active config: ${env.providerModel}`,
    `- locale: ${env.locale}`,
  ].join("\n");
}

function issueBody(env: FeedbackEnv): string {
  return [
    "## What happened?",
    "",
    "(describe the problem here)",
    "",
    buildEnvBlock(env),
    "",
    "> Reporting a problem about a specific task? Go back to that chat and type" +
      " `/report-issue` — the agent will draft the report for you.",
  ].join("\n");
}

export function buildGithubNewIssueUrl(env: FeedbackEnv): string {
  const body = encodeURIComponent(issueBody(env));
  return `https://github.com/${GITHUB_REPO}/issues/new?labels=user-report&body=${body}`;
}

export function buildFeedbackMailto(env: FeedbackEnv): string {
  const subject = encodeURIComponent("Pie Feedback");
  const body = encodeURIComponent(issueBody(env));
  return `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/feedback.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/feedback.ts src/lib/feedback.test.ts
git commit -m "feat(feedback): pure helpers for GitHub issue + mailto URLs"
```

---

## Task 2: i18n strings for the Feedback section

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts` (inside `settings: { ... }`)
- Modify: `src/lib/i18n/dictionaries/zh-CN.ts` (same path)
- Test: `src/lib/i18n/__tests__/dictionary-parity.test.ts` (already exists — run it, don't edit)

- [ ] **Step 1: Add the English keys**

In `src/lib/i18n/dictionaries/en.ts`, inside the `settings` object (e.g. right after the `language: { ... }` block), add:

```ts
    feedback: {
      sectionTitle: "FEEDBACK",
      githubButton: "Report on GitHub",
      githubHint: "Opens a prefilled issue. To report a problem about a specific task, open that chat and type /report-issue.",
      emailButton: "Email feedback",
    },
```

- [ ] **Step 2: Add the matching Simplified-Chinese keys**

In `src/lib/i18n/dictionaries/zh-CN.ts`, at the same `settings.feedback` path, add:

```ts
    feedback: {
      sectionTitle: "反馈",
      githubButton: "在 GitHub 上反馈",
      githubHint: "打开预填的 issue 页。要反馈某个具体任务的问题，请回到那个会话输入 /report-issue。",
      emailButton: "邮件反馈",
    },
```

- [ ] **Step 3: Run the parity test to verify both dictionaries match**

Run: `pnpm test src/lib/i18n/__tests__/dictionary-parity.test.ts`
Expected: PASS (no missing-key mismatch between en and zh-CN).

- [ ] **Step 4: Commit**

```bash
git add src/lib/i18n/dictionaries/en.ts src/lib/i18n/dictionaries/zh-CN.ts
git commit -m "feat(feedback): i18n strings for settings feedback section"
```

---

## Task 3: Feedback section in Settings

**Files:**
- Modify: `src/sidepanel/components/Settings.tsx`

No new test — this is thin wiring over the Task 1 helpers (follows the existing untested-section precedent, e.g. `CdpInputSection`). The helpers carry the logic and are tested.

- [ ] **Step 1: Add imports at the top of `Settings.tsx`**

Add to the existing import block:

```ts
import { buildGithubNewIssueUrl, buildFeedbackMailto, type FeedbackEnv } from "@/lib/feedback";
import { getLocale } from "@/lib/i18n";
```

(`getLocale` is exported from `@/lib/i18n`; if the editor flags it as missing, import from `@/lib/i18n/use-t` instead.)

- [ ] **Step 2: Render `<FeedbackSection>` in the configs tab**

In the `configs` branch JSX, immediately AFTER the existing Language `</section>` (the one closing around line 409, just before the closing `</div>` of the configs `flex flex-col gap-7` container), insert:

```tsx
            <FeedbackSection activeInstance={instances.find((i) => i.id === activeId)} />
```

- [ ] **Step 3: Add the `FeedbackSection` component**

Add this component near the other section components (e.g. after `CdpInputSection`):

```tsx
function FeedbackSection({ activeInstance }: { activeInstance: DecryptedInstance | undefined }) {
  const t = useT();
  const env: FeedbackEnv = {
    version: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    providerModel: activeInstance
      ? `${activeInstance.provider} · ${activeInstance.model}`
      : "(no active config)",
    locale: getLocale(),
  };
  return (
    <section className="flex flex-col gap-3.5">
      <div className="caps text-fg-3">{t("settings.feedback.sectionTitle")}</div>
      <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface p-3.5">
        <p className="text-[11px] leading-[16px] text-fg-3">{t("settings.feedback.githubHint")}</p>
        <div className="flex gap-2">
          {/* Native anchors: target=_blank opens a tab for GitHub; mailto is
              intercepted by the browser and won't navigate the side panel. */}
          <a
            href={buildGithubNewIssueUrl(env)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded border border-line bg-transparent px-3.5 py-2 text-[12px] text-accent hover:bg-field"
          >
            {t("settings.feedback.githubButton")}
          </a>
          <a
            href={buildFeedbackMailto(env)}
            className="flex items-center gap-2 rounded border border-line bg-transparent px-3.5 py-2 text-[12px] text-fg-2 hover:bg-field"
          >
            {t("settings.feedback.emailButton")}
          </a>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Typecheck + build**

Run: `pnpm typecheck`
Expected: 0 errors.
Run: `pnpm build`
Expected: build succeeds (manifest invariants pass).

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/Settings.tsx
git commit -m "feat(feedback): settings feedback section with github + email buttons"
```

---

## Task 4: built-in `/report-issue` skill

**Files:**
- Modify: `src/lib/skills/builtin.ts` (add package + extend `EXPECTED_BUILT_IN_SKILL_IDS`)
- Test: `src/lib/skills/builtin.test.ts` (already exists — run it, no edit needed; its assertions use `toContain`/`toBeGreaterThan` and won't break)

- [ ] **Step 1: Add the package to `BUILT_IN_SKILL_PACKAGES`**

Append a new `pkg(...)` entry inside the `BUILT_IN_SKILL_PACKAGES` array in `src/lib/skills/builtin.ts` (after the `create_skill_from_recording` entry):

```ts
  pkg(
    "report_issue",
    "Report Issue",
    "Draft a bug report from the current conversation and open a prefilled GitHub issue for the user to review and submit.",
    `Goal: turn the current session into a clear, public GitHub issue the user can submit.

The user typed /report-issue in the chat where something went wrong, so the
relevant context is already in this conversation.

Steps:
1. Review THIS conversation and write a concise summary: what the user was
   trying to do, what went wrong, steps to reproduce, expected vs. actual.
2. Privacy boundary — this issue is PUBLIC. Write a SUMMARY only. Do NOT paste
   raw <untrusted_*> page snapshots, and never include secrets (passwords,
   tokens, API keys) or personal data even if they appeared in the session.
3. Compose a Markdown body with these sections:
   ## What happened
   ## Steps to reproduce
   ## Expected
   ## Actual
   ## Environment
   Under Environment, include what you can tell from the session (provider,
   model, page URL/domain) and add the line "version: (please confirm)" —
   you cannot read the extension version, so the user fills it on review.
4. Build the URL by percent-encoding the title and body:
   https://github.com/WiseriaAI/pie-ai-agent/issues/new?labels=user-report&title=<encoded-title>&body=<encoded-body>
   Call open_url with that URL.
5. Call done with a one-line note: "Opened a prefilled GitHub issue — please
   review and submit." Do NOT try to submit it yourself; the user reviews and
   clicks Submit (they are already logged into GitHub).

Constraints:
- Never fill or submit the GitHub form via DOM actions — only open_url the
  prefilled page.
- If the conversation has no signs of a problem to report, ask the user what
  went wrong instead of inventing an issue.`,
    { tools: ["open_url"] },
  ),
```

- [ ] **Step 2: Extend the audit guard set**

In the same file, add `"report_issue"` to the `EXPECTED_BUILT_IN_SKILL_IDS` set:

```ts
const EXPECTED_BUILT_IN_SKILL_IDS = new Set([
  "auto_group_tabs",
  "close_duplicate_tabs",
  "close_inactive_tabs",
  "create_skill_from_recording",
  "extract_structured_data",
  "report_issue",
]);
```

- [ ] **Step 3: Run the skill tests**

Run: `pnpm test src/lib/skills/builtin.test.ts`
Expected: PASS — the import-time audit guard accepts the new id, all packages parse.

- [ ] **Step 4: Full test + typecheck + build**

Run: `pnpm test`
Expected: all pass (no regressions; audit guard + parity test green).
Run: `pnpm typecheck`
Expected: 0 errors.
Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/lib/skills/builtin.ts
git commit -m "feat(feedback): built-in report_issue skill"
```

---

## Manual verification (after all tasks)

1. `pnpm build`, load `dist/` unpacked in `chrome://extensions`.
2. Open side panel → Settings → Configs tab → scroll to FEEDBACK section.
3. Click "Report on GitHub" → a new tab opens GitHub's new-issue page prefilled
   with the env block + guidance line.
4. Click "Email feedback" → mail client opens with subject/body prefilled
   (or the OS prompts to pick a mail handler). The recipient is `FEEDBACK_EMAIL`.
5. In a chat that hit a problem, type `/report-issue` → the agent summarizes the
   session and opens a prefilled GitHub issue (title + body) without submitting.

## Open item

- Replace the `FEEDBACK_EMAIL` placeholder in `src/lib/feedback.ts` with the real
  dedicated address once decided (spec open item). One-line change.
```
