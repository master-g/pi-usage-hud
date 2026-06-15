/**
 * usage-hud — shows provider rolling-quota token usage as a progress-bar
 * HUD line below the editor.
 *
 *   Usage  5h █░░░░░░░░░ 1% ↻3.7h  ·  7d █░░░░░░░░░ 4% ↻2.9d
 *
 * Provider support lives in sibling fetcher modules (one per provider), each
 * implementing the ProviderAdapter interface from provider.ts.
 * Currently implemented:
 *   - zhipu.ts  → Zhipu / bigmodel   (providers: zhipu, zai-coding-cn, zhipu-coding)
 *   - kimi.ts   → Kimi / moonshot    (providers: kimi-coding, kimi, moonshot)
 *
 * To add a provider: add `xxx.ts` exporting a ProviderAdapter, then register
 * it in the `PROVIDERS` array below.
 *
 * Design:
 *   - Only renders when the active model's provider has a fetcher here.
 *   - Reads the provider's API key from ~/.pi/agent/auth.json (same key used
 *     for model calls — no separate expiring web dashboard token to maintain).
 *   - Fetches on session_start and after each completed turn (agent_end),
 *     cooldown-guarded via a per-provider snapshot file
 *     (~/.pi/agent/<provider>-quota.json).
 *   - A 30s interval re-renders from cache (keeps the reset countdown fresh
 *     and picks up the latest data without an extra network call).
 *   - Errors are surfaced without blanking last-good data.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ProviderAdapter } from "./provider.js";
import { zhipu } from "./zhipu.js";
import { kimi } from "./kimi.js";
import { getStored, shouldFetch, writeError, writeSuccess } from "./store.js";
import { renderHudLine, type HudStatus } from "./render.js";

// ─── Provider registry ──────────────────────────────────────────────────────
// Order matters only for diagnostics; dispatch is by provider-name match.
const PROVIDERS: readonly ProviderAdapter[] = [zhipu, kimi];

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

function authFilePath(): string {
	const piHome = process.env.PI_HOME ?? path.join(os.homedir(), ".pi");
	return path.join(piHome, "agent", "auth.json");
}

/**
 * Resolve an API key from ~/.pi/agent/auth.json for the given adapter.
 * Tries the adapter's `authKeys` in order; the first non-empty `apiKey`/`key`
 * field wins. Cached per-adapter after first successful read (cleared when a
 * miss happens so a later auth.json edit is picked up on the next attempt).
 */
const apiKeyCache = new Map<string, string>();
function resolveApiKey(adapter: ProviderAdapter): string | null {
	const cached = apiKeyCache.get(adapter.name);
	if (cached !== undefined) return cached;
	let resolved: string | null = null;
	try {
		const authPath = authFilePath();
		if (fs.existsSync(authPath)) {
			const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
			for (const key of adapter.authKeys) {
				const entry = auth[key];
				const val = entry?.apiKey ?? entry?.key;
				if (typeof val === "string" && val) {
					resolved = val;
					break;
				}
			}
		}
	} catch {
		// corrupt or unreadable auth.json — treat as no key
	}
	if (resolved) apiKeyCache.set(adapter.name, resolved);
	return resolved;
}

/** Human-readable credential hint for the no_creds state. */
function credsHint(adapter: ProviderAdapter): string {
	return `未找到 ${adapter.name} API key（见 ~/.pi/agent/auth.json 的 ${adapter.authKeys.join(" / ")}）`;
}

/** Decide which HUD variant to show from stored snapshot + credential state. */
function currentStatus(adapter: ProviderAdapter): HudStatus {
	const apiKey = resolveApiKey(adapter);
	if (!apiKey) {
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
 * Methods are no-ops when the active model's provider has no adapter here.
 */
class HudController {
	private interval: ReturnType<typeof setInterval> | null = null;
	/** Guards against overlapping background fetches. */
	private fetching = false;

	paint(ctx: ExtensionContext): void {
		const adapter = adapterFor(ctx.model?.provider);
		if (!adapter) return;
		const line = renderHudLine(ctx.ui.theme, currentStatus(adapter));
		ctx.ui.setWidget(WIDGET_NAME, [line], { placement: "belowEditor" });
	}

	/** Repaint from cache immediately, then refresh from the network if due. */
	async refreshAndPaint(ctx: ExtensionContext): Promise<void> {
		const adapter = adapterFor(ctx.model?.provider);
		if (!adapter) return;
		const apiKey = resolveApiKey(adapter);
		if (!apiKey) {
			this.paint(ctx);
			return;
		}
		this.paint(ctx);
		if (!shouldFetch(adapter.name) || this.fetching) return;
		this.fetching = true;
		try {
			const result = await adapter.fetch(apiKey);
			if (result.ok) writeSuccess(adapter.name, result.usage);
			else writeError(adapter.name, result.reason, result.message);
		} catch (e) {
			writeError(adapter.name, "network", String(e));
		} finally {
			this.fetching = false;
		}
		this.paint(ctx);
	}

	startInterval(ctx: ExtensionContext): void {
		this.stopInterval();
		this.interval = setInterval(() => {
			if (!adapterFor(ctx.model?.provider)) return;
			// Cheap repaint from cache; only fetch when cooldown elapses.
			if (shouldFetch(ctx.model!.provider!) && !this.fetching) {
				void this.refreshAndPaint(ctx);
			} else {
				this.paint(ctx);
			}
		}, TICK_MS);
	}

	stopInterval(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	clearWidget(ctx: ExtensionContext): void {
		ctx.ui.setWidget(WIDGET_NAME, undefined);
	}
}

/** One-time manual fetch + repaint, bypassing the cooldown. */
async function manualRefresh(ctx: ExtensionContext): Promise<void> {
	const adapter = adapterFor(ctx.model?.provider);
	if (!adapter) {
		ctx.ui.notify(
			`当前 provider (${ctx.model?.provider ?? "none"}) 没有用量 fetcher（支持：${PROVIDERS.map((p) => p.name).join(", ")}）`,
			"info",
		);
		return;
	}
	const apiKey = resolveApiKey(adapter);
	if (!apiKey) {
		ctx.ui.notify(credsHint(adapter), "warning");
		return;
	}
	const result = await adapter.fetch(apiKey);
	if (result.ok) {
		writeSuccess(adapter.name, result.usage);
		ctx.ui.notify(`${adapter.name} 用量已刷新`, "info");
	} else {
		writeError(adapter.name, result.reason, result.message);
		ctx.ui.notify(`刷新失败：${result.reason}`, "error");
	}
}

export default function (pi: ExtensionAPI): void {
	const hud = new HudController();

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || !adapterFor(ctx.model?.provider)) return;
		void hud.refreshAndPaint(ctx);
		hud.startInterval(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (adapterFor(ctx.model?.provider)) {
			void hud.refreshAndPaint(ctx);
			hud.startInterval(ctx);
		} else {
			hud.stopInterval();
			hud.clearWidget(ctx);
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.hasUI && adapterFor(ctx.model?.provider))
			void hud.refreshAndPaint(ctx);
	});

	pi.on("session_shutdown", () => hud.stopInterval());

	pi.registerCommand("usage-hud", {
		description: "强制刷新用量 HUD",
		handler: async (_args, ctx) => {
			await manualRefresh(ctx);
			if (ctx.hasUI) hud.paint(ctx);
		},
	});
}
