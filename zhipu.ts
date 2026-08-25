/**
 * Zhipu quota fetcher.
 *
 * Calls the bigmodel.cn monitor API (the same endpoint that powers the
 * dashboard "usage" page) to read the two rolling-token windows:
 *   - unit 3  → 5-hour window  (short)
 *   - unit 6  → 7-day window   (long)
 *
 * Window mapping was verified against live API responses by inspecting
 * `nextResetTime` deltas: unit 3 resets every ~5h, unit 6 every ~7d.
 *
 * Auth: the same bigmodel API key used for model calls (the hex.hex key in
 * ~/.pi/agent/auth.json). Verified empirically that the quota endpoint
 * accepts a bare API key with no Bearer prefix and no org/project headers —
 * identical account data to the legacy web-token method. This removes the
 * need to keep a separate, expiring web dashboard token in sync.
 */

import type {
	ProviderAdapter,
	ProviderUsage,
	FetchResult,
} from "./provider.js";

export type { ProviderUsage, FetchResult } from "./provider.js";

// unit codes returned by the API — see file header for derivation
const UNIT_5H = 3;
const UNIT_7D = 6;

const ENDPOINT = "https://bigmodel.cn/api/monitor/usage/quota/limit";

interface ApiLimit {
	unit: number;
	percentage: number;
	nextResetTime?: number; // epoch ms; the API occasionally omits it
}

/** Epoch ms → ISO, or "" when absent/invalid. The HUD renders "" as an
 *  unknown reset (pace cursor hidden, "now" countdown) instead of throwing
 *  RangeError and failing the whole fetch. */
const toIso = (t?: number) =>
	typeof t === "number" && Number.isFinite(t) ? new Date(t).toISOString() : "";

async function fetchZhipuUsage(
	apiKey: string,
	timeoutMs = 10000,
): Promise<FetchResult> {
	let res: Response;
	try {
		res = await fetch(ENDPOINT, {
			headers: {
				// Bare API key — verified to work without Bearer prefix or
				// org/project headers. Returns identical account data.
				Authorization: apiKey,
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (e) {
		return { ok: false, reason: "network", message: String(e) };
	}

	if (res.status === 401 || res.status === 403) {
		return { ok: false, reason: "auth_failed", message: `HTTP ${res.status}` };
	}
	if (!res.ok) {
		return { ok: false, reason: "http_error", message: `HTTP ${res.status}` };
	}

	let json: {
		code?: number;
		data?: { limits?: ApiLimit[] };
	};
	try {
		json = (await res.json()) as typeof json;
	} catch (e) {
		return { ok: false, reason: "parse_error", message: String(e) };
	}

	// Some failure modes return HTTP 200 with a non-200 code body.
	if (typeof json.code === "number" && json.code !== 200) {
		return { ok: false, reason: "auth_failed", message: `code=${json.code}` };
	}
	if (!json.data?.limits) {
		return { ok: false, reason: "parse_error", message: "missing data.limits" };
	}

	const find = (unit: number) => json.data!.limits!.find((l) => l.unit === unit);
	const h = find(UNIT_5H);
	const d = find(UNIT_7D);

	const usage: ProviderUsage = {
		fiveHour: h
			? {
					usedPct: h.percentage,
					resetsAt: toIso(h.nextResetTime),
				}
			: null,
		sevenDay: d
			? {
					usedPct: d.percentage,
					resetsAt: toIso(d.nextResetTime),
				}
			: null,
		fetchedAt: new Date().toISOString(),
	};

	return { ok: true, usage };
}

/** ProviderAdapter registration for zhipu / bigmodel. */
export const zhipu: ProviderAdapter = {
	name: "zhipu",
	providerNames: ["zhipu", "zai-coding-cn", "zhipu-coding"],
	authKeys: ["zhipu", "zai-coding-cn", "zhipu-coding"],
	fetch: fetchZhipuUsage,
};
