/**
 * The Beads screen: list, detail and the three hand-off actions
 * (design delta 20260916-beads-screen).
 *
 * An action never touches the bead store. It makes sure the workspace has a
 * Beads Manager and sends it a request; the Manager delegates to a Worker like
 * any other request, so labels, reports, the review budget and the Metric
 * screen all keep working.
 */
import { isReady, readBeads, type BeadRecord } from "./beads-store";
import { DashboardError, type BeadAction, type BeadDetail, type BeadRow } from "../shared/contracts";

export function beadRowOf(bead: BeadRecord, all: Map<string, BeadRecord>): BeadRow {
  return {
    id: bead.id,
    title: bead.title,
    status: bead.status,
    issueType: bead.issueType,
    priority: bead.priority,
    labels: bead.labels,
    createdAt: bead.createdAt,
    updatedAt: bead.updatedAt === "" ? null : bead.updatedAt,
    closedAt: bead.closedAt,
    ready: bead.status !== "closed" && isReady(bead, all),
    parentId: bead.parentId,
    work: null,
  };
}

/** Every bead of a workspace, newest update first. */
export function listBeadRows(workspaceDirectory: string): BeadRow[] {
  const { beads } = readBeads(workspaceDirectory);
  return [...beads.values()]
    .map((bead) => beadRowOf(bead, beads))
    .sort((a, b) => ((a.updatedAt ?? "") < (b.updatedAt ?? "") ? 1 : (a.updatedAt ?? "") > (b.updatedAt ?? "") ? -1 : 0));
}

export function getBeadDetail(workspaceDirectory: string, id: string): BeadDetail {
  const { beads } = readBeads(workspaceDirectory);
  const bead = beads.get(id);
  if (bead === undefined) throw new DashboardError("E_BEAD_NOT_FOUND", `no bead ${id} in ${workspaceDirectory}`);
  return {
    ...beadRowOf(bead, beads),
    description: bead.description,
    closeReason: bead.closeReason,
    blockedBy: bead.blockedBy,
    children: [...beads.values()].filter((other) => other.parentId === id).map((other) => other.id),
  };
}

const INSTRUCTION: Record<BeadAction, string> = {
  implement: "Have a Worker implement this bead until it is closed with evidence, following its acceptance criteria.",
  delete:
    "Have a Worker assess whether this bead is still needed. If it is not, delete it with the tracker (br) and report why. If it is still needed, do not delete it; report the reason instead.",
  close:
    "Have a Worker check whether this bead can be closed: its acceptance criteria are met and nothing it requires is still open. If so, close it with the tracker (br) and the evidence as the reason. If not, leave it open and report what is missing.",
};

/** The request the Manager receives. Agent-facing, so English. */
export function actionMessage(action: BeadAction, bead: Pick<BeadRow, "id" | "title">): string {
  const title = bead.title === null ? "" : ` ("${bead.title}")`;
  return [
    `[Beads screen] The user asks: ${action} bead ${bead.id}${title}.`,
    INSTRUCTION[action],
    "The user confirmed this action on the Beads screen. Treat it as a new request from the user. Do not commit or push.",
  ].join("\n");
}

export interface BeadActionPaseo {
  agents: { ref(agentId: string): { send(text: string): Promise<void> } };
}

/**
 * Sends the action to the workspace's Manager. `ensure` is the existing
 * `ensureManager` bound to this host, so a workspace without a Manager gets
 * one exactly as the launcher would create it.
 */
export async function runBeadAction(
  input: { workspaceId: string; action: BeadAction; bead: Pick<BeadRow, "id" | "title"> },
  deps: {
    paseo: BeadActionPaseo;
    ensure: (workspaceId: string) => Promise<{ agentId: string; created: boolean }>;
  },
): Promise<{ managerId: string; created: boolean }> {
  const manager = await deps.ensure(input.workspaceId);
  await deps.paseo.agents.ref(manager.agentId).send(actionMessage(input.action, input.bead));
  return { managerId: manager.agentId, created: manager.created };
}
