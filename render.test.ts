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
  fg: (_color: string, text: string) => `\x1b[38;2;1;2;3m${text}\x1b[39m`,
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
  // The shape that crashed: stale + both windows + a " network" suffix.
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

// The cursor is a color tick, not a glyph: a color-distinguishing theme makes
// it observable. Bar cells are the runs of 10 single-glyph {color}X pairs.
const ctheme = { fg: (c: string, t: string) => `{${c}}${t}` };
const okLineC = (u: ProviderUsage, width = 80) =>
  renderHudLine(ctheme, { kind: "ok", usage: u }, width);
const barCellRuns = (line: string) => {
  const runs = line.match(/(?:\{\w+\}[█░]){10}/gu) ?? [];
  return runs.map((run) =>
    [...run.matchAll(/\{(\w+)\}([█░])/gu)].map((m) => ({
      color: m[1],
      ch: m[2],
    })),
  );
};

// Half-way through the window: the accent tick lands on cell 5 of 10 (the
// fill boundary when usage is also 50%, visibly right of the fill at 20%).
const midCells = barCellRuns(okLineC(atElapsed(20, 0.5)))[0] ?? [];
if (
  midCells.length !== 10 ||
  midCells[5].color !== "accent" ||
  midCells[5].ch !== "░" ||
  midCells.some((c, i) => i !== 5 && c.color === "accent")
) {
  throw new Error(
    `cursor misplaced at 50% elapsed: ${JSON.stringify(midCells)}`,
  );
}

// Window just started (<5% elapsed): cursor hidden.
if (okLineC(atElapsed(12, 0.03)).includes("{accent}")) {
  throw new Error("cursor shown at 3% elapsed");
}

// Reset already passed: cursor hidden (nothing left to pace).
if (okLineC(atElapsed(10, 1.2)).includes("{accent}")) {
  throw new Error("cursor shown past reset");
}

// Missing 5h window is hidden; the remaining 7d bar still gets a cursor.
const miss5: ProviderUsage = {
  fiveHour: null,
  sevenDay: {
    usedPct: 29,
    resetsAt: new Date(Date.now() + (1 - 0.5) * SEVEN_D).toISOString(),
  },
  fetchedAt: new Date().toISOString(),
};
const miss5Rendered = okLineC(miss5);
const missRuns = barCellRuns(miss5Rendered);
if (missRuns.length !== 1 || miss5Rendered.includes("5h")) {
  throw new Error(`missing window was rendered: ${JSON.stringify(miss5Rendered)}`);
}
if (!missRuns[0].some((c) => c.color === "accent" && c.ch === "░")) {
  throw new Error(
    `cursor missing on 7d window: ${JSON.stringify(missRuns[0])}`,
  );
}

// Fill past the cursor: the tick cell keeps the █ glyph, only recolored.
const overCells = barCellRuns(okLineC(atElapsed(70, 0.4)))[0] ?? [];
if (overCells[4]?.color !== "accent" || overCells[4]?.ch !== "█") {
  throw new Error(
    `in-fill cursor should be an accent █: ${JSON.stringify(overCells)}`,
  );
}

console.log(
  "ok — pace cursor: position, hide thresholds, missing window, in-fill",
);

// ─── Reset hourglass ────────────────────────────────────────────────────────
// Icon follows the remaining fraction of the window: full → half → nearly
// empty → empty (past reset / unknown window).
const FULL = "\u{f251}",
  HALF = "\u{f252}",
  EMPTY = "\u{f253}",
  DONE = "\u{f250}";
const iconOf = (u: ProviderUsage) => stripAnsi(okLine(u));
if (!iconOf(atElapsed(10, 0.1)).includes(FULL))
  throw new Error("expected full hourglass at 90% remaining");
if (!iconOf(atElapsed(10, 0.5)).includes(HALF))
  throw new Error("expected half hourglass at 50% remaining");
if (!iconOf(atElapsed(10, 0.9)).includes(EMPTY))
  throw new Error("expected empty hourglass at 10% remaining");
if (!iconOf(atElapsed(10, 1.2)).includes(DONE))
  throw new Error("expected empty hourglass past reset");
// Missing 5h window is hidden; its 7d window is half-way to reset.
const miss5Line = iconOf(miss5);
if (miss5Line.includes("5h") || miss5Line.includes(DONE) || !miss5Line.includes(HALF)) {
  throw new Error(`hourglass mismatch for missing window: ${miss5Line}`);
}

// Unknown/unparseable resetsAt (e.g. zhipu omitting nextResetTime) counts
// down "now" — never "NaNm" — and hides the pace cursor.
const unknownReset: ProviderUsage = {
  fiveHour: { usedPct: 12, resetsAt: "" },
  sevenDay: null,
  fetchedAt: new Date().toISOString(),
};
const unknownLine = okLineC(unknownReset);
if (unknownLine.includes("NaN") || !unknownLine.includes("now")) {
  throw new Error(`unknown reset should count down "now": ${unknownLine}`);
}
if (unknownLine.includes("{accent}")) {
  throw new Error(`cursor shown for unknown reset: ${unknownLine}`);
}

console.log(
  "ok — reset hourglass: full / half / nearly-empty / empty / missing",
);
