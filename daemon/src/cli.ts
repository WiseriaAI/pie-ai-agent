import { doctor } from "./doctor";

export async function runCli(argv: string[]): Promise<number> {
  const cmd = argv[0];
  switch (cmd) {
    case "daemon": {
      const { startDaemon } = await import("./daemon");
      await startDaemon();
      return 0; // 常驻，正常不返回
    }
    case "host": {
      const { runHost } = await import("./host");
      await runHost();
      return 0;
    }
    case "doctor": {
      const r = await doctor();
      for (const l of r.lines) console.error(l);
      return r.ok ? 0 : 1;
    }
    case "windows-install":
    case "windows-uninstall":
    case "windows-status": {
      // Inno 安装器/卸载器调这些子命令装/卸 Windows 脚本沙箱设施（spec §3.2 / §4.5）。
      // install/uninstall 是 best-effort：失败只报告不阻断（安装器 [Code] 亦忽略退出码），
      // 故恒返回 0；status 返回就绪判定（ready→0 / 未就绪→1，供 doctor/自检读）。
      const { runWindowsSandboxSetup } = await import("./windows-sandbox-setup");
      const action = cmd.slice("windows-".length) as "install" | "uninstall" | "status";
      const r = await runWindowsSandboxSetup(action);
      console.error(`[pie] windows-${action}: ${r.skipped ? "skipped" : r.ok ? "ok" : "not-ok"} — ${r.detail}`);
      return action === "status" ? (r.ok ? 0 : 1) : 0;
    }
    case "--version":
    case "version": {
      const { DAEMON_VERSION } = await import("./version");
      console.log(DAEMON_VERSION);
      return 0;
    }
    default:
      console.error(
        `unknown command: ${cmd ?? "(none)"}. usage: pie <daemon|host|doctor|version|windows-install|windows-uninstall|windows-status>`,
      );
      return 2;
  }
}

if (import.meta.main) {
  runCli(Bun.argv.slice(2)).then((code) => process.exit(code));
}
