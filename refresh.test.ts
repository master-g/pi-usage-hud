/**
 * refreshUsage pipeline + statusFromSnapshot, tested through the UsageStore
 * seam with an in-memory adapter — no fs, no network, no pi process.
 */

import {
	refreshUsage,
	statusFromSnapshot,
	type UsageStore,
} from "./refresh.js";
import type {
	FetchResult,
	ProviderAdapter,
	ProviderUsage,
} from "./provider.js";
import type { Snapshot } from "./store.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const FIVE_H = 5 * 3600_000;

function makeUsage(pct = 7): ProviderUsage {
	return {
		fiveHour: {
			usedPct: pct,
			resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
			windowMs: FIVE_H,
		},
		sevenDay: null,
		fetchedAt: new Date().toISOString(),
	};
}

/** In-memory UsageStore with a controllable cooldown flag and a call log. */
function memStore(initial: Snapshot = {}, due = true) {
	let snap = initial;
	const calls: string[] = [];
	const store: UsageStore = {
		getStored: () => snap,
		shouldFetch: () => due,
		writeSuccess: (_provider, usage) => {
			calls.push("writeSuccess");
			snap = { ...snap, usage, updatedAt: usage.fetchedAt };
		},
		writeError: (_provider, reason, message) => {
			calls.push(`writeError:${reason}`);
			snap = {
				...snap,
				error: message ?? reason,
				errorReason: reason,
				errorAt: new Date().toISOString(),
			};
		},
	};
	return { store, calls, snap: () => snap };
}

/** Adapter whose fetch returns a canned result (or throws) and counts calls. */
function fakeAdapter(result: FetchResult | (() => FetchResult)) {
	let fetches = 0;
	const adapter: ProviderAdapter = {
		name: "fake",
		providerNames: ["fake"],
		authKeys: ["fake"],
		fetch: async () => {
			fetches++;
			return typeof result === "function" ? result() : result;
		},
	};
	return { adapter, fetches: () => fetches };
}

const okCred = async () => "key";
const noCred = async () => null;
const throwCred = async () => {
	throw new Error("oauth refresh broken");
};

// Cooldown: fetch skipped, nothing written, status read back from the store.
{
	const { adapter, fetches } = fakeAdapter({ ok: true, usage: makeUsage() });
	const m = memStore({}, false);
	const r = await refreshUsage(adapter, true, okCred, { store: m.store });
	assert(r.outcome === "cooldown", `expected cooldown, got ${r.outcome}`);
	assert(fetches() === 0, "fetch ran during cooldown");
	assert(m.calls.length === 0, `cooldown wrote: ${m.calls}`);
}

// force bypasses the cooldown (the /usage-hud command path).
{
	const { adapter, fetches } = fakeAdapter({ ok: true, usage: makeUsage() });
	const m = memStore({}, false);
	const r = await refreshUsage(adapter, true, okCred, {
		store: m.store,
		force: true,
	});
	assert(r.outcome === "fetched" && fetches() === 1, "force did not fetch");
	assert(m.calls.includes("writeSuccess"), "forced fetch not persisted");
	assert(r.status.kind === "ok", `forced status: ${r.status.kind}`);
}

// No credential: no fetch, no writes, no_creds display.
{
	const { adapter, fetches } = fakeAdapter({ ok: true, usage: makeUsage() });
	const m = memStore();
	const r = await refreshUsage(adapter, false, noCred, { store: m.store });
	assert(r.outcome === "no_credential", `expected no_credential, got ${r.outcome}`);
	assert(fetches() === 0 && m.calls.length === 0, "no_credential touched store/network");
	assert(r.status.kind === "no_creds", `status: ${r.status.kind}`);
}

// Credential resolution throwing is recorded as auth_failed, never thrown.
{
	const { adapter } = fakeAdapter({ ok: true, usage: makeUsage() });
	const m = memStore();
	const r = await refreshUsage(adapter, true, throwCred, { store: m.store });
	assert(r.outcome === "failed" && r.reason === "auth_failed", `outcome: ${r.outcome}/${r.reason}`);
	assert(m.calls.includes("writeError:auth_failed"), "auth failure not recorded");
	assert(r.status.kind === "stale", `status: ${r.status.kind}`);
}

// Fetch failure preserves last-good usage in the snapshot.
{
	const good = makeUsage();
	const { adapter } = fakeAdapter({ ok: false, reason: "http_error", message: "HTTP 500" });
	const m = memStore({ usage: good, updatedAt: good.fetchedAt });
	const r = await refreshUsage(adapter, true, okCred, { store: m.store });
	assert(r.outcome === "failed" && r.reason === "http_error", `outcome: ${r.outcome}`);
	assert(m.snap().usage === good, "last-good usage clobbered by the error");
	assert(m.calls.includes("writeError:http_error"), "error not recorded");
}

// adapter.fetch throwing maps to network (e.g. undici failures).
{
	const { adapter } = fakeAdapter(() => {
		throw new Error("socket hangup");
	});
	const m = memStore();
	const r = await refreshUsage(adapter, true, okCred, { store: m.store });
	assert(r.outcome === "failed" && r.reason === "network", `outcome: ${r.outcome}/${r.reason}`);
}

console.log("ok — refreshUsage: cooldown, force, no_credential, auth_failed, error preservation, network");

// ─── statusFromSnapshot (pure; `now` injected) ─────────────────────────────
const { adapter } = fakeAdapter({ ok: true, usage: makeUsage() });
const usage = makeUsage();
const now = Date.now();
const fresh = { usage, updatedAt: new Date(now - 30_000).toISOString() };
const old = { usage, updatedAt: new Date(now - 3 * 60_000).toISOString() };

assert(statusFromSnapshot(fresh, true, adapter, now).kind === "ok", "fresh usage → ok");
assert(
	statusFromSnapshot({ ...fresh, error: "x", errorReason: "network" }, true, adapter, now).kind === "ok",
	"fresh usage + old error → still ok",
);
const stale = statusFromSnapshot({ ...old, error: "x", errorReason: "network" }, true, adapter, now);
assert(
	stale.kind === "stale" && stale.usage === usage && stale.reason === "network",
	"stale-age usage + error → stale with usage",
);
assert(statusFromSnapshot(old, true, adapter, now).kind === "ok", "old usage without error → ok");
const errOnly = statusFromSnapshot({ error: "x", errorReason: "parse_error" }, true, adapter, now);
assert(
	errOnly.kind === "stale" && errOnly.usage === null && errOnly.reason === "parse_error",
	"error without usage → stale null",
);
const pending = statusFromSnapshot({}, true, adapter, now);
assert(pending.kind === "stale" && pending.reason === "pending", "empty snapshot → pending");
const noCreds = statusFromSnapshot({}, false, adapter, now);
assert(noCreds.kind === "no_creds" && noCreds.hint.includes("fake"), "no creds → no_creds with hint");

console.log("ok — statusFromSnapshot: ok/stale/pending/no_creds, staleness by age + error");
