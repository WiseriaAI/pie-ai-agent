# Pie Link Windows — Gate 0 spike 操作手册

目的：验证 srt-win（alpha）沙箱在我们的单二进制形态里端到端可用。对应 spec
`docs/specs/2026-08-05-daemon-windows-support.md` §2.2 的 S1–S10。
机器要求：Windows 10 22H2+ 或 Windows 11，x64（S9 用 arm64 设备跑同一包）。

## 步骤（PowerShell，普通权限即可，UAC 会自己弹）

1. 解压 zip 到**Windows 本地盘的普通目录**（如 `C:\pie-spike`），进入该目录：
   ```powershell
   cd C:\pie-spike
   ```
   ⚠️ 不要在映射网络盘 / UNC 路径 / 虚拟机共享文件夹（Parallels 的 `\\Mac\...`、VMware Shared Folders）里直接跑——UAC 提权后的进程在新 logon session 里看不到这些映射，`install` 会以 exit 53（ERROR_BAD_NETPATH）失败。
2. **S1 安装沙箱设施**（弹一次 UAC，批准）：
   ```powershell
   .\pie-spike.exe install
   ```
   预期：输出 JSON、无异常。接着重跑一次同命令验证幂等（预期同样成功）。
3. **状态检查**：
   ```powershell
   .\pie-spike.exe status
   ```
   预期：显示 srt-sandbox 账户与 WFP 设施就位。
4. **S2–S7 主测试批**：
   ```powershell
   .\pie-spike.exe run
   ```
   预期：`S2a/S2b/S3/S4a/S4b/S5/S6` 全 `[PASS]`（S7 python 是 `[INFO]`，装没装 python 都不算失败，把输出记下来即可）。
5. **S8 named pipe**：
   ```powershell
   .\pie-spike.exe pipe
   ```
   预期：`[PASS] S8-named-pipe`。
6. **S9（可选，有 arm64 设备才做）**：在 arm64 Windows 上重复步骤 1–5（x64 模拟层）。
7. **S10 卸载**（弹一次 UAC）：
   ```powershell
   .\pie-spike.exe uninstall
   ```
   预期：输出 JSON、无 `cancelled`。可再跑 `.\pie-spike.exe status` 确认设施已清。

## 回报格式

把每步的**完整终端输出**原样贴回来（尤其 FAIL 项的 stderr），外加：

- Windows 版本（`winver` 截图或 `[System.Environment]::OSVersion.Version`）
- 是否装了第三方杀软（Defender 之外）
- 步骤 2 的 UAC 弹窗是否只出现一次

## 已知可能的坑（遇到不用慌，照实记录）

- SmartScreen 拦 `pie-spike.exe`：「更多信息 → 仍要运行」。
- 企业策略/杀软可能拦 `CreateProcessWithLogonW`（表现为 run 全批 FAIL、错误 5/1385）——记录错误码即可，这正是 spike 要探的。
- S3/S4 若全部超时挂死而非快速失败，记录每项耗时感受（WFP 围栏行为差异是关键观察点）。
