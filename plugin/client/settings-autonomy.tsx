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
 * What it says is `settings-autonomy-model.ts`; `LevelControl` and
 * `BoundarySwitch` are hook-free and tested with the element-tree helper.
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
  autonomyLevelView,
  autonomyProjects,
  autonomyTabs,
  levelPressOf,
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
export function BoundarySwitch({ view, busy, onToggle, onConfirm, onCancel, styles, theme }: {
  view: AutonomyBoundaryView;
  busy: boolean;
  onToggle: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const { colors } = theme;
  return (
    <View
      style={{ gap: 12, borderWidth: 1, borderColor: colors.border, paddingVertical: 16, paddingHorizontal: 20 }}
      accessibilityLabel={view.accessibilityLabel}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500" }}>{view.label}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{view.since === null ? view.caption : `${view.since}. ${view.caption}`}</Text>
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
export function LevelConfirmBox({ dialog, busy, onConfirm, onCancel, theme }: {
  dialog: ConfirmDialog;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  theme: Theme;
}) {
  const { colors } = theme;
  return (
    <View style={{ gap: 10, borderWidth: 1, borderColor: colors.statusWarning, backgroundColor: colors.surface2, paddingVertical: 14, paddingHorizontal: 16 }}>
      {dialog.title === null ? null : <Text style={{ color: colors.statusWarning, fontSize: 14, fontWeight: "600" }}>{dialog.title}</Text>}
      <Text style={{ color: colors.foreground, fontSize: 14 }} selectable>
        {dialog.body}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {busy ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dialog.cancelAccessibilityLabel ?? dialog.cancelLabel}
            onPress={onCancel}
            style={{ backgroundColor: colors.foreground, paddingVertical: 8, paddingHorizontal: 16 }}
          >
            <Text style={{ color: colors.surface0, fontSize: 14, fontWeight: "500" }}>{dialog.cancelLabel}</Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={dialog.confirmAccessibilityLabel ?? dialog.confirmLabel}
          accessibilityState={{ disabled: busy, busy }}
          disabled={busy}
          onPress={onConfirm}
          style={{ borderWidth: 1, borderColor: colors.statusWarning, paddingVertical: 8, paddingHorizontal: 16 }}
        >
          <Text style={{ color: colors.statusWarning, fontSize: 14 }}>{busy ? "Saving…" : dialog.confirmLabel}</Text>
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
 * decides each, the legend, and a failed change's reason. Hook-free.
 */
export function LevelControl({ view, error, busy, onPick, onConfirm, onCancel, styles, theme }: {
  view: AutonomyLevelView;
  error: string | null;
  busy: boolean;
  onPick: (level: AutonomyLevel) => void;
  onConfirm: () => void;
  onCancel: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const { colors } = theme;
  // The knobs' centres sit at a tenth of the row from each side: the track runs between them.
  const trackTop = 8 + 18 - 1;
  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}>
      <View style={{ paddingTop: 28, paddingHorizontal: 28, paddingBottom: 8 }}>
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
                style={{ flex: 1, minWidth: 0, alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 4 }}
              >
                <View style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center", ...knob.box }}>
                  <Text style={{ color: knob.text, fontFamily: MONO, fontWeight: "500", fontSize: 14 }}>{String(stop.level)}</Text>
                </View>
                <Text
                  numberOfLines={1}
                  style={{ color: stop.selected ? colors.foreground : colors.foregroundMuted, fontWeight: stop.selected ? "600" : "400", fontSize: 14, textAlign: "center" }}
                >
                  {stop.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <View style={{ paddingTop: 16, paddingHorizontal: 28, paddingBottom: 24, gap: 14 }}>
        <Text style={{ color: colors.foreground, fontSize: 15, lineHeight: 22 }}>{view.summary}</Text>
        {view.confirm === null ? null : <LevelConfirmBox dialog={view.confirm.dialog} busy={busy} onConfirm={onConfirm} onCancel={onCancel} theme={theme} />}
        <View style={{ flexDirection: "row", flexWrap: "wrap", borderTopWidth: 1, borderTopColor: colors.border }}>
          {view.classes.map((entry) => (
            <View
              key={entry.decisionClass}
              accessibilityLabel={`${entry.label}: ${entry.who}`}
              style={{
                width: "33.33%",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                paddingTop: 10,
                paddingBottom: 10,
                paddingRight: 12,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
              }}
            >
              <Text style={{ color: colors.foreground, fontSize: 14, flexShrink: 1 }} numberOfLines={1}>
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
 * The Autonomy group's body (its title and meaning are the section's
 * heading): the project tabs — text tabs, each project by name with its level
 * in muted mono —, the chosen project's level panel and its action boundary.
 * A change returns the whole policy, which `onSaved` puts in the shared query.
 */
export function AutonomyGroup({ policy, projects, onSaved, styles, theme }: {
  policy: AutonomyPolicy;
  projects: readonly InsightsProject[];
  onSaved: (policy: AutonomyPolicy) => void;
  styles: Styles;
  theme: Theme;
}) {
  const setLevel = useRpc(autonomySetLevelRpc);
  const setBoundary = useRpc(autonomySetBoundaryRpc);
  const [chosen, setChosen] = useState<string | null>(null);
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
  return (
    <View style={{ gap: 18 }}>
      <TextTabs
        tabs={autonomyTabs(list, policy)}
        selected={project.id}
        divider
        wrap
        onSelect={(key) => {
          setError(null);
          setConfirmingLevel(null);
          setConfirmingBoundary(null);
          setChosen(key);
        }}
        theme={theme}
      />
      <LevelControl
        view={view}
        error={error}
        busy={busy}
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
