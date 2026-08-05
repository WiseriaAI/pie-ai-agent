// Gate 0 spike（spec docs/specs/2026-08-05-daemon-windows-support.md §2）：
// 在 Windows 真机验证 srt-win alpha 在 bun compile 单二进制里的端到端可用性。
// 自包含，不 import daemon 源码；沙箱调用形态刻意对齐 skill-sandbox.ts 的 runViaSrt
// （异步 Bun.spawn / 串行单沙箱 / cleanup+reset），验证的就是未来产品代码的同款路径。
//
// 子命令：
//   status     沙箱设施状态（账户/WFP），不需要 UAC
//   install    一次性 UAC 安装沙箱设施（S1）
//   run        S2–S7 自动断言（写限/断网/域名白名单/敏感读拒/内嵌 Bun/python）
//   pipe       S8 named pipe 回环自测
//   all        status + run + pipe
//   uninstall  卸载沙箱设施（S10）
//
// 编译（mac 交叉编译）：bash daemon/spike/windows/build.sh
// 运行前提：srt-win.exe 与本 exe 同目录（build.sh 会放好）。
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import net from "node:net";
import {
  SandboxManager,
  resolveSrtWin,
  installWindowsSandboxAsync,
  uninstallWindowsSandbox,
  checkWindowsSandboxStatusAsync,
  verifyWindowsWfpEgress,
} from "@anthropic-ai/sandbox-runtime";

const exeDir = dirname(process.execPath);
const srtWinExe = join(exeDir, "srt-win.exe");
const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
const tmp = process.env.TEMP ?? join(home, "AppData", "Local", "Temp");

// ---------- 结果汇总 ----------
const results: { id: string; ok: boolean | null; note: string }[] = [];
function report(id: string, ok: boolean | null, note: string) {
  const tag = ok === null ? "INFO" : ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${id}: ${note}`);
  results.push({ id, ok, note });
}
function summarize(): number {
  const fails = results.filter((r) => r.ok === false);
  console.log(`\n=== ${results.filter((r) => r.ok === true).length} pass, ${fails.length} fail, ${results.filter((r) => r.ok === null).length} info ===`);
  if (fails.length) console.log("failed: " + fails.map((f) => f.id).join(", "));
  return fails.length ? 1 : 0;
}

// ---------- 沙箱执行（对齐 runViaSrt 形态）----------
interface RunResult { stdout: string; stderr: string; exitCode: number; timedOut: boolean }

async function sandboxRun(opts: {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  allowWrite: string[];
  allowRead: string[];
  allowedDomains: string[];
  denyRead: string[];
  timeoutMs?: number;
}): Promise<RunResult> {
  await SandboxManager.initialize({
    network: { allowedDomains: opts.allowedDomains, deniedDomains: [] },
    filesystem: { denyRead: opts.denyRead, allowRead: opts.allowRead, allowWrite: opts.allowWrite, denyWrite: [] },
    windows: { srtWin: { path: srtWinExe } },
  });
  try {
    await SandboxManager.waitForNetworkInitialization();
    const wrapped = await SandboxManager.wrapWithSandboxArgv(opts.command, "cmd", undefined, undefined, opts.cwd);
    // 异步 spawn 铁律：绝不 spawnSync（srt 网络代理依赖事件循环，同 mac spike 教训）
    const proc = Bun.spawn({
      cmd: wrapped.argv,
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}), ...(wrapped.env as Record<string, string>) },
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, opts.timeoutMs ?? 60_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode, timedOut };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    SandboxManager.cleanupAfterCommand();
    await SandboxManager.reset();
  }
}

function requireWin() {
  if (process.platform !== "win32") {
    console.error("this command only runs on Windows (pipe 子命令除外)");
    process.exit(2);
  }
  if (!existsSync(srtWinExe)) {
    console.error(`srt-win.exe not found next to exe: ${srtWinExe}`);
    process.exit(2);
  }
}

// ---------- S2–S7 ----------
async function cmdRun(): Promise<number> {
  requireWin();
  const ws = join(tmp, "pie-spike", "ws");
  const secretDir = join(home, ".pie-spike-secret");
  const secretFile = join(secretDir, "token.txt");
  const denyFile = join(home, "pie-spike-deny.txt");
  rmSync(join(tmp, "pie-spike"), { recursive: true, force: true });
  rmSync(denyFile, { force: true });
  mkdirSync(ws, { recursive: true });
  mkdirSync(secretDir, { recursive: true });
  writeFileSync(secretFile, "SECRET");

  // 所有用例共享的基线：workspace 可写、exe 目录可读（srt-sandbox 账户对用户
  // profile 天然无权限，spike 包若解压在 Downloads，不加 allowRead 连 exe 都读不到）
  const base = { cwd: ws, allowWrite: [ws], allowRead: [exeDir], denyRead: [secretDir] };

  // S2a 写白名单内：应成功
  {
    const okFile = join(ws, "ok.txt");
    const r = await sandboxRun({ ...base, allowedDomains: [], command: `echo hello> "${okFile}"` });
    report("S2a-write-allowed", r.exitCode === 0 && existsSync(okFile), `exit=${r.exitCode} exists=${existsSync(okFile)} ${r.stderr.slice(0, 120)}`);
  }
  // S2b 写白名单外：应失败
  {
    const r = await sandboxRun({ ...base, allowedDomains: [], command: `echo x> "${denyFile}"` });
    report("S2b-write-denied", !existsSync(denyFile), `exit=${r.exitCode} exists=${existsSync(denyFile)} ${r.stderr.slice(0, 120)}`);
    rmSync(denyFile, { force: true });
  }
  // S3 默认断网：应失败（curl 是 Win10 1803+ 自带；--ssl-no-revoke 避免 CRL 撞围栏的假信号）
  {
    const r = await sandboxRun({ ...base, allowedDomains: [], command: `curl.exe -sS --ssl-no-revoke -m 15 https://example.com`, timeoutMs: 30_000 });
    report("S3-network-deny-all", r.exitCode !== 0, `exit=${r.exitCode} timedOut=${r.timedOut} ${r.stderr.slice(0, 120)}`);
  }
  // S4a 域名白名单放行：应成功
  {
    const r = await sandboxRun({ ...base, allowedDomains: ["example.com"], command: `curl.exe -sS --ssl-no-revoke -m 20 https://example.com`, timeoutMs: 40_000 });
    report("S4a-allowlist-pass", r.exitCode === 0 && r.stdout.length > 0, `exit=${r.exitCode} bytes=${r.stdout.length} ${r.stderr.slice(0, 120)}`);
  }
  // S4b 白名单外域名：应失败
  {
    const r = await sandboxRun({ ...base, allowedDomains: ["example.com"], command: `curl.exe -sS --ssl-no-revoke -m 15 https://www.google.com`, timeoutMs: 30_000 });
    report("S4b-allowlist-block", r.exitCode !== 0, `exit=${r.exitCode} ${r.stderr.slice(0, 120)}`);
  }
  // S5 敏感读拒：应失败
  {
    const r = await sandboxRun({ ...base, allowedDomains: [], command: `type "${secretFile}"` });
    report("S5-deny-read", r.exitCode !== 0 && !r.stdout.includes("SECRET"), `exit=${r.exitCode} leaked=${r.stdout.includes("SECRET")} ${r.stderr.slice(0, 120)}`);
  }
  // S6-env 探针：broker 传给 Bun.spawn 的自定义 env 是否穿透到沙箱内进程
  // （v1 实测：不穿透——CreateProcessWithLogonW 换账户不带 broker env；此项固化取证）
  {
    const r = await sandboxRun({ ...base, allowedDomains: [], command: `echo PROBE=%BUN_BE_BUN%`, env: { BUN_BE_BUN: "1" } });
    const passed = r.stdout.includes("PROBE=1");
    report("S6a-env-passthrough", null, passed ? "broker env DOES reach sandbox" : `broker env does NOT reach sandbox (out=${r.stdout.trim().slice(0, 40)})`);
  }
  // S6b 内嵌 Bun 解释器：BUN_BE_BUN 经 cmd 内联 set 注入（沙箱内 cmd → 子进程继承，
  // 绕开 srt-win 不透传 broker env 的限制；产品 skill-exec Windows 分支须走同款通道）
  {
    const hello = join(ws, "hello.ts");
    writeFileSync(hello, `console.log("bun-ok:" + (1 + 1));`);
    const r = await sandboxRun({
      ...base,
      allowedDomains: [],
      command: `set "BUN_BE_BUN=1" && "${process.execPath}" run "${hello}"`,
    });
    report("S6b-embedded-bun", r.exitCode === 0 && r.stdout.includes("bun-ok:2"), `exit=${r.exitCode} out=${r.stdout.slice(0, 80)} ${r.stderr.slice(0, 120)}`);
  }
  // S7 全局 python 可用性（informational，不计入 Gate 硬项）。
  // WindowsApps 下的 python.exe 是 Store 执行别名 stub（per-user reparse point），
  // 沙箱账户必然拒绝访问——按"无 python"处理（产品探测也须同样排除）。
  {
    const where = Bun.spawnSync(["where.exe", "python"]); // 宿主侧探测，非沙箱内，spawnSync 无害
    const candidates = where.exitCode === 0
      ? where.stdout.toString().trim().split(/\r?\n/).filter((p) => !/\\WindowsApps\\/i.test(p))
      : [];
    const found = candidates[0] ?? null;
    if (!found) {
      report("S7-python", null, "no global python on PATH (WindowsApps stub excluded) — skipped");
    } else {
      const r = await sandboxRun({ ...base, allowedDomains: [], command: `"${found}" -c "print('py-ok')"` });
      report("S7-python", null, `path=${found} exit=${r.exitCode} out=${r.stdout.trim().slice(0, 40)} ${r.stderr.slice(0, 120)}`);
    }
  }

  rmSync(join(tmp, "pie-spike"), { recursive: true, force: true });
  rmSync(secretDir, { recursive: true, force: true });
  return summarize();
}

// ---------- S8 named pipe ----------
async function cmdPipe(): Promise<number> {
  const path = process.platform === "win32" ? `\\\\.\\pipe\\pie-spike-${process.pid}` : join(tmp, `pie-spike-${process.pid}.sock`);
  const ok = await new Promise<boolean>((resolve) => {
    const server = net.createServer((sock) => sock.on("data", (d) => sock.write(d)));
    server.on("error", (e) => { console.error("server error:", e.message); resolve(false); });
    server.listen(path, () => {
      const client = net.connect(path);
      const timer = setTimeout(() => { client.destroy(); server.close(); resolve(false); }, 5000);
      client.on("connect", () => client.write("ping"));
      client.on("data", (d) => {
        clearTimeout(timer);
        const good = d.toString() === "ping";
        client.end();
        server.close(() => resolve(good));
      });
      client.on("error", (e) => { clearTimeout(timer); console.error("client error:", e.message); server.close(); resolve(false); });
    });
  });
  report("S8-named-pipe", ok, `path=${path}`);
  return summarize();
}

// ---------- 设施生命周期 ----------
async function cmdStatus(): Promise<number> {
  requireWin();
  const srtWin = resolveSrtWin({ path: srtWinExe });
  const status = await checkWindowsSandboxStatusAsync({ srtWin });
  console.log("sandbox status:", JSON.stringify(status, null, 2));
  // 非管理员读不了 BFE filter 表（cannot-read 属预期），行为级验证走 egress probe：
  // 以 srt-sandbox 身份实际尝试直连出站，blocked = 围栏在位。
  try {
    const egress = await verifyWindowsWfpEgress({ srtWin });
    console.log("wfp egress probe:", JSON.stringify(egress, null, 2));
  } catch (e) {
    console.log("wfp egress probe FAILED (fence may be absent):", e instanceof Error ? e.message : String(e));
  }
  return 0;
}

async function cmdInstall(): Promise<number> {
  requireWin();
  console.log("triggering one-time elevated install (UAC prompt incoming)...");
  const r = await installWindowsSandboxAsync({ srtWin: resolveSrtWin({ path: srtWinExe }) });
  console.log(JSON.stringify(r, null, 2));
  return 0;
}

function cmdUninstall(): number {
  requireWin();
  const r = uninstallWindowsSandbox({ srtWin: resolveSrtWin({ path: srtWinExe }) });
  console.log(JSON.stringify(r, null, 2));
  return 0;
}

// ---------- main ----------
const cmd = process.argv[2];
let code: number;
switch (cmd) {
  case "status": code = await cmdStatus(); break;
  case "install": code = await cmdInstall(); break;
  case "uninstall": code = cmdUninstall(); break;
  case "run": code = await cmdRun(); break;
  case "pipe": code = await cmdPipe(); break;
  case "all": {
    await cmdStatus();
    await cmdRun();
    code = await cmdPipe();
    break;
  }
  default:
    console.log("usage: pie-spike <status|install|run|pipe|all|uninstall>");
    code = 2;
}
process.exit(code);
