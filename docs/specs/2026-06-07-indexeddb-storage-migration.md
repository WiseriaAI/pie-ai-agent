# IndexedDB 存储层迁移设计

- 日期：2026-06-07
- 状态：设计已确认，待写实施 plan
- 范围：`pie-ai-agent`（单仓库，不牵动后端）

## 背景与动机

当前所有持久化配置与会话数据存在 `chrome.storage.local`，受 MV3 的 **10 MB 硬上限**约束。代码刻意把可用预算定在 8 MB（`STORAGE_BUDGET_BYTES` / `QUOTA_GUARD_BYTES` / `lifecycle.QUOTA_BYTES`），预留 2 MB 给非会话 key，并在写入前做字节检查、超阈值就 LRU 自动归档最老会话。

会话消息历史是存储大头，10 MB 很容易触顶。已有局部规避（图片附件走内存 image-cache、output 文件走 IndexedDB `pie-output-files`、skill 虚拟文件树走 IndexedDB `skill-store`），但主数据仍困在 10 MB 里。

**目标**：把 `chrome.storage.local` 里的全部数据（会话、密钥/实例、skill 开关、各类配置）统一迁到 IndexedDB，获得统一的维护/销毁入口，并彻底摆脱 10 MB 上限。

### 关键事实（决策依据）

- `chrome.storage.local` 的 10 MB 是**该 API 专属**上限。迁到 IndexedDB 后，**无论是否加 `unlimitedStorage` 权限，都已不受 10 MB 约束**（IDB 走 origin 配额，通常为磁盘的百分比、GB 级）。
- `unlimitedStorage` 权限的真正作用：①persistent（磁盘紧张时不被静默驱逐）；②解除 origin 配额上限。代价是 manifest 权限变更 → Chrome Web Store 重审 + 用户更新时看到新权限提示。
- IndexedDB 无原生跨上下文变更事件（不像 `chrome.storage.local.onChanged`）。

## 已确认的设计决策

| # | 决策点 | 选定方案 |
|---|---|---|
| D1 | 核心架构 | **领域化对象存储**（domain object stores，非 KV 兼容层） |
| D2 | 变更通知 | **BroadcastChannel 统一总线**（跨 SW + panel） |
| D3 | `unlimitedStorage` 权限 | **不加**（IDB 已远超 10 MB；极端磁盘压力下 best-effort 被驱逐的风险可接受） |
| D4 | 旧 8 MB 阈值 | **彻底去掉自动 LRU 归档阈值**；保留 30 天过期 + 手动软/硬删 + 手动归档/恢复 |
| D5 | 范围/分期 | **单次切换 PR**（内部按 commit 分层），不留半迁移态 |

> D1 主动放宽了最初「清理逻辑一字不改」的约束：清理**行为**保持不变，但**实现**从「拼 key 字符串 + `getBytesInUse`」重写为走 object store 的索引/游标查询。

## 架构

### 1. 单 database、多 object store

**一个 IDB database `pie`，内含多个 object store**——而非每域一个 database。原因：IDB 事务可跨同一 database 的多个 store，但不能跨 database。当前 `writeAtomic` 会把 `meta + index` 或 `meta + agent` 一次性原子写（D9 不变量）；要保住该原子性，这些 store 必须同库。

| object store | keyPath | index | 装什么 | 取代的旧 key |
|---|---|---|---|---|
| `sessions` | `id`（如 `${sid}:meta` / `${sid}:agent` / `${sid}:archived`） | — | 会话 meta / agent / archived 三类记录 | `session_${id}_meta` / `_agent` / `_archived` |
| `session_index` | `id`（单例 `"index"`） | — | 轻量索引（title / status / lastAccessedAt 等），抽屉渲染不必加载整段 meta | `session_index` |
| `instances` | `id` | — | `StoredInstance`（含 `encryptedKey`） | `instance_${id}` |
| `config` | `key` | — | 一切杂项单值（见下） | 各对应散 key |

`config` store 收纳的单值 key（沿用原 key 名作为 keyPath 值，迁移即「同名搬家」）：

- `encryption_key`
- `instances_index`、`active_instance_id`
- `last_model_selection`
- `theme-mode`、locale 相关
- `cdp-input-enabled`
- `pcm_${provider}`、`pcmm_${provider}`（per-provider 自定义模型池 + sidecar 元数据）
- custom-providers 相关 key
- search-provider 相关 key
- `schema_version`、`migration_v2_mapping` 等迁移哨兵

设计要点：

- **meta / agent 拆为不同记录**，延续 D2 不变量「panel 写 meta、SW 写 agent 互不竞争」——不同记录的写互不阻塞。
- **`session_index` 保留为独立轻量记录**：渲染会话抽屉只读这一条，避免把所有会话的完整消息历史读进内存。不直接用「在 `sessions` store 上建 status 索引再 `getAll`」是因为那会连整段 meta 一起拉出，渲染列表代价过大。
- 每个域一个薄模块（`sessions/idb.ts`、改造后的 `instances.ts`、新 `config-store.ts`），复用 `lib/files/output-store.ts` 既有的 `openDb` / `tx` 模式，但 `openDb` 升级为「多 store + 版本化 `onupgradeneeded`」。

### 2. 变更通知总线 `lib/store-bus.ts`

```
const bus = new BroadcastChannel('pie-store')
publishChange(store, op, id)   // postMessage({store, op, id})
onStoreChange(store, cb)       // addEventListener + 按 store 过滤
```

- 每个 store 的写事务 `oncomplete` 后调 `publishChange`。
- panel 侧提供 `useStoreChange(store, cb)` hook 订阅、按 store 名过滤后重拉。
- 逐一替换现有 `chrome.storage.local.onChanged.addListener` 订阅点（`StorageIndicator`、`App.tsx`、`Chat.tsx` 等）。
- MV3 下 BroadcastChannel 在 SW 与 panel 间可用，补齐旧 `onChanged` 的跨上下文语义。

### 3. 清理行为（迁移后）

- ❌ **移除**：LRU 自动归档全链路——`QUOTA_GUARD_BYTES`、`setSessionAgent` 写入前字节检查、`checkAndArchiveLRU` 及其调用。
- ✅ **保留**（行为不变，实现改走 store）：
  - 30 天过期硬删 `hardDeleteExpired`（App 挂载触发）
  - 手动软删 / 硬删
  - 手动归档 / 恢复（archive / unarchive / delete-forever）
  - 归档或硬删时连带删 output 文件 `deleteSessionArtifacts`

> 「archive」作为**手动**功能与 30 天过期照旧；仅移除「写入压力触发的**自动** LRU 归档」。

### 4. StorageIndicator 新行为

- 去掉分母（`/ 8 MB`）与 7.5 MB 变橙告警。
- headline 改为纯用量 `X MB used`，数字优先取 `navigator.storage.estimate().usage`（整个 origin 用量，一次调用，涵盖 sessions / instances / output-files / skill 包 / WASM cache，即「Pie 总占用」最诚实的数）。
- `estimate()` 不可用时回退到累加各 store 记录 `byteLength`。
- 订阅从 `chrome.storage.local.onChanged` 改为 `useStoreChange`。
- per-store / per-session 明细拆分**不在本次范围**，留给 #4 内容管理 issue。
- 可选增强：运行时调 `navigator.storage.persist()` 请求持久化（无需 manifest 权限，浏览器自行决定是否授予）——列为可选项，不阻塞本次落地。

### 5. 迁移 / 切换（V2 → V3，一次性静默）

执行时机与顺序：

1. App 启动时，在**现有所有 chrome.storage 系迁移**（`migrate-v2` 及各 `migration-*` / `cleanup-migration` 模块）全部跑完、chrome.storage 进入终态**之后**，执行 V3 sweep。
2. V3 sweep：把 `chrome.storage.local` 终态读出 → 在**一个 IDB 事务**里写进对应 store → 成功后 `chrome.storage.local.clear()` 旧 key → 写 `config.schema_version = 3`。
3. 因 IDB 事务全有或全无，「先写成功再清旧 key」保证不存在写一半丢数据；中途中断可安全重跑（幂等：`schema_version === 3` 直接 return）。

密钥安全：

- `encryption_key` 与 `instances`（内含同一把 key 加密的 blob）必须在同一 sweep 里一起搬；key 完好则解密照常。
- at-rest 安全性与 `chrome.storage.local` 等价（均仅扩展自身可访问、明文落盘，AES-GCM 加密的是 API key blob，密钥本身明文存储——此点未因迁移改变）。

### 6. 测试面与基建

- 21 个测试文件目前打 `chrome.storage.local` mock，需引入 IDB 测试后端：优先 `fake-indexeddb`（dev 依赖），或先确认 happy-dom 的 IDB 实现是否够用。这是落地第一步的基建前提。
- `store-bus` 在测试中需可 mock/静默（BroadcastChannel 在 happy-dom 下的可用性需确认，必要时提供 noop 后端）。
- 构建期不变量（`tool-names.ts` / `tools.ts` 的 throw）与本次无关，但提交前仍须 `pnpm test` + `pnpm typecheck` + `pnpm build` 全绿。

## 范围与分期

**单次切换 PR**，不留半迁移态（避免 StorageIndicator 用量数与 sweep 横跨两套后端）。PR 内部按 commit 分层便于 review：

1. 基建：`lib/idb/` 通用 `openDb`/`tx`（多 store）+ `store-bus.ts` + 测试后端（fake-indexeddb）
2. `sessions` + `session_index` store + `sessions/storage.ts`、`lifecycle.ts` 改造（含移除 LRU 自动归档）
3. `instances` store + `crypto` 的 `encryption_key` 迁移
4. `config` store + 各杂项 key（pcm/pcmm、custom-providers、search-provider、theme、locale、last-model-selection、cdp-input-enabled 等）
5. V3 migration sweep（在既有迁移之后运行）
6. 订阅点替换（`onChanged` → `useStoreChange`）+ StorageIndicator 新行为
7. 全量测试迁移到 IDB 后端

## 显式不做（YAGNI / 留给后续）

- per-store / per-session 字节明细面板、一键清空某域、清理建议行动按钮 → **#4 内容管理 issue**，本次迁移落地后单独开。
- `unlimitedStorage` 权限 → 不加（见 D3）。
- KV 兼容层 → 不采用（见 D1，选了领域化）。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| V3 sweep 与既有 chrome.storage 迁移顺序错乱导致漏搬 | sweep 严格在所有既有迁移之后；幂等哨兵 `schema_version === 3` |
| 密钥/实例搬家不一致导致全部实例解密失败 | key 与 instances 同事务搬；先写成功再清旧 key |
| BroadcastChannel 在某些上下文/测试不可用 | 提供 noop 后端；测试可 mock |
| 跨 store 原子写需求被拆库破坏 | 单 database 多 store，事务可跨 store |
| 半迁移态导致用量/清理逻辑横跨两后端 | D5 单次切换，不分期上线 |
