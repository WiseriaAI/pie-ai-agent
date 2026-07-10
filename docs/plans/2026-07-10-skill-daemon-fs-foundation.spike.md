# Slice 1 Task 1 — SkillSandbox 后端 spike 决策记录

日期：2026-07-10 · 分支 `feat/skill-system-daemon`

## 结论：后端 = Anthropic sandbox-runtime（srt），全能力在 bun 二进制成立，无需回退

`@anthropic-ai/sandbox-runtime@0.0.64`（Apache-2.0）经 `import { SandboxManager }` 嵌进 `bun build --compile` 的独立二进制，**文件写限 / 敏感读拒 / 默认断网 / 按域名放行网络**四项在 bun runtime **与编译后二进制**里端到端真机全过。

## 调查问题逐条回答

1. **srt 库能否内嵌进 `bun --compile` 独立二进制并工作？** → **能**。`bun build ./x.ts --compile` 打进 80 modules，运行期 `SandboxManager.initialize/wrapWithSandboxArgv` 正常，`checkDependencies` 返回 `{errors:[],warnings:[]}`。不需要用户装 node / 全局 srt。
2. **辅助依赖（代理进程 / sandbox-exec / ripgrep）在编译环境可得吗？** → macOS 用系统 `sandbox-exec`（自带）；网络过滤是 srt **进程内 JS 代理**（`@pondwader/socks5-server` + `node-forge`，纯 JS，打进二进制）；**ripgrep（`rg`）是 srt 运行时依赖**——本机已装故 `checkDependencies` 干净（见 Follow-up）。
3. **需要回退到手写 sandbox-exec 吗？** → **不需要**。srt 全能力成立。

## 踩过的坑（务必固化进实现）

- **绝不 `Bun.spawnSync` 跑沙箱子进程 → 必须异步 `Bun.spawn`。** srt 的按域名网络放行靠进程内 JS 代理，代理要靠 bun 单线程事件循环转发。`spawnSync` 阻塞事件循环 → 代理不转发 → **所有出站挂到超时**。排查中一度误判「srt 网络在 bun 下坏」，实为此死锁；换异步 spawn 后 allowed→HTTP 301 转发、denied→`CONNECT tunnel failed 403` 快速拒。已写进 `daemon/src/skill-sandbox.ts` 头注释。
- **`SandboxManager` 是全局单例**（`initialize/updateConfig/reset` 改共享状态 + 每次起代理端口）。并发请求会互踩 → `realSkillSandbox.run` 全程**串行化**（module-level promise chain），一次只跑一个沙箱。
- **seatbelt `remote ip` host 只认 `*` 或 `localhost`**（`127.0.0.1:port` 让整个 profile 解析失败）——srt 内部已处理，仅记备忘。

## config 映射（SandboxSettings → srt SandboxRuntimeConfig）

```
allowWrite      → filesystem.allowWrite
denyRead        → filesystem.denyRead
allowedDomains  → network.allowedDomains（空 = 全断）
```
序列：`initialize(config)` → `waitForNetworkInitialization()` → `wrapWithSandboxArgv(shellQuote(argv),…,cwd)` → 异步 `Bun.spawn(wrapped.argv, {env: {...process.env,...env,...wrapped.env}})` + 60s 超时 + 1MB stdout/stderr 双路封顶 → `cleanupAfterCommand()` + `reset()`（finally）。

## 真机验证结果（`realSkillSandbox`，6/6 PASS）

| 探针 | 结果 |
|---|---|
| write inside workspace | exit 0 ✓ |
| write outside → blocked | exit 1 ✓（未泄漏） |
| read secret dir → blocked | exit 1 ✓ |
| default deny net → blocked | exit 56（快速 403，非超时）✓ |
| declared domain (anthropic.com) allowed | exit 0 / HTTP 301 ✓ |
| undeclared domain (neverssl.com) blocked | exit 56 ✓ |

## 交付物

- `daemon/src/skill-sandbox.ts` — `SkillSandbox` 接口 + `realSkillSandbox`（srt 后端）+ `fakeSkillSandbox`。
- `daemon/test/skill-sandbox.test.ts` — fake 契约测试（CI，1 pass）。
- `daemon/package.json` + `bun.lock` — 加 `@anthropic-ai/sandbox-runtime` 依赖。

## Follow-up（非 Slice 1 阻塞）

- **ripgrep 运行时依赖**：srt `checkDependencies` 查 `rg`。用户机无 `rg` 时行为待验（可能 warning + 降级，或需捆绑 rg / 探测缺失时的兜底）。装 daemon 时应 `checkDependencies()` 并在缺依赖时给清晰提示。真机在一台无 rg 的机器复验。
- **srt 是 research preview**（API/配置格式可能变）：已 vendor-lock `0.0.64` + 全部调用挡在 `SkillSandbox` 接口后，升级只动一个文件。
- **per-run initialize/reset 起新代理端口**：skill 执行是低频用户触发，串行 + per-run 起代理可接受；若未来吞吐要求高，改 init-once + updateConfig（需重验代理 re-key）。
- Linux（bubblewrap）/ Windows（WFP）：srt 已跨平台，跟 daemon 跨平台一起做。
