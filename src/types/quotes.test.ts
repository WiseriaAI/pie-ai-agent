import { describe, it, expectTypeOf } from "vitest";
import type {
  Quote,
  TextQuote,
  ElementQuote,
  QuoteTextCapturedMessage,
  QuoteElementCapturedMessage,
  QuoteAddedMessage,
  PickerStartMessage,
  PickerStopMessage,
  PickerEnterMessage,
  PickerExitMessage,
} from "./quotes";

describe("Quote types", () => {
  it("TextQuote shape", () => {
    expectTypeOf<TextQuote>().toEqualTypeOf<{
      id: string;
      kind: "text";
      text: string;
      sourceUrl: string;
      sourceTabId: number;
    }>();
  });

  it("ElementQuote allows null imageDataUrl", () => {
    const q: ElementQuote = {
      id: "x",
      kind: "element",
      role: "button",
      accessibleName: "Create",
      textContent: "New issue",
      outerHTMLTruncated: "<button>New issue</button>",
      imageDataUrl: null,
      sourceUrl: "https://example.com",
      sourceTabId: 1,
    };
    expectTypeOf(q).toMatchTypeOf<ElementQuote>();
  });

  it("Quote is union of TextQuote and ElementQuote", () => {
    expectTypeOf<Quote>().toEqualTypeOf<TextQuote | ElementQuote>();
  });

  it("wire message types exist", () => {
    expectTypeOf<QuoteTextCapturedMessage>().toMatchTypeOf<{
      type: "quote-text-captured";
      payload: { text: string; sourceUrl: string };
    }>();
    expectTypeOf<QuoteElementCapturedMessage>().toMatchTypeOf<{
      type: "quote-element-captured";
    }>();
    expectTypeOf<QuoteAddedMessage>().toMatchTypeOf<{
      type: "quote-added";
      quote: Quote;
    }>();
    expectTypeOf<PickerStartMessage>().toMatchTypeOf<{ type: "picker:start"; tabId: number }>();
    expectTypeOf<PickerStopMessage>().toMatchTypeOf<{ type: "picker:stop"; tabId: number }>();
    expectTypeOf<PickerEnterMessage>().toMatchTypeOf<{ type: "picker:enter" }>();
    expectTypeOf<PickerExitMessage>().toMatchTypeOf<{ type: "picker:exit" }>();
  });
});
