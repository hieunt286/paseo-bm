/**
 * The tones the screens of the Beads Manager surface colour by, a badge, and
 * the mark each agent role is drawn with (WP-211.1; Dashboard Design §2.1).
 * Split from `dashboard-model.ts` (code review 2026-09-30 §4). Every colour
 * comes from the theme; no literal colours.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import type { PluginTheme } from "@getpaseo/plugin";

/**
 * `plain` is the text colour itself: it says "read me" without a hue, and it is
 * what everywhere a bead shows uses since delta 20260925 §3.2 — four hues on a
 * list of beads were tiring to read.
 */
export type Tone = "muted" | "plain" | "info" | "warning" | "danger" | "success";

export interface Badge {
  text: string;
  tone: Tone;
}

export function toneColor(theme: PluginTheme, tone: Tone): string {
  switch (tone) {
    case "muted":
      return theme.colors.foregroundMuted;
    case "plain":
      return theme.colors.foreground;
    case "info":
      return theme.colors.accent;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    case "success":
      return theme.colors.statusSuccess;
  }
}

/**
 * The tone of the bar at a card's left that marks its kind (change-014
 * outcome 6), from the tone that describes the card: something waiting reads
 * warning, something held or failing danger, news (info) a muted grey; a
 * settled or neutral card (success, muted, plain) has no bar. Colour stays in
 * this small mark, and only where the owner may have to act.
 */
export function kindBarTone(tone: Tone | null): Tone | null {
  if (tone === "warning" || tone === "danger") return tone;
  return tone === "info" ? "muted" : null;
}

// ---------------------------------------------------------------------------
// Role marks.
// ---------------------------------------------------------------------------

/** What a role mark can stand for: the Manager (its request), a Worker, a Reviewer, or the Orchestrator. */
export type RoleMarkKind = "request" | "worker" | "reviewer" | "orchestrator";

/**
 * How each agent is drawn: a small Lucide icon on a soft, square tint of one
 * theme colour. `request` stands for the Manager, which handles the request. The
 * shape tells the role apart even where the colours look alike.
 */
export const ROLE_MARK: Readonly<Record<RoleMarkKind, { role: string; icon: string; tone: Tone }>> = {
  request: { role: "Manager", icon: "BotMessageSquare", tone: "info" },
  worker: { role: "Worker", icon: "Hammer", tone: "success" },
  reviewer: { role: "Reviewer", icon: "ScanEye", tone: "warning" },
  orchestrator: { role: "Orchestrator", icon: "Compass", tone: "muted" },
};
