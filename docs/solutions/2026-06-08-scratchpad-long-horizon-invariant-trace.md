# 长程任务草稿本（Scratchpad）— 落地 invariant trace

- 日期：2026-06-08
- 分支：`worktree-scratchpad-long-horizon`
- spec：`docs/specs/2026-06-08-scratchpad-long-horizon.md`
- plan：`docs/plans/2026-06-08-scratchpad-long-horizon.md`（17 任务，subagent-driven 执行，每组两阶段 review）
- 状态：实现完成，单测全绿（203 files / 1864 passed / 1 skipped），typecheck 0，build 成功。**待真机回归**。

## 解决的问题

长程数据抽取/爬虫任务中，数据只活在 LLM 对话上下文，被三道裁剪机制（sliding window 12 对 / compact-react-window LLM 摘要 / elide-stale-observations）绞掉，"几轮迭代后 agent 自己就忘了"。核心解法：把数据从易失的上下文搬到 IndexedDB 持久层，上下文只留一个有界、永不被裁的概览指针。

## 落地 invariant

- **S1 — 事实源唯一**：scratchpad 数据的唯一权威是 IndexedDB 单库 `pie` 的 `scratchpads` store（`keyPath:"id"`，key = sessionId）。`DB_VERSION` 1→2（漏 bump 则现有用户 onupgradeneeded 不触发、永不建 store）。SQLite(sql.js) 只是**瞬态清洗协处理器**，无任何持久状态——与 PDF offscreen/LiteParse 同生命周期哲学（offscreen 里的都是可丢弃派生物，SW idle 即回收）。
- **S2 — 概览搭车 trailing，永不被裁**：每轮 `buildObservationMessage` 后把 `<scratchpad_overview>`（有界：每表计数 + dedupeKey + 前 3 条预览 + notes 全文）append 到 observationText，并入最新 user turn（trailing）。sliding-window / compaction / token-budget 三者都不动 trailing。数据落盘瞬间即脱离对话介质，compaction 摘掉写入步骤也不丢数据/进度。
- **S3 — untrusted 包裹不变量**：概览预览、`read_records` 回显、`query_scratchpad` 结果预览——凡页面派生数据进 LLM context，一律 `<untrusted_scratchpad_preview>` 包裹 + `escapeUntrustedWrappers` 转义。新 tag 在 `UNTRUSTED_WRAPPER_TAGS`（主）+ probe-core.ts / html-strip.ts / _shared/interactive.ts / **recording/capture.ts** 全部副本登记，dual-list lock-step 测试守。notes 与计数/表名是 trusted（LLM 自写 / 系统聚合）。
- **S4 — 容量保护**：所有写放大路径写前 `estimateBytes > MAX_SCRATCHPAD_BYTES(50MB/session)` 即拒（结构化 error，不落盘、不损坏）——覆盖 `saveRecords` 和 `query_scratchpad` 的 `into` 写回（SQL 能放大行数，如 self cross-join N→N²，是独立于 saveRecords 的真实放大面）。唯 `update_notes` 不设守卫（见加固项 5）。Backlog：可做用户可调。
- **S5 — fail-soft 概览读**：`svcGetOverview` 每步读 IDB，包在 try/catch 里——读失败 `console.warn` + 空概览继续，绝不 unwind 外层 catch-less try 杀掉 in-flight 任务（概览是增强项）。
- **S6 — 生命周期**：scratchpad per-session，`hardDeleteSession` 删、30 天 `hardDeleteExpired` sweep 也删（best-effort）；**archive 有意保留**（绑 session 而非 live-task，unarchive 可续爬，区别于绑 live-session 的 output_file artifacts）。
- **S7 — SQL 沙箱安全**：`runQuery` 表名/列名经 `quoteIdent` 转义（双引号 + 内部引号 double-up），值走 bound `?` placeholder，无插值注入面；`db.close()` 在 finally 保证释放；列无类型声明以保留 number affinity；嵌套对象存 JSON text。SQL 在 WASM 沙箱内只能动导入的临时表，碰不到页面/网络/扩展状态。
- **S8 — read/write 分类**：5 个 tool 在 `tool-names.ts` 登记 class（save_records/update_notes/clear_scratchpad=write，read_records/query_scratchpad=read）。`query_scratchpad` 的 `into` 虽写 IDB，但分类只服务 `collectCrossSessionConflicts` 的跨 session **tab 锁**判定（无 tab 参数、永不冲突），故归 read 是有意的。

## tool 面

- `save_records(collection, records, dedupeKey?, fields?)` — append + 内置去重（跨调用 seen-set 从已存记录 seed，幂等重试不重复）；返回 `{added, skipped, total}`。
- `update_notes(notes)` — 整块覆写进度笔记。
- `read_records(collection, offset?, limit?, query?)` — 分页（默认 50）+ 子串过滤；untrusted 包裹回显。
- `query_scratchpad(from, sql, into?)` — sql.js 就地清洗；省 `into` 返回结果摘要，给 `into` 把结果集 replace 写回新/同名 collection（`into===from` 就地清洗已验证安全：records 在发送前已读入独立数组）。
- `clear_scratchpad(collection?)` — 重置一表或全部。
- 导出复用 `output_file`（序列化 collection 成 CSV/JSON → 侧栏下载卡）。

## 实现相对 plan 的偏差 / 安全加固（两阶段 review 产出）

1. **plan Task 3 漏列文件**：dual-list lock-step 实际还检查 `recording/capture.ts`（plan 只写 4 文件）；实现按测试补到 5 文件。
2. **read_records untrusted 包裹（S3）**：plan Task 8 原稿 `read_records` 直接 `JSON.stringify` 回显，code review 揪出违反 P3-O；已修为与 overview 同款包裹 + 转义，并加注入转义测试。
3. **概览 fail-soft（S5）**：plan Task 10 原稿 `svcGetOverview` 是裸 await，code review 判定一次 IDB 读失败会杀整个任务；已包 try/catch + 空串 fallback。
4. **sweep 清理（S6）**：plan 未覆盖 30 天 sweep 的 scratchpad 清理；既然 archive 保留，sweep 是唯一最终清理路径，已补 best-effort `deleteScratchpad`（未动 pre-existing 的 artifacts sweep gap）。
5. **预算守卫覆盖 saveRecords + query into，唯 updateNotes 不设**：`saveRecords` 与 `query_scratchpad` 的 `into` 写回都走 50MB 守卫（final review 揪出 into 写回原缺守卫、SQL 行放大能突破，已补）；`update_notes` 整块覆写不累积、且单次写受 LLM 输出 token 上限约束（远 < 50MB），故无界是有意决策（理论性、不可达），未加守卫。

## 真机回归清单（待执行）

加载 `dist/` 到 Chrome 后逐项验证：

1. **CSP 权威验证**：触发 `query_scratchpad` 让 offscreen 跑 sql.js，确认 `wasm-unsafe-eval`-only CSP 下能初始化（静态预检已 GO：sql.js 1.14.1 胶水 0 个 eval/new Function；此为权威确认）。
2. **多页抓取 + compaction 不丢数据**：跑足够多步触发 compaction，确认早期数据 `read_records` 可取回、概览计数不回退。
3. **进度笔记**：`update_notes` 写的进度每轮概览可见。
4. **去重**：同页重复 `save_records`，skipped 计数正确。
5. **SQL 清洗**：`query_scratchpad` 去重/过滤 → `into` 写回 → `output_file` 导出 → 下载卡正常。
6. **SW 回收存活**：等待/手动 stop SW 后继续任务，scratchpad 数据仍在（IDB 持久）。
7. **session 删除清理**：删 session 后 DevTools → IndexedDB → pie/scratchpads 确认记录被清。
8. **旧版升级 DB 迁移**：DB_VERSION=1 的既有 profile 升级到 2，`scratchpads` store 被创建、原有 sessions/instances/config 无损。
9. **skill 触发 + playbook 遵循（端到端引导验证）**：对列表/抓取类请求（如"把这网站的商品列出来"）确认能触发 `extract_structured_data` skill（`use_skill` 被调用），且加载后模型照 playbook 走——逐页 `save_records`、概览核对、导出前停下来问用户清洗/格式。检验"工具 + 三层引导（常驻 SCRATCHPAD_GUIDANCE + skill playbook + 每轮概览）是否真驱动模型正确编排"。
