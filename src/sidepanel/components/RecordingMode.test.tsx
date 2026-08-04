/**
 * RecordingMode row rendering — issue #342. Step rows are composed at render time
 * from the structured `target` (kindKey / name / nth / regionKey / editorEngine) via
 * i18n dicts, so the same recorded actions render in the active UI locale and a
 * language switch re-renders even already-captured rows.
 */
import { render, screen, act, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import RecordingMode from "./RecordingMode";
import { I18nProvider, STORAGE_KEY_UI_LOCALE } from "@/lib/i18n";
import { setConfig } from "@/lib/idb/config-store";
import { publishChange } from "@/lib/store-bus";
import { _resetForTests } from "@/lib/idb/db";
import type { RecordedAction } from "@/lib/recording/types";

afterEach(cleanup);
beforeEach(async () => {
  await _resetForTests();
});

function mk(partial: Partial<RecordedAction>, ts: number): RecordedAction {
  return { type: "click", url: "https://x.com", timestamp: ts, ...partial };
}

const ACTIONS: RecordedAction[] = [
  mk({ type: "click", target: { kindKey: "button", name: "Save" } }, 1),
  mk({ type: "click", target: { kindKey: "checkbox", name: "Agree" }, checked: true }, 2),
  mk({ type: "click", target: { kindKey: "link", nth: 3, regionKey: "nav" }, unstable: true }, 3),
  mk({ type: "click", target: { kindKey: "editor", editorEngine: "Monaco" } }, 4),
  mk({ type: "scroll", direction: "down", value: "640" }, 5),
];

function renderBooth() {
  return render(
    <I18nProvider>
      <RecordingMode
        active
        actions={ACTIONS}
        lastAbortReason={null}
        onFinish={() => {}}
        onDiscard={() => {}}
      />
    </I18nProvider>,
  );
}

describe("RecordingMode structured rows (#342)", () => {
  it("renders kind/region/checked words in English by default", async () => {
    renderBooth();
    // kind words (language-neutral codes → English dict). getByText throws if absent.
    await waitFor(() => expect(screen.getByText("button")).toBeTruthy());
    expect(screen.getByText("link")).toBeTruthy();
    expect(screen.getByText("checkbox")).toBeTruthy();
    expect(screen.getByText("editor")).toBeTruthy();
    // page-verbatim name + editor engine
    expect(screen.getByText("Save")).toBeTruthy();
    expect(screen.getByText("Monaco")).toBeTruthy();
    // nth fallback + region word + checked state + scroll (locale-neutral glyphs)
    expect(screen.getByText("#3")).toBeTruthy();
    expect(screen.getByText(/·\s*nav/)).toBeTruthy();
    expect(screen.getByText(/checked/)).toBeTruthy();
    expect(screen.getByText(/640px/)).toBeTruthy();
  });

  it("re-renders the same rows in Chinese after a locale switch", async () => {
    renderBooth();
    await waitFor(() => expect(screen.getByText("button")).toBeTruthy());

    await act(async () => {
      await setConfig(STORAGE_KEY_UI_LOCALE, "zh-CN");
      publishChange("config", "put", STORAGE_KEY_UI_LOCALE);
    });

    // Same recorded actions, now localized to zh-CN at render time.
    await waitFor(() => expect(screen.getByText("按钮")).toBeTruthy());
    expect(screen.getByText("链接")).toBeTruthy();
    expect(screen.getByText("复选框")).toBeTruthy();
    expect(screen.getByText("编辑器")).toBeTruthy();
    expect(screen.getByText(/·\s*导航区/)).toBeTruthy();
    expect(screen.getByText(/勾选/)).toBeTruthy();
    // English kind words are gone.
    expect(screen.queryByText("button")).toBeNull();
  });
});
