/**
 * Refresh pipeline: cooldown gating, credential hand-off, fetch, snapshot
 * writes and status derivation behind one function interface.
 *
 * HudController (index.ts) owns only the widget, timers and event wiring —
 * the parts that need a live pi process. Everything decidable lives here,
 * testable through refreshUsage with an in-memory UsageStore, and through
 * the pure statusFromSnapshot.
 */

import type { ProviderAdapter, ProviderUsage } from "./provider.js";
import * as store from "./store.js";
import type { Snapshot } from "./store.js";
import type { HudStatus } from "./render.js";

/**
 * The store seam. Production uses the fs-backed snapshot module; tests
 * inject an in-memory adapter. Two adapters make the seam real.
 */
export interface UsageStore {
	getStored(provider: string): Snapshot;
	shouldFetch(provider: string): boolean;
	writeSuccess(provider: string, usage: ProviderUsage): void;
	writeError(provider: string, reason: string, message?: string): void;
}

/** The production UsageStore: the fs snapshot module, structurally. */
export const fsUsageStore: UsageStore = store;

/** Mark data as stale for display once the last success is older than this. */
const STALE_MS = 2 * 60_000;

/** Human-readable credential hint for the no_creds state. */
export function credsHint(adapter: ProviderAdapter): string {
	return `未找到 ${adapter.name} 凭据（provider: ${adapter.authKeys.join(" / ")}）`;
}

/**
 * Pure status decision: stored snapshot + credential state → HUD variant.
 * `now` is injectable so staleness is testable without waiting.
 */
export function statusFromSnapshot(
	snap: Snapshot,
	hasCredentials: boolean,
	adapter: ProviderAdapter,
	now = Date.now(),
): HudStatus {
	if (!hasCredentials) {
		return {
			kind: "no_creds",
			providerName: adapter.name,
			hint: credsHint(adapter),
		};
	}
	if (snap.usage) {
		const ageMs = snap.updatedAt
			? now - new Date(snap.updatedAt).getTime()
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

export type RefreshOutcome = "fetched" | "cooldown" | "no_credential" | "failed";

/**
 * Fetch if due (or forced), persist through the store seam, and return the
 * status to display. Never throws: every failure mode lands in the snapshot
 * and the returned status, so the HUD never blanks last-good data.
 *
 * - `hasCredentials`: the caller's synchronous "is auth configured" check,
 *   used only for the no_creds display.
 * - `getCredential`: resolves the API key / OAuth token (may refresh); a
 *   throw is recorded as auth_failed.
 */
export async function refreshUsage(
	adapter: ProviderAdapter,
	hasCredentials: boolean,
	getCredential: () => Promise<string | null>,
	opts: { force?: boolean; store?: UsageStore; now?: number } = {},
): Promise<{ status: HudStatus; outcome: RefreshOutcome; reason?: string }> {
	const usageStore = opts.store ?? fsUsageStore;
	const now = opts.now ?? Date.now();
	const done = (outcome: RefreshOutcome, reason?: string) => ({
		status: statusFromSnapshot(
			usageStore.getStored(adapter.name),
			hasCredentials,
			adapter,
			now,
		),
		outcome,
		reason,
	});
	if (!opts.force && !usageStore.shouldFetch(adapter.name)) return done("cooldown");
	let credential: string | null;
	try {
		credential = await getCredential();
	} catch (e) {
		usageStore.writeError(adapter.name, "auth_failed", String(e));
		return done("failed", "auth_failed");
	}
	if (!credential) return done("no_credential");
	try {
		const result = await adapter.fetch(credential);
		if (result.ok) {
			usageStore.writeSuccess(adapter.name, result.usage);
			return done("fetched");
		}
		usageStore.writeError(adapter.name, result.reason, result.message);
		return done("failed", result.reason);
	} catch (e) {
		usageStore.writeError(adapter.name, "network", String(e));
		return done("failed", "network");
	}
}
