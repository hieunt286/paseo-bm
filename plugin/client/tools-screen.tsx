/**
 * Tools & skills, a section of the management surface (change-014 outcome 5;
 * experience concept §4.4; the approved mockup `Tools.dc.html`), on one
 * scrolling column at most 1040 wide:
 *
 * - **Skills** — where they are installed and what Used counts, Update all
 *   (the skills CLI, behind its confirmation, Cancel first; "Install skills…"
 *   while one is missing) and Check again; then a table — Skill (with its
 *   install state per agent), Used by, Used (how many Worker reports named it
 *   in the last 30 days, every project) and Manage, which opens the skill's
 *   install state per agent, its problem and the command to run yourself.
 * - **Agent tools by role** — a table: what Paseo's agent tools let each role
 *   do (in the warning colour when the last one had none), and paseo-bm's own.
 * - **Command-line tools** — `br` and `bv`, one row each: installed, the
 *   update available, or Install… behind its confirmation.
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
import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { skillsUsageRpc, type SetupStatus } from "../shared/contracts";
import { errorMessageOf } from "./errors";
import { localTimeText } from "./format";
import { SKILLS_COMMAND_LABEL, anySkillMissing, skillsRunLine } from "./settings-machine-model";
import { CommandLine, SkillsInstallBlock, ToolCard } from "./settings-blocks";
import { SettingsSectionHeading, sectionContentStyle, useSetupStatus, type SettingsScreenProps } from "./settings-section";
import { dashboardStyles } from "./styles";
import { MONO } from "./text-tabs";
import { toneColor } from "./tone";
import {
  BEADS_TOOL_IDS,
  SKILLS_USAGE_DAYS,
  SKILLS_USAGE_QUERY_KEY,
  agentToolsRows,
  skillRowsView,
  skillsHeaderText,
  type AgentToolsRowView,
  type SkillRowView,
} from "./tools-screen-model";
import { Chip, ToneText, type Styles, type Theme } from "./ui";

/** The Skills table's columns (the mockup's grid): the skill takes the rest. */
const SKILL_COLUMNS = { usedBy: 260, used: 110, manage: 120 } as const;
/** The agent tools table's first column. */
const ROLE_COLUMN = 140;

/** A table's header row: small uppercase muted labels over a 1px rule. */
function TableHeader({ children, theme }: { children: ReactNode; theme: Theme }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      {children}
    </View>
  );
}

function headerText(theme: Theme) {
  return { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "500" as const, textTransform: "uppercase" as const, letterSpacing: 0.72 };
}

/** The small secondary button of a row (Manage): a 1px border, muted text. */
function SmallButton({ label, accessibilityLabel, expanded, onPress, theme }: {
  label: string;
  accessibilityLabel: string;
  expanded?: boolean;
  onPress: () => void;
  theme: Theme;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      {...(expanded === undefined ? {} : { accessibilityState: { expanded } })}
      onPress={onPress}
      style={{ borderWidth: 1, borderColor: theme.colors.border, paddingVertical: 5, paddingHorizontal: 10 }}
    >
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

/**
 * The skills, one row each (the approved mockup): the name in mono with its
 * install state per agent under it (its tone's colour when one is missing or
 * broken), who uses it, the Used count, and Manage, which opens the row's
 * details — the install state per agent and the problem — under it. A
 * problem also shows under the name. Hook-free; `open` is the row Manage
 * opened.
 */
export function SkillsTable({ rows, open = null, onManage = () => undefined, details, narrow = false, styles, theme }: {
  rows: readonly SkillRowView[];
  /** A phone: the Used by column gives way, the others shrink. */
  narrow?: boolean;
  open?: string | null;
  onManage?: (name: string) => void;
  /** What an opened row shows under its chips (the command to install or update). */
  details?: ReactNode;
  styles: Styles;
  theme: Theme;
}) {
  const { colors } = theme;
  const columns = narrow ? { usedBy: 0, used: 48, manage: 84 } : SKILL_COLUMNS;
  return (
    <View>
      <TableHeader theme={theme}>
        <Text style={[headerText(theme), { flex: 1 }]}>Skill</Text>
        {narrow ? null : <Text style={[headerText(theme), { width: columns.usedBy }]}>Used by</Text>}
        <Text style={[headerText(theme), { width: columns.used, textAlign: "right" }]}>Used</Text>
        <View style={{ width: columns.manage }} />
      </TableHeader>
      {rows.map((row) => {
        const expanded = open === row.name;
        return (
          <View key={row.name} style={{ paddingVertical: 13, gap: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }} accessibilityLabel={row.accessibilityLabel}>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text style={{ color: colors.foreground, fontSize: 14, fontFamily: MONO }}>{row.name}</Text>
                <Text style={{ color: row.summaryTone === "muted" ? colors.foregroundMuted : toneColor(theme, row.summaryTone), fontSize: 13 }}>{row.summary}</Text>
                {row.problem === null ? null : (
                  <ToneText tone="danger" style={{ fontSize: 13 }} styles={styles} theme={theme}>
                    {row.problem}
                  </ToneText>
                )}
              </View>
              {narrow ? null : <Text style={{ width: columns.usedBy, color: colors.foreground, fontSize: 13 }}>{row.usedBy}</Text>}
              <Text style={{ width: columns.used, color: colors.foreground, fontSize: 14, fontFamily: MONO, textAlign: "right" }}>{row.used}</Text>
              <View style={{ width: columns.manage, alignItems: "flex-end" }}>
                <SmallButton
                  label={expanded ? "Close" : "Manage"}
                  accessibilityLabel={expanded ? `Close ${row.name}` : `Manage ${row.name}: its install state per agent`}
                  expanded={expanded}
                  onPress={() => onManage(row.name)}
                  theme={theme}
                />
              </View>
            </View>
            {expanded ? (
              <View style={{ gap: 8, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: colors.border }}>
                {row.chips.length === 0 ? (
                  <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{row.note ?? "No install state reported."}</Text>
                ) : (
                  <View style={styles.chipRow}>
                    {row.chips.map((badge) => (
                      <Chip key={badge.text} badge={badge} styles={styles} theme={theme} />
                    ))}
                  </View>
                )}
                {details}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** Paseo's tools in full contrast, "none" muted, a warning in its colour. */
function paseoToolsColor(theme: Theme, paseo: AgentToolsRowView["paseo"]): string {
  if (paseo.tone !== "muted") return toneColor(theme, paseo.tone);
  return paseo.text === "none" ? theme.colors.foregroundMuted : theme.colors.foreground;
}

/** The agent tools by role (the approved mockup): Role · Paseo tools · paseo-bm tools, one row per role, Paseo's tools in their tone. Hook-free. */
export function AgentToolsTable({ rows, theme }: { rows: readonly AgentToolsRowView[]; styles?: Styles; theme: Theme }) {
  const { colors } = theme;
  return (
    <View>
      <TableHeader theme={theme}>
        <Text style={[headerText(theme), { width: ROLE_COLUMN }]}>Role</Text>
        <Text style={[headerText(theme), { flex: 1 }]}>Paseo tools</Text>
        <Text style={[headerText(theme), { flex: 1 }]}>paseo-bm tools</Text>
      </TableHeader>
      {rows.map((row) => (
        <View
          key={row.role}
          accessibilityLabel={`${row.role}: Paseo tools ${row.paseo.text}; paseo-bm tools ${row.bm}`}
          style={{ flexDirection: "row", gap: 12, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: colors.border }}
        >
          <Text style={{ width: ROLE_COLUMN, color: colors.foreground, fontSize: 14 }}>{row.role}</Text>
          <Text style={{ flex: 1, fontSize: 13, color: paseoToolsColor(theme, row.paseo) }}>{row.paseo.text}</Text>
          <Text style={{ flex: 1, color: colors.foreground, fontSize: 12, fontFamily: MONO }}>{row.bm}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The Skills section: the title with where they are installed, Check again
 * and Update all (its confirmation opens under the title), the table, the
 * last run and a failed usage read.
 */
function SkillsSection({ status, usage, usageError, testing, narrow, onTest, onDone, styles, theme }: {
  status: SetupStatus;
  usage: Parameters<typeof skillRowsView>[1];
  usageError: string | null;
  testing: boolean;
  narrow: boolean;
  onTest: () => void;
  onDone: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const { colors } = theme;
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const now = new Date();
  const runLine = skillsRunLine(status, now);
  const missing = anySkillMissing(status);
  const updateLabel = missing ? "Install skills…" : "Update all";
  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 12, rowGap: 6, marginBottom: 12 }}>
        <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 22, fontWeight: "600" }}>
          Skills
        </Text>
        <Text style={{ flex: 1, minWidth: 200, color: colors.foregroundMuted, fontSize: 14 }}>{skillsHeaderText(status.skills.dirs)}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Test the agent skills again"
          accessibilityState={{ disabled: testing, busy: testing }}
          disabled={testing}
          onPress={onTest}
        >
          <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{testing ? "Checking…" : "Check again"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${updateLabel.replace("…", "")}: runs the skills command after a confirmation`}
          onPress={() => setAsking(true)}
          style={{ borderWidth: 1, borderColor: colors.border, paddingVertical: 8, paddingHorizontal: 14 }}
        >
          <Text style={{ color: colors.foreground, fontSize: 14 }}>{updateLabel}</Text>
        </Pressable>
      </View>
      <SkillsInstallBlock command={status.skills.installCommand} onDone={onDone} asking={asking} onAskingChange={setAsking} styles={styles} theme={theme} />
      <SkillsTable
        rows={skillRowsView(status, usage)}
        open={open}
        onManage={(name) => setOpen(open === name ? null : name)}
        narrow={narrow}
        details={<CommandLine label={SKILLS_COMMAND_LABEL} command={status.skills.installCommand} styles={styles} theme={theme} />}
        styles={styles}
        theme={theme}
      />
      <View style={{ gap: 4, marginTop: 12 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
          {`Checked ${localTimeText(new Date(status.skills.checkedAt), now)}${runLine === null ? "" : ` · ${runLine}`}`}
        </Text>
        {usageError === null ? null : (
          <ToneText tone="danger" style={{ fontSize: 12 }} styles={styles} theme={theme}>
            {usageError}
          </ToneText>
        )}
      </View>
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
    <ScrollView style={styles.screen} contentContainerStyle={sectionContentStyle(1040, layout.compact)}>
      {statusStrip}
      {status.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {status.isError ? (
        <ToneText tone="danger" styles={styles} theme={theme}>
          {errorMessageOf(status.error)}
        </ToneText>
      ) : null}
      {data === undefined ? null : (
        <>
          <SkillsSection
            status={data}
            usage={usage.data?.skills ?? null}
            usageError={usage.isError ? errorMessageOf(usage.error) : null}
            testing={status.isFetching}
            narrow={layout.compact}
            onTest={refetch}
            onDone={refetch}
            styles={styles}
            theme={theme}
          />
          <View style={{ gap: 12 }}>
            <SettingsSectionHeading title="Agent tools by role" meaning={null} state={null} size="group" styles={styles} theme={theme} />
            <AgentToolsTable rows={agentToolsRows(data)} styles={styles} theme={theme} />
          </View>
          <View>
            <View style={{ marginBottom: 12 }}>
              <SettingsSectionHeading title="Command-line tools" meaning={null} state={null} size="group" styles={styles} theme={theme} />
            </View>
            {data.tools
              .filter((tool) => BEADS_TOOL_IDS.has(tool.id))
              .map((tool, index) => (
                <ToolCard key={tool.id} tool={tool} first={index === 0} styles={styles} theme={theme} onInstalled={refetch} />
              ))}
            <Text style={{ marginTop: 12, color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {`Newest versions as of ${data.latestCheckedOn}; paseo-bm does not look them up online.`}
            </Text>
          </View>
        </>
      )}
    </ScrollView>
  );
}
