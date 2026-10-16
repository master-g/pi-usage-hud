# GLOSSARY — pi-usage-hud

项目领域词汇，供代码、文档与 AI 代理统一用语。架构词汇（module / interface / depth / seam / adapter / leverage / locality）不在此列，见 codebase-design 技能的定义。

- **Provider adapter（provider 适配器）**：一个 provider 的配额抓取器 + 身份元数据，实现 `provider.ts` 的 `ProviderAdapter` 契约（name / providerNames / authKeys / fetch）。每个 adapter 把异构 API 归一化成统一的用量窗口；adapter 之间共享 `getJson` 的 HTTP 骨架，只保留 endpoint、headers、parse 三样差异。
- **Usage snapshot（用量快照）**：每个 provider 一个的 JSON 文件 `~/.pi/agent/<provider>-quota.json`，跨 pi 会话共享；保存 last-good 用量与最近一次错误，出错时不清空旧数据。
- **Quota window（配额窗口）**：滚动 token 窗口，产品固定为 5h / 7d 两个槽位（`ProviderUsage.fiveHour` / `sevenDay`）。`WindowUsage.windowMs` 是窗口长度，pace cursor 与沙漏图标都从这个数据推导，render.ts 不再按 label 反查。
- **Refresh pipeline（refresh 管线）**：`refresh.ts` 的 `refreshUsage` —— 冷却判定 → 凭据交接 → fetch → 快照写入 → 状态推导，收在一个函数 interface 后面。`UsageStore` 是它的 store seam：生产是 fs 快照模块，测试注入内存 adapter。
- **HUD line**：渲染在编辑器下方的一行进度条（render.ts）；宽度契约为任何渲染行不得超过终端列宽，否则 pi-tui 抛错拖垮进程。
- **Pace cursor**：进度条上的 accent 色刻度，标记匀速消耗下当前应处的位置；窗口长度未知（旧快照）或窗口刚开始（<5%）时隐藏。
- **Cooldown（冷却）**：同一 provider 两次成功 fetch 之间的最小间隔（默认 60s，`USAGE_HUD_COOLDOWN_SECONDS` 可调），由快照 `updatedAt` 判定。
