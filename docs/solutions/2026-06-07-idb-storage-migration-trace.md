# IndexedDB 存储层迁移 — Invariant Trace & Known Follow-ups

> 日期：2026-06-07 · 分支 `feat/indexeddb-storage-migration`
> Scope：把全部 `chrome.storage.local` 数据迁移到单个 IndexedDB database `pie`，解除 10 MB 上限，统一原子写语义，切换跨上下文变更通知机制。

## 落地内容摘要

| 模块 | 变化 |
|---|---|
| `src/lib/idb/db.ts` | `openDb` 单库多 store + `tx`/`txMulti` 跨 store 原子事务 + `clearAllStores` |
| `src/lib/idb/config-store.ts` | config store CRUD（encryption_key / active_instance_id / pcm_* / custom_provider_* 等杂项 key） |
| `src/lib/idb/sessions-store.ts` | sessions + session_index 双 store；`writeSessionBatch` = 旧 `writeAtomic` 的 IDB 等价（单 txMulti 原子） |
| `src/lib/store-bus.ts` | `BroadcastChannel('pie-store')`；`publishChange` / `onStoreChange`；happy-dom 降级进程内；取代 `chrome.storage.local.onChanged` |
| `src/lib/startup-migrations.ts` | 统一迁移 pipeline：Phase 1（chrome.storage 上游迁移）→ Phase 2（V3 sweep，幂等）→ Phase 3（IDB 后迁移）；SW 与 panel 共享，await 后才读 IDB |
| `src/lib/crypto.ts` | 加密密钥从 chrome.storage → IDB config；legacy fallback（IDB miss 时读旧 key）供升级期解密 |
| `src/lib/migration-v2.ts` (migration-v3.ts) | V3 sweep：chrome.storage → IDB 完成后 clear；schema_version=3 幂等 |
| StorageIndicator | 改为 `navigator.storage.estimate().usage` 显示 origin 总用量；去掉 8 MB 预算/进度条/告警 |

**已移除**：`QUOTA_BYTES` / `QUOTA_GUARD_BYTES` / `checkAndArchiveLRU`（IDB 无 10 MB 上限）。

## 不变量（新增）

- **D9 原子写不变量保持**：所有多 key 写走 `writeAtomic` → `writeSessionBatch`，单 `txMulti` 跨 sessions + session_index 两 store 原子提交。
- **sweep-first 不变量**：startup pipeline Phase 2（V3 sweep）先于任何 IDB 读；两入口（SW / panel）均 await pipeline 完成。
- **store-bus 通知边界**：sessions 事件 coarse（不带具体变更内容）；session_index 变化搭 sessions 事件通知；skill 包内容变化（独立 pie-skills IDB）无 store-bus 事件。
- **manifest 不变**：未加 `unlimitedStorage` 权限。

## 已知 Follow-ups

### 1. useSession coarse-event 竞态（中优先级）

**现象**：store-bus 的 `sessions` 事件是 coarse（不带具体变更内容），`useSession` 收到后重读 `getSessionMeta`。`clearMessages` 与刚提交的「更长 persist」同时发生时，基于 `remote.length > local.length` 的采纳规则可能短暂重显示旧消息（旧 `onChanged` 携带 `newValue` 时无此问题）。

**建议修法**：用 generation counter 或消息 id 区分 stale-longer vs 真 append，取代纯 length 比较。

### 2. session_index 和 skill 无单独 store-bus 事件（已知，符合迁移范围）

- `session_index` store 变化搭 `sessions` 事件通知，不单独发。
- skill 包内容变化（独立 `pie-skills` IDB）无 store-bus 事件；Chat 仅在 enable/disable 时刷新。

两者均为已知且有意限制，不影响当前功能正确性。

### 3. migration-v2 V1-直升-IDB 窄边缘（已闭合，记录备查）

V1 数据（`provider_*` 键）经 V2 migration 转成 instance 格式后再由 V3 sweep 迁入 IDB，路径：V2 → chrome.storage（instance 格式）→ V3 sweep → IDB。若用户从极早版本（V1）**跳过 V2** 直接升到 V3+，V3 sweep 只看 instance 格式键，V1 格式键留在 chrome.storage 但不被迁移。

实际闭合：`crypto.ts` legacy fallback（IDB miss 时读 chrome.storage 旧 key）保证加密密钥可用；用户数据在 V1 era 极少，且 V2 migration 在 startup pipeline Phase 1 运行（先于 sweep）——正常升级路径 V1 键先被 V2 转换、再被 sweep 迁入 IDB。纯 V1-直升-IDB 路径理论上极窄且密钥不丢，记录备查无需修。
