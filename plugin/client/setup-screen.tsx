/**
 * Setup view of the Beads Manager surface (delta 20260916-setup-screen):
 * additional instructions per role with a full preview, the agent skills with
 * a Test button, and the beads tools `br` / `bv` with a confirmed Install.
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  rolesInstructionsRpc,
  rolesSaveExtraRpc,
  setupInstallToolRpc,
  setupStatusRpc,
  type SetupStatus,
} from "../shared/contracts";
import { dashboardStyles, toneColor } from "./dashboard-model";
import { errorMessageOf } from "./launch-manager";
import { MarkdownView } from "./markdown-view";
import {
  SETUP_ROLES,
  extraCounter,
  installWarning,
  setupHeadline,
  skillBadge,
  toolBadge,
  type SetupRole,
} from "./setup-model";
import { Chip, RoleMark, type Styles, type Theme } from "./ui";
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

export function SetupScreen({ theme, layout, onOpenWorkspaces, status: statusStrip }: SetupScreenProps) {
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const getStatus = useRpc(setupStatusRpc);
  const status = useQuery({ queryKey: ["paseo-bm", "setup", "status"], queryFn: () => getStatus({}) });
  const data = status.data;
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
      <Text style={styles.body}>Setup for this machine: beads tools, agent skills and extra instructions for each role.</Text>
      {statusStrip}
      {status.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {status.isError ? (
        <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{errorMessageOf(status.error)}</Text>
      ) : null}
      {headline === null ? null : <Text style={[styles.sectionTitle, { color: toneColor(theme, headline.tone) }]}>{headline.text}</Text>}

      {/* 1. Beads tools */}
      <Text style={styles.sectionTitle}>Beads tools</Text>
      {data?.tools.map((tool) => (
        <ToolCard key={tool.id} tool={tool} styles={styles} theme={theme} onInstalled={() => void status.refetch()} />
      ))}
      {data === undefined ? null : (
        <Text style={[styles.body, { fontSize: 11 }]}>{`Newest versions as of ${data.latestCheckedOn}; paseo-bm does not look them up online.`}</Text>
      )}

      {/* 2. Agent skills */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[styles.sectionTitle, { flex: 1 }]}>Agent skills</Text>
        <Pressable accessibilityRole="button" disabled={status.isFetching} onPress={() => void status.refetch()} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>{status.isFetching ? "Testing…" : "Test"}</Text>
        </Pressable>
      </View>
      {data === undefined ? null : (
        <View style={[styles.card, { gap: 6 }]}>
          <Text style={styles.body}>{`Checked ${new Date(data.skills.checkedAt).toLocaleTimeString()} · Claude: ${data.skills.dirs.claude} · Codex: ${data.skills.dirs.shared} or ${data.skills.dirs.codex}`}</Text>
          {data.skills.skills.map((skill) => (
            <View key={skill.name} style={{ gap: 2 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <Text style={[styles.mono, { flex: 1 }]}>{`${skill.name}${skill.required ? "" : " (optional)"}`}</Text>
                <Chip badge={skillBadge("Claude", skill.claude)} styles={styles} theme={theme} />
                <Chip badge={skillBadge("Codex", skill.codex)} styles={styles} theme={theme} />
              </View>
              {skill.problem === null ? null : (
                <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{skill.problem}</Text>
              )}
            </View>
          ))}
          <CommandLine label="Install the required skills (run it yourself, or use `npx paseo-bm install --apply --install-skills`)" command={data.skills.installCommand} styles={styles} theme={theme} />
        </View>
      )}

      {/* 3. Additional instructions per role */}
      <Text style={styles.sectionTitle}>Additional instructions</Text>
      <Text style={styles.body}>
        Added after each role&apos;s built-in instructions, for agents created from now on. Running agents keep what they started with.
      </Text>
      {SETUP_ROLES.map((entry) => (
        <RoleCard key={entry.role} {...entry} styles={styles} theme={theme} compact={layout.compact} />
      ))}

      <Text style={[styles.body, { fontSize: 11 }]}>{`paseo-bm ${PLUGIN_VERSION}`}</Text>
    </ScrollView>
  );
}
