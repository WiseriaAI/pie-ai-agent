import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ModelMetaEditor from "./ModelMetaEditor";

afterEach(() => { cleanup(); });

describe("ModelMetaEditor", () => {
  it("hides tools field when showTools=false", () => {
    render(<ModelMetaEditor showTools={false} onSave={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByText(/advanced/i));
    expect(screen.queryByText(/tools/i)).toBeNull();
    expect(screen.getByText(/vision/i)).toBeTruthy();
  });

  it("shows tools field when showTools=true (custom provider parity)", () => {
    render(<ModelMetaEditor showTools onSave={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByText(/advanced/i));
    expect(screen.getByText(/tools/i)).toBeTruthy();
  });

  it("save emits id + meta with 256k default", () => {
    const onSave = vi.fn();
    render(<ModelMetaEditor showTools={false} onSave={onSave} onCancel={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/model id/i), { target: { value: "m1" } });
    fireEvent.click(screen.getByText(/save/i));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: "m1", tools: true, vision: false, maxContextTokens: 256_000 }),
    );
  });

  it("modelId is read-only in edit mode", () => {
    render(<ModelMetaEditor showTools={false} modelIdReadonly initial={{ id: "fixed", vision: true, maxContextTokens: 999 }} onSave={() => {}} onCancel={() => {}} />);
    const input = screen.getByDisplayValue("fixed") as HTMLInputElement;
    expect(input.readOnly).toBe(true);
  });

  it("cancel fires onCancel", () => {
    const onCancel = vi.fn();
    render(<ModelMetaEditor showTools={false} onSave={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByText(/cancel/i));
    expect(onCancel).toHaveBeenCalled();
  });

  it("initial vision seeds and flows into onSave", () => {
    const onSave = vi.fn();
    render(<ModelMetaEditor showTools={false} initial={{ id: "v1", vision: true, maxContextTokens: 256_000 }} onSave={onSave} onCancel={() => {}} />);
    fireEvent.click(screen.getByText(/save/i));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "v1", vision: true }));
  });
});
