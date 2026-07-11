# Pie Link：daemon 制品化（签名 pkg + CI 发布 + 版本握手 + 安装漏斗 + 顶栏 app）

- 日期：2026-07-11
- Issue：#267
- 状态：spec 定稿待拆 issue

## 1. 背景与目标

本地 daemon 核心能力已合 main（PR #259/#262/#265/#266），但分发是纯手工（本地 `bun run compile` + 手动拷贝）。目标：daemon 成为随发版发布的正式制品，真实用户能装、能看到装好了、能知道要不要升级。

范围限定：**v1 仅 macOS + Chrome**。

## 2. 命名

对外制品名 **Pie Link**，只出现在：设置页文案、release 资产名（`pie-link*.pkg`）、README/下载引导、顶栏 app 名（`Pie Link.app`）。

不动的：二进制名 `pie`、内部 id（`ai.wiseria.pie`、`~/.pie/`）、代码内 bridge 术语。改内部 id 会破坏已装用户。

## 3. 制品结构

单一 **universal .pkg**（arm64 + x64 经 `lipo` 合一；一个下载链接、无架构选择，体积翻倍可接受）。

pkg payload / postinstall 产物：

| 路径 | 内容 | 装入方式 |
|---|---|---|
| `/usr/local/bin/pie` | universal 单二进制（signed） | payload |
| `/Applications/Pie Link.app` | 顶栏 app（signed，LSUIElement） | payload |
| `/usr/local/bin/pie-host` | host wrapper（`exec pie host`） | postinstall |
| `~/Library/.../Chrome/NativeMessagingHosts/ai.wiseria.pie.json` | native host manifest（EXT_ID 打包时注入） | postinstall |
| `~/Library/LaunchAgents/ai.wiseria.pie.plist` | daemon LaunchAgent | postinstall |
| `~/Library/LaunchAgents/ai.wiseria.pie.menubar.plist` | 顶栏 app LaunchAgent（RunAtLoad，登录自启） | postinstall |

postinstall 沿用现有 console-user 解析逻辑（root 上下文写 per-user 路径），新增 menubar plist 一条，且 load 后**立即启动顶栏 app**——图标出现即安装成功的即时反馈。

生产扩展 ID 恒定（manifest.json 已固定 `key`）：`gpccjhdgjkmalnepmeclooflliiocfed`，CI 以常量注入 `build-pkg.sh`。

## 4. 签名 / 公证

前提：已有可用 Apple Developer 账号。需签发两张证书：

- **Developer ID Application** — 签 `pie` 二进制与 `Pie Link.app`。`pie` 是 bun compile 产物（内嵌 JavaScriptCore JIT），hardened runtime 下必须带 entitlements（至少 `com.apple.security.cs.allow-jit`，具体按 bun 官方文档；entitlements plist 进仓库 `daemon/install/`）。**这是全链路最可能踩坑的点，tracer bullet 1 首先验证。**
- **Developer ID Installer** — 签 pkg（`pkgbuild --sign` 或 `productsign`）。

公证：`xcrun notarytool submit --wait`（App Store Connect API key 凭据，比 Apple ID + app 专用密码更适合 CI）+ `xcrun stapler staple`。

CI secrets：

| Secret | 内容 |
|---|---|
| `APPLE_CERT_P12` | 两张证书合一导出的 p12，base64 |
| `APPLE_CERT_PASSWORD` | p12 密码 |
| `APPLE_NOTARY_KEY_ID` / `APPLE_NOTARY_KEY_ISSUER` / `APPLE_NOTARY_KEY` | App Store Connect API key 三元组（key 为 p8 内容） |

job 内建临时 keychain 导入证书，job 结束销毁。

## 5. CI 发布

`release.yml` 新增 `build-daemon-pkg` job（`runs-on: macos-14`），与现有扩展 zip job 并行，同一 `v*` tag / `workflow_dispatch` 触发：

```
setup-bun → (cd daemon) bun install --frozen-lockfile → bun test
→ bun build --compile --target=bun-darwin-arm64 / bun-darwin-x64（版本注入见 §6）
→ lipo -create 合 universal
→ 构建顶栏 app（swiftc 或 xcodebuild，见 §8）
→ codesign（binary 带 entitlements + hardened runtime；.app 常规 hardened runtime）
→ build-pkg.sh（EXT_ID 常量 + daemon 版本）→ 签 pkg → notarytool --wait → staple
→ 上传两个资产名
```

资产命名：
- `pie-link.pkg` — 版本无关名。`https://github.com/WiseriaAI/pie-ai-agent/releases/latest/download/pie-link.pkg` 成为永久稳定 URL，设置页安装卡片硬编码它
- `pie-link-<daemonVer>.pkg` — 同一文件存档名

`build-pkg.sh` 改造：接受已签名二进制、签名步骤留在 workflow 层——本地无证书仍可跑通 unsigned 路径（开发用）。

扩展 job 不动；daemon job 失败不阻塞扩展 zip 上传（两 job 独立）。

## 6. 版本策略与握手

- daemon 独立版本号，唯一源 `daemon/package.json` 新增 `version` 字段（起始 `0.1.0`）。发布载具仍是扩展 tag：每次 release 重建上传 pkg，daemon 没改动就是同版本号重传（幂等，无独立 tag 流程）
- 编译时经 `bun build --define` 注入二进制；`pie --version` 输出
- `hello` 响应加 `daemonVersion: string`（`src/types/local-bridge.ts` 加法演进，PROTOCOL_VERSION 不动）
- 扩展内置 `MIN_DAEMON_VERSION` 常量，semver 比较用 split-compare 手写（不加依赖）
- 兼容性分两级：
  - `PROTOCOL_VERSION` 不匹配 = 硬不兼容，「本地打通」不可用，设置页强提示升级
  - `daemonVersion < MIN_DAEMON_VERSION` = 软提示：显示「需要升级」卡（链接即 `pie-link.pkg` 稳定 URL，重装即升级），功能按现有 capability 机制降级继续用
- 设置页「本地打通」显示当前 daemon 版本

## 7. 安装引导漏斗

```
开关打开 → nativeMessaging 授权 → SW connectNative 失败（host manifest 不存在）
→ 状态 = 未安装 → 设置页安装卡片：下载 pie-link.pkg + 简要步骤 + 「装完会自动连接」
→ 用户安装（postinstall 写 host manifest + launchd + 顶栏图标出现）
→ 重连梯子自动探测连上 → 卡片翻转为已连接态
```

设置页卡片状态机（在现有「本地打通」区块内扩展）：

| 态 | 判定 | 呈现 |
|---|---|---|
| 未安装 | connectNative 失败且 lastError 指示 host not found | 安装卡：下载按钮 + 步骤 |
| 已装未连 | host 存在但桥不通（daemon 未跑等） | `pie doctor` 引导文案 |
| 已连接 | 桥通 | 现有状态 + daemon 版本 |
| 需升级 | §6 两级判定 | 升级卡（复用下载按钮） |

行为要求：
- 现有重连梯子（1s→30s 封顶）只覆盖「意外断开」；本轮扩展为**开关开启且未安装/未连上时也持续按梯子重试**，直到连上或用户关开关。装完 ≤30s 内自动连上
- 卡片留「重新检测」按钮兜底（手动立即重试）
- lastError 文案不可区分「未安装 / 已装未连」时，统一给安装卡 + doctor 兜底文案

## 8. Pie Link 顶栏 app

macOS 后台守护进程的标准产品形态（Tailscale / Ollama 先例）。价值：安装成功即时反馈（图标出现）、浏览器之外的常驻连接状态可见性（回应「静默降级无感知」）、本机 skill 执行透明度。

- **实现**：Swift（MenuBarExtra 或 AppKit NSStatusItem，macOS 13+），`LSUIElement = true`（无 Dock 图标），点击展开菜单。无 Xcode 工程依赖优先（swiftc + Info.plist 可构建即可）；源码住 `daemon/menubar/`
- **数据面**：daemon.sock 的又一个本地客户端，复用现有 JSON framing。菜单**点开时才查询**，不常驻轮询
- **菜单内容（v1）**：
  1. 状态行：`Pie Link vX.Y.Z · 运行中`（socket 连不上则「未运行」+ 引导）
  2. 扩展连接：已连接 / 未连接
  3. 正在运行的 skill（无则显示「无」）
  4. 最近执行：audit 前 5 条（只读，来自现有 `list_audit`）
  5. 诊断：执行 `pie doctor`，结果弹窗显示
  6. 退出：只退顶栏图标；daemon 由 launchd 独立管理，不受影响
- **daemon 侧新增**：`status` RPC（`{ version, uptimeSec, extensionConnected, runningSkills: [{name, startedAt}] }`）；skill-exec 加活跃执行注册表；host 连接计数（extensionConnected = 活跃 native host 连接 > 0）。wire 类型进 `src/types/local-bridge.ts`（加法）
- **自启**：postinstall 装 LaunchAgent（RunAtLoad），默认登录自启；退出后下次登录回来。「隐藏图标」偏好不做（v1 用退出兜底）

## 9. 非目标（v1 明确不做）

- Windows / Linux（daemon 仅有 launchd 支持）
- Edge 的 native host 注册（Edge NativeMessagingHosts 目录 + Edge 扩展 ID，独立 issue）
- Homebrew / curl-install 通道（签名 pkg 已覆盖主流路径，需要时后补）
- daemon / 顶栏 app 自动更新（重装即升级）
- 顶栏 app 的设置界面、通知推送、隐藏图标偏好
- App Store 分发

## 10. Tracer-bullet 拆分（spec 定稿后建 issue，直接标 ready-for-implement）

| # | 内容 | 依赖 |
|---|---|---|
| 1 | 签名/公证链路打通：universal 二进制 + entitlements codesign + 签名 pkg + notarize 手动全程跑通，干净 Mac 真机验 Gatekeeper 放行。纯脚本改造（`build-pkg.sh` 拆分 + entitlements plist），不动扩展 | — |
| 2 | `release.yml` 加 `build-daemon-pkg` job + secrets 配置 + 版本注入 + 双资产名上传 | 1 |
| 3 | 版本握手：`hello.daemonVersion` + `MIN_DAEMON_VERSION` + 设置页版本显示/两级升级提示 | 可与 1 并行 |
| 4 | 安装引导卡片状态机 + 未安装态持续重试 + 「重新检测」 | 3 |
| 5 | Pie Link 顶栏 app + daemon `status` RPC/活跃执行注册表 + pkg payload 集成（menubar plist + postinstall） | 签名集成依赖 1；开发可与 3/4 并行 |

## 11. 验证

- Tracer 1/2：干净 Mac（或新建用户）下载 release 资产双击安装，Gatekeeper 放行、图标出现、`pie doctor` 全绿、扩展连上
- Tracer 3/4：`pnpm test` 覆盖版本比较/状态机分支；真机走一遍「未装 → 装 → 自动连上」漏斗
- Tracer 5：菜单各项数据与设置页一致；跑一个 disk skill 时「正在运行」出现；退出图标后 daemon 不死
