/**
 * The destructive flows over request history: delete and reassign
 * (WP-211.2.2; REQ-054, REQ-055b, REQ-057d). Work's project page offers them
 * for one request (its Details) and for a closed workspace (its Requests tab);
 * Settings → Data offers them per workspace with history.
 *
 * These live in their own file because they are the only irreversible thing the
 * plugin's screens can do, and they have their own review and evidence boundary.
 *
 * The shape is always the same three steps, and none can be skipped:
 *
 * 1. ask the server what would be lost (`dryRun: true`);
 * 2. show that answer and wait — the confirmation gate has no default "Yes",
 *    it simply has nothing pending until step 1 returned;
 * 3. only then call the real RPC.
 *
 * Nothing here runs on mount, on a timer, or on a refresh: every path starts
 * with a press (REQ-054f).
 *
 * Client rules: React Native primitives only, colours from `theme.colors`, no
 * Node import, no `server/` import.
 */
import { type PluginSurfaceProps, useRpc, usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { tracesDeleteRpc, tracesReassignRpc, type WorkspaceState } from "../shared/contracts";
import type { dashboardStyles } from "./styles";
import { OLDER_THAN_DAYS, createConfirmationGate, describeAction, olderThanCutoff, type DeleteScope } from "./history-model";
import { errorMessageOf } from "./errors";
import { Button, ToneText } from "./ui";

export interface TraceActionsProps {
  theme: PluginSurfaceProps["theme"];
  /** A phone: the buttons stack. */
  compact: boolean;
  styles: ReturnType<typeof dashboardStyles>;
  workspaceId: string;
  scope: "workspace" | "trace";
  traceId?: string;
  /** Reassignment is only offered for a workspace Paseo no longer lists. */
  workspaceState?: WorkspaceState;
  onDone: () => void;
}

export function TraceActions({
  theme,
  compact,
  styles,
  workspaceId,
  scope,
  traceId,
  workspaceState,
  onDone,
}: TraceActionsProps) {
  const deleteTraces = useRpc(tracesDeleteRpc);
  const reassign = useRpc(tracesReassignRpc);
  const paseo = usePaseo();
  const gate = useMemo(() => createConfirmationGate(), []);
  const pending = useSyncExternalStore(gate.subscribe, gate.getPending, gate.getPending);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targets = useQuery({
    queryKey: ["paseo-bm", "reassign-targets"],
    queryFn: async () => {
      const result = await paseo.workspaces.list({ sort: [{ key: "activity_at", direction: "desc" }] });
      return result.entries
        .filter((workspace) => !workspace.archivingAt && workspace.id !== workspaceId)
        .map((workspace) => ({ id: workspace.id, label: workspace.title || workspace.name }));
    },
    enabled: workspaceState === "orphaned",
  });

  /** Step 1: ask what would be lost, then hand it to the gate. */
  const preview = async (deleteScope: DeleteScope) => {
    setError(null);
    setBusy(true);
    try {
      const result = await deleteTraces({ workspaceId, scope: deleteScope, dryRun: true });
      gate.request({
        kind: "delete",
        scope: deleteScope,
        preview: result.deleted,
        running: result.deleted.running,
      });
    } catch (failure) {
      setError(errorMessageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const previewReassign = async (toWorkspaceId: string) => {
    setError(null);
    setBusy(true);
    try {
      const result = await reassign({ fromWorkspaceId: workspaceId, toWorkspaceId, dryRun: true });
      gate.request({ kind: "reassign", fromWorkspaceId: workspaceId, toWorkspaceId, preview: result.moved });
    } catch (failure) {
      setError(errorMessageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  /** Step 3: the only place either destructive RPC is called for real. */
  const runPending = async () => {
    setError(null);
    setBusy(true);
    try {
      await gate.confirm(async (action) => {
        if (action.kind === "delete") {
          await deleteTraces({ workspaceId, scope: action.scope });
        } else {
          await reassign({ fromWorkspaceId: action.fromWorkspaceId, toWorkspaceId: action.toWorkspaceId });
        }
      });
      onDone();
    } catch (failure) {
      setError(errorMessageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const described = pending === null ? null : describeAction(pending);

  return (
    <View style={{ gap: compact ? 6 : 8 }}>
      {error === null ? null : (
        <ToneText tone="danger" accessibilityLiveRegion="polite" styles={styles} theme={theme}>
          {error}
        </ToneText>
      )}

      {described === null ? (
        <View style={{ flexDirection: compact ? "column" : "row", gap: 8 }}>
          {scope === "trace" && traceId !== undefined ? (
            <Button
              label="Delete this request's history"
              kind="danger"
              accessibilityLabel="Delete the recorded history of this request"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => {
                void preview({ traceId });
              }}
              styles={styles}
            />
          ) : null}

          {scope === "workspace" ? (
            <>
              <Button
                label={`Delete traces older than ${OLDER_THAN_DAYS} days`}
                kind="danger"
                accessibilityLabel={`Delete traces older than ${OLDER_THAN_DAYS} days`}
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => {
                  void preview({ before: olderThanCutoff(new Date()) });
                }}
                styles={styles}
              />
              <Button
                label="Delete all traces here"
                kind="danger"
                accessibilityLabel="Delete every trace of this workspace"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => {
                  void preview({ allOfWorkspace: true });
                }}
                styles={styles}
              />
            </>
          ) : null}

          {busy ? <ActivityIndicator color={styles.spinner.color} /> : null}
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{described.title}</Text>
          {described.body.map((line) => (
            <Text key={line} style={styles.body}>
              {line}
            </Text>
          ))}
          <View style={{ flexDirection: compact ? "column" : "row", gap: 8 }}>
            {/* Cancel first, so the safe choice is the one under the thumb. */}
            <Button
              label="No, keep them"
              kind="secondary"
              accessibilityLabel="Cancel and keep the traces"
              onPress={() => {
                setError(null);
                gate.cancel();
              }}
              styles={styles}
            />
            <Button
              label={busy ? "Working…" : described.confirmLabel}
              kind="danger"
              accessibilityLabel={described.confirmLabel}
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => {
                void runPending();
              }}
              styles={styles}
            />
          </View>
        </View>
      )}

      {/* Reassignment: only for a workspace Paseo no longer lists (REQ-057d). */}
      {described === null && scope === "workspace" && workspaceState === "orphaned" ? (
        <View style={{ gap: 6 }}>
          <Text style={styles.body}>
            Move these traces onto a workspace that exists. They keep the workspace they were
            recorded under; only the grouping changes.
          </Text>
          {targets.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
          {targets.data?.length === 0 ? (
            <Text style={styles.body}>There is no other workspace to move them to.</Text>
          ) : null}
          {targets.data?.map((target) => (
            <Button
              key={target.id}
              label={`Reassign to ${target.label}`}
              kind="secondary"
              accessibilityLabel={`Reassign these traces to ${target.label}`}
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => {
                void previewReassign(target.id);
              }}
              styles={styles}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
