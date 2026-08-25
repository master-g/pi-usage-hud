/**
 * usage-hud — shows provider rolling-quota token usage as a progress-bar
 * HUD line below the editor.
 *
 *   Usage  5h █░░░░░░░░ 1%  1h24m  ·  7d █░░░░░░░░ 4%  2d7h
 *
 * Provider support lives in sibling fetcher modules (one per provider), each
 * implementing the ProviderAdapter interface from provider.ts.
 * Currently implemented:
 *   - zhipu.ts  → Zhipu / bigmodel   (providers: zhipu, zai-coding-cn, zhipu-coding)
 *   - kimi.ts   → Kimi / moonshot    (providers: kimi-coding, kimi, moonshot)
 *   - codex.ts  → OpenAI Codex       (provider: openai-codex)
 *
 * To add a provider: add `xxx.ts` exporting a ProviderAdapter, then register
 * it in the `PROVIDERS` array below.
 *
 * Design:
 *   - Only renders when the active model's provider has a fetcher here.
 *   - Resolves credentials through pi's model registry, including OAuth token
 *     refresh. No separate web-dashboard credential is needed.
 *   - Fetches on session_start and after each completed turn (agent_end),
 *     cooldown-guarded via a per-provider snapshot file
 *     (~/.pi/agent/<provider>-quota.json).
 *   - A 30s interval re-renders from cache (keeps the reset countdown fresh
 *     and picks up the latest data without an extra network call).
 *   - Errors are surfaced without blanking last-good data.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ProviderAdapter } from "./provider.js";
import { zhipu } from "./zhipu.js";
import { kimi } from "./kimi.js";
import { codex } from "./codex.js";
import { getStored, shouldFetch, writeError, writeSuccess } from "./store.js";
import { renderHudLine, type HudStatus } from "./render.js";

// ─── Provider registry ──────────────────────────────────────────────────────
// Order matters only for diagnostics; dispatch is by provider-name match.
const PROVIDERS: readonly ProviderAdapter[] = [zhipu, kimi, codex];

const PROVIDER_BY_NAME = new Map<string, ProviderAdapter>();
for (const adapter of PROVIDERS) {
	for (const name of adapter.providerNames) {
		PROVIDER_BY_NAME.set(name, adapter);
	}
}

/** Resolve the adapter for an active pi provider, or null if unsupported. */
function adapterFor(provider: string | undefined): ProviderAdapter | null {
	if (!provider) return null;
	return PROVIDER_BY_NAME.get(provider) ?? null;
}

const WIDGET_NAME = "usage-hud";
const TICK_MS = 30_000;
/** Mark data as stale for display once the last success is older than this. */
const STALE_MS = 2 * 60_000;

/** Find the first configured pi provider that can supply this adapter's credential. */
function credentialProvider(
	adapter: ProviderAdapter,
	ctx: ExtensionContext,
): string | null {
	const candidates = [ctx.model?.provider, ...adapter.authKeys];
	for (const provider of new Set(candidates)) {
		if (provider && ctx.modelRegistry.getProviderAuthStatus(provider).configured) {
			return provider;
		}
	}
	return null;
}

/** Resolve the current credential through pi so expired OAuth tokens refresh. */
async function resolveCredential(
	adapter: ProviderAdapter,
	ctx: ExtensionContext,
): Promise<string | null> {
	const provider = credentialProvider(adapter, ctx);
	if (!provider) return null;
	return (await ctx.modelRegistry.getApiKeyForProvider(provider)) ?? null;
}

/** Human-readable credential hint for the no_creds state. */
function credsHint(adapter: ProviderAdapter): string {
	return `未找到 ${adapter.name} 凭据（provider: ${adapter.authKeys.join(" / ")}）`;
}

/** Decide which HUD variant to show from stored snapshot + credential state. */
function currentStatus(
	adapter: ProviderAdapter,
	hasCredentials: boolean,
): HudStatus {
	if (!hasCredentials) {
		return {
			kind: "no_creds",
			providerName: adapter.name,
			hint: credsHint(adapter),
		};
	}
	const snap = getStored(adapter.name);
	if (snap.usage) {
		const ageMs = snap.updatedAt
			? Date.now() - new Date(snap.updatedAt).getTime()
			: Infinity;
		if (ageMs > STALE_MS && snap.error) {
			return {
				kind: "stale",
				usage: snap.usage,
				reason: snap.errorReason ?? "fetch_failed",
			};
		}
		return { kind: "ok", usage: snap.usage };
	}
	if (snap.error) {
		return {
			kind: "stale",
			usage: null,
			reason: snap.errorReason ?? "fetch_failed",
		};
	}
	return { kind: "stale", usage: null, reason: "pending" };
}

/**
 * Owns the widget lifecycle + background fetch scheduling for one pi process.
 *
 * Rendering strategy: the widget is mounted ONCE via the component-factory
 * form of `ctx.ui.setWidget`. We never call `setWidget` again — updates are
 * pushed by recomputing a cached line and calling `tui.requestRender()`.
 *
 * Why this matters: pi's `setWidget` does `map.delete(key)` + `map.set(key)`
 * on every call, so a widget that is re-set frequently sinks to the BOTTOM
 * of the below-editor stack. The factory form is mounted a single time, so
 * its slot in the stack is stable. Because usage-hud is a global extension
 * (loaded before npm packages like pi-lens / powerline / workflows), its
 * `session_start` handler runs first, so this one-time mount lands at the
 * TOP of the below-editor stack — directly under the input box — and stays
 * there even as other widgets grow beneath it.
 */
class HudController {
	private interval: ReturnType<typeof setInterval> | null = null;
	/** Guards against overlapping background fetches. */
	private fetching = false;
	/** Whether the factory-form widget has been mounted this session. */
	private mounted = false;
	/** Render callback captured from the factory's `tui`, used to refresh. */
	private requestRender: (() => void) | null = null;
	/** Theme captured at mount time (factory closure), used to color the line. */
	private theme: { fg(color: string, text: string): string } | null = null;
	/** Most-recent event context (model/provider resolution). */
	private ctx: ExtensionContext | null = null;
	/** Last read snapshot, or null when the provider has no adapter (line hidden).
	 *  We cache the status, not the rendered line: the line depends on the
	 *  terminal width, which is only known inside `render(width)`. */
	private cachedStatus: HudStatus | null = null;

	/** Re-read the snapshot from disk. Does not trigger a render. */
	private computeStatus(): void {
		const ctx = this.ctx;
		const adapter = adapterFor(ctx?.model?.provider);
		this.cachedStatus =
			adapter && ctx
				? currentStatus(adapter, credentialProvider(adapter, ctx) !== null)
				: null;
	}

	/** Re-read the snapshot and ask pi to re-render the widget. */
	private repaint(): void {
		this.computeStatus();
		this.requestRender?.();
	}

	/**
	 * Mount the widget once (factory form). Idempotent within a session:
	 * subsequent calls just refresh the cached line.
	 */
	mount(ctx: ExtensionContext): void {
		this.ctx = ctx;
		if (this.mounted) {
			this.repaint();
			return;
		}
		ctx.ui.setWidget(
			WIDGET_NAME,
			(
				tui: { requestRender(): void },
				theme: { fg(color: string, text: string): string },
			) => {
				this.theme = theme;
				this.requestRender = () => tui.requestRender();
				this.computeStatus(); // prime cache before first paint (no render during setWidget)
				return {
					// renderHudLine fits the line to `width`; pi-tui kills the
					// process on any line wider than the terminal.
					render: (width: number) =>
						this.cachedStatus && this.theme
							? [renderHudLine(this.theme, this.cachedStatus, width)]
							: [],
					invalidate: () => {},
				};
			},
			{ placement: "belowEditor" },
		);
		this.mounted = true;
	}

	/** Forget the mount so the next `session_start` re-mounts at the top. */
	unmount(): void {
		this.mounted = false;
		this.requestRender = null;
	}

	/** Update context + repaint from cache (no network). Hides the line when
	 *  the active provider has no adapter, while keeping the slot pinned. */
	update(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.repaint();
	}

	/** Cooldown-guarded background refresh (session_start / agent_end / tick). */
	async refresh(ctx: ExtensionContext): Promise<void> {
		this.ctx = ctx;
		const adapter = adapterFor(ctx.model?.provider);
		if (!adapter || !shouldFetch(adapter.name) || this.fetching) {
			this.repaint();
			return;
		}
		this.fetching = true;
		try {
			let credential: string | null;
			try {
				credential = await resolveCredential(adapter, ctx);
			} catch (e) {
				writeError(adapter.name, "auth_failed", String(e));
				return;
			}
			if (!credential) return;
			const result = await adapter.fetch(credential);
			if (result.ok) writeSuccess(adapter.name, result.usage);
			else writeError(adapter.name, result.reason, result.message);
		} catch (e) {
			writeError(adapter.name, "network", String(e));
		} finally {
			this.fetching = false;
			this.repaint();
		}
	}

	/** Forced refresh for the `/usage-hud` command (bypasses the cooldown). */
	async refreshNow(ctx: ExtensionContext): Promise<void> {
		this.ctx = ctx;
		const adapter = adapterFor(ctx.model?.provider);
		if (!adapter) {
			ctx.ui.notify(
				`当前 provider (${ctx.model?.provider ?? "none"}) 没有用量 fetcher（支持：${PROVIDERS.map((p) => p.name).join(", ")}）`,
				"info",
			);
			this.repaint();
			return;
		}
		let credential: string | null;
		try {
			credential = await resolveCredential(adapter, ctx);
		} catch (e) {
			writeError(adapter.name, "auth_failed", String(e));
			ctx.ui.notify("刷新失败：auth_failed", "error");
			this.repaint();
			return;
		}
		if (!credential) {
			ctx.ui.notify(credsHint(adapter), "warning");
			this.repaint();
			return;
		}
		try {
			const result = await adapter.fetch(credential);
			if (result.ok) {
				writeSuccess(adapter.name, result.usage);
				ctx.ui.notify(`${adapter.name} 用量已刷新`, "info");
			} else {
				writeError(adapter.name, result.reason, result.message);
				ctx.ui.notify(`刷新失败：${result.reason}`, "error");
			}
		} catch (e) {
			writeError(adapter.name, "network", String(e));
			ctx.ui.notify("刷新失败：network", "error");
		}
		this.repaint();
	}

	startInterval(ctx: ExtensionContext): void {
		this.stopInterval();
		this.ctx = ctx;
		this.interval = setInterval(() => {
			const adapter = adapterFor(this.ctx?.model?.provider);
			if (!adapter) return;
			// Cheap repaint from cache keeps the reset countdown fresh; only
			// hit the network when the cooldown has elapsed.
			if (shouldFetch(adapter.name) && !this.fetching) {
				void this.refresh(this.ctx!);
			} else {
				this.repaint();
			}
		}, TICK_MS);
	}

	stopInterval(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}
}

export default function (pi: ExtensionAPI): void {
	const hud = new HudController();

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		// Mount first so we claim the top slot of the below-editor stack
		// (global extensions load before npm packages → our handler runs
		// first). Mounting is idempotent; later session_starts just refresh.
		hud.mount(ctx);
		void hud.refresh(ctx);
		hud.startInterval(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (adapterFor(ctx.model?.provider)) {
			void hud.refresh(ctx);
			hud.startInterval(ctx);
		} else {
			hud.stopInterval();
			// Hide the line (renders empty) WITHOUT re-calling setWidget, so
			// the slot stays pinned at the top for when a supported model
			// returns.
			hud.update(ctx);
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.hasUI) void hud.refresh(ctx);
	});

	pi.on("session_shutdown", () => {
		hud.stopInterval();
		hud.unmount();
	});

	pi.registerCommand("usage-hud", {
		description: "强制刷新用量 HUD",
		handler: async (_args, ctx) => {
			await hud.refreshNow(ctx);
		},
	});
}
