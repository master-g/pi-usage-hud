# 项目记忆 — pi-usage-hud

> 跨会话的持久信息，只记代码、Git 和文档推导不出的内容。回写约定见 [AGENTS.md](./AGENTS.md)。
> 门槛：全文 ≤ 24 KB，单行 ≤ 300 字符；改写节各只留一块。

## 已验证的事实

<!-- 追加：确认过的决策和约束，每条一行：结论 + 原因 + 来源。同主题改写既有条目，不追加第二条。 -->

- refresh 管线抽在 `refresh.ts`（`refreshUsage` + 纯函数 `statusFromSnapshot`），store seam 是注入式 `UsageStore`；controller 只留 widget/计时器/事件接线。依据：index.ts 是改动第二频繁且唯一修过 bug（fb043c5）的文件，却零测试。（2026-10-16 架构评审候选 A）
- 三个 provider 的 HTTP 骨架收敛为 `provider.ts` 的 `getJson`，错误映射（network/401+403/非 2xx/坏 JSON）只定义一次；adapter 只留 endpoint、headers、parse。（候选 B）
- `WindowUsage.windowMs` 是可选字段：磁盘上的旧快照没有这个字段，属于信任边界数据，render 对缺失降级为“未知重置”显示，不抛错。（候选 C）

## 失败尝试

<!-- 追加：走不通的路径及原因，每条一行。 -->

## 上次会话

<!-- 整块改写：分支、验证命令及实际结果、停在何处；任务细节只留一行指向证据目录。 -->

master 分支，未提交。完成架构评审（报告在 /tmp/architecture-review-20261016-142209.html）并落地候选 A+B+C：新增 `refresh.ts`、`GLOSSARY.md`，改 `provider.ts`/`render.ts`/`index.ts`/三个 adapter/两个既有测试，新增 `refresh.test.ts`。随后跑了两轴 code-review（Standards/Spec 均 PASS），应用三条修复：refreshNow 在 fetch 进行中时通知而非静默、AGENTS.md 风格节改为「契约 + getJson」、refresh.ts 局部 store 改名 usageStore。验证：`bun test` 退出码 0（七组 ok 行），`npm run typecheck` 通过。停在未提交状态。

## 下次运行

<!-- 整块改写：接下来的任务和优先级，含仍受阻的项。 -->

提交并推送本次改动（`git push` 需用户确认）；无其他待办。
