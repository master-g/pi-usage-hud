/**
 * Kimi Code subscription usage — rolling windows.
 *
 *   GET https://api.kimi.com/coding/v1/usages
 *   Authorization: Bearer <sk-kimi API key>
 *
 * Auth uses the same API key as model calls (auth.json `kimi-coding` key).
 * The response explicitly echoes `authentication.method: "METHOD_API_KEY"`,
 * confirming this endpoint is designed to accept API keys — no need for the
 * separate, expiring 30-day web session JWT the old Connect-RPC path relied on.
 *
 * Two independent quota systems exist in Kimi (known UX confusion, see
 * MoonshotAI/kimi-cli#2150):
 *   - Kimi Code (subscription, 5h/7d windows) ← THIS endpoint, what the HUD wants
 *   - Kimi Open Platform (pay-per-token balance at api.moonshot.ai)
 * The sk-kimi key only works against api.kimi.com (returns 401 at moonshot.ai).
 *
 * Response shape (numeric fields arrive as strings):
 *   {
 *     "usage": { limit, used, remaining, resetTime },        // 7-day window
 *     "limits": [ { window: { duration, timeUnit },          // 5h = duration 300 + TIME_UNIT_MINUTE
 *                   detail: { limit, remaining, resetTime } } ],
 *     "totalQuota": { ... }   // total purchased quota, NOT a rolling window → ignored
 *   }
 *
 * Window derivation (verified against live resetTime deltas):
 *   - top-level `usage`                       → resets in ~4-7d → seven_day
 *   - `limits[i]` with window.duration ≈ 300  → resets in ~5h  → five_hour
 * We match the 5h window by its declared duration rather than by array index,
 * so ordering changes in the API response don't break us.
 */

import { getJson } from "./provider.js";
import type {
	ProviderAdapter,
	ProviderUsage,
	FetchResult,
} from "./provider.js";

const ENDPOINT = "https://api.kimi.com/coding/v1/usages";

/** The product windows kimi data is normalized into (see file header). */
const FIVE_H_MS = 5 * 3600_000;
const SEVEN_D_MS = 7 * 24 * 3600_000;

/** used/limit → 0..100 (rounded). Returns null when either is missing/invalid. */
function pct(
	used: string | undefined,
	limit: string | undefined,
): number | null {
	const u = Number(used);
	const l = Number(limit);
	if (!Number.isFinite(u) || !Number.isFinite(l) || l <= 0) return null;
	return Math.min(100, Math.max(0, Math.round((u / l) * 100)));
}

async function fetchKimiUsage(
	apiKey: string,
	timeoutMs = 10000,
): Promise<FetchResult> {
	const res = await getJson(
		ENDPOINT,
		{ Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		timeoutMs,
	);
	if (!res.ok) return res;

	const json = res.json as {
		usage?: {
			limit?: string;
			used?: string;
			remaining?: string;
			resetTime?: string;
		};
		limits?: Array<{
			window?: { duration?: number; timeUnit?: string };
			detail?: { limit?: string; remaining?: string; resetTime?: string };
		}>;
	};

	// 7-day window: top-level `usage`.
	const seven = json.usage;
	const sevenDayPct = pct(seven?.used, seven?.limit);

	// 5-hour window: the entry in `limits` whose declared duration is ~300 min.
	const five = json.limits?.find(
		(l) => l.window?.duration != null && l.window.duration >= 250,
	)?.detail;
	// The 5h detail only exposes `remaining`, so derive used = limit - remaining.
	const fiveHourPct =
		five?.limit != null && five?.remaining != null
			? pct(String(Number(five.limit) - Number(five.remaining)), five.limit)
			: null;

	const usage: ProviderUsage = {
		fiveHour:
			fiveHourPct !== null
				? {
						usedPct: fiveHourPct,
						resetsAt: five?.resetTime ?? "",
						windowMs: FIVE_H_MS,
					}
				: null,
		sevenDay:
			sevenDayPct !== null
				? {
						usedPct: sevenDayPct,
						resetsAt: seven?.resetTime ?? "",
						windowMs: SEVEN_D_MS,
					}
				: null,
		fetchedAt: new Date().toISOString(),
	};

	return { ok: true, usage };
}

/** ProviderAdapter registration for kimi / moonshot code. */
export const kimi: ProviderAdapter = {
	name: "kimi",
	providerNames: ["kimi-coding", "kimi", "moonshot"],
	authKeys: ["kimi-coding", "kimi", "moonshot"],
	fetch: fetchKimiUsage,
};
