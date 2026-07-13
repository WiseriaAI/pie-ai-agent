// PR #299（fix/settings-root-bridge-badge）真机验收 — 功能批。
// 环境搭建 / 配方坑见 docs/agents/auto-acceptance.md。无 LLM 依赖 → 不 seedConfig。
//
// 断言核心：不是「badge 最终变了」，而是「桥 ready 翻转 → badge 跟随」的**延迟**。
// 同时观测两条流（250ms 采样）：
//   - 真值：SW 的 local-bridge:status RPC（ready 布尔）
//   - 表现：设置根页 Local Bridge 行的 badge 文本（Connected / Not connected）
// badge 若只在 mount 查一次（#298 的 bug），ready 翻转后表现永不跟随 → 超时 FAIL。
// 全程不 reload、不离开设置页 —— SettingsRoot 保持挂载，排除「重挂载才更新」的假通过。
//
// 同一脚本可直接跑 main 的 dist 做对照（期望场景 1 FAIL），证明修复有效而非环境巧合。
import { chromium } from 'playwright';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';

const BASE = process.env.PIE_ACCEPT_BASE;
if (!BASE) throw new Error('PIE_ACCEPT_BASE 未设置');
const REPO = '/Users/wenkang/repos/pie/pie-ai-agent';
const DIST = process.env.PIE_ACCEPT_DIST || `${BASE}/dist-pilot`;
const TAG = process.env.PIE_ACCEPT_TAG || 'pr299';
const PROFILE = process.env.PIE_ACCEPT_PROFILE || `profile-${TAG}`;
const REPORT = `${BASE}/report`;
const results = [];
let shot = 0;

function record(item, status, note = '') {
  results.push({ item, status, note });
  console.log(`[${status}] ${item}${note ? ' — ' + note : ''}`);
}
async function snap(page, name) {
  shot += 1;
  await page.screenshot({ path: `${REPORT}/${TAG}-${String(shot).padStart(2, '0')}-${name}.png` });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const sockExists = () => fs.existsSync(`${BASE}/home/.pie/daemon.sock`);

const NM_MANIFEST = JSON.stringify({
  name: 'ai.wiseria.pie',
  description: 'Pie daemon bridge (pilot299 scratch)',
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
  return { ctx, page, extId };
}

// 桥真值（SW 的 local-bridge:status handler）
const bridgeReady = (page) =>
  page.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'local-bridge:status' }, (res) => resolve(res?.ready === true));
  })).catch(() => null);

// 设置根页 Local Bridge 行的 badge 表现值
async function badgeText(page) {
  const on = await page.getByText('Connected', { exact: true }).count();
  const off = await page.getByText('Not connected', { exact: true }).count();
  if (on && !off) return 'Connected';
  if (off && !on) return 'Not connected';
  if (!on && !off) return 'none';
  return 'both';
}

// 同时观测真值与表现，返回各自首次到达目标的时刻（相对 t0，ms）。
async function observeFollow(page, wantReady, wantBadge, timeoutMs) {
  const t0 = Date.now();
  let tReady = null, tBadge = null;
  while (Date.now() - t0 < timeoutMs) {
    const [r, b] = [await bridgeReady(page), await badgeText(page)];
    if (tReady === null && r === wantReady) tReady = Date.now() - t0;
    if (tBadge === null && b === wantBadge) tBadge = Date.now() - t0;
    if (tReady !== null && tBadge !== null) break;
    await sleep(250);
  }
  return { tReady, tBadge, lag: tReady !== null && tBadge !== null ? tBadge - tReady : null };
}

async function openSettings(page) {
  const bridgeRow = page.getByText('Local Bridge', { exact: true });
  if (await bridgeRow.count()) return; // firstRun 已落在设置页
  await page.getByTestId('topbar-drawer').click();
  await page.getByTestId('drawer-settings').click();
  await bridgeRow.waitFor();
}

// ── 前置：daemon 不起（模拟「桥未 ready」的冷启动），再拉起 Chrome
killDaemon();
await sleep(500);
const { ctx, page } = await launch(PROFILE, DIST);
await openSettings(page);
await sleep(2000); // 给 SW 首轮连桥尝试落定（host 见无 socket 即 exit → 退避梯子）

// ── 1. 桥未 ready 时停在设置根页 → daemon 起来后 badge 自行变 Connected（不刷新、不离开）
try {
  const before = { badge: await badgeText(page), ready: await bridgeReady(page) };
  await snap(page, 'root-not-connected');
  if (before.badge !== 'Not connected' || before.ready !== false) {
    record('1-badge-follows-connect', 'ERROR',
      `前置不成立：badge=${before.badge} ready=${before.ready}（期望 Not connected / false）`);
  } else {
    startDaemon();
    for (let i = 0; i < 40 && !sockExists(); i++) await sleep(250);
    // 退避梯子最长 30s → 给 90s；badge 只要在 ready 后 ≤2.5s 内跟上即算跟随
    const o = await observeFollow(page, true, 'Connected', 90000);
    const ok = o.tReady !== null && o.tBadge !== null && o.lag <= 2500;
    record('1-badge-follows-connect', ok ? 'PASS' : 'FAIL',
      `sock=${sockExists()} · 桥 ready@${o.tReady}ms · badge Connected@${o.tBadge}ms · 跟随延迟=${o.lag}ms（期望 ≤2500，轮询 1.5s）`);
    await snap(page, 'root-connected');
  }
} catch (e) { record('1-badge-follows-connect', 'ERROR', e.message); await snap(page, 'err-1'); }

// ── 2. 停在设置根页 kill daemon → badge 自行变回 Not connected
try {
  killDaemon();
  const o = await observeFollow(page, false, 'Not connected', 30000);
  const ok = o.tReady !== null && o.tBadge !== null && o.lag <= 2500;
  record('2-badge-follows-disconnect', ok ? 'PASS' : 'FAIL',
    `桥 ready=false@${o.tReady}ms · badge Not connected@${o.tBadge}ms · 跟随延迟=${o.lag}ms（期望 ≤2500）`);
  await snap(page, 'root-disconnected');
} catch (e) { record('2-badge-follows-disconnect', 'ERROR', e.message); await snap(page, 'err-2'); }

// ── 3. Bridge 二级页行为不变：daemon 回来后状态行显示 Connected to daemon. + 版本；
//       再 kill 后二级页自行变回未连接（二级页原有轮询未被本 PR 动过）
try {
  startDaemon();
  for (let i = 0; i < 40 && !sockExists(); i++) await sleep(250);
  const back = await observeFollow(page, true, 'Connected', 90000);
  if (back.tReady === null) throw new Error('daemon 重启后桥未 ready');
  await page.getByText('Local Bridge', { exact: true }).click();
  await page.getByText(/Connected to daemon\./).waitFor({ timeout: 15000 });
  const line = await page.getByText(/Connected to daemon\./).innerText();
  const hasVersion = /\d+\.\d+\.\d+/.test(line);
  await snap(page, 'bridge-subpage-connected');

  killDaemon();
  let gone = false;
  for (let i = 0; i < 80; i++) { // ≤20s
    if (await page.getByText(/Connected to daemon\./).count() === 0) { gone = true; break; }
    await sleep(250);
  }
  await snap(page, 'bridge-subpage-disconnected');
  record('3-bridge-subpage-unchanged', hasVersion && gone ? 'PASS' : 'FAIL',
    `状态行="${line}" 含版本=${hasVersion} · kill 后二级页自行清除连接态=${gone}`);
} catch (e) { record('3-bridge-subpage-unchanged', 'ERROR', e.message); await snap(page, 'err-3'); }

await ctx.close();
killDaemon();
fs.writeFileSync(`${REPORT}/results-${TAG}.json`, JSON.stringify(results, null, 2));
const fails = results.filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
console.log(`\n== [${TAG}] ${results.length} checks, ${fails.length} fail/error ==`);
process.exit(fails.length ? 1 : 0);
