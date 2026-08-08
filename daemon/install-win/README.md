# Pie Link Windows 安装器（Inno Setup）

macOS `.pkg`（`daemon/install/`）的 Windows 对应物。权威设计：
`docs/specs/2026-08-05-daemon-windows-support.md` §4.2 / §4.5 + 实测发现 F1 / F5。

## 文件

- **`pie-link.iss`** — Inno Setup 6 脚本（唯一打包入口）。
- **`pie-host.bat`** — native messaging host wrapper。Chrome 只能在 manifest 里指一个不带
  参数的可执行路径，而 `pie.exe` 需要 `host` 子命令，故加这层 wrapper（两行 bat，真机
  2026-08-08 验证 Chrome 正常拉起、扩展正常连上——**不需要**单独编 `pie-host.exe`）。

## 装什么（→ `%ProgramFiles%\Pie Link\`，本地盘）

| 文件 | 来源 | 说明 |
|---|---|---|
| `pie.exe` | `bun build --compile --target=bun-windows-x64` | daemon，兼作 `host` / `windows-*` 子命令 |
| `pie-host.bat` | 本目录 | native messaging wrapper |
| `PieTray.exe` | `daemon/tray-win/build-tray.ps1` | 最小托盘 app（C# net48） |
| `srt-win.exe` | `@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/` | 沙箱后端伴随文件（bun 单二进制无隐式回落，spec §6.1） |
| `vc_redist.x64.exe` | https://aka.ms/vs/17/release/vc_redist.x64.exe | 装到 `{tmp}` 装完即删；**F1**：srt-win 动链 `VCRUNTIME140.dll`，缺失时 loader 阶段静默死 |

**为什么必须装本地盘 Program Files（F5）**：exe 位于网络路径（UNC / 映射盘 / VM 共享
文件夹）时提权进程找不到自身 → `ERROR_BAD_NETPATH`。`{autopf}` 天然规避。

## 安装器做什么

- **`[Registry]`**（全机器级 **HKLM**）：写 Chrome + Edge 的
  `NativeMessagingHosts\ai.wiseria.pie` 键（默认值 = manifest json 绝对路径，json 落
  **`{app}`（Program Files，全用户可读）**）+ **HKLM** `Run` key（登录自启**托盘**；daemon
  由 host 兜底拉起，spec §4.4）。`allowed_origins` 固定
  `chrome-extension://gpccjhdgjkmalnepmeclooflliiocfed/`。
  **为什么 HKLM 而非 HKCU**：这是提权的机器级安装（WFP 围栏 + `srt-sandbox` 账户都是机器
  作用域）。若标准用户凭**另一个**管理员账户提权，HKCU / `%LOCALAPPDATA%` 会落到那个管理员的
  hive/profile，而 Chrome 以标准用户身份跑 → 永远读不到 per-user 的 NM manifest。HKLM 的 NM
  host 键对每个用户都生效，manifest json 放 `{app}` 世界可读，从根上消掉这个身份错配。
- **`[Code]` ssPostInstall**（顺序，容错）：写 native manifest → `vc_redist /install /quiet
  /norestart`（**F1**，先于沙箱）→ `pie.exe windows-install`（装沙箱设施，一次 UAC 内完成；
  **失败/取消不阻断安装**，只降级脚本执行，spec §3.2 fail-closed）→ 以调用者身份启动托盘。
- **卸载**：停托盘 → `pie.exe windows-uninstall`（清 `srt-sandbox` 账户 / WFP / ACE）→ 杀
  残留 daemon → 删注册表键 / `Run` 值 / `{app}\ai.wiseria.pie.json`。

## 构建

```powershell
# 前置：daemon/dist 里已备好 pie.exe / PieTray.exe / srt-win.exe / vc_redist.x64.exe
iscc /DMyAppVersion=1.2.3 daemon\install-win\pie-link.iss
# 产物 → daemon\dist\pie-link-setup-1.2.3.exe
```

- `MyAppVersion`（必给）= daemon/package.json 的 version；CI 从那里读。
- `DistDir`（可选，默认 `..\dist` = `daemon/dist`）= 上表四个 payload 的暂存目录。
- CI 接线见 `.github/workflows/release.yml` 的 `build-daemon-win` job（每 tag 交叉编译 +
  `choco install innosetup` + iscc → 上传 release asset）。

## 尚未做（首期明确不含）

- **代码签名**：首期不签（接受 SmartScreen 摩擦，spec 决策 9）。`.iss` `[Setup]` 与 CI
  均留签名占位，拿到证书填 secrets 即生效。
- **品牌图标**：托盘图标目前代码画（琥珀色派），真 `.ico` 资产走 #379；届时
  `SetupIconFile` + PieTray 资源一并接入。
- 真机全流程验收走 PR 的 `need-human-test`（下载 → SmartScreen → 一次 UAC → 完成页 →
  托盘图标 → 扩展自动连接；卸载无残留；重装幂等）。
