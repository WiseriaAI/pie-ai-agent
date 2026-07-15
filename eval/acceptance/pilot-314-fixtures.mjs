// PR #314（feat #296 skill 脚本 I/O 契约收口）真机验收 — fixture 生成器。
// 参照 pilot-283 的 ad hoc 造数做法固化成脚本；环境搭建/配方坑见 docs/agents/auto-acceptance.md。
//
// ⚠️ 执行顺序（主控必须遵守）：
//   1. pnpm build:eval（产出 dist-eval/）
//   2. export PIE_ACCEPT_BASE=/tmp/pie314（短路径，daemon.sock 受 sun_path 104B 上限）
//   3. node eval/acceptance/pilot-314-fixtures.mjs   ← 本脚本，**必须在 daemon 启动之前跑**
//      （GC 项 7b 的孤儿 session 目录要先落盘、mtime 拨到 31 天前，daemon 启动时
//       startDaemon → sweepSessions() 才会把它清掉——GC 只在 daemon 启动时发生一次）
//   4. HOME=$PIE_ACCEPT_BASE/home bun daemon/src/cli.ts daemon   ← 主控启动 scratch daemon
//   5. node eval/acceptance/pilot-314-functional.mjs  ← daemon-direct + functional 断言批
//
// 产出布局（全部落在 $PIE_ACCEPT_BASE 下，绝不碰真实 ~/.pie / ~/.agents）：
//   home/.pie/skills/io-probe/            主根脚本 skill（print.py / write.sh / noop.sh）
//   home/.pie/skills/fixture-1..32/       无脚本规模档（≥30，压 list_skills >8KB 背压路径）
//   home/.agents/skills/agents-probe/     副根脚本 skill（write.py：print+写文件混合型）
//   home/.pie/sessions/<uuid-old>/        孤儿 session（mtime 拨回 31 天，供启动 GC 清）
//   home/.pie/sessions/<uuid-fresh>/      新鲜 session（GC 对照组，必须存活）
//   dist-pilot/                           dist-eval 副本 + nativeMessaging 提为必选权限
//   dist-orig/                            dist-eval 原样副本（IDB/daemon-off 基线用）
//   host-wrapper.sh                       NM host 包装（HOME 指向 scratch home）
//   fixtures.json                         本脚本产出的 uuid/路径清单，functional 批读取
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE = process.env.PIE_ACCEPT_BASE;
if (!BASE) throw new Error('PIE_ACCEPT_BASE 未设置（隔离工作目录，见 docs/agents/auto-acceptance.md）');
// fail-fast：daemon.sock 受 macOS sun_path 104B 上限，路径太长 daemon 会 Failed to listen（表现为桥永远连不上、误判成回归）
if (Buffer.byteLength(`${BASE}/home/.pie/daemon.sock`) > 103) {
  throw new Error('PIE_ACCEPT_BASE 过长：daemon.sock 超 macOS sun_path 104B 上限，用 /tmp/pie314 之类短路径');
}
if (!fs.existsSync(BASE)) fs.mkdirSync(BASE, { recursive: true });

const REPO = '/Users/wenkang/repos/pie/pie-ai-agent';
const HOME = `${BASE}/home`;
const PIE_SKILLS = `${HOME}/.pie/skills`;
const AGENTS_SKILLS = `${HOME}/.agents/skills`;
const SESSIONS = `${HOME}/.pie/sessions`;
const REPORT = `${BASE}/report`;

// 幂等：重复跑先清掉上一轮的 fixture 面（不动 dist-eval）。
// grants.json / logs / profile-* 也必须清：fixture 逐字节固定 → 信封 hash 不变 →
// 残留 grant 让 item8/llm-1「首跑需授权」假失败；残留 audit/daemon.log 让时序断言读到旧行；
// 残留 profile 的 IDB 旧 session 干扰 item7a 候选。要求本脚本在 daemon 启动前跑（头注顺序）。
for (const d of [PIE_SKILLS, AGENTS_SKILLS, SESSIONS]) {
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
}
fs.rmSync(`${HOME}/.pie/grants.json`, { force: true });
fs.rmSync(`${HOME}/.pie/logs`, { recursive: true, force: true });
for (const entry of fs.existsSync(BASE) ? fs.readdirSync(BASE) : []) {
  if (entry.startsWith('profile-')) fs.rmSync(path.join(BASE, entry), { recursive: true, force: true });
}
fs.mkdirSync(REPORT, { recursive: true });

function writeSkill(root, name, description, scripts = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\nPR #314 acceptance fixture.\n`,
  );
  if (Object.keys(scripts).length > 0) {
    const sdir = path.join(dir, 'scripts');
    fs.mkdirSync(sdir, { recursive: true });
    for (const [file, content] of Object.entries(scripts)) {
      fs.writeFileSync(path.join(sdir, file), content, { mode: 0o755 });
    }
  }
  return dir;
}

// ── 主根 io-probe：print 型（python3）/ 写文件型（sh）/ 静默型（sh） ────────────────
// runnableScripts = scripts/ 目录下的文件名（daemon 扫盘得出，frontmatter 无需声明）。
// 语言覆盖：print.py=python3、write.sh/noop.sh=bash（interpreterFor 按扩展名路由）。
const PRINT_PY = `#!/usr/bin/env python3
# print 型：把运行时事实（cwd / argv / 注入 env）打成一行 JSON 到 stdout。
# 断言点：cwd == PIE_WORKSPACE == ~/.pie/sessions/<sid>/workspace，PIE_SKILL_DIR 指 skill 目录。
import json, os, sys
print(json.dumps({
    "cwd": os.getcwd(),
    "argv": sys.argv[1:],
    "skillDir": os.environ.get("PIE_SKILL_DIR"),
    "ws": os.environ.get("PIE_WORKSPACE"),
}))
`;

const WRITE_SH = `#!/bin/bash
# 写文件型：cwd（= session workspace）写 out.csv（内容 = $1，字节数可精确断言）
# + 子目录 sub/raw.json（验 outputs 递归扫描 + 相对路径形态）。
# --many N：写 N 个文件压 OUTPUTS_CAP=50 封顶（outputs.length==50 && outputsTruncated）。
set -euo pipefail
if [ "\${1:-}" = "--many" ]; then
  n="\${2:?--many needs a count}"
  mkdir -p many
  i=1
  while [ "$i" -le "$n" ]; do
    printf 'x' > "many/f\${i}.txt"
    i=$((i+1))
  done
  exit 0
fi
printf '%s' "\${1:?usage: write.sh <content> | --many N}" > out.csv
mkdir -p sub
printf '{"k":1}' > sub/raw.json
`;

const NOOP_SH = `#!/bin/bash
# 静默型（复刻 #296 原始 bug 形状：脚本"算了个值"但既不 print 也不写文件）：
# exit 0、零 stdout、零产物 → 扩展侧 observation 必须给出可行动提示
# （"script exited 0 but produced nothing … a returned value is discarded"）。
exit 0
`;

const ioProbeDir = writeSkill(PIE_SKILLS, 'io-probe', 'IO contract probe fixture (PR #314): print env facts, write session outputs, or stay silent.', {
  'print.py': PRINT_PY,
  'write.sh': WRITE_SH,
  'noop.sh': NOOP_SH,
});

// ── 副根 agents-probe：print + 写文件混合型（python3）──────────────────────────
// 必须住副根：item4「副根零写入」断言只有跑 ~/.agents/skills 里的 skill 才测得到
// （修复点 = skill-exec 不再 mkdir skillDir/workspace，产物全部落 session workspace）。
const AGENTS_WRITE_PY = `#!/usr/bin/env python3
# 副根版 print+写文件型：stdout 打 marker，同时向 cwd（session workspace）写 agents-out.txt。
# 正控制：证明脚本真跑了、写入没被静默吞——副根零写入断言才有意义。
import os, sys
content = "from-agents-probe:" + ",".join(sys.argv[1:])
with open(os.path.join(os.getcwd(), "agents-out.txt"), "w") as f:
    f.write(content)
print("agents-probe wrote agents-out.txt")
`;

const agentsProbeDir = writeSkill(AGENTS_SKILLS, 'agents-probe', 'Agents-root fixture (PR #314): prints a marker AND writes agents-out.txt into the session workspace.', {
  'write.py': AGENTS_WRITE_PY,
});

// ── 规模档：≥30 个无脚本 skill（283 教训：3-4 个 fixture 全绿 ≠ 真实规模能活；
//    32 个让 list_skills 响应 >8KB 压 socket 背压路径，中文 description 压多字节 UTF-8 切分）──
const SCALE_COUNT = 40; // 32 时 list_skills 响应 7892B 差临门一脚不过 8KB 背压阈值，40 稳过
for (let i = 1; i <= SCALE_COUNT; i++) {
  writeSkill(PIE_SKILLS, `fixture-${i}`, `规模档 fixture ${i}（无脚本，压真实规模档与多字节 UTF-8 切分路径）— scale fixture ${i} of ${SCALE_COUNT}.`);
}

// ── GC fixture：孤儿 session（mtime 拨回 31 天）+ 新鲜对照组 ─────────────────────
// sweepSessions 判据 = session 目录本身的 statSync(dir).mtimeMs（skill-store.ts:239），
// 阈值 30 天；本脚本在 daemon 启动前落盘，daemon 启动时 startDaemon → sweepSessions()
// 应删 uuidOld 整目录、留 uuidFresh。functional 批只做事后检查，不自己启 daemon。
const uuidOld = crypto.randomUUID();
const uuidFresh = crypto.randomUUID();
const THIRTY_ONE_DAYS_AGO = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);

{
  const oldWs = path.join(SESSIONS, uuidOld, 'workspace');
  fs.mkdirSync(oldWs, { recursive: true });
  fs.writeFileSync(path.join(oldWs, 'stale.txt'), 'orphan session artifact, should be GC-ed at daemon start\n');
  // utimesSync 顺序必须由内向外：先文件、再 workspace、最后 session 目录本身——
  // 写子项会刷新父目录 mtime，倒过来拨会被自己刷回当前时间。GC 判据是最外层目录 mtime。
  fs.utimesSync(path.join(oldWs, 'stale.txt'), THIRTY_ONE_DAYS_AGO, THIRTY_ONE_DAYS_AGO);
  fs.utimesSync(oldWs, THIRTY_ONE_DAYS_AGO, THIRTY_ONE_DAYS_AGO);
  fs.utimesSync(path.join(SESSIONS, uuidOld), THIRTY_ONE_DAYS_AGO, THIRTY_ONE_DAYS_AGO);

  const freshWs = path.join(SESSIONS, uuidFresh, 'workspace');
  fs.mkdirSync(freshWs, { recursive: true });
  fs.writeFileSync(path.join(freshWs, 'fresh.txt'), 'fresh session, GC control group, must survive daemon start\n');
}

// ── dist-pilot / dist-orig：复制 dist-eval + manifest 改写（参照 pilot-283 配方）──────
// dist-pilot = nativeMessaging 从 optional_permissions 提为必选 permissions
//   → Playwright 装载即授予，SW 自动连桥（绕过点不了的原生权限弹框；桥开关流未覆盖，报告须声明）。
// dist-orig  = 原样（不连桥 = IDB/daemon-off 基线）。
const DIST_EVAL = `${REPO}/dist-eval`;
if (!fs.existsSync(`${DIST_EVAL}/manifest.json`)) {
  throw new Error(`dist-eval 不存在或不完整（${DIST_EVAL}）——先在仓库根跑 pnpm build:eval`);
}
for (const target of ['dist-pilot', 'dist-orig']) {
  const dst = `${BASE}/${target}`;
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(DIST_EVAL, dst, { recursive: true });
}
{
  const mfPath = `${BASE}/dist-pilot/manifest.json`;
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  mf.optional_permissions = (mf.optional_permissions ?? []).filter((p) => p !== 'nativeMessaging');
  if (mf.optional_permissions.length === 0) delete mf.optional_permissions;
  mf.permissions = mf.permissions ?? [];
  if (!mf.permissions.includes('nativeMessaging')) mf.permissions.push('nativeMessaging');
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));
}

// ── host-wrapper.sh：NM host 以 scratch HOME 跑 daemon/src/cli.ts host ───────────
fs.writeFileSync(
  `${BASE}/host-wrapper.sh`,
  `#!/bin/bash\nexport HOME=${HOME}\nexec bun ${REPO}/daemon/src/cli.ts host\n`,
  { mode: 0o755 },
);

// ── fixtures.json：把 functional 批需要的事实固化下来 ────────────────────────────
const manifest = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  home: HOME,
  sessionsDir: SESSIONS,
  skills: {
    ioProbe: { name: 'io-probe', dir: ioProbeDir, scripts: ['print.py', 'write.sh', 'noop.sh'] },
    agentsProbe: { name: 'agents-probe', dir: agentsProbeDir, scripts: ['write.py'] },
    scaleCount: SCALE_COUNT,
  },
  gc: {
    // daemon 启动时 sweepSessions 应删 uuidOld、留 uuidFresh（判据 = 目录 mtime > 30 天）
    uuidOld,
    uuidFresh,
    rolledBackTo: THIRTY_ONE_DAYS_AGO.toISOString(),
  },
};
fs.writeFileSync(`${BASE}/fixtures.json`, JSON.stringify(manifest, null, 2));

console.log('pilot-314 fixtures generated:');
console.log(`  primary skills : io-probe + fixture-1..${SCALE_COUNT}  (${PIE_SKILLS})`);
console.log(`  secondary skill: agents-probe                      (${AGENTS_SKILLS})`);
console.log(`  GC orphan      : sessions/${uuidOld} (mtime -> ${THIRTY_ONE_DAYS_AGO.toISOString()})`);
console.log(`  GC control     : sessions/${uuidFresh} (fresh)`);
console.log(`  dist-pilot     : nativeMessaging promoted to required permission`);
console.log(`  dist-orig      : untouched dist-eval copy`);
console.log(`  manifest       : ${BASE}/fixtures.json`);
console.log('\nNEXT: start scratch daemon (HOME=' + HOME + ' bun daemon/src/cli.ts daemon), then run pilot-314-functional.mjs');
