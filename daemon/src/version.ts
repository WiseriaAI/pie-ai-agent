import pkg from "../package.json";

// daemon 版本唯一源 = daemon/package.json 的 version 字段（spec §6）。
// CI 编译时 `bun build --define process.env.PIE_DAEMON_VERSION="x.y.z"` 静态替换，
// 把版本号内嵌进单文件二进制；本地开发 / 测试无 define → 运行时 env 为空 →
// 回落 package.json。两条路径都收敛到同一个 x.y.z。
export const DAEMON_VERSION: string = process.env.PIE_DAEMON_VERSION || pkg.version;
