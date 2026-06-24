# 工具命名约定：动词_领域 + 全局无歧义

合并 page-atlas 读工具时（PR #217），新工具拟名 `read_records` 撞上 scratchpad 既有的 `read_records`，被迫改名 `read_struct`。复盘发现根因不是"缺前缀"，而是**已有的事实命名约定没有被写下来、也被漏用了**：工具作用域分类其实早已存在于 `TOOL_GROUPS`（`DisclosureGroup`：core / screenshot / skill-mediation / pdf / local-file / scratchpad / schedule / skill-authoring）这一**元数据**里，渐进披露 `load_tools` 按能力包（=group）名加载、不靠工具名前缀检索（见 `docs/specs/2026-06-13-progressive-tool-disclosure-design.md`，语义检索为明确非目标）。

**决定**：

1. **新工具命名一律 `动词_领域`，领域做后缀**（与现状一致：`read_pdf` / `list_tabs` / `create_skill` / `read_editor` / `create_schedule`）。**不采用 `领域_动词` 前缀**（如 `page_read_struct`）——那会反转既有几十个工具的约定、制造长期不一致，且收益（"看名字知作用域"）已被 `TOOL_GROUPS` 元数据覆盖。

2. **新工具名必须对全部现有工具无歧义**——尤其不得与其他领域的工具同名或近义到 LLM 在"意图→选工具"时会混淆（`read_records` 撞 `read_records` 就该被这条拦下）。加新工具时先 `rg` 一遍工具名清单。

3. **一个领域有多个工具时共用领域 token**（`*_tabs` / `*_pdf` / `*_skill` / `*_scratchpad`），让同域工具在名字上聚簇。

4. **作用域分类靠 `TOOL_GROUPS` 元数据，不靠名字**。新工具落地时必须在 `TOOL_CLASSES`（read/write，R7 锁用）+ `TOOL_GROUPS`（能力包，披露用）两表登记——这是既有 build-time 不变量，本就会 throw，约定只是把它说清楚。

5. **对外（MCP / 跨 agent 暴露）的命名空间另行决定**。届时为防与其它 server 工具撞名，可能需要 `pie_*` 这类**外部**前缀——这是真正需要前缀的场景，但属于 MCP 接入边界的整体决策（随 disclosure plan 做 + 配迁移），不在本 ADR 的"内部工具名"范围内。

**被拒的备选**：

- **全局前缀重命名（`page_*` / `scratchpad_*` ...）**：要改 ~45 个工具 + 2596 测试断言 + prompt/skill 文档 + **持久化态**（录制按字符串记工具名、scheduled task、skill 引用名）→ 破坏性、需迁移垫片。为一个 `TOOL_GROUPS` 已表达的事实付这个账，不划算。
- **引入语义检索/embedding 选工具**：disclosure spec 已判定目录足够小、按名加载即可，非目标。

**已知欠账（不在本 ADR 修，见 issue #222）**：scratchpad 的 `save_records` / `read_records` / `update_notes` 未带 `_scratchpad` 领域后缀，违反本约定第 3 条，也是这次撞名的土壤（`query_scratchpad` / `clear_scratchpad` 已合规）。因涉及持久化态（录制/scheduled task）与 skill 文档引用，作为独立的破坏性改动单独排期，不搭车本 ADR。

**下游影响**：纯约定文档，不改代码。后续加工具的 PR 受本约定约束；reviewer 据此把关新工具名。
