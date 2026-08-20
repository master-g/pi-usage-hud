/**
 * Progress-bar + HUD line rendering.
 *
 * pi-tui has no built-in gauge component, so we draw with Unicode block
 * characters (█ filled / ░ empty) and color by usage threshold via theme.fg.
 *
 * Colors (used%):
 *   < 70  → success (green)
 *   < 90  → warning (yellow)
 *   >= 90 → error   (red)
 *
 * The line shape:
 *   Usage  5h █░░░░░░░░ 1% ⴵ 1h24m  ·  7d █░░░░░░░░ 4% ⴵ 2d7h
 *
 * Pace cursor: one bar cell marks where usage would sit under uniform
 * consumption (elapsed fraction of the window). Fill left of it = 富余, fill
 * past it = 偏快. Zero width cost — it replaces a cell instead of adding one:
 * ▎ (dim) in the unfilled region, dim █ once the fill has passed it. Hidden
 * when the window just started (<5% elapsed, pace is noise there) or the
 * reset time is unknown/unparseable/already past.
 *
 * Width contract: pi-tui's `doRender` throws (and kills the process) when any
 * rendered line is wider than the terminal, so every string returned from here
 * MUST fit the `width` passed in. We can't import pi-tui's visibleWidth /
 * truncateToWidth — extensions live outside the pi package's module scope — so
 * widths are computed from the plain text we build ourselves, before coloring.
 */

import type { ProviderUsage, WindowUsage } from "./provider.js";

const BAR_WIDTH = 10;
/** Below this a gauge can't tell 7% from 29%, so we drop it instead. */
const MIN_BAR_WIDTH = 4;

type Theme = { fg(color: string, text: string): string };

export type HudStatus =
 | { kind: "ok"; usage: ProviderUsage }
 | { kind: "no_creds"; providerName: string; hint: string }
 | { kind: "stale"; usage: ProviderUsage | null; reason: string };

/**
 * Terminal columns for one character. The glyphs this HUD draws are all
 * single-column in pi-tui's measurement; anything else (CJK hints, emoji)
 * counts as 2 — over-estimating only truncates earlier, never overflows.
 */
const NARROW_GLYPHS = new Set(["█", "░", "▎", "ⴵ", "·", "⚠"]);
function charWidth(ch: string): number {
 const cp = ch.codePointAt(0);
 if (cp !== undefined && cp < 0x80) return 1;
 return NARROW_GLYPHS.has(ch) ? 1 : 2;
}

function plainWidth(text: string): number {
 let w = 0;
 for (const ch of text) w += charWidth(ch);
 return w;
}

/** Hard-truncate uncolored text to `width` columns. No ellipsis: a "…" of
 *  uncertain width is exactly what would re-trip the overflow assertion. */
function truncatePlain(text: string, width: number): string {
 let out = "";
 let w = 0;
 for (const ch of text) {
  const cw = charWidth(ch);
  if (w + cw > width) break;
  out += ch;
  w += cw;
 }
 return out;
}

function pctColor(pct: number): string {
 if (pct >= 90) return "error";
 if (pct >= 70) return "warning";
 return "success";
}

/** Window durations by label, used to place the pace cursor. */
const WINDOW_MS: Record<string, number> = {
 "5h": 5 * 3600_000,
 "7d": 7 * 24 * 3600_000,
};

/**
 * Bar cell where usage would sit under uniform consumption, or -1 to hide
 * the cursor: missing window, unparseable reset, window just started (<5%
 * elapsed — pace is noise there), or reset at/past now (nothing left to
 * pace). A reset further out than the window length clamps to 0 and hides.
 */
function paceMarker(
 label: string,
 win: WindowUsage | null,
 barWidth: number,
): number {
 const windowMs = WINDOW_MS[label];
 if (!win || !windowMs || barWidth <= 0) return -1;
 const resetMs = new Date(win.resetsAt).getTime();
 if (Number.isNaN(resetMs)) return -1;
 const elapsed = 1 - (resetMs - Date.now()) / windowMs;
 if (elapsed < 0.05 || elapsed >= 1) return -1;
 return Math.min(barWidth - 1, Math.round(elapsed * barWidth));
}

/** One bar cell: glyph + whether it takes the pct color or dim (cursor). */
type BarCell = { ch: string; dim: boolean };

function barCells(pct: number, width: number, marker: number): BarCell[] {
 const clamped = Math.max(0, Math.min(100, pct));
 let filled = Math.round((clamped / 100) * width);
 // Any non-zero usage shows at least one cell so the bar isn't misleadingly empty.
 if (clamped > 0 && filled === 0) filled = 1;
 const cells: BarCell[] = [];
 for (let i = 0; i < width; i++) {
  if (i === marker) cells.push({ ch: i < filled ? "█" : "▎", dim: true });
  else cells.push({ ch: i < filled ? "█" : "░", dim: false });
 }
 return cells;
}

/**
 * Compact reset countdown: "45m" / "1h24m" / "1d19h" / "now".
 * ≥1d drops the minutes column for compactness ("1d19h", not "1d19h3m");
 * trailing zero components are omitted ("2h" / "1d", not "2h0m" / "1d0h").
 */
function resetCountdown(iso: string): string {
 const ms = new Date(iso).getTime() - Date.now();
 if (ms <= 0) return "now";
 // Round to whole minutes; never show "0m" when time remains.
 let totalMin = Math.round(ms / 60_000);
 if (totalMin < 1) totalMin = 1;
 const days = Math.floor(totalMin / 1440);
 const hours = Math.floor((totalMin % 1440) / 60);
 const mins = totalMin % 60;
 // ≥1d: days + hours only, minutes dropped. Trailing zero hours omitted.
 if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
 // <1d: hours + minutes. Trailing zero minutes omitted.
 if (hours > 0) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
 return `${mins}m`;
}

/** A colored fragment plus the terminal columns it occupies. */
type Segment = { width: number; text: string };

function windowSegment(
 theme: Theme,
 label: string,
 win: WindowUsage | null,
 barWidth: number,
 showReset: boolean,
): Segment {
 const usedPct = win?.usedPct ?? 0;
 const color = pctColor(usedPct);
 const pct = `${Math.round(usedPct)}%`;
 const parts = [theme.fg("dim", label)];
 let width = label.length;
 if (barWidth > 0) {
  const cells = barCells(usedPct, barWidth, paceMarker(label, win, barWidth))
   .map((c) => theme.fg(c.dim ? "dim" : color, c.ch))
   .join("");
  parts.push(cells);
  width += 1 + barWidth;
 }
 parts.push(theme.fg(color, pct));
 width += 1 + pct.length;
 if (showReset) {
  // Missing windows count down from "now" → displays "now".
  const reset = `ⴵ ${resetCountdown(win?.resetsAt ?? new Date().toISOString())}`;
  parts.push(theme.fg("dim", reset));
  width += 1 + reset.length;
 }
 return { width, text: parts.join(" ") };
}

function windowOf(w: ProviderUsage["fiveHour"]): {
 pct: number;
 resetsAt: string;
} {
 return {
  pct: w?.usedPct ?? 0,
  resetsAt: w?.resetsAt ?? new Date().toISOString(),
 };
}

/**
 * Render the HUD as a single themed line that fits `width` terminal columns.
 *
 * When the full shape doesn't fit, the line degrades in place: shorter bars
 * first, then the reset countdowns, then the bars altogether. The percentages
 * are the payload, so they are the last thing to go.
 */
export function renderHudLine(
 theme: Theme,
 status: HudStatus,
 width: number,
): string {
 if (width <= 0) return "";

 if (status.kind === "no_creds") {
  return theme.fg("warning", truncatePlain(`Usage — ${status.hint}`, width));
 }

 const usage = status.usage;
 const warn = status.kind === "stale" ? `  ⚠ ${status.reason}` : "";

 if (!usage) {
  return theme.fg(
   "dim",
   truncatePlain(`Usage （等待用量数据…）${warn}`, width),
  );
 }
 if (!usage.fiveHour && !usage.sevenDay) {
  return theme.fg("dim", truncatePlain(`Usage （暂无用量窗口）${warn}`, width));
 }

 const head = "Usage ";
 const sep = "  ·  ";
 const five = windowOf(usage.fiveHour);
 const seven = windowOf(usage.sevenDay);
 const fixed = head.length + sep.length + plainWidth(warn);

 for (const showReset of [true, false]) {
  const bare5 = windowSegment(theme, "5h", usage.fiveHour, 0, showReset);
  const bare7 = windowSegment(theme, "7d", usage.sevenDay, 0, showReset);
  const base = fixed + bare5.width + bare7.width;
  if (base > width) continue;
  // Both windows get the same bar, and each bar costs a leading space too.
  const room = Math.floor((width - base - 2) / 2);
  const barWidth = room >= MIN_BAR_WIDTH ? Math.min(BAR_WIDTH, room) : 0;
  const s5 =
   barWidth > 0
    ? windowSegment(theme, "5h", usage.fiveHour, barWidth, showReset)
    : bare5;
  const s7 =
   barWidth > 0
    ? windowSegment(theme, "7d", usage.sevenDay, barWidth, showReset)
    : bare7;
  return (
   theme.fg("dim", head) +
   s5.text +
   theme.fg("dim", sep) +
   s7.text +
   (warn ? theme.fg("dim", warn) : "")
  );
 }

 // Narrower than even the barless form (~22 columns): drop the styling and
 // keep whatever numbers fit.
 return theme.fg(
  "dim",
  truncatePlain(
   `5h ${Math.round(five.pct)}% · 7d ${Math.round(seven.pct)}%`,
   width,
  ),
 );
}
