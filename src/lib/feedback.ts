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
