import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import ModelPicker, { modelsFor } from "./ModelPicker";
import type { DecryptedInstance } from "@/lib/instances";
import { getEntitlement } from "@/lib/managed-account";

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
    // Accordion keeps all rows mounted (for the open/close animation), so each
    // provider has its own search box — target OpenAI's by its aria-label.
    fireEvent.change(screen.getByRole("textbox", { name: /OpenAI/i }), { target: { value: "mini" } });
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

  it("renders the popover via a portal under document.body, escaping the trigger wrapper", () => {
    const { container } = renderPicker();
    openPicker();
    const popover = screen.getByRole("dialog");
    // Portaled to body so no ancestor overflow/stacking can clip it.
    expect(document.body.contains(popover)).toBe(true);
    // It must NOT be nested inside the trigger wrapper (the rendered container).
    expect(container.contains(popover)).toBe(false);
  });
});

function inst(over: Partial<DecryptedInstance>): DecryptedInstance {
  return { id: "i1", provider: "moonshot", nickname: "K", apiKey: "k", createdAt: 0, ...over };
}

describe("modelsFor with endpoint variants", () => {
  it("payg variant with models replaces the default (Plan) list; custom appended, fetched skipped", () => {
    const ids = modelsFor(
      inst({
        endpointVariant: "payg", // moonshot payg pool = MOONSHOT_MODELS
        customModels: ["my-model"],
        fetchedModels: [{ id: "should-not-appear", vision: false, tools: true, maxContextTokens: 1 }],
      }),
    ).map((r) => r.id);
    expect(ids).toContain("kimi-k2.6"); // from the payg pool
    expect(ids).not.toContain("kimi-for-coding"); // default (Plan) model is replaced
    expect(ids).toContain("my-model"); // custom pool still appended
    expect(ids).not.toContain("should-not-appear"); // fetched skipped when variant has models
  });

  it("payg variant without models keeps the default list (zhipu — both share the full GLM list)", () => {
    const rows = modelsFor(inst({ provider: "zhipu", endpointVariant: "payg" }));
    expect(rows.map((r) => r.id)).toContain("glm-5.1");
  });

  it("no variant → default (Plan) registry list", () => {
    const rows = modelsFor(inst({}));
    expect(rows[0]!.id).toBe("kimi-for-coding"); // moonshot default = Kimi Code Plan
  });

  it("dangling variant id falls back to the default (Plan) list", () => {
    const rows = modelsFor(inst({ endpointVariant: "gone" }));
    expect(rows[0]!.id).toBe("kimi-for-coding");
  });
});

describe("modelsFor managed", () => {
  it("从缓存 entitlement 出多模型行（携 managed 元数据）", async () => {
    const ent = { plan: "active", email: "e", subscription: null, quota: null, models: [
      { id: "default", name: "标准", vision: false, maxContextTokens: 128000, costLevel: 1 },
      { id: "pro", name: "进阶", description: "更强", vision: true, maxContextTokens: 200000, costLevel: 3 },
    ] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ent })) as unknown as typeof fetch;
    await getEntitlement("sk-managed", { fetchFn, locale: "en" }); // 播种进程内缓存
    const rows = modelsFor(inst({ provider: "managed", apiKey: "sk-managed" }));
    expect(rows.map((r) => r.id)).toEqual(["default", "pro"]);
    expect(rows[1]!.managed).toMatchObject({ id: "pro", name: "进阶", vision: true, costLevel: 3 });
  });

  it("无缓存时回退 registry 单条 default", () => {
    const rows = modelsFor(inst({ provider: "managed", apiKey: "sk-cold" }));
    expect(rows.map((r) => r.id)).toEqual(["default"]);
    expect(rows[0]!.managed).toBeUndefined();
  });
});

describe("ModelPicker managed rendering", () => {
  async function seedManaged() {
    const ent = { plan: "active", email: "e", subscription: null, quota: null, models: [
      { id: "default", name: "标准", description: "快速经济", vision: false, maxContextTokens: 128000, costLevel: 1 },
      { id: "pro", name: "进阶", description: "推理更强", vision: true, maxContextTokens: 200000, costLevel: 3 },
    ] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ent })) as unknown as typeof fetch;
    await getEntitlement("sk-m", { fetchFn, locale: "en" });
  }
  const managedInsts: DecryptedInstance[] = [{ id: "m", provider: "managed", nickname: "Pie", apiKey: "sk-m", createdAt: 1 }];

  it("展开 managed 显示模型名+描述，不显示搜索框", async () => {
    await seedManaged();
    render(<ModelPicker instances={managedInsts} currentInstanceId="m" currentModel="default" locked={false} onSelect={() => {}} onManage={() => {}} />);
    fireEvent.click(screen.getAllByRole("button")[0]!);
    fireEvent.click(screen.getByText("Pie 官方订阅"));
    expect(screen.getAllByText("标准").length).toBeGreaterThan(0);
    expect(screen.getByText("推理更强")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /Pie/i })).toBeNull();
  });

  it("点选 managed 模型回传 alias id", async () => {
    await seedManaged();
    const onSelect = vi.fn();
    render(<ModelPicker instances={managedInsts} currentInstanceId="m" currentModel="default" locked={false} onSelect={onSelect} onManage={() => {}} />);
    fireEvent.click(screen.getAllByRole("button")[0]!);
    fireEvent.click(screen.getByText("Pie 官方订阅"));
    fireEvent.click(screen.getByText("进阶"));
    expect(onSelect).toHaveBeenCalledWith("m", "pro");
  });
});
