// PR #304（feat/install-guide-funnel）真机验收 — 功能批。
// 环境搭建 / 配方坑见 docs/agents/auto-acceptance.md。无 LLM 依赖 → 不 seedConfig。
//
// 验的是安装引导漏斗的三态分类（installState）与卡片跟随：
//   未装 host manifest      → connectNative/onDisconnect "not found"  → 安装卡
//   manifest 在但 daemon 停 → host 连不上 socket 即 exit             → doctor 卡
//   daemon 起来             → 握手成功                                → 连接态（卡片消失）
// 全程单个 Chrome、单个 Bridge 页，不 reload、不离开该页——排除「重挂载才更新」的假通过。
import { chromium } from 'playwright';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';

const BASE = process.env.PIE_ACCEPT_BASE;
if (!BASE) throw new Error('PIE_ACCEPT_BASE 未设置');
const REPO = '/Users/wenkang/repos/pie/pie-ai-agent';
const DIST = process.env.PIE_ACCEPT_DIST || `${BASE}/dist-pilot`;
const TAG = process.env.PIE_ACCEPT_TAG || 'pr304';
const PROFILE = `${BASE}/profile-${TAG}`;
const REPORT = `${BASE}/report`;
const NM_PATH = `${PROFILE}/NativeMessagingHosts/ai.wiseria.pie.json`;
const PKG_URL = 'https://github.com/WiseriaAI/pie-ai-agent/releases/latest/download/pie-link.pkg';
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

// 「装 Pie Link」= 落 host manifest（pkg 干的事，这里等价模拟；pkg 本体属人工盲区）
function installHostManifest() {
  fs.writeFileSync(NM_PATH, JSON.stringify({
    name: 'ai.wiseria.pie',
    description: 'Pie daemon bridge (pilot304 scratch)',
    path: `${BASE}/host-wrapper.sh`,
    type: 'stdio',
    allowed_origins: ['chrome-extension://gpccjhdgjkmalnepmeclooflliiocfed/'],
  }));
}

// 桥真值：SW 分类出的 installState（本 PR 新增字段）
const swInstallState = (page) =>
  page.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'local-bridge:status' }, (res) =>
      resolve(res ? `${res.installState}/${res.ready}` : 'null'));
  })).catch(() => null);

// 卡片表现值（Bridge 二级页）
async function cardState(page) {
  const install = await page.getByText('Install Pie Link', { exact: true }).count();
  const doctor = await page.getByText(/pie doctor/).count();
  const connected = await page.getByText(/Connected to daemon\./).count();
  if (connected) return 'connected';
  if (install && !doctor) return 'install';
  if (doctor && !install) return 'doctor';
  if (install && doctor) return 'both';
  return 'none';
}

// 双流采样：真值（SW RPC）与表现（DOM）各自首次到达目标的时刻。
async function observeFollow(page, wantState, wantCard, timeoutMs) {
  const t0 = Date.now();
  let tTruth = null, tCard = null;
  while (Date.now() - t0 < timeoutMs) {
    const [s, c] = [await swInstallState(page), await cardState(page)];
    if (tTruth === null && s === wantState) tTruth = Date.now() - t0;
    if (tCard === null && c === wantCard) tCard = Date.now() - t0;
    if (tTruth !== null && tCard !== null) break;
    await sleep(250);
  }
  return { tTruth, tCard, lag: tTruth !== null && tCard !== null ? tCard - tTruth : null };
}

// ── 前置：无 host manifest（= 未装 Pie Link）、无 daemon
killDaemon();
fs.mkdirSync(`${PROFILE}/NativeMessagingHosts`, { recursive: true });
if (fs.existsSync(NM_PATH)) fs.rmSync(NM_PATH);
await sleep(300);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 420, height: 900 },
  locale: 'en-US',
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--lang=en-US'],
});
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
const page = await ctx.newPage();
page.setDefaultTimeout(12000);
await page.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);

// 进 Bridge 二级页，之后全程停在这里（firstRun 直接落设置页；等它挂完再判断，
// 否则会在重挂载途中点到 detached 的 topbar 按钮）
await sleep(1500);
const bridgeRow = page.getByText('Local Bridge', { exact: true });
try {
  await bridgeRow.waitFor({ timeout: 5000 });
} catch {
  await page.getByTestId('topbar-drawer').click();
  await page.getByTestId('drawer-settings').click();
  await bridgeRow.waitFor();
}
await bridgeRow.click();
await sleep(2500); // 首轮连桥尝试落定

// ── 1. 未装 → 安装卡（标题 + 下载链接 href + 重新检测按钮），SW 判为 not_installed
try {
  const truth = await swInstallState(page);
  const card = await cardState(page);
  const href = await page.getByRole('link', { name: 'Download Pie Link (.pkg)' }).getAttribute('href').catch(() => null);
  const hasRecheck = await page.getByRole('button', { name: 'Check again' }).count();
  await snap(page, 'not-installed');
  const ok = truth === 'not_installed/false' && card === 'install' && href === PKG_URL && hasRecheck === 1;
  record('1-未装-安装卡', ok ? 'PASS' : 'FAIL',
    `installState=${truth} · 卡片=${card} · 下载链接=${href} · 重新检测按钮=${hasRecheck}`);
} catch (e) { record('1-未装-安装卡', 'ERROR', e.message); await snap(page, 'err-1'); }

// ── 2. 装上 host manifest 但 daemon 未跑 → 点「重新检测」→ 立即翻 doctor 卡
//      （同时验证 Chrome 不缓存 host manifest：运行中新装能被感知，无需重启浏览器）
try {
  installHostManifest();
  await page.getByRole('button', { name: 'Check again' }).click();
  const o = await observeFollow(page, 'installed_not_running/false', 'doctor', 15000);
  const installGone = (await page.getByText('Install Pie Link', { exact: true }).count()) === 0;
  await snap(page, 'installed-not-running');
  const ok = o.tTruth !== null && o.tCard !== null && installGone;
  record('2-已装未跑-doctor卡', ok ? 'PASS' : 'FAIL',
    `点重新检测后 installed_not_running@${o.tTruth}ms · doctor 卡@${o.tCard}ms · 安装卡消失=${installGone}`);
} catch (e) { record('2-已装未跑-doctor卡', 'ERROR', e.message); await snap(page, 'err-2'); }

// ── 3. daemon 起来（= pkg 装完 launchd 拉起）→ 不点任何按钮 → 卡片自行翻连接态
//      PR 清单原文：装完 ≤30s 自动翻转。退避梯子封顶 30s → 给 90s 上限并记录实际耗时。
try {
  startDaemon();
  for (let i = 0; i < 40 && !sockExists(); i++) await sleep(250);
  const o = await observeFollow(page, 'connected/true', 'connected', 90000);
  await snap(page, 'connected');
  const ok = o.tTruth !== null && o.tCard !== null && o.lag <= 2500;
  record('3-装完自动翻转连接态', ok ? 'PASS' : 'FAIL',
    `sock=${sockExists()} · 桥 connected@${o.tTruth}ms（退避梯子，无需点按钮）· 卡片跟随@${o.tCard}ms · 跟随延迟=${o.lag}ms（期望 ≤2500，轮询 1.5s）${o.tTruth > 30000 ? ' ⚠️ 超过清单的 30s' : ''}`);
} catch (e) { record('3-装完自动翻转连接态', 'ERROR', e.message); await snap(page, 'err-3'); }

// ── 4. daemon 挂掉（manifest 仍在）→ 回 doctor 卡，不是安装卡（分类没退化成 not_installed）
try {
  killDaemon();
  const o = await observeFollow(page, 'installed_not_running/false', 'doctor', 30000);
  const noInstallCard = (await page.getByText('Install Pie Link', { exact: true }).count()) === 0;
  await snap(page, 'daemon-died');
  const ok = o.tTruth !== null && o.tCard !== null && noInstallCard;
  record('4-daemon挂掉-回doctor不误报未装', ok ? 'PASS' : 'FAIL',
    `installed_not_running@${o.tTruth}ms · doctor 卡@${o.tCard}ms · 未误报安装卡=${noInstallCard}`);
} catch (e) { record('4-daemon挂掉-回doctor不误报未装', 'ERROR', e.message); await snap(page, 'err-4'); }

// ── 5. doctor 态点「重新检测」+ daemon 已在 → 立即连上（手动重连绕过退避梯子）
try {
  startDaemon();
  for (let i = 0; i < 40 && !sockExists(); i++) await sleep(250);
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Check again' }).click();
  const o = await observeFollow(page, 'connected/true', 'connected', 10000);
  await snap(page, 'recheck-connected');
  const ok = o.tTruth !== null && o.tCard !== null;
  record('5-重新检测立即连上', ok ? 'PASS' : 'FAIL',
    `点击后 connected@${o.tTruth}ms · 卡片消失@${o.tCard}ms（10s 内，未等退避）· 点击时刻=${t0 % 100000}`);
} catch (e) { record('5-重新检测立即连上', 'ERROR', e.message); await snap(page, 'err-5'); }

await ctx.close();
killDaemon();

// ── 6. 真实用户路径（最坏情况）：全新 profile 未装 → 干等 45s 让退避梯子爬到 30s 档
//      → 装 manifest + 起 daemon，**不点任何按钮** → 卡片应在 ≤30s（梯子上限）内自行翻转。
//      场景 3 因为前一步点过「重新检测」重置了梯子（2.3s 就连上），测不到这个最坏情况。
try {
  const P2 = `${BASE}/profile-${TAG}-cold`;
  const NM2 = `${P2}/NativeMessagingHosts/ai.wiseria.pie.json`;
  fs.mkdirSync(`${P2}/NativeMessagingHosts`, { recursive: true });
  if (fs.existsSync(NM2)) fs.rmSync(NM2);
  const ctx2 = await chromium.launchPersistentContext(P2, {
    headless: false, viewport: { width: 420, height: 900 }, locale: 'en-US',
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--lang=en-US'],
  });
  let sw2 = ctx2.serviceWorkers()[0];
  if (!sw2) sw2 = await ctx2.waitForEvent('serviceworker', { timeout: 15000 });
  const page2 = await ctx2.newPage();
  page2.setDefaultTimeout(12000);
  await page2.goto(`chrome-extension://${new URL(sw2.url()).host}/src/sidepanel/index.html`);
  await sleep(1500);
  const row2 = page2.getByText('Local Bridge', { exact: true });
  try { await row2.waitFor({ timeout: 5000 }); } catch {
    await page2.getByTestId('topbar-drawer').click();
    await page2.getByTestId('drawer-settings').click();
    await row2.waitFor();
  }
  await row2.click();

  await sleep(45000); // 梯子爬到 30s 档（1→2→4→8→16→30）
  const before = await cardState(page2);
  fs.writeFileSync(NM2, fs.readFileSync(NM_PATH)); // 「装 pkg」
  startDaemon();
  for (let i = 0; i < 40 && !sockExists(); i++) await sleep(250);
  const o = await observeFollow(page2, 'connected/true', 'connected', 60000);
  await snap(page2, 'cold-autoflip');
  const ok = before === 'install' && o.tTruth !== null && o.tCard !== null && o.tCard <= 32000;
  record('6-冷退避-装完不点按钮自动翻转', ok ? 'PASS' : 'FAIL',
    `装前卡片=${before} · 桥 connected@${o.tTruth}ms · 卡片翻转@${o.tCard}ms（期望 ≤32000 = 退避上限 30s + 轮询 1.5s）`);
  await ctx2.close();
  killDaemon();
} catch (e) { record('6-冷退避-装完不点按钮自动翻转', 'ERROR', e.message); }

fs.writeFileSync(`${REPORT}/results-${TAG}.json`, JSON.stringify(results, null, 2));
const fails = results.filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
console.log(`\n== [${TAG}] ${results.length} checks, ${fails.length} fail/error ==`);
process.exit(fails.length ? 1 : 0);
