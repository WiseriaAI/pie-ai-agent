import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import AgentStepLine from "./AgentStepLine";

afterEach(() => cleanup());

const tinyJpegBase64 =
  "/9j/4AAQSkZJRgABAQAASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AAH//2Q==";

describe("AgentStepLine — image rendering (issue follow-up to #35/#39)", () => {
  beforeEach(() => {
    // Force the details element open so the unit test doesn't depend on the
    // user clicking the "详情" toggle. The image rendering happens inside
    // that block — this verifies the markup, not the toggle wiring.
  });

  it("renders the screenshot thumbnail in the details block when image prop is set", () => {
    render(
      <AgentStepLine
        tool="capture_visible_tab"
        args={{}}
        status="ok"
        observation="screenshot captured: 1372x1568 jpeg"
        image={{
          mediaType: "image/jpeg",
          data: tinyJpegBase64,
          width: 1372,
          height: 1568,
        }}
        defaultExpanded
      />,
    );
    const img = screen.getByRole("img", { name: /screenshot/i });
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBe(`data:image/jpeg;base64,${tinyJpegBase64}`);
  });

  it("does not render an <img> when image prop is absent", () => {
    render(
      <AgentStepLine
        tool="click"
        args={{}}
        status="ok"
        observation="clicked"
        defaultExpanded
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders image only after the details toggle is expanded", () => {
    render(
      <AgentStepLine
        tool="capture_visible_tab"
        args={{}}
        status="ok"
        observation="screenshot captured: 1372x1568 jpeg"
        image={{
          mediaType: "image/jpeg",
          data: tinyJpegBase64,
          width: 1372,
          height: 1568,
        }}
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
    const toggle = screen.getByRole("button", { name: /details/i });
    fireEvent.click(toggle);
    expect(screen.getByRole("img", { name: /screenshot/i })).toBeTruthy();
  });
});
