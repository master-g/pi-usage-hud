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
	/**
	 * Window length in ms — render.ts derives the pace cursor and hourglass
	 * from the data instead of a label-keyed table. Optional because snapshot
	 * files written before this field existed don't have it; they degrade to
	 * the unknown-reset display until the next fetch.
	 */
	windowMs?: number;
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

/** Failure modes shared by every fetch-shaped result. */
export interface Failure {
	ok: false;
	reason: "auth_failed" | "http_error" | "parse_error" | "network";
	message?: string;
}

export type FetchResult = { ok: true; usage: ProviderUsage } | Failure;

/** getJson's result: the parsed body, or the same failure modes as FetchResult. */
export type JsonResult = { ok: true; json: unknown } | Failure;

/**
 * Shared HTTP plumbing for provider adapters: GET with timeout, with the
 * failure mapping (network / 401+403 / non-2xx / bad JSON) defined once.
 * Adapters keep only what actually varies: endpoint, headers, body parse.
 */
export async function getJson(
	url: string,
	headers: Record<string, string>,
	timeoutMs = 10000,
): Promise<JsonResult> {
	let res: Response;
	try {
		res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
	} catch (e) {
		return { ok: false, reason: "network", message: String(e) };
	}
	if (res.status === 401 || res.status === 403) {
		return { ok: false, reason: "auth_failed", message: `HTTP ${res.status}` };
	}
	if (!res.ok) {
		return { ok: false, reason: "http_error", message: `HTTP ${res.status}` };
	}
	try {
		return { ok: true, json: await res.json() };
	} catch (e) {
		return { ok: false, reason: "parse_error", message: String(e) };
	}
}

/**
 * One provider's quota fetcher + identity metadata.
 *
 * - `name`: stable identifier used for the snapshot file name (`<name>-quota.json`)
 *   and notifications.
 * - `providerNames`: pi model `provider` values that map to this adapter. The
 *   first entry is the canonical name; the rest are aliases.
 * - `authKeys`: pi provider IDs to try, in order, when resolving credentials.
 * - `fetch`: performs the live quota request using the resolved API key or
 *   OAuth access token.
 */
export interface ProviderAdapter {
	readonly name: string;
	readonly providerNames: readonly string[];
	readonly authKeys: readonly string[];
	fetch(apiKey: string, timeoutMs?: number): Promise<FetchResult>;
}
