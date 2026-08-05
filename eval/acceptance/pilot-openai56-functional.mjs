// PR fix/openai-gpt56-chat-completions 真机验收 — 功能批（纯扩展侧，无 daemon）。
// 环境搭建 / 配方坑见 docs/agents/auto-acceptance.md。
//
// 断言核心：真实 Chromium + 真实扩展（SW loop / panel probe 两条 fetch 路径），
// ctx.route 拦截 api.openai.com（需 PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1
// 才能拦到 SW 发起的请求，PR#349 配方），假 key + mock SSE，对**出站请求体**做确定性断言：
//   S1 chat（gpt-5.6-sol + tools）→ body.reasoning_effort === "none" 且无 max_tokens
//   S2 chat（gpt-4o + tools）→ body 无 reasoning_effort（回归护栏）
//   S3 设置页 Test 按钮（gpt-5.6-sol 探针）→ max_completion_tokens===16 且无 max_tokens，
//      UI 不出现 "Test failed"
// 同一脚本跑 main 的 dist 做对照：S1/S3 必须 FAIL，证明断言灵敏度（非环境巧合）。
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.PIE_ACCEPT_BASE;
if (!BASE) throw new Error('PIE_ACCEPT_BASE 未设置');
if (process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS !== '1')
  throw new Error('需 PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1（否则拦不到 SW fetch）');
const DIST = process.env.PIE_ACCEPT_DIST || `${BASE}/dist-pr`;
const TAG = process.env.PIE_ACCEPT_TAG || 'pr';
const REPORT = `${BASE}/report`;
fs.mkdirSync(REPORT, { recursive: true });
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

// ── mock SSE：纯文本回复 + stop（loop 视纯文本为终止；探针只要 200 即成功）──
const SSE = [
  'data: {"choices":[{"delta":{"content":"done"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
  'data: [DONE]',
].join('\n\n') + '\n\n';

const captures = []; // {url, body} 按到达序
const ctx = await chromium.launchPersistentContext(`${BASE}/profile-${TAG}`, {
  headless: false,
  viewport: { width: 420, height: 900 },
  locale: 'en-US',
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--lang=en-US'],
});
await ctx.route('**://api.openai.com/**', async (route) => {
  const req = route.request();
  let body = null;
  try { body = JSON.parse(req.postData() ?? 'null'); } catch { /* keep null */ }
  captures.push({ url: req.url(), body });
  await route.fulfill({ status: 200, contentType: 'text/event-stream', body: SSE });
});

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
for (let i = 0; i < 20; i++) {
  if (await sw.evaluate(() => typeof globalThis.__pieEval !== 'undefined')) break;
  await sleep(250);
}
await sleep(3000); // 等 startup pipeline，防 instances_index lost-update

async function seed(model) {
  const { instanceId } = await sw.evaluate(
    (cfg) => globalThis.__pieEval.seedConfig(cfg),
    { provider: 'openai', model, apiKey: 'sk-fake-acceptance' },
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
  }), { instanceId, model });
  return instanceId;
}

async function runTask(scenario) {
  const from = captures.length;
  const { sessionId } = await sw.evaluate(
    (goal) => globalThis.__pieEval.startTask({ goal }),
    'Reply with the single word done. Do not use any tools.',
  );
  await sw.evaluate(
    (opts) => globalThis.__pieEval.waitForDone(opts),
    { sessionId, timeoutMs: 30000 },
  );
  const hit = captures.slice(from).find((c) => c.url.includes('/chat/completions') && c.body);
  if (!hit) { record(scenario, 'ERROR', '未捕获到 chat/completions 请求（SW 拦截失效？）'); return null; }
  return hit.body;
}

// ── S1: chat loop @ gpt-5.6-sol —— tools 存在 + reasoning_effort none + 无 max_tokens ──
await seed('gpt-5.6-sol');
{
  const body = await runTask('S1 chat gpt-5.6-sol');
  if (body) {
    const toolsOk = Array.isArray(body.tools) && body.tools.length > 0;
    const effortOk = body.reasoning_effort === 'none';
    const noMaxTokens = !('max_tokens' in body);
    if (toolsOk && effortOk && noMaxTokens)
      record('S1 chat gpt-5.6-sol: tools+reasoning_effort none 且无 max_tokens', 'PASS',
        `tools=${body.tools.length} reasoning_effort=${body.reasoning_effort}`);
    else
      record('S1 chat gpt-5.6-sol: tools+reasoning_effort none 且无 max_tokens', 'FAIL',
        `tools=${toolsOk} reasoning_effort=${JSON.stringify(body.reasoning_effort)} max_tokens=${JSON.stringify(body.max_tokens)}`);
  }
}

// ── S2: chat loop @ gpt-4o —— 不得带 reasoning_effort（回归护栏）──
await seed('gpt-4o');
{
  const body = await runTask('S2 chat gpt-4o');
  if (body) {
    if (!('reasoning_effort' in body))
      record('S2 chat gpt-4o: 无 reasoning_effort', 'PASS', `model=${body.model}`);
    else
      record('S2 chat gpt-4o: 无 reasoning_effort', 'FAIL', `reasoning_effort=${JSON.stringify(body.reasoning_effort)}`);
  }
}

// ── S3: 设置页 → Models → OpenAI 实例 → Test 按钮（真实 UI 探针路径，panel fetch）──
await seed('gpt-5.6-sol'); // Test 探针取 registry 首模型 = gpt-5.6-sol
const page = await ctx.newPage();
page.setDefaultTimeout(15000);
await page.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
try {
  // 进设置（firstRun 已被 seed 消解；chat 空态 CTA 撞名，用 exact）
  const gear = page.getByRole('button', { name: 'Open settings', exact: true });
  if (await gear.count()) await gear.click();
  await page.getByText('Model Configs', { exact: true }).click();
  await snap(page, 'models-page');
  // 展开 OpenAI 实例编辑器 → 点 Test
  await page.getByText('OpenAI', { exact: true }).first().click();
  const from = captures.length;
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await sleep(2500);
  await snap(page, 'after-test');
  const hit = captures.slice(from).find((c) => c.url.includes('/chat/completions') && c.body);
  const failedVisible = await page.getByText(/Test failed/).count();
  if (!hit) record('S3 Test 探针', 'ERROR', '未捕获探针请求');
  else {
    const ok = hit.body.max_completion_tokens === 16 && !('max_tokens' in hit.body) && failedVisible === 0;
    record('S3 Test 探针: max_completion_tokens=16 且无 max_tokens 且 UI 无 Test failed',
      ok ? 'PASS' : 'FAIL',
      `max_completion_tokens=${JSON.stringify(hit.body.max_completion_tokens)} max_tokens=${JSON.stringify(hit.body.max_tokens)} model=${hit.body.model} failedVisible=${failedVisible}`);
  }
} catch (e) {
  await snap(page, 'error');
  record('S3 Test 探针', 'ERROR', String(e).slice(0, 300));
}

fs.writeFileSync(`${REPORT}/results-${TAG}.json`, JSON.stringify({ results, captures: captures.map(c => ({ url: c.url, body: c.body })) }, null, 2));
await ctx.close();
const fails = results.filter((r) => r.status !== 'PASS').length;
console.log(`\n== ${TAG}: ${results.length - fails}/${results.length} PASS ==`);
