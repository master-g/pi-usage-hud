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
 *   Usage  5h █░░░░░░░░ 1%  1h24m  ·  7d █░░░░░░░░ 4%  2d7h
 *
 * Pace cursor: the marker cell is tinted with the theme's accent color AND
 * drawn as ▎ when unfilled (█ once the fill reaches it), so it stays
 * recognizable by shape even in themes where accent ≈ the fill color.
 * Fill left of it = 富余, fill past it = 偏快. Zero width cost — it replaces
 * a cell instead of adding one. Hidden when the window length is unknown
 * (pre-windowMs snapshots), the window just started (<5% elapsed, pace is
 * noise there) or the reset time is unknown/unparseable/already past.
 *
 * The countdown icon is an hourglass showing the remaining fraction of the
 * window:  full (just reset) →  half →  nearly empty →  empty
 * (reset due now).
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
const NARROW_GLYPHS = new Set(["█", "░", "▎", "", "", "", "", "·", ""]);
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

/**
 * Bar cell where usage would sit under uniform consumption, or -1 to hide
 * the cursor: unknown window length (pre-windowMs snapshots), unparseable
 * reset, window just started (<5% elapsed — pace is noise there), or reset
 * at/past now (nothing left to pace). A reset further out than the window
 * length clamps to 0 and hides.
 */
function paceMarker(win: WindowUsage | null, barWidth: number): number {
 const windowMs = win?.windowMs;
 if (!win || !windowMs || barWidth <= 0) return -1;
 const resetMs = new Date(win.resetsAt).getTime();
 if (Number.isNaN(resetMs)) return -1;
 const elapsed = 1 - (resetMs - Date.now()) / windowMs;
 if (elapsed < 0.05 || elapsed >= 1) return -1;
 return Math.min(barWidth - 1, Math.round(elapsed * barWidth));
}

/**
 * Hourglass icon for the reset countdown, by remaining fraction of the
 * window:  full (>2/3 left) →  half →  nearly empty (≤1/3) → 
 * empty (reset due now). Unknown/unparseable reset falls through to
 * empty, matching the "now" countdown shown in that case.
 */
function resetIcon(win: WindowUsage | null): string {
 const windowMs = win?.windowMs;
 const resetMs = win ? new Date(win.resetsAt).getTime() : NaN;
 if (!windowMs || Number.isNaN(resetMs)) return "\u{f250}";
 const remaining = (resetMs - Date.now()) / windowMs;
 if (remaining <= 0) return "\u{f250}";
 if (remaining <= 1 / 3) return "\u{f253}";
 if (remaining <= 2 / 3) return "\u{f252}";
 return "\u{f251}";
}

/** One bar cell: glyph + whether it takes the accent color (pace cursor). */
type BarCell = { ch: string; accent: boolean };

function barCells(pct: number, width: number, marker: number): BarCell[] {
 const clamped = Math.max(0, Math.min(100, pct));
 let filled = Math.round((clamped / 100) * width);
 // Any non-zero usage shows at least one cell so the bar isn't misleadingly empty.
 if (clamped > 0 && filled === 0) filled = 1;
 const cells: BarCell[] = [];
 for (let i = 0; i < width; i++) {
  const ch = i === marker ? (i < filled ? "█" : "▎") : i < filled ? "█" : "░";
  cells.push({ ch, accent: i === marker });
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
 // Unknown/unparseable reset counts down "now", matching the empty hourglass.
 if (!Number.isFinite(ms) || ms <= 0) return "now";
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
  const cells = barCells(usedPct, barWidth, paceMarker(win, barWidth))
   .map((c) => theme.fg(c.accent ? "accent" : color, c.ch))
   .join("");
  parts.push(cells);
  width += 1 + barWidth;
 }
 parts.push(theme.fg(color, pct));
 width += 1 + pct.length;
 if (showReset) {
  // Missing windows count down from "now" → displays "now".
  const reset = `${resetIcon(win)} ${resetCountdown(win?.resetsAt ?? new Date().toISOString())}`;
  parts.push(theme.fg("dim", reset));
  width += 1 + reset.length;
 }
 return { width, text: parts.join(" ") };
}

type NamedWindow = { label: string; usage: WindowUsage };

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
 const warn = status.kind === "stale" ? `  \u{e654} ${status.reason}` : "";

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
 const windows: NamedWindow[] = [];
 if (usage.fiveHour) windows.push({ label: "5h", usage: usage.fiveHour });
 if (usage.sevenDay) windows.push({ label: "7d", usage: usage.sevenDay });
 const fixed =
  head.length + plainWidth(sep) * (windows.length - 1) + plainWidth(warn);

 for (const showReset of [true, false]) {
  const bare = windows.map((window) =>
   windowSegment(theme, window.label, window.usage, 0, showReset),
  );
  const base = fixed + bare.reduce((sum, segment) => sum + segment.width, 0);
  if (base > width) continue;
  // Every window gets the same bar; each bar costs one leading space.
  const room = Math.floor((width - base - windows.length) / windows.length);
  const barWidth = room >= MIN_BAR_WIDTH ? Math.min(BAR_WIDTH, room) : 0;
  const segments =
   barWidth > 0
    ? windows.map((window) =>
       windowSegment(theme, window.label, window.usage, barWidth, showReset),
      )
    : bare;
  return (
   theme.fg("dim", head) +
   segments.map((segment) => segment.text).join(theme.fg("dim", sep)) +
   (warn ? theme.fg("dim", warn) : "")
  );
 }

 // Narrower than the barless form: keep only labels and percentages.
 return theme.fg(
  "dim",
  truncatePlain(
   windows
    .map((window) => `${window.label} ${Math.round(window.usage.usedPct)}%`)
    .join(" · "),
   width,
  ),
 );
}
