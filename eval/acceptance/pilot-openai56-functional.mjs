// PR fix/openai-gpt56-chat-completions 真机验收 — 功能批（纯扩展侧，无 daemon）。
// 环境搭建 / 配方坑见 docs/agents/auto-acceptance.md。
//
// 断言核心：真实 Chromium + 真实扩展（SW loop / panel probe 两条 fetch 路径），
// ctx.route 拦截 api.openai.com（需 PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1
// 才能拦到 SW 发起的请求，PR#349 配方），假 key + mock Responses SSE，
// 对**出站请求体**做确定性断言（openai provider 已整体迁 /v1/responses）：
//   S1 chat（gpt-5.6-sol + tools）→ URL=/v1/responses，flat tools + store:false，
//      无 reasoning_effort / max_tokens
//   S2 chat（gpt-4o + tools）→ 同走 /v1/responses（全 provider 迁移护栏）
//   S3 设置页 Test 按钮探针 → /v1/responses + max_output_tokens:16，UI 无 "Test failed"
// 同一脚本跑 main 的 dist 做对照：三项必须 FAIL（main 还在打 chat/completions），
// 证明断言灵敏度（非环境巧合）。
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

// ── mock SSE：Responses API typed events，纯文本回复 + completed（loop 视纯文本为
// 终止；探针只要 200 即成功）。老 wire（chat/completions）收到这套事件会当没
// 讲完 → 兜底 done，仍能跑完不悬死。──
const SSE_EVENTS = [
  { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'done' },
  { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
];
const SSE = SSE_EVENTS.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  + 'data: [DONE]\n\n'; // 老 wire 对照跑需要 [DONE] 才收尾

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
  const hit = captures.slice(from).find((c) => c.body);
  if (!hit) { record(scenario, 'ERROR', '未捕获到出站请求（SW 拦截失效？）'); return null; }
  return hit;
}

const isResponsesWire = (hit) =>
  hit.url.endsWith('/v1/responses') && Array.isArray(hit.body.input) && hit.body.store === false;

// ── S1: chat loop @ gpt-5.6-sol —— /v1/responses + flat tools，无 reasoning_effort/max_tokens ──
await seed('gpt-5.6-sol');
{
  const hit = await runTask('S1 chat gpt-5.6-sol');
  if (hit) {
    const toolsOk = Array.isArray(hit.body.tools) && hit.body.tools.length > 0 && typeof hit.body.tools[0].name === 'string';
    const clean = !('reasoning_effort' in hit.body) && !('max_tokens' in hit.body);
    if (isResponsesWire(hit) && toolsOk && clean)
      record('S1 chat gpt-5.6-sol: /v1/responses + flat tools + store:false', 'PASS',
        `url=${hit.url} tools=${hit.body.tools.length}`);
    else
      record('S1 chat gpt-5.6-sol: /v1/responses + flat tools + store:false', 'FAIL',
        `url=${hit.url} store=${JSON.stringify(hit.body.store)} tools0=${JSON.stringify(hit.body.tools?.[0])?.slice(0, 80)} reasoning_effort=${JSON.stringify(hit.body.reasoning_effort)}`);
  }
}

// ── S2: chat loop @ gpt-4o —— 整个 openai provider 同走 /v1/responses（迁移护栏）──
await seed('gpt-4o');
{
  const hit = await runTask('S2 chat gpt-4o');
  if (hit) {
    if (isResponsesWire(hit)) record('S2 chat gpt-4o: 同走 /v1/responses', 'PASS', `url=${hit.url}`);
    else record('S2 chat gpt-4o: 同走 /v1/responses', 'FAIL', `url=${hit.url}`);
  }
}

// ── S3: 设置页 → Model Configs → OpenAI 实例 → Test（真实 UI 探针路径，panel fetch）──
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
  const hit = captures.slice(from).find((c) => c.body);
  const failedVisible = await page.getByText(/Test failed/).count();
  if (!hit) record('S3 Test 探针', 'ERROR', '未捕获探针请求');
  else {
    const ok = isResponsesWire(hit) && hit.body.max_output_tokens === 16
      && !('max_tokens' in hit.body) && failedVisible === 0;
    record('S3 Test 探针: /v1/responses + max_output_tokens=16 且 UI 无 Test failed',
      ok ? 'PASS' : 'FAIL',
      `url=${hit.url} max_output_tokens=${JSON.stringify(hit.body.max_output_tokens)} max_tokens=${JSON.stringify(hit.body.max_tokens)} model=${hit.body.model} failedVisible=${failedVisible}`);
  }
} catch (e) {
  await snap(page, 'error');
  record('S3 Test 探针', 'ERROR', String(e).slice(0, 300));
}

fs.writeFileSync(`${REPORT}/results-${TAG}.json`, JSON.stringify({ results, captures: captures.map(c => ({ url: c.url, body: c.body })) }, null, 2));
await ctx.close();
const fails = results.filter((r) => r.status !== 'PASS').length;
console.log(`\n== ${TAG}: ${results.length - fails}/${results.length} PASS ==`);
