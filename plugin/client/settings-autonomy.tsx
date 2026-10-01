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
import { Text, View } from "react-native";
import type { AutonomyLevel, AutonomyPolicy } from "../shared/autonomy";
import { autonomySetBoundaryRpc, autonomySetLevelRpc } from "../shared/contracts";
import type { InsightsProject } from "./insights-model";
import { errorMessageOf } from "./errors";
import {
  AUTONOMY_MEANING,
  AUTONOMY_NO_PROJECTS,
  autonomyLevelView,
  autonomyProjects,
  autonomyTabs,
  levelPressOf,
  setLevelInputOf,
  shownProjectOf,
  type AutonomyBoundaryView,
  type AutonomyLevelView,
} from "./settings-autonomy-model";
import { useBusyAction } from "./settings-blocks";
import { Button, ConfirmBlock, StatusTabs, ToneText, type Styles, type Theme } from "./ui";

/**
 * The project's action boundary: its name and what it does, one switch, since
 * when it is on, and the confirmation of the side pressed, in place (Cancel
 * first). Hook-free.
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
  return (
    <View style={[styles.card, { gap: 6 }]} accessibilityLabel={view.accessibilityLabel}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.body, { color: theme.colors.foreground }]}>{view.label}</Text>
          <Text style={[styles.body, { fontSize: 11 }]}>{view.since === null ? view.caption : `${view.since}. ${view.caption}`}</Text>
        </View>
        <Button
          label={view.toggle.label}
          kind={view.on ? "primary" : "secondary"}
          accessibilityRole="switch"
          accessibilityLabel={view.toggle.accessibilityLabel}
          accessibilityState={{ checked: view.on, disabled: !view.toggle.pressable }}
          disabled={!view.toggle.pressable}
          onPress={onToggle}
          styles={styles}
        />
      </View>
      {view.confirm === null ? null : (
        <ConfirmBlock dialog={view.confirm} busy={busy} busyLabel="Saving…" onConfirm={onConfirm} onCancel={onCancel} styles={styles} theme={theme} />
      )}
    </View>
  );
}

/**
 * One project's level: the five stops in a row (one radio group), what the
 * shown level means, the confirmation of Turbo or Full auto while it is
 * asked, the nine classes in three columns with who decides each, and a
 * failed change's reason. Hook-free.
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
  return (
    <View style={[styles.card, { gap: 10 }]}>
      <View style={{ gap: 2 }}>
        <Text style={styles.sectionTitle}>{view.title}</Text>
        <Text style={[styles.body, { fontSize: 11 }]}>{view.levelLine}</Text>
      </View>
      <View accessibilityRole="radiogroup" accessibilityLabel={`Autonomy level of ${view.title}`} style={styles.chipRow}>
        {view.stops.map((stop) => (
          <Button
            key={stop.level}
            label={stop.label}
            kind={stop.selected ? "primary" : "secondary"}
            accessibilityRole="radio"
            accessibilityLabel={stop.accessibilityLabel}
            accessibilityState={{ selected: stop.selected, checked: stop.selected, disabled: !stop.enabled }}
            disabled={!stop.enabled}
            onPress={() => onPick(stop.level)}
            styles={styles}
          />
        ))}
      </View>
      <Text style={[styles.body, { color: theme.colors.foreground }]}>{view.summary}</Text>
      {view.confirm === null ? null : (
        <ConfirmBlock dialog={view.confirm.dialog} busy={busy} busyLabel="Saving…" onConfirm={onConfirm} onCancel={onCancel} styles={styles} theme={theme} />
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {view.classes.map((entry) => (
          <View key={entry.decisionClass} accessibilityLabel={`${entry.label}: ${entry.who}`} style={{ width: "33.33%", paddingVertical: 4, paddingRight: 8, gap: 2 }}>
            <Text style={styles.body} numberOfLines={1}>
              {entry.label}
            </Text>
            <Text style={styles.mono}>{entry.who}</Text>
          </View>
        ))}
      </View>
      <Text style={[styles.body, { fontSize: 11 }]}>{view.legend}</Text>
      {error === null ? null : (
        <ToneText tone="danger" selectable styles={styles} theme={theme}>
          {error}
        </ToneText>
      )}
    </View>
  );
}

/**
 * The Autonomy group's body: what the levels are for, the project tabs
 * (projects by name, as Insights names them, each with its level), the chosen
 * project's level and its action boundary. A change returns the whole
 * policy, which `onSaved` puts in the shared query.
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
    return (
      <View style={{ gap: 10 }}>
        <Text style={[styles.body, { fontSize: 11 }]}>{AUTONOMY_MEANING}</Text>
        <Text style={styles.body}>{AUTONOMY_NO_PROJECTS}</Text>
      </View>
    );
  }
  const view = autonomyLevelView({ policy, project, busy, confirmingLevel, confirmingBoundary });
  return (
    <View style={{ gap: 10 }}>
      <Text style={[styles.body, { fontSize: 11 }]}>{AUTONOMY_MEANING}</Text>
      {list.length > 1 ? (
        <StatusTabs
          tabs={autonomyTabs(list, policy)}
          selected={project.id}
          onSelect={(key) => {
            setError(null);
            setConfirmingLevel(null);
            setConfirmingBoundary(null);
            setChosen(key);
          }}
          styles={styles}
        />
      ) : null}
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
