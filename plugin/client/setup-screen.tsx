/**
 * Setup view of the Beads Manager surface (delta 20260916-setup-screen):
 * additional instructions per role with a full preview, the agent skills with
 * a Test button, and the beads tools `br` / `bv` with a confirmed Install.
 * Above the instructions, "Roles & models" (delta 20260921 §4.3.1) shows each
 * role's provider, model, thinking and mode, with an Edit form that saves
 * through `roles.save-settings`, and under a role whose fallback chain is
 * offered, its policy and entries, saved through `roles.save-fallback` (§4.4.3).
 *
 * It is the surface's MAIN screen (owner decision Q1, delta 20260918e §4.2):
 * no back button, and a "Workspaces" button to the workspace list. The surface
 * hands it the status strip, so what a slash command reported is seen here.
 *
 * Wording lives in `setup-model.ts`. Client rules: React Native primitives
 * only, colours from the theme, no Node import, no `server/` import.
 */
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/react-native";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  rolesInstructionsRpc,
  rolesOptionsRpc,
  rolesSaveExtraRpc,
  rolesSaveFallbackRpc,
  rolesSaveSettingsRpc,
  rolesSettingsRpc,
  setupCleanupRpc,
  setupEnsureRolesRpc,
  setupGrantAgentToolsRpc,
  setupInstallSkillsRpc,
  setupInstallToolRpc,
  setupStatusRpc,
  type BmRole,
  type FallbackEntryInput,
  type FallbackSettings,
  type RoleSetting,
  type RolesOptions,
  type RolesSettings,
  type SetupStatus,
} from "../shared/contracts";
import { dashboardStyles, toneColor, type Badge } from "./dashboard-model";
import { errorMessageOf } from "./launch-manager";
import { MarkdownView } from "./markdown-view";
import {
  AGENT_TOOLS_DIALOG,
  CLEANUP_BUTTON_ACCESSIBILITY_LABEL,
  CLEANUP_BUTTON_LABEL,
  CLEANUP_DATA_DIALOG,
  CLEANUP_WARNING_DIALOG,
  DEFAULT_SETUP_TAB,
  PLUGIN_DIAGNOSTICS_LINE,
  SKILLS_COMMAND_LABEL,
  agentToolsBlock,
  anySkillMissing,
  dataHomeLine,
  rolesCreatedLine,
  signInRows,
  skillsRunLine,
  FALLBACK_POLICY_CHOICES,
  ROLES_APPLY_NOTICE,
  SETUP_ROLES,
  SETUP_TABS,
  addFallback,
  applySavedRole,
  canAddFallback,
  cleanupDataQuestion,
  cleanupInput,
  cleanupReport,
  cleanupWarning,
  ensureRolesLine,
  entryAsSetting,
  entryOfDraft,
  fallbackBlocks,
  fallbackDraftChanged,
  fallbackDraftOf,
  fallbackEntryText,
  fallbackPolicyWarning,
  fallbackPriceText,
  migrationBanner,
  moveFallback,
  removeFallback,
  setupChecklist,
  skillsDialog,
  replaceFallback,
  saveFallbackInput,
  extraCounter,
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
  setupHeadline,
  paseoToolsWarnings,
  skillChips,
  skillDirsText,
  toolBadge,
  type FallbackDraft,
  type RoleChoice,
  type RoleDraft,
  type ChecklistRow,
  type CleanupReport,
  type SetupDialog,
  type SetupRole,
  type SetupTab,
} from "./setup-model";
import { Chip, RoleMark, StatusTabs, type Styles, type Theme } from "./ui";
import { PLUGIN_VERSION } from "../shared/version";

export interface SetupScreenProps extends PluginSurfaceProps {
  onOpenWorkspaces: () => void;
  /** The surface's status strip (slash-command notice, launch state), drawn under the header. */
  status?: ReactNode;
}

function CopyButton({ text, styles }: { text: string; styles: Styles }) {
  const [copied, setCopied] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
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

function CommandLine({ label, command, styles, theme }: { label: string; command: string; styles: Styles; theme: Theme }) {
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
        <CopyButton text={command} styles={styles} />
      </View>
    </View>
  );
}

function RoleCard({ role, label, mark, styles, theme, compact }: {
  role: SetupRole;
  label: string;
  mark: (typeof SETUP_ROLES)[number]["mark"];
  styles: Styles;
  theme: Theme;
  compact: boolean;
}) {
  const getInstructions = useRpc(rolesInstructionsRpc);
  const saveExtra = useRpc(rolesSaveExtraRpc);
  const queryClient = useQueryClient();
  const instructions = useQuery({
    queryKey: ["paseo-bm", "setup", "instructions", role],
    queryFn: () => getInstructions({ role }),
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: "success" | "danger" } | null>(null);

  const data = instructions.data;
  const text = draft ?? data?.extra ?? "";
  const dirty = data !== undefined && draft !== null && draft !== data.extra;

  const save = async () => {
    setSaving(true);
    setNote(null);
    try {
      await saveExtra({ role, text });
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ["paseo-bm", "setup"] });
      setNote({ text: `Saved. ${label} agents created from now on use it.`, tone: "success" });
    } catch (failure) {
      setNote({ text: errorMessageOf(failure), tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[styles.card, { gap: 6 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <RoleMark kind={mark} theme={theme} />
        <Text style={[styles.sectionTitle, { flex: 1 }]}>{label}</Text>
        {data === undefined ? null : <Text style={styles.body}>{extraCounter(text.length, data.maxChars)}</Text>}
      </View>
      {instructions.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {instructions.isError ? (
        <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{errorMessageOf(instructions.error)}</Text>
      ) : null}
      <TextInput
        value={text}
        onChangeText={setDraft}
        multiline
        placeholder={`Additional instructions for every new ${label}. They are added after the built-in rules and cannot override them.`}
        placeholderTextColor={theme.colors.foregroundMuted}
        style={[styles.mono, { minHeight: 72, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 8 }]}
      />
      <View style={styles.chipRow}>
        <Pressable
          accessibilityRole="button"
          disabled={!dirty || saving}
          onPress={() => void save()}
          style={[styles.button, !dirty || saving ? { opacity: 0.5 } : null]}
        >
          <Text style={styles.buttonText}>{saving ? "Saving…" : "Save"}</Text>
        </Pressable>
        {dirty ? (
          <Pressable accessibilityRole="button" onPress={() => setDraft(null)} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Discard</Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: preview }} onPress={() => setPreview(!preview)} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>{preview ? "Hide preview" : "Preview full instructions"}</Text>
        </Pressable>
      </View>
      {note === null ? null : <Text style={[styles.body, { color: toneColor(theme, note.tone) }]}>{note.text}</Text>}
      {preview && data !== undefined ? (
        <View style={[styles.card, { backgroundColor: theme.colors.surface0, gap: 4 }]}>
          <Text style={styles.body}>
            {dirty ? "Showing the saved version; save to preview your changes." : `Built-in ${label} instructions plus your additions.`}
          </Text>
          <MarkdownView source={data.full} theme={theme} compact={compact} />
        </View>
      ) : null}
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
  role: BmRole;
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
          disabled={!canSave}
          onPress={() => void save()}
          style={[styles.button, canSave ? null : { opacity: 0.5 }]}
        >
          <Text style={styles.buttonText}>{saving ? "Saving…" : "Save"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={saving} onPress={onClose} style={styles.secondaryButton}>
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
          disabled={done === null}
          onPress={() => done !== null && onDone(done)}
          style={[styles.button, done === null ? { opacity: 0.5 } : null]}
        >
          <Text style={styles.buttonText}>{entry === null ? "Add" : "Done"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onCancel} style={styles.secondaryButton}>
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
            disabled={!changed || saving}
            onPress={() => void save()}
            style={[styles.button, changed && !saving ? null : { opacity: 0.5 }]}
          >
            <Text style={styles.buttonText}>{saving ? "Saving…" : "Save fallbacks"}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
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
function RolesSection({ styles, theme }: { styles: Styles; theme: Theme }) {
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
  const chains = new Map((data === undefined ? [] : fallbackBlocks(data)).map((chain) => [chain.role, chain] as const));
  const [editing, setEditing] = useState<{ role: BmRole; revision: string } | null>(null);
  const [notes, setNotes] = useState<{ role: BmRole; lines: Badge[] } | null>(null);

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
                {chains.get(row.role) === undefined ? null : (
                  <FallbackBlock
                    chain={chains.get(row.role)!}
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

function ToolCard({ tool, styles, theme, onInstalled }: {
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
            <View style={styles.chipRow}>
              <Pressable accessibilityRole="button" disabled={busy} onPress={() => void run()} style={styles.button}>
                <Text style={styles.buttonText}>{busy ? "Installing… (up to 5 minutes)" : `Install ${tool.id}`}</Text>
              </Pressable>
              {busy ? null : (
                <Pressable accessibilityRole="button" onPress={() => setConfirming(false)} style={styles.secondaryButton}>
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </Pressable>
              )}
            </View>
          </View>
        ) : (
          <View style={{ gap: 6 }}>
            <CommandLine label="Install command" command={tool.installCommand!} styles={styles} theme={theme} />
            <Pressable accessibilityRole="button" onPress={() => setConfirming(true)} style={[styles.button, { alignSelf: "flex-start" }]}>
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
 * A confirmation shown in place, with Cancel as the default.
 *
 * The confirm button is deliberately not the first control and never
 * pre-focused: both dialogs that use this grant something machine-wide, so an
 * accidental Return must do nothing (design §7.13.3, §7.13.4).
 */
function ConfirmBlock({ dialog, busy, busyLabel, onConfirm, onCancel, styles, theme }: {
  dialog: SetupDialog;
  busy: boolean;
  busyLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.sectionTitle, { color: toneColor(theme, "warning") }]}>{dialog.title}</Text>
      <Text style={styles.body} selectable>
        {dialog.body}
      </Text>
      <View style={styles.chipRow}>
        {busy ? null : (
          <Pressable accessibilityRole="button" onPress={onCancel} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>{dialog.cancelLabel}</Text>
          </Pressable>
        )}
        <Pressable accessibilityRole="button" disabled={busy} onPress={onConfirm} style={styles.button}>
          <Text style={styles.buttonText}>{busy ? busyLabel : dialog.confirmLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * "Set up paseo-bm": what this machine still needs, and the buttons that do it.
 *
 * Above the tab row on purpose — a tab could hide it — and not rendered at all
 * when `setupChecklist` is empty, which is where almost every user is.
 */
function SetupChecklistCard({ status, rolesError, onDone, onOpenTab, styles, theme }: {
  status: SetupStatus;
  rolesError: string | null;
  onDone: () => void;
  onOpenTab: (tab: SetupTab) => void;
  styles: Styles;
  theme: Theme;
}) {
  const ensure = useRpc(setupEnsureRolesRpc);
  const grant = useRpc(setupGrantAgentToolsRpc);
  const installSkills = useRpc(setupInstallSkillsRpc);
  const [asking, setAsking] = useState<"agent-tools" | "install-skills" | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ key: string; text: string } | null>(null);
  const [tail, setTail] = useState<string[]>([]);

  const rows = setupChecklist(status, rolesError);
  if (rows.length === 0) return null;

  const call = async (key: string, work: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(null);
    try {
      await work();
      setAsking(null);
      onDone();
    } catch (error) {
      setFailure({ key, text: errorMessageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const press = (row: ChecklistRow) => {
    switch (row.action.kind) {
      case "ensure-roles":
        return void call("roles", () => ensure({}));
      case "grant-agent-tools":
        return setAsking("agent-tools");
      case "install-skills":
        return setAsking("install-skills");
      case "open-tab":
        return onOpenTab(row.action.tab);
      default:
        return undefined;
    }
  };

  return (
    <View style={[styles.card, { gap: 10 }]}>
      <Text style={styles.sectionTitle}>Set up paseo-bm</Text>
      {rows.map((row) => (
        <View key={`${row.key}-${row.status}`} style={{ gap: 4 }}>
          <Text style={[styles.body, { fontWeight: "600" }]}>{row.title}</Text>
          <Text style={styles.body} selectable>
            {row.status}
          </Text>
          {row.command === null ? null : <CommandLine label="Run it yourself" command={row.command} styles={styles} theme={theme} />}
          {row.button === null ? null : (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => press(row)}
              style={[styles.button, { alignSelf: "flex-start" }]}
            >
              <Text style={styles.buttonText}>{row.button}</Text>
            </Pressable>
          )}
          {failure !== null && failure.key === row.key ? (
            <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{failure.text}</Text>
          ) : null}
        </View>
      ))}
      {asking === "agent-tools" ? (
        <ConfirmBlock
          dialog={AGENT_TOOLS_DIALOG}
          busy={busy}
          busyLabel="Allowing…"
          onCancel={() => setAsking(null)}
          onConfirm={() => void call("agent-tools", () => grant({ confirmed: true }))}
          styles={styles}
          theme={theme}
        />
      ) : null}
      {asking === "install-skills" ? (
        <ConfirmBlock
          dialog={skillsDialog(status.skills.installCommand)}
          busy={busy}
          busyLabel="Running… (up to 5 minutes)"
          onCancel={() => setAsking(null)}
          onConfirm={() =>
            void call("skills", async () => {
              setTail((await installSkills({ confirmed: true })).tail);
            })
          }
          styles={styles}
          theme={theme}
        />
      ) : null}
      {tail.length === 0 ? null : (
        <Text style={[styles.mono, { backgroundColor: theme.colors.surface0, padding: 6, borderRadius: 6 }]} selectable>
          {tail.join("\n")}
        </Text>
      )}
    </View>
  );
}

/** The Agents tab's view of Paseo's machine-wide switch, with the same dialog. */
function AgentToolsBlockView({ status, onDone, styles, theme }: {
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
        <Pressable accessibilityRole="button" onPress={() => setAsking(true)} style={[styles.button, { alignSelf: "flex-start" }]}>
          <Text style={styles.buttonText}>{block.button}</Text>
        </Pressable>
      )}
      {failure === null ? null : <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{failure}</Text>}
    </View>
  );
}

/** The Agent skills tab's own Install button, with the same dialog as the card. */
function SkillsInstallBlock({ command, onDone, styles, theme }: {
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
        <Pressable accessibilityRole="button" onPress={() => setAsking(true)} style={[styles.button, { alignSelf: "flex-start" }]}>
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
function CleanupBlock({ status, onCleaned, styles, theme }: {
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
            <Pressable accessibilityRole="button" onPress={() => setStep("idle")} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>{CLEANUP_WARNING_DIALOG.cancelLabel}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setStep("data")} style={styles.button}>
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
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => run(false)} style={styles.button}>
              <Text style={styles.buttonText}>{busy ? "Removing…" : CLEANUP_DATA_DIALOG.keepLabel}</Text>
            </Pressable>
            {busy ? null : (
              <Pressable accessibilityRole="button" onPress={() => run(true)} style={styles.secondaryButton}>
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

export function SetupScreen({ theme, layout, onOpenWorkspaces, status: statusStrip }: SetupScreenProps) {
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const getStatus = useRpc(setupStatusRpc);
  const ensure = useRpc(setupEnsureRolesRpc);
  // One chain, one spinner: the roles are created (or found) BEFORE the status
  // is read, so the screen never shows a machine as half set up while it is
  // being set up. This is the other first-use trigger besides opening the
  // Manager (design §7.13.2).
  const status = useQuery({
    queryKey: ["paseo-bm", "setup", "status"],
    queryFn: async () => {
      let ensured: Awaited<ReturnType<typeof ensure>> | null = null;
      let rolesError: unknown = null;
      try {
        ensured = await ensure({});
      } catch (error) {
        rolesError = error;
      }
      return { ...(await getStatus({})), ensured, rolesError };
    },
  });
  const data = status.data;
  const [dismissedRoles, setDismissedRoles] = useState(false);
  const rolesLine = data === undefined ? null : ensureRolesLine(data.ensured, data.rolesError);
  const banner = data === undefined ? null : migrationBanner(data);
  // Lives as long as this screen: reopening the surface starts on the first tab,
  // the same way the "Beads" tab's sub-tabs behave (delta 20260925 §3.3).
  const [tab, setTab] = useState<SetupTab>(DEFAULT_SETUP_TAB);
  const headline = data === undefined ? null : setupHeadline(data);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={[styles.title, { flex: 1 }]} numberOfLines={1}>
          Beads Manager
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open the workspace list: Beads Manager, metrics and beads of each workspace"
          onPress={onOpenWorkspaces}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonText}>Workspaces</Text>
        </Pressable>
      </View>
      <Text style={styles.body}>Setup for this machine: beads tools, agent skills, and each role&apos;s model and extra instructions.</Text>
      {statusStrip}
      {status.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {status.isError ? (
        <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{errorMessageOf(status.error)}</Text>
      ) : null}
      {headline === null ? null : <Text style={[styles.sectionTitle, { color: toneColor(theme, headline.tone) }]}>{headline.text}</Text>}

      {/* This install came from the retired `npx` installer (design §7.13.6). */}
      {banner === null ? null : (
        <View style={[styles.card, { gap: 6 }]}>
          <Text style={[styles.body, { color: toneColor(theme, "warning") }]} selectable>
            {banner.text}
          </Text>
          <CommandLine label="Run it once" command={banner.command} styles={styles} theme={theme} />
        </View>
      )}

      {rolesLine === null || (rolesLine.dismissable && dismissedRoles) ? null : (
        <View style={{ gap: 6 }}>
          <Text style={[styles.body, { color: toneColor(theme, rolesLine.tone) }]} selectable>
            {rolesLine.text}
          </Text>
          <View style={styles.chipRow}>
            {rolesLine.button === null ? null : (
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  void (async () => {
                    // "Set up again" is the only call that clears the cleanup mark.
                    if (rolesLine.button === "Set up again") await ensure({ resume: true });
                    await status.refetch();
                  })()
                }
                style={[styles.button, { alignSelf: "flex-start" }]}
              >
                <Text style={styles.buttonText}>{rolesLine.button}</Text>
              </Pressable>
            )}
            {rolesLine.dismissable ? (
              <Pressable accessibilityRole="button" onPress={() => setDismissedRoles(true)} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Dismiss</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      )}

      {data === undefined || data.ensured?.skipped === "cleaned-up" ? null : (
        <SetupChecklistCard
          status={data}
          rolesError={data.rolesError === null ? null : errorMessageOf(data.rolesError)}
          onDone={() => void status.refetch()}
          onOpenTab={setTab}
          styles={styles}
          theme={theme}
        />
      )}
      {data === undefined
        ? null
        : paseoToolsWarnings(data).map((warning) => (
            <Text key={warning} style={[styles.body, { color: toneColor(theme, "warning") }]}>
              {warning}
            </Text>
          ))}

      {/* The three configurations, one at a time. Everything above this row —
          the headline and the tool warnings — stays out of the tabs, so a tab can
          never hide a problem (delta 20260925 §3.3). */}
      <StatusTabs tabs={SETUP_TABS} selected={tab} onSelect={(key) => setTab(key as SetupTab)} styles={styles} />

      {/* 1. Beads tools */}
      {tab !== "tools" ? null : (
        <>
          {data?.tools.map((tool) => (
            <ToolCard key={tool.id} tool={tool} styles={styles} theme={theme} onInstalled={() => void status.refetch()} />
          ))}
          {data === undefined ? null : (
            <Text style={[styles.body, { fontSize: 11 }]}>{`Newest versions as of ${data.latestCheckedOn}; paseo-bm does not look them up online.`}</Text>
          )}
        </>
      )}

      {/* 2. Agent skills */}
      {tab !== "skills" ? null : (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={[styles.sectionTitle, { flex: 1 }]}>Agent skills</Text>
            <Pressable accessibilityRole="button" disabled={status.isFetching} onPress={() => void status.refetch()} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>{status.isFetching ? "Testing…" : "Test"}</Text>
            </Pressable>
          </View>
          {data === undefined || !anySkillMissing(data) ? null : (
            <SkillsInstallBlock command={data.skills.installCommand} onDone={() => void status.refetch()} styles={styles} theme={theme} />
          )}
          {data === undefined || skillsRunLine(data) === null ? null : (
            <Text style={[styles.body, { fontSize: 11 }]}>{skillsRunLine(data)}</Text>
          )}
          {data === undefined ? null : (
            <View style={[styles.card, { gap: 6 }]}>
              <Text style={styles.body}>{`Checked ${new Date(data.skills.checkedAt).toLocaleTimeString()} · ${skillDirsText(data.skills.dirs)}`}</Text>
              {data.skills.skills.map((skill) => (
                <View key={skill.name} style={{ gap: 2 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <Text style={[styles.mono, { flex: 1 }]}>{`${skill.name}${skill.required ? "" : " (optional)"}`}</Text>
                    {skillChips(skill).map((badge) => (
                      <Chip key={badge.text} badge={badge} styles={styles} theme={theme} />
                    ))}
                  </View>
                  {skill.problem === null ? null : (
                    <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{skill.problem}</Text>
                  )}
                </View>
              ))}
              <CommandLine label={SKILLS_COMMAND_LABEL} command={data.skills.installCommand} styles={styles} theme={theme} />
            </View>
          )}
        </>
      )}

      {/* 3. Roles & models (delta 20260921 §4.3.1) and 4. additional
          instructions: both are about the agents, so they share one tab. */}
      {tab !== "agents" ? null : (
        <>
          {data === undefined || rolesCreatedLine(data) === null ? null : (
            <Text style={[styles.body, { fontSize: 11 }]}>{rolesCreatedLine(data)}</Text>
          )}
          <RolesSection styles={styles} theme={theme} />
          {data === undefined ? null : (
            <AgentToolsBlockView status={data} onDone={() => void status.refetch()} styles={styles} theme={theme} />
          )}
          {data === undefined || signInRows(data).length === 0 ? null : (
            <View style={[styles.card, { gap: 6 }]}>
              <Text style={styles.sectionTitle}>Sign-in</Text>
              <Text style={[styles.body, { fontSize: 11 }]}>
                paseo-bm never runs a login command and never sees your credentials.
              </Text>
              {signInRows(data).map((row) => (
                <View key={row.provider} style={{ gap: 2 }}>
                  <Text style={styles.body}>{`${row.provider} · ${row.usedBy}`}</Text>
                  <Text style={[styles.body, { color: toneColor(theme, row.tone) }]} selectable>
                    {row.text}
                  </Text>
                  {row.command === null ? null : (
                    <CommandLine label="Run it yourself" command={row.command} styles={styles} theme={theme} />
                  )}
                </View>
              ))}
            </View>
          )}
          <Text style={styles.sectionTitle}>Additional instructions</Text>
          <Text style={styles.body}>
            Added after each role&apos;s built-in instructions, for agents created from now on. Running agents keep what they started with.
          </Text>
          {SETUP_ROLES.map((entry) => (
            <RoleCard key={entry.role} {...entry} styles={styles} theme={theme} compact={layout.compact} />
          ))}
        </>
      )}

      <Text style={[styles.body, { fontSize: 11 }]}>{`paseo-bm ${PLUGIN_VERSION}`}</Text>
      {/* Outside the tabs: where this install keeps its data, and what to look
          at when the plugin does not load at all (design §7.13.8). */}
      {data === undefined || dataHomeLine(data) === null ? null : (
        <Text style={[styles.body, { fontSize: 11, color: toneColor(theme, dataHomeLine(data)!.tone) }]} selectable>
          {dataHomeLine(data)!.text}
        </Text>
      )}
      <Text style={[styles.body, { fontSize: 11 }]} selectable>
        {PLUGIN_DIAGNOSTICS_LINE}
      </Text>
      {data === undefined ? null : (
        <CleanupBlock status={data} onCleaned={() => void status.refetch()} styles={styles} theme={theme} />
      )}
    </ScrollView>
  );
}
