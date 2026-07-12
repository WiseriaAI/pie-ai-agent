// PR #293（fix/bridge-init-overlap-teardown，合入 main 后）真机验收 — 功能批。
// 环境搭建 / 配方坑见 docs/agents/auto-acceptance.md。无 LLM 依赖（本 PR 不涉及模型面）→ 不 seedConfig。
//
// 断言优先级：SW 的 local-bridge:status RPC（ready/daemonVersion/protocolMismatch）
// + host 进程计数（pgrep）> DOM。产品路径的「真·重叠 init」是罕见竞态、真机无触发口
// （initLocalBridge 不对外暴露），由单测覆盖；本批验证的是它依赖的 Chrome 语义前提
// （port.disconnect() 不触发自身 onDisconnect、且回收 host 进程）+ 全链路回归无损。
import { chromium } from 'playwright';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';

const BASE = process.env.PIE_ACCEPT_BASE;
if (!BASE) throw new Error('PIE_ACCEPT_BASE 未设置');
const REPO = '/Users/wenkang/repos/pie/pie-ai-agent';
const REPORT = `${BASE}/report`;
const results = [];
let shot = 0;

function record(item, status, note = '') {
  results.push({ item, status, note });
  console.log(`[${status}] ${item}${note ? ' — ' + note : ''}`);
}
async function snap(page, name) {
  shot += 1;
  await page.screenshot({ path: `${REPORT}/${String(shot).padStart(2, '0')}-${name}.png` });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// scratch host = `bun <repo>/daemon/src/cli.ts host`；真实用户 daemon 是编译版
// ~/.pie/bin/pie-host → 精确匹配，不会误计/误伤。
function hostCount() {
  try {
    return execSync(`pgrep -f "daemon/src/cli.ts host" | wc -l`).toString().trim() | 0;
  } catch {
    return 0;
  }
}
function killDaemon() {
  try { execSync(`pkill -f "daemon/src/cli.ts daemon"`); } catch { /* already dead */ }
}
function startDaemon() {
  const p = spawn('bun', [`${REPO}/daemon/src/cli.ts`, 'daemon'], {
    env: { ...process.env, HOME: `${BASE}/home` },
    detached: true, stdio: 'ignore',
  });
  p.unref();
}

const NM_MANIFEST = JSON.stringify({
  name: 'ai.wiseria.pie',
  description: 'Pie daemon bridge (pilot293 scratch)',
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

// 桥状态唯一确定性观察量（SW 的 local-bridge:status handler）
const bridgeStatus = (page) =>
  page.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'local-bridge:status' }, (res) => resolve(res ?? null));
  }));

async function waitReady(page, timeoutMs = 20000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await bridgeStatus(page);
    if (last?.ready) return last;
    await sleep(500);
  }
  return last;
}

const { ctx, page, sw } = await launch('profile-a', `${BASE}/dist-pilot`);

// ── 1. 冷启动连桥 + 握手（合并冲突就解在握手回调：stale 守卫 + protocolMismatch/daemonVersion）
try {
  const s = await waitReady(page);
  const ok = s?.ready === true && !!s.daemonVersion && s.protocolMismatch !== true;
  record('1-bridge-connect-handshake', ok ? 'PASS' : 'FAIL', JSON.stringify(s));
  await snap(page, 'bridge-connected');
  if (!ok) { fs.writeFileSync(`${REPORT}/results.json`, JSON.stringify(results, null, 2)); await ctx.close(); process.exit(1); }
} catch (e) {
  record('1-bridge-connect-handshake', 'ERROR', e.message);
  await ctx.close(); process.exit(1);
}

// ── 2. host 进程无泄漏基线：一条桥 = 恰好一个 host 进程
try {
  const n = hostCount();
  record('2-host-process-single', n === 1 ? 'PASS' : 'FAIL', `host 进程数=${n}（期望 1）`);
} catch (e) { record('2-host-process-single', 'ERROR', e.message); }

// #292 IA 重构后设置入口移进会话抽屉（顶栏无齿轮）；firstRun 时已自动在设置页。
async function openSettings(page) {
  const bridgeRow = page.getByText('Local Bridge', { exact: true });
  if (await bridgeRow.count()) return;
  await page.getByTestId('topbar-drawer').click();
  await page.getByTestId('drawer-settings').click();
  await bridgeRow.waitFor();
}
async function leaveSettings(page) {
  const back = page.getByTestId('topbar-back');
  while (await back.count()) { await back.click(); await sleep(400); }
}

// ── 3. 设置页 IA 回归（合入 main #292 重构）+ 桥状态展示（#285 版本握手）
// 桥 ready 后再打开设置页（真实路径）：SettingsRoot 的 badge 只在 mount 查一次、不轮询。
try {
  await page.reload();
  await openSettings(page);
  await sleep(1000);
  const badge = await page.getByText('Connected', { exact: true }).count();
  const staleBadge = await page.getByText('Not connected', { exact: true }).count();
  await snap(page, 'settings-root');
  await page.getByText('Local Bridge', { exact: true }).click();
  await page.getByText(/Connected to daemon\./).waitFor();
  const statusLine = await page.getByText(/Connected to daemon\./).innerText();
  const hasVersion = /\d+\.\d+\.\d+/.test(statusLine);
  record('3-settings-ia-bridge-status', badge >= 1 && hasVersion ? 'PASS' : 'FAIL',
    `根页 badge Connected=${badge} / Not connected=${staleBadge} · Bridge 页状态行="${statusLine}"`);
  await snap(page, 'settings-bridge-page');
} catch (e) { record('3-settings-ia-bridge-status', 'ERROR', e.message); await snap(page, 'settings-error'); }

// ── 4. skill_fs 全链路（32 个磁盘 skill → list 响应 >8KB，压 socket 背压路径）
try {
  await leaveSettings(page);
  await page.getByTestId('topbar-skills').click();
  await page.locator('code:text-is("/fixture-32")').waitFor({ timeout: 15000 });
  const rows = await page.locator('code').filter({ hasText: /^\/fixture-\d+$/ }).count();
  record('4-skill-fs-disk-list-32', rows === 32 ? 'PASS' : 'FAIL', `磁盘 skill 行数=${rows}（期望 32，>8KB 响应）`);
  await snap(page, 'skills-32');
} catch (e) { record('4-skill-fs-disk-list-32', 'ERROR', e.message); await snap(page, 'skills-error'); }

// ── 5. Chrome 语义取证（PR (a) 拆旧 port 的前提，单测 mock 覆盖不到）：
//    port.disconnect() 不触发自身 onDisconnect，且回收对应 host 进程；
//    同时主桥（另一条 port）不受影响 → 拆旧 port 不会误清健康连接。
try {
  const before = hostCount();
  await sw.evaluate(() => {
    const p = chrome.runtime.connectNative('ai.wiseria.pie');
    globalThis.__probe = { port: p, fired: false };
    p.onDisconnect.addListener(() => { globalThis.__probe.fired = true; });
  });
  await sleep(1500);
  const during = hostCount();
  await sw.evaluate(() => globalThis.__probe.port.disconnect());
  await sleep(1500);
  const after = hostCount();
  const fired = await sw.evaluate(() => globalThis.__probe.fired);
  const s = await bridgeStatus(page);
  const ok = during === before + 1 && after === before && fired === false && s?.ready === true;
  record('5-chrome-disconnect-semantics', ok ? 'PASS' : 'FAIL',
    `host 进程 ${before}→${during}→${after} · 自身 onDisconnect fired=${fired}（期望 false） · 主桥 ready=${s?.ready}`);
} catch (e) { record('5-chrome-disconnect-semantics', 'ERROR', e.message); }

// ── 6. daemon 重启 → 退避梯子重连恢复；重连后无僵尸 host 堆积、桥重新 ready
try {
  killDaemon();
  await sleep(2000);
  const afterKill = await bridgeStatus(page);
  startDaemon();
  await sleep(3000);
  const s = await waitReady(page, 45000); // 退避梯子 1s→30s
  const hosts = hostCount();
  const ok = s?.ready === true && !!s.daemonVersion && hosts === 1;
  record('6-daemon-restart-reconnect', ok ? 'PASS' : 'FAIL',
    `kill 后 ready=${afterKill?.ready} → 重启后 ready=${s?.ready} v=${s?.daemonVersion} · host 进程数=${hosts}（期望 1）`);
  await snap(page, 'after-reconnect');
} catch (e) { record('6-daemon-restart-reconnect', 'ERROR', e.message); }

// ── 7. 重连后 skill_fs 仍走通（stale onDisconnect 若清掉健康新连接，这里会空/报错）
try {
  await page.reload();
  await page.getByTestId('topbar-skills').click();
  await page.locator('code:text-is("/fixture-32")').waitFor({ timeout: 20000 });
  const rows = await page.locator('code').filter({ hasText: /^\/fixture-\d+$/ }).count();
  record('7-skill-fs-after-reconnect', rows === 32 ? 'PASS' : 'FAIL', `重连后磁盘 skill 行数=${rows}（期望 32）`);
  await snap(page, 'skills-after-reconnect');
} catch (e) { record('7-skill-fs-after-reconnect', 'ERROR', e.message); await snap(page, 'skills-reconnect-error'); }

await ctx.close();
fs.writeFileSync(`${REPORT}/results.json`, JSON.stringify(results, null, 2));
const fails = results.filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
console.log(`\n== ${results.length} checks, ${fails.length} fail/error ==`);
process.exit(fails.length ? 1 : 0);
