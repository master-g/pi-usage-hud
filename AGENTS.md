# pi-usage-hud — 项目上下文

> 项目指令与常用命令，供 AI 编码代理按任务需要查阅；Claude Code 经 CLAUDE.md 的 `@AGENTS.md` 导入读到同一份内容。
> 跨会话记忆见 [PROJECT_MEMORY.md](./PROJECT_MEMORY.md)。

## 技术栈

- TypeScript（strict，ESM），pi 扩展：由 pi 的 jiti 运行时直接加载源码，无构建步骤，npm 包直接发布 `.ts` 源文件。
- 运行/测试用 Bun（`bun test`），类型检查用 `tsc`（typescript ^5.9）；pi SDK `@earendil-works/pi-coding-agent` 是 peerDependency。

## 导航

- 单包扁平仓库，源码都在根目录：`index.ts` 入口（provider 注册表 `PROVIDERS` + `HudController`），`refresh.ts` 是 fetch/冷却/快照管线（`UsageStore` seam + 纯函数状态推导），`provider.ts` 定义 `ProviderAdapter` 契约与共享 `getJson`，`codex.ts` / `kimi.ts` / `zhipu.ts` 各实现一个 provider，`store.ts` 管快照文件与冷却，`render.ts` 渲染 HUD 行。
- 新增 provider：加 `xxx.ts` 导出 `ProviderAdapter`，再登记到 `index.ts` 的 `PROVIDERS`。

## 命令

<!-- 常用脚本、构建命令、测试命令、lint/格式化命令。让代理无需猜测即可运行。 -->

- 安装依赖: `bun install`（或 `npm install`）
- 构建: 无构建步骤
- 测试: `bun test`
- 类型检查: `npm run typecheck`（`tsc --noEmit`）
- Lint / 格式化: 未配置

## 工作流与陷阱

- `git push` 和 `npm publish` 须用户确认：包以 `@master.g/pi-usage-hud` 公开发布，发出去的版本无法撤回。
- 测试是顶层 assert 脚本，不用 `test()`，所以 `bun test` 总显示 `0 pass`；以退出码和 `ok — …` 输出判断，断言失败时退出码为 1。
- `render.test.ts` 按绝对路径导入 `~/.bun/install/global/node_modules/@earendil-works/pi-tui`：pi-tui 在扩展目录里解析不到，本机需全局装 pi（bun）才能跑该测试。
- 渲染出的每行宽度不得超过给定宽度：超宽会让 pi-tui 的 `doRender` 抛错并拖垮整个 pi 进程，改 `render.ts` 后必须跑 `bun test`。
- widget 只通过工厂形式的 `ctx.ui.setWidget` 挂载一次，之后用 `tui.requestRender()` 更新：每次 `setWidget` 都会把 widget 移到 below-editor 栈底。
- 发布前用 `npm pack --dry-run` 核对 tarball 内容：`.npmignore` 决定哪些文件进包。

## 代码风格

- 无 lint/formatter 配置；沿用所改文件的现有风格：多数文件 tab 缩进（`render.ts`、`render.test.ts` 用两空格），双引号、分号，相对导入写 `.js` 后缀（`./provider.js`）。
- provider 模块之间不互相依赖，只依赖 `provider.ts`（契约 + `getJson`）；网络、鉴权错误统一返回 `FetchResult`（`ok: false` + `reason`），不抛异常。

## 禁止文件

- `bun.lock`、`package-lock.json`：由包管理器生成，不手改。
- `node_modules/`。

## 审查规则

- 无 CI；提交前本地跑 `bun test` 和 `npm run typecheck`。
- 提交信息用 Conventional Commits（`feat:` / `fix(scope):` / `chore:`），描述中英文均可。

## 项目记忆 (回写约定)

跨会话的持久信息记录在 [PROJECT_MEMORY.md](./PROJECT_MEMORY.md)，只写代码、Git 和文档推导不出的内容。

收尾顺序：验证 → 回写记忆 → 提交 → 推送。回写与本次改动进同一个提交；不提交的任务在结束前回写。

回写是提炼，不是记录：

- 「上次会话」「下次运行」整节改写成一块（分支、验证命令与实际结果、停在何处；接下来做什么），旧块直接删，历史由 Git 保存。
- 本次确认的决策追加到「已验证的事实」，走不通的路径及原因追加到「失败尝试」；每条一行，写结论、原因和来源或适用范围。能从 `git log`、代码或计划文档 30 秒内推出来的（commit SHA、进度状态、计划内容）不写，只留一行指向证据目录。
- 同主题已有条目就改写它，不追加；结论被推翻就删旧条。写不进两行的长期知识搬进 docs/ 后只留一行指针；反复出现或每次会话都要先知道的陷阱，晋升到本文件「工作流与陷阱」后从记忆里删掉。
- 结束前核对门槛：全文 ≤ 24 KB，单行 ≤ 300 字符，改写节各一块。装了 bootstrap-claude 技能的会话用它的 `scripts/memory.py check` 校验，`compact` 只压改写节；追加节条目由人合并或搬出，脚本不自动删。

<!-- bootstrap-claude convention v3 -->
