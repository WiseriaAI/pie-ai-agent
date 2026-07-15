// PR #314（feat #296 skill 脚本 I/O 契约收口）真机验收 — LLM 驱动批。
// 环境搭建 / 配方坑见 docs/agents/auto-acceptance.md；结构参照 pilot-283-llm.mjs。
//
// 覆盖断言设计里归入 llm 批的清单项：
//   llm-1/2  首跑未授权 skill → 授权卡弹出（composer 发任务 + Playwright 点 Allow & run）
//            → grants.json 出现信封条目
//   llm-3    print 型脚本 → 原始 observation 含 <untrusted_skill_content> 包裹的 stdout，
//            且 stdout JSON 里 cwd == PIE_WORKSPACE == ~/.pie/sessions/<sid>/workspace、
//            PIE_SKILL_DIR 指向主根 skill 目录（main 上三断言必 FAIL = would-fail-on-main）
//   llm-4    再跑同 skill 不再弹卡（grant 不失效；grants.json 无新增条目）
//   llm-5    写文件型脚本 → observation 含 untrusted_skill_output_list 文件清单（名字+字节），
//            磁盘 $PIE_ACCEPT_BASE/home/.pie/sessions/<sid>/workspace/ 真有该文件
//   llm-6    read_skill_output 读回 → 该 tool 成功且内容与磁盘一致
//   llm-7    静默型脚本 → observation 含 "a returned value is discarded" 可行动提示
//   llm-8    两个 session 跑同一写文件脚本 → 两 workspace 各有同名文件、内容不同、互不覆盖
//   llm-9    副根 skill 跑脚本 → 副根目录树 before/after 快照零变化 + 功能正常（正控制）
//
// ⚠️ 证据通道说明（与 pilot-283-llm 的差异）：
//   __pieEval.getTrace 只覆盖 startTask 会话，而 startTask 的 sessionId 形如 `eval-1`，
//   会被 daemon 的 assertSessionId（严格 UUID 正则）拒掉 —— 本 PR 起 run_skill_script
//   必带 sessionId。所以全部脚本执行项都走 composer 真会话（UUID sid），原始 observation
//   证据改从 IDB `sessions` store 的 `${sid}:agent` 记录轮询捕获（loop 每步持久化 raw
//   agentMessages，done 时写 tombstone 清空——轮询保留最后一份非空快照即拿到全量 LLM IR）。
//   断言优先磁盘 / raw-IR 证据，不以对话文本为唯一证据；LLM 不听话（没调预期工具）记
//   FAIL 并附捕获到的 tool 调用序列。
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const BASE = process.env.PIE_ACCEPT_BASE;
if (!BASE) throw new Error('PIE_ACCEPT_BASE 未设置（隔离工作目录，见 docs/agents/auto-acceptance.md）');
if (!fs.existsSync(BASE)) throw new Error(`PIE_ACCEPT_BASE 不存在: ${BASE}`);
const REPO = '/Users/wenkang/repos/pie/pie-ai-agent';
const DIST = `${BASE}/dist-pilot`;
const REPORT = `${BASE}/report`;
const HOME = `${BASE}/home`;
const PIE = `${HOME}/.pie`;
const SESSIONS = `${PIE}/sessions`;
const PRIMARY_ROOT = `${PIE}/skills`;
const AGENTS_ROOT = `${HOME}/.agents/skills`;
const GRANTS = `${PIE}/grants.json`;
const AUDIT = `${PIE}/logs/audit.jsonl`;
const SOCK = `${PIE}/daemon.sock`;

const PROVIDER = process.env.PIE_EVAL_PROVIDER;
const MODEL = process.env.PIE_EVAL_MODEL;
const API_KEY = process.env.PIE_EVAL_API_KEY;
if (!PROVIDER || !MODEL || !API_KEY) throw new Error('PIE_EVAL_* 未配置（set -a; source ~/.pie/acceptance.env; set +a）');
if (!fs.existsSync(`${DIST}/manifest.json`)) throw new Error(`dist-pilot 不存在（先 pnpm build:eval + 提权 manifest）: ${DIST}`);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const results = [];
let shot = 40; // 接在 daemon-direct / functional 批截图之后

function record(item, status, note = '') {
  results.push({ item, status, note });
  console.log(`[${status}] ${item}${note ? ' — ' + note : ''}`);
}
async function snap(page, name) {
  shot += 1;
  try { await page.screenshot({ path: `${REPORT}/${String(shot).padStart(2, '0')}-${name}.png` }); } catch { /* best-effort */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hashFile = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
// macOS /tmp → /private/tmp symlink：脚本进程 process.cwd() 回 real path，env/期望值是逻辑路径。
const normPath = (p) => (typeof p === 'string' ? p.replace(/^\/private\//, '/') : p);

/** 复刻 src/lib/agent/tools/skill-script.ts formatBytes（清单项字节断言用）。 */
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${Math.round(kb / 1024)} MB`;
}

const grantsRaw = () => (fs.existsSync(GRANTS) ? fs.readFileSync(GRANTS, 'utf8') : '');
const grantCount = (raw) => (raw.match(/"skillName"/g) ?? []).length;

function auditEntries(sinceTs = 0) {
  if (!fs.existsSync(AUDIT)) return [];
  return fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter((e) => (e.ts ?? 0) >= sinceTs);
}
const auditHas = (sinceTs, skillName, entry) =>
  auditEntries(sinceTs).some((e) => e.skillName === skillName && e.entry === entry && e.exitCode === 0);

/** 目录树全保真快照：相对路径 + 目录标记 + 文件 size/mtime/sha256（副根零写入断言）。 */
function treeSnapshot(root) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      if (e.isDirectory()) { out.push({ rel: `${rel}/` }); walk(abs); }
      else if (e.isFile()) {
        const st = fs.statSync(abs);
        out.push({ rel, size: st.size, mtimeMs: st.mtimeMs, sha256: hashFile(abs) });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function listWorkspaceFiles(sid) {
  const ws = `${SESSIONS}/${sid}/workspace`;
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push(path.relative(ws, abs));
    }
  };
  walk(ws);
  return out.sort();
}

// ───────────────────────── fixtures（幂等：只在缺失时写，绝不碰真实 ~/）─────────────────────────
function writeIfMissing(p, content) {
  if (fs.existsSync(p)) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function ensureFixtures() {
  // 主根 io-probe：print / write / noop 三脚本（断言设计 fixture 清单）
  writeIfMissing(`${PRIMARY_ROOT}/io-probe/SKILL.md`,
    '---\nname: io-probe\ndescription: Acceptance fixture skill. Bundles print.ts (prints an env/cwd JSON line to stdout), write.ts (writes out.csv and sub/raw.json into the working directory), and noop.ts (returns a value without printing or writing).\n---\n# io-probe\n\nPR #314 I/O contract acceptance fixture.\n');
  writeIfMissing(`${PRIMARY_ROOT}/io-probe/scripts/print.ts`,
    'console.log(JSON.stringify({\n' +
    '  cwd: process.cwd(),\n' +
    '  argv: process.argv.slice(2),\n' +
    '  skillDir: process.env.PIE_SKILL_DIR ?? null,\n' +
    '  ws: process.env.PIE_WORKSPACE ?? null,\n' +
    '}));\n');
  writeIfMissing(`${PRIMARY_ROOT}/io-probe/scripts/write.ts`,
    'import fs from "node:fs";\n' +
    'const args = process.argv.slice(2);\n' +
    'if (args[0] === "--many") {\n' +
    '  const n = Number(args[1] ?? "60");\n' +
    '  for (let i = 0; i < n; i++) fs.writeFileSync(`bulk-${String(i).padStart(3, "0")}.txt`, `bulk ${i}`);\n' +
    '} else {\n' +
    '  const content = args[0] ?? "EMPTY";\n' +
    '  fs.writeFileSync("out.csv", content);\n' +
    '  fs.mkdirSync("sub", { recursive: true });\n' +
    '  fs.writeFileSync("sub/raw.json", JSON.stringify({ content }));\n' +
    '}\n');
  // #296 踩坑原型：export default 返回值——exit 0、零 stdout、零文件
  writeIfMissing(`${PRIMARY_ROOT}/io-probe/scripts/noop.ts`,
    'export default (_input: unknown) => ({ ok: true });\n');

  // 副根 agents-probe（唯一必须在副根的 fixture：零写入断言）
  writeIfMissing(`${AGENTS_ROOT}/agents-probe/SKILL.md`,
    '---\nname: agents-probe\ndescription: Agents-root fixture. write.ts writes agents-out.txt into the working directory.\n---\n# agents-probe\n');
  writeIfMissing(`${AGENTS_ROOT}/agents-probe/scripts/write.ts`,
    'import fs from "node:fs";\n' +
    'fs.writeFileSync("agents-out.txt", process.argv[2] ?? "AGENTS");\n');

  // 规模档 ≥30（283 教训：小规模全绿掩盖背压 blocker）。
  // pipeline 模式（fixtures.json 在 = pilot-314-fixtures.mjs 已在主根造过 fixture-1..32）跳过：
  // 副根同名会被主根遮蔽，只留 32 个僵尸目录、并让向导规模面证据失真。standalone 才落副根。
  if (!fs.existsSync(`${BASE}/fixtures.json`)) {
    for (let i = 1; i <= 32; i++) {
      writeIfMissing(`${AGENTS_ROOT}/fixture-${i}/SKILL.md`,
        `---\nname: fixture-${i}\ndescription: 规模档 fixture ${i}（含中文压多字节 UTF-8 切分路径）\n---\n# fixture-${i}\n`);
    }
  }

  writeIfMissing(`${BASE}/host-wrapper.sh`,
    `#!/bin/bash\nexport HOME=${HOME}\nexec bun ${REPO}/daemon/src/cli.ts host\n`);
  fs.chmodSync(`${BASE}/host-wrapper.sh`, 0o755);
  fs.mkdirSync(REPORT, { recursive: true });
}

async function ensureDaemon() {
  if (fs.existsSync(SOCK)) return;
  const p = spawn('bun', [`${REPO}/daemon/src/cli.ts`, 'daemon'], {
    env: { ...process.env, HOME },
    detached: true, stdio: 'ignore',
  });
  p.unref();
  for (let i = 0; i < 60 && !fs.existsSync(SOCK); i++) await sleep(250);
  if (!fs.existsSync(SOCK)) throw new Error(`daemon 未起（socket 不存在: ${SOCK}；注意 sun_path 104B 上限，BASE 须短路径）`);
  console.log('  [setup] scratch daemon started');
}

ensureFixtures();
await ensureDaemon();

// ───────────────────────── launch（283-llm 配方；内置模型故不写 pcm_）─────────────────────────
const NM_MANIFEST = JSON.stringify({
  name: 'ai.wiseria.pie',
  description: 'Pie daemon bridge (pilot314 scratch)',
  path: `${BASE}/host-wrapper.sh`,
  type: 'stdio',
  allowed_origins: ['chrome-extension://gpccjhdgjkmalnepmeclooflliiocfed/'],
});
fs.mkdirSync(`${BASE}/profile-llm314/NativeMessagingHosts`, { recursive: true });
fs.writeFileSync(`${BASE}/profile-llm314/NativeMessagingHosts/ai.wiseria.pie.json`, NM_MANIFEST);
const ctx = await chromium.launchPersistentContext(`${BASE}/profile-llm314`, {
  headless: false, // MV3 扩展需有头；daemon 授权 headless fail-closed → 必须开 panel 点卡
  viewport: { width: 420, height: 900 },
  locale: 'en-US',
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--lang=en-US'],
});
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
for (let i = 0; i < 20; i++) {
  if (await sw.evaluate(() => typeof globalThis.__pieEval !== 'undefined')) break;
  await sleep(250);
}
await sleep(3000); // 等 startup pipeline，防 instances_index lost-update
const { instanceId } = await sw.evaluate(
  (cfg) => globalThis.__pieEval.seedConfig(cfg),
  { provider: PROVIDER, model: MODEL, apiKey: API_KEY },
);
await sw.evaluate((args) => new Promise((resolve, reject) => {
  const req = indexedDB.open('pie');
  req.onsuccess = () => {
    const tx = req.result.transaction('config', 'readwrite');
    tx.objectStore('config').put({ key: 'last_model_selection', value: { instanceId: args.instanceId, model: args.model } });
    tx.objectStore('config').put({ key: 'instances_index', value: [args.instanceId] }); // 竞态兜底
    tx.oncomplete = () => resolve(null);
    tx.onerror = () => reject(tx.error);
  };
  req.onerror = () => reject(req.error);
}), { instanceId, model: MODEL });
console.log(`  [launch] profile-llm314 seeded ${PROVIDER}/${MODEL} instance=${instanceId.slice(0, 8)} extId=${extId}`);

const page = await ctx.newPage();
page.setDefaultTimeout(15000);
await page.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);

// ───────────────────────── IDB 真值读取（SW 侧）─────────────────────────
const listMetas = () => sw.evaluate(() => new Promise((resolve, reject) => {
  const req = indexedDB.open('pie');
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction('sessions', 'readonly');
    const g = tx.objectStore('sessions').getAll();
    g.onsuccess = () => {
      const metas = [];
      for (const rec of g.result) {
        if (typeof rec?.id === 'string' && rec.id.endsWith(':meta') && rec.value) {
          metas.push({
            sid: rec.id.slice(0, -':meta'.length),
            createdAt: rec.value.createdAt ?? 0,
            lastAccessedAt: rec.value.lastAccessedAt ?? 0,
          });
        }
      }
      db.close();
      resolve(metas);
    };
    g.onerror = () => { db.close(); reject(g.error); };
  };
  req.onerror = () => reject(req.error);
}));

const readAgentMessages = (sid) => sw.evaluate((key) => new Promise((resolve, reject) => {
  const req = indexedDB.open('pie');
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction('sessions', 'readonly');
    const g = tx.objectStore('sessions').get(key);
    g.onsuccess = () => {
      db.close();
      const msgs = g.result?.value?.agentMessages;
      resolve(Array.isArray(msgs) ? msgs : null);
    };
    g.onerror = () => { db.close(); reject(g.error); };
  };
  req.onerror = () => reject(req.error);
}), `${sid}:agent`);

// ───────────────────────── raw LLM IR 解析（AgentMessage: string | ContentBlock[]）─────────────
/** 从捕获的 agentMessages 抽 tool 调用序列：assistant tool_use 配对 user tool_result。 */
function extractCalls(messages) {
  const byId = new Map();
  const calls = [];
  for (const m of messages ?? []) {
    if (!Array.isArray(m?.content)) continue;
    if (m.role === 'assistant') {
      for (const b of m.content) {
        if (b?.type === 'tool_use') {
          const c = { id: b.id, name: b.name, input: b.input, result: null, isError: false };
          byId.set(b.id, c);
          calls.push(c);
        }
      }
    } else if (m.role === 'user') {
      for (const b of m.content) {
        if (b?.type === 'tool_result') {
          const c = byId.get(b.toolUseId);
          if (c) { c.result = typeof b.content === 'string' ? b.content : JSON.stringify(b.content); c.isError = !!b.isError; }
        }
      }
    }
  }
  return calls;
}
const callSummary = (calls) => calls.map((c) => `${c.name}${c.isError ? '(err)' : ''}`).join('→') || '(no tool calls captured)';

// ───────────────────────── composer 任务驱动 + 原始 observation 捕获 ─────────────────────────
const GRANT_CARD_RE = /asks to run scripts on your computer/;

async function backToChat() {
  const back = page.getByTestId('topbar-back');
  for (let i = 0; i < 6 && (await back.count()) > 0; i++) { await back.click(); await sleep(400); }
}

/**
 * composer 发任务并全程轮询：
 *  - IDB `${sid}:agent` 每 800ms 采样，保留最后一份非空 agentMessages（done tombstone 前的全量 IR）
 *  - 同时监视 skill-grant 卡；expectCard 时点 Allow & run，非预期出现也点掉（保流程活）但记 cardSeen
 *  - 结束判定：tombstone（非空→空）/ 消息数 90s 无增长 / 硬超时
 */
async function runTask({ label, prompt, sid = null, excludeSids = [], expectCard = false, timeoutMs = 300000 }) {
  await backToChat();
  const composer = page.locator('textarea').first();
  await composer.waitFor({ timeout: 10000 });
  const sendTs = Date.now();
  await composer.fill(prompt);
  await composer.press('Enter');

  let captured = [];
  let seenNonEmpty = false;
  let cardSeen = false;
  let cardClicked = false;
  let endedBy = 'timeout';
  let lastCount = -1;
  let lastChange = Date.now();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // sid 探测：composer 会话由 panel 生成 UUID；取发送后 lastAccessedAt 最新的 UUID meta
    if (!sid) {
      try {
        const metas = (await listMetas()).filter(
          (m) => UUID_RE.test(m.sid) && !excludeSids.includes(m.sid) && m.lastAccessedAt >= sendTs - 2000,
        );
        if (metas.length) sid = metas.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)[0].sid;
      } catch { /* SW 重启瞬间 */ }
    }
    // 授权卡监视
    try {
      if ((await page.getByText(GRANT_CARD_RE).count()) > 0) {
        cardSeen = true;
        if (!cardClicked) {
          await snap(page, `${label}-grant-card`);
          try {
            await page.getByRole('button', { name: 'Allow & run', exact: true }).first().click({ timeout: 3000 });
            cardClicked = true;
          } catch { /* 卡片进出场动画中，下轮重试 */ }
        }
      }
    } catch { /* page 导航瞬间 */ }
    // raw agentMessages 采样
    if (sid) {
      try {
        const msgs = await readAgentMessages(sid);
        if (Array.isArray(msgs)) {
          if (msgs.length > 0) { seenNonEmpty = true; captured = msgs; }
          else if (seenNonEmpty) { endedBy = 'tombstone'; break; }
          if (msgs.length !== lastCount) { lastCount = msgs.length; lastChange = Date.now(); }
          else if (seenNonEmpty && Date.now() - lastChange > 90000) { endedBy = 'stall'; break; }
        }
      } catch { /* 采样失败下轮重试 */ }
    }
    await sleep(800);
  }
  await snap(page, `${label}-end`);
  console.log(`  [task ${label}] sid=${sid ?? '??'} endedBy=${endedBy} msgs=${captured.length} card=${cardSeen}`);
  return { sid, captured, cardSeen, endedBy, calls: extractCalls(captured) };
}

// ───────────────────────── setup：桥 ready + 副根导入向导全选启用 ─────────────────────────
const bridgeStatus = () => page.evaluate(() => new Promise((resolve) => {
  chrome.runtime.sendMessage({ type: 'local-bridge:status' }, (res) => resolve(res ?? null));
}));
try {
  let st = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    st = await bridgeStatus();
    if (st?.ready) break;
    await sleep(500);
  }
  if (!st?.ready) throw new Error(`bridge not ready: ${JSON.stringify(st)}`);
  record('setup-bridge', 'PASS', `daemonVersion=${st.daemonVersion}`);
} catch (e) {
  record('setup-bridge', 'ERROR', e.message);
  await snap(page, 'setup-bridge-error');
  fs.writeFileSync(`${REPORT}/results-llm.json`, JSON.stringify(results, null, 2));
  await ctx.close();
  process.exit(1);
}

try {
  // 副根 skill（agents-probe，standalone 模式还含规模档）默认关，须启用；主根 io-probe 默认开。
  // 坑 1：firstRun 会**异步**自动落设置页——count() 检查后、click 完成前 topbar-skills 可能被
  //   detach（实测 15s click 超时）。对策：先等视图沉降，循环内短超时点击 + try/catch 重试。
  // 坑 2：导入向导只在首连弹一次（agents_import_prompted），重跑 profile 不弹。
  //   对策：向导在走向导（顺带覆盖向导路径），不在则直接点 skill 行的 Enable toggle（role=switch）。
  await sleep(3000); // 等 firstRun 重定向沉降
  let onSkills = false;
  for (let i = 0; i < 20 && !onSkills; i++) {
    try {
      const skillsBtn = page.getByTestId('topbar-skills');
      if (await skillsBtn.count()) {
        await skillsBtn.click({ timeout: 2000 });
        onSkills = true;
        break;
      }
      const back = page.getByTestId('topbar-back');
      if (await back.count()) await back.click({ timeout: 2000 });
    } catch { /* 视图切换竞态，下轮重试 */ }
    await sleep(600);
  }
  if (!onSkills) throw new Error('20 轮未进入 skills 视图（panel 卡在非 chat 视图）');
  const wizardText = page.getByText(/Found \d+ local skills?/);
  let via;
  try {
    await wizardText.waitFor({ timeout: 8000 });
    const wizardCount = /Found (\d+)/.exec(await wizardText.textContent())?.[1] ?? '?';
    await snap(page, 'setup-wizard');
    await page.getByRole('button', { name: 'Select all' }).click();
    await page.getByRole('button', { name: 'Enable selected' }).click();
    await wizardText.waitFor({ state: 'hidden' });
    via = `导入向导全选启用（Found ${wizardCount} local skills）`;
  } catch {
    // 向导没弹（已提示过）→ 直接开 agents-probe 的 toggle
    const toggle = page.getByRole('switch', { name: 'Enable agents-probe' });
    await toggle.waitFor({ timeout: 8000 });
    await toggle.click();
    await page.getByRole('switch', { name: 'Disable agents-probe' }).waitFor({ timeout: 8000 });
    via = '向导未弹（已提示过），直接点 Enable agents-probe toggle';
  }
  // 规模档冒烟：fixture-32 可见（pipeline 模式住主根、standalone 住副根；>8KB list 响应压背压路径）
  await page.locator('code:text-is("/fixture-32")').waitFor({ timeout: 15000 });
  record('setup-wizard-enable-scale', 'PASS', `${via}；/fixture-32 可见（规模档在列）`);
  await snap(page, 'setup-skills-enabled');
} catch (e) {
  record('setup-wizard-enable-scale', 'ERROR', `${e.message.slice(0, 200)}（副根 skill 未启用则 llm-9 会连带失败）`);
  await snap(page, 'setup-wizard-error');
}
await backToChat();

// llm-1 前置：重置 grant 状态（daemon 每次 hasGrant 都读盘，运行中删除即时生效）——
// 让「首跑未授权 → 弹卡」语义自包含、重跑安全，不依赖与 functional 批的信封差异。
fs.rmSync(GRANTS, { force: true });

let sidA = null;
let sidB = null;

// ═══════════ 任务 A：io-probe print.ts —— llm-1 首跑授权卡 / llm-2 grants 信封 / llm-3 stdout observation ═══════════
try {
  const itemStart = Date.now();
  const grantsBefore = grantsRaw();
  const t = await runTask({
    label: 'taskA-print',
    prompt: 'Call the run_skill_script tool with skillId "io-probe", entry "print.ts", and args ["hello"]. Then reply with the exact stdout text the tool returned. Do not use any other tools.',
    expectCard: true,
  });
  sidA = t.sid;

  // llm-1：首跑弹信封授权卡（Playwright 现场点掉 Allow & run）
  record('llm-1-first-run-grant-card', t.cardSeen ? 'PASS' : 'FAIL',
    t.cardSeen ? '首跑弹信封授权卡，已点 Allow & run' : `未见授权卡；calls=${callSummary(t.calls)} endedBy=${t.endedBy}`);

  // llm-2：grants.json 从无到有出现 io-probe 信封条目（磁盘证据）
  const grantsAfter = grantsRaw();
  const grantOk = grantsAfter.includes('io-probe') && grantCount(grantsAfter) > grantCount(grantsBefore);
  record('llm-2-grants-envelope-on-disk', grantOk ? 'PASS' : 'FAIL',
    `grants entries ${grantCount(grantsBefore)}→${grantCount(grantsAfter)}; hasIoProbe=${grantsAfter.includes('io-probe')}`);

  // llm-3：原始 observation（raw IR，非对话文本）—— untrusted_skill_content 包裹 stdout，
  // 且 stdout JSON 三断言（cwd==ws==session workspace、skillDir 指主根）在 main 必 FAIL
  const call = t.calls.find((c) => c.name === 'run_skill_script' && c.input?.skillId === 'io-probe' && !c.isError && typeof c.result === 'string' && c.result.includes('<untrusted_skill_content>'));
  if (!sidA) {
    record('llm-3-print-stdout-observation', 'FAIL', `未探测到会话 sid；calls=${callSummary(t.calls)}`);
  } else if (!call) {
    record('llm-3-print-stdout-observation', 'FAIL', `LLM 未按预期成功调 run_skill_script；calls=${callSummary(t.calls)} endedBy=${t.endedBy}`);
  } else {
    const inner = /<untrusted_skill_content>([\s\S]*?)<\/untrusted_skill_content>/.exec(call.result)?.[1] ?? '';
    let parsed = null;
    try { parsed = JSON.parse(inner.trim()); } catch { /* stdout 非 JSON */ }
    const expectedWs = `${SESSIONS}/${sidA}/workspace`;
    const argsIsArray = Array.isArray(call.input?.args) && !('input' in (call.input ?? {}));
    const ok = parsed
      && normPath(parsed.cwd) === normPath(expectedWs)
      && normPath(parsed.ws) === normPath(expectedWs)
      && normPath(parsed.skillDir) === normPath(`${PRIMARY_ROOT}/io-probe`)
      && JSON.stringify(parsed.argv) === JSON.stringify(['hello'])
      && argsIsArray
      && fs.existsSync(expectedWs);
    record('llm-3-print-stdout-observation', ok ? 'PASS' : 'FAIL',
      ok ? `cwd==PIE_WORKSPACE==${expectedWs}; PIE_SKILL_DIR=主根 io-probe; argv=["hello"]; 参数用 args 数组`
        : `parsed=${JSON.stringify(parsed).slice(0, 300)} expectedWs=${expectedWs} argsIsArray=${argsIsArray} wsExists=${fs.existsSync(expectedWs)}`);
  }
  const auditOk = auditHas(itemStart, 'io-probe', 'print.ts');
  if (!auditOk) record('llm-3-audit-print', 'FAIL', 'audit.jsonl 无 io-probe/print.ts exit 0 行');
} catch (e) { record('llm-3-print-stdout-observation', 'ERROR', e.message); await snap(page, 'taskA-error'); }

// ═══════════ 任务 B：io-probe write.ts + read_skill_output —— llm-4 免卡 / llm-5 产物清单 / llm-6 读回 ═══════════
try {
  const itemStart = Date.now();
  const grantsBefore = grantsRaw();
  const t = await runTask({
    label: 'taskB-write',
    prompt: 'Call run_skill_script with skillId "io-probe", entry "write.ts", and args ["ALPHA-SESSION-ONE"]. The tool result will list files written to the session workspace. Then call read_skill_output with path "out.csv" and reply with the exact file content it returned. Do not use any other tools.',
    sid: sidA,
    expectCard: false,
  });
  sidA = sidA ?? t.sid;

  // llm-4：同 skill 再跑不弹卡 + grants.json 零新增（grant 不失效）
  const grantsAfter = grantsRaw();
  const regrantOk = !t.cardSeen && grantsAfter === grantsBefore;
  record('llm-4-regrant-not-prompted', regrantOk ? 'PASS' : 'FAIL',
    `cardSeen=${t.cardSeen}（期望 false）; grantsUnchanged=${grantsAfter === grantsBefore}`);

  // llm-5：observation 产物清单 + 磁盘文件互证
  const wsFile = `${SESSIONS}/${sidA}/workspace/out.csv`;
  const wsContent = fs.existsSync(wsFile) ? fs.readFileSync(wsFile, 'utf8') : null;
  const runCall = t.calls.find((c) => c.name === 'run_skill_script' && c.input?.skillId === 'io-probe' && !c.isError && typeof c.result === 'string' && c.result.includes('untrusted_skill_output_list'));
  if (!runCall) {
    record('llm-5-write-outputs-observation', 'FAIL',
      `未捕获到含 untrusted_skill_output_list 的成功 observation；calls=${callSummary(t.calls)} endedBy=${t.endedBy}`);
  } else {
    const framingOk = runCall.result.includes('Files written to the session workspace (read them with read_skill_output):');
    const listInner = /<untrusted_skill_output_list>([\s\S]*?)<\/untrusted_skill_output_list>/.exec(runCall.result)?.[1] ?? '';
    const bytesOk = wsContent !== null && listInner.includes(`out.csv (${fmtBytes(Buffer.byteLength(wsContent))})`);
    const subOk = listInner.includes('sub/raw.json');
    const diskOk = wsContent === 'ALPHA-SESSION-ONE';
    const ok = framingOk && bytesOk && subOk && diskOk;
    record('llm-5-write-outputs-observation', ok ? 'PASS' : 'FAIL',
      `framing=${framingOk} listHasOutCsvBytes=${bytesOk} listHasSub=${subOk} diskContent=${JSON.stringify(wsContent)}（期望 "ALPHA-SESSION-ONE"）; list="${listInner.slice(0, 160)}"`);
  }

  // llm-6：read_skill_output 读回，tool 成功且内容与磁盘一致
  const readCall = t.calls.find((c) => c.name === 'read_skill_output');
  const readOk = !!readCall && !readCall.isError && typeof readCall.result === 'string'
    && readCall.result.includes('<untrusted_skill_content>ALPHA-SESSION-ONE</untrusted_skill_content>');
  record('llm-6-read-skill-output-roundtrip', readOk ? 'PASS' : 'FAIL',
    readCall
      ? `isError=${readCall.isError} result="${String(readCall.result).slice(0, 160)}"`
      : `LLM 未调 read_skill_output；calls=${callSummary(t.calls)}`);

  if (!auditHas(itemStart, 'io-probe', 'write.ts')) record('llm-5-audit-write', 'FAIL', 'audit.jsonl 无 io-probe/write.ts exit 0 行');
} catch (e) { record('llm-5-write-outputs-observation', 'ERROR', e.message); await snap(page, 'taskB-error'); }

// ═══════════ 任务 C：io-probe noop.ts —— llm-7 静默脚本可行动提示 ═══════════
try {
  const itemStart = Date.now();
  const filesBefore = sidA ? listWorkspaceFiles(sidA) : [];
  const t = await runTask({
    label: 'taskC-noop',
    prompt: 'Call run_skill_script with skillId "io-probe", entry "noop.ts", and args []. Then reply with the exact text of the tool result, verbatim. Do not use any other tools.',
    sid: sidA,
    expectCard: false,
  });
  const call = t.calls.find((c) => c.name === 'run_skill_script' && c.input?.entry?.includes('noop'));
  const obs = call?.result ?? '';
  const hintOk = obs.includes('script exited 0 but produced nothing') && obs.includes('a returned value is discarded');
  const filesAfter = sidA ? listWorkspaceFiles(sidA) : [];
  const noNewFiles = JSON.stringify(filesBefore) === JSON.stringify(filesAfter);
  const auditOk = auditHas(itemStart, 'io-probe', 'noop.ts');
  const ok = hintOk && noNewFiles && auditOk;
  record('llm-7-silent-script-hint', ok ? 'PASS' : 'FAIL',
    call
      ? `hint=${hintOk} noNewFiles=${noNewFiles} audit=${auditOk}; obs="${obs.slice(0, 200)}"`
      : `LLM 未调 run_skill_script(noop.ts)；calls=${callSummary(t.calls)} endedBy=${t.endedBy}`);
} catch (e) { record('llm-7-silent-script-hint', 'ERROR', e.message); await snap(page, 'taskC-error'); }

// ═══════════ 任务 D：新会话跑同一 write.ts —— llm-8 双 session workspace 互不覆盖 ═══════════
try {
  await backToChat();
  await page.getByTestId('topbar-new').click();
  await sleep(1000);
  const t = await runTask({
    label: 'taskD-session2',
    prompt: 'Call run_skill_script with skillId "io-probe", entry "write.ts", and args ["BRAVO-SESSION-TWO"]. Then reply "done". Do not use any other tools.',
    excludeSids: sidA ? [sidA] : [],
    expectCard: false,
  });
  sidB = t.sid;
  const fileA = sidA ? `${SESSIONS}/${sidA}/workspace/out.csv` : null;
  const fileB = sidB ? `${SESSIONS}/${sidB}/workspace/out.csv` : null;
  const contentA = fileA && fs.existsSync(fileA) ? fs.readFileSync(fileA, 'utf8') : null;
  const contentB = fileB && fs.existsSync(fileB) ? fs.readFileSync(fileB, 'utf8') : null;
  const ok = !!sidA && !!sidB && sidA !== sidB
    && contentA === 'ALPHA-SESSION-ONE' && contentB === 'BRAVO-SESSION-TWO' && !t.cardSeen;
  record('llm-8-two-sessions-isolation', ok ? 'PASS' : 'FAIL',
    `sidA=${sidA?.slice(0, 8)} sidB=${sidB?.slice(0, 8)} contentA=${JSON.stringify(contentA)} contentB=${JSON.stringify(contentB)} cardSeen=${t.cardSeen}` +
    (ok ? '（同名 out.csv 并存、内容各异、grant 跨 session 免卡）' : ` calls=${callSummary(t.calls)}`));
} catch (e) { record('llm-8-two-sessions-isolation', 'ERROR', e.message); await snap(page, 'taskD-error'); }

// ═══════════ 任务 E：副根 agents-probe write.ts —— llm-9 副根零写入 + 功能正常 ═══════════
try {
  const itemStart = Date.now();
  const treeBefore = treeSnapshot(AGENTS_ROOT);
  const grantsBefore = grantsRaw();
  const t = await runTask({
    label: 'taskE-agents',
    prompt: 'Call run_skill_script with skillId "agents-probe", entry "write.ts", and args ["FROM-AGENTS-ROOT"]. Then reply "done". Do not use any other tools.',
    sid: sidB,
    expectCard: true, // 新 skill 首跑：per-skill 信封各自一张卡
  });
  const sidE = sidB ?? t.sid;
  const treeAfter = treeSnapshot(AGENTS_ROOT);
  const treeUnchanged = JSON.stringify(treeBefore) === JSON.stringify(treeAfter);
  const outFile = sidE ? `${SESSIONS}/${sidE}/workspace/agents-out.txt` : null;
  const outContent = outFile && fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : null;
  const positiveControl = outContent === 'FROM-AGENTS-ROOT'; // 证明脚本真跑了、写没被静默吞
  const auditOk = auditHas(itemStart, 'agents-probe', 'write.ts');
  const grantsAfter = grantsRaw();
  const newGrantOk = grantsAfter.includes('agents-probe') && grantCount(grantsAfter) > grantCount(grantsBefore);
  const ok = treeUnchanged && positiveControl && auditOk;
  if (!treeUnchanged) {
    const beforeSet = new Map(treeBefore.map((x) => [x.rel, x]));
    const diff = treeAfter.filter((x) => JSON.stringify(beforeSet.get(x.rel)) !== JSON.stringify(x)).map((x) => x.rel)
      .concat(treeBefore.filter((x) => !treeAfter.some((y) => y.rel === x.rel)).map((x) => `-${x.rel}`));
    record('llm-9-agents-root-zero-write', 'FAIL',
      `副根树变化: ${diff.slice(0, 10).join(', ')}; positiveControl=${positiveControl}`);
  } else {
    record('llm-9-agents-root-zero-write', ok ? 'PASS' : 'FAIL',
      `treeUnchanged=true positiveControl=${positiveControl}（workspace/agents-out.txt=${JSON.stringify(outContent)}）audit=${auditOk} card=${t.cardSeen} newGrant=${newGrantOk}` +
      (ok ? '' : ` calls=${callSummary(t.calls)} endedBy=${t.endedBy}`));
  }
} catch (e) { record('llm-9-agents-root-zero-write', 'ERROR', e.message); await snap(page, 'taskE-error'); }

// ═══════════ item7a：归档 / 硬删 session → daemon 侧 workspace 目录消失（lifecycle 全链路）═══════════
// 从 functional 批挪来：SessionDrawer 只列出有内容的会话，taskA-E 的 sidA/sidB 正好可用。
// 链路：archiveSession/hardDeleteSession（lifecycle.ts 钩子）→ SW delete-session-workspace → 桥 → daemon rm。
// main 对照点：main 的 lifecycle 无钩子 → 目录残留 → FAIL。
try {
  const candidates = [sidA, sidB].filter(Boolean);
  if (!candidates.length) throw new Error('taskA-E 未产生可用 sid，无法测删除链路');
  for (const sid of candidates) {
    fs.mkdirSync(`${SESSIONS}/${sid}/workspace`, { recursive: true });
    fs.writeFileSync(`${SESSIONS}/${sid}/workspace/marker.txt`, `panel session ${sid}\n`);
  }
  await backToChat();
  await page.getByTestId('topbar-drawer').click();
  await page.getByText(/Show Archived/i).waitFor({ timeout: 8000 });
  const rows = page.locator('li[aria-label]');
  const rowCount = await rows.count();
  let archiveClicked = false;
  for (let i = rowCount - 1; i >= 0 && !archiveClicked; i--) {
    await rows.nth(i).hover();
    await sleep(300);
    const btn = page.getByRole('button', { name: /^Archive .+/ });
    if (await btn.count()) {
      await snap(page, 'drawer-before-archive');
      await btn.first().click();
      archiveClicked = true;
    }
  }
  if (!archiveClicked) throw new Error(`悬停 ${rowCount} 行未出现 Archive 按钮`);

  // 归档触发 fire-and-forget RPC → 轮询哪个候选目录消失（点击行按 UI 排序，用磁盘 diff 反推）
  let archivedSid = null;
  for (let i = 0; i < 32 && !archivedSid; i++) {
    await sleep(250);
    archivedSid = candidates.find((sid) => !fs.existsSync(`${SESSIONS}/${sid}`)) ?? null;
  }
  if (!archivedSid) {
    record('item7a-archive-clears-workspace', 'FAIL',
      `点 Archive 后 8s 内候选目录均残留: ${candidates.map((s) => s.slice(0, 8)).join(',')}`);
  } else {
    const survivor = candidates.find((sid) => sid !== archivedSid);
    const survivorIntact = !survivor || fs.existsSync(`${SESSIONS}/${survivor}/workspace/marker.txt`);
    record('item7a-archive-clears-workspace', survivorIntact ? 'PASS' : 'FAIL',
      `归档 ${archivedSid.slice(0, 8)}… → sessions/<sid>/ 整目录消失 · 对照组(${survivor ? survivor.slice(0, 8) + '…' : '无'})存活=${survivorIntact}`);
    await snap(page, 'after-archive');

    // 硬删分支：重造该 sid 的 workspace → Show Archived → Delete forever → 目录再次消失
    fs.mkdirSync(`${SESSIONS}/${archivedSid}/workspace`, { recursive: true });
    fs.writeFileSync(`${SESSIONS}/${archivedSid}/workspace/marker2.txt`, 'recreated for hard-delete leg\n');
    await page.getByText(/Show Archived/i).click();
    const delBtn = page.getByRole('button', { name: / forever$/ });
    await delBtn.first().waitFor({ timeout: 8000 });
    await snap(page, 'drawer-archived-list');
    await delBtn.first().click();
    let goneAgain = false;
    for (let i = 0; i < 32 && !goneAgain; i++) {
      await sleep(250);
      goneAgain = !fs.existsSync(`${SESSIONS}/${archivedSid}`);
    }
    record('item7a-harddelete-clears-workspace', goneAgain ? 'PASS' : 'FAIL',
      `Delete forever 后 sessions/${archivedSid.slice(0, 8)}…/ 消失=${goneAgain}（重造过的 workspace 走 hardDeleteSession 钩子再删）`);
    await snap(page, 'after-harddelete');
  }
} catch (e) { record('item7a-archive-clears-workspace', 'ERROR', e.message); await snap(page, 'item7a-error'); }

// ───────────────────────── 收尾 ─────────────────────────
await ctx.close();
// daemon 留给主控统一生命周期管理（与 pilot-283-llm 一致，批间共享 scratch daemon）
fs.writeFileSync(`${REPORT}/results-llm.json`, JSON.stringify(results, null, 2));
console.table(results);
const fails = results.filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
console.log(`\n== LLM 批 ${results.length} checks, ${fails.length} fail/error ==`);
process.exit(fails.length ? 1 : 0);
