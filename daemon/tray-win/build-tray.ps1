# daemon/tray-win/build-tray.ps1 — csc 组 net48 单 exe（PieTray.exe）。
# 用法: build-tray.ps1 [-OutDir <dir>] [-Version <x.y.z>]
# CI windows runner 自带 csc（.NET Framework SDK），无额外分发依赖。安装器接线见 #363。
param(
    [string]$OutDir = (Join-Path $PSScriptRoot "..\dist"),
    [string]$Version = "0.0.0"
)
$ErrorActionPreference = "Stop"

# 定位 net48 csc：优先 Framework64 v4.0.30319（windows runner 稳定路径），
# 回落到当前进程 runtime 目录。
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    $csc = Join-Path ([System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) "csc.exe"
}
if (-not (Test-Path $csc)) { throw "csc.exe not found (need .NET Framework 4.x)" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$out = Join-Path $OutDir "PieTray.exe"

# 版本戳进 exe 元数据（安装器 / 未来签名读；界面版本走 daemon status RPC）。
# AssemblyVersion 需 4 段数字，补齐末段。
$ver4 = "$Version.0"
$asmInfo = Join-Path $OutDir "trayinfo.cs"
@"
using System.Reflection;
[assembly: AssemblyTitle("Pie Link")]
[assembly: AssemblyProduct("Pie Link")]
[assembly: AssemblyCompany("Wiseria")]
[assembly: AssemblyVersion("$ver4")]
[assembly: AssemblyFileVersion("$ver4")]
"@ | Set-Content -Encoding UTF8 -Path $asmInfo

# /target:winexe = 无控制台窗口；/platform:x64 对齐首期 x64-only 支持面。
& $csc /nologo /target:winexe /platform:x64 /out:"$out" `
    /r:System.dll `
    /r:System.Drawing.dll `
    /r:System.Windows.Forms.dll `
    /r:System.Web.Extensions.dll `
    (Join-Path $PSScriptRoot "PieTray.cs") `
    "$asmInfo"
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit $LASTEXITCODE" }

Remove-Item $asmInfo -ErrorAction SilentlyContinue
Write-Host "built $out"
