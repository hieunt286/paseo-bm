/**
 * Settings → Coordination's compaction and handoff cards (autonomy design
 * §G.7; bead `7gxw.9`) and the review budget card (bead `7gxw.12`):
 * hook-free, drawn from `mechanismCardView` and `reviewBudgetCardView`
 * (`settings-coordination-model.ts`); the group that holds their state is in
 * `settings-section.tsx`.
 *
 * Client rules: React Native primitives only, colours from the theme, no Node
 * import, no `server/` import.
 */
import { Text, View } from "react-native";
import type { MechanismCardView, ReviewBudgetCardView, ReviewBudgetKey, StepButton, ThresholdKey } from "./settings-coordination-model";
import { Button, ConfirmBlock, ToneText, type Styles, type Theme } from "./ui";
import type { ConfirmDialog } from "./ui-types";

function StepButtonView({ button, primary, onPress, styles }: { button: StepButton; primary: boolean; onPress: () => void; styles: Styles }) {
  return (
    <Button
      label={button.label}
      kind={primary ? "primary" : "secondary"}
      accessibilityLabel={button.accessibilityLabel}
      accessibilityState={{ disabled: !button.enabled }}
      disabled={!button.enabled}
      onPress={onPress}
      styles={styles}
    />
  );
}

/**
 * One mechanism: its title and switch, its status, what it does, the turn-on
 * confirmation while it is asked, each threshold with − and +, Save and the
 * defaults. A failed save says why under it.
 */
export function MechanismCard({ view, dialog, busy, error, onToggle, onConfirm, onCancel, onStep, onSave, onReset, styles, theme }: {
  view: MechanismCardView;
  /** The turn-on confirmation, while it is asked. */
  dialog: ConfirmDialog | null;
  busy: boolean;
  error: string | null;
  onToggle: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onStep: (key: ThresholdKey, step: -1 | 1) => void;
  onSave: () => void;
  onReset: () => void;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={[styles.card, { gap: 6 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={[styles.sectionTitle, { flex: 1, minWidth: 120 }]}>{view.title}</Text>
        {dialog === null ? <StepButtonView button={view.toggle} primary={view.toggle.turnsOn} onPress={onToggle} styles={styles} /> : null}
      </View>
      <ToneText tone={view.status.tone} styles={styles} theme={theme}>
        {view.status.text}
      </ToneText>
      <Text style={[styles.body, { fontSize: 11 }]}>{view.meaning}</Text>
      {dialog === null ? null : (
        <ConfirmBlock dialog={dialog} busy={busy} busyLabel="Turning on…" onConfirm={onConfirm} onCancel={onCancel} styles={styles} theme={theme} />
      )}
      {view.rows.map((row) => (
        <View key={row.key} style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text style={[styles.body, { minWidth: 96 }]}>{row.label}</Text>
          <StepButtonView button={row.decrease} primary={false} onPress={() => onStep(row.key, -1)} styles={styles} />
          <Text style={styles.body}>{row.valueText}</Text>
          <StepButtonView button={row.increase} primary={false} onPress={() => onStep(row.key, 1)} styles={styles} />
        </View>
      ))}
      {view.note === null ? null : <Text style={[styles.body, { fontSize: 11 }]}>{view.note}</Text>}
      <View style={styles.chipRow}>
        <StepButtonView button={view.save} primary onPress={onSave} styles={styles} />
        {view.reset === null ? null : <StepButtonView button={view.reset} primary={false} onPress={onReset} styles={styles} />}
      </View>
      {error === null ? null : (
        <ToneText tone="danger" selectable styles={styles} theme={theme}>
          {error}
        </ToneText>
      )}
    </View>
  );
}

/**
 * The review budget per tier (autonomy design §C.4, §G.7): what it means, each
 * tier's review calls with − and +, that a Worker keeps the budget it started
 * with, Save and the defaults. A failed save says why under it.
 */
export function ReviewBudgetCard({ view, error, onStep, onSave, onReset, styles, theme }: {
  view: ReviewBudgetCardView;
  error: string | null;
  onStep: (key: ReviewBudgetKey, step: -1 | 1) => void;
  onSave: () => void;
  onReset: () => void;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={[styles.card, { gap: 6 }]}>
      <Text style={styles.sectionTitle}>{view.title}</Text>
      <Text style={[styles.body, { fontSize: 11 }]}>{view.meaning}</Text>
      {view.rows.map((row) => (
        <View key={row.key} style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text style={[styles.body, { minWidth: 96 }]}>{row.label}</Text>
          <StepButtonView button={row.decrease} primary={false} onPress={() => onStep(row.key, -1)} styles={styles} />
          <Text style={styles.body}>{row.valueText}</Text>
          <StepButtonView button={row.increase} primary={false} onPress={() => onStep(row.key, 1)} styles={styles} />
        </View>
      ))}
      <Text style={[styles.body, { fontSize: 11 }]}>{view.note}</Text>
      <View style={styles.chipRow}>
        <StepButtonView button={view.save} primary onPress={onSave} styles={styles} />
        {view.reset === null ? null : <StepButtonView button={view.reset} primary={false} onPress={onReset} styles={styles} />}
      </View>
      {error === null ? null : (
        <ToneText tone="danger" selectable styles={styles} theme={theme}>
          {error}
        </ToneText>
      )}
    </View>
  );
}
