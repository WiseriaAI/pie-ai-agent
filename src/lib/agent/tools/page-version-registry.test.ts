import { describe, it, expect, beforeEach } from "vitest";
import {
  recordFrameVersion,
  getFrameVersion,
  markObserverDead,
  clearFrame,
  clearTab,
  resetRegistry,
} from "./page-version-registry";

describe("page-version-registry", () => {
  beforeEach(() => resetRegistry());

  it("记录与读取 version", () => {
    recordFrameVersion(1, 0, 42);
    expect(getFrameVersion(1, 0)).toEqual({ version: 42, observerAlive: true });
  });

  it("读取未记录的 frame 返回 undefined", () => {
    expect(getFrameVersion(99, 0)).toBeUndefined();
  });

  it("clearFrame 移除该 frame", () => {
    recordFrameVersion(1, 0, 42);
    clearFrame(1, 0);
    expect(getFrameVersion(1, 0)).toBeUndefined();
  });

  it("clearTab 移除整 tab 所有 frame", () => {
    recordFrameVersion(1, 0, 42);
    recordFrameVersion(1, 3, 7);
    clearTab(1);
    expect(getFrameVersion(1, 0)).toBeUndefined();
    expect(getFrameVersion(1, 3)).toBeUndefined();
  });

  it("markObserverDead 设 observerAlive=false 保留 version", () => {
    recordFrameVersion(1, 0, 42);
    markObserverDead(1, 0);
    expect(getFrameVersion(1, 0)).toEqual({ version: 42, observerAlive: false });
  });

  it("recordFrameVersion 覆盖时重置 observerAlive=true", () => {
    recordFrameVersion(1, 0, 42);
    markObserverDead(1, 0);
    recordFrameVersion(1, 0, 43);
    expect(getFrameVersion(1, 0)).toEqual({ version: 43, observerAlive: true });
  });
});
