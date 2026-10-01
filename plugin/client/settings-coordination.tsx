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
import type { ReactNode } from "react";
import { Text, TextInput, View } from "react-native";
import {
  inputErrorsOf,
  type CoordinationInputs,
  type CoordinationNumberKey,
  type MechanismCardView,
  type ReviewBudgetCardView,
  type StepButton,
} from "./settings-coordination-model";
import { SquareSwitch } from "./settings-blocks";
import { MONO } from "./text-tabs";
import { Button, ConfirmBlock, ToneText, type Styles, type Theme } from "./ui";
import type { ConfirmDialog } from "./ui-types";

/** A bordered card of the Coordination section: the border colour, `surface1`, square corners. */
export function coordinationCardStyle(theme: Theme) {
  return { borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 } as const;
}

/**
 * A number field of the mockup: mono, right-aligned, on the page ground in a
 * 1px border (the danger colour while its text is refused). Hook-free.
 */
export function NumberField({ value, invalid, accessibilityLabel, editable, width = 96, onChange, theme }: {
  value: string;
  invalid: boolean;
  accessibilityLabel: string;
  editable: boolean;
  width?: number;
  onChange: (text: string) => void;
  theme: Theme;
}) {
  const { colors } = theme;
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      editable={editable}
      accessibilityLabel={accessibilityLabel}
      inputMode="decimal"
      style={{
        width,
        backgroundColor: colors.surface0,
        color: colors.foreground,
        borderWidth: 1,
        borderColor: invalid ? colors.statusDanger : colors.border,
        paddingVertical: 6,
        paddingHorizontal: 8,
        fontFamily: MONO,
        fontSize: 14,
        textAlign: "right",
      }}
    />
  );
}

/** Whether a card's foot has something to say: a change to save, a refusal, a failed save, or a save running. */
export function footerShown(save: StepButton, refusals: readonly string[], error: string | null): boolean {
  return save.enabled || refusals.length > 0 || error !== null || save.label === "Saving…";
}

/**
 * The foot of a card while it has something to say: why a field is refused,
 * why a save failed, and Save at the right. Nothing at rest, so the card reads
 * as the mockup draws it. Hook-free.
 */
export function CardFooter({ save, refusals, error, onSave, styles, theme }: {
  save: StepButton;
  refusals: readonly string[];
  error: string | null;
  onSave: () => void;
  styles: Styles;
  theme: Theme;
}) {
  if (!footerShown(save, refusals, error)) return null;
  const enabled = save.enabled && refusals.length === 0;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
      <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
        {[...refusals, ...(error === null ? [] : [error])].map((line) => (
          <ToneText key={line} tone="danger" selectable style={{ fontSize: 12 }} styles={styles} theme={theme}>
            {line}
          </ToneText>
        ))}
      </View>
      <Button
        label={save.label}
        kind="primary"
        accessibilityLabel={save.accessibilityLabel}
        accessibilityState={{ disabled: !enabled }}
        disabled={!enabled}
        onPress={onSave}
        style={{ borderRadius: 0, paddingVertical: 6, opacity: enabled ? 1 : 0.6 }}
        styles={styles}
      />
    </View>
  );
}

/** A labelled field of a card's two-column grid: the label, then the field at the right; borders between the cells. */
function GridCell({ index, count, narrow, label, children, theme }: {
  index: number;
  count: number;
  narrow: boolean;
  label: string;
  children: ReactNode;
  theme: Theme;
}) {
  const { colors } = theme;
  const columns = narrow ? 1 : 2;
  const lastRowStart = count - (count % columns === 0 ? columns : count % columns);
  return (
    <View
      style={{
        width: narrow ? "100%" : "50%",
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 20,
        ...(index < lastRowStart ? { borderBottomWidth: 1, borderBottomColor: colors.border } : {}),
        ...(!narrow && index % 2 === 0 ? { borderRightWidth: 1, borderRightColor: colors.border } : {}),
      }}
    >
      <Text style={{ flex: 1, color: colors.foreground, fontSize: 14 }}>{label}</Text>
      {children}
    </View>
  );
}

/**
 * One of Compact and Handoff (the approved mockup): the title, what it does,
 * how often it helped and its square switch; the turn-on confirmation while
 * it is asked (Cancel first); a switch-off by paseo-bm in the warning colour;
 * then its thresholds in a two-column grid of number fields, and Save at the
 * foot while a field changed. Hook-free.
 */
export function MechanismCard({ view, inputs, dialog, busy, error, narrow = false, onToggle, onConfirm, onCancel, onInput, onSave, styles, theme }: {
  view: MechanismCardView;
  /** The text of the fields being typed in. */
  inputs: CoordinationInputs;
  /** The turn-on confirmation, while it is asked. */
  dialog: ConfirmDialog | null;
  busy: boolean;
  error: string | null;
  narrow?: boolean;
  onToggle: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onInput: (key: CoordinationNumberKey, text: string) => void;
  onSave: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const { colors } = theme;
  const refusals = inputErrorsOf(view.rows.map((row) => row.key), inputs);
  return (
    <View style={coordinationCardStyle(theme)}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16, paddingVertical: 16, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>{view.title}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{view.meaning}</Text>
        </View>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{view.helped}</Text>
        <SquareSwitch
          on={!view.toggle.turnsOn}
          disabled={!view.toggle.enabled || dialog !== null}
          accessibilityLabel={view.toggle.accessibilityLabel}
          onPress={onToggle}
          theme={theme}
        />
      </View>
      {view.status.tone === "warning" || dialog !== null ? (
        <View style={{ gap: 10, paddingVertical: 12, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          {view.status.tone === "warning" ? (
            <ToneText tone="warning" style={{ fontSize: 13 }} styles={styles} theme={theme}>
              {view.status.text}
            </ToneText>
          ) : null}
          {dialog === null ? null : (
            <ConfirmBlock dialog={dialog} busy={busy} busyLabel="Turning on…" onConfirm={onConfirm} onCancel={onCancel} styles={styles} theme={theme} />
          )}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {view.rows.map((row, index) => (
          <GridCell key={row.key} index={index} count={view.rows.length} narrow={narrow} label={row.label} theme={theme}>
            <NumberField
              value={inputs[row.key] ?? row.inputText}
              invalid={inputErrorsOf([row.key], inputs).length > 0}
              accessibilityLabel={row.accessibilityLabel}
              editable={!busy}
              onChange={(text) => onInput(row.key, text)}
              theme={theme}
            />
          </GridCell>
        ))}
      </View>
      {dialog === null && footerShown(view.save, refusals, error) ? (
        <View style={{ paddingVertical: 12, paddingHorizontal: 20, borderTopWidth: 1, borderTopColor: colors.border }}>
          <CardFooter save={view.save} refusals={refusals} error={error} onSave={onSave} styles={styles} theme={theme} />
        </View>
      ) : null}
      {dialog !== null && error !== null ? (
        <View style={{ paddingVertical: 12, paddingHorizontal: 20 }}>
          <ToneText tone="danger" selectable styles={styles} theme={theme}>
            {error}
          </ToneText>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The review budget per tier (the approved mockup): its title, three joined
 * cells — Small, Medium, Large — each a mono number field, what the budget
 * means, and Save at the foot while a tier changed. Hook-free.
 */
export function ReviewBudgetCard({ view, inputs, busy, error, onInput, onSave, styles, theme }: {
  view: ReviewBudgetCardView;
  inputs: CoordinationInputs;
  busy: boolean;
  error: string | null;
  onInput: (key: CoordinationNumberKey, text: string) => void;
  onSave: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const { colors } = theme;
  const refusals = inputErrorsOf(view.rows.map((row) => row.key), inputs);
  return (
    <View style={[coordinationCardStyle(theme), { flex: 1, gap: 12, paddingVertical: 16, paddingHorizontal: 20 }]}>
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>{view.title}</Text>
      <View style={{ flexDirection: "row", borderWidth: 1, borderColor: colors.border }}>
        {view.rows.map((row, index) => {
          const invalid = inputErrorsOf([row.key], inputs).length > 0;
          return (
            <View
              key={row.key}
              style={{ flex: 1, minWidth: 0, gap: 4, paddingVertical: 10, paddingHorizontal: 12, ...(index === 0 ? {} : { borderLeftWidth: 1, borderLeftColor: colors.border }) }}
            >
              <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{row.label}</Text>
              <TextInput
                value={inputs[row.key] ?? row.inputText}
                onChangeText={(text) => onInput(row.key, text)}
                editable={!busy}
                accessibilityLabel={row.accessibilityLabel}
                inputMode="numeric"
                style={{ color: invalid ? colors.statusDanger : colors.foreground, fontFamily: MONO, fontSize: 18, padding: 0, borderWidth: 0, backgroundColor: "transparent", width: "100%" }}
              />
            </View>
          );
        })}
      </View>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{view.meaning}</Text>
      <CardFooter save={view.save} refusals={refusals} error={error} onSave={onSave} styles={styles} theme={theme} />
    </View>
  );
}
