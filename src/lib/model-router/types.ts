export type StreamEvent =
  | { type: "text-delta"; text: string }
  | {
      type: "done";
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { type: "error"; error: string };
