# Scratchpad tool `_scratchpad` suffix rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the three non-compliant scratchpad tools to carry the `_scratchpad` domain suffix (ADR 0004), so cross-domain name collisions (e.g. the PR #217 `read_records` clash) structurally disappear.

**Architecture:** Pure identifier rename of three tool-name strings + every reference (tool registry, read/write class table, disclosure group table, runtime guidance copy, the `extract_structured_data` skill playbook, and test assertions). The internal camelCase variables/service methods (`saveRecords`, `updateNotes`) are NOT renamed — only the snake_case tool-name strings change. No persistence compat needed (see Global Constraints).

**Tech Stack:** TypeScript, vitest.

## Rename map

| Old | New |
|---|---|
| `save_records` | `save_scratchpad` |
| `update_notes` | `update_scratchpad_notes` |
| `read_records` | `read_scratchpad` |

(`query_scratchpad` / `clear_scratchpad` already compliant — untouched.)

## Global Constraints

- **No persistence migration.** Verified: recording (`src/lib/recording/`) stores DOM actions, not agent tool names; `ScheduleRecord` (`src/lib/schedules/`) stores prompt/model/schedule, not tool names. The only place old names persist is session `agentMessages` history (completed tool_use/tool_result blocks) — pure resumed context, never re-executed; an unknown old name would self-correct via the normal tool-not-found path. So no compat map / migration script.
- **Rename scope = `src/` only.** Historical docs (`docs/specs|plans|solutions|release-notes|ROADMAP|adr`) record state at their date — leave them. ADR 0004 already names #222 as the tracking item.
- **camelCase identifiers stay.** Only whole-word snake_case `save_records`/`update_notes`/`read_records` strings change.
- Gates before PR: `pnpm test`, `pnpm typecheck`, `pnpm build` all green; `rg -w` over `src/` shows zero old names.

---

### Task 1: Rename the three tools and all `src/` references

**Files (source):**
- Modify: `src/lib/agent/tools/scratchpad.ts` — tool `name:` strings + cross-references in descriptions
- Modify: `src/lib/agent/tool-names.ts` — `SCRATCHPAD_TOOL_NAMES` enum, `TOOL_CLASSES`, `TOOL_GROUPS`, comments
- Modify: `src/lib/agent/disclosure.ts` — `SCRATCHPAD_GUIDANCE` copy + `catalogLine`
- Modify: `src/lib/agent/loop.ts` — soft-budget guidance string (~L1536)
- Modify: `src/lib/skills/builtin.ts` — `extract_structured_data` playbook steps (~L44-45)

**Files (tests):**
- Modify: `src/lib/agent/tools/scratchpad.test.ts`, `src/lib/agent/tools/disclosure.test.ts`, `src/lib/agent/disclosure.test.ts`, `src/lib/agent/tool-groups.test.ts`, `src/lib/agent/prompt.test.ts`, `src/lib/skills/builtin.test.ts`

**Interfaces:**
- Produces: tool names `save_scratchpad`, `update_scratchpad_notes`, `read_scratchpad` exposed to the LLM via the registry, classified in `TOOL_CLASSES` (save/update = write, read = read), grouped under `scratchpad` in `TOOL_GROUPS`.

- [ ] **Step 1: Update test assertions to expect the new names (RED)**

The test files assert old names (`scratchpad.test.ts` byName lookups + sorted-name list, `disclosure.test.ts`/`tools/disclosure.test.ts` catalog/observation contains, `tool-groups.test.ts` `getToolGroup("save_records")`, `builtin.test.ts` md contains, `prompt.test.ts` contains). Rewrite each old-name string to its new name (whole-word). Same perl pass as Step 2 covers tests too; run it over the test files first to make them assert new names while source still emits old — verifying the rename is actually load-bearing.

- [ ] **Step 2: Run the renamed tests to verify they FAIL against old source**

Run: `pnpm test src/lib/agent/tools/scratchpad.test.ts`
Expected: FAIL — `byName.save_scratchpad` is undefined (source still registers `save_records`).

- [ ] **Step 3: Apply the whole-word rename across source + tests (GREEN)**

Run (from worktree root) a portable whole-word replace via perl (`\b` boundary; camelCase `saveRecords`/`updateNotes` won't match snake_case):
```bash
FILES=$(rg -l -w -e save_records -e update_notes -e read_records src/)
perl -pi -e 's/\bsave_records\b/save_scratchpad/g; s/\bupdate_notes\b/update_scratchpad_notes/g; s/\bread_records\b/read_scratchpad/g' $FILES
```
Then read `src/lib/agent/tools/scratchpad.ts` and confirm the three `name:` fields and the in-description cross-refs (e.g. "use update_notes" → "use update_scratchpad_notes") read naturally; fix any awkward prose by hand.

- [ ] **Step 4: Run the scratchpad + disclosure + group tests to verify GREEN**

Run: `pnpm test src/lib/agent/tools/scratchpad.test.ts src/lib/agent/tool-groups.test.ts src/lib/agent/tools/disclosure.test.ts src/lib/agent/disclosure.test.ts src/lib/skills/builtin.test.ts src/lib/agent/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm zero residual old names in `src/`**

Run: `rg -w -e save_records -e update_notes -e read_records src/`
Expected: no matches.

- [ ] **Step 6: Full gates**

Run: `pnpm test` then `pnpm typecheck` then `pnpm build`
Expected: all green. (`tool-names.ts` build-time invariant — every tool must declare a read/write class — still satisfied since the class table was renamed in lockstep.)

- [ ] **Step 7: Commit**

```bash
git add src/ docs/plans/2026-06-25-scratchpad-tool-rename.md
git commit -m "refactor(scratchpad): add _scratchpad domain suffix to save/read/update tools (#222)"
```
