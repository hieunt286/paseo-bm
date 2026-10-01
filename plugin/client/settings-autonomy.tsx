/**
 * Settings → Autonomy (ADR-025; autonomy design §B.2, §A.12; experience
 * concept §4.4; change-014 outcome 5): one level per project, on a control of
 * five stops — Hands-on, Co-pilot, Cruise, Turbo, Full auto.
 *
 * Under the stops, one sentence says what the selected level means and a list
 * of the nine classes in three columns says who decides each at it. Pressing
 * a stop sets the level at once (`autonomy.set-level`), except Turbo and Full
 * auto: they open an in-place confirmation, Cancel first, and only its own
 * button sends `autonomy.set-level` with `confirmed: true`. A project whose
 * cells match no level reads Custom: no stop is selected and the classes show
 * their own cells, read-only.
 *
 * Under the level, **Hold risky actions for approval** is the project's
 * action boundary (`autonomy.set-boundary`, §D.2, change-010; off by
 * default), each direction after an in-place confirmation, Cancel first.
 *
 * On a phone (`compact`, the approved phone mockup) the project tabs become
 * one full-width picker that opens the list of projects in place, the
 * classes one column, and the confirmation's buttons a two-column grid.
 *
 * What it says is `settings-autonomy-model.ts`; `LevelControl`,
 * `BoundarySwitch` and `ProjectPicker` are hook-free and tested with the
 * element-tree helper.
 *
 * Client rules: React Native primitives only, colours from the theme, project
 * names only (no ids), no Node import, no `server/` import.
 */
import { useRpc } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { AutonomyLevel, AutonomyPolicy } from "../shared/autonomy";
import { autonomySetBoundaryRpc, autonomySetLevelRpc } from "../shared/contracts";
import type { InsightsProject } from "./insights-model";
import { errorMessageOf } from "./errors";
import {
  AUTONOMY_NO_PROJECTS,
  BOUNDARY_SHORT_LABEL,
  BOUNDARY_SHORT_MEANING,
  autonomyLevelView,
  autonomyProjects,
  autonomyTabs,
  levelPressOf,
  projectPickerView,
  setLevelInputOf,
  shownProjectOf,
  type AutonomyBoundaryView,
  type AutonomyLevelView,
  type ClassDecider,
} from "./settings-autonomy-model";
import { SquareSwitch, useBusyAction } from "./settings-blocks";
import { MONO, TextTabs } from "./text-tabs";
import { ConfirmBlock, ToneText, type Styles, type Theme } from "./ui";
import type { ConfirmDialog } from "./ui-types";

/** The colour of who decides a class: the Orchestrator in the accent, your approval in full contrast, you muted. */
function deciderColor(theme: Theme, decider: ClassDecider): string {
  if (decider === "orchestrator") return theme.colors.accent;
  return decider === "approve" ? theme.colors.foreground : theme.colors.foregroundMuted;
}

/** The legend square of who decides: as the class list colours it, "You" in the border colour. */
function legendColor(theme: Theme, decider: ClassDecider): string {
  return decider === "owner" ? theme.colors.foregroundMuted : deciderColor(theme, decider);
}

/**
 * The project's action boundary (the approved mockup): a bordered row with its
 * name and what it does, and one square switch; the confirmation of the side
 * pressed opens under it, in place (Cancel first). Hook-free.
 */
export function BoundarySwitch({ view, busy, compact = false, onToggle, onConfirm, onCancel, styles, theme }: {
  view: AutonomyBoundaryView;
  busy: boolean;
  /** A phone: the short name and line, 14 padding. */
  compact?: boolean;
  onToggle: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const { colors } = theme;
  const label = compact ? BOUNDARY_SHORT_LABEL : view.label;
  const caption = compact ? BOUNDARY_SHORT_MEANING : view.caption;
  return (
    <View
      style={{ gap: 12, borderWidth: 1, borderColor: colors.border, ...(compact ? { padding: 14 } : { paddingVertical: 16, paddingHorizontal: 20 }) }}
      accessibilityLabel={view.accessibilityLabel}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: compact ? 12 : 16 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500" }}>{label}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: compact ? 12 : 13 }}>{view.since === null ? caption : `${view.since}. ${caption}`}</Text>
        </View>
        <SquareSwitch
          on={view.on}
          disabled={!view.toggle.pressable}
          accessibilityLabel={view.toggle.accessibilityLabel}
          onPress={onToggle}
          theme={theme}
        />
      </View>
      {view.confirm === null ? null : (
        <ConfirmBlock dialog={view.confirm} busy={busy} busyLabel="Saving…" onConfirm={onConfirm} onCancel={onCancel} styles={styles} theme={theme} />
      )}
    </View>
  );
}

/**
 * The confirmation of Turbo or Full auto (the approved mockup): a box in the
 * warning colour with its title, what changes, Cancel (light, filled) first,
 * then "Switch to <level>" outlined in the warning colour. While it saves,
 * Cancel is gone and the button says so. Hook-free.
 */
export function LevelConfirmBox({ dialog, busy, compact = false, onConfirm, onCancel, theme }: {
  dialog: ConfirmDialog;
  busy: boolean;
  /** A phone: the two buttons share the row equally. */
  compact?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  theme: Theme;
}) {
  const { colors } = theme;
  const cell = compact ? ({ flex: 1, minWidth: 0, alignItems: "center", paddingHorizontal: 8 } as const) : {};
  return (
    <View style={{ gap: 10, borderWidth: 1, borderColor: colors.statusWarning, backgroundColor: colors.surface2, paddingVertical: 14, paddingHorizontal: 16 }}>
      {dialog.title === null ? null : <Text style={{ color: colors.statusWarning, fontSize: 14, fontWeight: "600" }}>{dialog.title}</Text>}
      <Text style={{ color: colors.foreground, fontSize: 14 }} selectable>
        {dialog.body}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: compact ? "nowrap" : "wrap", gap: 8 }}>
        {busy ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dialog.cancelAccessibilityLabel ?? dialog.cancelLabel}
            onPress={onCancel}
            style={{ backgroundColor: colors.foreground, paddingVertical: 8, paddingHorizontal: 16, ...cell }}
          >
            <Text style={{ color: colors.surface0, fontSize: 14, fontWeight: "500", textAlign: "center" }}>{dialog.cancelLabel}</Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={dialog.confirmAccessibilityLabel ?? dialog.confirmLabel}
          accessibilityState={{ disabled: busy, busy }}
          disabled={busy}
          onPress={onConfirm}
          style={{ borderWidth: 1, borderColor: colors.statusWarning, paddingVertical: 8, paddingHorizontal: 16, ...cell }}
        >
          <Text style={{ color: colors.statusWarning, fontSize: 14, textAlign: "center" }}>{busy ? "Saving…" : dialog.confirmLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** The knob of a stop: filled in the accent when shown, outlined in it below, in the border colour above. */
function knobStyle(theme: Theme, place: "below" | "selected" | "above") {
  const { colors } = theme;
  if (place === "selected") return { box: { backgroundColor: colors.accent, borderWidth: 1, borderColor: colors.accent }, text: colors.surface0 };
  if (place === "below") return { box: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.accent }, text: colors.accent };
  return { box: { backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border }, text: colors.foregroundMuted };
}

/**
 * One project's level, in one bordered panel (the approved mockup): the
 * slider — a 2px track from the first stop to the last, filled in the accent
 * up to the level shown, five numbered square knobs with their names, one
 * radio group —, what the shown level means, the confirmation of Turbo or
 * Full auto while it is asked, the nine classes in three columns with who
 * decides each, the legend, and a failed change's reason. On a phone
 * (`compact`): 32px knobs, names at 11 on up to two lines, and the classes
 * as one column of rows. Hook-free.
 */
export function LevelControl({ view, error, busy, compact = false, onPick, onConfirm, onCancel, styles, theme }: {
  view: AutonomyLevelView;
  error: string | null;
  busy: boolean;
  compact?: boolean;
  onPick: (level: AutonomyLevel) => void;
  onConfirm: () => void;
  onCancel: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const { colors } = theme;
  // The knobs' centres sit at a tenth of the row from each side: the track runs between them.
  const knobSize = compact ? 32 : 36;
  const stopPadding = compact ? 4 : 8;
  const trackTop = stopPadding + knobSize / 2 - 1;
  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, ...(compact ? { paddingVertical: 16, paddingHorizontal: 12, gap: 14 } : {}) }}>
      <View style={compact ? {} : { paddingTop: 28, paddingHorizontal: 28, paddingBottom: 8 }}>
        <View accessibilityRole="radiogroup" accessibilityLabel={`Autonomy level of ${view.title}`} style={{ flexDirection: "row" }}>
          <View style={{ position: "absolute", left: "10%", right: "10%", top: trackTop, height: 2, backgroundColor: colors.border }} />
          <View style={{ position: "absolute", left: "10%", width: `${view.fill * 80}%`, top: trackTop, height: 2, backgroundColor: colors.accent }} />
          {view.stops.map((stop) => {
            const knob = knobStyle(theme, stop.place);
            return (
              <Pressable
                key={stop.level}
                accessibilityRole="radio"
                accessibilityLabel={stop.accessibilityLabel}
                accessibilityState={{ selected: stop.selected, checked: stop.selected, disabled: !stop.enabled }}
                disabled={!stop.enabled}
                onPress={() => onPick(stop.level)}
                style={{ flex: 1, minWidth: 0, alignItems: "center", gap: compact ? 8 : 10, paddingVertical: stopPadding, paddingHorizontal: compact ? 2 : 4 }}
              >
                <View style={{ width: knobSize, height: knobSize, alignItems: "center", justifyContent: "center", ...knob.box }}>
                  <Text style={{ color: knob.text, fontFamily: MONO, fontWeight: "500", fontSize: compact ? 13 : 14 }}>{String(stop.level)}</Text>
                </View>
                <Text
                  numberOfLines={compact ? 2 : 1}
                  style={{
                    color: stop.selected ? colors.foreground : colors.foregroundMuted,
                    fontWeight: stop.selected ? "600" : "400",
                    fontSize: compact ? 11 : 14,
                    textAlign: "center",
                  }}
                >
                  {stop.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <View style={compact ? { gap: 14 } : { paddingTop: 16, paddingHorizontal: 28, paddingBottom: 24, gap: 14 }}>
        <Text style={{ color: colors.foreground, fontSize: compact ? 14 : 15, lineHeight: compact ? 21 : 22 }}>{view.summary}</Text>
        {view.confirm === null ? null : (
          <LevelConfirmBox dialog={view.confirm.dialog} busy={busy} compact={compact} onConfirm={onConfirm} onCancel={onCancel} theme={theme} />
        )}
        <View style={{ flexDirection: compact ? "column" : "row", flexWrap: compact ? "nowrap" : "wrap", borderTopWidth: 1, borderTopColor: colors.border }}>
          {view.classes.map((entry) => (
            <View
              key={entry.decisionClass}
              accessibilityLabel={`${entry.label}: ${entry.who}`}
              style={{
                width: compact ? "100%" : "33.33%",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                paddingTop: compact ? 9 : 10,
                paddingBottom: compact ? 9 : 10,
                paddingRight: compact ? 0 : 12,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
              }}
            >
              <Text style={{ color: colors.foreground, fontSize: compact ? 13 : 14, flexShrink: 1 }} numberOfLines={1}>
                {entry.label}
              </Text>
              <Text style={{ color: deciderColor(theme, entry.decider), fontSize: 12, fontFamily: MONO }}>{entry.who}</Text>
            </View>
          ))}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 20, rowGap: 6 }} accessibilityLabel={view.legend.map((entry) => entry.text).join(" · ")}>
          {view.legend.map((entry) => (
            <View key={entry.decider} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={{ width: 8, height: 8, backgroundColor: legendColor(theme, entry.decider) }} />
              <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{entry.text}</Text>
            </View>
          ))}
        </View>
        {error === null ? null : (
          <ToneText tone="danger" selectable styles={styles} theme={theme}>
            {error}
          </ToneText>
        )}
      </View>
    </View>
  );
}

/**
 * The phone's project picker (the approved phone mockup): a "Project" label
 * and one full-width button — the project's name, its level in muted mono
 * and ▾ —; pressed, the list of every project opens under it in place (name
 * and level, the shown one marked), and choosing one closes it. Hook-free.
 */
export function ProjectPicker({ tabs, selected, open, onToggle, onSelect, theme }: {
  tabs: ReadonlyArray<{ key: string; label: string; suffix: string }>;
  selected: string;
  open: boolean;
  onToggle: () => void;
  onSelect: (key: string) => void;
  theme: Theme;
}) {
  const { colors } = theme;
  const picker = projectPickerView(tabs, selected, open);
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Project</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={picker.button.accessibilityLabel}
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, padding: 12 }}
      >
        <Text style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 14 }} numberOfLines={1}>
          {picker.button.label}
        </Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontFamily: MONO }}>{picker.button.level}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 14 }}>{open ? "▴" : "▾"}</Text>
      </Pressable>
      {picker.rows === null ? null : (
        <View accessibilityRole="list" style={{ borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}>
          {picker.rows.map((row, index) => (
            <Pressable
              key={row.key}
              accessibilityRole="button"
              accessibilityLabel={row.accessibilityLabel}
              accessibilityState={{ selected: row.current }}
              onPress={() => onSelect(row.key)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingVertical: 12,
                paddingHorizontal: 12,
                ...(row.current ? { backgroundColor: colors.surface2 } : {}),
                ...(index === 0 ? {} : { borderTopWidth: 1, borderTopColor: colors.border }),
              }}
            >
              <View style={{ width: 3, alignSelf: "stretch", backgroundColor: row.current ? colors.accent : "transparent" }} />
              <Text style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 14, fontWeight: row.current ? "500" : "400" }} numberOfLines={1}>
                {row.label}
              </Text>
              <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontFamily: MONO }}>{row.level}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * The Autonomy group's body (its title and meaning are the section's
 * heading): the project tabs — text tabs, each project by name with its level
 * in muted mono —, the chosen project's level panel and its action boundary.
 * A change returns the whole policy, which `onSaved` puts in the shared query.
 */
export function AutonomyGroup({ policy, projects, compact = false, onSaved, styles, theme }: {
  policy: AutonomyPolicy;
  projects: readonly InsightsProject[];
  /** A phone: the project picker instead of the tabs, the compact level panel. */
  compact?: boolean;
  onSaved: (policy: AutonomyPolicy) => void;
  styles: Styles;
  theme: Theme;
}) {
  const setLevel = useRpc(autonomySetLevelRpc);
  const setBoundary = useRpc(autonomySetBoundaryRpc);
  const [chosen, setChosen] = useState<string | null>(null);
  // The phone's project list, open under its picker.
  const [pickerOpen, setPickerOpen] = useState(false);
  // Turbo or Full auto pressed, its confirmation shown; or null.
  const [confirmingLevel, setConfirmingLevel] = useState<AutonomyLevel | null>(null);
  // The side of the action boundary whose confirmation is shown, or null.
  const [confirmingBoundary, setConfirmingBoundary] = useState<boolean | null>(null);
  const { busy, run: runAction } = useBusyAction();
  const [error, setError] = useState<string | null>(null);
  const list = autonomyProjects(projects, policy);
  const project = shownProjectOf(list, chosen);
  const run = (change: () => Promise<{ policy: AutonomyPolicy }>) =>
    runAction(
      async () => {
        setError(null);
        onSaved((await change()).policy);
      },
      (failure) => setError(errorMessageOf(failure)),
    );
  if (project === null) {
    return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>{AUTONOMY_NO_PROJECTS}</Text>;
  }
  const view = autonomyLevelView({ policy, project, busy, confirmingLevel, confirmingBoundary });
  const choose = (key: string) => {
    setError(null);
    setConfirmingLevel(null);
    setConfirmingBoundary(null);
    setChosen(key);
    setPickerOpen(false);
  };
  return (
    <View style={{ gap: compact ? 12 : 18 }}>
      {compact ? (
        <ProjectPicker
          tabs={autonomyTabs(list, policy)}
          selected={project.id}
          open={pickerOpen}
          onToggle={() => setPickerOpen((current) => !current)}
          onSelect={choose}
          theme={theme}
        />
      ) : (
        <TextTabs tabs={autonomyTabs(list, policy)} selected={project.id} divider wrap onSelect={choose} theme={theme} />
      )}
      <LevelControl
        view={view}
        error={error}
        busy={busy}
        compact={compact}
        onPick={(level) => {
          setError(null);
          setConfirmingBoundary(null);
          const press = levelPressOf(view.reading, level);
          if (press === "set") run(() => setLevel(setLevelInputOf(project.id, level)));
          setConfirmingLevel(press === "confirm" ? level : null);
        }}
        onConfirm={() => {
          const level = confirmingLevel;
          if (level === null) return;
          run(async () => {
            const saved = await setLevel(setLevelInputOf(project.id, level));
            setConfirmingLevel(null);
            return saved;
          });
        }}
        onCancel={() => setConfirmingLevel(null)}
        styles={styles}
        theme={theme}
      />
      <BoundarySwitch
        view={view.boundary}
        busy={busy}
        compact={compact}
        onToggle={() => {
          setError(null);
          setConfirmingLevel(null);
          setConfirmingBoundary(!view.boundary.on);
        }}
        onConfirm={() => {
          const enabled = confirmingBoundary;
          if (enabled === null) return;
          run(async () => {
            const saved = await setBoundary({ workspaceId: project.id, enabled, confirmed: true });
            setConfirmingBoundary(null);
            return saved;
          });
        }}
        onCancel={() => setConfirmingBoundary(null)}
        styles={styles}
        theme={theme}
      />
    </View>
  );
}
