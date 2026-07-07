import { test, expect } from "bun:test";
import { handleMessage, processSocketChunk } from "../src/daemon";
import { PROTOCOL_VERSION } from "../../src/types/local-bridge";
import { setLogEnabled } from "../src/log";

setLogEnabled(false); // hermetic：不让 handleMessage 的 log 写真实 ~/.pie/logs

test("hello returns protocolVersion + capabilities", async () => {
  const out = await handleMessage(
    JSON.stringify({ id: "1", method: "hello", params: { protocolVersion: PROTOCOL_VERSION } }),
  );
  const res = JSON.parse(out);
  expect(res.id).toBe("1");
  expect(res.ok).toBe(true);
  expect(res.result.protocolVersion).toBe(PROTOCOL_VERSION);
  expect(res.result.capabilities).toContain("run_local_agent");
  expect(res.result.capabilities).toContain("handoff_to_agent");
});

test("unknown method returns structured error", async () => {
  const out = await handleMessage(JSON.stringify({ id: "2", method: "nope", params: {} }));
  const res = JSON.parse(out);
  expect(res.ok).toBe(false);
  expect(res.error.code).toBe("unknown_method");
});

// Finding 2: Unix STREAM socket doesn't preserve message boundaries — a
// request's JSON can be split across two `data` events. Without per-connection
// carry buffering, each half-line fails JSON.parse independently and the
// caller's request never resolves. processSocketChunk is the pure, testable
// core of the socket `data` handler wired in startDaemon().
test("processSocketChunk: a line split across two chunks dispatches exactly once, after reassembly", async () => {
  const written: string[] = [];
  let carry = "";

  // First chunk: request JSON cut mid-method-name, no trailing newline yet —
  // must NOT dispatch anything.
  const r1 = processSocketChunk(carry, '{"id":"x","method":"hel', (out) => written.push(out));
  carry = r1.carry;
  await r1.pending;
  expect(written).toHaveLength(0);
  expect(carry).toBe('{"id":"x","method":"hel');

  // Second chunk completes the line — now it must dispatch exactly once, and
  // handleMessage must see the fully reassembled JSON (a valid `hello`).
  const r2 = processSocketChunk(carry, 'lo","params":{"protocolVersion":1}}\n', (out) => written.push(out));
  carry = r2.carry;
  await r2.pending;

  expect(carry).toBe("");
  expect(written).toHaveLength(1);
  const res = JSON.parse(written[0]);
  expect(res.id).toBe("x");
  expect(res.ok).toBe(true);
  expect(res.result.protocolVersion).toBe(PROTOCOL_VERSION);
});

test("processSocketChunk: two complete lines in one chunk both dispatch, in order", async () => {
  const written: string[] = [];
  const chunk = '{"id":"a","method":"hello","params":{}}\n{"id":"b","method":"nope","params":{}}\n';
  const { carry, pending } = processSocketChunk("", chunk, (out) => written.push(out));
  await pending;
  expect(carry).toBe("");
  expect(written).toHaveLength(2);
  expect(JSON.parse(written[0]).id).toBe("a");
  expect(JSON.parse(written[1]).id).toBe("b");
});

test("processSocketChunk: independent carry state per connection (no cross-talk)", async () => {
  const writtenA: string[] = [];
  const writtenB: string[] = [];

  // Connection A sends a partial line...
  const a1 = processSocketChunk("", '{"id":"conn-a","method":"hel', (out) => writtenA.push(out));
  await a1.pending;
  // ...while connection B, with its own independent carry, sends a totally
  // different partial line. Passing "" (B's own fresh carry) proves the two
  // don't share state — a shared/global carry would corrupt one with the other.
  const b1 = processSocketChunk("", '{"id":"conn-b","method":"wor', (out) => writtenB.push(out));
  await b1.pending;

  expect(writtenA).toHaveLength(0);
  expect(writtenB).toHaveLength(0);

  const a2 = processSocketChunk(a1.carry, 'lo","params":{"protocolVersion":1}}\n', (out) => writtenA.push(out));
  await a2.pending;
  const b2 = processSocketChunk(b1.carry, 'ld","params":{}}\n', (out) => writtenB.push(out));
  await b2.pending;

  expect(writtenA).toHaveLength(1);
  expect(JSON.parse(writtenA[0]).id).toBe("conn-a");
  expect(writtenB).toHaveLength(1);
  expect(JSON.parse(writtenB[0]).id).toBe("conn-b");
});

test("hello advertises list_agents capability", async () => {
  const out = JSON.parse(
    await handleMessage(
      JSON.stringify({ id: "la0", method: "hello", params: { protocolVersion: PROTOCOL_VERSION } }),
    ),
  );
  expect(out.result.capabilities).toContain("list_agents");
});

test("list_agents returns ALL candidates with installed flag (shape only — detection machine-dependent)", async () => {
  const out = JSON.parse(
    await handleMessage(JSON.stringify({ id: "la1", method: "list_agents", params: {} })),
  );
  expect(out.ok).toBe(true);
  // 全部候选恒定返回（未安装的也在，settings 页靠它渲染"未安装"态）
  expect(out.result.agents.map((a: { id: string }) => a.id)).toEqual([
    "claude-app",
    "claude-terminal",
    "codex-terminal",
  ]);
  for (const a of out.result.agents) {
    expect(typeof a.label).toBe("string");
    expect(typeof a.installed).toBe("boolean");
  }
});
