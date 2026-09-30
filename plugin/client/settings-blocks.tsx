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
 * Wording lives in `setup-model.ts`. Client rules: React Native primitives
 * only, colours from the theme, no Node import, no `server/` import.
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
import { toneColor, type Badge } from "./dashboard-model";
import { errorMessageOf } from "./launch-manager";
import {
  AGENT_TOOLS_DIALOG,
  CLEANUP_BUTTON_ACCESSIBILITY_LABEL,
  CLEANUP_BUTTON_LABEL,
  CLEANUP_DATA_DIALOG,
  CLEANUP_WARNING_DIALOG,
  agentToolsBlock,
  FALLBACK_POLICY_CHOICES,
  ROLES_APPLY_NOTICE,
  addFallback,
  applySavedRole,
  canAddFallback,
  cleanupDataQuestion,
  cleanupInput,
  cleanupReport,
  cleanupWarning,
  entryAsSetting,
  entryOfDraft,
  fallbackDraftChanged,
  fallbackDraftOf,
  fallbackEntryText,
  fallbackPolicyWarning,
  fallbackPriceText,
  moveFallback,
  removeFallback,
  skillsDialog,
  replaceFallback,
  saveFallbackInput,
  installWarning,
  isSettingsConflict,
  providerLabel,
  roleDraftOf,
  roleFormView,
  roleRows,
  rowOptionProviders,
  saveErrorText,
  saveSettingsInput,
  savedNotes,
  toolBadge,
  type FallbackDraft,
  type RoleChoice,
  type RoleDraft,
  type CleanupReport,
  type SetupRole,
} from "./setup-model";
import { Chip, ConfirmBlock, RoleMark, type Styles, type Theme } from "./ui";

function CopyButton({ text, label, styles }: { text: string; label: string; styles: Styles }) {
  const [copied, setCopied] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
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
      style={styles.secondaryButton}
    >
      <Text style={styles.secondaryButtonText}>{copied ? "Copied" : "Copy"}</Text>
    </Pressable>
  );
}

export function CommandLine({ label, command, styles, theme }: { label: string; command: string; styles: Styles; theme: Theme }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.body}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text
          style={[styles.mono, { flex: 1, backgroundColor: theme.colors.surface0, padding: 6, borderRadius: 6 }]}
          selectable
        >
          {command}
        </Text>
        <CopyButton text={command} label={label} styles={styles} />
      </View>
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
  const getOptions = useRpc(rolesOptionsRpc);
  const saveSettings = useRpc(rolesSaveSettingsRpc);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RoleDraft>(() => roleDraftOf(setting));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = useQuery({
    queryKey: roleOptionsKey(draft.baseProvider),
    queryFn: () => getOptions({ provider: draft.baseProvider }),
    enabled: draft.baseProvider !== "",
  });
  const view = roleFormView({ role, setting, available, draft, options: options.data });
  const input = saveSettingsInput(revision, role, view.draft);
  const canSave = input !== null && view.blocker === null && view.changed && !saving;

  const save = async () => {
    if (input === null) return;
    setSaving(true);
    setError(null);
    try {
      const result = await saveSettings(input);
      queryClient.setQueryData<RolesSettings>(ROLES_SETTINGS_KEY, (old) => (old === undefined ? old : applySavedRole(old, result)));
      void queryClient.invalidateQueries({ queryKey: ROLES_SETTINGS_KEY });
      setSaving(false);
      onSaved(savedNotes(result));
    } catch (failure) {
      setError(saveErrorText(failure));
      setSaving(false);
      // Show the configuration as it is now; this form keeps its revision, so only reopening saves over it.
      if (isSettingsConflict(failure)) void queryClient.invalidateQueries({ queryKey: ROLES_SETTINGS_KEY });
    }
  };

  return (
    <View style={[styles.card, { backgroundColor: theme.colors.surface0, gap: 8 }]}>
      <Text style={styles.sectionTitle}>{`Edit ${label}`}</Text>
      {view.providers.length === 0 ? (
        <Text style={styles.body}>Paseo reports no available provider right now.</Text>
      ) : (
        <ChoiceField
          title="Provider"
          choices={view.providers.map((provider) => ({ id: provider, label: providerLabel(provider) }))}
          selected={draft.baseProvider === "" ? null : draft.baseProvider}
          onSelect={(id) => setDraft((current) => ({ ...current, baseProvider: id ?? "" }))}
          styles={styles}
          theme={theme}
        />
      )}
      {options.isLoading ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {options.isError ? (
        <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{errorMessageOf(options.error)}</Text>
      ) : null}
      {view.models.length === 0 ? null : (
        <ChoiceField
          title="Model"
          choices={view.models.map((model) => ({ id: model.id, label: model.label }))}
          selected={view.draft.model}
          onSelect={(id) => setDraft((current) => ({ ...current, model: id }))}
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
          onSelect={(id) => setDraft((current) => ({ ...current, thinkingOptionId: id }))}
          styles={styles}
          theme={theme}
        />
      )}
      {view.modes.length === 0 ? null : (
        <ChoiceField
          title="Mode"
          choices={view.modes}
          selected={view.draft.modeId}
          onSelect={(id) => setDraft((current) => ({ ...current, modeId: id }))}
          styles={styles}
          theme={theme}
        />
      )}
      {view.modeNote === null ? null : <Text style={[styles.body, { color: toneColor(theme, "warning") }]}>{view.modeNote}</Text>}
      {view.blocker === null || options.isError ? null : <Text style={styles.body}>{view.blocker}</Text>}
      <View style={styles.chipRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Save the ${label} settings`}
          accessibilityState={{ disabled: !canSave, busy: saving }}
          disabled={!canSave}
          onPress={() => void save()}
          style={[styles.button, canSave ? null : { opacity: 0.5 }]}
        >
          <Text style={styles.buttonText}>{saving ? "Saving…" : "Save"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Cancel: keep the ${label} settings as they are`}
          disabled={saving}
          onPress={onClose}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonText}>Cancel</Text>
        </Pressable>
      </View>
      {error === null ? null : <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{error}</Text>}
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
  const getOptions = useRpc(rolesOptionsRpc);
  const setting = useMemo(() => entryAsSetting(role, entry), [role, entry]);
  const [draft, setDraft] = useState<RoleDraft>(() => roleDraftOf(setting));
  const options = useQuery({
    queryKey: roleOptionsKey(draft.baseProvider),
    queryFn: () => getOptions({ provider: draft.baseProvider }),
    enabled: draft.baseProvider !== "",
  });
  const view = roleFormView({ role, setting, available, draft, options: options.data });
  const done = view.blocker === null ? entryOfDraft(view.draft) : null;

  return (
    <View style={[styles.card, { backgroundColor: theme.colors.surface0, gap: 8 }]}>
      <Text style={styles.sectionTitle}>{entry === null ? "Add fallback" : "Edit fallback"}</Text>
      {view.providers.length === 0 ? (
        <Text style={styles.body}>Paseo reports no available provider right now.</Text>
      ) : (
        <ChoiceField
          title="Provider"
          choices={view.providers.map((provider) => ({ id: provider, label: providerLabel(provider) }))}
          selected={draft.baseProvider === "" ? null : draft.baseProvider}
          onSelect={(id) => setDraft((current) => ({ ...current, baseProvider: id ?? "" }))}
          styles={styles}
          theme={theme}
        />
      )}
      {options.isLoading ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {options.isError ? (
        <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{errorMessageOf(options.error)}</Text>
      ) : null}
      {view.models.length === 0 ? null : (
        <ChoiceField
          title="Model"
          choices={view.models.map((model) => ({ id: model.id, label: model.label }))}
          selected={view.draft.model}
          onSelect={(id) => setDraft((current) => ({ ...current, model: id }))}
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
          onSelect={(id) => setDraft((current) => ({ ...current, thinkingOptionId: id }))}
          styles={styles}
          theme={theme}
        />
      )}
      {view.modes.length === 0 ? null : (
        <ChoiceField
          title="Mode"
          choices={view.modes}
          selected={view.draft.modeId}
          onSelect={(id) => setDraft((current) => ({ ...current, modeId: id }))}
          styles={styles}
          theme={theme}
        />
      )}
      {view.modeNote === null ? null : <Text style={[styles.body, { color: toneColor(theme, "warning") }]}>{view.modeNote}</Text>}
      {view.blocker === null || options.isError ? null : <Text style={styles.body}>{view.blocker}</Text>}
      <View style={styles.chipRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={entry === null ? "Add this fallback" : "Done editing this fallback"}
          accessibilityState={{ disabled: done === null }}
          disabled={done === null}
          onPress={() => done !== null && onDone(done)}
          style={[styles.button, done === null ? { opacity: 0.5 } : null]}
        >
          <Text style={styles.buttonText}>{entry === null ? "Add" : "Done"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel: leave this fallback as it is" onPress={onCancel} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Cancel</Text>
        </Pressable>
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
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      style={[styles.secondaryButton, disabled ? { opacity: 0.4 } : null]}
    >
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </Pressable>
  );
}

/**
 * The fallback chain of one role (§4.3.1): the policy, the entries with
 * reorder, edit and remove, and "Add fallback". Edits stay local until Save;
 * the block keeps the `revision` it had when the user started editing, so a
 * save over a configuration changed since then is refused.
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
  const [saving, setSaving] = useState(false);
  const [notes, setNotes] = useState<Badge[]>([]);
  const [error, setError] = useState<string | null>(null);
  const draft = editing?.draft ?? fallbackDraftOf(chain);
  const changed = editing !== null && fallbackDraftChanged(chain, editing.draft);

  const edit = (next: (current: FallbackDraft) => FallbackDraft) => {
    setNotes([]);
    setError(null);
    setEditing((current) => ({ draft: next(current?.draft ?? fallbackDraftOf(chain)), revision: current?.revision ?? revision }));
  };

  const save = async () => {
    if (editing === null) return;
    setSaving(true);
    setError(null);
    try {
      const result = await saveFallback(saveFallbackInput(editing.revision, chain.role, editing.draft));
      setEditing(null);
      setNotes(savedNotes(result));
      void queryClient.invalidateQueries({ queryKey: ROLES_SETTINGS_KEY });
    } catch (failure) {
      setError(saveErrorText(failure));
      if (isSettingsConflict(failure)) void queryClient.invalidateQueries({ queryKey: ROLES_SETTINGS_KEY });
    } finally {
      setSaving(false);
    }
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
      {fallbackPolicyWarning(chain.role, draft.policy) === null ? null : (
        <Text style={[styles.body, { color: toneColor(theme, "warning") }]}>{fallbackPolicyWarning(chain.role, draft.policy)}</Text>
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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Save the ${label} fallbacks`}
            accessibilityState={{ disabled: !changed || saving, busy: saving }}
            disabled={!changed || saving}
            onPress={() => void save()}
            style={[styles.button, changed && !saving ? null : { opacity: 0.5 }]}
          >
            <Text style={styles.buttonText}>{saving ? "Saving…" : "Save fallbacks"}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Discard the changes to the ${label} fallbacks`}
            disabled={saving}
            onPress={() => {
              setEditing(null);
              setForm(null);
              setError(null);
            }}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>Discard</Text>
          </Pressable>
        </View>
      )}
      {notes.map((line, index) => (
        <Text key={`${index}:${line.text}`} style={[styles.body, { color: toneColor(theme, line.tone) }]}>
          {line.text}
        </Text>
      ))}
      {error === null ? null : <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{error}</Text>}
    </View>
  );
}

/** "Roles & models": one row per role in the order `roles.settings` returns, each with an Edit form. */
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
  const [editing, setEditing] = useState<{ role: SetupRole; revision: string } | null>(null);
  const [notes, setNotes] = useState<{ role: SetupRole; lines: Badge[] } | null>(null);

  return (
    <>
      <Text style={styles.sectionTitle}>Roles & models</Text>
      {settings.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {settings.isError ? (
        <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{errorMessageOf(settings.error)}</Text>
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
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={open ? `Close the ${row.label} form` : `Edit the ${row.label} provider, model, thinking and mode`}
                    accessibilityState={{ expanded: open }}
                    onPress={() => {
                      setNotes(null);
                      setEditing(open ? null : { role: row.role, revision: data.revision });
                    }}
                    style={styles.secondaryButton}
                  >
                    <Text style={styles.secondaryButtonText}>{open ? "Close" : "Edit"}</Text>
                  </Pressable>
                </View>
                {notes?.role === row.role
                  ? notes.lines.map((line, index) => (
                      <Text key={`${index}:${line.text}`} style={[styles.body, { color: toneColor(theme, line.tone) }]}>
                        {line.text}
                      </Text>
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
        <Text key={warning} style={[styles.body, { color: toneColor(theme, "warning") }]}>
          {warning}
        </Text>
      ))}
      <Text style={styles.body}>{ROLES_APPLY_NOTICE}</Text>
    </>
  );
}

export function ToolCard({ tool, styles, theme, onInstalled }: {
  tool: SetupStatus["tools"][number];
  styles: Styles;
  theme: Theme;
  onInstalled: () => void;
}) {
  const install = useRpc(setupInstallToolRpc);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; tone: "success" | "danger"; tail: string[] } | null>(null);
  const badge = toolBadge(tool);
  const installable = tool.path === null && tool.installCommand !== null && (tool.id === "br" || tool.id === "bv");

  const run = async () => {
    if (tool.id === "bd") return;
    setBusy(true);
    setResult(null);
    try {
      const done = await install({ tool: tool.id, confirmed: true });
      setResult({ text: `Installed with \`${done.command}\`.`, tone: "success", tail: done.tail });
      onInstalled();
    } catch (failure) {
      setResult({ text: errorMessageOf(failure), tone: "danger", tail: [] });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <View style={[styles.card, { gap: 6 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={[styles.sectionTitle, { flex: 1 }]}>{tool.name}</Text>
        <Chip badge={badge} styles={styles} theme={theme} />
      </View>
      <Text style={styles.body}>{tool.purpose}</Text>
      <Text style={styles.body} selectable>
        {tool.path === null ? "Not found on the daemon's PATH or the usual install folders." : `Found at ${tool.path}`}
      </Text>
      {installable ? (
        confirming ? (
          <View style={{ gap: 6 }}>
            <Text style={[styles.body, { color: toneColor(theme, "warning") }]}>{installWarning(tool)}</Text>
            {/* Cancel first: the safe choice is the default (autonomy design §A.12). */}
            <View style={styles.chipRow}>
              {busy ? null : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Cancel: do not install ${tool.id}`}
                  onPress={() => setConfirming(false)}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Install ${tool.id} on this machine`}
                accessibilityState={{ disabled: busy, busy }}
                disabled={busy}
                onPress={() => void run()}
                style={styles.button}
              >
                <Text style={styles.buttonText}>{busy ? "Installing… (up to 5 minutes)" : `Install ${tool.id}`}</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={{ gap: 6 }}>
            <CommandLine label="Install command" command={tool.installCommand!} styles={styles} theme={theme} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Install ${tool.id}: asks before anything runs`}
              onPress={() => setConfirming(true)}
              style={[styles.button, { alignSelf: "flex-start" }]}
            >
              <Text style={styles.buttonText}>{`Install ${tool.id}…`}</Text>
            </Pressable>
          </View>
        )
      ) : tool.updateCommand !== null ? (
        <CommandLine label="Update it yourself with" command={tool.updateCommand} styles={styles} theme={theme} />
      ) : null}
      {result === null ? null : (
        <View style={{ gap: 2 }}>
          <Text style={[styles.body, { color: toneColor(theme, result.tone) }]}>{result.text}</Text>
          {result.tail.length === 0 ? null : (
            <Text style={[styles.mono, { backgroundColor: theme.colors.surface0, padding: 6, borderRadius: 6 }]} selectable>
              {result.tail.join("\n")}
            </Text>
          )}
        </View>
      )}
      <Text style={[styles.body, { fontSize: 11 }]} selectable>
        {tool.homepage}
      </Text>
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
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const block = agentToolsBlock(status);
  if (block === null) return null;

  return (
    <View style={[styles.card, { gap: 6 }]}>
      <Text style={styles.sectionTitle}>Paseo agent tools</Text>
      <Text style={[styles.body, { color: toneColor(theme, block.tone) }]}>{block.text}</Text>
      {asking ? (
        <ConfirmBlock
          dialog={AGENT_TOOLS_DIALOG}
          busy={busy}
          busyLabel="Allowing…"
          onCancel={() => setAsking(false)}
          onConfirm={() =>
            void (async () => {
              setBusy(true);
              setFailure(null);
              try {
                await grant({ confirmed: true });
                setAsking(false);
                onDone();
              } catch (error) {
                setFailure(errorMessageOf(error));
              } finally {
                setBusy(false);
              }
            })()
          }
          styles={styles}
          theme={theme}
        />
      ) : block.button === null ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${block.button} Asks before anything changes.`}
          onPress={() => setAsking(true)}
          style={[styles.button, { alignSelf: "flex-start" }]}
        >
          <Text style={styles.buttonText}>{block.button}</Text>
        </Pressable>
      )}
      {failure === null ? null : <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{failure}</Text>}
    </View>
  );
}

/** The Agent skills tab's own Install button, with the same dialog as the card. */
export function SkillsInstallBlock({ command, onDone, styles, theme }: {
  command: string;
  onDone: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const installSkills = useRpc(setupInstallSkillsRpc);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; tone: "success" | "danger"; tail: string[] } | null>(null);

  return (
    <View style={{ gap: 6 }}>
      {asking ? (
        <ConfirmBlock
          dialog={skillsDialog(command)}
          busy={busy}
          busyLabel="Running… (up to 5 minutes)"
          onCancel={() => setAsking(false)}
          onConfirm={() =>
            void (async () => {
              setBusy(true);
              setResult(null);
              try {
                const done = await installSkills({ confirmed: true });
                setResult({ text: `Ran \`${done.command}\`, exit ${done.code}.`, tone: "success", tail: done.tail });
                setAsking(false);
                onDone();
              } catch (error) {
                setResult({ text: errorMessageOf(error), tone: "danger", tail: [] });
              } finally {
                setBusy(false);
              }
            })()
          }
          styles={styles}
          theme={theme}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Install skills: asks before anything runs"
          onPress={() => setAsking(true)}
          style={[styles.button, { alignSelf: "flex-start" }]}
        >
          <Text style={styles.buttonText}>Install skills…</Text>
        </Pressable>
      )}
      {result === null ? null : (
        <View style={{ gap: 2 }}>
          <Text style={[styles.body, { color: toneColor(theme, result.tone) }]}>{result.text}</Text>
          {result.tail.length === 0 ? null : (
            <Text style={[styles.mono, { backgroundColor: theme.colors.surface0, padding: 6, borderRadius: 6 }]} selectable>
              {result.tail.join("\n")}
            </Text>
          )}
        </View>
      )}
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
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [report, setReport] = useState<CleanupReport | null>(null);

  const run = (deleteData: boolean) =>
    void (async () => {
      setBusy(true);
      setFailure(null);
      try {
        setReport(cleanupReport(await cleanup(cleanupInput(deleteData))));
        setStep("idle");
        onCleaned();
      } catch (error) {
        setFailure(errorMessageOf(error));
      } finally {
        setBusy(false);
      }
    })();

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

  return (
    <View style={{ gap: 6 }}>
      {step === "idle" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={CLEANUP_BUTTON_ACCESSIBILITY_LABEL}
          onPress={() => setStep("warning")}
          style={[styles.secondaryButton, { alignSelf: "flex-start", borderColor: toneColor(theme, "danger") }]}
        >
          <Text style={[styles.secondaryButtonText, { color: toneColor(theme, "danger") }]}>{CLEANUP_BUTTON_LABEL}</Text>
        </Pressable>
      ) : null}
      {step === "warning" ? (
        <View style={{ gap: 6 }}>
          <Text style={[styles.body, { color: toneColor(theme, "danger") }]} selectable>
            {cleanupWarning(status)}
          </Text>
          <View style={styles.chipRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel: keep paseo-bm's settings"
              onPress={() => setStep("idle")}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>{CLEANUP_WARNING_DIALOG.cancelLabel}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Remove settings, then choose what happens to the data"
              onPress={() => setStep("data")}
              style={styles.button}
            >
              <Text style={styles.buttonText}>{CLEANUP_WARNING_DIALOG.confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {step === "data" ? (
        <View style={{ gap: 6 }}>
          <Text style={[styles.body, { color: toneColor(theme, "warning") }]} selectable>
            {cleanupDataQuestion(status)}
          </Text>
          <View style={styles.chipRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Remove the settings and keep my data"
              accessibilityState={{ disabled: busy, busy }}
              disabled={busy}
              onPress={() => run(false)}
              style={styles.button}
            >
              <Text style={styles.buttonText}>{busy ? "Removing…" : CLEANUP_DATA_DIALOG.keepLabel}</Text>
            </Pressable>
            {busy ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove the settings and delete paseo-bm's data"
                onPress={() => run(true)}
                style={styles.secondaryButton}
              >
                <Text style={[styles.secondaryButtonText, { color: toneColor(theme, "danger") }]}>
                  {CLEANUP_DATA_DIALOG.deleteLabel}
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      ) : null}
      {failure === null ? null : <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{failure}</Text>}
    </View>
  );
}
