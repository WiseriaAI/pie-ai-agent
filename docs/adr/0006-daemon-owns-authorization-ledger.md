# Local Daemon Bridge：授权账本归 daemon 持有，不归扩展

分级授权（spec §6）里，用户批准一次本地动作后要「记住」以免重复弹卡。这个持久 grant 存哪：扩展的 IndexedDB，还是 daemon 的本地文件？批准动作发生在**扩展**（侧栏 HITL 卡，用户在浏览器里点「允许」），但**强制点**（该不该真跑这个 skill 脚本 / 调这个 MCP 工具）在 **daemon**——它才是有文件系统 / 网络 / 子进程可达的那一侧。

**决定**：

1. **持久授权账本 = `~/.pie/grants.json`，daemon 拥有并强制。** 强制点持有授权，安全状态与它保护的能力同处一地，还和 audit log（`~/.pie/logs/audit.jsonl`）并置——本地侧安全状态集中一处，且不受浏览器重装 / 清存储影响。**扩展 IndexedDB 零 grant。**

2. **强制流**：agent loop 调 daemon → daemon 查账本 → miss → 回 `needs_authorization` → loop 弹 HITL 卡（扩展是唯一 UI 面）→ 用户批准 → loop 重调 daemon → daemon 写 grant + 执行。扩展只是**批准 UI + loop 编排**，不做授权判定。

3. **只持久化风险单元身份稳定的两类**：
   - `skill:<id>:<permsHash>`——skill 声明的 fs/network 权限静态，一次批准合法覆盖后续所有次；**permsHash 进 key**，声明一变 grant 自动失效，不靠额外逻辑。
   - `mcp:<server>`（read 类）/ `mcp:<server>:<tool>`（write 类，注入主攻击面，粒度更细）。
   - **round-trip / hand-off 不持久**——它们的风险住在每次都变的参数（prompt/cwd），「记住」覆盖不了危险部分，记了只会制造虚假安心并开注入洞，故一律每次弹卡。

4. **失效只有两条路径**：设置页「本地」tab 经桥读 daemon 账本、显式撤销（daemon 删条目）；permsHash 变更自动失效。**无时间过期**（与本仓库别处砍掉预算/过期复杂度的取向一致）。

**被拒的备选**：

- **扩展 IndexedDB 持有 grant，daemon 无条件信任扩展的授权结论**：把授权判定与强制点分离，daemon 沦为「谁连上就执行」，一旦扩展侧判定有 bug 或被绕过，特权执行无自我防线；且 grant 随浏览器清存储蒸发，与本地能力生命周期错配。
- **两级 scope（session 级内存 grant + 持久 grant）**：早稿设计。收敛「记住」语义后（只有 skill/mcp 两类值得持久、round-trip 永远弹）session 级那层没有服务对象了，删除。

**下游影响**：daemon 必须实现最小授权账本（读/写/撤销 `~/.pie/grants.json`）+ `needs_authorization` 回话协议。会合点拓扑（ADR 0005）下，未来任何 daemon 客户端共享同一账本。撤销 UI 是设置页「本地」tab 的一部分。
