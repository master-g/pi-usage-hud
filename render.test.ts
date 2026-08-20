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
  const inHours = (h: number) =>
    new Date(Date.now() + h * 3600_000).toISOString();
  return {
    fiveHour:
      fivePct === null ? null : { usedPct: fivePct, resetsAt: inHours(1.65) },
    sevenDay:
      sevenPct === null ? null : { usedPct: sevenPct, resetsAt: inHours(120) },
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
  {
    kind: "no_creds",
    providerName: "kimi",
    hint: "未找到 kimi API key（见 ~/.pi/agent/auth.json 的 kimi-coding / moonshot）",
  },
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
if (visibleWidth(crashed) > 53)
  throw new Error("regression case still overflows");
// Percentages survive the degradation — they are the reason the HUD exists.
if (!crashed.includes("7%") || !crashed.includes("29%")) {
  throw new Error(
    `degraded line dropped the percentages: ${JSON.stringify(crashed)}`,
  );
}

console.log(`ok — ${checked} width/status combinations fit`);
console.log(`53-col stale line (${visibleWidth(crashed)} cols): ${crashed}`);

// ─── Pace cursor ────────────────────────────────────────────────────────────
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const FIVE_H = 5 * 3600_000;
const SEVEN_D = 7 * 24 * 3600_000;
/** Usage whose 5h window is `elapsed` fraction through (7d absent). */
const atElapsed = (pct: number, elapsed: number): ProviderUsage => ({
  fiveHour: {
    usedPct: pct,
    resetsAt: new Date(Date.now() + (1 - elapsed) * FIVE_H).toISOString(),
  },
  sevenDay: null,
  fetchedAt: new Date().toISOString(),
});
const okLine = (u: ProviderUsage, width = 80) =>
  renderHudLine(theme, { kind: "ok", usage: u }, width);
const firstBar = (line: string) => stripAnsi(line).match(/[█░▎]+/)?.[0] ?? "";

// Half-way through the window: cursor lands on cell 5 of 10 (the fill boundary
// when usage is also 50%, and visibly right of the fill at 20%).
const mid = firstBar(okLine(atElapsed(20, 0.5)));
if (mid.length !== 10 || mid.indexOf("▎") !== 5) {
  throw new Error(`cursor misplaced at 50% elapsed: ${JSON.stringify(mid)}`);
}

// Window just started (<5% elapsed): cursor hidden, bar identical to before.
const early = okLine(atElapsed(12, 0.03));
if (stripAnsi(early).includes("▎"))
  throw new Error("cursor shown at 3% elapsed");

// Reset already passed: cursor hidden (nothing left to pace).
const past = okLine(atElapsed(10, 1.2));
if (stripAnsi(past).includes("▎")) throw new Error("cursor shown past reset");

// Missing 5h window: no cursor on its bar, but the 7d bar still gets one.
const miss5: ProviderUsage = {
  fiveHour: null,
  sevenDay: {
    usedPct: 29,
    resetsAt: new Date(Date.now() + (1 - 0.5) * SEVEN_D).toISOString(),
  },
  fetchedAt: new Date().toISOString(),
};
const bars = stripAnsi(okLine(miss5)).match(/[█░▎]+/g) ?? [];
if (bars.length !== 2)
  throw new Error(`expected 2 bars, got: ${JSON.stringify(bars)}`);
if (bars[0].includes("▎"))
  throw new Error(`cursor on missing 5h window: ${bars[0]}`);
if (!bars[1].includes("▎"))
  throw new Error(`cursor missing on 7d window: ${bars[1]}`);

// Fill past the cursor: the cursor cell renders as a dim █, not ▎.
// (A color-distinguishing theme; width contract is covered above.)
const ctheme = { fg: (c: string, t: string) => `{${c}}${t}` };
const over = renderHudLine(
  ctheme,
  { kind: "ok", usage: atElapsed(70, 0.4) },
  80,
);
if (over.includes("▎"))
  throw new Error("in-fill cursor should render as dim █");
if (!over.includes("{dim}█")) {
  throw new Error(`in-fill cursor cell not dimmed: ${JSON.stringify(over)}`);
}

console.log(
  "ok — pace cursor: position, hide thresholds, missing window, in-fill",
);
