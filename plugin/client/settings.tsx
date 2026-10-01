/**
 * Plugin settings screen: the trace-store warning threshold
 * (WP-211.2.1; REQ-055d, REQ-055e, REQ-055f).
 *
 * Paseo owns the storage and the revision handling through `useSettings`, so
 * this screen only edits one number. Two things it must say out loud: the
 * threshold is machine-wide (Paseo has no per-workspace settings), and an
 * invalid value leaves the previous one in force.
 *
 * Client rules: React Native primitives only, colours from `theme.colors`, no
 * Node import, no `server/` import.
 */
import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import {
  DEFAULT_WARN_ABOVE_BYTES,
  dashboardSettings,
} from "../shared/settings";
import { formatBytes } from "./format";
import { HOST_SCOPE_NOTICE } from "./history-model";
import { dashboardStyles } from "./styles";
import { Button, ToneText } from "./ui";

/** Settings screen id, used by `openSettings` from the Dashboard. */
export const SETTINGS_SCREEN_ID = "paseo-bm-settings";
export const SETTINGS_ICON = "Settings";

const MEGABYTE = 1024 * 1024;

export function DashboardSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const settings = useSettings(dashboardSettings);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const current =
    settings.status === "ready" ? settings.values.warnAboveBytes : DEFAULT_WARN_ABOVE_BYTES;
  const shown = draft ?? String(Math.round(current / MEGABYTE));

  const save = async () => {
    if (settings.status !== "ready") return;
    const megabytes = Number.parseInt(shown, 10);
    if (!Number.isFinite(megabytes) || megabytes <= 0) {
      // REQ-055f: refuse, and leave the stored threshold in force.
      setError(`"${shown}" is not a size in MB. The current threshold stays at ${formatBytes(current)}.`);
      return;
    }
    setError(null);
    const saved = await settings.save({ warnAboveBytes: megabytes * MEGABYTE }, settings.revision);
    if (!saved) setError(settings.saveError ?? "Could not save the setting.");
    else setDraft(null);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Beads Dashboard</Text>
      <Text style={styles.sectionTitle}>Trace store warning</Text>
      <Text style={styles.body}>
        The Dashboard warns when paseo-bm&apos;s trace store grows past this size. It never deletes
        anything on its own. {HOST_SCOPE_NOTICE}
      </Text>

      <View style={styles.card}>
        <Text style={styles.body}>Warn above (MB)</Text>
        <TextInput
          accessibilityLabel="Warn above, in megabytes"
          keyboardType="number-pad"
          value={shown}
          onChangeText={(next) => setDraft(next)}
          style={[styles.mono, { borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, padding: 8 }]}
        />
        <Text style={styles.body}>{`Currently ${formatBytes(current)}.`}</Text>
        {error !== null ? (
          <ToneText tone="danger" styles={styles} theme={theme}>{error}</ToneText>
        ) : null}
        {settings.status === "error" ? (
          <ToneText tone="danger" styles={styles} theme={theme}>{settings.error}</ToneText>
        ) : null}
        <Button
          label={settings.saving ? "Saving…" : "Save"}
          kind="primary"
          accessibilityLabel="Save the warning threshold"
          accessibilityState={{ disabled: settings.saving }}
          disabled={settings.saving}
          onPress={() => {
            void save();
          }}
          style={settings.saving ? { opacity: 0.5 } : null}
          styles={styles}
        />
        <Button
          label={`Reset to ${formatBytes(DEFAULT_WARN_ABOVE_BYTES)}`}
          kind="secondary"
          accessibilityLabel="Reset the warning threshold to the default"
          onPress={() => {
            setDraft(null);
            setError(null);
            void settings.reset();
          }}
          styles={styles}
        />
      </View>
    </ScrollView>
  );
}
