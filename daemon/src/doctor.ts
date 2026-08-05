import { existsSync } from "fs";
import { paths } from "./paths";
import { listSkillsMerged } from "./skill-store";
import type { SkillSummary } from "../../src/types/local-bridge";

export async function doctor(
  // 注入点：默认扫真实两根，测试可传桩清单做 hermetic 断言。
  listSkills: () => SkillSummary[] = listSkillsMerged,
): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  // named pipe 不在文件系统命名空间，existsSync 无法反映 daemon 是否在跑——只报地址、
  // 不做在场判定；ok 在 pipe 平台不把 IPC 在场性算进去（避免误报「未运行」）。
  const ipcPresent = paths.isPipe ? null : existsSync(paths.ipcPath);
  if (paths.isPipe) {
    lines.push(`pipe ${paths.ipcPath}: (existence not fs-checkable on Windows)`);
  } else {
    lines.push(`socket ${paths.ipcPath}: ${ipcPresent ? "present" : "absent (daemon not running?)"}`);
  }
  const claude = Bun.which("claude");
  lines.push(`claude CLI: ${claude ?? "NOT FOUND on PATH"}`);

  // skill 网络声明健康检查：列出被安全丢弃的非法域名（作者信号；不影响 ok，
  // 断网是安全兜底而非故障）。
  let skills: SkillSummary[] = [];
  try {
    skills = listSkills();
  } catch {
    /* 扫 skill 失败不该拖垮 doctor 的核心检查 */
  }
  for (const s of skills) {
    if (s.invalidNetwork && s.invalidNetwork.length > 0) {
      lines.push(`skill "${s.name}": ${s.invalidNetwork.length} invalid network domain(s) ignored: ${s.invalidNetwork.join(", ")}`);
    }
  }

  // pipe 平台无法 fs 判在场（ipcPresent=null）→ 不拿它压 ok，只看 claude CLI。
  const ok = (ipcPresent ?? true) && claude != null;
  return { ok, lines };
}
