// PR #314（feat #296 skill 脚本 I/O 契约收口）真机验收 — daemon-direct + functional 批。
// 环境搭建/配方坑见 docs/agents/auto-acceptance.md；断言规格见验收断言设计（issue/PR 交接文档）。
//
// ⚠️ 前置顺序（主控负责，本脚本不启动 daemon）：
//   1. node eval/acceptance/pilot-314-fixtures.mjs   ← daemon 启动前跑（造 skill/dist/孤儿 session）
//   2. 主控启动 scratch daemon：HOME=$PIE_ACCEPT_BASE/home bun daemon/src/cli.ts daemon
//      —— GC（sweepSessions）只在 startDaemon 时跑一次；fixtures 里 mtime 拨回 31 天的
//         孤儿 session 目录应在这一步被清掉。本脚本的 item7b 只做事后检查。
//   3. node eval/acceptance/pilot-314-functional.mjs ← 本脚本
//
// 批次结构：
//   Section A（daemon-direct）：node 直连 $PIE_ACCEPT_BASE/home/.pie/daemon.sock（NDJSON RPC，
//     无 Chrome）。覆盖：7b GC → 8 前半（grant_required）→ 1 stdout/env → 2 outputs+read 回
//     → 2b 封顶 50 → 3 前半（noop 零产物）→ 4 副根零写入 → 5 双 session 隔离 → 6 读回守卫
//     → delete RPC 幂等 → list_skills 规模冒烟（>8KB）。
//   Section B（functional，Playwright + dist-pilot，无 LLM）：7a 归档/硬删 → workspace 消失
//     + SkillsList 32 规模档滚动可见。
//   （item 3 后半 observation 文案与 item 8 HITL 授权卡属 llm 批，不在本脚本。）
//
// 证据优先级：磁盘 > RPC 响应 > DOM；每条记录带现场值。
import { chromium } from 'playwright';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE = process.env.PIE_ACCEPT_BASE;
if (!BASE) throw new Error('PIE_ACCEPT_BASE 未设置（隔离工作目录，见 docs/agents/auto-acceptance.md）');
const HOME = `${BASE}/home`;
const SOCK = `${HOME}/.pie/daemon.sock`;
const SESSIONS = `${HOME}/.pie/sessions`;
const REPORT = `${BASE}/report`;
fs.mkdirSync(REPORT, { recursive: true });

const fixtures = JSON.parse(fs.readFileSync(`${BASE}/fixtures.json`, 'utf8'));
const runStart = Date.now(); // audit 断言只认本次运行之后的行（防重跑读到上一轮残留）

const results = [];
let shot = 0;
function record(item, status, note = '') {
  results.push({ item, status, note });
  console.log(`[${status}] ${item}${note ? ' — ' + note : ''}`);
}
async function snap(page, name) {
  shot += 1;
  try {
    await page.screenshot({ path: `${REPORT}/${String(shot).padStart(2, '0')}-${name}.png` });
  } catch { /* 截图失败不影响断言 */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// macOS /tmp → /private/tmp symlink：python os.getcwd() 回 real path，env 传的是逻辑路径。
const normPath = (p) => (typeof p === 'string' ? p.replace(/^\/private\//, '/') : p);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ── daemon socket 直连 RPC（NDJSON：{id,method,params}\n ⇄ {id,ok,...}\n）────────────
function daemonRpc(method, params, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const id = `acc314-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sock = net.createConnection({ path: SOCK });
    let carry = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`rpc ${method} timeout after ${timeoutMs}ms`)); }, timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ id, method, params }) + '\n'));
    sock.on('data', (d) => {
      carry += d.toString();
      const lines = carry.split('\n');
      carry = lines.pop();
      for (const line of lines.filter(Boolean)) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === id) { clearTimeout(timer); sock.end(); resolve(msg); }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// grant 二段式（socket 层 = SW 面板流的下层等价物；LLM 不可自批的 schema 防线在扩展侧，由 llm 批覆盖）：
// 首调无 grant → needs_authorization + data.envelopeHash → 带 grantApproved+approvedEnvelopeHash 重调。
async function runScriptGranted(name, entry, args, sessionId) {
  const params = { name, entry, args, sessionId };
  let resp = await daemonRpc('run_skill_script', params);
  if (!resp.ok && resp.error?.code === 'needs_authorization') {
    const hash = resp.error.data?.envelopeHash;
    resp = await daemonRpc('run_skill_script', { ...params, grantApproved: true, approvedEnvelopeHash: hash });
  }
  return resp;
}

function readAudit() {
  try {
    return fs.readFileSync(`${HOME}/.pie/logs/audit.jsonl`, 'utf8')
      .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// 副根整树快照：相对路径 + （文件）size/mtime/sha256 + （目录）mtime。零写入断言 = 前后逐字节相同。
function snapshotTree(root) {
  const entries = [];
  const walk = (dir, rel) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (e.isDirectory()) {
        entries.push({ path: r + '/', mtimeMs: st.mtimeMs });
        walk(abs, r);
      } else {
        entries.push({ path: r, size: st.size, mtimeMs: st.mtimeMs, sha256: sha256(fs.readFileSync(abs)) });
      }
    }
  };
  walk(root, '');
  return JSON.stringify(entries);
}

const wsDir = (sid) => `${SESSIONS}/${sid}/workspace`;

// 本批自己的 session id（daemon 侧 assertSessionId 只认标准 UUID 形状）
const sessA = crypto.randomUUID();
const sessB = crypto.randomUUID();
const sessC = crypto.randomUUID(); // 副根 agents-probe 专用
const sessD = crypto.randomUUID(); // --many 封顶 + delete RPC 幂等专用

// ═══════════════════════ Section A：daemon-direct ═══════════════════════

// ── A0 sanity：daemon.sock 已在（主控已启动 daemon）─────────────────────────────
if (!fs.existsSync(SOCK)) {
  record('a0-daemon-sock', 'ERROR', `daemon.sock 不存在（${SOCK}）——主控须先启动 scratch daemon`);
  fs.writeFileSync(`${REPORT}/results-functional.json`, JSON.stringify(results, null, 2));
  process.exit(1);
}

// ── item7b：启动 GC — 孤儿 session（mtime 31 天前，fixtures 在 daemon 启动前落盘）
//    应已被 startDaemon → sweepSessions() 删除；新鲜对照组必须存活。
try {
  const { uuidOld, uuidFresh } = fixtures.gc;
  const oldGone = !fs.existsSync(`${SESSIONS}/${uuidOld}`);
  const freshAlive = fs.existsSync(`${SESSIONS}/${uuidFresh}/workspace/fresh.txt`);
  let gcLogged = false;
  try {
    gcLogged = fs.readFileSync(`${HOME}/.pie/logs/daemon.log`, 'utf8').includes('"event":"sessions.gc"');
  } catch { /* 日志缺失只降级辅证 */ }
  record('item7b-startup-gc', oldGone && freshAlive ? 'PASS' : 'FAIL',
    `孤儿 ${uuidOld} 已删=${oldGone} · 新鲜 ${uuidFresh} 存活=${freshAlive} · daemon.log sessions.gc=${gcLogged}（辅证）`);
} catch (e) { record('item7b-startup-gc', 'ERROR', e.message); }

// ── item8 前半（daemon-direct 半断言）：全新 grants 下裸调 → grant_required 语义 ──
//    首个 run_skill_script 不带 grantApproved：必须回 needs_authorization + envelope/envelopeHash。
//    （授权卡 UI 照常弹 + 已有 grant 不失效属 llm/HITL 批。）
let firstRunResp = null; // 留给 item1 复用（授权后的成功响应）
try {
  const bare = await daemonRpc('run_skill_script', { name: 'io-probe', entry: 'print.py', args: ['hello'], sessionId: sessA });
  const isAuthReq = !bare.ok && bare.error?.code === 'needs_authorization';
  const hash = bare.error?.data?.envelopeHash;
  const hasEnvelope = !!bare.error?.data?.envelope && typeof hash === 'string' && hash.length > 0;
  if (isAuthReq && hasEnvelope) {
    firstRunResp = await daemonRpc('run_skill_script', {
      name: 'io-probe', entry: 'print.py', args: ['hello'], sessionId: sessA,
      grantApproved: true, approvedEnvelopeHash: hash,
    });
    record('item8-grant-required-precheck', 'PASS',
      `裸调回 needs_authorization + envelopeHash=${hash} · 带 approvedEnvelopeHash 重调 ok=${firstRunResp.ok}`);
  } else {
    record('item8-grant-required-precheck', 'FAIL',
      `期望 needs_authorization+envelope，实得 ${JSON.stringify(bare).slice(0, 300)}`);
    firstRunResp = bare.ok ? bare : await runScriptGranted('io-probe', 'print.py', ['hello'], sessA);
  }
} catch (e) { record('item8-grant-required-precheck', 'ERROR', e.message); }

// ── item1：print 型脚本 → stdout 回传 + cwd/PIE_WORKSPACE/PIE_SKILL_DIR 契约 ─────
//    main 对照点：main 上 cwd=skillDir、无 env 注入、无 sessions/ 目录 → 三断言必 FAIL。
try {
  const resp = firstRunResp ?? await runScriptGranted('io-probe', 'print.py', ['hello'], sessA);
  if (!resp.ok) throw new Error(`run_skill_script failed: ${JSON.stringify(resp.error).slice(0, 300)}`);
  const facts = JSON.parse(resp.result.output.trim());
  const expectWs = wsDir(sessA);
  const cwdOk = normPath(facts.cwd) === normPath(expectWs);
  const wsOk = normPath(facts.ws) === normPath(expectWs);
  const skillDirOk = normPath(facts.skillDir) === normPath(`${HOME}/.pie/skills/io-probe`);
  const argvOk = JSON.stringify(facts.argv) === JSON.stringify(['hello']);
  const wsExists = fs.existsSync(expectWs);
  const auditHit = readAudit().some((a) => a.ts >= runStart && a.skillName === 'io-probe' && a.entry === 'print.py' && a.exitCode === 0);
  const grantsHit = fs.readFileSync(`${HOME}/.pie/grants.json`, 'utf8').includes('io-probe');
  const ok = cwdOk && wsOk && skillDirOk && argvOk && wsExists && auditHit && grantsHit;
  record('item1-print-stdout-env', ok ? 'PASS' : 'FAIL',
    `cwd=${facts.cwd}(ok=${cwdOk}) ws ok=${wsOk} skillDir=${facts.skillDir}(ok=${skillDirOk}) argv ok=${argvOk} ` +
    `· workspace 目录在=${wsExists} · audit 追加=${auditHit} · grants.json 含 io-probe=${grantsHit}`);
} catch (e) { record('item1-print-stdout-env', 'ERROR', e.message); }

// ── item2：写文件型 → outputs 清单（相对路径+精确 bytes）+ read_session_file 读回 ──
//    main 对照点：main 无 outputs 字段、read_session_file 是 unknown_method、sessions/ 不存在。
try {
  const PAYLOAD = 'PAYLOAD-A'; // 9 bytes
  const resp = await runScriptGranted('io-probe', 'write.sh', [PAYLOAD], sessA);
  if (!resp.ok) throw new Error(`write.sh failed: ${JSON.stringify(resp.error).slice(0, 300)}`);
  const outputs = resp.result.outputs ?? [];
  const csv = outputs.find((o) => o.path === 'out.csv');
  const rawJson = outputs.find((o) => o.path === 'sub/raw.json');
  const csvOk = !!csv && csv.bytes === 9;
  const subOk = !!rawJson && rawJson.bytes === 7; // '{"k":1}'
  const notTruncated = resp.result.outputsTruncated !== true;
  const diskContent = fs.readFileSync(`${wsDir(sessA)}/out.csv`, 'utf8');
  const diskOk = diskContent === PAYLOAD && sha256(diskContent) === sha256(PAYLOAD);
  const rd = await daemonRpc('read_session_file', { sessionId: sessA, path: 'out.csv' });
  const readbackOk = rd.ok && rd.result.content === PAYLOAD;
  const ok = csvOk && subOk && notTruncated && diskOk && readbackOk;
  record('item2-outputs-and-readback', ok ? 'PASS' : 'FAIL',
    `outputs=${JSON.stringify(outputs)} csvOk=${csvOk} subOk=${subOk} 无截断=${notTruncated} ` +
    `· 磁盘内容一致=${diskOk} · read_session_file 读回一致=${readbackOk}`);
} catch (e) { record('item2-outputs-and-readback', 'ERROR', e.message); }

// ── item2b：产物封顶 — 一次写 60 个文件 → outputs 恰 50 条 + outputsTruncated=true ──
try {
  const resp = await runScriptGranted('io-probe', 'write.sh', ['--many', '60'], sessD);
  if (!resp.ok) throw new Error(`write.sh --many failed: ${JSON.stringify(resp.error).slice(0, 300)}`);
  const n = (resp.result.outputs ?? []).length;
  const trunc = resp.result.outputsTruncated === true;
  const diskCount = fs.readdirSync(`${wsDir(sessD)}/many`).length;
  record('item2b-outputs-cap-50', n === 50 && trunc && diskCount === 60 ? 'PASS' : 'FAIL',
    `outputs.length=${n}（期望 50） outputsTruncated=${trunc} · 磁盘实际文件数=${diskCount}（期望 60）`);
} catch (e) { record('item2b-outputs-cap-50', 'ERROR', e.message); }

// ── item3 前半（daemon-direct 半断言）：静默型 → exit 0、零 stdout、outputs 整字段省略 ──
//    （observation 可行动提示文案在扩展侧组装，属 llm 批；这里钉死 daemon 侧输入形态。）
try {
  const resp = await runScriptGranted('io-probe', 'noop.sh', [], sessA);
  if (!resp.ok) throw new Error(`noop.sh failed: ${JSON.stringify(resp.error).slice(0, 300)}`);
  const emptyStdout = resp.result.output.trim() === '';
  const noOutputs = !('outputs' in resp.result);
  record('item3-noop-precheck', emptyStdout && noOutputs ? 'PASS' : 'FAIL',
    `stdout=""=${emptyStdout} · outputs 字段省略=${noOutputs}（result keys=${Object.keys(resp.result).join(',')}）`);
} catch (e) { record('item3-noop-precheck', 'ERROR', e.message); }

// ── item4：副根脚本 → 副根零写入（核心修复：不再 mkdir skillDir/workspace）──────────
//    证据 = 跑前后 ~/.agents/skills 整树快照逐字节相同 + 正控制（产物真落 session workspace）。
//    main 对照点：main 会在副根建 workspace/ 并落文件 → 树 diff 非空 → FAIL。
try {
  const agentsRoot = `${HOME}/.agents/skills`;
  const before = snapshotTree(agentsRoot);
  const resp = await runScriptGranted('agents-probe', 'write.py', ['x1', 'x2'], sessC);
  if (!resp.ok) throw new Error(`agents-probe write.py failed: ${JSON.stringify(resp.error).slice(0, 300)}`);
  const after = snapshotTree(agentsRoot);
  const treeUnchanged = before === after;
  const noWorkspaceDir = !fs.existsSync(`${agentsRoot}/agents-probe/workspace`);
  const productPath = `${wsDir(sessC)}/agents-out.txt`;
  const productOk = fs.existsSync(productPath) && fs.readFileSync(productPath, 'utf8') === 'from-agents-probe:x1,x2';
  const outputsOk = (resp.result.outputs ?? []).some((o) => o.path === 'agents-out.txt');
  const stdoutOk = resp.result.output.includes('agents-probe wrote agents-out.txt');
  const ok = treeUnchanged && noWorkspaceDir && productOk && outputsOk && stdoutOk;
  record('item4-agents-root-zero-write', ok ? 'PASS' : 'FAIL',
    `副根树前后一致=${treeUnchanged} 无 agents-probe/workspace=${noWorkspaceDir} ` +
    `· 正控制:产物落 sessions/${sessC.slice(0, 8)}…=${productOk} outputs 列出=${outputsOk} stdout marker=${stdoutOk}`);
  if (!treeUnchanged) {
    fs.writeFileSync(`${REPORT}/item4-tree-before.json`, before);
    fs.writeFileSync(`${REPORT}/item4-tree-after.json`, after);
  }
} catch (e) { record('item4-agents-root-zero-write', 'ERROR', e.message); }

// ── item5：双 session 同脚本同名文件 → 各写各的 workspace，互不覆盖 ─────────────────
//    main 对照点：main 两次都写 <skillDir>/workspace/out.csv 第二次覆盖第一次 → 必 FAIL。
try {
  const r1 = await runScriptGranted('io-probe', 'write.sh', ['AAA'], sessA);
  const r2 = await runScriptGranted('io-probe', 'write.sh', ['BBB'], sessB);
  if (!r1.ok || !r2.ok) throw new Error(`runs failed: ${JSON.stringify({ r1: r1.error, r2: r2.error }).slice(0, 300)}`);
  const contentA = fs.readFileSync(`${wsDir(sessA)}/out.csv`, 'utf8');
  const contentB = fs.readFileSync(`${wsDir(sessB)}/out.csv`, 'utf8');
  const outputsOk = (r1.result.outputs ?? []).some((o) => o.path === 'out.csv')
    && (r2.result.outputs ?? []).some((o) => o.path === 'out.csv');
  const ok = contentA === 'AAA' && contentB === 'BBB' && outputsOk;
  record('item5-session-isolation', ok ? 'PASS' : 'FAIL',
    `sessions/${sessA.slice(0, 8)}…/out.csv="${contentA}"（期望 AAA） sessions/${sessB.slice(0, 8)}…/out.csv="${contentB}"（期望 BBB） · 两次 outputs 各含 out.csv=${outputsOk}`);
} catch (e) { record('item5-session-isolation', 'ERROR', e.message); }

// ── item6：read_session_file 守卫 — 正控制 + 跨 session / 穿越 / 非法 sid 全拒 ──────
//    注：拒绝类断言在 main 上以 unknown_method 也报错（被测面不存在，安全断言天然真空通过）；
//    整项的 would-fail-on-main 由正控制 1 保证（main 上 unknown_method → FAIL）。
try {
  const pos = await daemonRpc('read_session_file', { sessionId: sessA, path: 'out.csv' });
  const posOk = pos.ok && pos.result.content === 'AAA';

  const cross = await daemonRpc('read_session_file', { sessionId: sessA, path: `../../${sessB}/workspace/out.csv` });
  const crossDenied = !cross.ok && !JSON.stringify(cross).includes('BBB');

  const abs = await daemonRpc('read_session_file', { sessionId: sessA, path: '/etc/passwd' });
  const deep = await daemonRpc('read_session_file', { sessionId: sessA, path: '../../../../../etc/passwd' });
  const travDenied = !abs.ok && !deep.ok
    && !JSON.stringify(abs).includes('root:') && !JSON.stringify(deep).includes('root:');

  const badSid = await daemonRpc('read_session_file', { sessionId: '../evil', path: 'x' });
  const sidDenied = !badSid.ok && String(badSid.error?.message ?? '').includes('invalid session id');

  const ok = posOk && crossDenied && travDenied && sidDenied;
  record('item6-read-session-guards', ok ? 'PASS' : 'FAIL',
    `正控制 AAA=${posOk} · 跨 session 拒且无 BBB 泄露=${crossDenied}(${JSON.stringify(cross.error?.message ?? '').slice(0, 120)}) ` +
    `· 绝对/深穿越拒且无 passwd 泄露=${travDenied} · 非法 sid 拒=${sidDenied}(${JSON.stringify(badSid.error?.message ?? '').slice(0, 120)})`);
} catch (e) { record('item6-read-session-guards', 'ERROR', e.message); }

// ── item7-rpc：delete_session_workspace 直连语义 — 删整个 session 目录 + 幂等 false ──
//    （7a 的 daemon 端等价物；扩展侧全链路见 Section B。sessD 用完即弃。）
try {
  const d1 = await daemonRpc('delete_session_workspace', { sessionId: sessD });
  const gone = !fs.existsSync(`${SESSIONS}/${sessD}`);
  const d2 = await daemonRpc('delete_session_workspace', { sessionId: sessD });
  const ok = d1.ok && d1.result.deleted === true && gone && d2.ok && d2.result.deleted === false;
  record('item7-delete-rpc-idempotent', ok ? 'PASS' : 'FAIL',
    `第一次 deleted=${d1.result?.deleted}（期望 true） 磁盘整目录消失=${gone} 第二次 deleted=${d2.result?.deleted}（期望 false，幂等）`);
} catch (e) { record('item7-delete-rpc-idempotent', 'ERROR', e.message); }

// ── item-list-scale：list_skills 单次 RPC 完整回 30+ 条（>8KB 压背压回归）───────────
try {
  const resp = await daemonRpc('list_skills', undefined);
  if (!resp.ok) throw new Error(JSON.stringify(resp.error).slice(0, 300));
  const skills = resp.result.skills;
  const fixtureCount = skills.filter((s) => /^fixture-\d+$/.test(s.name)).length;
  const io = skills.find((s) => s.name === 'io-probe');
  const agents = skills.find((s) => s.name === 'agents-probe');
  const bytes = JSON.stringify(resp).length;
  const ok = fixtureCount === fixtures.skills.scaleCount && !!io && io.source === 'pie'
    && !!agents && agents.source === 'agents' && bytes > 8192;
  record('item-list-skills-scale', ok ? 'PASS' : 'FAIL',
    `fixture 条数=${fixtureCount}（期望 ${fixtures.skills.scaleCount}） io-probe source=${io?.source} agents-probe source=${agents?.source} · 响应字节=${bytes}（期望 >8192）`);
} catch (e) { record('item-list-skills-scale', 'ERROR', e.message); }

// ═══════════════════════ Section B：functional（Playwright，无 LLM）═══════════════════════
// 7a 归档/硬删清 workspace（扩展 lifecycle 钩子 → SW → 桥 → daemon 全链路）+ SkillsList 规模档。
// 纯桥/生命周期测试，不 seedConfig（无 LLM 依赖）。

const NM_MANIFEST = JSON.stringify({
  name: 'ai.wiseria.pie',
  description: 'Pie daemon bridge (pilot314 scratch)',
  path: `${BASE}/host-wrapper.sh`,
  type: 'stdio',
  allowed_origins: ['chrome-extension://gpccjhdgjkmalnepmeclooflliiocfed/'],
});

async function launch(profile, dist) {
  fs.mkdirSync(`${BASE}/${profile}/NativeMessagingHosts`, { recursive: true });
  fs.writeFileSync(`${BASE}/${profile}/NativeMessagingHosts/ai.wiseria.pie.json`, NM_MANIFEST);
  const ctx = await chromium.launchPersistentContext(`${BASE}/${profile}`, {
    headless: false,
    viewport: { width: 420, height: 900 },
    locale: 'en-US',
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--lang=en-US'],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const page = await ctx.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
  return { ctx, page, sw, extId };
}

const bridgeStatus = (page) =>
  page.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'local-bridge:status' }, (res) => resolve(res ?? null));
  }));

async function waitReady(page, timeoutMs = 30000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await bridgeStatus(page);
    if (last?.ready) return last;
    await sleep(500);
  }
  return last;
}

// #292 IA：设置入口在会话抽屉；firstRun 可能自动落设置页 → topbar-back 循环点回聊天。
async function backToChat(page) {
  const back = page.getByTestId('topbar-back');
  for (let i = 0; i < 6 && (await back.count()); i++) { await back.click(); await sleep(400); }
}

// 从 IDB sessions store 读全部 session id（key 形如 `${sid}:meta`）
const readSids = (page) =>
  page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('pie');
    req.onsuccess = () => {
      try {
        const tx = req.result.transaction('sessions', 'readonly');
        const g = tx.objectStore('sessions').getAllKeys();
        g.onsuccess = () => resolve(
          g.result.filter((k) => typeof k === 'string' && k.endsWith(':meta')).map((k) => k.slice(0, -':meta'.length)),
        );
        g.onerror = () => resolve([]);
      } catch { resolve([]); }
    };
    req.onerror = () => resolve([]);
  }));

const { ctx, page } = await launch('profile-a', `${BASE}/dist-pilot`);

// ── B0：桥就绪（dist-pilot 必选权限 → SW 自动连 scratch daemon）────────────────────
try {
  const s = await waitReady(page);
  const ok = s?.ready === true && !!s.daemonVersion;
  record('b0-bridge-ready', ok ? 'PASS' : 'FAIL', JSON.stringify(s));
  await snap(page, 'bridge-ready');
  if (!ok) {
    fs.writeFileSync(`${REPORT}/results-functional.json`, JSON.stringify(results, null, 2));
    await ctx.close();
    process.exit(1);
  }
} catch (e) {
  record('b0-bridge-ready', 'ERROR', e.message);
  await ctx.close();
  fs.writeFileSync(`${REPORT}/results-functional.json`, JSON.stringify(results, null, 2));
  process.exit(1);
}

// ── itemB-skills-scale：SkillsList 32 规模档滚动到底可见末条（DOM 侧规模冒烟）──────────
try {
  await backToChat(page);
  await page.getByTestId('topbar-skills').click();
  // 副根 agents-probe 触发首连导入向导 → 「Not now」关掉（本批不需要启用它）
  try {
    await page.getByText(/Found \d+ local skills?/).waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'Not now' }).click();
  } catch { /* 向导没弹（已提示过）也 OK */ }
  await page.locator('code:text-is("/fixture-32")').waitFor({ timeout: 20000 });
  const fixtureRows = await page.locator('code').filter({ hasText: /^\/fixture-\d+$/ }).count();
  const ioRow = await page.locator('code:text-is("/io-probe")').count();
  const agentsRow = await page.locator('code:text-is("/agents-probe")').count();
  const ok = fixtureRows === fixtures.skills.scaleCount && ioRow === 1 && agentsRow === 1;
  record('itemB-skills-list-scale', ok ? 'PASS' : 'FAIL',
    `fixture 行数=${fixtureRows}（期望 ${fixtures.skills.scaleCount}） io-probe 行=${ioRow} agents-probe 行=${agentsRow}`);
  await snap(page, 'skills-scale');
} catch (e) { record('itemB-skills-list-scale', 'ERROR', e.message); await snap(page, 'skills-scale-error'); }

// ── item7a：归档 / 硬删 → workspace 消失（全链路）——已挪到 llm 批 ────────────────────
// 本批无 seedConfig、无带内容会话，而 SessionDrawer 只列出有内容的 session（空会话不进列表，
// topbar-new 出来的空会话悬停不出 Archive 按钮）。llm 批 taskA-E 产生真实会话后再测删除链路。
record('item7a-archive-clears-workspace', 'SKIP', '挪至 llm 批（抽屉只列有内容的会话，本批无 LLM 会话可归档）');
record('item7a-harddelete-clears-workspace', 'SKIP', '同上');

await ctx.close();

// ═══════════════════════ 收尾 ═══════════════════════
fs.writeFileSync(`${REPORT}/results-functional.json`, JSON.stringify(results, null, 2));
console.table(results);
const fails = results.filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
console.log(`\n== ${results.length} checks, ${fails.length} fail/error ==`);
process.exit(fails.length ? 1 : 0);
