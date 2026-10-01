/**
 * Tools & skills, a section of the management surface (change-014 outcome 5;
 * experience concept §4.4), on one scrolling screen:
 *
 * - **Skills** — each agent skill paseo-bm checks, with its install state per
 *   agent, its problem, and how many Worker reports named it in the last 30
 *   days in every project (`skills.usage`); Test, Install skills… (its
 *   confirmation, Cancel first) and the command to run it yourself.
 * - **Agent tools by role** — what Paseo's agent tools let the Manager and
 *   the Worker do and whether the last one had them, and paseo-bm's own
 *   tools per role.
 * - **Command-line tools** — `br` and `bv`, each with its install action.
 *
 * It reads `setup.status` through Settings' `useSetupStatus` (the same query,
 * so opening it ensures the roles too). What it says is
 * `tools-screen-model.ts`; `SkillsTable` and `AgentToolsTable` are hook-free
 * and tested with the element-tree helper.
 *
 * Client rules: React Native primitives only, colours from the theme, no Node
 * import, no `server/` import.
 */
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { skillsUsageRpc, type SetupStatus } from "../shared/contracts";
import { errorMessageOf } from "./errors";
import { localTimeText } from "./format";
import { SKILLS_COMMAND_LABEL, anySkillMissing, skillDirsText, skillsRunLine } from "./settings-machine-model";
import { CommandLine, SkillsInstallBlock, ToolCard } from "./settings-blocks";
import { SettingsSectionHeading, useSetupStatus, type SettingsScreenProps } from "./settings-section";
import { dashboardStyles } from "./styles";
import {
  BEADS_TOOL_IDS,
  SKILLS_USAGE_DAYS,
  SKILLS_USAGE_QUERY_KEY,
  SKILLS_USED_MEANING,
  agentToolsRows,
  skillRowsView,
  toolsGroupState,
  type AgentToolsRowView,
  type SkillRowView,
} from "./tools-screen-model";
import { Button, Chip, ToneText, type Styles, type Theme } from "./ui";

const USED_WIDTH = 56;

/** The skills, one row each: name and note, the Used count on the right, the install state per agent under it, and the problem. Hook-free. */
export function SkillsTable({ rows, styles, theme }: { rows: readonly SkillRowView[]; styles: Styles; theme: Theme }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Text style={[styles.body, { flex: 1, fontSize: 11 }]}>Skill</Text>
        <Text style={[styles.body, { width: USED_WIDTH, fontSize: 11, textAlign: "right" }]}>Used</Text>
      </View>
      {rows.map((row) => (
        <View key={row.name} style={{ gap: 4 }} accessibilityLabel={row.accessibilityLabel}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={[styles.mono, { flex: 1 }]}>{row.note === null ? row.name : `${row.name} ${row.note}`}</Text>
            <Text style={[styles.mono, { width: USED_WIDTH, textAlign: "right" }]}>{row.used}</Text>
          </View>
          {row.chips.length === 0 ? null : (
            <View style={styles.chipRow}>
              {row.chips.map((badge) => (
                <Chip key={badge.text} badge={badge} styles={styles} theme={theme} />
              ))}
            </View>
          )}
          {row.problem === null ? null : (
            <ToneText tone="danger" styles={styles} theme={theme}>
              {row.problem}
            </ToneText>
          )}
        </View>
      ))}
    </View>
  );
}

/** The agent tools, one row per role: the role, Paseo's tools in their tone, paseo-bm's tools. Hook-free. */
export function AgentToolsTable({ rows, styles, theme }: { rows: readonly AgentToolsRowView[]; styles: Styles; theme: Theme }) {
  return (
    <View style={{ gap: 8 }}>
      {rows.map((row) => (
        <View key={row.role} style={{ gap: 2 }} accessibilityLabel={`${row.role}: Paseo tools ${row.paseo.text}; paseo-bm tools ${row.bm}`}>
          <Text style={[styles.body, { color: theme.colors.foreground }]}>{row.role}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
              <Text style={[styles.body, { fontSize: 11 }]}>Paseo tools</Text>
              <ToneText tone={row.paseo.tone} styles={styles} theme={theme}>
                {row.paseo.text}
              </ToneText>
            </View>
            <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
              <Text style={[styles.body, { fontSize: 11 }]}>paseo-bm tools</Text>
              <Text style={styles.mono}>{row.bm}</Text>
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

/** The Skills card: Test, Install skills… while one is missing, the last run, where they were looked for, the rows, the command. */
function SkillsCard({ status, usage, usageError, testing, onTest, onDone, styles, theme }: {
  status: SetupStatus;
  usage: Parameters<typeof skillRowsView>[1];
  usageError: string | null;
  testing: boolean;
  onTest: () => void;
  onDone: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const now = new Date();
  const runLine = skillsRunLine(status, now);
  return (
    <View style={[styles.card, { gap: 8 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[styles.sectionTitle, { flex: 1 }]}>Skills</Text>
        <Button
          label={testing ? "Testing…" : "Test"}
          kind="secondary"
          accessibilityLabel="Test the agent skills again"
          accessibilityState={{ disabled: testing, busy: testing }}
          disabled={testing}
          onPress={onTest}
          styles={styles}
        />
      </View>
      <Text style={[styles.body, { fontSize: 11 }]}>{`${SKILLS_USED_MEANING} Checked ${localTimeText(new Date(status.skills.checkedAt), now)} · ${skillDirsText(status.skills.dirs)}`}</Text>
      {anySkillMissing(status) ? <SkillsInstallBlock command={status.skills.installCommand} onDone={onDone} styles={styles} theme={theme} /> : null}
      {runLine === null ? null : <Text style={[styles.body, { fontSize: 11 }]}>{runLine}</Text>}
      <SkillsTable rows={skillRowsView(status, usage)} styles={styles} theme={theme} />
      {usageError === null ? null : (
        <ToneText tone="danger" style={{ fontSize: 11 }} styles={styles} theme={theme}>
          {usageError}
        </ToneText>
      )}
      <CommandLine label={SKILLS_COMMAND_LABEL} command={status.skills.installCommand} styles={styles} theme={theme} />
    </View>
  );
}

export function ToolsScreen({ theme, layout, status: statusStrip }: SettingsScreenProps) {
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const status = useSetupStatus();
  const readUsage = useRpc(skillsUsageRpc);
  const usage = useQuery({ queryKey: SKILLS_USAGE_QUERY_KEY, queryFn: () => readUsage({ sinceDays: SKILLS_USAGE_DAYS }) });
  const data = status.data;
  const refetch = () => {
    void status.refetch();
    void usage.refetch();
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Tools & skills</Text>
      {statusStrip}
      {status.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {status.isError ? (
        <ToneText tone="danger" styles={styles} theme={theme}>
          {errorMessageOf(status.error)}
        </ToneText>
      ) : null}
      {data === undefined ? null : (
        <>
          <ToneText tone={toolsGroupState(data).tone} styles={styles} theme={theme}>
            {toolsGroupState(data).text}
          </ToneText>
          <SkillsCard
            status={data}
            usage={usage.data?.skills ?? null}
            usageError={usage.isError ? errorMessageOf(usage.error) : null}
            testing={status.isFetching}
            onTest={refetch}
            onDone={refetch}
            styles={styles}
            theme={theme}
          />
          <SettingsSectionHeading title="Agent tools by role" meaning={null} state={null} styles={styles} theme={theme} />
          <View style={styles.card}>
            <AgentToolsTable rows={agentToolsRows(data)} styles={styles} theme={theme} />
          </View>
          <SettingsSectionHeading title="Command-line tools" meaning={null} state={null} styles={styles} theme={theme} />
          {data.tools
            .filter((tool) => BEADS_TOOL_IDS.has(tool.id))
            .map((tool) => (
              <ToolCard key={tool.id} tool={tool} styles={styles} theme={theme} onInstalled={refetch} />
            ))}
          <Text style={[styles.body, { fontSize: 11 }]}>{`Newest versions as of ${data.latestCheckedOn}; paseo-bm does not look them up online.`}</Text>
        </>
      )}
    </ScrollView>
  );
}
