// ⚠️ 参考实现 — PR #283 试点原版（LLM 驱动批（读 ~/.pie/acceptance.env））。
// 验收断言天然 per-PR：复用时复制本文件，按目标 PR 的真机验收清单改断言，
// 环境搭建与配方坑见 docs/agents/auto-acceptance.md。
// PR #283 真机验收清单项 3/5 — LLM 驱动（deepseek，读 PIE_EVAL_* 三元组）
// 项 5：headless startTask，LLM 调 delete_skill 删副根 skill → read_only + 磁盘不变
// 项 3：composer 发任务 → run_skill_script 首跑弹授权卡 → Allow → py/sh/ts 执行成功
//       断言全落磁盘证据：grants.json / audit.jsonl / workspace/ / 既有文件未变
import { chromium } from 'playwright';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const BASE = process.env.PIE_ACCEPT_BASE;
if (!BASE) throw new Error('PIE_ACCEPT_BASE 未设置（隔离工作目录，见 docs/agents/auto-acceptance.md）');
const DIST = `${BASE}/dist-pilot`;
const REPORT = `${BASE}/report`;
const HOME = `${BASE}/home`;
const SD = `${HOME}/.agents/skills/script-demo`;
const results = [];
let shot = 20; // 接在功能批截图之后

const PROVIDER = process.env.PIE_EVAL_PROVIDER;
const MODEL = process.env.PIE_EVAL_MODEL;
const API_KEY = process.env.PIE_EVAL_API_KEY;
if (!PROVIDER || !MODEL || !API_KEY) throw new Error('PIE_EVAL_* 未配置（source ~/.pie/acceptance.env）');

function record(item, status, note = '') {
  results.push({ item, status, note });
  console.log(`[${status}] ${item}${note ? ' — ' + note : ''}`);
}
async function snap(page, name) {
  shot += 1;
  await page.screenshot({ path: `${REPORT}/${String(shot).padStart(2, '0')}-${name}.png` });
}
const hashFile = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
const fixtureHashes = () => ({
  md: hashFile(`${SD}/SKILL.md`),
  py: hashFile(`${SD}/scripts/hello.py`),
  sh: hashFile(`${SD}/scripts/hello.sh`),
  ts: hashFile(`${SD}/scripts/hello.ts`),
});

const NM_MANIFEST = JSON.stringify({
  name: 'ai.wiseria.pie',
  description: 'Pie daemon bridge (pilot283 scratch)',
  path: `${BASE}/host-wrapper.sh`,
  type: 'stdio',
  allowed_origins: ['chrome-extension://gpccjhdgjkmalnepmeclooflliiocfed/'],
});

// ── launch（同功能批配方；内置模型故不写 pcm_）──
fs.mkdirSync(`${BASE}/profile-llm/NativeMessagingHosts`, { recursive: true });
fs.writeFileSync(`${BASE}/profile-llm/NativeMessagingHosts/ai.wiseria.pie.json`, NM_MANIFEST);
const ctx = await chromium.launchPersistentContext(`${BASE}/profile-llm`, {
  headless: false,
  viewport: { width: 420, height: 900 },
  locale: 'en-US',
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--lang=en-US'],
});
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
for (let i = 0; i < 20; i++) {
  if (await sw.evaluate(() => typeof globalThis.__pieEval !== 'undefined')) break;
  await new Promise((r) => setTimeout(r, 250));
}
await new Promise((r) => setTimeout(r, 3000)); // 等 startup pipeline，防 index lost-update
const { instanceId } = await sw.evaluate(
  (cfg) => globalThis.__pieEval.seedConfig(cfg),
  { provider: PROVIDER, model: MODEL, apiKey: API_KEY },
);
await sw.evaluate((args) => new Promise((resolve, reject) => {
  const req = indexedDB.open('pie');
  req.onsuccess = () => {
    const tx = req.result.transaction('config', 'readwrite');
    tx.objectStore('config').put({ key: 'last_model_selection', value: { instanceId: args.instanceId, model: args.model } });
    tx.objectStore('config').put({ key: 'instances_index', value: [args.instanceId] });
    tx.oncomplete = () => resolve(null);
    tx.onerror = () => reject(tx.error);
  };
  req.onerror = () => reject(req.error);
}), { instanceId, model: MODEL });
console.log(`  [launch] profile-llm seeded ${PROVIDER}/${MODEL} instance=${instanceId.slice(0, 8)}`);

const page = await ctx.newPage();
page.setDefaultTimeout(15000);
await page.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);

async function openTab(name) {
  const tab = page.getByRole('button', { name, exact: true });
  try { await tab.waitFor({ timeout: 8000 }); }
  catch {
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await tab.waitFor({ timeout: 8000 });
  }
  await tab.click();
}

// 桥连接 + 向导全选启用（script-demo 要进 enabled 目录 LLM 才可见）
await openTab('General');
await page.getByText('Connected to daemon.').waitFor({ timeout: 15000 });
await openTab('Skills');
await page.getByText(/Found \d+ local skills/).waitFor();
await page.getByRole('button', { name: 'Select all' }).click();
await page.getByRole('button', { name: 'Enable selected' }).click();
await page.getByText(/Found \d+ local skills/).waitFor({ state: 'hidden' });
console.log('  [setup] wizard: all agents skills enabled');

// ───────────── 清单项 5：delete_skill 副根 → read_only，磁盘不变 ─────────────
try {
  const { sessionId } = await sw.evaluate(
    (goal) => globalThis.__pieEval.startTask({ goal }),
    'Use the delete_skill tool to delete the skill named "md-tidy". If the tool returns an error, report the exact error message verbatim in your final answer.',
  );
  const { status } = await sw.evaluate(
    (args) => globalThis.__pieEval.waitForDone(args),
    { sessionId, timeoutMs: 180000 },
  );
  const trace = await sw.evaluate((args) => globalThis.__pieEval.getTrace(args), { sessionId });
  const calledDelete = trace.steps.some((s) => s.tool === 'delete_skill');
  const stillOnDisk = fs.existsSync(`${HOME}/.agents/skills/md-tidy/SKILL.md`);
  const answerMentionsReadOnly = /read.?only/i.test(trace.answer);
  const ok = status === 'done' && calledDelete && stillOnDisk && answerMentionsReadOnly;
  record('item5-delete-readonly', ok ? 'PASS' : 'FAIL',
    `status=${status} calledDelete=${calledDelete} fileIntact=${stillOnDisk} answerHasReadOnly=${answerMentionsReadOnly}` +
    (ok ? '' : ` answer="${trace.answer.slice(0, 200)}"`));
} catch (e) { record('item5-delete-readonly', 'ERROR', e.message); }

// ───────────── 清单项 3：脚本首跑授权卡 → Allow → py/sh/ts 执行 ─────────────
try {
  const before = fixtureHashes();

  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  const composer = page.locator('textarea').first();
  await composer.waitFor();
  await composer.fill(
    'Use the run_skill_script tool three times on the skill "script-demo": first entry "hello.py", then entry "hello.sh", then entry "hello.ts". After all three, reply with their combined outputs.',
  );
  await composer.press('Enter');

  // 首跑授权卡 → Allow
  await page.getByText('Allow this skill to run scripts').waitFor({ timeout: 120000 });
  await snap(page, 'item3-grant-card');
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  record('item3-grant-card', 'PASS', '首跑弹信封授权卡，Playwright 点 Allow');

  // 磁盘证据轮询：audit 出现 py/sh/ts 三条（LLM 串行调用，宽限 5 分钟）
  const auditPath = `${HOME}/.pie/logs/audit.jsonl`;
  const deadline = Date.now() + 300000;
  let entries = [];
  while (Date.now() < deadline) {
    if (fs.existsSync(auditPath)) {
      entries = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const ran = new Set(entries.filter((e) => e.skillName === 'script-demo' && e.exitCode === 0).map((e) => e.entry));
      if (ran.has('hello.py') && ran.has('hello.sh') && ran.has('hello.ts')) break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  const ran = new Set(entries.filter((e) => e.skillName === 'script-demo' && e.exitCode === 0).map((e) => e.entry));
  const grants = fs.existsSync(`${HOME}/.pie/grants.json`)
    ? JSON.parse(fs.readFileSync(`${HOME}/.pie/grants.json`, 'utf8')) : null;
  const grantOk = JSON.stringify(grants ?? {}).includes('script-demo');
  const workspaceOk = fs.existsSync(`${SD}/workspace`);
  const after = fixtureHashes();
  const intact = JSON.stringify(before) === JSON.stringify(after);
  const ok = ran.size === 3 && grantOk && workspaceOk && intact;
  record('item3-scripts-exec', ok ? 'PASS' : 'FAIL',
    `ran=[${[...ran].join(',')}] grant=${grantOk} workspace=${workspaceOk} fixturesIntact=${intact}`);
  await snap(page, 'item3-after-exec');
} catch (e) { record('item3-scripts-exec', 'ERROR', e.message); await snap(page, 'item3-error'); }

await ctx.close();
fs.writeFileSync(`${REPORT}/results-llm.json`, JSON.stringify(results, null, 2));
const fails = results.filter((r) => r.status !== 'PASS');
console.log(`\n== LLM 批 ${results.length} checks, ${fails.length} fail/error ==`);
process.exit(fails.length ? 1 : 0);
