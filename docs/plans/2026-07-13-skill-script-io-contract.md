# 实施 plan · Skill 脚本 I/O 契约收口

> spec: `docs/specs/2026-07-13-skill-script-io-contract.md` · issue #296
> 两个 PR，PR1 先合（纯减法，PR2 在其上做加法）

---

## PR1 — 删死路径

零行为变化。**不碰任何文案**（tool description / scriptNote 在 PR2 重写，这里改了等于白改）。

### T1.1 · 砍 `run_skill_script` 的 builtin/idb 分支

`src/lib/agent/tools/skill-script.ts`

- 删 `SkillScriptDeps.runInSandbox`
- 删 handler 里 `skillEntry.origin === "disk"` 之外的整个分支（`resolveSkillPackage` → `parseScriptDecls` → `isPureCompute` → `runInSandbox` 那一段）
- 删 schema 里的 `input` 参数，以及 `finalArgs` 里的 `a.input` 兼容回退（`argv ?? (a.input !== undefined ? [JSON.stringify(a.input)] : [])` → `argv ?? []`）
- **保留** `scripts/` 前缀剥离的容错（spec D10）
- 非 disk origin 的 skill 调 `run_skill_script` → 返回明确错误（"this skill has no runnable scripts"）

**验证：** 既有 `skill-script` 测试里 builtin/idb 分支的用例全删；disk 分支用例全绿。

### T1.2 · 拆 sandbox 注入

- `src/lib/agent/loop.ts` — 删 `runInSandbox` 那个 dep 的构造与传入
- `src/offscreen/pdf-parser.ts` — 删 `initSandboxHost()` 调用与 import

**验证：** `pnpm typecheck` 无悬空引用。PDF 三个 tool 的测试仍绿（确认 offscreen 主文档没被拖坏）。

### T1.3 · 删 sandbox 载体

- 删 `src/offscreen/skill-sandbox.html`、`skill-sandbox.ts`、`skill-sandbox.test.ts`
- 删 `src/offscreen/sandbox-host.ts`、`sandbox-host.test.ts`
- `manifest.json` — 删 `sandbox` 段（`pages: [...skill-sandbox.html]`）与 `content_security_policy.sandbox` 那行（带 `'unsafe-eval'` 的）

**验证：** `pnpm build` 过；`dist/manifest.json` 里不再有 `sandbox` 键，也不再有 `unsafe-eval`（`extension_pages` 的 `wasm-unsafe-eval` 是 PDF WASM 要的，**不能动**——只删 `sandbox` 那条）。

### T1.4 · 删 `capabilities` frontmatter

- 删 `src/lib/skills/script-decl.ts` + 测试
- `src/lib/skills/package-types.ts` — 删 `SkillFrontmatter.capabilities` 整个字段（`tools` / `scripts` / `hosts` 三个子键全部零消费者）
- `src/lib/skills/source.ts` — `runnableScripts` 对 idb/builtin 恒 `[]`（daemon 后端的照旧，它来自 daemon summary）
- `src/lib/skills/frontmatter.ts` — 删 `capabilities` 的嵌套特判（`root[key] = key === "capabilities" ? {} : []` 那套）

**先写测试（TDD）：** 一个老 idb 包的 SKILL.md，frontmatter 里带完整的 `capabilities:` 嵌套块 → 解析后 `name` / `description` / body 三者仍正确，残留字段无害。**这是本 PR 唯一有真实回归风险的地方。**

**验证：** `pnpm test` 全绿；`grep -rn "capabilities" src/lib/skills/` 只剩无关命中。

---

## PR2 — 脚本 I/O 契约

daemon 先行（T2.1–T2.6），扩展跟上（T2.7–T2.12），文档收尾（T2.13）。

### T2.1 · daemon：session 目录

`daemon/src/paths.ts` — 加 `sessionsDir: join(pieDir, "sessions")`
新增 `sessionWorkspace(sessionId): string` helper，内含 `assertSessionId`（uuid 形状校验，防路径穿越——**sessionId 来自 wire，是不可信输入**）。

**先写测试：** `../`、绝对路径、空串、超长串全部 throw。

### T2.2 · daemon：`run_skill_script` 收 sessionId，cwd 换成 workspace

`daemon/src/skill-exec.ts`

- `RunSkillScriptParams` 加 `sessionId`（必填）
- `const workspace = sessionWorkspace(params.sessionId); mkdirSync(workspace, { recursive: true })` —— **`skillDir` 下不再有任何 mkdir**（这就是副根污染的修复点）
- `settings.allowWrite = [workspace, ...extraWrites]`（结构不变，只是 workspace 换了位置）
- `sandbox.run(argv, workspace, env, settings)` —— cwd 从 `skillDir` 改为 `workspace`
- `env` 加 `PIE_SKILL_DIR: skillDir` 和 `PIE_WORKSPACE: workspace`（`BUN_BE_BUN` 保留）

**先写测试：** 跑一个副根（secondary root）的 skill 脚本 → 断言 `~/.agents/skills/<name>/` 下**零新增文件/目录**。这条是 spec §1.2 那个 bug 的红灯。

### T2.3 · daemon：outputs 清单

`daemon/src/skill-exec.ts` — run 之后递归扫 workspace，收 `mtimeMs >= startedAt` 的文件，产出 `{ path, bytes }[]`（path 相对 workspace 根），封顶 50 → 超出置 `outputsTruncated: true`。空数组时两个字段都省略（optional）。

**先写测试：** 脚本写 2 个文件 → outputs 两条、path 相对、bytes 正确；跑第二次只改其中一个 → 只列被改的那个（mtime 过滤生效）；写 60 个 → 列 50 + `outputsTruncated`。

### T2.4 · daemon：`read_session_file` RPC

`daemon/src/skill-store.ts` 加 `readSessionFile(sessionId, rel)`（`safeRelPath` 锁在 `sessionWorkspace(sid)` 内）；`daemon/src/daemon.ts` 加 dispatch case。

**先写测试：** 正常读；`../../skills/foo/SKILL.md` → throw；读另一个 sessionId 的文件 → throw（路径拼不出去，天然隔离，但要有断言钉住）。

### T2.5 · daemon：`delete_session_workspace` RPC

`daemon.ts` 加 case → `rmSync(sessionWorkspace(sid), { recursive: true, force: true })`。不存在 → no-op 成功（幂等）。

### T2.6 · daemon：启动 GC

daemon 启动时扫 `~/.pie/sessions/`，删 mtime 超 30 天的目录。失败不阻塞启动（`try/catch` + log）。

**先写测试：** 造两个目录（一个新、一个 mtime 回拨 31 天）→ 只有旧的被删。

### T2.7 · wire 类型

`src/types/local-bridge.ts`（唯一权威源，daemon 相对 import）

- `RunSkillScriptParams` 加 `sessionId: string`
- `RunSkillScriptResult` 加 `outputs?: { path: string; bytes: number }[]`、`outputsTruncated?: boolean`
- 新增 `ReadSessionFileParams { sessionId, path }` / `Result { content }`
- 新增 `DeleteSessionWorkspaceParams { sessionId }`
- `PROTOCOL_VERSION` **不动**（全是加法）

### T2.8 · 扩展：sessionId 透传到 tool ctx

- `src/lib/agent/types.ts` — `ToolHandlerContext` 加 `sessionId: string`
- `src/lib/agent/loop.ts` — 建 ctx 的地方把 `ctx.sessionId`（`AgentLoopContext.sessionId`，已存在）传下去

**验证：** typecheck 会把所有造 `ToolHandlerContext` 的测试点亮，逐个补上。

### T2.9 · 扩展：`read_skill_output` tool

- 新 tool（放 `src/lib/agent/tools/skill-script.ts` 同文件即可，它俩是一对）：`read_skill_output({ path })` → `requestReadSessionFile({ sessionId: ctx.sessionId, path })`
- `src/lib/agent/tool-names.ts` — 加进 `SKILL_MEDIATION_TOOL_NAMES`，class = **read**（build-time invariant 会检查）
- 内容包 `<untrusted_skill_content>`（复用现有 tag，它就是"skill 相关的不可信内容"）

### T2.10 · 扩展：新 untrusted tag

- `src/lib/agent/untrusted-wrappers.ts` — `UNTRUSTED_WRAPPER_TAGS` 加 `untrusted_skill_output_list`
- `src/lib/agent/page-snapshot.ts` — `WRAPPER_TAGS_LIST` 同步加（**双列表不变量**，两处必须一致，有测试钉住）

### T2.11 · 扩展：observation 组装

`skill-script.ts` 的 disk 成功分支，按 spec D9 的三种形态组装：

- 有 stdout → `<untrusted_skill_content>` 照旧
- 有 outputs → 追加框架句 + `<untrusted_skill_output_list>`（文件名经 `escapeUntrustedWrappers`）
- stdout 空且 outputs 空 → 那句含 "a returned value is discarded" 的提示
- `truncated` / `outputsTruncated` 各自的后缀标记

**先写测试：** 四种组合（有/无 stdout × 有/无 outputs）各一条断言。

### T2.12 · 扩展：tool description 重写 + lifecycle 挂钩

- `run_skill_script` 的 description 与 `args` 字段说明改成单语义 CLI（spec D10）；`entry` 的 description 删掉 "older packaged skills may list paths like scripts/dedupe.js" 那句误导
- `src/lib/sessions/lifecycle.ts` — 在两处 `deleteSessionArtifacts(id)` 旁边加 `deleteSessionWorkspaceRpc(id).catch(() => {})`

### T2.13 · 作者文档

新建 `docs/agents/skill-authoring.md`（一页纸，SKILL.md 作者向）：spec §3.2 那张契约表 + 一个最小可跑示例（读 argv、print stdout、写产物到 cwd）+ 明写"返回值会被丢弃""写到 workspace 外的文件不会被列出，自己 print 路径"。

`CLAUDE.md` 的 `src/lib/skills/` 那段同步：workspace 已迁 session 维度、cwd 契约、新 tool。

---

## 验证

**每个 task 内 TDD**（红 → 绿）。全部完成后：

```
pnpm test && pnpm typecheck && pnpm build
cd daemon && bun test
```

**真机验收**（`need-human-test`，参考 `docs/agents/auto-acceptance.md` 走自动化预检）：

1. 磁盘脚本 print → LLM 拿到 stdout（回归）
2. 磁盘脚本写文件 → observation 列出 + `read_skill_output` 读回
3. 磁盘脚本啥也不干 → 拿到那句可行动提示
4. **副根 skill 跑脚本 → `~/.agents/skills/<name>/` 零写入**（本次核心修复）
5. 两个 session 跑同一脚本写同名文件 → 互不覆盖
6. 硬删 session → workspace 目录消失
7. 老 idb skill（frontmatter 带 `capabilities:`）仍能正常 `use_skill`
8. 首跑未授权 skill → 授权卡照常弹（grant 信封语义未变，已有 grant 不失效）
