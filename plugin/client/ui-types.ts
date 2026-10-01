/**
 * The types the shared pieces of `ui.tsx` take, in a `.ts` file so the pure
 * models (no React, no React Native) can build their values without importing
 * a component module.
 */
import type { Tone } from "./tone";

/**
 * A confirmation the user must read before anything happens, drawn in place
 * by `ConfirmBlock`: in Settings, the Inbox, a chat's decision card and
 * Insights.
 *
 * Cancel is the default action and the one Escape takes, and the confirm button
 * is never the pre-focused one: every dialog that uses this grants something
 * that is awkward to take back, so an accidental Return must do nothing.
 */
export interface ConfirmDialog {
  /** The question, in the warning colour; `null` when the body says it all. */
  title: string | null;
  body: string;
  /** The body's colour; plain text when omitted. */
  bodyTone?: Tone;
  confirmLabel: string;
  cancelLabel: string;
  /** What a screen reader hears for each button; the visible label when omitted. */
  confirmAccessibilityLabel?: string;
  cancelAccessibilityLabel?: string;
  /** What Escape and the default action do. */
  defaultAction: "cancel";
}
