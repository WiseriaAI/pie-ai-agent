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
    expect(url.startsWith(`https://github.com/${GITHUB_REPO}/issues/new?`)).toBe(
      true
    );
    expect(url).toContain("labels=user-report");
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
