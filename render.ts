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
 *   Usage  5h █░░░░░░░░ 1% ↻3.7h  ·  7d █░░░░░░░░ 4% ↻2.9d
 */

import type { ProviderUsage } from "./provider.js";

const BAR_WIDTH = 10;

type Theme = { fg(color: string, text: string): string };

export type HudStatus =
  | { kind: "ok"; usage: ProviderUsage }
  | { kind: "no_creds"; providerName: string; hint: string }
  | { kind: "stale"; usage: ProviderUsage | null; reason: string };

function pctColor(pct: number): string {
  if (pct >= 90) return "error";
  if (pct >= 70) return "warning";
  return "success";
}

function bar(pct: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  let filled = Math.round((clamped / 100) * width);
  // Any non-zero usage shows at least one cell so the bar isn't misleadingly empty.
  if (clamped > 0 && filled === 0) filled = 1;
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Compact reset countdown: "45m" / "3.7h" / "2.9d" / "now". */
function resetCountdown(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function windowSegment(
  theme: Theme,
  label: string,
  usedPct: number,
  resetsAt: string,
): string {
  const color = pctColor(usedPct);
  const lbl = theme.fg("dim", label);
  const b = theme.fg(color, bar(usedPct, BAR_WIDTH));
  const pct = theme.fg(color, `${Math.round(usedPct)}%`);
  const reset = theme.fg("dim", `ⴵ ${resetCountdown(resetsAt)}`);
  return `${lbl} ${b} ${pct} ${reset}`;
}

/**
 * Render the HUD as a single themed line. Width is the available terminal
 * width; we render left-aligned and let the caller truncate if needed.
 */
export function renderHudLine(theme: Theme, status: HudStatus): string {
  if (status.kind === "no_creds") {
    return theme.fg("warning", "Usage ") + theme.fg("dim", `— ${status.hint}`);
  }

  if (status.kind === "stale") {
    const base = status.usage
      ? `${windowSegment(theme, "6h", status.usage.fiveHour?.usedPct ?? 0, status.usage.fiveHour?.resetsAt ?? new Date().toISOString())}  ${theme.fg("dim", "·")}  ${windowSegment(theme, "7d", status.usage.sevenDay?.usedPct ?? 0, status.usage.sevenDay?.resetsAt ?? new Date().toISOString())}`
      : theme.fg("dim", "（等待用量数据…）");
    return (
      theme.fg("warning", "Usage ") +
      base +
      theme.fg("dim", `  ⚠ ${status.reason}`)
    );
  }

  const { usage } = status;
  const head = theme.fg("dim", "Usage ");
  const sep = theme.fg("dim", "  ·  ");

  if (!usage.fiveHour && !usage.sevenDay) {
    return head + theme.fg("dim", "（暂无用量窗口）");
  }

  const seg5 = windowSegment(
    theme,
    "5h",
    usage.fiveHour?.usedPct ?? 0,
    usage.fiveHour?.resetsAt ?? new Date().toISOString(),
  );
  const seg7 = windowSegment(
    theme,
    "7d",
    usage.sevenDay?.usedPct ?? 0,
    usage.sevenDay?.resetsAt ?? new Date().toISOString(),
  );
  return head + seg5 + sep + seg7;
}
