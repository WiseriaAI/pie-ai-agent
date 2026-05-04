import { describe, it, expect } from "vitest";
import type { ImageAttachment, ImagePlaceholder, Attachment } from "./types";

describe("Attachment discriminated union", () => {
  it("ImageAttachment carries data and id", () => {
    const a: ImageAttachment = {
      kind: "image",
      id: "img_test_1",
      mediaType: "image/jpeg",
      data: "/9j/4AAQ...",
      width: 1568,
      height: 880,
      byteLength: 245678,
    };
    expect(a.kind).toBe("image");
    expect(a.data.length).toBeGreaterThan(0);
  });

  it("ImagePlaceholder carries id but no data", () => {
    const p: ImagePlaceholder = {
      kind: "image_placeholder",
      id: "img_test_1",
      mediaType: "image/jpeg",
      width: 1568,
      height: 880,
    };
    expect(p.kind).toBe("image_placeholder");
    expect("data" in p).toBe(false);
  });

  it("Attachment is discriminated by kind", () => {
    const items: Attachment[] = [];
    items.push({
      kind: "image",
      id: "i1",
      mediaType: "image/png",
      data: "abc",
      width: 100,
      height: 100,
      byteLength: 50,
    });
    items.push({
      kind: "image_placeholder",
      id: "i2",
      mediaType: "image/png",
      width: 100,
      height: 100,
    });
    for (const x of items) {
      if (x.kind === "image") expect(x.data).toBeDefined();
      else expect(x.kind).toBe("image_placeholder");
    }
  });
});
