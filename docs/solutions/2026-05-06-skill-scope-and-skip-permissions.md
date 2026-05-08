<!-- docs/solutions/2026-05-06-skill-scope-and-skip-permissions.md -->
---
date: 2026-05-06
phase: skill-scope-and-skip-permissions (issue #26)
origin: docs/specs/2026-05-06-skill-scope-and-skip-permissions-requirements.md
plan: docs/plans/2026-05-06-001-feat-skill-scope-and-skip-permissions-plan.md
---

# Skill Scope 解禁 + 全局 skip-permissions toggle — Invariant Trace

## What shipped

- **Change 1**: 删除 R2 (allowedTools enforcement) / R3 (skill→skill 禁止) / R10 (first-run-confirm)。
  `SkillDefinition.allowedTools` / `firstRunConfirmedAt` 字段保留为 `@deprecated`
  optional，向后兼容老 storage 反序列化；新写入路径不再携带。
- **Change 2**: 新增 `src/lib/skip-permissions.ts` global toggle helper，
  Settings 加 `<SkipPermissionsSection>` + 一次性确认 modal，Chat header 加常驻
  warning banner（订阅 `chrome.storage.onChanged`），SW `sendConfirmRequest`
  在 pre-capture / open_url URL pre-parse 之后短路返回 `{approved: true}` 或
  `{approved: true, screenshotResult}`。
- 新增 wire 字段 `AgentStepMessage.autoApproved?: boolean`，loop 在自动批准 high-risk
  或 screenshot 步骤时携带 `true`，panel `AgentStepLine` 渲染 `auto-approved by
  skip-permissions` 小灰字作事后审计入口。

## Invariants 落地

- **I-1 任务级 snapshot**: `runAgentLoop` 入口读 `isSkipPermissionsEnabled()`
  注入 ctx；mid-task 切 toggle 不影响 in-flight 任务（与 keyboard sim 同语义）。
- **I-2 risk classifier 完整保留**: `classifyRisk` 在 skipPermissions=true 时仍跑、
  仍输出 high/low；只是 high 不再走 panel-bound confirm-request 路径。
- **I-3 untrusted_* wrapper 保留**: page snapshot 进 user role 仍包
  `<untrusted_page_content>`；与 confirm UI 完全正交。
- **I-4 K-9 / R7 server-side 锁保留**: close_tabs locked-pin refusal、cross-session
  pinned-tab lock 不依赖 confirm UI。
- **I-5 author taint propagation 保留**: `update_skill` 仍把 author 改为 'agent'
  （SkillsList 角标依据），不再清空 `firstRunConfirmedAt`（字段已 deprecated）。
- **I-6 K-3 链显式弃用**: `risk.ts` G-1 build-time gate 注释明确指向本 phase；
  gate 代码本身保留，因为"每个新 tab tool 必须显式分类"独立有价值。

## Out of scope（沿用 brainstorm Scope Boundaries）

参见 origin。
