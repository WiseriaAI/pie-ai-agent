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
    case "--version":
    case "version": {
      const { DAEMON_VERSION } = await import("./version");
      console.log(DAEMON_VERSION);
      return 0;
    }
    default:
      console.error(`unknown command: ${cmd ?? "(none)"}. usage: pie <daemon|host|doctor|version>`);
      return 2;
  }
}

if (import.meta.main) {
  runCli(Bun.argv.slice(2)).then((code) => process.exit(code));
}
