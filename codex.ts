/**
 * Codex subscription usage from the ChatGPT plan attached to pi's
 * `openai-codex` OAuth login.
 *
 * Only the main `rate_limit` is shown. Model-specific entries in
 * `additional_rate_limits` (for example Codex Spark) are intentionally ignored.
 */

import { getJson } from "./provider.js";
import type {
	FetchResult,
	ProviderAdapter,
	WindowUsage,
} from "./provider.js";

const ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const FIVE_H_SECONDS = 5 * 3600;
const SEVEN_D_SECONDS = 7 * 24 * 3600;
const ACCOUNT_CLAIM = "https://api.openai.com/auth";

interface RateLimitWindow {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_at?: number;
}

interface RateLimit {
	primary_window?: RateLimitWindow | null;
	secondary_window?: RateLimitWindow | null;
}

function accountId(token: string): string | null {
	try {
		const payload = token.split(".")[1];
		if (!payload) return null;
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		const id = claims?.[ACCOUNT_CLAIM]?.chatgpt_account_id;
		return typeof id === "string" && id ? id : null;
	} catch {
		return null;
	}
}

function normalizeWindow(window: RateLimitWindow | null | undefined): WindowUsage | null {
	if (!window || !Number.isFinite(window.used_percent)) return null;
	const reset = window.reset_at;
	const seconds = window.limit_window_seconds;
	return {
		usedPct: Math.min(100, Math.max(0, window.used_percent!)),
		resetsAt:
			typeof reset === "number" && Number.isFinite(reset)
				? new Date(reset * 1000).toISOString()
				: "",
		windowMs:
			typeof seconds === "number" && Number.isFinite(seconds)
				? seconds * 1000
				: undefined,
	};
}

export async function fetchCodexUsage(
	accessToken: string,
	timeoutMs = 10000,
): Promise<FetchResult> {
	const account = accountId(accessToken);
	if (!account) {
		return { ok: false, reason: "auth_failed", message: "missing account ID" };
	}

	const res = await getJson(
		ENDPOINT,
		{
			Authorization: `Bearer ${accessToken}`,
			"ChatGPT-Account-Id": account,
			Accept: "application/json",
		},
		timeoutMs,
	);
	if (!res.ok) return res;

	const json = res.json as { rate_limit?: RateLimit | null };
	if (!json.rate_limit) {
		return { ok: false, reason: "parse_error", message: "missing rate_limit" };
	}

	const windows = [
		json.rate_limit.primary_window,
		json.rate_limit.secondary_window,
	];
	const fiveHour = normalizeWindow(
		windows.find((window) => window?.limit_window_seconds === FIVE_H_SECONDS),
	);
	const sevenDay = normalizeWindow(
		windows.find((window) => window?.limit_window_seconds === SEVEN_D_SECONDS),
	);
	if (!fiveHour && !sevenDay) {
		return {
			ok: false,
			reason: "parse_error",
			message: "no recognized Codex windows",
		};
	}

	return {
		ok: true,
		usage: {
			fiveHour,
			sevenDay,
			fetchedAt: new Date().toISOString(),
		},
	};
}

export const codex: ProviderAdapter = {
	name: "codex",
	providerNames: ["openai-codex"],
	authKeys: ["openai-codex"],
	fetch: fetchCodexUsage,
};
