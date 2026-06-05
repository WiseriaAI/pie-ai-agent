import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import ModelPicker from "./ModelPicker";
import type { DecryptedInstance } from "@/lib/instances";

const insts: DecryptedInstance[] = [
  { id: "a", provider: "anthropic", nickname: "Anthropic", apiKey: "k", createdAt: 1 },
  { id: "o", provider: "openai", nickname: "OpenAI", apiKey: "k", createdAt: 2 },
];

afterEach(() => cleanup());

function renderPicker(overrides: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
  return render(
    <ModelPicker
      instances={insts}
      currentInstanceId="a"
      currentModel="claude-opus-4-7"
      locked={false}
      onSelect={() => {}}
      onManage={() => {}}
      {...overrides}
    />,
  );
}

function openPicker() {
  fireEvent.click(screen.getAllByRole("button")[0]!); // trigger chip
}

describe("ModelPicker", () => {
  it("lists providers at the top level when opened", () => {
    renderPicker();
    openPicker();
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("OpenAI")).toBeTruthy();
  });

  it("expands a provider to show its registry models (accordion)", () => {
    renderPicker();
    openPicker();
    fireEvent.click(screen.getByText("OpenAI"));
    expect(screen.getByText("gpt-4o")).toBeTruthy();
  });

  it("filters models within the expanded provider via search", () => {
    renderPicker();
    openPicker();
    fireEvent.click(screen.getByText("OpenAI"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "mini" } });
    expect(screen.getByText("gpt-4o-mini")).toBeTruthy();
    expect(screen.queryByText("gpt-4o")).toBeNull(); // non-match hidden
  });

  it("calls onSelect with (instanceId, model) on model click", () => {
    const onSelect = vi.fn();
    renderPicker({ onSelect });
    openPicker();
    fireEvent.click(screen.getByText("OpenAI"));
    fireEvent.click(screen.getByText("gpt-4o"));
    expect(onSelect).toHaveBeenCalledWith("o", "gpt-4o");
  });

  it("does not open when locked", () => {
    renderPicker({ locked: true });
    fireEvent.click(screen.getAllByRole("button")[0]!);
    expect(screen.queryByText("OpenAI")).toBeNull();
  });
});
