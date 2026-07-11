# Skill 体系 Slice 3：信封授权卡 + grants 设置页 + audit 呈现 + 桥自动重连 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 skill-daemon 体系的人机闭环——首跑 ungranted skill 弹信封授权卡（daemon 权威 payload、批准免卡直到信封变）、设置页可见/可撤销 grants + 最近执行审计、桥断开自动退避重连、`metadata.pie.network` 域名归一化。

**Architecture:** daemon 的 `needs_authorization` 错误升级为带结构化 `SkillAuthPayload`（信封原文 + hash）；扩展 `run_skill_script` disk 分支接 panel-request 新 kind `skill-grant` 弹卡，批准后带 `approvedEnvelopeHash` 重调（daemon 校验 hash 堵信封漂移 TOCTOU）。grants/audit 经既有 `chrome.runtime.sendMessage` SW handler 模式进设置页「本地打通」区。重连逻辑住 local-bridge，动作（`initBridgeAndMigrate`）由 index.ts 注入避免反向依赖。

**Tech Stack:** 现有栈不加依赖——Bun daemon + bun:test；扩展 vitest + happy-dom；panel-request HITL 原语；i18n 六语种字典。

**Spec:** `docs/specs/2026-07-10-skill-system-with-local-daemon.md` §4.4（grant 模型）、§4.5（桥协议）。前置：Slice 1+2 已合并 main（PR #265）。

## Global Constraints

- `PROTOCOL_VERSION` 保持 `1`；所有桥协议改动**只增不改语义**（错误信封加可选 `data`、`RunSkillScriptParams` 加可选 `approvedEnvelopeHash`、新方法 `list_audit` 搭 `skill_fs` capability 不新增 capability）。新扩展对旧 daemon：`needs_authorization` 无 `data` → 明确报错提示升级 daemon，不弹空卡。
- panel-request 原语只服务「工具语义即问人」；**不是** risk-confirm 拦截层（`no-confirm-*` 跨层测试守着，不得触碰）。
- 授权卡渲染的是 **daemon 派生的结构化数据**（skill 名/描述/脚本清单/域名/写路径原文），不经 LLM 转述；skill 内容仍按 untrusted 处理。
- LLM 不能自批：`grantApproved` 只由扩展在用户点了卡之后设置；`run_skill_script` 的 JSON schema **不暴露** `grantApproved`/`approvedEnvelopeHash` 参数。
- i18n 字典 parity：新 key 必须同时进 `en` / `zh-CN` / `zh-TW` / `ja` / `es-419` / `pt-BR` 六份字典（typecheck 强制键对齐）。
- 提交门禁：`pnpm test`、`pnpm typecheck`（0 错）、`pnpm build` 全绿；daemon 侧 `cd daemon && bun test` 全绿。
- daemon 二进制热替换（真机）：`rm ~/.pie/bin/pie && cp daemon/dist/pie ~/.pie/bin/pie && launchctl kickstart -k gui/$(id -u)/ai.wiseria.pie`（cp 覆盖会 codesign SIGKILL；pkill 对 launchd 服务不可靠）。
- wire 类型唯一权威源是 `src/types/local-bridge.ts`；daemon 相对 import，不复制。

---

### Task 1: daemon — `metadata.pie.network` 域名归一化

**Files:**
- Modify: `daemon/src/skill-md.ts`
- Test: `daemon/test/skill-md.test.ts`

**Interfaces:**
- Produces: `normalizeDomain(raw: string): string | null`（导出，测试直调）；`parseSkillMd().declaredCaps.network` 此后只含归一化裸域名。

**背景：** 真机验收发现用户在 `metadata.pie.network` 里写整 URL（`https://example.com`），而 srt `allowedDomains` 只认裸域名——声明悄悄失效。归一化点放 parse 层（`listSkills` 输出、授权卡、srt settings 三处同源受益）。

- [ ] **Step 1: 写失败测试**

在 `daemon/test/skill-md.test.ts` 追加：

```ts
import { normalizeDomain } from "../src/skill-md";

describe("normalizeDomain", () => {
  it("strips scheme / path / query / port and lowercases", () => {
    expect(normalizeDomain("https://API.Example.COM:8443/v1/x?q=1#frag")).toBe("api.example.com");
  });
  it("keeps bare domains and wildcard subdomains", () => {
    expect(normalizeDomain("api.example.com")).toBe("api.example.com");
    expect(normalizeDomain("*.example.com")).toBe("*.example.com");
  });
  it("strips trailing dots and userinfo", () => {
    expect(normalizeDomain("example.com.")).toBe("example.com");
    expect(normalizeDomain("user@ftp.example.com")).toBe("ftp.example.com");
  });
  it("rejects garbage", () => {
    expect(normalizeDomain("not a domain!!")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
  });
});

describe("parseSkillMd network normalization", () => {
  it("normalizes metadata.pie.network entries and drops invalid ones", () => {
    const md = [
      "---",
      "name: net-skill",
      "description: d",
      "metadata:",
      "  pie:",
      '    network: ["https://API.example.com/v1", "plain.example.org", "!!bad!!"]',
      "---",
      "body",
    ].join("\n");
    expect(parseSkillMd(md).declaredCaps.network).toEqual(["api.example.com", "plain.example.org"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && bun test test/skill-md.test.ts`
Expected: FAIL（`normalizeDomain` 未导出）

- [ ] **Step 3: 实现**

`daemon/src/skill-md.ts` 加：

```ts
/** metadata.pie.network 归一化：整 URL / 带端口路径 → 裸域名（srt allowedDomains 语义）。
 *  解析不出合法域名形 → null（调用方丢弃——静默失效比放行错误值安全）。 */
export function normalizeDomain(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  s = s.split(/[/?#]/)[0]; // path / query / fragment
  s = s.replace(/^[^@]*@/, ""); // userinfo
  s = s.replace(/:\d+$/, ""); // port
  s = s.replace(/\.+$/, ""); // trailing dots
  const DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
  return DOMAIN_RE.test(s) ? s : null;
}
```

`parseSkillMd` 返回处改：

```ts
    declaredCaps: {
      network: strArray(pie.network)
        .map(normalizeDomain)
        .filter((d): d is string => d !== null),
      write: strArray(pie.write),
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd daemon && bun test`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add daemon/src/skill-md.ts daemon/test/skill-md.test.ts
git commit -m "feat(daemon): normalize metadata.pie.network declarations to bare domains"
```

---

### Task 2: daemon — `needs_authorization` 带结构化 payload + `approvedEnvelopeHash` 校验

**Files:**
- Modify: `src/types/local-bridge.ts`
- Modify: `daemon/src/skill-exec.ts`
- Modify: `daemon/src/daemon.ts`（`run_skill_script` case 的错误序列化）
- Test: `daemon/test/skill-exec.test.ts`

**Interfaces:**
- Produces: `SkillAuthPayload`（wire 类型，Task 4/5/6 的卡片渲染源）；`RunSkillScriptParams.approvedEnvelopeHash?: string`；`BridgeResponse` 错误信封可选 `data?: unknown`。
- Consumes: `envelopeHash` / `canonicalEnvelope`（`daemon/src/grants.ts`，已存在）。

**语义：** 授权卡的渲染数据由 daemon 在拒绝时权威给出（信封 canonical 化 + hash）。批准后扩展带 `approvedEnvelopeHash` 重调；daemon 发现当前信封 hash 与批准时不一致（卡片挂起期间 skill 声明被改）→ 重新 `needs_authorization`，绝不落错误 grant。

- [ ] **Step 1: wire 类型（`src/types/local-bridge.ts`）**

`RunSkillScriptParams` 加字段：

```ts
  /** 授权卡批准的信封 hash（grantApproved=true 时必带）；daemon 校验它等于
   *  当前磁盘信封的 hash，不等 → 重新 needs_authorization（堵卡片挂起期间
   *  skill 声明被改的 TOCTOU）。 */
  approvedEnvelopeHash?: string;
```

`GrantRecord` 定义后面加：

```ts
/** needs_authorization 错误随带的结构化 payload：授权卡的唯一渲染源（daemon 权威给出）。 */
export interface SkillAuthPayload {
  skillName: string;
  displayName?: string;
  description: string;
  /** canonical 化后的信封（卡上原文展示） */
  envelope: GrantEnvelope;
  /** 批准后随 run 回传（approvedEnvelopeHash） */
  envelopeHash: string;
}
```

`BridgeResponse` 错误分支改为：

```ts
  | { id: string; ok: false; error: { code: string; message: string; data?: unknown } };
```

- [ ] **Step 2: 写失败测试**

`daemon/test/skill-exec.test.ts` 追加（沿用该文件既有的 tmp skillsRoot/grantsPath/fake sandbox 测试夹具写法）：

```ts
it("needs_authorization error carries SkillAuthPayload with canonical envelope + hash", async () => {
  // 夹具：一个声明了 network 的 skill，grants 账本为空
  try {
    await runSkillScript({ name: SKILL, entry: ENTRY }, deps);
    throw new Error("should have thrown");
  } catch (e) {
    expect((e as { code?: string }).code).toBe("needs_authorization");
    const data = (e as { data?: SkillAuthPayload }).data;
    expect(data?.skillName).toBe(SKILL);
    expect(data?.description).toBeTruthy();
    expect(data?.envelope.runnableScripts).toContain(ENTRY);
    expect(data?.envelopeHash).toMatch(/^[0-9a-f]{32}$/);
  }
});

it("grantApproved without matching approvedEnvelopeHash → needs_authorization again, no grant written", async () => {
  await expect(
    runSkillScript({ name: SKILL, entry: ENTRY, grantApproved: true }, deps),
  ).rejects.toMatchObject({ code: "needs_authorization" });
  await expect(
    runSkillScript(
      { name: SKILL, entry: ENTRY, grantApproved: true, approvedEnvelopeHash: "0".repeat(32) },
      deps,
    ),
  ).rejects.toMatchObject({ code: "needs_authorization" });
  expect(listGrants(deps.grantsPath)).toHaveLength(0);
});

it("grantApproved with correct hash writes grant and runs", async () => {
  const payload = await runSkillScript({ name: SKILL, entry: ENTRY }, deps).catch(
    (e) => (e as { data?: SkillAuthPayload }).data,
  );
  const res = await runSkillScript(
    { name: SKILL, entry: ENTRY, grantApproved: true, approvedEnvelopeHash: payload!.envelopeHash },
    deps,
  );
  expect(res.output).toBeDefined();
  expect(listGrants(deps.grantsPath)).toHaveLength(1);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd daemon && bun test test/skill-exec.test.ts`
Expected: FAIL（error 无 `data`；错 hash 也落 grant）

- [ ] **Step 4: 实现 `daemon/src/skill-exec.ts`**

import 行补 `envelopeHash`（来自 `./grants`）与 `SkillAuthPayload` 类型；grant 判定块改为：

```ts
  if (!hasGrant(name, envelope, grantsPath)) {
    const hash = envelopeHash(envelope);
    if (!params.grantApproved || params.approvedEnvelopeHash !== hash) {
      const data: SkillAuthPayload = {
        skillName: name,
        displayName: summary.displayName,
        description: summary.description,
        envelope,
        envelopeHash: hash,
      };
      throw Object.assign(new Error("authorization required"), {
        code: "needs_authorization",
        data,
      });
    }
    putGrant({ key: grantKey(name, envelope), skillName: name, envelope, grantedAt: now() }, grantsPath);
  }
```

- [ ] **Step 5: 实现 `daemon/src/daemon.ts` 错误序列化**

`run_skill_script` case 的 catch 改为透传 `data`：

```ts
        const code = (e as { code?: string }).code ?? "run_skill_script_failed";
        const data = (e as { data?: unknown }).data;
        log("error", "run_skill_script.failed", { id, code, error: String(e) });
        return respond({
          ok: false,
          error: { code, message: String(e), ...(data !== undefined ? { data } : {}) },
        });
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd daemon && bun test && cd .. && pnpm typecheck`
Expected: 全绿（wire 类型改动是加法，扩展侧编译不受影响）

- [ ] **Step 7: Commit**

```bash
git add src/types/local-bridge.ts daemon/src/skill-exec.ts daemon/src/daemon.ts daemon/test/skill-exec.test.ts
git commit -m "feat(daemon): needs_authorization carries SkillAuthPayload; approvedEnvelopeHash closes grant TOCTOU"
```

---

### Task 3: daemon — `list_audit` 桥方法

**Files:**
- Modify: `src/types/local-bridge.ts`
- Modify: `daemon/src/audit.ts`
- Modify: `daemon/src/daemon.ts`
- Test: `daemon/test/daemon-skill-fs.test.ts`（或新建 `daemon/test/audit.test.ts`，若前者夹具不便）

**Interfaces:**
- Produces: wire 类型 `AuditEntry` / `ListAuditParams` / `ListAuditResult`；桥方法 `"list_audit"`；`readAuditTail(limit?, path?): AuditEntry[]`。
- 注意：**不新增 capability**——`list_audit` 搭 `skill_fs` 走；旧 daemon 无此方法回 `unknown_method`，扩展侧（Task 7）catch 后按空列表渲染。

- [ ] **Step 1: wire 类型**

`src/types/local-bridge.ts` 的 skill_fs 区追加（`AuditEntry` 从 `daemon/src/audit.ts` **搬来**，daemon 侧改 import——wire 单一权威源）：

```ts
/** audit.jsonl 单行（daemon 每次脚本执行追加）。 */
export interface AuditEntry {
  ts: number;
  skillName: string;
  entry: string;
  envelope: GrantEnvelope;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  ms: number;
}
export interface ListAuditParams {
  /** 返回最近 N 条（默认 20，上限 200） */
  limit?: number;
}
export interface ListAuditResult {
  entries: AuditEntry[];
}
```

`BridgeRequest.method` 联合类型加 `| "list_audit"`。

- [ ] **Step 2: 写失败测试**

```ts
import { appendAudit, readAuditTail } from "../src/audit";

describe("readAuditTail", () => {
  it("returns newest-first tail, skipping corrupt lines, empty when file missing", () => {
    const path = join(tmpDir, "audit.jsonl");
    expect(readAuditTail(20, path)).toEqual([]);
    for (let i = 0; i < 5; i++) {
      appendAudit({ ts: i, skillName: "s", entry: "e.ts", envelope: EMPTY_ENV, exitCode: 0, timedOut: false, truncated: false, ms: 1 }, path);
    }
    appendFileSync(path, "not json\n");
    const tail = readAuditTail(3, path);
    expect(tail.map((e) => e.ts)).toEqual([4, 3, 2]);
  });
});
```

daemon dispatch 测试（`daemon-skill-fs.test.ts` 既有 dispatch 夹具风格）：`list_audit` 返回 `{entries: [...]}`；`limit` 越界被夹到 200。

- [ ] **Step 3: 跑测试确认失败**

Run: `cd daemon && bun test`
Expected: FAIL（`readAuditTail` 不存在）

- [ ] **Step 4: 实现 `daemon/src/audit.ts`**

删本地 `AuditEntry` interface，改 `import type { AuditEntry, GrantEnvelope } from "../../src/types/local-bridge";`（`AuditEntry` 需 re-export 保住既有 import 方）。追加：

```ts
export function readAuditTail(limit = 20, path = paths.auditPath): AuditEntry[] {
  // ponytail: 全量读文件取尾——一行一条,v1 量级 MB 内;文件真大了再改 seek 尾块
  const n = Math.max(1, Math.min(limit, 200));
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const out: AuditEntry[] = [];
    for (const line of lines.slice(-n)) {
      try {
        out.push(JSON.parse(line) as AuditEntry);
      } catch {
        /* 坏行跳过 */
      }
    }
    return out.reverse(); // 新的在前
  } catch {
    return [];
  }
}
```

（`readFileSync` 进 import。）

- [ ] **Step 5: 实现 `daemon/src/daemon.ts`**

`revoke_grant` case 后加：

```ts
    case "list_audit": {
      try {
        const p = (msg.params ?? {}) as ListAuditParams;
        return respond({ ok: true, result: { entries: readAuditTail(p.limit) } satisfies ListAuditResult });
      } catch (e) {
        log("error", "list_audit.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "list_audit_failed", message: String(e) } });
      }
    }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd daemon && bun test && cd .. && pnpm typecheck`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add src/types/local-bridge.ts daemon/src/audit.ts daemon/src/daemon.ts daemon/test/
git commit -m "feat(daemon): list_audit bridge method — newest-first audit tail"
```

---

### Task 4: 扩展 — 桥客户端：错误 `data` 透传 + `RunSkillScriptOutcome.auth` + `requestListAudit`

**Files:**
- Modify: `src/background/local-bridge.ts`
- Test: `src/background/local-bridge.test.ts`

**Interfaces:**
- Produces: `RunSkillScriptOutcome` 的 needsAuth 变体带 `auth?: SkillAuthPayload`；`requestListAudit(p?): Promise<ListAuditResult>`。
- Consumes: Task 2/3 的 wire 类型。

- [ ] **Step 1: 写失败测试**

`local-bridge.test.ts` 沿用既有 fake `chrome.runtime.connectNative` 夹具：

```ts
it("requestRunSkillScript surfaces needs_authorization data as outcome.auth", async () => {
  // 夹具回 { ok:false, error:{ code:"needs_authorization", message:"…", data: PAYLOAD } }
  const outcome = await requestRunSkillScript({ name: "s", entry: "e.ts" });
  expect(outcome).toMatchObject({ ok: false, needsAuth: true });
  expect((outcome as { auth?: SkillAuthPayload }).auth?.envelopeHash).toBe(PAYLOAD.envelopeHash);
});

it("needs_authorization without data (old daemon) → auth undefined", async () => { /* data 缺省 */ });

it("requestListAudit round-trips entries", async () => { /* 夹具回 {entries:[…]} */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/background/local-bridge.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`onMessage` 错误分支（`code` 定义后）加：

```ts
      if (msg.error.data !== undefined)
        // 非枚举：与 code 同理，防 JSON.stringify(err) 把 payload 泄进 LLM 可见文案
        Object.defineProperty(err, "data", { value: msg.error.data, enumerable: false });
```

Outcome 类型与解析：

```ts
export type RunSkillScriptOutcome =
  | { ok: true; result: RunSkillScriptResult }
  | { ok: false; needsAuth: true; auth?: SkillAuthPayload }
  | { ok: false; needsAuth: false; error: string };

// requestRunSkillScript catch 内：
    if (code === "needs_authorization") {
      return { ok: false, needsAuth: true, auth: (e as { data?: SkillAuthPayload }).data };
    }
```

新客户端方法（import 补 `ListAuditParams`/`ListAuditResult`/`SkillAuthPayload`）：

```ts
export async function requestListAudit(p: ListAuditParams = {}): Promise<ListAuditResult> {
  return (await send("list_audit", p)) as ListAuditResult;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/background/local-bridge.test.ts && pnpm typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/background/local-bridge.ts src/background/local-bridge.test.ts
git commit -m "feat(bridge): error data passthrough, RunSkillScriptOutcome.auth, requestListAudit"
```

---

### Task 5: 扩展 — `run_skill_script` 授权流：panel-request kind `skill-grant` + loop 按会话装配

**Files:**
- Modify: `src/lib/panel-request.ts`（kind 注册表 +1 行）
- Modify: `src/lib/agent/tools/skill-script.ts`（deps + disk 分支授权流 + 删模块级默认实例）
- Modify: `src/lib/agent/tools.ts`（BUILT_IN_TOOLS 移除 `RUN_SKILL_SCRIPT_TOOL`）
- Modify: `src/lib/agent/loop.ts`（per-run 装配，`requestFromPanel(sessionId, "skill-grant", …)` 闭包 sessionId）
- Test: `src/lib/agent/tools/skill-script.test.ts`

**Interfaces:**
- Produces: `SkillGrantRequest`（卡片 payload 类型，panel-request map 与 SkillGrantCard 共用）；`SkillScriptDeps.requestGrant: (p: SkillGrantRequest) => Promise<boolean>`；`SkillScriptDeps.runOnDaemon` 参数放宽为 `RunSkillScriptParams`。
- Consumes: `requestRunSkillScript`（Task 4 outcome）、`requestFromPanel`（既有）。

**装配决策：** `ToolHandlerContext` 不带 sessionId，而 `requestFromPanel` 需要它。House 精确前例是 mouse/keyboard tools——需要 sessionId 的工具在 loop.ts per-run 工厂构建，不进 BUILT_IN_TOOLS 静态表。`run_skill_script` 照搬：从 BUILT_IN_TOOLS 移出，loop.ts 内 `buildRunSkillScriptTool({...默认 deps, requestGrant})` 加进 `fullToolList`。工具分组（`tool-names.ts` 的 TOOL_GROUPS）按名字判定，装配点迁移不影响 progressive disclosure。

**头less/panel 关闭语义：** `requestFromPanel` 无 port 时 reject——handler catch 后返回明确错误（不批准、不重试）。schedule 头less 跑到 ungranted skill = 自动拒绝，符合「无人在场不授权」。

- [ ] **Step 1: kind 注册（`src/lib/panel-request.ts`）**

`PanelRequestMap` 加（`import type { SkillGrantRequest } from "./agent/tools/skill-script";`——类型 import，无运行时环）：

```ts
  "skill-grant": { req: SkillGrantRequest; res: boolean };
```

- [ ] **Step 2: 写失败测试（`skill-script.test.ts`）**

既有测试用 `buildRunSkillScriptTool` 假 deps——全部补 `requestGrant: async () => false`（或按用例覆写）。新增用例：

```ts
it("disk needsAuth → card approved → retries with grantApproved + approvedEnvelopeHash → ok", async () => {
  const calls: RunSkillScriptParams[] = [];
  const runOnDaemon = vi.fn(async (p: RunSkillScriptParams) => {
    calls.push(p);
    if (!p.grantApproved) return { ok: false as const, needsAuth: true as const, auth: AUTH_PAYLOAD };
    return { ok: true as const, result: { output: "ran" } };
  });
  const requestGrant = vi.fn(async () => true);
  const tool = buildRunSkillScriptTool({ ...deps, runOnDaemon, requestGrant });
  const r = await tool.handler({ skillId: "s", entry: "e.ts" }, ctx);
  expect(r.success).toBe(true);
  expect(requestGrant).toHaveBeenCalledWith(
    expect.objectContaining({ skillName: "s", scripts: AUTH_PAYLOAD.envelope.runnableScripts }),
  );
  expect(calls[1]).toMatchObject({ grantApproved: true, approvedEnvelopeHash: AUTH_PAYLOAD.envelopeHash });
});

it("card denied → error, no retry", async () => { /* requestGrant → false; runOnDaemon 只 1 次 */ });

it("needsAuth without auth payload (old daemon) → update-daemon error, no card", async () => {
  /* auth: undefined; requestGrant 不被调 */
});

it("requestGrant rejects (panel closed / headless) → declined error", async () => { /* rejects → success:false */ });

it("retry hits needsAuth again (envelope changed mid-card) → explanatory error, no loop", async () => {
  /* runOnDaemon 永远 needsAuth+auth；handler 恰好调 2 次后放弃 */
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test src/lib/agent/tools/skill-script.test.ts`
Expected: FAIL（deps 无 requestGrant）

- [ ] **Step 4: 实现 `skill-script.ts`**

类型与 deps：

```ts
/** skill-grant 授权卡 payload：daemon SkillAuthPayload 的展开（卡片按行渲染）。 */
export interface SkillGrantRequest {
  skillName: string;
  displayName?: string;
  description: string;
  scripts: string[];
  network: string[];
  write: string[];
}

export interface SkillScriptDeps {
  runInSandbox: (code: string, input: unknown) => Promise<string>;
  getSource: () => SkillSource;
  /** 磁盘 skill 特权脚本执行器：走本地 daemon 的 OS 沙箱。 */
  runOnDaemon: (p: RunSkillScriptParams) => Promise<RunSkillScriptOutcome>;
  /** HITL 授权卡：展示信封原文，用户批/拒。panel 不在（headless/已关）时 reject。 */
  requestGrant: (p: SkillGrantRequest) => Promise<boolean>;
}
```

disk 分支执行段改为（替换现有 `const outcome = …` 到 needsAuth 占位错误那一整段）：

```ts
        const finalArgs = argv ?? (a.input !== undefined ? [JSON.stringify(a.input)] : []);
        let outcome = await deps.runOnDaemon({ name: a.skillId, entry, args: finalArgs });
        if (!outcome.ok && outcome.needsAuth) {
          const auth = outcome.auth;
          if (!auth) {
            return {
              success: false,
              error:
                "authorization_required: this skill needs user approval, but the connected Pie " +
                "daemon is too old to describe what it would grant. Ask the user to update the Pie daemon.",
            };
          }
          let approved = false;
          try {
            approved = await deps.requestGrant({
              skillName: auth.skillName,
              displayName: auth.displayName,
              description: auth.description,
              scripts: auth.envelope.runnableScripts,
              network: auth.envelope.allowedDomains,
              write: auth.envelope.extraWrites,
            });
          } catch {
            return {
              success: false,
              error:
                "authorization_required: no user present to approve (sidepanel closed or headless run).",
            };
          }
          if (!approved) return { success: false, error: "User declined skill authorization." };
          outcome = await deps.runOnDaemon({
            name: a.skillId,
            entry,
            args: finalArgs,
            grantApproved: true,
            approvedEnvelopeHash: auth.envelopeHash,
          });
          if (!outcome.ok && outcome.needsAuth) {
            return {
              success: false,
              error:
                "Skill declarations changed while awaiting approval — call run_skill_script again.",
            };
          }
        }
        if (outcome.ok) {
          const suffix = outcome.result.truncated ? " [output truncated]" : "";
          return {
            success: true,
            observation:
              `<untrusted_skill_content>${escapeUntrustedWrappers(outcome.result.output)}` +
              `</untrusted_skill_content>${suffix}`,
          };
        }
        return { success: false, error: `run_skill_script failed: ${(outcome as { error: string }).error}` };
```

（import 补 `RunSkillScriptParams`。）工具 description 里追加一句授权语义（放 "You cannot supply code" 前）：`"Scripts from disk-based skills may pause for the user to approve the skill on an authorization card the first time. "`。JSON schema **不加**任何新参数。

删除文件底部 `RUN_SKILL_SCRIPT_TOOL` 默认实例（默认 deps 迁去 loop.ts）。

- [ ] **Step 5: 装配迁移**

`src/lib/agent/tools.ts`：删 `import { RUN_SKILL_SCRIPT_TOOL } …` 与 BUILT_IN_TOOLS 里的 `RUN_SKILL_SCRIPT_TOOL,` 行。

`src/lib/agent/loop.ts`：`loadToolsTool` 构建后、`localBridgeTools` 前加：

```ts
      // run_skill_script 需要 sessionId（skill-grant 授权卡走 panel-request）——
      // 与 mouse/keyboard 同模式 per-run 装配，不进 BUILT_IN_TOOLS 静态表。
      const runSkillScriptTool = buildRunSkillScriptTool({
        runInSandbox: (code, input) =>
          sendToOffscreen<string>({ type: "skill:run_script", code, input }),
        getSource: getActiveSkillSource,
        runOnDaemon: requestRunSkillScript,
        requestGrant: (p) => requestFromPanel(sessionId, "skill-grant", p),
      });
```

`fullToolList` 里 `extractRecordsTool,` 后加 `runSkillScriptTool,`。import 补：`buildRunSkillScriptTool`（`./tools/skill-script`）、`sendToOffscreen`（`@/background/offscreen-manager`）、`getActiveSkillSource`（`@/background/skill-source`）、`requestRunSkillScript`（`@/background/local-bridge`，并入既有 import）。

- [ ] **Step 6: 全量测试 + 修引用回归**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿。若既有测试（如 cross-layer 工具清单断言、tools.ts 相关）引用 `RUN_SKILL_SCRIPT_TOOL` 或断言 BUILT_IN_TOOLS 含 `run_skill_script`，改为对 `buildRunSkillScriptTool` 构建实例断言 / 从 loop 装配层断言——**语义不变，装配点搬家**。

- [ ] **Step 7: Commit**

```bash
git add src/lib/panel-request.ts src/lib/agent/tools/skill-script.ts src/lib/agent/tools.ts src/lib/agent/loop.ts src/lib/agent/tools/skill-script.test.ts
git commit -m "feat(agent): run_skill_script authorization flow — skill-grant panel-request + per-run assembly"
```

---

### Task 6: panel — SkillGrantCard + Chat 接线 + i18n

**Files:**
- Create: `src/sidepanel/components/SkillGrantCard.tsx`
- Test: `src/sidepanel/components/SkillGrantCard.test.tsx`
- Modify: `src/sidepanel/components/Chat.tsx`
- Modify: `src/lib/i18n/dictionaries/{en,zh-CN,zh-TW,ja,es-419,pt-BR}.ts`

**Interfaces:**
- Consumes: `SkillGrantRequest`（Task 5）；panel-request kind `"skill-grant"`（res 为 boolean——批准 true / 拒绝 false，都走 `{ok:true, data}`，与 handoff 卡「deny 也是正常应答」同语义）。

- [ ] **Step 1: 写失败测试**

沿用 `HandoffCard.test.tsx` 的测试风格（house afterEach(cleanup) + 语义化 query）：

```tsx
const PAYLOAD = {
  skillName: "fetch-report",
  description: "Fetches the weekly report",
  scripts: ["fetch.ts", "clean.ts"],
  network: ["api.example.com"],
  write: [],
};

it("renders name, description, scripts and declared domains", () => {
  render(<SkillGrantCard payload={PAYLOAD} onDecision={() => {}} />);
  expect(screen.getByText("fetch-report")).toBeTruthy();
  expect(screen.getByText("Fetches the weekly report")).toBeTruthy();
  expect(screen.getByText("fetch.ts")).toBeTruthy();
  expect(screen.getByText("api.example.com")).toBeTruthy();
});

it("shows displayName when present", () => { /* displayName: "周报抓取" 显示为标题 */ });

it("empty network shows the sandbox-blocked line; empty write hides the write block", () => { /* networkNone 文案出现 */ });

it("allow → onDecision(true), deny → onDecision(false)", async () => { /* userEvent 点两钮 */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/SkillGrantCard.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现组件**

```tsx
import { useT } from "@/lib/i18n";
import type { SkillGrantRequest } from "@/lib/agent/tools/skill-script";

interface Props {
  payload: SkillGrantRequest;
  onDecision: (approved: boolean) => void;
}

/**
 * skill 信封授权卡：首跑 ungranted 磁盘 skill 时展示 daemon 权威给出的能力信封
 * （可执行脚本 + 联网域名 + 工作区外写路径）原文，用户批准后该 skill 免卡直到
 * 信封变化。内容不经 LLM 转述。
 */
export function SkillGrantCard({ payload, onDecision }: Props) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning-line bg-warning-tint px-3 py-2.5 text-[12px] leading-[18px] text-warning">
      <div className="text-[13px] font-medium text-warning">{t("skillGrant.title")}</div>
      <div>
        <div className="font-medium text-warning">{payload.displayName ?? payload.skillName}</div>
        <div className="mt-0.5 text-warning/70">{payload.description}</div>
      </div>
      <div>
        <div className="text-warning/70">{t("skillGrant.scriptsLabel")}</div>
        <ul className="mt-1 flex flex-col gap-0.5">
          {payload.scripts.map((s) => (
            <li key={s} className="rounded border border-warning-line/50 bg-black/5 px-2 py-0.5 font-mono">
              {s}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <div className="text-warning/70">{t("skillGrant.networkLabel")}</div>
        {payload.network.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-0.5">
            {payload.network.map((d) => (
              <li key={d} className="rounded border border-warning-line/50 bg-black/5 px-2 py-0.5 font-mono">
                {d}
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-1 text-warning/70">{t("skillGrant.networkNone")}</div>
        )}
      </div>
      {payload.write.length > 0 && (
        <div>
          <div className="text-warning/70">{t("skillGrant.writeLabel")}</div>
          <ul className="mt-1 flex flex-col gap-0.5">
            {payload.write.map((w) => (
              <li key={w} className="rounded border border-warning-line/50 bg-black/5 px-2 py-0.5 font-mono">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="text-[12px] leading-relaxed text-warning/70">{t("skillGrant.disclosure")}</div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onDecision(true)}
          className="rounded border border-warning-line bg-warning-tint px-2.5 py-1 text-[11px] font-medium text-warning hover:bg-warning-line/30"
        >
          {t("skillGrant.allow")}
        </button>
        <button
          type="button"
          onClick={() => onDecision(false)}
          className="rounded border border-warning-line/50 bg-transparent px-2.5 py-1 text-[11px] text-warning/70 hover:text-warning"
        >
          {t("skillGrant.deny")}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Chat 接线**

`Chat.tsx` 的 `handoff-to-agent` 渲染块旁加：

```tsx
      {panelRequest?.kind === "skill-grant" && (
        <SkillGrantCard
          payload={panelRequest.payload as import("@/lib/agent/tools/skill-script").SkillGrantRequest}
          onDecision={(approved) => respondPanel(panelRequest.requestId, { ok: true, data: approved })}
        />
      )}
```

（import `SkillGrantCard`。）

- [ ] **Step 5: i18n 六语种**

每份字典加 `skillGrant` 段（与 `handoff` 段同级）：

`en.ts`:
```ts
  skillGrant: {
    title: "Allow this skill to run scripts on your computer?",
    scriptsLabel: "Scripts it can run",
    networkLabel: "Network access",
    networkNone: "None — network is blocked by the default sandbox",
    writeLabel: "Extra write locations (outside its workspace)",
    disclosure:
      "Scripts run with your user permissions inside a default sandbox: no network unless listed above, writes limited to the skill's workspace plus the listed paths, sensitive folders blocked from reading. Approval lasts until the skill's declarations change.",
    allow: "Allow",
    deny: "Deny",
  },
```

`zh-CN.ts`:
```ts
  skillGrant: {
    title: "允许该 skill 在你的电脑上运行脚本？",
    scriptsLabel: "可执行脚本",
    networkLabel: "网络访问",
    networkNone: "无——默认沙箱已断网",
    writeLabel: "工作区外额外写入路径",
    disclosure:
      "脚本将以你的本机权限在默认沙箱内运行：未列出的域名一律断网，写入仅限该 skill 的工作区与上列路径，敏感目录拒绝读取。批准后免再确认，直到该 skill 的声明发生变化。",
    allow: "允许",
    deny: "拒绝",
  },
```

`zh-TW.ts`:
```ts
  skillGrant: {
    title: "允許該 skill 在你的電腦上執行指令碼？",
    scriptsLabel: "可執行指令碼",
    networkLabel: "網路存取",
    networkNone: "無——預設沙箱已斷網",
    writeLabel: "工作區外額外寫入路徑",
    disclosure:
      "指令碼將以你的本機權限在預設沙箱內執行：未列出的網域一律斷網，寫入僅限該 skill 的工作區與上列路徑，敏感目錄拒絕讀取。核准後免再確認，直到該 skill 的宣告發生變化。",
    allow: "允許",
    deny: "拒絕",
  },
```

`ja.ts`:
```ts
  skillGrant: {
    title: "このスキルにお使いのパソコンでスクリプトの実行を許可しますか？",
    scriptsLabel: "実行可能なスクリプト",
    networkLabel: "ネットワークアクセス",
    networkNone: "なし——デフォルトのサンドボックスが通信を遮断します",
    writeLabel: "ワークスペース外の追加書き込み先",
    disclosure:
      "スクリプトはあなたのユーザー権限でデフォルトのサンドボックス内で実行されます。上記以外のドメインへの通信は遮断され、書き込みはこのスキルのワークスペースと記載のパスに限定され、機密フォルダの読み取りは拒否されます。承認はスキルの宣言が変わるまで有効です。",
    allow: "許可",
    deny: "拒否",
  },
```

`es-419.ts`:
```ts
  skillGrant: {
    title: "¿Permitir que esta skill ejecute scripts en tu computadora?",
    scriptsLabel: "Scripts que puede ejecutar",
    networkLabel: "Acceso a la red",
    networkNone: "Ninguno: el sandbox predeterminado bloquea la red",
    writeLabel: "Rutas de escritura adicionales (fuera de su espacio de trabajo)",
    disclosure:
      "Los scripts se ejecutan con tus permisos de usuario dentro de un sandbox predeterminado: sin red salvo los dominios listados, escritura limitada al espacio de trabajo de la skill y a las rutas listadas, y lectura bloqueada en carpetas sensibles. La aprobación dura hasta que cambien las declaraciones de la skill.",
    allow: "Permitir",
    deny: "Rechazar",
  },
```

`pt-BR.ts`:
```ts
  skillGrant: {
    title: "Permitir que esta skill execute scripts no seu computador?",
    scriptsLabel: "Scripts que ela pode executar",
    networkLabel: "Acesso à rede",
    networkNone: "Nenhum — a sandbox padrão bloqueia a rede",
    writeLabel: "Locais extras de escrita (fora do espaço de trabalho dela)",
    disclosure:
      "Os scripts rodam com as suas permissões de usuário dentro de uma sandbox padrão: sem rede além dos domínios listados, escrita limitada ao espaço de trabalho da skill e aos caminhos listados, e leitura bloqueada em pastas sensíveis. A aprovação vale até as declarações da skill mudarem.",
    allow: "Permitir",
    deny: "Recusar",
  },
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿（字典 parity 由 typecheck 强制）

- [ ] **Step 7: Commit**

```bash
git add src/sidepanel/components/SkillGrantCard.tsx src/sidepanel/components/SkillGrantCard.test.tsx src/sidepanel/components/Chat.tsx src/lib/i18n/dictionaries/
git commit -m "feat(panel): SkillGrantCard — envelope authorization card wired into chat"
```

---

### Task 7: 设置页 — grants 列表/撤销 + 最近脚本执行

**Files:**
- Modify: `src/background/index.ts`（三个 `chrome.runtime.sendMessage` handler）
- Modify: `src/sidepanel/components/Settings.tsx`（`LocalBridgeSection` 内两个区块）
- Modify: `src/lib/i18n/dictionaries/{en,zh-CN,zh-TW,ja,es-419,pt-BR}.ts`
- Test: `src/sidepanel/components/Settings.localbridge.test.tsx`（新建；若仓库已有 Settings 测试文件则并入）

**Interfaces:**
- Consumes: `requestListGrants` / `requestRevokeGrant`（既有）、`requestListAudit`（Task 4）、`bridgeHasSkillFs`（既有）。
- SW 消息协议（panel→SW，沿 `local-agents:list` 模式）：
  - `{type:"local-grants:list"}` → `{grants: GrantRecord[]}`
  - `{type:"local-grants:revoke", key: string}` → `{ok: boolean}`
  - `{type:"local-audit:list"}` → `{entries: AuditEntry[]}`

- [ ] **Step 1: SW handlers（`src/background/index.ts`）**

`local-agents:toggle` handler 后追加（import 补 `bridgeHasSkillFs`、`requestListGrants`、`requestRevokeGrant`、`requestListAudit`，并入既有 local-bridge import）：

```ts
  if (message?.type === "local-grants:list") {
    (async () => {
      if (!bridgeHasSkillFs()) return { grants: [] };
      const { grants } = await requestListGrants();
      return { grants };
    })()
      .then(sendResponse)
      .catch(() => sendResponse({ grants: [] }));
    return true; // async response
  }
  if (message?.type === "local-grants:revoke") {
    (async () => {
      if (!bridgeHasSkillFs() || typeof message.key !== "string") return { ok: false };
      const { revoked } = await requestRevokeGrant({ key: message.key });
      return { ok: revoked };
    })()
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true; // async response
  }
  if (message?.type === "local-audit:list") {
    (async () => {
      if (!bridgeHasSkillFs()) return { entries: [] };
      const { entries } = await requestListAudit({ limit: 20 });
      return { entries };
    })()
      .then(sendResponse)
      .catch(() => sendResponse({ entries: [] })); // 旧 daemon unknown_method → 空列表
    return true; // async response
  }
```

- [ ] **Step 2: 写失败测试**

组件级测试（mock `chrome.runtime.sendMessage` 按 type 分发返回）：

```tsx
it("renders granted skills with envelope summary and revoke button", async () => {
  // sendMessage mock: local-grants:list → { grants: [GRANT] }，local-audit:list → { entries: [] }
  // GRANT = { key:"skill:s:abc", skillName:"fetch-report", envelope:{allowedDomains:["api.example.com"], extraWrites:[], runnableScripts:["fetch.ts"]}, grantedAt: 1700000000000 }
  render(<LocalBridgeSection />); // 需要 export LocalBridgeSection 或经 Settings 渲染
  expect(await screen.findByText("fetch-report")).toBeTruthy();
  expect(screen.getByText(/api\.example\.com/)).toBeTruthy();
});

it("revoke sends local-grants:revoke with the grant key and refreshes the list", async () => { /* 点撤销 → sendMessage 断言 → 列表清空 */ });

it("renders recent runs from local-audit:list", async () => { /* entries 一条 → skill 名 + entry + exit 呈现 */ });
```

（`LocalBridgeSection` 目前是文件内私有函数——测试需要它可渲染：`export function LocalBridgeSection` 即可，App 结构不动。）

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/Settings.localbridge.test.tsx`
Expected: FAIL

- [ ] **Step 4: 实现 `LocalBridgeSection` 两区块**

`Settings.tsx` 顶部补类型 import：`import type { GrantRecord, AuditEntry } from "@/types/local-bridge";`

查询函数（`queryLocalAgents` 旁）：

```ts
function queryGrants(cb: (grants: GrantRecord[]) => void): void {
  try {
    chrome.runtime.sendMessage({ type: "local-grants:list" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && Array.isArray(res.grants)) cb(res.grants as GrantRecord[]);
    });
  } catch {
    /* noop */
  }
}

function queryAudit(cb: (entries: AuditEntry[]) => void): void {
  try {
    chrome.runtime.sendMessage({ type: "local-audit:list" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && Array.isArray(res.entries)) cb(res.entries as AuditEntry[]);
    });
  } catch {
    /* noop */
  }
}
```

`LocalBridgeSection` 内加状态与副作用（与 agents 同节奏：`status?.ready` 变化时一次性查询，无轮询）：

```ts
  const [grants, setGrants] = useState<GrantRecord[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditOpen, setAuditOpen] = useState(false);

  useEffect(() => {
    if (status?.ready) {
      queryGrants(setGrants);
      queryAudit(setAudit);
    } else {
      setGrants([]);
      setAudit([]);
    }
  }, [status?.ready]);

  const onRevoke = (key: string) => {
    try {
      chrome.runtime.sendMessage({ type: "local-grants:revoke", key }, (res) => {
        if (chrome.runtime.lastError) return;
        if (res?.ok) queryGrants(setGrants);
      });
    } catch {
      /* noop */
    }
  };
```

JSX：agents 区块（`</div>` 关闭 `agents.length > 0` 那块）之后加：

```tsx
        {status?.ready && grants.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <div className="text-[12px] font-medium text-fg-2">{t("settings.localBridge.grantsTitle")}</div>
            {grants.map((g) => (
              <div key={g.key} className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[13px] text-fg-1">{g.skillName}</span>
                  <span className="text-[11px] text-fg-3">
                    {g.envelope.runnableScripts.join(", ")}
                    {g.envelope.allowedDomains.length > 0 && ` · ${g.envelope.allowedDomains.join(", ")}`}
                    {g.envelope.extraWrites.length > 0 && ` · ${g.envelope.extraWrites.join(", ")}`}
                  </span>
                  <span className="text-[11px] text-fg-3">
                    {new Date(g.grantedAt).toLocaleDateString()}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onRevoke(g.key)}
                  className="shrink-0 rounded border border-line px-2 py-0.5 text-[11px] text-fg-2 hover:text-fg-1"
                >
                  {t("settings.localBridge.revoke")}
                </button>
              </div>
            ))}
          </div>
        )}
        {status?.ready && audit.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <button
              type="button"
              onClick={() => setAuditOpen((v) => !v)}
              className="self-start text-[12px] font-medium text-fg-2 hover:text-fg-1"
            >
              {t("settings.localBridge.auditTitle")} {auditOpen ? "▾" : "▸"}
            </button>
            {auditOpen &&
              audit.map((e, i) => (
                <div key={`${e.ts}-${i}`} className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="truncate text-fg-1">
                    {e.skillName} · {e.entry}
                  </span>
                  <span className="shrink-0 text-fg-3">
                    {e.exitCode === 0 && !e.timedOut
                      ? t("settings.localBridge.auditOk")
                      : t("settings.localBridge.auditFailed")}
                    {" · "}
                    {new Date(e.ts).toLocaleString()}
                  </span>
                </div>
              ))}
          </div>
        )}
```

- [ ] **Step 5: i18n 六语种**

`settings.localBridge` 段各加 5 key：

| key | en | zh-CN | zh-TW | ja | es-419 | pt-BR |
|---|---|---|---|---|---|---|
| grantsTitle | Authorized skills | 已授权 skill | 已授權 skill | 承認済みスキル | Skills autorizadas | Skills autorizadas |
| revoke | Revoke | 撤销 | 撤銷 | 取り消す | Revocar | Revogar |
| auditTitle | Recent script runs | 最近脚本执行 | 最近指令碼執行 | 最近のスクリプト実行 | Ejecuciones recientes de scripts | Execuções recentes de scripts |
| auditOk | ok | 成功 | 成功 | 成功 | ok | ok |
| auditFailed | failed | 失败 | 失敗 | 失敗 | falló | falhou |

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add src/background/index.ts src/sidepanel/components/Settings.tsx src/sidepanel/components/Settings.localbridge.test.tsx src/lib/i18n/dictionaries/
git commit -m "feat(settings): grants list/revoke + recent script runs in local-bridge section"
```

---

### Task 8: 扩展 — 桥断开自动重连（退避）

**Files:**
- Modify: `src/background/local-bridge.ts`
- Modify: `src/background/index.ts`（注入重连动作，1 行 + import）
- Test: `src/background/local-bridge.test.ts`

**Interfaces:**
- Produces: `setBridgeReconnectAction(fn: () => void): void`（index.ts 注入 `() => void initBridgeAndMigrate()`——动作注入避免 local-bridge → skill-migration 反向依赖）。
- 行为：SW 存活期内桥**意外**断开（daemon 重启/热替换/崩溃）→ 按 `1s, 2s, 5s, 15s, 30s`（封顶 30s）重试；握手成功归零计数；用户显式关闭（`disconnectLocalBridge`）不重试；SW 被回收则计时器自然消失，下次唤醒由 startup 的 `initBridgeAndMigrate` 兜底。重连成功自动重跑幂等迁移（`initBridgeAndMigrate` 全包）。

- [ ] **Step 1: 写失败测试**

`local-bridge.test.ts`（`vi.useFakeTimers()`；沿用既有 fake connectNative 夹具，可数 connect 调用次数）：

```ts
describe("auto-reconnect", () => {
  it("unexpected disconnect schedules reconnect action with backoff", async () => {
    const action = vi.fn();
    setBridgeReconnectAction(action);
    initLocalBridge();
    fakePort.fireDisconnect();
    await vi.advanceTimersByTimeAsync(999);
    expect(action).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("consecutive failures walk the delay ladder and cap at 30s", async () => { /* 断→1s→断→2s→…→30s→30s */ });

  it("successful handshake resets the ladder", async () => { /* 成功后再断 → 又从 1s 起 */ });

  it("disconnectLocalBridge (user off) suppresses reconnect and clears pending timer", async () => {
    /* fireDisconnect 排了 timer → disconnectLocalBridge() → advance 60s → action 未被调 */
    /* 以及：先 disconnectLocalBridge 再无重连 */
  });

  it("maybeInitLocalBridge clears the user-disabled flag", async () => { /* 关→重开→断→重连恢复 */ });
});
```

（`__resetPanelRequestState` 同风格：加 test-only `__resetBridgeReconnectState()` 清 timer/attempt/flag/action。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/background/local-bridge.test.ts`
Expected: FAIL（`setBridgeReconnectAction` 不存在）

- [ ] **Step 3: 实现**

`local-bridge.ts` 模块级加：

```ts
// ── 自动重连（退避）──────────────────────────────────────────────────
// SW 存活期内桥意外断开（daemon 重启/热替换/崩溃）→ 按退避序列重试；用户显式
// 关闭不重试。SW 被回收则计时器自然消失，下次唤醒由 startup 兜底。真机案例：
// Slice 2 验收期 daemon 重启后 UI 掉回 IDB 模式直到手动刷新扩展。
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000];
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let userDisabled = false;
let reconnectAction: (() => void) | null = null;

/** index.ts 注入重连动作（initBridgeAndMigrate）——动作注入避免反向依赖 skill-migration。 */
export function setBridgeReconnectAction(fn: () => void): void {
  reconnectAction = fn;
}

/** Test-only：清重连状态。 */
export function __resetBridgeReconnectState(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempt = 0;
  userDisabled = false;
  reconnectAction = null;
}

function scheduleReconnect(): void {
  if (userDisabled || !reconnectAction || reconnectTimer) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAction?.();
  }, delay);
}
```

挂接点（三处小改）：

1. `onDisconnect` listener 末尾（`pending.clear()` 后）：把 `// ponytail: Slice 0 不做指数退避重连…` 注释替换为 `scheduleReconnect();`
2. 握手成功分支（`ready = true;` 后）加 `reconnectAttempt = 0;`
3. `maybeInitLocalBridge` 函数体开头加 `userDisabled = false;`；`disconnectLocalBridge` 开头加：

```ts
  userDisabled = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
```

`src/background/index.ts`：`void initBridgeAndMigrate();`（约 line 231）前加：

```ts
setBridgeReconnectAction(() => void initBridgeAndMigrate());
```

（import 并入既有 local-bridge import。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/background/local-bridge.test.ts && pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/background/local-bridge.ts src/background/index.ts src/background/local-bridge.test.ts
git commit -m "feat(bridge): auto-reconnect with backoff on unexpected disconnect"
```

---

### Task 9: 收尾 — CLAUDE.md invariant 增补 + 全门禁

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/ROADMAP.md`（若该文件按 slice 记账——按现状格式追加一行 Slice 3 已交付；无对应段落则跳过）

- [ ] **Step 1: CLAUDE.md**

`src/lib/skills/` 条目中「特权脚本（fs/network）待 Slice 2b daemon 路径」若仍存在（Slice 1+2 合并时可能已改），更新为现实：磁盘 skill 特权脚本经 daemon srt 沙箱执行，首跑弹信封授权卡（panel-request `skill-grant`），grant 按能力信封记于 daemon `~/.pie/grants.json`，设置页可撤销。另在 Architecture Invariants 的 per-session/桥相关段落补一句：桥意外断开 SW 存活期内自动退避重连（1s→30s 封顶），用户关闭开关不重连。

- [ ] **Step 2: 全门禁**

Run: `pnpm test && pnpm typecheck && pnpm build && cd daemon && bun test`
Expected: 全部通过（build 含 tool-names/R-iframe-1 build-time invariant——run_skill_script 移出 BUILT_IN_TOOLS 后仍必须在 TOOL_GROUPS/分类表里，缺了 build 会 throw，此处是最终防线）

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/ROADMAP.md
git commit -m "docs: skill grant card + bridge auto-reconnect invariants"
```

---

## 真机验收清单（merge 前）

部署：`pnpm build` → 产物复制到主目录 `dist/`（`rm -rf /Users/wenkang/repos/pie/pie-ai-agent/dist && cp -R dist /Users/wenkang/repos/pie/pie-ai-agent/dist`）→ chrome://extensions 刷新；daemon：`cd daemon && bun run compile` → `rm ~/.pie/bin/pie && cp dist/pie ~/.pie/bin/pie && launchctl kickstart -k gui/$(id -u)/ai.wiseria.pie`。

**A. 授权卡**
- A1 新建磁盘 skill（含 `scripts/hello.ts`，无声明）→ 让 Pie 跑它 → 弹卡：脚本清单含 hello.ts、网络显示「默认沙箱已断网」、无写路径块 → 批准 → 脚本跑通，`~/.pie/grants.json` 出现该 skill 的信封 grant。
- A2 再跑同 skill → 不弹卡（免卡直到信封变）。
- A3 拒绝路径：撤销 grant 后再跑 → 弹卡 → 点拒绝 → 对话收到「User declined」，无 grant 写入。
- A4 信封重弹：给 SKILL.md 加 `metadata.pie.network: [api.github.com]` → 再跑 → 重新弹卡且卡上显示 api.github.com。
- A5 域名归一化：声明写成 `https://api.github.com/v2` → 卡上显示裸 `api.github.com`，srt 放行该域名（脚本内 fetch api.github.com 成功、fetch 其他域名失败）。
- A6 panel 关闭时首跑 ungranted skill（schedule 头less 或关侧栏）→ 明确报错不挂死。

**B. 设置页**
- B1 「本地打通」出现「已授权 skill」区：A1 的 grant 可见（脚本/域名摘要 + 日期）。
- B2 点「撤销」→ 行消失，`grants.json` 对应键删除；再跑该 skill 重新弹卡。
- B3 「最近脚本执行」折叠区：展开可见 A 步骤产生的执行记录（skill/entry/成败/时间）。
- B4 旧 daemon（若手头有 Slice 2 版二进制）：设置页不炸，audit 区静默为空。

**C. 自动重连**
- C1 桥已连 → `launchctl kickstart -k` 重启 daemon → 不动扩展，数秒内设置页状态自动回到「已连接」；skill 列表仍是磁盘模式（不掉 IDB）。
- C2 kill daemon 且不让 launchd 拉起（`launchctl bootout` 临时卸载）→ 状态显示未连接，扩展不炸；恢复 daemon（bootstrap 回来）→ ≤30s 自动重连。
- C3 设置页关掉「本地打通」开关 → 不再重连（状态稳定为关闭）；重新打开 → 正常连接 + 幂等迁移不重复落盘。

**D. 回归**
- D1 IDB 模式（daemon 关）：跑 2a 纯计算脚本 skill 照常（授权流不影响 MV3 sandbox 路径）。
- D2 handoff / run_local_agent 卡照常（panel-request 通道无回归）。
