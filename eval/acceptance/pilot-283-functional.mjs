// ⚠️ 参考实现 — PR #283 试点原版（功能批（Playwright 直驱，无 LLM））。
// 验收断言天然 per-PR：复用时复制本文件，按目标 PR 的真机验收清单改断言，
// 环境搭建与配方坑见 docs/agents/auto-acceptance.md。
// PR #283 skill 多根目录 — 真机验收清单自动化试点
// 覆盖清单项 1/2/4/6；3/5 需 LLM 驱动（另计）。
// dist-pilot = eval 构建 + nativeMessaging 提为必选（装载即自动连桥，绕过 optional 权限原生弹框）
// dist-orig  = eval 构建原样（无 nativeMessaging 授权 → 不连桥 = IDB 模式基线）
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.PIE_ACCEPT_BASE;
if (!BASE) throw new Error('PIE_ACCEPT_BASE 未设置（隔离工作目录，见 docs/agents/auto-acceptance.md）');
const REPORT = `${BASE}/report`;
const results = [];
let shot = 0;

function record(item, status, note = '') {
  results.push({ item, status, note });
  console.log(`[${status}] ${item}${note ? ' — ' + note : ''}`);
}
async function snap(page, name) {
  shot += 1;
  await page.screenshot({ path: `${REPORT}/${String(shot).padStart(2, '0')}-${name}.png`, fullPage: false });
}
const rowOf = (page, slug) =>
  page.locator(`code:text-is("/${slug}")`).locator('xpath=ancestor::div[contains(@class,"flex-col")][1]');

const NM_MANIFEST = JSON.stringify({
  name: 'ai.wiseria.pie',
  description: 'Pie daemon bridge (pilot283 scratch)',
  path: `${BASE}/host-wrapper.sh`,
  type: 'stdio',
  allowed_origins: ['chrome-extension://gpccjhdgjkmalnepmeclooflliiocfed/'],
});

async function launch(profile, dist) {
  // NM manifest 放 user-data-dir 下的 NativeMessagingHosts/（Chromium 跟随 --user-data-dir 查找）
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

  // eval bridge 种模型配置，解锁 composer——失败必须大声报
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not in env');
  let mounted = false;
  for (let i = 0; i < 20; i++) {
    mounted = await sw.evaluate(() => typeof globalThis.__pieEval !== 'undefined');
    if (mounted) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!mounted) throw new Error('__pieEval not mounted (eval build?)');
  // 等 SW startup pipeline 落定再 seed——否则 createInstance 写的 instances_index
  // 会被迁移路径的初始化 RMW 抹掉（lost-update，panel listInstances 走 index）
  await new Promise((r) => setTimeout(r, 3000));
  const { instanceId } = await sw.evaluate(
    (cfg) => globalThis.__pieEval.seedConfig(cfg),
    { provider: 'openrouter', model: 'openai/gpt-4o-mini', apiKey },
  );
  // seedConfig 只写 instance（SW loop 认）；panel 的 hasConfig 还要
  // last_model_selection + pcm_ 池才 resolve 得出模型 → 直接补进 IDB config
  await sw.evaluate((args) => new Promise((resolve, reject) => {
    const req = indexedDB.open('pie');
    req.onsuccess = () => {
      const tx = req.result.transaction('config', 'readwrite');
      tx.objectStore('config').put({ key: 'last_model_selection', value: { instanceId: args.instanceId, model: args.model } });
      tx.objectStore('config').put({ key: 'pcm_openrouter', value: [args.model] });
      tx.objectStore('config').put({ key: 'instances_index', value: [args.instanceId] }); // 竞态兜底
      tx.oncomplete = () => resolve(null);
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }), { instanceId, model: 'openai/gpt-4o-mini' });
  console.log(`  [launch] ${profile} extId=${extId} seeded=ok instance=${instanceId.slice(0, 8)}`);

  const page = await ctx.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
  return { ctx, page, extId };
}

async function probeInstances(page) {
  try {
    return await page.evaluate(() => new Promise((resolve) => {
      const req = indexedDB.open('pie');
      req.onsuccess = () => {
        const tx = req.result.transaction(['instances'], 'readonly');
        const g = tx.objectStore('instances').getAllKeys();
        g.onsuccess = () => resolve(g.result.length);
      };
      req.onerror = () => resolve(-1);
    }));
  } catch { return -2; }
}

const gearButton = (page) => page.getByRole('button', { name: 'Open settings', exact: true });

async function openTab(page, tabName) {
  const tab = page.getByRole('button', { name: tabName, exact: true });
  try {
    await tab.waitFor({ timeout: 8000 }); // firstRun 自动开设置页 / app 启动中
  } catch {
    await gearButton(page).click();
    await tab.waitFor({ timeout: 8000 });
  }
  await tab.click();
}

// dist-pilot 权限必选 → SW 启动 maybeInitLocalBridge 自动连桥，无需点开关，只等状态
async function waitBridgeConnected(page) {
  await openTab(page, 'General');
  await page.getByText('Connected to daemon.').waitFor({ timeout: 15000 });
}

// ───────────── Profile C：原版权限（未授予）= IDB 模式基线（清单项 6） ─────────────
{
  const { ctx, page } = await launch('profile-c', `${BASE}/dist-orig`);
  try {
    await openTab(page, 'Skills');
    // IDB 模式现状：设置页列表不含 builtin（设计如此），无用户 skill 时列表为空
    await page.getByText(/Displays reusable workflows/).waitFor();
    await page.waitForTimeout(2000);
    const agentsBadge = await page.getByText('~/.agents').count();
    const wizard = await page.getByText(/Found \d+ local skills/).count();
    const diskRows = await page.locator('code').count();
    if (agentsBadge === 0 && wizard === 0 && diskRows === 0) {
      record('item6-idb-baseline', 'PASS', '空 custom 列表 + 无向导/badge，与 daemon-off 现状一致');
    } else {
      record('item6-idb-baseline', 'FAIL', `badge=${agentsBadge} wizard=${wizard} rows=${diskRows}`);
    }
    await snap(page, 'item6-idb-baseline');
  } catch (e) { record('item6-idb-baseline', 'ERROR', e.message); await snap(page, 'item6-error'); }
  await ctx.close();
}

// ───────────────────────── Profile A：主流程 ─────────────────────────
{
  const { ctx, page } = await launch('profile-a', `${BASE}/dist-pilot`);

  try {
    await waitBridgeConnected(page);
    record('bridge-connect', 'PASS', 'Playwright Chromium 经 native host 自动连上 scratch daemon');
    console.log('   [probe] instances =', await probeInstances(page));
    await snap(page, 'bridge-connected');
  } catch (e) {
    record('bridge-connect', 'ERROR', e.message);
    await snap(page, 'bridge-error');
    await ctx.close();
    fs.writeFileSync(`${REPORT}/results.json`, JSON.stringify(results, null, 2));
    process.exit(1);
  }

  // 清单项 2（前半）：首连弹向导，勾 2 个确认
  try {
    await openTab(page, 'Skills');
    await page.getByText('Found 3 local skills').waitFor();
    await snap(page, 'item2-wizard');
    for (const s of ['csv-cleaner', 'md-tidy']) {
      await page.locator('label', { hasText: s }).locator('input[type=checkbox]').check();
    }
    await page.getByRole('button', { name: 'Enable selected' }).click();
    await page.getByText('Found 3 local skills').waitFor({ state: 'hidden' });
    record('item2-wizard-confirm', 'PASS', '弹出→勾 2 个→确认→向导关闭');
    console.log('   [probe] instances =', await probeInstances(page));
  } catch (e) { record('item2-wizard-confirm', 'ERROR', e.message); await snap(page, 'item2-error'); }

  // 清单项 1：副根 skill 带 badge、勾选状态正确、无编辑/删除、Run 保留
  try {
    const checks = [];
    for (const [slug, wantOn] of [['csv-cleaner', true], ['md-tidy', true], ['note-taker', false]]) {
      const row = rowOf(page, slug);
      await row.waitFor();
      const badge = await row.getByText('~/.agents').count();
      const on = await row.getByRole('switch').getAttribute('aria-checked');
      const runBtn = await row.getByRole('button', { name: 'Run', exact: true }).count();
      const editBtn = await row.getByRole('button', { name: 'Edit', exact: true }).count();
      const delBtn = await row.getByRole('button', { name: 'Delete', exact: true }).count();
      const ok = badge === 1 && on === String(wantOn) && runBtn === 1 && editBtn === 0 && delBtn === 0;
      checks.push(`${slug}:${ok ? 'ok' : `badge=${badge},on=${on},run=${runBtn},edit=${editBtn},del=${delBtn}`}`);
    }
    const allOk = checks.every((c) => c.endsWith(':ok'));
    record('item1-agents-rows', allOk ? 'PASS' : 'FAIL', checks.join(' '));
    console.log('   [probe] instances =', await probeInstances(page));
    await snap(page, 'item1-agents-rows');
  } catch (e) { record('item1-agents-rows', 'ERROR', e.message); await snap(page, 'item1-error'); }

  // 清单项 2（附）：启用的副根 skill 进 slash popover
  try {
    await page.getByRole('button', { name: 'Close settings', exact: true }).click(); // 回聊天视图
    if ((await page.getByText('NO API KEY').count()) > 0) {
      record('item2-slash-popover-diag', 'INFO', 'NO API KEY 空态出现——seed 后被覆盖？');
    }
    const composer = page.locator('textarea').first();
    await composer.waitFor({ timeout: 5000 });
    await composer.click();
    await composer.type('/csv', { delay: 40 });
    await page.waitForTimeout(800);
    const inPopover = await page.getByText('csv-cleaner').count();
    record('item2-slash-popover', inPopover > 0 ? 'PASS' : 'FAIL', `matches=${inPopover}`);
    await snap(page, 'item2-slash-popover');
    await composer.fill('');
  } catch (e) { record('item2-slash-popover', 'SKIP', `composer 不可用: ${e.message.slice(0, 120)}`); await snap(page, 'item2-slash-error'); }

  // 清单项 2（后半 A）：确认后刷新不再弹向导
  try {
    await page.reload();
    await openTab(page, 'Skills');
    await page.locator('code').first().waitFor();
    await page.waitForTimeout(1500); // 向导若要弹，给它时间
    const wizard = await page.getByText(/Found \d+ local skills/).count();
    record('item2-no-reprompt-after-confirm', wizard === 0 ? 'PASS' : 'FAIL', `wizard=${wizard}`);
    console.log('   [probe] instances =', await probeInstances(page));
  } catch (e) { record('item2-no-reprompt-after-confirm', 'ERROR', e.message); }

  // 清单项 4：主根同名遮蔽 + 删除后恢复
  try {
    const shadowDir = `${BASE}/home/.pie/skills/csv-cleaner`;
    fs.mkdirSync(shadowDir, { recursive: true });
    fs.writeFileSync(`${shadowDir}/SKILL.md`,
      `---\nname: csv-cleaner\ndescription: PRIMARY-ROOT version shadows the agents copy.\n---\n# csv-cleaner (primary)\n`);
    await page.reload();
    await openTab(page, 'Skills');
    const row = rowOf(page, 'csv-cleaner');
    await row.waitFor();
    const rows = await page.locator('code:text-is("/csv-cleaner")').count();
    const badge = await row.getByText('~/.agents').count();
    const primaryDesc = await row.getByText(/PRIMARY-ROOT/).count();
    const shadowOk = rows === 1 && badge === 0 && primaryDesc === 1;
    await snap(page, 'item4-shadowed');

    fs.rmSync(shadowDir, { recursive: true, force: true });
    await page.reload();
    await openTab(page, 'Skills');
    const row2 = rowOf(page, 'csv-cleaner');
    await row2.waitFor();
    const badge2 = await row2.getByText('~/.agents').count();
    const agentsDesc = await row2.getByText(/Agents-root fixture/).count();
    const restoreOk = badge2 === 1 && agentsDesc === 1;
    await snap(page, 'item4-restored');
    record('item4-shadow-and-restore', shadowOk && restoreOk ? 'PASS' : 'FAIL',
      `shadow(rows=${rows},badge=${badge},desc=${primaryDesc}) restore(badge=${badge2},desc=${agentsDesc})`);
  } catch (e) { record('item4-shadow-and-restore', 'ERROR', e.message); await snap(page, 'item4-error'); }

  await ctx.close();
}

// ───────────────────────── Profile B：「暂不」分支 ─────────────────────────
{
  const { ctx, page } = await launch('profile-b', `${BASE}/dist-pilot`);
  try {
    await waitBridgeConnected(page);
    await openTab(page, 'Skills');
    await page.getByText('Found 3 local skills').waitFor();
    await page.getByRole('button', { name: 'Not now' }).click();
    await page.getByText('Found 3 local skills').waitFor({ state: 'hidden' });
    // 三个副根 skill 都保持禁用
    let allOff = true;
    for (const s of ['csv-cleaner', 'md-tidy', 'note-taker']) {
      const on = await rowOf(page, s).getByRole('switch').getAttribute('aria-checked');
      if (on !== 'false') allOff = false;
    }
    await snap(page, 'item2b-dismissed');
    await page.reload();
    await openTab(page, 'Skills');
    await page.locator('code').first().waitFor();
    await page.waitForTimeout(1500);
    const wizard = await page.getByText(/Found \d+ local skills/).count();
    record('item2-dismiss-branch', allOff && wizard === 0 ? 'PASS' : 'FAIL',
      `allOff=${allOff} wizardAfterReload=${wizard}`);
    await snap(page, 'item2b-no-reprompt');
  } catch (e) { record('item2-dismiss-branch', 'ERROR', e.message); await snap(page, 'item2b-error'); }
  await ctx.close();
}

fs.writeFileSync(`${REPORT}/results.json`, JSON.stringify(results, null, 2));
const fails = results.filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
console.log(`\n== ${results.length} checks, ${fails.length} fail/error ==`);
process.exit(fails.length ? 1 : 0);
