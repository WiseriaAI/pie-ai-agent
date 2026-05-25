import { describe, it, expect, beforeEach } from "vitest";
import {
  recordFrameVersion,
  getFrameVersion,
  markObserverDead,
  clearFrame,
  clearTab,
  resetRegistry,
  setVersionFromBump,
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

  it("setVersionFromBump 创建 entry if not present", () => {
    setVersionFromBump(2, 5, 30);
    expect(getFrameVersion(2, 5)).toEqual({ version: 30, observerAlive: true });
  });

  it("setVersionFromBump 更新已有 entry 且保 observerAlive=true", () => {
    recordFrameVersion(2, 5, 30);
    markObserverDead(2, 5);
    setVersionFromBump(2, 5, 31);
    expect(getFrameVersion(2, 5)).toEqual({ version: 31, observerAlive: true });
  });
});
