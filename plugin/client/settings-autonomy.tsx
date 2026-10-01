/**
 * Settings → Autonomy (autonomy design §B.2, §A.12; experience concept §4.4;
 * PRD REQ-121): the owner's policy as one matrix per project — a row per
 * decision class with who decides it — and **Return all to owner**.
 *
 * The matrix sets `owner` or `shadow` (`autonomy.set`, no confirmation) and
 * `delegate` at any time (§B.4, ADR-023): **Delegated** opens, under the row,
 * who decides (the recommended option or the Orchestrator) and a confirmation
 * that says what changes, Cancel first; confirming sends `autonomy.set` with
 * `confirmed: true`. Return all to owner (`autonomy.reset`) is one press: it is
 * the safety path (REQ-121 d). What the rows say is
 * `settings-autonomy-model.ts`; the matrix itself is hook-free and tested with
 * the element-tree helper. Above the rows, **Orchestrator predictions** turns
 * the project's challenger on or off (`autonomy.set-challenger`, §B.3; off by
 * default, no confirmation). Above it, **Action boundary** turns the
 * project's boundary on or off (`autonomy.set-boundary`, §D.2, change-010;
 * off by default), each direction after an in-place confirmation, Cancel
 * first. The owner's precedents follow the matrix
 * (`settings-precedents.tsx`, §B.6).
 *
 * Client rules: React Native primitives only, colours from the theme, project
 * names only (no ids), no Node import, no `server/` import.
 */
import { useRpc } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Text, View } from "react-native";
import type { AutonomyPolicy, AutonomyPredictor } from "../shared/autonomy";
import { autonomyResetRpc, autonomySetBoundaryRpc, autonomySetChallengerRpc, autonomySetRpc } from "../shared/contracts";
import type { DecisionClass } from "../shared/decisions";
import type { InsightsProject } from "./insights-model";
import { errorMessageOf } from "./errors";
import {
  AUTONOMY_MEANING,
  AUTONOMY_NO_PROJECTS,
  autonomyMatrixView,
  autonomyProjects,
  autonomyTabs,
  shownProjectOf,
  type AutonomyBoundaryView,
  type AutonomyChallengerView,
  type AutonomyChoiceView,
  type AutonomyDelegateView,
  type AutonomyMatrixView,
  type AutonomyRowView,
  type DelegateConfirming,
} from "./settings-autonomy-model";
import { useBusyAction } from "./settings-blocks";
import { PrecedentsBlock } from "./settings-precedents";
import { Button, ConfirmBlock, StatusTabs, ToneText, type Styles, type Theme } from "./ui";

/** One choice of a row, drawn filled when it is the current mode. */
function ChoiceView({ choice, onPress, styles }: { choice: AutonomyChoiceView; onPress: () => void; styles: Styles }) {
  return (
    <Button
      label={choice.label}
      kind={choice.selected ? "primary" : "secondary"}
      accessibilityLabel={choice.accessibilityLabel}
      accessibilityState={{ selected: choice.selected, disabled: !choice.enabled }}
      disabled={!choice.enabled}
      onPress={onPress}
      styles={styles}
    />
  );
}

/** A delegation being confirmed, under its row: who decides, then the confirmation (Cancel first). */
function DelegateView({ view, busy, onPredictor, onConfirm, onCancel, styles, theme }: {
  view: AutonomyDelegateView;
  busy: boolean;
  onPredictor: (predictor: AutonomyPredictor) => void;
  onConfirm: () => void;
  onCancel: () => void;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={{ gap: 6, paddingTop: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={[styles.body, { fontSize: 11 }]}>{view.label}</Text>
        {view.predictors.map((choice) => (
          <Button
            key={choice.predictor}
            label={choice.label}
            kind={choice.selected ? "primary" : "secondary"}
            accessibilityLabel={choice.accessibilityLabel}
            accessibilityState={{ selected: choice.selected, disabled: busy }}
            disabled={busy}
            onPress={() => onPredictor(choice.predictor)}
            styles={styles}
          />
        ))}
      </View>
      <ConfirmBlock dialog={view.dialog} busy={busy} busyLabel="Saving…" onConfirm={onConfirm} onCancel={onCancel} styles={styles} theme={theme} />
    </View>
  );
}

/** What a row's delegation confirmation does: choose who decides, confirm, cancel. */
export interface DelegateHandlers {
  onPredictor: (decisionClass: DecisionClass, predictor: AutonomyPredictor) => void;
  onConfirm: (view: AutonomyDelegateView) => void;
  onCancel: () => void;
}

const NO_DELEGATE_HANDLERS: DelegateHandlers = { onPredictor: () => {}, onConfirm: () => {}, onCancel: () => {} };

/** One class: its name, its mode or the Owner / Shadow / Delegated choice, a line saying why or who decides, and a delegation's confirmation while asked. */
function RowView({ row, busy, onChoose, delegate, styles, theme }: {
  row: AutonomyRowView;
  busy: boolean;
  onChoose: (mode: AutonomyChoiceView["mode"]) => void;
  delegate: DelegateHandlers;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={{ gap: 2 }} accessibilityLabel={row.accessibilityLabel}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={[styles.body, { flex: 1, minWidth: 140 }]}>{row.label}</Text>
        {row.fixed ? (
          <ToneText tone="muted" styles={styles} theme={theme}>{row.modeText}</ToneText>
        ) : (
          row.choices.map((choice) => <ChoiceView key={choice.mode} choice={choice} onPress={() => onChoose(choice.mode)} styles={styles} />)
        )}
      </View>
      {row.caption === null ? null : (
        <ToneText tone={row.fixed ? "muted" : "info"} style={{ fontSize: 11 }} styles={styles} theme={theme}>{row.caption}</ToneText>
      )}
      {row.delegate === null ? null : (
        <DelegateView
          view={row.delegate}
          busy={busy}
          onPredictor={(predictor) => delegate.onPredictor(row.decisionClass, predictor)}
          onConfirm={() => delegate.onConfirm(row.delegate!)}
          onCancel={delegate.onCancel}
          styles={styles}
          theme={theme}
        />
      )}
    </View>
  );
}

/** The project's Orchestrator predictions: Off / On, drawn like a row's choice, and what they do. */
function ChallengerView({ view, onSet, styles, theme }: {
  view: AutonomyChallengerView;
  onSet: (enabled: boolean) => void;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={{ gap: 2 }} accessibilityLabel={view.accessibilityLabel}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={[styles.body, { flex: 1, minWidth: 140 }]}>{view.label}</Text>
        {view.choices.map((choice) => (
          <Button
            key={choice.label}
            label={choice.label}
            kind={choice.selected ? "primary" : "secondary"}
            accessibilityLabel={choice.accessibilityLabel}
            accessibilityState={{ selected: choice.selected, disabled: !choice.pressable }}
            disabled={!choice.pressable}
            onPress={() => onSet(choice.enabled)}
            styles={styles}
          />
        ))}
      </View>
      <ToneText tone="muted" style={{ fontSize: 11 }} styles={styles} theme={theme}>{view.caption}</ToneText>
    </View>
  );
}

/**
 * The project's action boundary: Off / On, what it does, since when, and the
 * confirmation of the side pressed, in place (Cancel first).
 */
function BoundaryView({ view, busy, onAsk, onConfirm, onCancel, styles, theme }: {
  view: AutonomyBoundaryView;
  busy: boolean;
  onAsk: (enabled: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={{ gap: 4 }} accessibilityLabel={view.accessibilityLabel}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={[styles.body, { flex: 1, minWidth: 140 }]}>{view.label}</Text>
        {view.choices.map((choice) => (
          <Button
            key={choice.label}
            label={choice.label}
            kind={choice.selected ? "primary" : "secondary"}
            accessibilityLabel={choice.accessibilityLabel}
            accessibilityState={{ selected: choice.selected, disabled: !choice.pressable }}
            disabled={!choice.pressable}
            onPress={() => onAsk(choice.enabled)}
            styles={styles}
          />
        ))}
      </View>
      <ToneText tone="muted" style={{ fontSize: 11 }} styles={styles} theme={theme}>
        {view.since === null ? view.caption : `${view.since}. ${view.caption}`}
      </ToneText>
      {view.confirm === null ? null : (
        <ConfirmBlock dialog={view.confirm} busy={busy} busyLabel="Saving…" onConfirm={onConfirm} onCancel={onCancel} styles={styles} theme={theme} />
      )}
    </View>
  );
}

/**
 * One project's matrix: its name and summary, the action boundary, the
 * Orchestrator predictions, a row per class, Return all to owner, and a
 * failed change's reason. Hook-free.
 */
export function AutonomyMatrix({ view, error, busy = false, onChoose, delegate, onChallenger, onBoundaryAsk, onBoundaryConfirm, onBoundaryCancel, onReset, styles, theme }: {
  view: AutonomyMatrixView;
  error: string | null;
  busy?: boolean;
  onChoose: (decisionClass: DecisionClass, mode: AutonomyChoiceView["mode"]) => void;
  delegate?: DelegateHandlers;
  onChallenger: (enabled: boolean) => void;
  onBoundaryAsk?: (enabled: boolean) => void;
  onBoundaryConfirm?: () => void;
  onBoundaryCancel?: () => void;
  onReset: () => void;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={[styles.card, { gap: 8 }]}>
      <Text style={styles.sectionTitle}>{view.title}</Text>
      <Text style={[styles.body, { fontSize: 11 }]}>{view.summary}</Text>
      <BoundaryView
        view={view.boundary}
        busy={busy}
        onAsk={onBoundaryAsk ?? (() => {})}
        onConfirm={onBoundaryConfirm ?? (() => {})}
        onCancel={onBoundaryCancel ?? (() => {})}
        styles={styles}
        theme={theme}
      />
      <ChallengerView view={view.challenger} onSet={onChallenger} styles={styles} theme={theme} />
      {view.rows.map((row) => (
        <RowView
          key={row.decisionClass}
          row={row}
          busy={busy}
          onChoose={(mode) => onChoose(row.decisionClass, mode)}
          delegate={delegate ?? NO_DELEGATE_HANDLERS}
          styles={styles}
          theme={theme}
        />
      ))}
      <View style={styles.chipRow}>
        <Button
          label={view.reset.label}
          kind="secondary"
          accessibilityLabel={view.reset.accessibilityLabel}
          accessibilityState={{ disabled: !view.reset.enabled }}
          disabled={!view.reset.enabled}
          onPress={onReset}
          styles={styles}
        />
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
 * The Autonomy group's body: what the modes mean, the project tabs (projects
 * by name, as Insights names them) and the chosen project's matrix. A change
 * returns the whole policy, which `onSaved` puts in the shared query.
 */
export function AutonomyGroup({ policy, projects, onSaved, styles, theme }: {
  policy: AutonomyPolicy;
  projects: readonly InsightsProject[];
  onSaved: (policy: AutonomyPolicy) => void;
  styles: Styles;
  theme: Theme;
}) {
  const set = useRpc(autonomySetRpc);
  const reset = useRpc(autonomyResetRpc);
  const setChallenger = useRpc(autonomySetChallengerRpc);
  const setBoundary = useRpc(autonomySetBoundaryRpc);
  const [chosen, setChosen] = useState<string | null>(null);
  // The side of the action boundary whose confirmation is shown, or null.
  const [confirmingBoundary, setConfirmingBoundary] = useState<boolean | null>(null);
  // The delegation whose confirmation is shown, or null.
  const [confirmingDelegate, setConfirmingDelegate] = useState<DelegateConfirming | null>(null);
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
  return (
    <View style={{ gap: 10 }}>
      <Text style={[styles.body, { fontSize: 11 }]}>{AUTONOMY_MEANING}</Text>
      {project === null ? (
        <>
          <Text style={styles.body}>{AUTONOMY_NO_PROJECTS}</Text>
          <PrecedentsBlock projects={list} defaultScope={null} styles={styles} theme={theme} />
        </>
      ) : (
        <>
          {list.length > 1 ? (
            <StatusTabs
              tabs={autonomyTabs(list, policy)}
              selected={project.id}
              onSelect={(key) => {
                setError(null);
                setConfirmingBoundary(null);
                setConfirmingDelegate(null);
                setChosen(key);
              }}
              styles={styles}
            />
          ) : null}
          <AutonomyMatrix
            view={autonomyMatrixView({ policy, project, busy, confirmingBoundary, confirmingDelegate })}
            error={error}
            busy={busy}
            onChoose={(decisionClass, mode) => {
              setError(null);
              if (mode === "delegate") {
                setConfirmingBoundary(null);
                setConfirmingDelegate({ decisionClass, predictor: "recommended" });
                return;
              }
              setConfirmingDelegate(null);
              run(() => set({ workspaceId: project.id, class: decisionClass, mode }));
            }}
            delegate={{
              onPredictor: (decisionClass, predictor) => setConfirmingDelegate({ decisionClass, predictor }),
              onConfirm: (asked) =>
                run(async () => {
                  const saved = await set(asked.input);
                  setConfirmingDelegate(null);
                  return saved;
                }),
              onCancel: () => setConfirmingDelegate(null),
            }}
            onChallenger={(enabled) => run(() => setChallenger({ workspaceId: project.id, enabled }))}
            onBoundaryAsk={(enabled) => {
              setError(null);
              setConfirmingDelegate(null);
              setConfirmingBoundary(enabled);
            }}
            onBoundaryConfirm={() => {
              const enabled = confirmingBoundary;
              if (enabled === null) return;
              run(async () => {
                const saved = await setBoundary({ workspaceId: project.id, enabled, confirmed: true });
                setConfirmingBoundary(null);
                return saved;
              });
            }}
            onBoundaryCancel={() => setConfirmingBoundary(null)}
            onReset={() => {
              setConfirmingDelegate(null);
              run(() => reset({ workspaceId: project.id }));
            }}
            styles={styles}
            theme={theme}
          />
          <PrecedentsBlock projects={list} defaultScope={project.id} styles={styles} theme={theme} />
        </>
      )}
    </View>
  );
}
