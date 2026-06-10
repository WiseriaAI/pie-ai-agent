import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecryptedInstance } from "@/lib/instances";
import InstancesList from "./InstancesList";

afterEach(() => {
  cleanup();
});

describe("InstancesList", () => {
  it("shows provider display name instead of stored nickname", () => {
    const inst: DecryptedInstance = {
      id: "inst-1",
      provider: "anthropic",
      nickname: "Old custom nickname",
      apiKey: "sk-ant-secret",
      createdAt: 1,
    };

    render(
      <InstancesList
        instances={[inst]}
        expandedId={null}
        onToggleExpand={() => {}}
        renderForm={() => null}
      />,
    );

    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.queryByText("Old custom nickname")).toBeNull();
  });

  it("does not show the provider ref after the provider title", () => {
    const inst: DecryptedInstance = {
      id: "inst-1",
      provider: "anthropic",
      nickname: "Old custom nickname",
      apiKey: "sk-ant-secret",
      createdAt: 1,
    };

    render(
      <InstancesList
        instances={[inst]}
        expandedId={null}
        onToggleExpand={() => {}}
        renderForm={() => null}
      />,
    );

    expect(screen.queryByText(/· anthropic/)).toBeNull();
  });

  it("shows custom provider name instead of stored nickname", () => {
    const inst: DecryptedInstance = {
      id: "inst-1",
      provider: "custom:cp-1",
      nickname: "Old custom nickname",
      apiKey: "sk-custom-secret",
      createdAt: 1,
    };

    render(
      <InstancesList
        instances={[inst]}
        customProviderNames={{ "custom:cp-1": "Local Gateway" }}
        expandedId={null}
        onToggleExpand={() => {}}
        renderForm={() => null}
      />,
    );

    expect(screen.getByText("Local Gateway")).toBeTruthy();
    expect(screen.queryByText("Old custom nickname")).toBeNull();
  });

  it("keeps using the instance id to toggle configured rows", () => {
    const onToggleExpand = vi.fn();
    const inst: DecryptedInstance = {
      id: "inst-1",
      provider: "openai",
      nickname: "Work key",
      apiKey: "sk-openai-secret",
      createdAt: 1,
    };

    render(
      <InstancesList
        instances={[inst]}
        expandedId={null}
        onToggleExpand={onToggleExpand}
        renderForm={() => null}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    expect(onToggleExpand).toHaveBeenCalledWith("inst-1");
  });
});
