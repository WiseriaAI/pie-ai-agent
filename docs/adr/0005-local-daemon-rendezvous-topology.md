# Local Daemon Bridge：常驻 daemon 作会合点，host 只透传

做「插件 ↔ 本地进程打通」（spec `docs/specs/2026-07-05-local-daemon-bridge.md`）时，扩展要同时满足两个方向：Pie → 本地（接力 / MCP / skill 执行），以及本地 Agent → Pie（把 Pie 浏览器工具当 tool 调）。连接拓扑有两个成熟参照，答案相反：

- **Claude Code 的 native host**：Chrome 用 `connectNative` **按需 spawn** host，进程随扩展生灭，**无常驻 daemon**，生命周期零基建。
- **summarize**：**常驻 daemon**（launchd/systemd/schtasks 自启动），native host 只是薄代理。

**决定**：

1. **daemon 常驻自启动（macOS launchd KeepAlive），是唯一的会合点（rendezvous）。** daemon 是**浏览器侧（`pie host`）**和**本地 Agent 侧（`pie mcp`）**两个客户端的碰面处；双向对等要求它比任一条连接活得久，否则本地 Agent 起 `pie mcp` 时若没有浏览器把 daemon 拉起来就找不到对端。常驻让 rendezvous、授权账本、audit 有稳定的家。

2. **`pie host` 是薄透传，不含业务逻辑，不 spawn daemon。** host 由 Chrome 按需 spawn（`connectNative`），只做 stdin/stdout（Chrome 4 字节长度前缀 framing）↔ daemon unix socket（ndjson）的双向搬运。host 连不上 daemon → 报「daemon 未运行」→ `pie doctor` / 重装修复，**host 不负责拉起 daemon**（拉起是 launchd 的事，避免「谁 spawn、单例锁、竞态」）。

3. **传输 = unix domain socket `~/.pie/daemon.sock`（0600）**，不用裸 localhost 端口——零网络面、天然用户级隔离、无需 token 配对仪式；准入靠 native host manifest `allowed_origins` 锁扩展 ID。

**被拒的备选**：

- **host 按需 spawn daemon（Claude Code 式，无常驻）**：生命周期极简，但双向对等的 rendezvous 塌了——本地 Agent 侧无浏览器时无对端；且引入 spawn 竞态 / 单例锁。曾考虑「Slice 0 先按需、Slice 4 反向时升常驻」，但那要吃一次生命周期重写 + 反向那刀更重，故直接常驻。
- **summarize 式 native host 转发 HTTP/SSE 到 localhost 端口 daemon**：HTTP 请求/响应模型对双向推送别扭（要 SSE 长轮询维持），且开了 localhost 端口面（任何本地进程/网页可探）。socket + connectNative 长连接更干净。
- **扩展直连 `ws://127.0.0.1` + token 配对**：省一步 host 注册，但端口对所有本地进程/网页可见、需防 DNS rebinding + token 仪式，且 Chrome PNA（Private Network Access）政策在收紧，终局不稳。

**下游影响**：daemon 常驻是**三平台自启动基建的成本源**（v1 只 macOS launchd，Windows/Linux 后议见 spec §11）。「daemon 未运行」是一个必须处理的常见态（§8 错误矩阵）。会合点模型也让未来任何非浏览器的 daemon 客户端天然共享同一套授权账本（见 ADR 0006）。
