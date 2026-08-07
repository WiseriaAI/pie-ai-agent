# daemon/tray-win/build-tray.ps1 — csc 组 net48 单 exe（PieTray.exe）。
# 用法: build-tray.ps1 [-OutDir <dir>] [-Version <x.y.z>]
# 安装器接线见 #363。
#
# ⚠️ 本文件与 PieTray.cs 都必须存成 **带 BOM 的 UTF-8**：中文系统的 Windows PowerShell 5.1
# 按 ANSI(GBK) 读无 BOM 的 .ps1，中文注释乱码后语法直接崩；csc 同理会把无 BOM 源码按 ANSI
# 读，六语言菜单文案会乱码进 exe。
param(
    [string]$OutDir = (Join-Path $PSScriptRoot "..\dist"),
    [string]$Version = "0.0.0"
)
$ErrorActionPreference = "Stop"

# Roslyn 编译器版本（下载回落用；固定版本保证构建可复现）。
$RoslynVersion = "4.14.0"

# 定位 csc。⚠️ 不能用系统内置的 %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
# ——那是 C# 5 编译器，编不了 PieTray.cs 里的字典索引初始化 `["k"] = v`(C#6) 与
# `out var`(C#7)，报一屏 CS1525。装了 VS 的机器（含 GitHub windows runner）有 Roslyn 版；
# 干净机器上回落到固定版本的 Microsoft.Net.Compilers.Toolset（缓存在 LOCALAPPDATA，只下一次）。
function Resolve-Csc {
    if ($env:PIE_CSC -and (Test-Path $env:PIE_CSC)) { return $env:PIE_CSC }

    $pf86 = ${env:ProgramFiles(x86)}
    if ($pf86) {
        $vswhere = Join-Path $pf86 "Microsoft Visual Studio\Installer\vswhere.exe"
        if (Test-Path $vswhere) {
            $vs = & $vswhere -latest -products * -property installationPath 2>$null | Select-Object -First 1
            if ($vs) {
                $c = Join-Path $vs "MSBuild\Current\Bin\Roslyn\csc.exe"
                if (Test-Path $c) { return $c }
            }
        }
    }

    $cache = Join-Path $env:LOCALAPPDATA "pie-build\roslyn-$RoslynVersion"
    $cached = Join-Path $cache "tasks\net472\csc.exe"
    if (Test-Path $cached) { return $cached }

    Write-Host "未找到 Roslyn csc，下载 Microsoft.Net.Compilers.Toolset $RoslynVersion ..."
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    # Expand-Archive 只认 .zip 扩展名，nupkg 存成 .zip 再解
    $nupkg = Join-Path $env:TEMP "roslyn-$RoslynVersion.zip"
    $url = "https://api.nuget.org/v3-flatcontainer/microsoft.net.compilers.toolset/$RoslynVersion/microsoft.net.compilers.toolset.$RoslynVersion.nupkg"
    $prev = $ProgressPreference; $ProgressPreference = "SilentlyContinue"
    try { Invoke-WebRequest -Uri $url -OutFile $nupkg -UseBasicParsing } finally { $ProgressPreference = $prev }
    Expand-Archive -Path $nupkg -DestinationPath $cache -Force
    Remove-Item $nupkg -ErrorAction SilentlyContinue
    if (-not (Test-Path $cached)) { throw "Roslyn 编译器解压后仍找不到 $cached" }
    return $cached
}

$csc = Resolve-Csc
Write-Host "using csc: $csc"

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
