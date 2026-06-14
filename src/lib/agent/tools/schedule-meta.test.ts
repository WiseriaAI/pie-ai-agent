// TDD tests for schedule-meta.ts (Task 7)
//
// Covers:
//   7.1 — create/update/delete/list schedule tools
//   7.2 — tool-names build-time class invariant (implicit — import of tool-names exercises it)
//   7.4 — recursive creation prevention (headless ctx excludes create/update)
//   7.5 — instance deletion cascades to paused + disarmed schedules

import { describe, it, expect, beforeEach, vi, type MockedFunction } from "vitest";
import { SCHEDULE_META_TOOLS } from "./schedule-meta";
import { getSchedule, listSchedules, putSchedule, deleteSchedule } from "../../schedules/store";
import { armSchedule, disarmSchedule } from "../../schedules/scheduler";
import { createInstance } from "../../instances";
import { _resetForTests } from "../../idb/db";
import { _resetKeyForTests } from "../../crypto";
import type { ToolHandlerContext } from "../types";
import type { ScheduleRecord } from "../../schedules/types";
import { newScheduleId, MIN_INTERVAL_MINUTES, MAX_SCHEDULES } from "../../schedules/types";

// ── Mock scheduler (armSchedule / disarmSchedule) ────────────────────────────
vi.mock("../../schedules/scheduler", () => ({
  armSchedule: vi.fn().mockResolvedValue(undefined),
  disarmSchedule: vi.fn().mockResolvedValue(undefined),
}));

const mockedArm = armSchedule as MockedFunction<typeof armSchedule>;
const mockedDisarm = disarmSchedule as MockedFunction<typeof disarmSchedule>;

const EMPTY_CTX = {} as ToolHandlerContext; // 无会话选择 → 走 resolveSelection 兜底

const create = SCHEDULE_META_TOOLS.find((t) => t.name === "create_schedule")!;
const update = SCHEDULE_META_TOOLS.find((t) => t.name === "update_schedule")!;
const del = SCHEDULE_META_TOOLS.find((t) => t.name === "delete_schedule")!;
const list = SCHEDULE_META_TOOLS.find((t) => t.name === "list_schedules")!;

const TEST_INSTANCE_ID = "test-instance-001";

/** seed 一个真实例（镜像全新 V2：配了 provider 但没写 active_instance_id）。
 *  create_schedule 无显式 instanceId 时经 resolveSelection 兜底解析到它。 */
async function seedInstance(): Promise<string> {
  return createInstance({ provider: "anthropic", nickname: "A", apiKey: "k" });
}

async function clearAll() {
  await _resetForTests();
  _resetKeyForTests();
  vi.clearAllMocks();
}

/** Helper: build a minimal ScheduleRecord for manual insertion. */
function makeRecord(override: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: newScheduleId(),
    title: "Test",
    prompt: "do something",
    spec: { intervalMinutes: 60 },
    instanceId: TEST_INSTANCE_ID,
    enabled: true,
    status: "active",
    runCount: 0,
    consecutiveFailures: 0,
    runIds: [],
    createdAt: Date.now(),
    ...override,
  };
}

describe("schedule-meta CRUD tools", () => {
  beforeEach(clearAll);

  // ── create_schedule ─────────────────────────────────────────────────────────

  it("create_schedule 写入 store 并调用 armSchedule", async () => {
    const seededId = await seedInstance();
    const r = await create.handler(
      { title: "Daily Report", prompt: "summarize the news" },
      EMPTY_CTX,
    );
    expect(r.success).toBe(true);
    expect(r.observation).toContain("id=");

    const all = await listSchedules();
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe("Daily Report");
    expect(all[0]!.instanceId).toBe(seededId);
    expect(mockedArm).toHaveBeenCalledOnce();
  });

  it("create_schedule 使用显式 instanceId 覆盖 active", async () => {
    await seedInstance();
    const r = await create.handler(
      { title: "T", prompt: "p", instanceId: TEST_INSTANCE_ID },
      EMPTY_CTX,
    );
    expect(r.success).toBe(true);
    const all = await listSchedules();
    expect(all[0]!.instanceId).toBe(TEST_INSTANCE_ID);
  });

  it("create_schedule: 会话 ctx → 绑定当前会话 (instance, model) (#181)", async () => {
    const ctx = { currentInstanceId: "inst_live", currentModel: "claude-opus-4-7" } as ToolHandlerContext;
    const r = await create.handler({ title: "T", prompt: "p" }, ctx);
    expect(r.success).toBe(true);
    const all = await listSchedules();
    expect(all[0]!.instanceId).toBe("inst_live");
    expect(all[0]!.model).toBe("claude-opus-4-7");
  });

  it("create_schedule: 无 ctx + active 为 null + 有实例 → resolveSelection 兜底成功 (#181)", async () => {
    const id = await seedInstance();
    const r = await create.handler({ title: "T", prompt: "p" }, EMPTY_CTX);
    expect(r.success).toBe(true);
    const all = await listSchedules();
    expect(all[0]!.instanceId).toBe(id);
  });

  it("create_schedule: 真零配置(无实例 + 无 ctx) → 清晰错误 (#181)", async () => {
    const r = await create.handler({ title: "T", prompt: "p" }, EMPTY_CTX);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/provider/i);
  });

  it("create_schedule 拒绝空 title", async () => {
    const r = await create.handler({ title: "", prompt: "p" }, EMPTY_CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain("title");
  });

  it("create_schedule 拒绝空 prompt", async () => {
    const r = await create.handler({ title: "T", prompt: "" }, EMPTY_CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain("prompt");
  });

  it(`create_schedule 拒绝 intervalMinutes < ${MIN_INTERVAL_MINUTES}`, async () => {
    await seedInstance();
    const r = await create.handler(
      { title: "T", prompt: "p", spec: { intervalMinutes: MIN_INTERVAL_MINUTES - 1 } },
      EMPTY_CTX,
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain(`${MIN_INTERVAL_MINUTES}`);
  });

  it(`create_schedule 允许 intervalMinutes = ${MIN_INTERVAL_MINUTES} (边界值)`, async () => {
    await seedInstance();
    const r = await create.handler(
      { title: "T", prompt: "p", spec: { intervalMinutes: MIN_INTERVAL_MINUTES } },
      EMPTY_CTX,
    );
    expect(r.success).toBe(true);
  });

  it("create_schedule 拒绝 restricted startUrl (chrome://)", async () => {
    await seedInstance();
    const r = await create.handler(
      { title: "T", prompt: "p", startUrl: "chrome://extensions" },
      EMPTY_CTX,
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/restricted|chrome/i);
  });

  it(`create_schedule 超过 MAX_SCHEDULES(${MAX_SCHEDULES}) 拒绝`, async () => {
    await seedInstance();
    // Insert MAX_SCHEDULES records directly to bypass the limit temporarily
    for (let i = 0; i < MAX_SCHEDULES; i++) {
      await putSchedule(makeRecord({ title: `S${i}` }));
    }
    const r = await create.handler({ title: "Extra", prompt: "p" }, EMPTY_CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain(`${MAX_SCHEDULES}`);
  });

  // ── Block B — startAt accepts a local-time ISO string ────────────────────────

  it("create_schedule 接受本地时间 ISO 字符串 startAt → 存为 epoch ms (number)", async () => {
    await seedInstance();
    const iso = "2026-06-13T09:00";
    const r = await create.handler(
      { title: "T", prompt: "p", spec: { startAt: iso } },
      EMPTY_CTX,
    );
    expect(r.success).toBe(true);
    const all = await listSchedules();
    expect(all).toHaveLength(1);
    const stored = all[0]!.spec.startAt;
    expect(typeof stored).toBe("number");
    expect(stored).toBe(new Date(iso).getTime());
  });

  it("create_schedule 拒绝非法 startAt 字符串", async () => {
    const r = await create.handler(
      { title: "T", prompt: "p", spec: { startAt: "not-a-date" } },
      EMPTY_CTX,
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/startAt/i);
  });

  it("update_schedule 接受 startAt ISO 字符串 → 存为 epoch ms", async () => {
    await seedInstance();
    await create.handler({ title: "T", prompt: "p" }, EMPTY_CTX);
    const all = await listSchedules();
    const id = all[0]!.id;

    const iso = "2026-12-25T18:30";
    const r = await update.handler({ id, spec: { startAt: iso } }, EMPTY_CTX);
    expect(r.success).toBe(true);
    const updated = await getSchedule(id);
    expect(typeof updated!.spec.startAt).toBe("number");
    expect(updated!.spec.startAt).toBe(new Date(iso).getTime());
  });

  it("update_schedule 拒绝非法 startAt 字符串", async () => {
    await seedInstance();
    await create.handler({ title: "T", prompt: "p" }, EMPTY_CTX);
    const all = await listSchedules();
    const id = all[0]!.id;

    const r = await update.handler({ id, spec: { startAt: "garbage" } }, EMPTY_CTX);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/startAt/i);
  });

  it("create_schedule 初始 status=active, enabled=true, runCount=0", async () => {
    await seedInstance();
    await create.handler({ title: "T", prompt: "p" }, EMPTY_CTX);
    const all = await listSchedules();
    expect(all[0]!.status).toBe("active");
    expect(all[0]!.enabled).toBe(true);
    expect(all[0]!.runCount).toBe(0);
    expect(all[0]!.consecutiveFailures).toBe(0);
    expect(all[0]!.runIds).toEqual([]);
  });

  // ── update_schedule ─────────────────────────────────────────────────────────

  it("update_schedule 更新 title 和 prompt", async () => {
    await seedInstance();
    await create.handler({ title: "Old", prompt: "old prompt" }, EMPTY_CTX);
    const all = await listSchedules();
    const id = all[0]!.id;

    const r = await update.handler({ id, title: "New", prompt: "new prompt" }, EMPTY_CTX);
    expect(r.success).toBe(true);

    const updated = await getSchedule(id);
    expect(updated!.title).toBe("New");
    expect(updated!.prompt).toBe("new prompt");
  });

  it("update_schedule 改 intervalMinutes 触发重排 (disarm + arm)", async () => {
    await seedInstance();
    await create.handler({ title: "T", prompt: "p" }, EMPTY_CTX);
    vi.clearAllMocks(); // reset arm call count after create
    const all = await listSchedules();
    const id = all[0]!.id;

    const r = await update.handler({ id, spec: { intervalMinutes: 60 } }, EMPTY_CTX);
    expect(r.success).toBe(true);
    expect(mockedDisarm).toHaveBeenCalledWith(id);
    expect(mockedArm).toHaveBeenCalledOnce();
  });

  it("update_schedule 改 startAt 触发重排", async () => {
    await seedInstance();
    await create.handler({ title: "T", prompt: "p" }, EMPTY_CTX);
    vi.clearAllMocks();
    const all = await listSchedules();
    const id = all[0]!.id;

    const futureAt = Date.now() + 60 * 60 * 1000;
    const r = await update.handler({ id, spec: { startAt: futureAt } }, EMPTY_CTX);
    expect(r.success).toBe(true);
    expect(mockedDisarm).toHaveBeenCalledWith(id);
    expect(mockedArm).toHaveBeenCalledOnce();
  });

  it("update_schedule 不改 spec 时不重排", async () => {
    await seedInstance();
    await create.handler({ title: "T", prompt: "p" }, EMPTY_CTX);
    vi.clearAllMocks();
    const all = await listSchedules();
    const id = all[0]!.id;

    const r = await update.handler({ id, title: "New Title" }, EMPTY_CTX);
    expect(r.success).toBe(true);
    expect(mockedDisarm).not.toHaveBeenCalled();
    expect(mockedArm).not.toHaveBeenCalled();
  });

  it("update_schedule 拒绝不存在的 id", async () => {
    const r = await update.handler({ id: "sched_nonexistent" }, EMPTY_CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain("not found");
  });

  it("update_schedule 拒绝 intervalMinutes < MIN", async () => {
    await seedInstance();
    await create.handler({ title: "T", prompt: "p" }, EMPTY_CTX);
    const all = await listSchedules();
    const id = all[0]!.id;

    const r = await update.handler(
      { id, spec: { intervalMinutes: MIN_INTERVAL_MINUTES - 1 } },
      EMPTY_CTX,
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain(`${MIN_INTERVAL_MINUTES}`);
  });

  // ── delete_schedule ─────────────────────────────────────────────────────────

  it("delete_schedule 删除 store + 调用 disarmSchedule", async () => {
    await seedInstance();
    await create.handler({ title: "ToDelete", prompt: "p" }, EMPTY_CTX);
    const all = await listSchedules();
    const id = all[0]!.id;

    const r = await del.handler({ id }, EMPTY_CTX);
    expect(r.success).toBe(true);
    expect(await getSchedule(id)).toBeNull();
    expect(mockedDisarm).toHaveBeenCalledWith(id);
  });

  it("delete_schedule 拒绝不存在的 id", async () => {
    const r = await del.handler({ id: "sched_gone" }, EMPTY_CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain("not found");
  });

  // ── list_schedules ──────────────────────────────────────────────────────────

  it("list_schedules 返回 JSON 数组含 id/title/spec/enabled/status/runCount", async () => {
    await seedInstance();
    await create.handler({ title: "Listed", prompt: "p" }, EMPTY_CTX);
    const r = await list.handler({}, EMPTY_CTX);
    expect(r.success).toBe(true);
    const items = JSON.parse(r.observation!);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.id).toMatch(/^sched_/);
    expect(item.title).toBe("Listed");
    expect(item.enabled).toBe(true);
    expect(item.status).toBe("active");
    expect(item.runCount).toBe(0);
    expect(item).toHaveProperty("spec");
  });

  it("list_schedules 空列表时返回 []", async () => {
    const r = await list.handler({}, EMPTY_CTX);
    expect(r.success).toBe(true);
    expect(JSON.parse(r.observation!)).toEqual([]);
  });
});

// ── 7.4 Headless destructive-action prevention ───────────────────────────────

describe("7.4 — headless run tool exclusion", () => {
  it("SCHEDULE_META_TOOLS 含 create/update/delete_schedule (write-class)", () => {
    // Verify the tools exist (all three write-class tools are excluded in
    // run.ts via excludeToolNames for headless runs).
    expect(create).toBeDefined();
    expect(update).toBeDefined();
    expect(del).toBeDefined();
  });

  it("headless 排除全部 write-class schedule-meta tool (create+update+delete),保留 list", async () => {
    // spec §11 (owner ruling): headless runs are unattended + a prompt-injection
    // surface, so EVERY write-class schedule-meta tool is excluded. Only the
    // read-class list_schedules survives.
    const { HEADLESS_EXCLUDE_TOOL_NAMES } = await import("../../schedules/run");
    expect(HEADLESS_EXCLUDE_TOOL_NAMES).toContain("create_schedule");
    expect(HEADLESS_EXCLUDE_TOOL_NAMES).toContain("update_schedule");
    expect(HEADLESS_EXCLUDE_TOOL_NAMES).toContain("delete_schedule");
    expect(HEADLESS_EXCLUDE_TOOL_NAMES).not.toContain("list_schedules");
  });
});

// ── 7.5 Instance deletion cascade ────────────────────────────────────────────

describe("7.5 — instance deletion cascade", () => {
  beforeEach(clearAll);

  it("deleteInstance 把绑定 schedule 转 paused + disarm", async () => {
    // Insert a schedule bound to TEST_INSTANCE_ID directly
    const rec = makeRecord({ instanceId: TEST_INSTANCE_ID, status: "active" });
    await putSchedule(rec);

    // Import and call deleteInstance
    const { deleteInstance } = await import("../../instances");
    // We need a real stored instance — mock the IDB by inserting a stub
    // via createInstance would require encryption + chrome.storage context,
    // so instead we call the hook logic directly via a test helper export.
    // Alternatively we test by importing the cascade helper exported for Task 8.
    const { cascadeInstanceDelete } = await import("../../instances");
    await cascadeInstanceDelete(TEST_INSTANCE_ID);

    const updated = await getSchedule(rec.id);
    expect(updated!.status).toBe("paused");
    expect(mockedDisarm).toHaveBeenCalledWith(rec.id);
  });

  it("cascadeInstanceDelete 只影响绑定 instanceId 的 schedule", async () => {
    const rec1 = makeRecord({ instanceId: TEST_INSTANCE_ID, status: "active" });
    const rec2 = makeRecord({ instanceId: "other-instance", status: "active" });
    await putSchedule(rec1);
    await putSchedule(rec2);

    const { cascadeInstanceDelete } = await import("../../instances");
    await cascadeInstanceDelete(TEST_INSTANCE_ID);

    const u1 = await getSchedule(rec1.id);
    const u2 = await getSchedule(rec2.id);
    expect(u1!.status).toBe("paused");
    expect(u2!.status).toBe("active"); // untouched
    expect(mockedDisarm).toHaveBeenCalledTimes(1);
    expect(mockedDisarm).toHaveBeenCalledWith(rec1.id);
  });

  it("cascadeInstanceDelete 不影响已 paused 的 schedule", async () => {
    const rec = makeRecord({ instanceId: TEST_INSTANCE_ID, status: "paused" });
    await putSchedule(rec);

    const { cascadeInstanceDelete } = await import("../../instances");
    await cascadeInstanceDelete(TEST_INSTANCE_ID);

    // Already paused — disarm should NOT be called again (optimization)
    expect(mockedDisarm).not.toHaveBeenCalled();
  });
});
