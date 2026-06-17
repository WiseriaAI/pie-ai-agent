# Managed entitlement 缓存持久化 + SWR 刷新

- 日期：2026-06-17
- 状态：设计定稿，待写实施 plan
- 范围：`pie-ai-agent`（客户端单仓库）
- 关联：跨项目契约 `pie-managed-backend/docs/contract.md`（`/auth/exchange`、`/me/entitlement`）

## 1. 问题

Composer 的 ModelPicker 经常显示 managed（Pie 官方订阅）的兜底单条模型 `default`，而非后端 `entitlement.models[]` 的真实阵容。

根因是 managed 模型列表的唯一数据源是一个**进程内内存 `Map`**（`managed-account.ts:15` 的 `entitlementCache`），注释明确「仅当前会话有效，扩展重载即清」。而 ModelPicker（`ModelPicker.tsx:58` `modelsFor`）、`instances.ts:201/252`、`cachedManagedModel` 都同步读这个 Map，读不到就回退 registry 兜底——registry 里 managed 只硬编码一条 `{ id: "default" }`（`registry.ts:339-341`）。

填充这个 Map（`entitlementCache.set`）只有两个常规入口：`getEntitlement()`（仅被 `ManagedAccountPanel` / `ManagedSubscribePanel` / `ManagedErrorCta` 在挂载时 `useEffect` 调用）与 `redeem()`。于是只要满足任一条，Map 即为空 → 掉回 `default`：

- 登录后没去设置页展开过账户面板；
- 关掉再打开 side panel（进程重置，Map 清空）；
- SW 闲置被回收后重启。

更刺眼：登录 `/auth/exchange` 本就返回完整 `{apiKey, entitlement}`（含 `models`，`managed-auth.ts:78`），但 `startManagedLogin` 的调用方只取了 `apiKey` 和 `email`（`ManagedSubscribePanel.tsx:132`），把 `models` 丢了，没回填缓存。手里有数据却没用。

## 2. 目标 / 非目标

**目标**
- managed 模型列表跨 side panel 重开 / SW 重启后仍正确（持久化）。
- 登录 / 订阅完成 / 兑换成功、确认进入 `active` 的那一刻就把列表就绪，用户首次切回 Composer 即看到真实列表，不掉 `default`。
- 后端日后增改模型阵容，老用户能自动看到（最终一致），无需手动清缓存。

**非目标（YAGNI）**
- 不做定时轮询、不做单独的列表拉取服务。模型阵容变化频率极低（后端改 `config.yaml` 才变），轮询是过度设计。
- 不做 TTL / 过期失效（SWR 已保证最终一致）。
- 不改 registry `default` 兜底（保留作冷启动 + 无网络时的最后防线）。
- 不动同步读取点（`ModelPicker` / `instances.ts` / `cachedManagedModel`）的同步签名。

## 3. 架构

双层缓存，单一事实源是内存 `Map`，IndexedDB 做持久后备：

```
                    ┌─ 同步读取层（签名零改动）──────────────┐
  ModelPicker.modelsFor ─┐                                      │
  instances.resolveModelConfig ─┼─→ getCachedEntitlement(apiKey) ← 内存 Map（保留）
  cachedManagedModel ─────┘                                      │
                    └───────────────────────────────────────────┘
                                  ▲ 双写              ▲ 启动水合
                                  │                   │
   写入点 ×3 ──→ cacheEntitlement() ─→ IDB config store（managed_entitlement_${apiKey}）
   (exchange / getEntitlement / redeem)         ▲
                                        hydrateEntitlementCache()（启动调一次）
```

设计要点：异步 IDB 只发生在「写」和「启动水合」，读路径仍是同步内存 Map，现有读取点零侵入。

## 4. 模块改动

### 4.1 `managed-account.ts`（持久层 + 双写）
- 把所有 `entitlementCache.set(apiKey, ent)` 收拢成私有 `cacheEntitlement(apiKey, ent)`：内部**双写** —— 先更新内存 Map（同步），再 `setConfig('managed_entitlement_' + apiKey, ent)`（异步写 IDB，`config-store.ts` 内部已 `publishChange('config','put',key)`）。
- `getEntitlement` / `redeem` 成功路径改调 `cacheEntitlement`（语义不变，多了持久化）。
- 新增导出 `hydrateEntitlementCache(): Promise<void>`：`getAllConfig()` 扫所有 `managed_entitlement_*` key → 每条经 `normalizeEntitlement` 归一化（容旧结构）→ 灌内存 Map。**只写内存，不再 `setConfig`**（避免水合回写循环）。读失败整体吞掉，不抛。
- key 维度按 apiKey（LiteLLM virtual key，长效）。多 managed instance / 多账号天然隔离。

### 4.2 `managed-auth.ts`（登录回填 + locale）
- `startManagedLogin` 的 exchange 成功后 `cacheEntitlement(apiKey, entitlement)` —— 回填目前白丢的那份数据。落在离数据源最近处，所有登录入口（`ManagedSubscribePanel` / `NewConfigWizard`）自动受益。
- exchange 请求带上 `?locale=`（契约支持，当前 `managed-auth.ts:69-73` 未带）。locale 取 `getLocale()`，与 `getEntitlement`（`managed-account.ts:24`）一致——`startManagedLogin` 新增可选 `locale` dep、缺省 `getLocale()`。否则「登录即 active」路径（`ManagedSubscribePanel.tsx:131`，用 exchange 内联 entitlement 而非 `getEntitlement`）回填的 `models.name/description` 会是后端默认语言而非用户当前 UI 语言。带上后登录瞬间即本地化正确，且零额外请求。
- 注：`managed-auth.ts` 已 value-import `normalizeEntitlement`（`:2`），再加 `cacheEntitlement` 同源；`managed-account.ts` 对 `managed-auth` 是 type-only import，不构成运行时循环。

### 4.3 启动水合
- 在现有 `startup-migrations` pipeline 之后 `await hydrateEntitlementCache()`，SW 与 panel 两入口共享（与现有「两入口都 await pipeline 后才读 IDB」一致）。这样进程重启后 ModelPicker 首次渲染即从内存 Map 拿到上次的真实列表。

### 4.4 `ModelPicker` SWR + 重渲染
- `toggleProvider` 展开 managed instance 时无条件触发一次后台刷新（现状被 `lazyEmpty=false` 挡掉，`ModelPicker.tsx:148-149`，因为 managed registry models 非空）。刷新动作 = `getEntitlement(inst.apiKey)`，成功经 `cacheEntitlement` 双写。
- **重渲染触发**（内存 Map 更新不会自动触发 React 重渲染）：复用 `store-bus`。`cacheEntitlement` 走 `setConfig` 已 `publishChange('config',...)`，且 `store-bus.post` 在 BroadcastChannel 存在时同时通知本地 listeners（`store-bus.ts:40-43`，同上下文回环成立）。组件订阅 `onStoreChange('config', c => …)`，过滤 `c.id?.startsWith('managed_entitlement_')` → bump 一个 version state → 重渲染 → `modelsFor` 重读已更新的内存 Map。
- 刷新动作的落点（ModelPicker 直接调 `getEntitlement` vs 经 `onRefreshModels` 上提到 Chat 分派）留给实施 plan 决定；store-bus 重渲染机制与落点无关，两者都成立。

## 5. 数据流

**启动**：`hydrateEntitlementCache()` 从 IDB 灌内存 Map → ModelPicker 首次展开即有真实列表。

**登录 / 订阅完成 / 兑换（进入 active 的全部收口）**：`ManagedSubscribePanel` 的四条进入 active 路径恰好都走被改造的三个函数，因此全部自动灌好内存+IDB：

| 进入 active 的路径 | 走的函数 | 效果 |
|---|---|---|
| 登录即 active（`ManagedSubscribePanel.tsx:131`） | `startManagedLogin`（exchange 内联，带 locale） | 双写回填 |
| 订阅完成 poll 命中（`:76` `checkEntitlement`） | `getEntitlement` | 双写 |
| 手动刷新到 active（`:161` `handleRefresh`） | `getEntitlement` | 双写 |
| 兑换码到 active（`:255` `onRedeemed`） | `redeem` | 双写 |

`onCreated` 关闭 wizard 切回 Composer，ModelPicker 重渲染同步读已填的内存 Map → 直接显示真实列表。这部分零额外请求、零额外代码，是双写设计的副产物。

**展开 ModelPicker（SWR）**：① 同步 `modelsFor` 读内存 Map 立即渲染（命中显真实列表、不闪烁）；② 后台 `getEntitlement` → 成功 `cacheEntitlement` 双写 → store-bus 触发重渲染 → 列表更新到最新（覆盖后端阵容变更）。

## 6. 错误处理

- `hydrateEntitlementCache` 读 IDB 失败 → 整体吞掉，退回「内存空 → 兜底」，**不阻塞启动**。
- SWR `getEntitlement` 网络失败 → 静默保留已显缓存（ModelPicker 不弹错；账户面板有自己的错误 UI）。
- 持久化值结构老旧 → 水合时统一过 `normalizeEntitlement` 补默认，不让旧结构裸穿渲染层。

## 7. 边缘假设（标注，不额外处理）

信任后端对 `active` 用户的 exchange / `getEntitlement` 必返回非空 `models`。万一 exchange 对 active 返回空 `models`（后端边缘），用户切回 Composer 第一眼可能短暂掉回 `default`，随后展开 ModelPicker 的 SWR 自动修正。不为此边缘加额外补拉（YAGNI）。

## 8. 测试计划

- **双写**：`cacheEntitlement` / `getEntitlement` / `redeem` 成功后内存 Map 与 IDB（`managed_entitlement_${apiKey}`）都有值。
- **水合**：IDB 预置 → `hydrateEntitlementCache()` → 内存 Map 命中；旧结构经归一化补默认；读失败不抛。
- **登录回填**：`startManagedLogin` 成功后内存+IDB 有 entitlement；exchange 请求 URL 带 `?locale=`。
- **key 隔离**：不同 apiKey 各自独立持久化。
- **ModelPicker**：展开 managed 触发 SWR 刷新；缓存命中先显真实列表；store-bus `config` + `managed_entitlement_` 变更触发重渲染。
- 复用现有 `idb/__tests__` 基建（fake IndexedDB）。

## 9. 关键文件

| 文件 | 角色 |
|---|---|
| `src/lib/managed-account.ts` | 内存 Map + `cacheEntitlement` 双写 + `hydrateEntitlementCache` |
| `src/lib/managed-auth.ts` | exchange 回填 + `?locale=` |
| `src/lib/idb/config-store.ts` | `getConfig`/`setConfig`/`getAllConfig`（复用，已带 store-bus 通知） |
| `src/lib/store-bus.ts` | 重渲染通知（复用，同上下文回环成立） |
| `src/lib/startup-migrations.ts` | 启动 pipeline，水合接在其后 |
| `src/sidepanel/components/ModelPicker.tsx` | 展开 managed SWR + store-bus 订阅重渲染 |
| `src/lib/model-router/providers/registry.ts` | `default` 兜底（保留不动） |
