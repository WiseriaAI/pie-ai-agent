# Pie Link daemon 制品化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **云端 Loop 注意**：本 plan 按 5 个 tracer-bullet 切片组织，每个切片对应一个独立 GitHub issue，**每个 issue 一个独立 PR**。只实现你所领 issue 对应的切片。Slice 1/2/5 的真机验证（签名、公证、装机）云端做不了，PR 走 `need-human-test`。

**Goal:** daemon 成为随发版发布的正式制品（签名 universal .pkg「Pie Link」）+ 版本握手升级提示 + 安装引导漏斗 + macOS 顶栏状态 app。

**Architecture:** 制品链 = bun 双 target 编译 → lipo universal → codesign（JIT entitlements）→ pkgbuild → productsign → notarytool → staple，跑在 release.yml 新增的 macos job；扩展侧沿用现有桥/重连梯子，只加版本状态与安装卡片；顶栏 app 是 `~/.pie/daemon.sock` 的又一个瘦客户端（Swift/AppKit，点开菜单才查询）。

**Tech Stack:** Bun（daemon）、bash（打包脚本）、GitHub Actions macos-14、Swift/AppKit（顶栏 app）、React/TS + vitest（扩展）。

**Spec:** `docs/specs/2026-07-11-pie-link-daemon-packaging.md`（本 plan 一切取舍以 spec 为准）

## Global Constraints

- 对外名 **Pie Link** 只出现在：设置页文案、release 资产名 `pie-link*.pkg`、顶栏 app 名 `Pie Link.app`。二进制 `pie`、内部 id `ai.wiseria.pie`、`~/.pie/` 一律不动
- 生产扩展 ID 常量：`gpccjhdgjkmalnepmeclooflliiocfed`（manifest.json 固定 key 推导，恒定）
- 稳定下载 URL：`https://github.com/WiseriaAI/pie-ai-agent/releases/latest/download/pie-link.pkg`
- `src/types/local-bridge.ts` 是 wire 唯一权威源，**只加字段不改语义**，PROTOCOL_VERSION 保持 1
- daemon 版本唯一源 `daemon/package.json` 的 `version`；起始 `0.1.0`；`MIN_DAEMON_VERSION = "0.1.0"`
- 扩展侧改动跑 `pnpm test` + `pnpm typecheck` + `pnpm build`；daemon 侧跑 `cd daemon && bun test`
- i18n：新 UI 文案必须同时加进 `src/lib/i18n/dictionaries/` 全部字典（键 parity 强制，typecheck 会挡）
- v1 仅 macOS + Chrome；不做 Windows/Linux/Edge/自动更新

## 文件地图

| 切片 | 创建 | 修改 |
|---|---|---|
| 1 签名链路 | `daemon/install/pie.entitlements`、`daemon/install/release-pkg.sh` | `daemon/install/build-pkg.sh`、`daemon/package.json`（加 version） |
| 2 CI job | — | `.github/workflows/release.yml` |
| 3 版本握手 | `daemon/src/version.ts` | `src/types/local-bridge.ts`、`daemon/src/daemon.ts`、`daemon/src/cli.ts`、`src/background/local-bridge.ts`、`src/background/index.ts`、`src/sidepanel/components/Settings.tsx`、i18n 字典 |
| 4 安装漏斗 | — | `src/background/local-bridge.ts`、`src/background/index.ts`、`src/sidepanel/components/Settings.tsx`、i18n 字典 |
| 5 顶栏 app | `daemon/menubar/main.swift`、`daemon/menubar/Info.plist`、`daemon/menubar/build-app.sh`、`daemon/src/status.ts`、`daemon/install/ai.wiseria.pie.menubar.plist.template` | `daemon/src/daemon.ts`、`daemon/src/skill-exec.ts`、`src/types/local-bridge.ts`、`daemon/install/build-pkg.sh`、`daemon/install/postinstall.sh`、`.github/workflows/release.yml` |

---

## Slice 1：签名/公证链路（脚本层，issue A）

纯脚本 + 配置，不动扩展。产出：本地有证书的人能一条命令产出已签名已公证的 pkg；无证书开发者仍能走 unsigned 路径。

### Task 1.1: daemon 版本字段 + entitlements

**Files:**
- Modify: `daemon/package.json`
- Create: `daemon/install/pie.entitlements`

**Interfaces:**
- Produces: `daemon/package.json` 的 `"version": "0.1.0"`（Slice 2 CI 用 `jq -r .version` 读、Slice 3 `version.ts` import）

- [ ] **Step 1: package.json 加 version**

`daemon/package.json` 的 `"name"` 行后加：

```json
  "version": "0.1.0",
```

- [ ] **Step 2: 写 entitlements**

创建 `daemon/install/pie.entitlements`（bun compile 产物内嵌 JavaScriptCore JIT，hardened runtime 必须显式放行；这是 bun 官方文档给单文件可执行签名的集合，公证通过后可尝试收窄）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-executable-page-protection</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
```

- [ ] **Step 3: 语法自检 + commit**

Run: `plutil -lint daemon/install/pie.entitlements`（本机）或 `python3 -c "import plistlib,sys; plistlib.load(open('daemon/install/pie.entitlements','rb'))"`
Expected: OK / 无异常

```bash
git add daemon/package.json daemon/install/pie.entitlements
git commit -m "feat(daemon): version 字段 + codesign entitlements"
```

### Task 1.2: build-pkg.sh 拆分（可接已签名二进制 + universal）

**Files:**
- Modify: `daemon/install/build-pkg.sh`

**Interfaces:**
- Produces: `build-pkg.sh <EXT_ID> [VERSION] [BIN]` — BIN 给定时跳过本机编译直接用（CI 传入已签名 universal 二进制）；产物 `daemon/dist/pie-link-<VERSION>.pkg`（unsigned，签名在 release-pkg.sh / CI 层）

- [ ] **Step 1: 改写 build-pkg.sh**

```bash
#!/bin/bash
# daemon/install/build-pkg.sh — 组 .pkg。用法: build-pkg.sh <EXT_ID> [VERSION] [BIN]
# BIN 缺省 = 本机编译 dist/pie（开发路径，unsigned）；给定 = 使用外部（已签名）二进制。
# 产物 pkg 本身不签名——签名/公证在 release-pkg.sh（CI）层做。
set -euo pipefail
EXT_ID="${1:?need extension id}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${2:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json")}"
BIN="${3:-}"

if [ -z "$BIN" ]; then
  ( cd "$ROOT" && bun build ./src/cli.ts --compile --outfile dist/pie )
  BIN="$ROOT/dist/pie"
fi

STAGE="$(mktemp -d)"
mkdir -p "$STAGE/usr/local/bin"
cp "$BIN" "$STAGE/usr/local/bin/pie"
chmod +x "$STAGE/usr/local/bin/pie"

SCRIPTS="$(mktemp -d)"
cp "$ROOT/install/postinstall.sh" "$SCRIPTS/postinstall"
chmod +x "$SCRIPTS/postinstall"
sed "s|__EXT_ID__|$EXT_ID|g" "$ROOT/install/ai.wiseria.pie.host.template.json" > "$SCRIPTS/ai.wiseria.pie.host.template.json"
cp "$ROOT/install/ai.wiseria.pie.plist.template" "$SCRIPTS/"

mkdir -p "$ROOT/dist"
pkgbuild --root "$STAGE" --scripts "$SCRIPTS" \
  --identifier ai.wiseria.pie --version "$VERSION" \
  "$ROOT/dist/pie-link-$VERSION.pkg"
echo "built dist/pie-link-$VERSION.pkg (unsigned)"
```

- [ ] **Step 2: 语法自检 + commit**

Run: `bash -n daemon/install/build-pkg.sh`
Expected: 无输出（语法通过）

```bash
git add daemon/install/build-pkg.sh
git commit -m "feat(daemon): build-pkg.sh 接受外部二进制，产物改名 pie-link"
```

### Task 1.3: release-pkg.sh 全链（编译→lipo→codesign→pkg→productsign→notarize→staple）

**Files:**
- Create: `daemon/install/release-pkg.sh`

**Interfaces:**
- Consumes: `build-pkg.sh <EXT_ID> <VERSION> <BIN>`（Task 1.2）、`pie.entitlements`（Task 1.1）
- Produces: `release-pkg.sh <EXT_ID> <VERSION>` — 环境要求：keychain 已含 Developer ID Application/Installer 两证书；env `APPLE_NOTARY_KEY`(p8 内容)/`APPLE_NOTARY_KEY_ID`/`APPLE_NOTARY_KEY_ISSUER`。产物：已签名已公证已 staple 的 `daemon/dist/pie-link-<VERSION>.pkg`（Slice 2 CI 直接调用）

- [ ] **Step 1: 写 release-pkg.sh**

```bash
#!/bin/bash
# daemon/install/release-pkg.sh — 签名发布全链。CI（或有证书的本机）调用。
# 前提: keychain 已导入 Developer ID Application + Installer 证书；
# env: APPLE_NOTARY_KEY / APPLE_NOTARY_KEY_ID / APPLE_NOTARY_KEY_ISSUER
set -euo pipefail
EXT_ID="${1:?need extension id}"
VERSION="${2:?need version}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${APPLE_NOTARY_KEY:?}" "${APPLE_NOTARY_KEY_ID:?}" "${APPLE_NOTARY_KEY_ISSUER:?}"

APP_ID="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
INST_ID="$(security find-identity -v | sed -n 's/.*"\(Developer ID Installer: [^"]*\)".*/\1/p' | head -1)"
[ -n "$APP_ID" ] || { echo "no Developer ID Application identity in keychain" >&2; exit 1; }
[ -n "$INST_ID" ] || { echo "no Developer ID Installer identity in keychain" >&2; exit 1; }

# 1) 双 target 编译 + lipo universal
( cd "$ROOT" \
  && bun build ./src/cli.ts --compile --target=bun-darwin-arm64 \
       --define "process.env.PIE_DAEMON_VERSION=\"$VERSION\"" --outfile dist/pie-arm64 \
  && bun build ./src/cli.ts --compile --target=bun-darwin-x64 \
       --define "process.env.PIE_DAEMON_VERSION=\"$VERSION\"" --outfile dist/pie-x64 )
lipo -create "$ROOT/dist/pie-arm64" "$ROOT/dist/pie-x64" -output "$ROOT/dist/pie-universal"

# 2) 签二进制（hardened runtime + JIT entitlements）
codesign --force --options runtime --timestamp \
  --entitlements "$ROOT/install/pie.entitlements" \
  --sign "$APP_ID" "$ROOT/dist/pie-universal"
codesign --verify --strict "$ROOT/dist/pie-universal"

# 3) 组 pkg（unsigned）→ productsign
"$ROOT/install/build-pkg.sh" "$EXT_ID" "$VERSION" "$ROOT/dist/pie-universal"
mv "$ROOT/dist/pie-link-$VERSION.pkg" "$ROOT/dist/pie-link-$VERSION-unsigned.pkg"
productsign --sign "$INST_ID" \
  "$ROOT/dist/pie-link-$VERSION-unsigned.pkg" "$ROOT/dist/pie-link-$VERSION.pkg"
rm "$ROOT/dist/pie-link-$VERSION-unsigned.pkg"

# 4) 公证 + staple
KEY_FILE="$(mktemp)"; printf '%s' "$APPLE_NOTARY_KEY" > "$KEY_FILE"
xcrun notarytool submit "$ROOT/dist/pie-link-$VERSION.pkg" \
  --key "$KEY_FILE" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_KEY_ISSUER" \
  --wait
rm "$KEY_FILE"
xcrun stapler staple "$ROOT/dist/pie-link-$VERSION.pkg"
echo "signed+notarized dist/pie-link-$VERSION.pkg"
```

- [ ] **Step 2: 语法自检 + commit**

Run: `bash -n daemon/install/release-pkg.sh && chmod +x daemon/install/release-pkg.sh daemon/install/build-pkg.sh`
Expected: 无输出

```bash
git add daemon/install/release-pkg.sh
git commit -m "feat(daemon): release-pkg.sh 签名+公证全链"
```

- [ ] **Step 3: 人工真机验证（PR 标 need-human-test，云端跳过）**

有证书的机器上：导入两证书 → `export APPLE_NOTARY_KEY=... APPLE_NOTARY_KEY_ID=... APPLE_NOTARY_KEY_ISSUER=...` → `daemon/install/release-pkg.sh gpccjhdgjkmalnepmeclooflliiocfed 0.1.0`
Expected: notarytool 状态 `Accepted`；干净 Mac（或新建用户）双击安装 Gatekeeper 放行；`pie doctor` 全绿；`spctl --assess --type install dist/pie-link-0.1.0.pkg` 输出 accepted。
已知风险点：bun 产物 codesign / 公证被拒 → 逐条对照 entitlements 与 bun 官方 single-file executable 签名文档调整。

---

## Slice 2：release.yml 加 daemon job（issue B，依赖 Slice 1 合并 + secrets 就位）

### Task 2.1: build-daemon-pkg job

**Files:**
- Modify: `.github/workflows/release.yml`（在 `build-and-upload` job 后追加平级 job）

**Interfaces:**
- Consumes: `daemon/install/release-pkg.sh <EXT_ID> <VERSION>`（Slice 1）；repo secrets `APPLE_CERT_P12` / `APPLE_CERT_PASSWORD` / `APPLE_NOTARY_KEY` / `APPLE_NOTARY_KEY_ID` / `APPLE_NOTARY_KEY_ISSUER`（人工预配，见 Step 3）
- Produces: release assets `pie-link-<daemonVer>.pkg` + `pie-link.pkg`（稳定名，Slice 4 安装卡片硬编码其 latest URL）

- [ ] **Step 1: 追加 job**

在 `release.yml` 末尾追加（与 `build-and-upload` 平级、互不依赖——daemon job 失败不阻塞扩展 zip）：

```yaml
  build-daemon-pkg:
    runs-on: macos-14
    steps:
      - name: Resolve tag
        id: tag
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            TAG="${{ inputs.tag }}"
          else
            TAG="${GITHUB_REF_NAME}"
          fi
          echo "ref=${TAG}" >> "$GITHUB_OUTPUT"

      - name: Checkout
        uses: actions/checkout@v4
        with:
          ref: ${{ steps.tag.outputs.ref }}

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2

      - name: Daemon tests
        run: cd daemon && bun install --frozen-lockfile && bun test

      - name: Read daemon version
        id: dv
        run: echo "version=$(jq -r .version daemon/package.json)" >> "$GITHUB_OUTPUT"

      - name: Import signing certs into temp keychain
        env:
          APPLE_CERT_P12: ${{ secrets.APPLE_CERT_P12 }}
          APPLE_CERT_PASSWORD: ${{ secrets.APPLE_CERT_PASSWORD }}
        run: |
          KEYCHAIN="$RUNNER_TEMP/build.keychain-db"
          security create-keychain -p ci "$KEYCHAIN"
          security default-keychain -s "$KEYCHAIN"
          security unlock-keychain -p ci "$KEYCHAIN"
          echo "$APPLE_CERT_P12" | base64 -d > "$RUNNER_TEMP/cert.p12"
          security import "$RUNNER_TEMP/cert.p12" -k "$KEYCHAIN" \
            -P "$APPLE_CERT_PASSWORD" -T /usr/bin/codesign -T /usr/bin/productsign
          security set-key-partition-list -S apple-tool:,apple: -s -k ci "$KEYCHAIN"
          rm "$RUNNER_TEMP/cert.p12"

      - name: Build, sign, notarize
        env:
          APPLE_NOTARY_KEY: ${{ secrets.APPLE_NOTARY_KEY }}
          APPLE_NOTARY_KEY_ID: ${{ secrets.APPLE_NOTARY_KEY_ID }}
          APPLE_NOTARY_KEY_ISSUER: ${{ secrets.APPLE_NOTARY_KEY_ISSUER }}
        run: daemon/install/release-pkg.sh gpccjhdgjkmalnepmeclooflliiocfed "${{ steps.dv.outputs.version }}"

      - name: Upload assets
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          cp "daemon/dist/pie-link-${{ steps.dv.outputs.version }}.pkg" pie-link.pkg
          gh release upload "${{ steps.tag.outputs.ref }}" \
            "daemon/dist/pie-link-${{ steps.dv.outputs.version }}.pkg" \
            pie-link.pkg \
            --clobber
```

- [ ] **Step 2: YAML 自检 + commit**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"`
Expected: 无异常

```bash
git add .github/workflows/release.yml
git commit -m "ci: release 加 build-daemon-pkg job（签名 pkg 双资产名上传）"
```

- [ ] **Step 3: 人工步骤（不入库，写进 PR 描述）**

repo admin 预配 5 个 secrets（两证书合一 p12 base64、p12 密码、App Store Connect API key 三元组）。验证 = 在已有 tag 上 `gh workflow run release.yml -f tag=v<x.y.z>` 跑通，release 页出现两个 pkg 资产。

---

## Slice 3：版本握手 + 设置页升级提示（issue C，可与 Slice 1 并行）

### Task 3.1: daemon 侧版本机制（version.ts + --version + hello.daemonVersion）

**Files:**
- Create: `daemon/src/version.ts`
- Modify: `src/types/local-bridge.ts`、`daemon/src/daemon.ts`、`daemon/src/cli.ts`
- Test: `daemon/test/version.test.ts`（新建，跟随 `daemon/test/` 现有风格）

**Interfaces:**
- Produces: `DAEMON_VERSION: string`（CI `--define process.env.PIE_DAEMON_VERSION` 注入，缺省回落 package.json version）；`HelloResponse.result.daemonVersion?: string`；`pie --version` 输出版本号

- [ ] **Step 1: 失败测试**

`daemon/test/version.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { DAEMON_VERSION } from "../src/version";
import { handleMessage } from "../src/daemon";

describe("daemon version", () => {
  test("DAEMON_VERSION 回落 package.json version", () => {
    expect(DAEMON_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
  test("hello 响应带 daemonVersion", async () => {
    const out = await handleMessage(JSON.stringify({ id: "1", method: "hello", params: { protocolVersion: 1 } }));
    const res = JSON.parse(out);
    expect(res.ok).toBe(true);
    expect(res.result.daemonVersion).toBe(DAEMON_VERSION);
  });
});
```

Run: `cd daemon && bun test version`
Expected: FAIL（version.ts 不存在）

- [ ] **Step 2: 实现**

`daemon/src/version.ts`：

```ts
import pkg from "../package.json";

// CI 编译时 --define process.env.PIE_DAEMON_VERSION="x.y.z" 静态替换；
// 本地开发/测试无 define → 运行时 env 为空 → 回落 package.json。
export const DAEMON_VERSION: string = process.env.PIE_DAEMON_VERSION || pkg.version;
```

`src/types/local-bridge.ts` 的 `HelloResponse.result` 改为：

```ts
  result: { protocolVersion: number; capabilities: string[]; daemonVersion?: string };
```

`daemon/src/daemon.ts` 的 hello case 加 `daemonVersion`（import `DAEMON_VERSION`）：

```ts
    case "hello":
      return respond({
        ok: true,
        result: { protocolVersion: PROTOCOL_VERSION, capabilities: [...BRIDGE_CAPABILITIES], daemonVersion: DAEMON_VERSION },
      });
```

`daemon/src/cli.ts` 的 switch 加（`doctor` case 前）：

```ts
    case "--version":
    case "version": {
      const { DAEMON_VERSION } = await import("./version");
      console.log(DAEMON_VERSION);
      return 0;
    }
```

并把 usage 文案改为 `usage: pie <daemon|host|doctor|version>`。

- [ ] **Step 3: 测试通过 + commit**

Run: `cd daemon && bun test`
Expected: 全 PASS

```bash
git add daemon/src/version.ts daemon/src/daemon.ts daemon/src/cli.ts daemon/test/version.test.ts src/types/local-bridge.ts
git commit -m "feat(daemon): 版本注入 + hello.daemonVersion + pie --version"
```

### Task 3.2: 扩展侧版本状态（compare + MIN_DAEMON_VERSION + status 消息）

**Files:**
- Modify: `src/background/local-bridge.ts`、`src/background/index.ts`（`local-bridge:status` handler，691 行附近）
- Test: `src/background/local-bridge.test.ts`（追加）

**Interfaces:**
- Consumes: `HelloResponse.result.daemonVersion?`（Task 3.1）
- Produces: `compareDaemonVersions(a: string, b: string): number`、`MIN_DAEMON_VERSION: string`、`bridgeDaemonVersion(): string | null`、`bridgeNeedsUpgrade(): boolean`、`bridgeProtocolMismatch(): boolean`；`local-bridge:status` 响应扩为 `{ hasPermission, ready, daemonVersion, needsUpgrade, protocolMismatch }`（Slice 4 再加 installState）

- [ ] **Step 1: 失败测试（纯函数部分）**

`src/background/local-bridge.test.ts` 追加：

```ts
import { compareDaemonVersions } from "./local-bridge";

describe("compareDaemonVersions", () => {
  it.each([
    ["0.1.0", "0.1.0", 0],
    ["0.1.0", "0.2.0", -1],
    ["1.0.0", "0.9.9", 1],
    ["0.1", "0.1.0", 0],
    ["0.10.0", "0.9.0", 1],
  ])("%s vs %s -> %i", (a, b, want) => {
    expect(compareDaemonVersions(a, b)).toBe(want);
  });
});
```

Run: `pnpm test -- local-bridge`
Expected: FAIL（函数不存在）

- [ ] **Step 2: 实现**

`src/background/local-bridge.ts` 加：

```ts
export const MIN_DAEMON_VERSION = "0.1.0";

let daemonVersion: string | null = null;
let protocolMismatch = false;

/** 简单三段 semver 比较，够用（daemon 版本我们自己发，无 prerelease）。 */
export function compareDaemonVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function bridgeDaemonVersion(): string | null {
  return daemonVersion;
}
/** 连上但版本过旧（含旧 daemon 不带 daemonVersion 的情况）。软提示：功能按 capability 降级继续用。 */
export function bridgeNeedsUpgrade(): boolean {
  return ready && (daemonVersion === null || compareDaemonVersions(daemonVersion, MIN_DAEMON_VERSION) < 0);
}
/** PROTOCOL_VERSION 差 >1 = 硬不兼容（沿用现有 ±1 兼容窗口判定）。 */
export function bridgeProtocolMismatch(): boolean {
  return protocolMismatch;
}
```

hello 握手 `.then` 里（现有 147-151 行判定处）同步维护两状态：

```ts
      const res = r as { protocolVersion: number; capabilities: string[]; daemonVersion?: string };
      protocolMismatch = Math.abs(res.protocolVersion - PROTOCOL_VERSION) > 1;
      if (!protocolMismatch) {
        capabilities = res.capabilities;
        daemonVersion = res.daemonVersion ?? null;
        ready = true;
        reconnectAttempt = 0;
      }
```

断开/失败路径（`initLocalBridge` 的 catch、`onDisconnect`、`disconnectLocalBridge`）在清 `capabilities` 处同步 `daemonVersion = null`（`protocolMismatch` 保留到下次握手覆盖，设置页要在断开重连间隙仍能显示硬不兼容提示）。

`src/background/index.ts` 的 `local-bridge:status` handler 响应对象扩为：

```ts
    sendResponse({
      hasPermission,
      ready: isBridgeReady(),
      daemonVersion: bridgeDaemonVersion(),
      needsUpgrade: bridgeNeedsUpgrade(),
      protocolMismatch: bridgeProtocolMismatch(),
    });
```

（import 对应新函数；保持该 handler 现有的 hasPermission 取法不动。）

- [ ] **Step 3: 测试通过 + commit**

Run: `pnpm test -- local-bridge && pnpm typecheck`
Expected: 全 PASS / 0 错

```bash
git add src/background/local-bridge.ts src/background/index.ts src/background/local-bridge.test.ts
git commit -m "feat(bridge): daemon 版本状态 + MIN_DAEMON_VERSION 判定"
```

### Task 3.3: 设置页版本显示 + 升级提示 + i18n

**Files:**
- Modify: `src/sidepanel/components/Settings.tsx`（`LocalBridgeSection` / `BridgeStatus` / `queryBridgeStatus`）、`src/lib/i18n/dictionaries/` 全部字典
- Test: `src/sidepanel/components/Settings.localbridge.test.tsx`（追加）

**Interfaces:**
- Consumes: `local-bridge:status` 扩展后的响应（Task 3.2）

- [ ] **Step 1: 失败测试**

`Settings.localbridge.test.tsx` 追加（mock `chrome.runtime.sendMessage` 回 `local-bridge:status`，跟随文件内现有 mock 模式）：

```tsx
it("已连接时显示 daemon 版本", async () => {
  // sendMessage mock 返回 { hasPermission: true, ready: true, daemonVersion: "0.1.0", needsUpgrade: false, protocolMismatch: false }
  render(<LocalBridgeSection />);
  expect(await screen.findByText(/0\.1\.0/)).toBeInTheDocument();
});

it("needsUpgrade 时显示升级卡与下载链接", async () => {
  // sendMessage mock 返回 { hasPermission: true, ready: true, daemonVersion: "0.0.9", needsUpgrade: true, protocolMismatch: false }
  render(<LocalBridgeSection />);
  const link = await screen.findByRole("link", { name: /升级|update/i });
  expect(link).toHaveAttribute("href", "https://github.com/WiseriaAI/pie-ai-agent/releases/latest/download/pie-link.pkg");
});
```

Run: `pnpm test -- Settings.localbridge`
Expected: FAIL

- [ ] **Step 2: 实现**

- `BridgeStatus` type 扩为 `{ hasPermission: boolean; ready: boolean; daemonVersion?: string | null; needsUpgrade?: boolean; protocolMismatch?: boolean }`
- 常量（组件文件顶部）：`const PKG_URL = "https://github.com/WiseriaAI/pie-ai-agent/releases/latest/download/pie-link.pkg";`
- 已连接状态行追加版本：`statusConnected` 文案后拼 ` · Pie Link v{daemonVersion}`（daemonVersion 存在时）
- `ready && (needsUpgrade || protocolMismatch)` 时在开关卡片内、agents 区块前渲染升级块：`protocolMismatch` 用强文案（`upgradeRequired`），否则软文案（`upgradeAvailable`）；块内 `<a href={PKG_URL} target="_blank" rel="noreferrer">`（样式跟随现有按钮：`rounded border border-line px-2 py-0.5 text-[11px]`）
- i18n 新键（`settings.localBridge.` 前缀，全字典 parity）：`upgradeAvailable`（zh-CN「有新版本的 Pie Link 可用，下载后重新安装即可升级」）、`upgradeRequired`（zh-CN「Pie Link 版本与扩展不兼容，需要升级后才能使用本地打通」）、`downloadUpdate`（zh-CN「下载新版」）

- [ ] **Step 3: 测试通过 + commit**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全 PASS / 0 错 / build 成功

```bash
git add src/sidepanel/components/Settings.tsx src/sidepanel/components/Settings.localbridge.test.tsx src/lib/i18n/dictionaries/
git commit -m "feat(settings): daemon 版本显示 + 两级升级提示"
```

---

## Slice 4：安装引导漏斗（issue D，依赖 Slice 3 合并）

### Task 4.1: SW 断开原因分类 + installState + 重新检测

**Files:**
- Modify: `src/background/local-bridge.ts`、`src/background/index.ts`
- Test: `src/background/local-bridge.test.ts`（追加）

**Interfaces:**
- Produces: `classifyDisconnect(message: string | undefined): "not_installed" | "installed_not_running"`、`bridgeInstallState(): "connected" | "not_installed" | "installed_not_running" | "unknown"`；`local-bridge:status` 响应加 `installState`；新消息 `{ type: "local-bridge:reconnect" }` → SW 立即 `maybeInitLocalBridge()` 并回 `{ ok: true }`

- [ ] **Step 1: 失败测试**

```ts
import { classifyDisconnect } from "./local-bridge";

describe("classifyDisconnect", () => {
  it.each([
    ["Specified native messaging host not found.", "not_installed"],
    ["Access to the specified native messaging host is forbidden.", "not_installed"],
    ["Error when communicating with the native messaging host.", "installed_not_running"],
    [undefined, "installed_not_running"],
  ])("%s -> %s", (msg, want) => {
    expect(classifyDisconnect(msg as string | undefined)).toBe(want);
  });
});
```

Run: `pnpm test -- local-bridge`
Expected: FAIL

- [ ] **Step 2: 实现**

`src/background/local-bridge.ts`：

```ts
export type BridgeInstallState = "connected" | "not_installed" | "installed_not_running" | "unknown";
let installState: BridgeInstallState = "unknown";

/** Chrome onDisconnect lastError 文案分类。not found = 未装 host manifest；
 *  forbidden = manifest 在但 EXT_ID 不匹配（对用户同样呈现为「重新安装」）。 */
export function classifyDisconnect(message: string | undefined): "not_installed" | "installed_not_running" {
  if (!message) return "installed_not_running";
  return /not found|forbidden/i.test(message) ? "not_installed" : "installed_not_running";
}

export function bridgeInstallState(): BridgeInstallState {
  return installState;
}
```

状态维护点：
- `onDisconnect` listener 里现有 `void chrome.runtime?.lastError;` 改为读取并分类：`installState = classifyDisconnect(chrome.runtime?.lastError?.message);`
- 握手成功（`ready = true` 处）：`installState = "connected";`
- `initLocalBridge` 的 connectNative catch：`installState = "not_installed";`
- `disconnectLocalBridge`（用户关开关）：`installState = "unknown";`

`src/background/index.ts`：
- `local-bridge:status` 响应加 `installState: bridgeInstallState()`
- 平级新增 handler：

```ts
  if (message?.type === "local-bridge:reconnect") {
    void maybeInitLocalBridge().then(() => sendResponse({ ok: true }));
    return true;
  }
```

（注意 `maybeInitLocalBridge` 会重置 `userDisabled` 并重新握手——即「立即重试」，与既有梯子共存无冲突。）

- [ ] **Step 3: 测试通过 + commit**

Run: `pnpm test -- local-bridge && pnpm typecheck`
Expected: PASS / 0 错

```bash
git add src/background/local-bridge.ts src/background/index.ts src/background/local-bridge.test.ts
git commit -m "feat(bridge): 断开原因分类 installState + 手动重连消息"
```

### Task 4.2: 设置页安装卡片

**Files:**
- Modify: `src/sidepanel/components/Settings.tsx`、i18n 字典
- Test: `src/sidepanel/components/Settings.localbridge.test.tsx`（追加）

**Interfaces:**
- Consumes: `local-bridge:status` 的 `installState`（Task 4.1）、`PKG_URL` 常量（Task 3.3）

- [ ] **Step 1: 失败测试**

```tsx
it("开关开启且未安装时显示安装卡", async () => {
  // mock status: { hasPermission: true, ready: false, installState: "not_installed" }
  render(<LocalBridgeSection />);
  expect(await screen.findByRole("link", { name: /下载|download/i })).toHaveAttribute("href", expect.stringContaining("pie-link.pkg"));
  expect(screen.getByRole("button", { name: /重新检测|check again/i })).toBeInTheDocument();
});

it("已装未连时显示 doctor 引导", async () => {
  // mock status: { hasPermission: true, ready: false, installState: "installed_not_running" }
  render(<LocalBridgeSection />);
  expect(await screen.findByText(/pie doctor/)).toBeInTheDocument();
});
```

Run: `pnpm test -- Settings.localbridge`
Expected: FAIL

- [ ] **Step 2: 实现**

`LocalBridgeSection` 内，`enabled && status && !status.ready` 时按 `installState` 渲染（替代现有单一 `statusEnabledNotConnected` 文案）：

- `"not_installed"` → 安装卡：标题 `installTitle`（zh-CN「安装 Pie Link」）、正文 `installBody`（zh-CN「本地打通需要在这台电脑上安装 Pie Link。下载安装包，双击完成安装，之后会自动连接。」）、下载链接（`PKG_URL`，文案 `installDownload`「下载 Pie Link (.pkg)」）、`重新检测` 按钮（`recheck`）→ `chrome.runtime.sendMessage({ type: "local-bridge:reconnect" })` 后立即 `queryBridgeStatus(setStatus)`
- `"installed_not_running"` → doctor 引导：`doctorHint`（zh-CN「Pie Link 已安装但未连接。打开终端运行 `pie doctor` 查看诊断，或点击重新检测。」）+ 同一 `重新检测` 按钮
- `"unknown"`（或旧 SW 未回 installState）→ 维持现有 `statusEnabledNotConnected` 文案（向后兼容）
- 现有 1.5s 轮询保留——装完后梯子连上，卡片随下一次轮询自动翻转为已连接态，无需额外机制

- [ ] **Step 3: 测试通过 + commit**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全 PASS

```bash
git add src/sidepanel/components/Settings.tsx src/sidepanel/components/Settings.localbridge.test.tsx src/lib/i18n/dictionaries/
git commit -m "feat(settings): Pie Link 安装引导卡片（未装/未连/重新检测）"
```

- [ ] **Step 4: 人工真机（PR 标 need-human-test）**

未装 daemon 的机器：开开关 → 安装卡出现 → 装 pkg → ≤30s 卡片自动翻转已连接。

---

## Slice 5：Pie Link 顶栏 app（issue E，签名集成依赖 Slice 1；开发可与 3/4 并行）

### Task 5.1: daemon status RPC + 活跃执行注册表 + 扩展连接跟踪

**Files:**
- Create: `daemon/src/status.ts`
- Modify: `src/types/local-bridge.ts`、`daemon/src/daemon.ts`、`daemon/src/skill-exec.ts`
- Test: `daemon/test/status.test.ts`（新建）

**Interfaces:**
- Produces: wire 类型 `StatusResult { version: string; uptimeSec: number; extensionConnected: boolean; runningSkills: { name: string; startedAt: number }[] }` + method union 加 `"status"`；`status.ts` 导出 `markExtensionSocket(s) / dropSocket(s) / beginSkillRun(name, entry): string / endSkillRun(id) / getStatus(): StatusResult`
- 约定：**扩展 host 连接会发 `hello`，顶栏 app 不发**——发过 hello 的 socket 记为 extension 连接

- [ ] **Step 1: 失败测试**

`daemon/test/status.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { markExtensionSocket, dropSocket, beginSkillRun, endSkillRun, getStatus } from "../src/status";
import { handleMessage } from "../src/daemon";

describe("status", () => {
  test("extensionConnected 随 mark/drop 翻转", () => {
    const s = {};
    expect(getStatus().extensionConnected).toBe(false);
    markExtensionSocket(s);
    expect(getStatus().extensionConnected).toBe(true);
    dropSocket(s);
    expect(getStatus().extensionConnected).toBe(false);
  });
  test("runningSkills 随 begin/end 增减", () => {
    const id = beginSkillRun("demo", "fetch.ts");
    expect(getStatus().runningSkills).toEqual([{ name: "demo", startedAt: expect.any(Number) }]);
    endSkillRun(id);
    expect(getStatus().runningSkills).toEqual([]);
  });
  test("status RPC 走 handleMessage", async () => {
    const res = JSON.parse(await handleMessage(JSON.stringify({ id: "1", method: "status", params: {} })));
    expect(res.ok).toBe(true);
    expect(res.result.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof res.result.uptimeSec).toBe("number");
  });
});
```

Run: `cd daemon && bun test status`
Expected: FAIL

- [ ] **Step 2: 实现**

`src/types/local-bridge.ts`：`BridgeRequest.method` union 加 `"status"`，并加：

```ts
// ── status（顶栏 app / 诊断用）────────────────────────────────────────
export interface StatusResult {
  version: string;
  uptimeSec: number;
  /** 有活跃的扩展 host 连接（发过 hello 的 socket） */
  extensionConnected: boolean;
  runningSkills: { name: string; startedAt: number }[];
}
```

`daemon/src/status.ts`：

```ts
import { DAEMON_VERSION } from "./version";
import type { StatusResult } from "../../src/types/local-bridge";

const startedAtMs = Date.now();
const extSockets = new Set<unknown>();
const running = new Map<string, { name: string; entry: string; startedAt: number }>();

export function markExtensionSocket(s: unknown): void {
  extSockets.add(s);
}
export function dropSocket(s: unknown): void {
  extSockets.delete(s);
}
export function beginSkillRun(name: string, entry: string): string {
  const id = crypto.randomUUID();
  running.set(id, { name, entry, startedAt: Date.now() });
  return id;
}
export function endSkillRun(id: string): void {
  running.delete(id);
}
export function getStatus(): StatusResult {
  return {
    version: DAEMON_VERSION,
    uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
    extensionConnected: extSockets.size > 0,
    runningSkills: [...running.values()].map((r) => ({ name: r.name, startedAt: r.startedAt })),
  };
}
```

`daemon/src/daemon.ts`：
- switch 加 case（同构 try/catch）：

```ts
    case "status": {
      try {
        return respond({ ok: true, result: getStatus() });
      } catch (e) {
        log("error", "status.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "status_failed", message: String(e) } });
      }
    }
```

- `processSocketChunk` 返回值加 `sawHello`（供 socket 层标记扩展连接；双 parse 只发生在 hello 这一次，代价可忽略）：

```ts
export function processSocketChunk(
  carry: string,
  chunk: string,
  write: (out: string) => void,
): { carry: string; pending: Promise<void>; sawHello: boolean } {
  const { lines, carry: nextCarry } = decodeNdjsonLines(carry, chunk);
  const sawHello = lines.some((l) => {
    try {
      return (JSON.parse(l) as { method?: string }).method === "hello";
    } catch {
      return false;
    }
  });
  const pending = Promise.all(lines.map((line) => handleMessage(line).then((out) => write(out + "\n")))).then(
    () => undefined,
  );
  return { carry: nextCarry, pending, sawHello };
}
```

- `startDaemon` 的 socket 回调：`data()` 里 `if (sawHello) markExtensionSocket(socket);`，`close(socket)` 里 `dropSocket(socket);`

`daemon/src/skill-exec.ts`：`runSkillScript` 主体（授权检查通过后、实际执行前）包一层：

```ts
  const runId = beginSkillRun(params.name, params.entry);
  try {
    // …existing execution…
  } finally {
    endSkillRun(runId);
  }
```

- [ ] **Step 3: 测试通过 + commit**

Run: `cd daemon && bun test && cd .. && pnpm typecheck`
Expected: 全 PASS / 0 错

```bash
git add daemon/src/status.ts daemon/src/daemon.ts daemon/src/skill-exec.ts daemon/test/status.test.ts src/types/local-bridge.ts
git commit -m "feat(daemon): status RPC + 活跃 skill 注册表 + 扩展连接跟踪"
```

### Task 5.2: Swift 顶栏 app

**Files:**
- Create: `daemon/menubar/main.swift`、`daemon/menubar/Info.plist`、`daemon/menubar/build-app.sh`

**Interfaces:**
- Consumes: `status` / `list_audit` RPC（unix socket `~/.pie/daemon.sock`，NDJSON，Task 5.1）
- Produces: `build-app.sh [OUT_DIR]` → `<OUT_DIR>/Pie Link.app`（默认 `daemon/dist/`）

- [ ] **Step 1: main.swift**

```swift
// Pie Link 顶栏 app：~/.pie/daemon.sock 的瘦客户端。菜单点开才查询，无常驻轮询。
import AppKit

let socketPath = (NSHomeDirectory() as NSString).appendingPathComponent(".pie/daemon.sock")

/// 一问一答：连 unix socket，发一行 JSON 请求，读一行 JSON 响应（1s 超时）。
func queryDaemon(_ method: String, _ params: [String: Any] = [:]) -> [String: Any]? {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var tv = timeval(tv_sec: 1, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let ok = socketPath.withCString { src -> Bool in
        guard strlen(src) < 104 else { return false }
        return withUnsafeMutablePointer(to: &addr.sun_path) {
            $0.withMemoryRebound(to: CChar.self, capacity: 104) { dst in
                strcpy(dst, src)
                return true
            }
        }
    }
    guard ok else { return nil }
    let connected = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard connected == 0 else { return nil }
    let req: [String: Any] = ["id": UUID().uuidString, "method": method, "params": params]
    guard var line = try? JSONSerialization.data(withJSONObject: req) else { return nil }
    line.append(0x0A)
    let sent = line.withUnsafeBytes { write(fd, $0.baseAddress, line.count) }
    guard sent == line.count else { return nil }
    var buf = Data()
    var chunk = [UInt8](repeating: 0, count: 65536)
    while !buf.contains(0x0A) {
        let n = read(fd, &chunk, chunk.count)
        if n <= 0 || buf.count > 4_000_000 { return nil }
        buf.append(contentsOf: chunk[0..<n])
    }
    guard let nl = buf.firstIndex(of: 0x0A),
          let obj = try? JSONSerialization.jsonObject(with: buf[..<nl]) as? [String: Any],
          obj["ok"] as? Bool == true
    else { return nil }
    return obj["result"] as? [String: Any]
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var statusItem: NSStatusItem!

    func applicationDidFinishLaunching(_: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(
            systemSymbolName: "circle.hexagongrid.fill", accessibilityDescription: "Pie Link")
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
    }

    // 点开菜单才查 daemon（status + list_audit 各一次）
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let status = queryDaemon("status")
        if let s = status {
            let ver = s["version"] as? String ?? "?"
            menu.addItem(disabled("Pie Link v\(ver) · 运行中"))
            let ext = s["extensionConnected"] as? Bool ?? false
            menu.addItem(disabled(ext ? "浏览器扩展：已连接" : "浏览器扩展：未连接"))
            menu.addItem(.separator())
            let running = s["runningSkills"] as? [[String: Any]] ?? []
            menu.addItem(disabled("正在运行的 skill"))
            if running.isEmpty {
                menu.addItem(indented("无"))
            } else {
                for r in running { menu.addItem(indented(r["name"] as? String ?? "?")) }
            }
            menu.addItem(.separator())
            menu.addItem(disabled("最近执行"))
            let audit = queryDaemon("list_audit", ["limit": 5])
            let entries = audit?["entries"] as? [[String: Any]] ?? []
            if entries.isEmpty {
                menu.addItem(indented("无"))
            } else {
                for e in entries.reversed() {
                    let name = e["skillName"] as? String ?? "?"
                    let entry = e["entry"] as? String ?? "?"
                    let okRun = (e["exitCode"] as? Int ?? 1) == 0 && !(e["timedOut"] as? Bool ?? false)
                    menu.addItem(indented("\(okRun ? "✓" : "✗") \(name) · \(entry)"))
                }
            }
        } else {
            menu.addItem(disabled("Pie Link · 未运行"))
            menu.addItem(indented("守护进程未响应，可尝试重新登录或运行 pie doctor"))
        }
        menu.addItem(.separator())
        menu.addItem(item("诊断（pie doctor）", #selector(runDoctor)))
        menu.addItem(item("退出", #selector(NSApplication.terminate(_:))))
    }

    @objc func runDoctor() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/local/bin/pie")
        p.arguments = ["doctor"]
        let pipe = Pipe()
        p.standardError = pipe
        p.standardOutput = pipe
        let out: String
        do {
            try p.run()
            p.waitUntilExit()
            out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        } catch {
            out = "无法运行 /usr/local/bin/pie：\(error.localizedDescription)"
        }
        let alert = NSAlert()
        alert.messageText = "pie doctor"
        alert.informativeText = out
        alert.runModal()
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        i.isEnabled = false
        return i
    }
    private func indented(_ title: String) -> NSMenuItem {
        let i = disabled(title)
        i.indentationLevel = 1
        return i
    }
    private func item(_ title: String, _ sel: Selector) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: sel, keyEquivalent: "")
        i.target = self
        return i
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // 无 Dock 图标（与 Info.plist LSUIElement 双保险）
app.run()
```

- [ ] **Step 2: Info.plist + build-app.sh**

`daemon/menubar/Info.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>ai.wiseria.pie.menubar</string>
  <key>CFBundleName</key><string>Pie Link</string>
  <key>CFBundleExecutable</key><string>Pie Link</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>__VERSION__</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
```

`daemon/menubar/build-app.sh`：

```bash
#!/bin/bash
# daemon/menubar/build-app.sh — swiftc 组 Pie Link.app。用法: build-app.sh [OUT_DIR] [VERSION]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/../dist}"
VERSION="${2:-0.0.0}"
APP="$OUT/Pie Link.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
# arm64 + x86_64 双 target 一次出 universal
swiftc -O -target arm64-apple-macos13 -o "$OUT/pielink-arm64" "$HERE/main.swift" -framework AppKit
swiftc -O -target x86_64-apple-macos13 -o "$OUT/pielink-x64" "$HERE/main.swift" -framework AppKit
lipo -create "$OUT/pielink-arm64" "$OUT/pielink-x64" -output "$APP/Contents/MacOS/Pie Link"
rm "$OUT/pielink-arm64" "$OUT/pielink-x64"
sed "s|__VERSION__|$VERSION|g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
echo "built $APP"
```

- [ ] **Step 3: 本机构建自检 + commit**

Run（macOS）: `daemon/menubar/build-app.sh /tmp/pielink-test 0.1.0 && open /tmp/pielink-test/"Pie Link.app"`（云端只 `bash -n daemon/menubar/build-app.sh`）
Expected: 图标出现在顶栏；daemon 在跑时菜单显示状态；不在跑时显示「未运行」

```bash
git add daemon/menubar/
git commit -m "feat(menubar): Pie Link 顶栏 app（status/audit 菜单 + doctor + 退出）"
```

### Task 5.3: pkg / postinstall / CI 集成

**Files:**
- Create: `daemon/install/ai.wiseria.pie.menubar.plist.template`
- Modify: `daemon/install/build-pkg.sh`、`daemon/install/postinstall.sh`、`daemon/install/release-pkg.sh`、`.github/workflows/release.yml`

**Interfaces:**
- Consumes: `build-app.sh`（Task 5.2）
- Produces: `build-pkg.sh <EXT_ID> [VERSION] [BIN] [APP]` — APP 给定时把 `.app` 放进 payload `/Applications/`

- [ ] **Step 1: menubar LaunchAgent 模板**

`daemon/install/ai.wiseria.pie.menubar.plist.template`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.wiseria.pie.menubar</string>
  <key>Program</key><string>/Applications/Pie Link.app/Contents/MacOS/Pie Link</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
```

- [ ] **Step 2: build-pkg.sh 加 APP 参数**

`build-pkg.sh` 参数行改 `APP="${4:-}"`，STAGE 段追加：

```bash
if [ -n "$APP" ]; then
  mkdir -p "$STAGE/Applications"
  cp -R "$APP" "$STAGE/Applications/"
fi
```

SCRIPTS 段追加 `cp "$ROOT/install/ai.wiseria.pie.menubar.plist.template" "$SCRIPTS/"`。

- [ ] **Step 3: postinstall 装 menubar LaunchAgent 并立即启动**

`postinstall.sh` 在现有 launchd 段之后追加（沿用同一 CONSOLE_USER/USER_HOME/USER_UID 变量）：

```bash
# 顶栏 app：登录自启 + 装完立即启动（图标出现 = 安装成功反馈）
if [ -d "/Applications/Pie Link.app" ]; then
  cp "$(dirname "$0")/ai.wiseria.pie.menubar.plist.template" "$LA_DIR/ai.wiseria.pie.menubar.plist"
  chown "$CONSOLE_USER" "$LA_DIR/ai.wiseria.pie.menubar.plist"
  launchctl asuser "$USER_UID" launchctl unload "$LA_DIR/ai.wiseria.pie.menubar.plist" 2>/dev/null || true
  launchctl asuser "$USER_UID" launchctl load "$LA_DIR/ai.wiseria.pie.menubar.plist"
fi
```

- [ ] **Step 4: release-pkg.sh 构建并签名 .app、CI 无需改动**

`release-pkg.sh` 在「组 pkg」步骤前插入：

```bash
# 1.5) 顶栏 app：构建 + 签名（hardened runtime，无需 JIT entitlements）
"$ROOT/menubar/build-app.sh" "$ROOT/dist" "$VERSION"
codesign --force --deep --options runtime --timestamp \
  --sign "$APP_ID" "$ROOT/dist/Pie Link.app"
codesign --verify --strict "$ROOT/dist/Pie Link.app"
```

并把 build-pkg.sh 调用改为传 APP：

```bash
"$ROOT/install/build-pkg.sh" "$EXT_ID" "$VERSION" "$ROOT/dist/pie-universal" "$ROOT/dist/Pie Link.app"
```

（release.yml 无需再改——job 只调 release-pkg.sh；若 Slice 2 未合，此改动照常进 release-pkg.sh，CI 接入随 Slice 2。）

- [ ] **Step 5: 自检 + commit**

Run: `bash -n daemon/install/build-pkg.sh daemon/install/postinstall.sh daemon/install/release-pkg.sh && cd daemon && bun test`
Expected: 语法通过 / daemon 测试全 PASS

```bash
git add daemon/install/
git commit -m "feat(pkg): Pie Link.app 进 payload + menubar LaunchAgent 自启"
```

- [ ] **Step 6: 人工真机（PR 标 need-human-test）**

装完整 pkg：图标立即出现；菜单显示版本/扩展连接/无运行 skill；跑一个 disk skill 时「正在运行」出现该 skill；退出图标后 `launchctl asuser <uid> launchctl list | grep ai.wiseria.pie`（daemon 仍在）；重新登录图标回来。

---

## Self-Review 记录

- Spec 覆盖：spec §2→Slice 1/3 文案与资产名；§3→Task 1.2/5.3；§4→Task 1.1/1.3/2.1；§5→Task 2.1；§6→Slice 3；§7→Slice 4；§8→Slice 5；§10 依赖关系与 issue 划分一致
- 类型一致：`StatusResult`/`daemonVersion?`/`installState` 在 daemon、types、SW、Settings 四处签名对齐；`compareDaemonVersions`/`classifyDisconnect` 命名全文唯一
- 无 TBD/占位；所有验证命令给出预期输出；无法自动化的验证（签名/公证/装机）显式标注 need-human-test 步骤
