import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import ScheduleForm from "./ScheduleForm";
import type { DecryptedInstance } from "@/lib/instances";
import { MIN_INTERVAL_MINUTES } from "@/lib/schedules/types";

afterEach(() => cleanup());

const instances: DecryptedInstance[] = [
  { id: "inst_1", provider: "anthropic", nickname: "Claude", apiKey: "k", createdAt: 1, customModels: ["model-a1", "model-a2"] },
  { id: "inst_2", provider: "openai", nickname: "GPT", apiKey: "k", createdAt: 2, customModels: ["model-b1"] },
];

function renderForm(props: Partial<React.ComponentProps<typeof ScheduleForm>> = {}) {
  return render(
    <ScheduleForm
      instances={instances}
      activeInstanceId="inst_1"
      activeModel="model-a1"
      onSubmit={props.onSubmit ?? vi.fn().mockResolvedValue({ ok: true })}
      onCancel={props.onCancel ?? vi.fn()}
      {...props}
    />,
  );
}

describe("ScheduleForm", () => {
  it("blocks submit when title or prompt empty", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    renderForm({ onSubmit });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/title is required/i)).toBeTruthy();
  });

  it("rejects interval below MIN_INTERVAL_MINUTES with an inline error", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    renderForm({ onSubmit });
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Digest" } });
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: "summarize" } });
    fireEvent.change(screen.getByLabelText(/interval/i), {
      target: { value: String(MIN_INTERVAL_MINUTES - 1) },
    });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByText(new RegExp(`at least ${MIN_INTERVAL_MINUTES}`, "i")),
    ).toBeTruthy();
  });

  it("rejects a restricted startUrl", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    renderForm({ onSubmit });
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Digest" } });
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: "summarize" } });
    fireEvent.change(screen.getByLabelText(/start url/i), { target: { value: "chrome://settings" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/restricted/i)).toBeTruthy();
  });

  it("submits a valid create payload (title/prompt/interval/instance)", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    renderForm({ onSubmit });
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Digest" } });
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: "summarize" } });
    fireEvent.change(screen.getByLabelText(/interval/i), { target: { value: "60" } });
    fireEvent.change(screen.getByLabelText(/runs/i), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const arg = onSubmit.mock.calls[0][0];
    expect(arg.title).toBe("Digest");
    expect(arg.prompt).toBe("summarize");
    expect(arg.instanceId).toBe("inst_1");
    expect(arg.spec.intervalMinutes).toBe(60);
    expect(arg.spec.maxRuns).toBe(3);
  });

  it("prefills fields in edit mode and labels the button Save", () => {
    renderForm({
      editing: {
        id: "sched_1",
        title: "Existing",
        prompt: "old prompt",
        spec: { intervalMinutes: 30, maxRuns: 2 },
        instanceId: "inst_2",
        enabled: true,
        status: "active",
        createdAt: 1,
        runCount: 0,
        consecutiveFailures: 0,
        runIds: [],
      },
    });
    expect((screen.getByLabelText(/title/i) as HTMLInputElement).value).toBe("Existing");
    expect((screen.getByLabelText(/prompt/i) as HTMLTextAreaElement).value).toBe("old prompt");
    expect(screen.getByRole("button", { name: /save/i })).toBeTruthy();
  });

  it("surfaces a backend error returned from onSubmit", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: false, error: "quota exceeded" });
    renderForm({ onSubmit });
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Digest" } });
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: "summarize" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await screen.findByText(/quota exceeded/i);
  });

  it("提交时带上默认 (instanceId, model)", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    renderForm({ onSubmit });
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Digest" } });
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: "summarize" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: "inst_1", model: "model-a1" }),
      ),
    );
  });

  it("用 ModelPicker 切到另一模型后提交带新 model", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    renderForm({ onSubmit });
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Digest" } });
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: "summarize" } });
    fireEvent.click(screen.getByRole("button", { name: /model-a1/ })); // open picker (current inst expanded)
    fireEvent.click(screen.getByRole("button", { name: "model-a2" }));  // pick another model
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: "inst_1", model: "model-a2" }),
      ),
    );
  });

  it("编辑模式也显示 ModelPicker（不再隐藏实例选择）", async () => {
    const editing = {
      id: "sched_e", title: "Old", prompt: "p", spec: { intervalMinutes: 60 },
      instanceId: "inst_2", model: "model-b1", enabled: true, status: "active" as const,
      createdAt: 1, runCount: 0, consecutiveFailures: 0, runIds: [],
    };
    renderForm({ editing });
    expect(screen.getByRole("button", { name: /model-b1/ })).toBeTruthy(); // trigger shows edited record's model
  });
});
