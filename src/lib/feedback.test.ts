import { describe, it, expect } from "vitest";
import {
  GITHUB_REPO,
  FEEDBACK_EMAIL,
  buildEnvBlock,
  buildGithubNewIssueUrl,
  buildFeedbackMailto,
  buildTranscript,
  MAX_TRANSCRIPT_BYTES,
  type FeedbackEnv,
} from "./feedback";
import type { DisplayMessage } from "@/types/messages";

const ENV: FeedbackEnv = {
  version: "0.19.4",
  userAgent: "Mozilla/5.0 Test",
  providerModel: "openai · gpt-4o",
  locale: "en",
};

describe("feedback builders", () => {
  it("uses the dedicated feedback inbox", () => {
    expect(FEEDBACK_EMAIL).toBe("feedback@pie.chat");
  });

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
  });

  it("mailto targets FEEDBACK_EMAIL with subject + encoded body", () => {
    const url = buildFeedbackMailto(ENV);
    expect(url.startsWith(`mailto:${FEEDBACK_EMAIL}?`)).toBe(true);
    expect(url).toContain("subject=");
    const body = decodeURIComponent(new URL(url).searchParams.get("body")!);
    expect(body).toContain("0.19.4");
  });
});

describe("buildTranscript", () => {
  const CONVO: DisplayMessage[] = [
    { role: "user", content: "book me a flight" },
    {
      role: "agent-step",
      stepIndex: 0,
      tool: "read_page",
      args: { selector: "#main" },
      status: "ok",
      observation: "<untrusted_page_content>fares…</untrusted_page_content>",
    },
    { role: "assistant", content: "Done.", thinking: "checked the fares" },
    { role: "agent-summary", success: false, summary: "could not submit", stepCount: 3 },
  ];

  it("captures prompt, tool call, tool result, thinking and summary", () => {
    const out = buildTranscript(CONVO);
    expect(out).toContain("[user]\nbook me a flight");
    expect(out).toContain("read_page(");
    expect(out).toContain('"selector":"#main"');
    expect(out).toContain("→ ok");
    expect(out).toContain("fares…");
    expect(out).toContain("[assistant thinking]\nchecked the fares");
    expect(out).toContain("[summary fail steps=3]");
  });

  it("marks only the message the user reported", () => {
    const out = buildTranscript(CONVO, 2);
    const marker = ">>> user reported a problem on the message below <<<";
    expect(out.split(marker)).toHaveLength(2);
    // Marker sits immediately before that message, not at the top.
    expect(out.indexOf(marker)).toBeGreaterThan(out.indexOf("book me a flight"));
    expect(out.indexOf(marker)).toBeLessThan(out.indexOf("[assistant]"));
  });

  it("degrades screenshot bytes to a dimension marker", () => {
    const out = buildTranscript([
      {
        role: "agent-step",
        stepIndex: 1,
        tool: "capture_visible_tab",
        args: {},
        status: "ok",
        image: { mediaType: "image/jpeg", data: "A".repeat(400_000), width: 800, height: 600 },
      },
    ]);
    expect(out).toContain("[image 800x600]");
    expect(out).not.toContain("AAAA");
  });

  it("stays within budget and keeps the tail when a long history overflows", () => {
    // Each row survives per-field clipping (~4k chars); it takes many of them
    // to overflow the transcript budget, which is when the tail-cap kicks in.
    const long: DisplayMessage[] = [
      ...Array.from({ length: 100 }, (): DisplayMessage => ({
        role: "user",
        content: "X".repeat(10_000),
      })),
      { role: "assistant", content: "THE-FAILURE-IS-HERE" },
    ];
    const out = buildTranscript(long);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
    expect(out).toContain("THE-FAILURE-IS-HERE");
    expect(out).toContain("earlier history dropped");
  });

  it("clips a single oversized observation from the middle, keeping both ends", () => {
    const out = buildTranscript([
      {
        role: "agent-step",
        stepIndex: 0,
        tool: "read_page",
        args: {},
        status: "error",
        observation: `HEAD${"z".repeat(50_000)}TAIL-ERROR`,
      },
    ]);
    expect(out).toContain("HEAD");
    expect(out).toContain("TAIL-ERROR");
    expect(out).toContain("chars truncated");
  });
});
