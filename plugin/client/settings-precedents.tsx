/**
 * Settings → More → Precedents (autonomy design §B.6, §B.9; PRD REQ-124):
 * the owner's standing answers. Each active
 * precedent shows its project, subject, answer and expiry with **End**
 * (`precedents.end`, a confirmation in place, Cancel first); **Add
 * precedent…** opens a form — project or all, subject, answer, Cancel first —
 * that saves through `precedents.save`. A precedent is also saved from an
 * answered decision's card (`chat-card.tsx`), which refreshes the same query.
 *
 * What the block says is `settings-autonomy-model.ts`; `PrecedentsList` is
 * hook-free and tested with the element-tree helper.
 *
 * Client rules: React Native primitives only, colours from the theme, project
 * names only (no ids), no Node import, no `server/` import.
 */
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Text, TextInput, View } from "react-native";
import { precedentsEndRpc, precedentsListRpc, precedentsSaveRpc } from "../shared/contracts";
import { errorMessageOf } from "./errors";
import { RADIUS } from "./styles";
import {
  PRECEDENTS_QUERY_KEY,
  PRECEDENTS_UI_IDLE,
  openPrecedentForm,
  precedentSaveInputOf,
  precedentsView,
  type AutonomyProject,
  type PrecedentFormState,
  type PrecedentRowView,
  type PrecedentsUi,
  type PrecedentsView,
} from "./settings-autonomy-model";
import { Button, ConfirmBlock, ToneText, type Styles, type Theme } from "./ui";

/** What the owner does in the block. */
export interface PrecedentsHandlers {
  add: () => void;
  form: (change: Partial<PrecedentFormState>) => void;
  cancelForm: () => void;
  save: () => void;
  end: (id: string) => void;
  cancelEnd: () => void;
  confirmEnd: () => void;
}

const INPUT_STYLE = { borderWidth: 1, borderRadius: RADIUS, padding: 8 };

/** One precedent: subject and project, the answer, expiry and source, and End or its confirmation. */
function RowView({ row, busy, on, styles, theme }: { row: PrecedentRowView; busy: boolean; on: PrecedentsHandlers; styles: Styles; theme: Theme }) {
  return (
    <View style={{ gap: 2 }} accessibilityLabel={row.accessibilityLabel}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={[styles.body, { flex: 1, minWidth: 140, color: theme.colors.foreground }]}>{`${row.subject} · ${row.scopeText}`}</Text>
        {row.confirm === null ? (
          <Button
            label={row.end.label}
            kind="secondary"
            accessibilityLabel={row.end.accessibilityLabel}
            accessibilityState={{ disabled: !row.end.enabled }}
            disabled={!row.end.enabled}
            onPress={() => on.end(row.id)}
            styles={styles}
          />
        ) : null}
      </View>
      <Text style={styles.body}>{row.text}</Text>
      <ToneText tone="muted" style={{ fontSize: 11 }} styles={styles} theme={theme}>{`${row.expiresText} · ${row.sourceText}`}</ToneText>
      {row.confirm === null ? null : (
        <ConfirmBlock dialog={row.confirm} busy={busy} busyLabel="Ending…" onConfirm={on.confirmEnd} onCancel={on.cancelEnd} styles={styles} theme={theme} />
      )}
    </View>
  );
}

/**
 * The precedents block, drawn from its view: the title and meaning, a row per
 * active precedent, then Add precedent… or its form, and a failed change's
 * reason. Hook-free.
 */
export function PrecedentsList({ view, on, styles, theme }: { view: PrecedentsView; on: PrecedentsHandlers; styles: Styles; theme: Theme }) {
  const form = view.form;
  return (
    <View style={[styles.card, { gap: 8 }]}>
      <Text style={styles.sectionTitle}>{view.title}</Text>
      <Text style={[styles.body, { fontSize: 11 }]}>{view.meaning}</Text>
      {view.empty === null ? null : <Text style={styles.body}>{view.empty}</Text>}
      {view.rows.map((row) => (
        <RowView key={row.id} row={row} busy={view.busy} on={on} styles={styles} theme={theme} />
      ))}
      {view.add === null ? null : (
        <View style={styles.chipRow}>
          <Button
            label={view.add.label}
            kind="secondary"
            accessibilityLabel={view.add.accessibilityLabel}
            accessibilityState={{ disabled: !view.add.enabled }}
            disabled={!view.add.enabled}
            onPress={on.add}
            styles={styles}
          />
        </View>
      )}
      {form === null ? null : (
        <View style={{ gap: 6 }}>
          <Text style={styles.sectionTitle}>{form.title}</Text>
          <View accessibilityRole="radiogroup" style={styles.chipRow}>
            {form.scopes.map((choice) => (
              <Button
                key={choice.key}
                label={choice.label}
                kind={choice.selected ? "primary" : "secondary"}
                accessibilityRole="radio"
                accessibilityLabel={choice.accessibilityLabel}
                accessibilityState={{ selected: choice.selected, disabled: form.busy }}
                disabled={form.busy}
                onPress={() => on.form({ scope: choice.key })}
                styles={styles}
              />
            ))}
          </View>
          <TextInput
            value={form.subject}
            onChangeText={(subject) => on.form({ subject })}
            editable={!form.busy}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={form.subjectLabel}
            placeholder="subject, e.g. test-layout"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={[styles.mono, INPUT_STYLE, { borderColor: theme.colors.border }]}
          />
          <ToneText tone={form.subjectError === null ? "muted" : "danger"} style={{ fontSize: 11 }} styles={styles} theme={theme}>
            {form.subjectError ?? form.subjectHint}
          </ToneText>
          <TextInput
            value={form.text}
            onChangeText={(text) => on.form({ text })}
            editable={!form.busy}
            multiline
            accessibilityLabel={form.textLabel}
            placeholder="The answer to keep"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={[styles.mono, INPUT_STYLE, { minHeight: 56, borderColor: theme.colors.border }]}
          />
          {form.textError === null ? null : <ToneText tone="danger" style={{ fontSize: 11 }} styles={styles} theme={theme}>{form.textError}</ToneText>}
          <View style={styles.chipRow}>
            {form.busy ? null : (
              <Button label={form.cancelLabel} kind="secondary" accessibilityLabel={form.cancelLabel} onPress={on.cancelForm} styles={styles} />
            )}
            <Button
              label={form.saveLabel}
              kind="primary"
              accessibilityLabel="Save the precedent"
              accessibilityState={{ disabled: !form.saveEnabled }}
              disabled={!form.saveEnabled}
              onPress={on.save}
              styles={styles}
            />
          </View>
        </View>
      )}
      {view.error === null ? null : (
        <ToneText tone="danger" selectable styles={styles} theme={theme}>
          {view.error}
        </ToneText>
      )}
    </View>
  );
}

/**
 * The block with its reads and writes: `precedents.list` once when shown (and
 * after each change here or on a decision card), `precedents.save` from the
 * form, `precedents.end` after its confirmation.
 */
export function PrecedentsBlock({ projects, defaultScope, styles, theme }: {
  /** The projects of Settings, by name: the form's choices and the rows' project names. */
  projects: readonly AutonomyProject[];
  /** Where Add precedent… starts: a project, or null for all projects. */
  defaultScope: string | null;
  styles: Styles;
  theme: Theme;
}) {
  const queryClient = useQueryClient();
  const list = useRpc(precedentsListRpc);
  const save = useRpc(precedentsSaveRpc);
  const end = useRpc(precedentsEndRpc);
  const query = useQuery({ queryKey: PRECEDENTS_QUERY_KEY, queryFn: () => list({}) });
  const [ui, setUi] = useState<PrecedentsUi>(PRECEDENTS_UI_IDLE);

  const run = (change: () => Promise<unknown>, after: PrecedentsUi) =>
    void (async () => {
      setUi({ ...ui, busy: true, error: null });
      try {
        await change();
        setUi(after);
        await queryClient.invalidateQueries({ queryKey: PRECEDENTS_QUERY_KEY });
      } catch (failure) {
        setUi({ ...ui, busy: false, error: errorMessageOf(failure) });
      }
    })();

  if (query.isError) return <ToneText tone="danger" styles={styles} theme={theme}>{errorMessageOf(query.error)}</ToneText>;
  if (query.data === undefined) return <ActivityIndicator color={styles.spinner.color} />;
  const view = precedentsView({ precedents: query.data.precedents, projects, ui, now: new Date() });
  return (
    <PrecedentsList
      view={view}
      on={{
        add: () => setUi({ ...PRECEDENTS_UI_IDLE, form: openPrecedentForm(defaultScope) }),
        form: (change) => {
          if (ui.form !== null) setUi({ ...ui, error: null, form: { ...ui.form, ...change } });
        },
        cancelForm: () => setUi(PRECEDENTS_UI_IDLE),
        save: () => {
          if (ui.form !== null) run(() => save(precedentSaveInputOf(ui.form!)), PRECEDENTS_UI_IDLE);
        },
        end: (id) => setUi({ ...PRECEDENTS_UI_IDLE, ending: id }),
        cancelEnd: () => setUi(PRECEDENTS_UI_IDLE),
        confirmEnd: () => {
          if (ui.ending !== null) run(() => end({ id: ui.ending! }), PRECEDENTS_UI_IDLE);
        },
      }}
      styles={styles}
      theme={theme}
    />
  );
}
