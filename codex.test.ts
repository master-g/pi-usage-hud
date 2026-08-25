import { fetchCodexUsage } from "./codex.js";
import { renderHudLine } from "./render.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const payload = Buffer.from(
	JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "acct-test" },
	}),
).toString("base64url");
const token = `header.${payload}.signature`;
const now = Date.now();
let responseBody: unknown = {
	rate_limit: {
		// Slots are intentionally reversed: classification must use duration.
		primary_window: {
			used_percent: 34,
			limit_window_seconds: 7 * 24 * 3600,
			reset_at: Math.floor((now + 3.5 * 24 * 3600_000) / 1000),
		},
		secondary_window: {
			used_percent: 20,
			limit_window_seconds: 5 * 3600,
			reset_at: Math.floor((now + 2.5 * 3600_000) / 1000),
		},
	},
	additional_rate_limits: [
		{
			limit_name: "GPT-5.3-Codex-Spark",
			rate_limit: {
				primary_window: {
					used_percent: 99,
					limit_window_seconds: 5 * 3600,
					reset_at: Math.floor((now + 3600_000) / 1000),
				},
			},
		},
	],
};

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (
	_input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
) => {
	const headers = new Headers(init?.headers);
	assert(headers.get("authorization") === `Bearer ${token}`, "missing bearer token");
	assert(
		headers.get("chatgpt-account-id") === "acct-test",
		"missing ChatGPT account header",
	);
	return new Response(JSON.stringify(responseBody), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}) as typeof fetch;

try {
	const result = await fetchCodexUsage(token);
	assert(result.ok, `expected success: ${JSON.stringify(result)}`);
	assert(result.usage.fiveHour?.usedPct === 20, "5h window misclassified");
	assert(result.usage.sevenDay?.usedPct === 34, "7d window misclassified");
	assert(
		result.usage.fiveHour?.resetsAt ===
			new Date(Math.floor((now + 2.5 * 3600_000) / 1000) * 1000).toISOString(),
		"5h reset mismatch",
	);

	const line = renderHudLine(
		{ fg: (color: string, text: string) => `{${color}}${text}` },
		{ kind: "ok", usage: result.usage },
		80,
	);
	assert(line.includes("{accent}"), "Codex usage lacks expected-usage marker");
	assert(!line.includes("99%"), "Spark usage leaked into Codex HUD");

	responseBody = {
		rate_limit: {
			primary_window: {
				used_percent: 12,
				limit_window_seconds: 3600,
				reset_at: Math.floor((now + 1800_000) / 1000),
			},
		},
	};
	const unknown = await fetchCodexUsage(token);
	assert(!unknown.ok && unknown.reason === "parse_error", "schema drift must fail explicitly");
} finally {
	globalThis.fetch = originalFetch;
}

console.log("ok — Codex main quota, duration mapping, pace marker, Spark ignored");
