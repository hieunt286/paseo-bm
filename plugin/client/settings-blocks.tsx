/**
 * The blocks of the Settings section (autonomy design §A.12), from the former
 * Setup screen (delta 20260916-setup-screen): "Roles & models" (delta 20260921
 * §4.3.1) — each role's provider, model, thinking and mode, with an Edit form
 * that saves through `roles.save-settings`, and under a role whose fallback
 * chain is offered, its policy and entries, saved through
 * `roles.save-fallback` (§4.4.3) — the beads tools `br` / `bv` with a
 * confirmed Install, the agent skills, Paseo's agent tools and the cleanup.
 * `settings-section.tsx` places them.
 *
 * Wording lives in `settings-roles-model.ts` (roles and fallbacks) and
 * `settings-machine-model.ts` (the machine's set-up). Every confirmation is a
 * `ConfirmBlock`, Cancel first, except the cleanup's data question, whose safe
 * answer ("Keep my data") is itself the first button. Client rules: React
 * Native primitives only, colours from the theme, no Node import, no `server/`
 * import.
 */
import { useRpc } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/react-native";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  rolesOptionsRpc,
  rolesSaveFallbackRpc,
  rolesSaveSettingsRpc,
  rolesSettingsRpc,
  setupCleanupRpc,
  setupGrantAgentToolsRpc,
  setupInstallSkillsRpc,
  setupInstallToolRpc,
  type BmRole,
  type FallbackEntryInput,
  type FallbackSettings,
  type RoleSetting,
  type RolesOptions,
  type RolesSettings,
  type SetupStatus,
} from "../shared/contracts";
import { RADIUS } from "./styles";
import { MONO } from "./text-tabs";
import { toolRowView } from "./tools-screen-model";
import { toneColor, type Badge } from "./tone";
import { errorMessageOf } from "./errors";
import {
  AGENT_TOOLS_DIALOG,
  CLEANUP_BUTTON_ACCESSIBILITY_LABEL,
  CLEANUP_BUTTON_LABEL,
  CLEANUP_DATA_DIALOG,
  agentToolsBlock,
  cleanupDataQuestion,
  cleanupInput,
  cleanupReport,
  cleanupWarningDialog,
  installDialog,
  skillsDialog,
  type CleanupReport,
} from "./settings-machine-model";
import {
  FALLBACK_AUTO_RETIRED_ACK,
  FALLBACK_POLICY_CHOICES,
  ROLES_APPLY_NOTICE,
  addFallback,
  applySavedRole,
  canAddFallback,
  entryAsSetting,
  entryOfDraft,
  fallbackAutoRetiredNotice,
  fallbackDraftChanged,
  fallbackDraftOf,
  fallbackEntryText,
  fallbackPriceText,
  isSettingsConflict,
  moveFallback,
  providerLabel,
  removeFallback,
  replaceFallback,
  roleDraftOf,
  roleFormView,
  reviewerFamilyNote,
  roleBoundaryNote,
  roleRows,
  rowOptionProviders,
  saveErrorText,
  saveFallbackInput,
  saveSettingsInput,
  savedNotes,
  type FallbackDraft,
  type RoleChoice,
  type RoleDraft,
  type RoleFormView,
  type SetupRole,
} from "./settings-roles-model";
import { Button, Chip, ConfirmBlock, RoleMark, ToneText, type Styles, type Theme } from "./ui";

/**
 * The square switch of the flat surface (the approved mockup): 44×24, the
 * accent when on with its square knob at the right, the border colour when
 * off with a muted knob at the left. Hook-free.
 */
export function SquareSwitch({ on, disabled = false, accessibilityLabel, onPress, theme }: {
  on: boolean;
  disabled?: boolean;
  accessibilityLabel: string;
  onPress: () => void;
  theme: Theme;
}) {
  const { colors } = theme;
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: on, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ width: 44, height: 24, backgroundColor: on ? colors.accent : colors.border, opacity: disabled ? 0.6 : 1 }}
    >
      <View
        style={{
          position: "absolute",
          top: 3,
          width: 18,
          height: 18,
          backgroundColor: on ? colors.accentForeground : colors.foregroundMuted,
          ...(on ? { right: 3 } : { left: 3 }),
        }}
      />
    </Pressable>
  );
}

/**
 * The busy flag of one action, and the one way a Settings action runs:
 * `run(action, onFailure)` sets the flag, awaits the action and clears the flag
 * whether the action finished or threw; a throw goes to `onFailure`.
 */
export function useBusyAction(): { busy: boolean; run: (action: () => Promise<void>, onFailure: (failure: unknown) => void) => void } {
  const [busy, setBusy] = useState(false);
  const run = (action: () => Promise<void>, onFailure: (failure: unknown) => void) => {
    setBusy(true);
    void (async () => {
      try {
        await action();
      } catch (failure) {
        onFailure(failure);
      } finally {
        setBusy(false);
      }
    })();
  };
  return { busy, run };
}

function CopyButton({ text, label, styles }: { text: string; label: string; styles: Styles }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      label={copied ? "Copied" : "Copy"}
      kind="secondary"
      accessibilityLabel={copied ? "Copied" : `Copy: ${label}`}
      onPress={() => {
        void copyText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
          () => setCopied(false),
        );
      }}
      styles={styles}
    />
  );
}

export function CommandLine({ label, command, styles, theme }: { label: string; command: string; styles: Styles; theme: Theme }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.body}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text
          style={[styles.mono, { flex: 1, backgroundColor: theme.colors.surface0, padding: 6, borderRadius: RADIUS }]}
          selectable
        >
          {command}
        </Text>
        <CopyButton text={command} label={label} styles={styles} />
      </View>
    </View>
  );
}

/** What an install run says: its line in its tone, then the last lines of its output. */
export interface RunResult {
  text: string;
  tone: "success" | "danger";
  tail: string[];
}

/** A run's result under its button: the line, then the output tail when there is one. Hook-free. */
export function RunResultView({ result, styles, theme }: { result: RunResult; styles: Styles; theme: Theme }) {
  return (
    <View style={{ gap: 2 }}>
      <ToneText tone={result.tone} styles={styles} theme={theme}>{result.text}</ToneText>
      {result.tail.length === 0 ? null : (
        <Text style={[styles.mono, { backgroundColor: theme.colors.surface0, padding: 6, borderRadius: RADIUS }]} selectable>
          {result.tail.join("\n")}
        </Text>
      )}
    </View>
  );
}

const ROLES_SETTINGS_KEY = ["paseo-bm", "setup", "roles-settings"] as const;
const roleOptionsKey = (provider: string) => ["paseo-bm", "setup", "role-options", provider] as const;

/** One field of the Edit form: a title and a row of chips, the selected one marked. */
function ChoiceField({ title, choices, selected, onSelect, styles, theme }: {
  title: string;
  choices: RoleChoice[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.body}>{title}</Text>
      <View style={styles.chipRow}>
        {choices.map((choice) => {
          const on = choice.id === selected;
          return (
            <Chip
              key={choice.id === null ? "(not set)" : `id:${choice.id}`}
              badge={{ text: choice.label, tone: on ? "info" : "muted" }}
              selected={on}
              onPress={() => onSelect(choice.id)}
              styles={styles}
              theme={theme}
            />
          );
        })}
      </View>
    </View>
  );
}

/** What `RoleFields` draws, from `useRoleForm`. */
export interface RoleFieldsProps {
  view: RoleFormView;
  /** `roles.options` of the drafted provider is loading. */
  loading: boolean;
  /** Why `roles.options` failed; it replaces the blocker line. */
  error: string | null;
  onChange: (next: (draft: RoleDraft) => RoleDraft) => void;
}

/**
 * The fields both Edit forms share, a role's and a fallback entry's
 * (`roleFormView`): provider, model and its price, thinking, mode, and why the
 * form cannot finish yet. Hook-free.
 */
export function RoleFields({ view, loading, error, onChange, styles, theme }: RoleFieldsProps & { styles: Styles; theme: Theme }) {
  const set = (patch: Partial<RoleDraft>) => onChange((current) => ({ ...current, ...patch }));
  return (
    <>
      {view.providers.length === 0 ? (
        <Text style={styles.body}>Paseo reports no available provider right now.</Text>
      ) : (
        <ChoiceField
          title="Provider"
          choices={view.providers.map((provider) => ({ id: provider, label: providerLabel(provider) }))}
          selected={view.draft.baseProvider === "" ? null : view.draft.baseProvider}
          onSelect={(id) => set({ baseProvider: id ?? "" })}
          styles={styles}
          theme={theme}
        />
      )}
      {loading ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {error === null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{error}</ToneText>}
      {view.models.length === 0 ? null : (
        <ChoiceField
          title="Model"
          choices={view.models.map((model) => ({ id: model.id, label: model.label }))}
          selected={view.draft.model}
          onSelect={(id) => set({ model: id })}
          styles={styles}
          theme={theme}
        />
      )}
      {view.price === null ? null : <Text style={styles.body}>{view.price}</Text>}
      {view.thinking.length === 0 ? null : (
        <ChoiceField
          title="Thinking"
          choices={view.thinking}
          selected={view.draft.thinkingOptionId}
          onSelect={(id) => set({ thinkingOptionId: id })}
          styles={styles}
          theme={theme}
        />
      )}
      {view.modes.length === 0 ? null : (
        <ChoiceField
          title="Mode"
          choices={view.modes}
          selected={view.draft.modeId}
          onSelect={(id) => set({ modeId: id })}
          styles={styles}
          theme={theme}
        />
      )}
      {view.modeNote === null ? null : <ToneText tone="warning" styles={styles} theme={theme}>{view.modeNote}</ToneText>}
      {view.blocker === null || error !== null ? null : <Text style={styles.body}>{view.blocker}</Text>}
    </>
  );
}

/**
 * The state of one Edit form, a role's or a fallback entry's: the draft, the
 * drafted provider's `roles.options`, and what the form shows.
 */
function useRoleForm(role: SetupRole, setting: RoleSetting, available: readonly string[]): RoleFieldsProps {
  const getOptions = useRpc(rolesOptionsRpc);
  const [draft, setDraft] = useState<RoleDraft>(() => roleDraftOf(setting));
  const options = useQuery({
    queryKey: roleOptionsKey(draft.baseProvider),
    queryFn: () => getOptions({ provider: draft.baseProvider }),
    enabled: draft.baseProvider !== "",
  });
  return {
    view: roleFormView({ role, setting, available, draft, options: options.data }),
    loading: options.isLoading,
    error: options.isError ? errorMessageOf(options.error) : null,
    onChange: setDraft,
  };
}

/**
 * The Edit form of one role (design §4.3.1). `revision` is the one the form
 * was opened with: a save against a configuration changed since then is
 * refused with `E_ROLE_SETTINGS_CONFLICT`, and only reopening takes the new one.
 */
function RoleEditForm({ role, label, setting, available, revision, styles, theme, onClose, onSaved }: {
  role: SetupRole;
  label: string;
  setting: RoleSetting;
  available: readonly string[];
  revision: string;
  styles: Styles;
  theme: Theme;
  onClose: () => void;
  onSaved: (notes: Badge[]) => void;
}) {
  const saveSettings = useRpc(rolesSaveSettingsRpc);
  const queryClient = useQueryClient();
  const form = useRoleForm(role, setting, available);
  const { busy: saving, run } = useBusyAction();
  const [error, setError] = useState<string | null>(null);
  const input = saveSettingsInput(revision, role, form.view.draft);
  const canSave = input !== null && form.view.blocker === null && form.view.changed && !saving;

  const save = () => {
    if (input === null) return;
    run(
      async () => {
        setError(null);
        const result = await saveSettings(input);
        queryClient.setQueryData<RolesSettings>(ROLES_SETTINGS_KEY, (old) => (old === undefined ? old : applySavedRole(old, result)));
        void queryClient.invalidateQueries({ queryKey: ROLES_SETTINGS_KEY });
        onSaved(savedNotes(result));
      },
      (failure) => {
        setError(saveErrorText(failure));
        // Show the configuration as it is now; this form keeps its revision, so only reopening saves over it.
        if (isSettingsConflict(failure)) void queryClient.invalidateQueries({ queryKey: ROLES_SETTINGS_KEY });
      },
    );
  };

  return (
    <View style={[styles.card, { backgroundColor: theme.colors.surface0, gap: 8 }]}>
      <Text style={styles.sectionTitle}>{`Edit ${label}`}</Text>
      <RoleFields {...form} styles={styles} theme={theme} />
      <View style={styles.chipRow}>
        <Button
          label={saving ? "Saving…" : "Save"}
          kind="primary"
          accessibilityLabel={`Save the ${label} settings`}
          accessibilityState={{ disabled: !canSave, busy: saving }}
          disabled={!canSave}
          onPress={save}
          style={canSave ? null : { opacity: 0.5 }}
          styles={styles}
        />
        <Button
          label="Cancel"
          kind="secondary"
          accessibilityLabel={`Cancel: keep the ${label} settings as they are`}
          disabled={saving}
          onPress={onClose}
          styles={styles}
        />
      </View>
      {error === null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{error}</ToneText>}
    </View>
  );
}

/**
 * The Edit form of one fallback entry: the same fields and rules as a role's
 * form (`roleFormView`), but it hands the entry back to its chain instead of
 * saving; the chain is saved as a whole.
 */
function FallbackEntryForm({ role, entry, available, styles, theme, onDone, onCancel }: {
  role: BmRole;
  entry: FallbackEntryInput | null;
  available: readonly string[];
  styles: Styles;
  theme: Theme;
  onDone: (entry: FallbackEntryInput) => void;
  onCancel: () => void;
}) {
  const setting = useMemo(() => entryAsSetting(role, entry), [role, entry]);
  const form = useRoleForm(role, setting, available);
  const done = form.view.blocker === null ? entryOfDraft(form.view.draft) : null;

  return (
    <View style={[styles.card, { backgroundColor: theme.colors.surface0, gap: 8 }]}>
      <Text style={styles.sectionTitle}>{entry === null ? "Add fallback" : "Edit fallback"}</Text>
      <RoleFields {...form} styles={styles} theme={theme} />
      <View style={styles.chipRow}>
        <Button
          label={entry === null ? "Add" : "Done"}
          kind="primary"
          accessibilityLabel={entry === null ? "Add this fallback" : "Done editing this fallback"}
          accessibilityState={{ disabled: done === null }}
          disabled={done === null}
          onPress={() => done !== null && onDone(done)}
          style={done === null ? { opacity: 0.5 } : null}
          styles={styles}
        />
        <Button label="Cancel" kind="secondary" accessibilityLabel="Cancel: leave this fallback as it is" onPress={onCancel} styles={styles} />
      </View>
    </View>
  );
}

/** A small text button of an entry row: ↑, ↓, Edit, Remove. */
function RowButton({ label, accessibilityLabel, disabled, onPress, styles }: {
  label: string;
  accessibilityLabel: string;
  disabled?: boolean;
  onPress: () => void;
  styles: Styles;
}) {
  return (
    <Button
      label={label}
      kind="secondary"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      style={disabled ? { opacity: 0.4 } : null}
      styles={styles}
    />
  );
}

/**
 * The fallback chain of one role (§4.3.1): the policy, the entries with
 * reorder, edit and remove, and "Add fallback". Edits stay local until Save;
 * the block keeps the `revision` it had when the user started editing, so a
 * save over a configuration changed since then is refused. A chain still
 * stored with the retired Auto switch shows its notice once, with a button
 * that saves the chain as shown (ADR-022 decision 4); any save ends it.
 */
function FallbackBlock({ chain, label, revision, available, optionsOf, styles, theme }: {
  chain: FallbackSettings;
  label: string;
  revision: string;
  available: readonly string[];
  optionsOf: (provider: string) => RolesOptions | undefined;
  styles: Styles;
  theme: Theme;
}) {
  const saveFallback = useRpc(rolesSaveFallbackRpc);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ draft: FallbackDraft; revision: string } | null>(null);
  const [form, setForm] = useState<{ index: number | null } | null>(null);
  const { busy: saving, run } = useBusyAction();
  const [notes, setNotes] = useState<Badge[]>([]);
  const [error, setError] = useState<string | null>(null);
  const draft = editing?.draft ?? fallbackDraftOf(chain);
  const changed = editing !== null && fallbackDraftChanged(chain, editing.draft);
  const retired = fallbackAutoRetiredNotice(chain);

  const edit = (next: (current: FallbackDraft) => FallbackDraft) => {
    setNotes([]);
    setError(null);
    setEditing((current) => ({ draft: next(current?.draft ?? fallbackDraftOf(chain)), revision: current?.revision ?? revision }));
  };

  const save = (next: { draft: FallbackDraft; revision: string } | null = editing) => {
    if (next === null) return;
    run(
      async () => {
        setError(null);
        const result = await saveFallback(saveFallbackInput(next.revision, chain.role, next.draft));
        setEditing(null);
        setNotes(savedNotes(result));
        void queryClient.invalidateQueries({ queryKey: ROLES_SETTINGS_KEY });
      },
      (failure) => {
        setError(saveErrorText(failure));
        if (isSettingsConflict(failure)) void queryClient.invalidateQueries({ queryKey: ROLES_SETTINGS_KEY });
      },
    );
  };

  return (
    <View style={{ gap: 6, paddingLeft: 12 }}>
      <View style={[styles.chipRow, { alignItems: "center" }]}>
        <Text style={styles.body}>On a usage limit:</Text>
        {FALLBACK_POLICY_CHOICES.map((choice) => {
          const on = draft.policy === choice.id;
          return (
            <Chip
              key={choice.id}
              badge={{ text: choice.label, tone: on ? "info" : "muted" }}
              selected={on}
              onPress={() => edit((current) => ({ ...current, policy: choice.id }))}
              styles={styles}
              theme={theme}
            />
          );
        })}
      </View>
      {retired === null ? null : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <ToneText tone="warning" style={{ flex: 1, minWidth: 160 }} styles={styles} theme={theme}>{retired}</ToneText>
          {editing === null ? (
            <RowButton
              label={FALLBACK_AUTO_RETIRED_ACK}
              accessibilityLabel={`Save the ${label} fallbacks as shown`}
              disabled={saving}
              onPress={() => save({ draft: fallbackDraftOf(chain), revision })}
              styles={styles}
            />
          ) : null}
        </View>
      )}
      {draft.entries.map((entry, index) => {
        const saved = editing === null ? chain.entries[index] : undefined;
        const price = saved === undefined ? null : fallbackPriceText(saved);
        return (
          <View key={`${index}:${entry.baseProvider}:${entry.model}`} style={{ gap: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Text style={styles.body}>{`Fallback ${index + 1}`}</Text>
              <Text style={[styles.body, { flex: 1, minWidth: 160 }]} selectable>
                {fallbackEntryText(entry, optionsOf(entry.baseProvider))}
              </Text>
              <RowButton label="↑" accessibilityLabel={`Move ${label} fallback ${index + 1} up`} disabled={index === 0} onPress={() => edit((current) => moveFallback(current, index, -1))} styles={styles} />
              <RowButton
                label="↓"
                accessibilityLabel={`Move ${label} fallback ${index + 1} down`}
                disabled={index === draft.entries.length - 1}
                onPress={() => edit((current) => moveFallback(current, index, 1))}
                styles={styles}
              />
              <RowButton label="Edit" accessibilityLabel={`Edit ${label} fallback ${index + 1}`} onPress={() => setForm({ index })} styles={styles} />
              <RowButton label="Remove" accessibilityLabel={`Remove ${label} fallback ${index + 1}`} onPress={() => edit((current) => removeFallback(current, index))} styles={styles} />
            </View>
            {price === null ? null : <Text style={styles.body}>{price}</Text>}
            {form?.index === index ? (
              <FallbackEntryForm
                role={chain.role}
                entry={entry}
                available={available}
                styles={styles}
                theme={theme}
                onDone={(next) => {
                  edit((current) => replaceFallback(current, index, next));
                  setForm(null);
                }}
                onCancel={() => setForm(null)}
              />
            ) : null}
          </View>
        );
      })}
      {form !== null && form.index === null ? (
        <FallbackEntryForm
          role={chain.role}
          entry={null}
          available={available}
          styles={styles}
          theme={theme}
          onDone={(next) => {
            edit((current) => addFallback(current, next));
            setForm(null);
          }}
          onCancel={() => setForm(null)}
        />
      ) : canAddFallback(draft) ? (
        <View style={styles.chipRow}>
          <RowButton label="+ Add fallback" accessibilityLabel={`Add a fallback for the ${label}`} onPress={() => setForm({ index: null })} styles={styles} />
        </View>
      ) : null}
      {editing === null ? null : (
        <View style={styles.chipRow}>
          <Button
            label={saving ? "Saving…" : "Save fallbacks"}
            kind="primary"
            accessibilityLabel={`Save the ${label} fallbacks`}
            accessibilityState={{ disabled: !changed || saving, busy: saving }}
            disabled={!changed || saving}
            onPress={() => save()}
            style={changed && !saving ? null : { opacity: 0.5 }}
            styles={styles}
          />
          <Button
            label="Discard"
            kind="secondary"
            accessibilityLabel={`Discard the changes to the ${label} fallbacks`}
            disabled={saving}
            onPress={() => {
              setEditing(null);
              setForm(null);
              setError(null);
            }}
            styles={styles}
          />
        </View>
      )}
      {notes.map((line, index) => (
        <ToneText key={`${index}:${line.text}`} tone={line.tone} styles={styles} theme={theme}>
          {line.text}
        </ToneText>
      ))}
      {error === null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{error}</ToneText>}
    </View>
  );
}

/**
 * The line under the Reviewer's row when it runs on the Worker's model family
 * (`reviewerFamilyNote`, autonomy design §C.5); nothing otherwise. Hook-free.
 */
export function ReviewerFamilyNoteView({ note, styles, theme }: { note: Badge | null; styles: Styles; theme: Theme }) {
  if (note === null) return null;
  return (
    <ToneText tone={note.tone} styles={styles} theme={theme}>
      {note.text}
    </ToneText>
  );
}

/**
 * "Roles & models": one row per role in the order `roles.settings` returns,
 * each with an Edit form; under the Reviewer's, the same-family line.
 */
export function RolesSection({ styles, theme }: { styles: Styles; theme: Theme }) {
  const getSettings = useRpc(rolesSettingsRpc);
  const getOptions = useRpc(rolesOptionsRpc);
  const settings = useQuery({ queryKey: ROLES_SETTINGS_KEY, queryFn: () => getSettings({}) });
  const data = settings.data;
  const providers = data === undefined ? [] : rowOptionProviders(data);
  const optionQueries = useQueries({
    queries: providers.map((provider) => ({ queryKey: roleOptionsKey(provider), queryFn: () => getOptions({ provider }) })),
  });
  const optionsOf = (provider: string) => optionQueries[providers.indexOf(provider)]?.data;
  const rows = data === undefined ? [] : roleRows(data, optionsOf);
  const familyNote = data === undefined ? null : reviewerFamilyNote(data);
  const [editing, setEditing] = useState<{ role: SetupRole; revision: string } | null>(null);
  const [notes, setNotes] = useState<{ role: SetupRole; lines: Badge[] } | null>(null);

  return (
    <>
      <Text style={styles.sectionTitle}>Roles & models</Text>
      {settings.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {settings.isError ? (
        <ToneText tone="danger" styles={styles} theme={theme}>{errorMessageOf(settings.error)}</ToneText>
      ) : null}
      {data === undefined ? null : (
        <View style={[styles.card, { gap: 10 }]}>
          {rows.map((row) => {
            const open = editing?.role === row.role;
            return (
              <View key={row.role} style={{ gap: 6 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <RoleMark kind={row.mark} theme={theme} />
                  <Text style={styles.sectionTitle}>{row.label}</Text>
                  <Text style={[styles.body, { flex: 1, minWidth: 160 }]} selectable>
                    {row.text}
                  </Text>
                  <Button
                    label={open ? "Close" : "Edit"}
                    kind="secondary"
                    accessibilityLabel={open ? `Close the ${row.label} form` : `Edit the ${row.label} provider, model, thinking and mode`}
                    accessibilityState={{ expanded: open }}
                    onPress={() => {
                      setNotes(null);
                      setEditing(open ? null : { role: row.role, revision: data.revision });
                    }}
                    styles={styles}
                  />
                </View>
                {row.role === "reviewer" ? <ReviewerFamilyNoteView note={familyNote} styles={styles} theme={theme} /> : null}
                <ReviewerFamilyNoteView note={roleBoundaryNote(row.setting)} styles={styles} theme={theme} />
                {notes?.role === row.role
                  ? notes.lines.map((line, index) => (
                      <ToneText key={`${index}:${line.text}`} tone={line.tone} styles={styles} theme={theme}>
                        {line.text}
                      </ToneText>
                    ))
                  : null}
                {row.fallback === null ? null : (
                  <FallbackBlock
                    chain={row.fallback}
                    label={row.label}
                    revision={data.revision}
                    available={data.providers}
                    optionsOf={optionsOf}
                    styles={styles}
                    theme={theme}
                  />
                )}
                {open ? (
                  <RoleEditForm
                    role={row.role}
                    label={row.label}
                    setting={row.setting}
                    available={data.providers}
                    revision={editing.revision}
                    styles={styles}
                    theme={theme}
                    onClose={() => setEditing(null)}
                    onSaved={(lines) => {
                      setEditing(null);
                      setNotes({ role: row.role, lines });
                    }}
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      )}
      {data?.warnings.map((warning) => (
        <ToneText key={warning} tone="warning" styles={styles} theme={theme}>
          {warning}
        </ToneText>
      ))}
      <Text style={styles.body}>{ROLES_APPLY_NOTICE}</Text>
    </>
  );
}

/**
 * One command-line tool as a row of Tools & skills (the approved mockup): the
 * name in mono, what it is with its version, and on the right "installed",
 * the update available, or Install… behind its confirmation (Cancel first).
 * A missing tool says where it was looked for; an update shows its command.
 */
export function ToolCard({ tool, first = false, styles, theme, onInstalled }: {
  tool: SetupStatus["tools"][number];
  /** The first row draws the top border too. */
  first?: boolean;
  styles: Styles;
  theme: Theme;
  onInstalled: () => void;
}) {
  const install = useRpc(setupInstallToolRpc);
  const [confirming, setConfirming] = useState(false);
  const { busy, run } = useBusyAction();
  const [result, setResult] = useState<RunResult | null>(null);
  const row = toolRowView(tool);
  const installable = tool.path === null && tool.installCommand !== null && (tool.id === "br" || tool.id === "bv");
  const { colors } = theme;

  const confirm = () => {
    const id = tool.id;
    if (id === "bd") return;
    run(
      async () => {
        setResult(null);
        const done = await install({ tool: id, confirmed: true });
        setResult({ text: `Installed with \`${done.command}\`.`, tone: "success", tail: done.tail });
        onInstalled();
        setConfirming(false);
      },
      (failure) => {
        setResult({ text: errorMessageOf(failure), tone: "danger", tail: [] });
        setConfirming(false);
      },
    );
  };

  const stateColor = row.state.kind === "installed" ? colors.accent : row.state.kind === "update" ? colors.statusWarning : colors.statusDanger;
  return (
    <View
      accessibilityLabel={`${row.name}: ${row.description}; ${row.state.text}`}
      style={{
        gap: 8,
        paddingVertical: 13,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        ...(first ? { borderTopWidth: 1, borderTopColor: colors.border } : {}),
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Text style={{ width: 140, color: colors.foreground, fontSize: 14, fontFamily: MONO }}>{row.name}</Text>
        <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: 14 }} numberOfLines={2}>
          {row.description}
        </Text>
        {installable && !confirming ? (
          <Button
            label={`Install ${tool.id}…`}
            kind="primary"
            accessibilityLabel={`Install ${tool.id}: asks before anything runs`}
            onPress={() => setConfirming(true)}
            style={{ borderRadius: 0, paddingVertical: 6 }}
            styles={styles}
          />
        ) : (
          <Text style={{ minWidth: 120, textAlign: "right", color: stateColor, fontSize: 13 }}>{row.state.text}</Text>
        )}
      </View>
      {tool.path === null ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Not found on the daemon's PATH or the usual install folders.</Text>
      ) : null}
      {installable ? (
        confirming ? (
          <ConfirmBlock
            dialog={installDialog(tool)}
            busy={busy}
            busyLabel="Installing… (up to 5 minutes)"
            onCancel={() => setConfirming(false)}
            onConfirm={confirm}
            styles={styles}
            theme={theme}
          />
        ) : (
          <CommandLine label="Install command" command={tool.installCommand!} styles={styles} theme={theme} />
        )
      ) : tool.path !== null && row.state.kind === "update" && tool.updateCommand !== null ? (
        <CommandLine label="Update it yourself with" command={tool.updateCommand} styles={styles} theme={theme} />
      ) : null}
      {result === null ? null : <RunResultView result={result} styles={styles} theme={theme} />}
    </View>
  );
}

/**
 * Paseo's agent tools (`daemon.mcp.injectIntoAgents`): what the switch is, and
 * turning it on behind its confirmation, Cancel first (design §7.13.3).
 */
export function AgentToolsBlockView({ status, onDone, styles, theme }: {
  status: SetupStatus;
  onDone: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const grant = useRpc(setupGrantAgentToolsRpc);
  const [asking, setAsking] = useState(false);
  const { busy, run } = useBusyAction();
  const [failure, setFailure] = useState<string | null>(null);
  const block = agentToolsBlock(status);
  if (block === null) return null;

  return (
    <View style={[styles.card, { gap: 6 }]}>
      <Text style={styles.sectionTitle}>Paseo agent tools</Text>
      <ToneText tone={block.tone} styles={styles} theme={theme}>{block.text}</ToneText>
      {asking ? (
        <ConfirmBlock
          dialog={AGENT_TOOLS_DIALOG}
          busy={busy}
          busyLabel="Allowing…"
          onCancel={() => setAsking(false)}
          onConfirm={() =>
            run(
              async () => {
                setFailure(null);
                await grant({ confirmed: true });
                setAsking(false);
                onDone();
              },
              (error) => setFailure(errorMessageOf(error)),
            )
          }
          styles={styles}
          theme={theme}
        />
      ) : block.button === null ? null : (
        <Button
          label={block.button}
          kind="primary"
          accessibilityLabel={`${block.button} Asks before anything changes.`}
          onPress={() => setAsking(true)}
          style={{ alignSelf: "flex-start" }}
          styles={styles}
        />
      )}
      {failure === null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{failure}</ToneText>}
    </View>
  );
}

/**
 * The skills CLI run (`setup.install-skills`), behind its confirmation, Cancel
 * first. Uncontrolled it draws its own "Install skills…" button; with `asking`
 * and `onAskingChange` the caller owns the button (Tools & skills' Update all)
 * and this draws only the confirmation and the run's result.
 */
export function SkillsInstallBlock({ command, onDone, asking: askingProp, onAskingChange, styles, theme }: {
  command: string;
  onDone: () => void;
  asking?: boolean;
  onAskingChange?: (asking: boolean) => void;
  styles: Styles;
  theme: Theme;
}) {
  const installSkills = useRpc(setupInstallSkillsRpc);
  const [askingOwn, setAskingOwn] = useState(false);
  const controlled = askingProp !== undefined && onAskingChange !== undefined;
  const asking = controlled ? askingProp : askingOwn;
  const setAsking = controlled ? onAskingChange : setAskingOwn;
  const { busy, run } = useBusyAction();
  const [result, setResult] = useState<RunResult | null>(null);

  return (
    <View style={{ gap: 6 }}>
      {asking ? (
        <ConfirmBlock
          dialog={skillsDialog(command)}
          busy={busy}
          busyLabel="Running… (up to 5 minutes)"
          onCancel={() => setAsking(false)}
          onConfirm={() =>
            run(
              async () => {
                setResult(null);
                const done = await installSkills({ confirmed: true });
                setResult({ text: `Ran \`${done.command}\`, exit ${done.code}.`, tone: "success", tail: done.tail });
                setAsking(false);
                onDone();
              },
              (error) => setResult({ text: errorMessageOf(error), tone: "danger", tail: [] }),
            )
          }
          styles={styles}
          theme={theme}
        />
      ) : controlled ? null : (
        <Button
          label="Install skills…"
          kind="primary"
          accessibilityLabel="Install skills: asks before anything runs"
          onPress={() => setAsking(true)}
          style={{ alignSelf: "flex-start" }}
          styles={styles}
        />
      )}
      {result === null ? null : <RunResultView result={result} styles={styles} theme={theme} />}
    </View>
  );
}

/**
 * The cleanup's second question: the data. "Keep my data" is the first button
 * and the default; "Delete data" is gone while the cleanup runs. Hook-free.
 */
export function CleanupDataView({ question, busy, onKeep, onDelete, styles, theme }: {
  question: string;
  busy: boolean;
  onKeep: () => void;
  onDelete: () => void;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={{ gap: 6 }}>
      <ToneText tone="warning" selectable styles={styles} theme={theme}>
        {question}
      </ToneText>
      <View style={styles.chipRow}>
        <Button
          label={busy ? "Removing…" : CLEANUP_DATA_DIALOG.keepLabel}
          kind="primary"
          accessibilityLabel="Remove the settings and keep my data"
          accessibilityState={{ disabled: busy, busy }}
          disabled={busy}
          onPress={onKeep}
          styles={styles}
        />
        {busy ? null : (
          <Button
            label={CLEANUP_DATA_DIALOG.deleteLabel}
            kind="secondary"
            accessibilityLabel="Remove the settings and delete paseo-bm's data"
            onPress={onDelete}
            textStyle={{ color: toneColor(theme, "danger") }}
            styles={styles}
          />
        )}
      </View>
    </View>
  );
}

/**
 * "Remove paseo-bm's settings": two questions, then one RPC.
 *
 * Two on purpose. The first takes away the configuration, which one press can
 * put back; the second offers to delete the user's history, which nothing can.
 * Each defaults to the safe answer and neither sends anything until it is
 * pressed (design §7.13.7).
 */
export function CleanupBlock({ status, onCleaned, styles, theme }: {
  status: SetupStatus;
  onCleaned: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const cleanup = useRpc(setupCleanupRpc);
  const [step, setStep] = useState<"idle" | "warning" | "data">("idle");
  const { busy, run } = useBusyAction();
  const [failure, setFailure] = useState<string | null>(null);
  const [report, setReport] = useState<CleanupReport | null>(null);

  const remove = (deleteData: boolean) =>
    run(
      async () => {
        setFailure(null);
        setReport(cleanupReport(await cleanup(cleanupInput(deleteData))));
        setStep("idle");
        onCleaned();
      },
      (error) => setFailure(errorMessageOf(error)),
    );

  if (report !== null) {
    return (
      <View style={[styles.card, { gap: 6 }]}>
        <Text style={styles.sectionTitle}>paseo-bm&apos;s settings were removed</Text>
        {report.lines.map((line) => (
          <Text key={line} style={styles.body} selectable>
            {line}
          </Text>
        ))}
        <CommandLine label="Now remove the plugin" command={report.nextCommand} styles={styles} theme={theme} />
      </View>
    );
  }

  const warning = cleanupWarningDialog(status);
  return (
    <View style={{ gap: 6 }}>
      {step === "idle" ? (
        <Button
          label={CLEANUP_BUTTON_LABEL}
          kind="secondary"
          accessibilityLabel={CLEANUP_BUTTON_ACCESSIBILITY_LABEL}
          onPress={() => setStep("warning")}
          style={{ alignSelf: "flex-start", borderColor: toneColor(theme, "danger") }}
          textStyle={{ color: toneColor(theme, "danger") }}
          styles={styles}
        />
      ) : null}
      {step === "warning" ? (
        <ConfirmBlock
          dialog={warning}
          busy={false}
          busyLabel={warning.confirmLabel}
          onCancel={() => setStep("idle")}
          onConfirm={() => setStep("data")}
          styles={styles}
          theme={theme}
        />
      ) : null}
      {step === "data" ? (
        <CleanupDataView
          question={cleanupDataQuestion(status)}
          busy={busy}
          onKeep={() => remove(false)}
          onDelete={() => remove(true)}
          styles={styles}
          theme={theme}
        />
      ) : null}
      {failure === null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{failure}</ToneText>}
    </View>
  );
}
