/**
 * Shared types + the ProviderAdapter contract.
 *
 * Each provider (zhipu, kimi, ...) lives in its own module and exports a
 * ProviderAdapter. index.ts holds a registry of adapters and dispatches based
 * on the active model's `provider` field.
 *
 * To add a provider:
 *   1. Add `xxx.ts` exporting a ProviderAdapter.
 *   2. Register it in index.ts's `PROVIDERS` array.
 */

/** A single rolling-token window (used percentage + next reset). */
export interface WindowUsage {
	/** used percentage 0..100 */
	usedPct: number;
	/** ISO timestamp of next reset */
	resetsAt: string;
}

/**
 * Normalized usage — provider-agnostic. Both windows are optional because a
 * given account/plan may expose only one (or neither) of them.
 */
export interface ProviderUsage {
	fiveHour: WindowUsage | null;
	sevenDay: WindowUsage | null;
	fetchedAt: string;
}

export type FetchResult =
	| { ok: true; usage: ProviderUsage }
	| {
			ok: false;
			reason: "auth_failed" | "http_error" | "parse_error" | "network";
			message?: string;
	  };

/**
 * One provider's quota fetcher + identity metadata.
 *
 * - `name`: stable identifier used for the snapshot file name (`<name>-quota.json`)
 *   and notifications.
 * - `providerNames`: pi model `provider` values that map to this adapter. The
 *   first entry is the canonical name; the rest are aliases.
 * - `authKeys`: keys in ~/.pi/agent/auth.json to try, in order, when resolving
 *   this provider's API key. The first non-empty `apiKey`/`key` field wins.
 * - `fetch`: performs the live quota request using a bare API key.
 */
export interface ProviderAdapter {
	readonly name: string;
	readonly providerNames: readonly string[];
	readonly authKeys: readonly string[];
	fetch(apiKey: string, timeoutMs?: number): Promise<FetchResult>;
}
