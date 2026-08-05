/**
 * Width contract check: every line renderHudLine returns must fit the width it
 * was given, measured with pi-tui's own visibleWidth — a wider line makes
 * pi-tui's doRender throw and takes the whole process down.
 *
 * pi-tui is not resolvable from the extension directory, so it is imported by
 * absolute path here. Run:  bun run render.test.ts
 */

import { renderHudLine, type HudStatus } from "./render.js";
import type { ProviderUsage } from "./provider.js";

const { visibleWidth } = (await import(
  `${process.env.HOME}/.bun/install/global/node_modules/@earendil-works/pi-tui/dist/utils.js`
)) as { visibleWidth(s: string): number };

const theme = {
  fg: (color: string, text: string) => `\x1b[38;2;1;2;3m${text}\x1b[39m`,
};

function usage(fivePct: number | null, sevenPct: number | null): ProviderUsage {
  const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  return {
    fiveHour: fivePct === null ? null : { usedPct: fivePct, resetsAt: inHours(1.65) },
    sevenDay: sevenPct === null ? null : { usedPct: sevenPct, resetsAt: inHours(120) },
    fetchedAt: new Date().toISOString(),
  };
}

const statuses: HudStatus[] = [
  { kind: "ok", usage: usage(7, 29) },
  { kind: "ok", usage: usage(0, 0) },
  { kind: "ok", usage: usage(100, 100) },
  { kind: "ok", usage: usage(null, 29) },
  { kind: "ok", usage: usage(null, null) },
  // The shape that crashed: stale + both windows + a "⚠ network" suffix.
  { kind: "stale", usage: usage(7, 29), reason: "network" },
  { kind: "stale", usage: null, reason: "pending" },
  { kind: "no_creds", providerName: "kimi", hint: "未找到 kimi API key（见 ~/.pi/agent/auth.json 的 kimi-coding / moonshot）" },
];

let checked = 0;
for (const status of statuses) {
  for (let width = 0; width <= 120; width++) {
    const line = renderHudLine(theme, status, width);
    const w = visibleWidth(line);
    if (w > width) {
      throw new Error(
        `overflow: ${status.kind} at width ${width} rendered ${w} cols: ${JSON.stringify(line)}`,
      );
    }
    checked++;
  }
}

// The regression itself: 53 columns, stale + network warning (was 68 cols).
const crashed = renderHudLine(
  theme,
  { kind: "stale", usage: usage(7, 29), reason: "network" },
  53,
);
if (visibleWidth(crashed) > 53) throw new Error("regression case still overflows");
// Percentages survive the degradation — they are the reason the HUD exists.
if (!crashed.includes("7%") || !crashed.includes("29%")) {
  throw new Error(`degraded line dropped the percentages: ${JSON.stringify(crashed)}`);
}

console.log(`ok — ${checked} width/status combinations fit`);
console.log(`53-col stale line (${visibleWidth(crashed)} cols): ${crashed}`);
