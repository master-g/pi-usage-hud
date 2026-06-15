/**
 * Snapshot file + cooldown.
 *
 * A single JSON file per provider (shared across all pi sessions so we never
 * hammer the API). The fetcher checks `updatedAt` and skips the network call
 * if the last success is within the cooldown window. On error we preserve the
 * last-good usage so the HUD never blanks out.
 *
 * Snapshots are provider-namespaced: each provider writes its own
 * `~/.pi/agent/<provider>-quota.json`, so switching providers (and back) keeps
 * each one's last-good data instead of clobbering it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProviderUsage } from "./provider.js";

const DEFAULT_COOLDOWN_SEC = 60;

export function cooldownMs(): number {
	const override = process.env.USAGE_HUD_COOLDOWN_SECONDS;
	if (override !== undefined && override !== "") {
		const n = Number(override);
		if (Number.isFinite(n)) return n * 1000;
	}
	return DEFAULT_COOLDOWN_SEC * 1000;
}

/**
 * Resolve the snapshot path for a provider. Defaults to a provider-namespaced
 * file under ~/.pi/agent/; `USAGE_HUD_SNAPSHOT_PATH` overrides ALL providers
 * (useful for debugging — forces a single shared file).
 */
export function snapshotPath(provider: string): string {
	const override = process.env.USAGE_HUD_SNAPSHOT_PATH;
	return override
		? override.replace(/^~/, os.homedir())
		: path.join(os.homedir(), ".pi", "agent", `${provider}-quota.json`);
}

interface Snapshot {
	usage?: ProviderUsage | null;
	updatedAt?: string;
	error?: string;
	errorReason?: string;
	errorAt?: string;
}

/** Read the current snapshot (last-good usage + last error). Safe to any fs error. */
export function getStored(provider: string): Snapshot {
	try {
		const raw = fs.readFileSync(snapshotPath(provider), "utf8");
		return JSON.parse(raw) as Snapshot;
	} catch {
		return {};
	}
}

/** Atomic write: tmp-per-pid then rename. Survives concurrent sessions. */
function writeSnapshot(provider: string, out: Snapshot): void {
	const file = snapshotPath(provider);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
	} catch {
		// ignore — likely already exists
	}
	const tmp = `${file}.tmp.${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(out, null, 2), "utf8");
	fs.renameSync(tmp, file);
}

/** True if the last successful fetch is older than the cooldown (or absent). */
export function shouldFetch(provider: string): boolean {
	const snap = getStored(provider);
	if (!snap.updatedAt) return true;
	return Date.now() - new Date(snap.updatedAt).getTime() >= cooldownMs();
}

export function writeSuccess(provider: string, usage: ProviderUsage): void {
	const snap = getStored(provider);
	writeSnapshot(provider, {
		...snap,
		usage,
		updatedAt: usage.fetchedAt,
		// keep last error record but it's no longer current
	});
}

export function writeError(
	provider: string,
	reason: string,
	message?: string,
): void {
	const snap = getStored(provider);
	writeSnapshot(provider, {
		...snap,
		error: message ?? reason,
		errorReason: reason,
		errorAt: new Date().toISOString(),
	});
}
