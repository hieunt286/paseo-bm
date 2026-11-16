import { afterEach, describe, expect, it, vi } from "vitest";
import { decideRefusalOf, EMPTY_AUTONOMY_POLICY } from "../plugin/shared/autonomy";
import { DashboardError, missionGetRpc } from "../plugin/shared/contracts";
import { answerDecision, carriesPreparedChange, type Decision } from "../plugin/shared/decisions";
import { whyIneligible } from "../plugin/shared/question-subjects";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { handleDecisionsAnswer } from "../plugin/server/decision-rpc";
import {
  applyIntegrationDecision,
  applyLocalMergeDecision,
  integrationCoverOf,
  integrationFactLine,
  integrationWindowOf,
  isIntegrationCard,
  isLocalMergeCard,
  localMergeHolds,
  openIntegrationCardIfNeeded,
  openLocalMergeCardIfNeeded,
  revokeIntegration,
  revokeLocalMerge,
} from "../plugin/server/integration-grant";
import { createMissionDecisionStore } from "../plugin/server/mission-decisions";
import { createMissionStore, type Placement } from "../plugin/server/mission-store";
import { handleMissionGet, handleMissionIntegrationAsk, handleMissionIntegrationRevoke, integrationStateOf, localMergeStateOf } from "../plugin/server/missions-rpc";
import { createOutbox } from "../plugin/server/outbox";
import { placementOf } from "../plugin/server/placements";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * The owner's standing integration grant (delivery line design §4.3): the
 * card opened once per mission × repo, answered by the owner's tap only, its
 * grant written on the placement, used by the boundary and revoked by the
 * owner with a `BM-SETTINGS` to the placement's Workers. Temporary data
 * folders and the fake Paseo handle only.
 */

const NOW = new Date("2026-10-21T10:00:00.000Z");
const REPO = "wks_repo";
const PLACE = "wks_place";
const BRANCH = "m/ABC/fe";

afterEach(() => {
  clearJsonFileCache();
  removeDataFolders();
});

function placement(over: Partial<Placement> = {}): Placement {
  return {
    repo: REPO,
    workspaceId: PLACE,
    directory: "/tmp/worktrees/m-abc-fe",
    branch: BRANCH,
    target: "develop",
    base: "origin/develop",
    worktreeSlug: "m-abc-fe",
    state: "ready",
    requestKey: "bm-place-x",
    createdAt: NOW.toISOString(),
    deps: { cloned: [], at: null, note: null },
    integration: null,
    ...over,
  };
}

function missionIn(home: string, placements: Placement[] = [placement()]): string {
  const store = createMissionStore(home, { now: () => NOW });
  const made = store.create({ code: "ABC", name: "Alpha", goal: "Ship it.", repos: [REPO], createdBy: "owner", mainId: "main-1" });
  if (!made.ok) throw new Error(made.reasons.join("\n"));
  const updated = store.update(made.mission.missionId, (mission) => ({ ...mission, placements }));
  if (!updated.ok) throw new Error(updated.reasons.join("\n"));
  return made.mission.missionId;
}

const deps = (home: string, extra: Record<string, unknown> = {}) => ({ home, now: NOW, log: () => {}, ...extra });

function openCard(home: string, missionId: string): Decision {
  const id = openIntegrationCardIfNeeded(home, missionId, REPO, { now: NOW, log: () => {}, requestId: "req-20261021T090000Z" });
  if (id === null) throw new Error("no card opened");
  return createMissionDecisionStore(home).get(id)!;
}

describe("the integration card (§4.3)", () => {
  it("is ownerOnly, release, subject integration, a Yes carrying the grant and a Not now, the design's question word for word", () => {
    const home = dataFolder();
    const missionId = missionIn(home);
    const card = openCard(home, missionId);
    expect(card).toMatchObject({
      id: `m:${missionId}:1`,
      workspaceId: missionId,
      requestId: "req-20261021T090000Z",
      askedBy: { role: "plugin", agentId: null },
      subject: "integration",
      class: "release",
      ownerOnly: true,
      status: "open",
    });
    expect(card.question).toBe("Push `m/ABC/fe` and open its merge request into `develop`? Later pushes and updates of this merge request are then covered; merging stays on GitLab.");
    expect(card.options).toEqual([
      { key: "a", label: "Yes, for this mission and repository", recommended: false, effects: ["push"], action: { kind: "integration.grant", missionId, repo: REPO } },
      { key: "b", label: "Not now — keep committing locally", recommended: false, effects: ["none"] },
    ]);
    expect(createMissionStore(home).journal(missionId).map((line) => line.text)).toContain(`The owner is asked on ${card.id} to allow pushing ${BRANCH} and its merge request into develop.`);
  });

  it("opens once per mission × repo: never again while open, after Not now, or with a grant; never for a placement not ready", () => {
    const home = dataFolder();
    const missionId = missionIn(home);
    const card = openCard(home, missionId);
    expect(openIntegrationCardIfNeeded(home, missionId, REPO, { now: NOW, log: () => {} })).toBeNull();
    createMissionDecisionStore(home).transition(card.id, (current) => answerDecision(current, { via: "inbox", optionKey: "b", at: NOW.toISOString() }));
    expect(openIntegrationCardIfNeeded(home, missionId, REPO, { now: NOW, log: () => {} })).toBeNull();
    expect(createMissionDecisionStore(home).list(missionId)).toHaveLength(1);

    const granted = dataFolder();
    const withGrant = missionIn(granted, [placement({ integration: { state: "revoked", decisionId: "m:mis-0000000001:1", grantedAt: NOW.toISOString(), revokedAt: NOW.toISOString(), scope: { remote: "origin", branch: BRANCH, target: "develop" }, mr: null } })]);
    expect(openIntegrationCardIfNeeded(granted, withGrant, REPO, { now: NOW, log: () => {} })).toBeNull();

    const creating = dataFolder();
    const notReady = missionIn(creating, [placement({ state: "creating" })]);
    expect(openIntegrationCardIfNeeded(creating, notReady, REPO, { now: NOW, log: () => {} })).toBeNull();
    expect(openIntegrationCardIfNeeded(creating, notReady, "wks_none", { now: NOW, log: () => {} })).toBeNull();
  });

  it("negative: no policy, level, Main, Orchestrator, chat relay or precedent answers it", () => {
    const home = dataFolder();
    const card = openCard(home, missionIn(home));
    const at = NOW.toISOString();
    expect(answerDecision(card, { by: "policy", via: "inbox", optionKey: "a", at }).ok).toBe(false);
    expect(answerDecision(card, { by: "main", via: "main", optionKey: "a", at }).ok).toBe(false);
    expect(answerDecision(card, { by: "precedent", via: "inbox", optionKey: "a", at, precedentId: "p-1" }).ok).toBe(false);
    expect(answerDecision(card, { via: "chat-manager", optionKey: "a", at }).ok).toBe(false);
    expect(carriesPreparedChange(card)).toBe(true);
    expect(decideRefusalOf(EMPTY_AUTONOMY_POLICY, card)).not.toBeNull();
    expect(whyIneligible(card.subject, card)).toBe('"integration" is a question paseo-bm asks you itself, once per mission and repository; no precedent answers it');
  });
});

describe("the grant (§4.3)", () => {
  it("the owner's Yes writes the grant scoped to the placement and tells its live Workers; Not now writes none", async () => {
    const home = dataFolder();
    const missionId = missionIn(home);
    const card = openCard(home, missionId);
    const fake = fakePaseo({ agents: [{ id: "w-1", workspaceId: PLACE, status: "idle", provider: "bm-worker", labels: { "bm.role": "worker" } }, { id: "w-2", workspaceId: "wks_other", status: "idle", provider: "bm-worker", labels: { "bm.role": "worker" } }] });
    const enqueue = vi.fn<(targetId: string, kind: string, text: string, paseo?: unknown) => Promise<"sent">>(async () => "sent");
    const answered = answerDecision(card, { via: "inbox", optionKey: "a", at: NOW.toISOString() });
    if (!answered.ok) throw new Error(answered.message);
    await applyIntegrationDecision(answered.decision, deps(home, { paseo: fake.paseo, enqueue }));
    const written = placementOf(home, missionId, REPO)!;
    expect(written.integration).toEqual({ state: "granted", decisionId: card.id, grantedAt: NOW.toISOString(), revokedAt: null, scope: { remote: "origin", branch: BRANCH, target: "develop" }, mr: null });
    expect(integrationFactLine(written)).toBe("Integration: m/ABC/fe → develop; commit: yes; push/MR: yes.");
    expect(enqueue.mock.calls).toEqual([
      [
        "w-1",
        "BM-SETTINGS",
        'BM-SETTINGS The owner changed what your mission branch may do. This replaces the "Integration:" line under "## Runtime facts":\nIntegration: m/ABC/fe → develop; commit: yes; push/MR: yes.\nDo not reply to this message; carry on with what you were doing.',
        fake.paseo,
      ],
    ]);

    const other = dataFolder();
    const otherMission = missionIn(other);
    const notNow = answerDecision(openCard(other, otherMission), { via: "inbox", optionKey: "b", at: NOW.toISOString() });
    if (!notNow.ok) throw new Error(notNow.message);
    await applyIntegrationDecision(notNow.decision, deps(other));
    expect(placementOf(other, otherMission, REPO)?.integration).toBeNull();
    expect(integrationFactLine(placementOf(other, otherMission, REPO)!)).toBe("Integration: m/ABC/fe → develop; commit: yes; push/MR: no.");
  });

  it("decisions.answer applies it on the owner's tap; a retired placement is refused, nothing written", async () => {
    const home = dataFolder();
    const missionId = missionIn(home);
    const card = openCard(home, missionId);
    await handleDecisionsAnswer({ id: card.id, optionKey: "a" }, undefined, { home, now: () => NOW, log: () => {} });
    expect(placementOf(home, missionId, REPO)?.integration?.state).toBe("granted");
    expect(createMissionDecisionStore(home).get(card.id)?.answer).toMatchObject({ by: "owner", optionKey: "a" });

    const retired = dataFolder();
    const retiredMission = missionIn(retired);
    const retiredCard = openCard(retired, retiredMission);
    createMissionStore(retired).update(retiredMission, (mission) => ({ ...mission, placements: [placement({ state: "retired" })] }));
    const error = await handleDecisionsAnswer({ id: retiredCard.id, optionKey: "a" }, undefined, { home: retired, now: () => NOW, log: () => {} }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DashboardError);
    expect((error as DashboardError).code).toBe("E_MISSION_INVALID");
    expect(createMissionDecisionStore(retired).get(retiredCard.id)?.status).toBe("open");
    expect(placementOf(retired, retiredMission, REPO)?.integration).toBeNull();
  });

  it("covers only integration and forge-read findings, only while granted and scoped to the placement", () => {
    const grant = { state: "granted" as const, decisionId: "m:mis-0000000001:1", grantedAt: NOW.toISOString(), revokedAt: null, scope: { remote: "origin" as const, branch: BRANCH, target: "develop" }, mr: null };
    const push = { what: `git push ${BRANCH}`, effects: ["push" as const], unreadable: false, integration: true as const };
    const read = { what: "glab (read)", effects: ["network" as const], unreadable: false, forgeRead: true as const };
    const curl = { what: "curl", effects: ["network" as const], unreadable: false };
    expect(integrationCoverOf([push, read], placement({ integration: grant }))).toBe(true);
    expect(integrationCoverOf([push, curl], placement({ integration: grant }))).toBe(false);
    expect(integrationCoverOf([], placement({ integration: grant }))).toBe(false);
    expect(integrationCoverOf([push], placement())).toBe(false);
    expect(integrationCoverOf([push], placement({ integration: { ...grant, state: "revoked", revokedAt: NOW.toISOString() } }))).toBe(false);
    expect(integrationCoverOf([push], placement({ integration: grant, target: "main" }))).toBe(false);
    expect(integrationWindowOf(placement({ integration: grant }))).toEqual({ grantedAt: NOW.toISOString(), revokedAt: null });
    expect(integrationWindowOf(placement())).toBeNull();
  });
});

describe("the revoke (§4.3, mission.integration.revoke)", () => {
  const granted = () =>
    placement({ integration: { state: "granted", decisionId: "m:mis-0000000001:1", grantedAt: "2026-10-21T09:00:00.000Z", revokedAt: null, scope: { remote: "origin", branch: BRANCH, target: "develop" }, mr: null } });

  it("sets revokedAt, sends BM-SETTINGS to the placement's live Workers and journals a decision line", async () => {
    const home = dataFolder();
    const missionId = missionIn(home, [granted()]);
    const fake = fakePaseo({ agents: [{ id: "w-1", workspaceId: PLACE, status: "idle", provider: "bm-worker", labels: { "bm.role": "worker" } }, { id: "m-1", workspaceId: PLACE, status: "idle", provider: "bm-manager", labels: { "bm.role": "manager" } }] });
    const enqueue = vi.fn<(targetId: string, kind: string, text: string, paseo?: unknown) => Promise<"queued">>(async () => "queued");
    const revoked = await revokeIntegration(missionId, REPO, deps(home, { paseo: fake.paseo, enqueue }));
    expect(revoked).toMatchObject({ ok: true, notified: 1 });
    expect(placementOf(home, missionId, REPO)?.integration).toMatchObject({ state: "revoked", revokedAt: NOW.toISOString(), grantedAt: "2026-10-21T09:00:00.000Z" });
    expect(enqueue.mock.calls.map((call) => [call[0], call[1], call[2].split("\n")[1]])).toEqual([["w-1", "BM-SETTINGS", "Integration: m/ABC/fe → develop; commit: yes; push/MR: no."]]);
    const line = createMissionStore(home).journal(missionId, 10, "decision").at(-1);
    expect(line).toMatchObject({ kind: "decision", by: "owner", text: "The owner revoked pushing m/ABC/fe and its merge request into develop.", ref: "m:mis-0000000001:1" });
    // The window keeps what it covered before the revoke.
    expect(integrationWindowOf(placementOf(home, missionId, REPO)!)).toEqual({ grantedAt: "2026-10-21T09:00:00.000Z", revokedAt: NOW.toISOString() });
  });

  it("the RPC revokes through the same path; no grant, no worktree or an unknown mission is E_MISSION_INVALID", async () => {
    const home = dataFolder();
    const missionId = missionIn(home, [granted()]);
    const fake = fakePaseo({ agents: [{ id: "w-1", workspaceId: PLACE, status: "idle", provider: "bm-worker", labels: { "bm.role": "worker" } }] });
    const output = await handleMissionIntegrationRevoke({ missionId, repo: REPO }, fake.paseo, { home, now: () => NOW, log: () => {} });
    expect(output.revokedAt).toBe(NOW.toISOString());
    const codeOf = async (run: () => Promise<unknown>) => run().then(() => null, (error: unknown) => (error instanceof DashboardError ? [error.code, error.message] : String(error)));
    expect(await codeOf(() => handleMissionIntegrationRevoke({ missionId, repo: REPO }, undefined, { home, now: () => NOW }))).toEqual([
      "E_MISSION_INVALID",
      "E_MISSION_INVALID: push and merge request are not allowed for m/ABC/fe; nothing was changed",
    ]);
    expect((await codeOf(() => handleMissionIntegrationRevoke({ missionId, repo: "wks_none" }, undefined, { home, now: () => NOW })))?.[0]).toBe("E_MISSION_INVALID");
    expect((await codeOf(() => handleMissionIntegrationRevoke({ missionId: "mis-ffffffffff", repo: REPO }, undefined, { home, now: () => NOW })))?.[0]).toBe("E_MISSION_INVALID");
  });
});

describe("the mission page's repo row (§4.9, mission.get)", () => {
  const grant = { decisionId: "m:mis-0000000001:1", grantedAt: "2026-10-21T09:00:00.000Z", scope: { remote: "origin" as const, branch: BRANCH, target: "develop" }, mr: null };

  it("reads push and merge request: allowed, revoked, waiting on the open card, not now, none before any card", () => {
    const home = dataFolder();
    const missionId = missionIn(home);
    expect(integrationStateOf(placement(), [])).toEqual({ state: "none", at: null, decisionId: null });
    const card = openCard(home, missionId);
    expect(integrationStateOf(placement(), [card])).toEqual({ state: "waiting", at: null, decisionId: card.id });
    const notNow = answerDecision(card, { via: "inbox", optionKey: "b", at: NOW.toISOString() });
    if (!notNow.ok) throw new Error(notNow.message);
    expect(integrationStateOf(placement(), [notNow.decision])).toEqual({ state: "not-now", at: null, decisionId: card.id });
    // A card of another repo says nothing of this one.
    expect(integrationStateOf(placement({ repo: "wks_other" }), [card])).toEqual({ state: "none", at: null, decisionId: null });
    expect(integrationStateOf(placement({ integration: { ...grant, state: "granted", revokedAt: null } }), [notNow.decision])).toEqual({ state: "allowed", at: grant.grantedAt, decisionId: grant.decisionId });
    expect(integrationStateOf(placement({ integration: { ...grant, state: "revoked", revokedAt: NOW.toISOString() } }), [])).toEqual({ state: "revoked", at: NOW.toISOString(), decisionId: grant.decisionId });
  });

  it("mission.get carries the placement on its repo, and the mission state's lines; a repo with no worktree has none", async () => {
    const home = dataFolder();
    const missionId = missionIn(home);
    createMissionStore(home).update(missionId, (mission) => ({ ...mission, charter: { ...mission.charter, repos: [REPO, "wks_plain"] } }));
    const card = openCard(home, missionId);
    const page = missionGetRpc.output.parse(await handleMissionGet({ missionId }, undefined, { home, now: () => NOW, log: () => {} }));
    const [placed, plain] = page.summary.repos;
    expect(placed!.placement).toEqual({
      branch: BRANCH,
      target: "develop",
      state: "ready",
      dirty: null,
      ahead: null,
      behind: null,
      lastCommitAt: null,
      pushed: null,
      mr: null,
      ci: null,
      readAt: null,
      integration: { state: "waiting", at: null, decisionId: card.id },
      localMerge: { state: "none", at: null, decisionId: null },
      // Delivery line design §19.8: lane 1 alone, idle, and no overlap.
      lanes: [{ lane: 1, branch: BRANCH, workspaceId: PLACE, state: "ready", requests: [], freeSince: null, mergedAt: null, mergePending: null }],
      maxLanes: 7,
      overlaps: [],
    });
    expect(plain!.placement).toBeUndefined();
    expect(page.inFlight?.placements).toEqual([expect.objectContaining({ repo: REPO, branch: BRANCH, target: "develop", grant: null })]);
  });
});

describe("Ask me again (§4.3, mission.integration.ask)", () => {
  const rpc = (home: string) => ({ home, now: () => NOW, log: () => {} });
  const codeOf = async (run: () => Promise<unknown>) => run().then(() => null, (error: unknown) => (error instanceof DashboardError ? [error.code, error.message] : String(error)));

  it("after Not now, opens a fresh owner-only card for the placement; the row then waits for the owner", async () => {
    const home = dataFolder();
    const missionId = missionIn(home);
    const first = openCard(home, missionId);
    createMissionDecisionStore(home).transition(first.id, (current) => answerDecision(current, { via: "inbox", optionKey: "b", at: NOW.toISOString() }));
    const { decisionId } = await handleMissionIntegrationAsk({ missionId, repo: REPO }, undefined, rpc(home));
    expect(decisionId).toBe(`m:${missionId}:2`);
    const card = createMissionDecisionStore(home).get(decisionId)!;
    expect(card).toMatchObject({ subject: "integration", class: "release", ownerOnly: true, status: "open", requestId: null, question: first.question, options: first.options });
    expect(createMissionStore(home).journal(missionId, 10, "decision").at(-1)).toMatchObject({ by: "owner", text: `The owner asked again on ${decisionId} to allow pushing ${BRANCH} and its merge request into develop.`, ref: decisionId });
    expect(integrationStateOf(placementOf(home, missionId, REPO)!, createMissionDecisionStore(home).list(missionId))).toEqual({ state: "waiting", at: null, decisionId });
    // The plugin's own opener still never asks again.
    expect(openIntegrationCardIfNeeded(home, missionId, REPO, { now: NOW, log: () => {} })).toBeNull();
  });

  it("after a revoke, asks again; the owner's Yes grants anew", async () => {
    const home = dataFolder();
    const missionId = missionIn(home, [placement({ integration: { state: "revoked", decisionId: "m:mis-0000000001:1", grantedAt: NOW.toISOString(), revokedAt: NOW.toISOString(), scope: { remote: "origin", branch: BRANCH, target: "develop" }, mr: null } })]);
    const { decisionId } = await handleMissionIntegrationAsk({ missionId, repo: REPO }, undefined, rpc(home));
    await handleDecisionsAnswer({ id: decisionId, optionKey: "a" }, undefined, rpc(home));
    expect(placementOf(home, missionId, REPO)?.integration).toMatchObject({ state: "granted", decisionId, revokedAt: null });
  });

  it("negative: refused with E_MISSION_INVALID while a card is open, while the grant holds, with no ready worktree, or for a closed or unknown mission; nothing is written", async () => {
    const home = dataFolder();
    const missionId = missionIn(home);
    const open = openCard(home, missionId);
    expect(await codeOf(() => handleMissionIntegrationAsk({ missionId, repo: REPO }, undefined, rpc(home)))).toEqual(["E_MISSION_INVALID", `E_MISSION_INVALID: ${open.id} already asks you about ${BRANCH}; nothing was asked`]);
    expect(createMissionDecisionStore(home).list(missionId)).toHaveLength(1);

    const granted = dataFolder();
    const grantedMission = missionIn(granted, [placement({ integration: { state: "granted", decisionId: "m:mis-0000000001:1", grantedAt: NOW.toISOString(), revokedAt: null, scope: { remote: "origin", branch: BRANCH, target: "develop" }, mr: null } })]);
    expect(await codeOf(() => handleMissionIntegrationAsk({ missionId: grantedMission, repo: REPO }, undefined, rpc(granted)))).toEqual(["E_MISSION_INVALID", `E_MISSION_INVALID: push and merge request are already allowed for ${BRANCH}; nothing was asked`]);

    const retired = dataFolder();
    const retiredMission = missionIn(retired, [placement({ state: "retired" })]);
    expect((await codeOf(() => handleMissionIntegrationAsk({ missionId: retiredMission, repo: REPO }, undefined, rpc(retired))))?.[0]).toBe("E_MISSION_INVALID");
    expect((await codeOf(() => handleMissionIntegrationAsk({ missionId: retiredMission, repo: "wks_none" }, undefined, rpc(retired))))?.[0]).toBe("E_MISSION_INVALID");
    expect((await codeOf(() => handleMissionIntegrationAsk({ missionId: "mis-ffffffffff", repo: REPO }, undefined, rpc(retired))))?.[0]).toBe("E_MISSION_INVALID");
    expect(createMissionDecisionStore(granted).list(grantedMission)).toHaveLength(0);
    expect(createMissionDecisionStore(retired).list(retiredMission)).toHaveLength(0);

    const closing = dataFolder();
    const closedMission = missionIn(closing);
    createMissionStore(closing).update(closedMission, (mission) => ({ ...mission, state: "closed", closedAt: NOW.toISOString() }));
    expect(await codeOf(() => handleMissionIntegrationAsk({ missionId: closedMission, repo: REPO }, undefined, rpc(closing)))).toEqual(["E_MISSION_INVALID", "E_MISSION_INVALID: mission ABC is not open"]);
  });
});

describe("the local-merge grant (ADR-045 decision 4)", () => {
  const rpc = (home: string) => ({ home, now: () => NOW, log: () => {} });
  const QUESTION = "Merge `m/ABC/fe` into your local `develop` by fast-forward whenever a request passes its checks? Nothing is pushed; push and tag stay yours.";
  const stated = (over: Partial<NonNullable<Placement["localMerge"]>> = {}): NonNullable<Placement["localMerge"]> => ({ state: "granted", decisionId: "m:mis-0000000001:1", grantedAt: NOW.toISOString(), revokedAt: null, target: "develop", ...over });
  function openMergeCard(home: string, missionId: string): Decision {
    const id = openLocalMergeCardIfNeeded(home, missionId, REPO, { now: NOW, log: () => {}, requestId: "req-20261021T090000Z" });
    if (id === null) throw new Error("no card opened");
    return createMissionDecisionStore(home).get(id)!;
  }
  function answered(card: Decision, optionKey: string): Decision {
    const done = answerDecision(card, { via: "inbox", optionKey, at: NOW.toISOString() });
    if (!done.ok) throw new Error(done.message);
    return done.decision;
  }

  it("is ownerOnly, release, its own code subject, a Yes carrying the grant and a Not now, the question word for word", () => {
    const home = dataFolder();
    const missionId = missionIn(home);
    const card = openMergeCard(home, missionId);
    expect(card).toMatchObject({ workspaceId: missionId, requestId: "req-20261021T090000Z", askedBy: { role: "plugin", agentId: null }, subject: "local-merge", class: "release", ownerOnly: true, status: "open", question: QUESTION });
    expect(card.options).toEqual([
      { key: "a", label: "Yes, for this mission and repository", recommended: false, effects: ["commit"], action: { kind: "integration.local-merge", missionId, repo: REPO } },
      { key: "b", label: "Not now — keep the work on its branch", recommended: false, effects: ["none"] },
    ]);
    expect([isLocalMergeCard(card), isIntegrationCard(card)]).toEqual([true, false]);
    expect(createMissionStore(home).journal(missionId).map((line) => line.text)).toContain(`The owner is asked on ${card.id} to allow fast-forwarding develop to what ${BRANCH} passes.`);
  });

  it("is asked once: never again while open, after Not now or with a grant; a placement not ready is not asked", () => {
    const home = dataFolder();
    const missionId = missionIn(home);
    const card = openMergeCard(home, missionId);
    const again = () => openLocalMergeCardIfNeeded(home, missionId, REPO, { now: NOW, log: () => {} });
    expect(again()).toBeNull();
    createMissionDecisionStore(home).transition(card.id, (current) => answerDecision(current, { via: "inbox", optionKey: "b", at: NOW.toISOString() }));
    expect(again()).toBeNull();
    expect(createMissionDecisionStore(home).list(missionId)).toHaveLength(1);
    for (const placed of [placement({ localMerge: stated() }), placement({ localMerge: stated({ state: "revoked", revokedAt: NOW.toISOString() }) }), placement({ state: "creating" })]) {
      const other = dataFolder();
      expect(openLocalMergeCardIfNeeded(other, missionIn(other, [placed]), REPO, { now: NOW, log: () => {} })).toBeNull();
    }
  });

  it("the owner's Yes writes the grant, the journal and the Main's word, on the mission branch's placement", async () => {
    const home = dataFolder();
    const lane2 = placement({ workspaceId: "wks_lane", branch: `${BRANCH}-2`, lane: 2 });
    const missionId = missionIn(home, [placement(), lane2]);
    createMissionStore(home).update(missionId, (mission) => ({ ...mission, workspaceId: "wks_main" }));
    const card = openMergeCard(home, missionId);
    await applyLocalMergeDecision(answered(card, "a"), deps(home));
    const placements = createMissionStore(home).get(missionId)!.placements!;
    expect(placements[0]!.localMerge).toEqual({ state: "granted", decisionId: card.id, grantedAt: NOW.toISOString(), revokedAt: null, target: "develop" });
    expect(placements[1]!.localMerge).toBeUndefined();
    expect(localMergeHolds(placements[0]!)).toBe(true);
    expect(createMissionStore(home).journal(missionId, 10, "decision").at(-1)).toMatchObject({ by: "owner", text: `The owner allowed fast-forwarding develop to what ${BRANCH} passes (${card.id}).`, ref: card.id });
    expect(createOutbox(home).list("wks_main").map((record) => record.text)).toEqual([expect.stringContaining(`The owner allowed fast-forwarding the local develop to what ${BRANCH} passes, on card ${card.id}; nothing is pushed.`)]);
  });

  it("Not now writes no grant, and stands until the owner re-asks", async () => {
    const home = dataFolder();
    const missionId = missionIn(home);
    createMissionStore(home).update(missionId, (mission) => ({ ...mission, workspaceId: "wks_main" }));
    const card = openMergeCard(home, missionId);
    await handleDecisionsAnswer({ id: card.id, optionKey: "b" }, undefined, rpc(home));
    expect(placementOf(home, missionId, REPO)?.localMerge).toBeUndefined();
    expect(createOutbox(home).list("wks_main").map((record) => record.text)).toEqual([expect.stringContaining(`On local-merge card ${card.id} the owner chose not now: nothing is merged.`)]);
    expect(openLocalMergeCardIfNeeded(home, missionId, REPO, { now: NOW, log: () => {} })).toBeNull();
    const { decisionId } = await handleMissionIntegrationAsk({ missionId, repo: REPO, what: "local-merge" }, undefined, rpc(home));
    expect(createMissionDecisionStore(home).get(decisionId)).toMatchObject({ subject: "local-merge", status: "open", question: QUESTION });
    expect(createMissionStore(home).journal(missionId, 10, "decision").at(-1)).toMatchObject({ by: "owner", text: `The owner asked again on ${decisionId} to allow fast-forwarding develop to what ${BRANCH} passes.` });
  });

  it("negative: an answer that is not the owner's writes no grant", async () => {
    const home = dataFolder();
    const missionId = missionIn(home);
    const card = openMergeCard(home, missionId);
    const at = NOW.toISOString();
    expect(answerDecision(card, { by: "policy", via: "inbox", optionKey: "a", at }).ok).toBe(false);
    expect(answerDecision(card, { by: "main", via: "main", optionKey: "a", at }).ok).toBe(false);
    expect(answerDecision(card, { by: "precedent", via: "inbox", optionKey: "a", at, precedentId: "p-1" }).ok).toBe(false);
    expect(answerDecision(card, { via: "chat-manager", optionKey: "a", at }).ok).toBe(false);
    expect(carriesPreparedChange(card)).toBe(true);
    expect(decideRefusalOf(EMPTY_AUTONOMY_POLICY, card)).not.toBeNull();
    expect(whyIneligible(card.subject, card)).toBe('"local-merge" is a question paseo-bm asks you itself, once per mission and repository; no precedent answers it');
    // Whatever reaches the applier, only the owner's own answer writes.
    await applyLocalMergeDecision({ ...answered(card, "a"), answer: { ...answered(card, "a").answer!, by: "main" } }, deps(home));
    expect(placementOf(home, missionId, REPO)?.localMerge).toBeUndefined();
  });

  it("decisions.answer routes it on the owner's tap; a retired placement is refused, nothing written", async () => {
    const home = dataFolder();
    const missionId = missionIn(home);
    const card = openMergeCard(home, missionId);
    await handleDecisionsAnswer({ id: card.id, optionKey: "a" }, undefined, rpc(home));
    expect(placementOf(home, missionId, REPO)?.localMerge?.state).toBe("granted");
    expect(placementOf(home, missionId, REPO)?.integration).toBeNull();

    const retired = dataFolder();
    const retiredMission = missionIn(retired);
    const retiredCard = openMergeCard(retired, retiredMission);
    createMissionStore(retired).update(retiredMission, (mission) => ({ ...mission, placements: [placement({ state: "retired" })] }));
    await expect(handleDecisionsAnswer({ id: retiredCard.id, optionKey: "a" }, undefined, rpc(retired))).rejects.toMatchObject({ code: "E_MISSION_INVALID" });
    expect(createMissionDecisionStore(retired).get(retiredCard.id)?.status).toBe("open");
    expect(placementOf(retired, retiredMission, REPO)?.localMerge).toBeUndefined();
  });

  it("a grant holds only while its target is the placement's, and until a Revoke ends it", () => {
    expect(localMergeHolds(placement({ localMerge: stated() }))).toBe(true);
    expect(localMergeHolds(placement({ target: "main", localMerge: stated() }))).toBe(false);
    expect(localMergeHolds(placement({ localMerge: stated({ state: "revoked" }) }))).toBe(false);
    expect(localMergeHolds(placement())).toBe(false);
    const home = dataFolder();
    const missionId = missionIn(home, [placement({ localMerge: stated() })]);
    expect(revokeLocalMerge(missionId, REPO, deps(home))).toMatchObject({ ok: true });
    expect(placementOf(home, missionId, REPO)?.localMerge).toMatchObject({ state: "revoked", revokedAt: NOW.toISOString(), grantedAt: NOW.toISOString() });
    expect(localMergeHolds(placementOf(home, missionId, REPO)!)).toBe(false);
    expect(createMissionStore(home).journal(missionId, 10, "decision").at(-1)).toMatchObject({ by: "owner", text: `The owner revoked fast-forwarding develop to what ${BRANCH} passes.`, ref: "m:mis-0000000001:1" });
    expect(revokeLocalMerge(missionId, REPO, deps(home))).toEqual({ ok: false, reasons: ["the local merge into develop is not allowed; nothing was changed"] });
  });

  it("the RPCs take what: local-merge; a Revoke then an Ask grants anew; refusals are E_MISSION_INVALID", async () => {
    const home = dataFolder();
    const missionId = missionIn(home, [placement({ localMerge: stated() })]);
    await expect(handleMissionIntegrationAsk({ missionId, repo: REPO, what: "local-merge" }, undefined, rpc(home))).rejects.toMatchObject({ code: "E_MISSION_INVALID" });
    expect(await handleMissionIntegrationRevoke({ missionId, repo: REPO, what: "local-merge" }, undefined, rpc(home))).toEqual({ revokedAt: NOW.toISOString(), notified: 0 });
    await expect(handleMissionIntegrationRevoke({ missionId, repo: REPO, what: "local-merge" }, undefined, rpc(home))).rejects.toMatchObject({ code: "E_MISSION_INVALID" });
    const { decisionId } = await handleMissionIntegrationAsk({ missionId, repo: REPO, what: "local-merge" }, undefined, rpc(home));
    await handleMissionIntegrationAsk({ missionId, repo: REPO, what: "local-merge" }, undefined, rpc(home)).then(
      () => { throw new Error("a second card opened"); },
      (error: unknown) => expect(error).toBeInstanceOf(DashboardError),
    );
    await handleDecisionsAnswer({ id: decisionId, optionKey: "a" }, undefined, rpc(home));
    expect(placementOf(home, missionId, REPO)?.localMerge).toMatchObject({ state: "granted", decisionId, revokedAt: null });
  });

  it("the push card and its RPCs behave as before when what is absent", async () => {
    const home = dataFolder();
    const missionId = missionIn(home, [placement({ localMerge: stated() })]);
    const push = openCard(home, missionId);
    expect(isIntegrationCard(push)).toBe(true);
    await handleDecisionsAnswer({ id: push.id, optionKey: "a" }, undefined, rpc(home));
    expect(placementOf(home, missionId, REPO)?.integration?.state).toBe("granted");
    await handleMissionIntegrationRevoke({ missionId, repo: REPO }, undefined, rpc(home));
    expect(placementOf(home, missionId, REPO)?.integration?.state).toBe("revoked");
    expect(placementOf(home, missionId, REPO)?.localMerge?.state).toBe("granted");
    const { decisionId } = await handleMissionIntegrationAsk({ missionId, repo: REPO }, undefined, rpc(home));
    expect(createMissionDecisionStore(home).get(decisionId)).toMatchObject({ subject: "integration", question: push.question });
    // A local-merge card does not count as the push card's "asked once".
    const fresh = dataFolder();
    const freshMission = missionIn(fresh);
    openMergeCard(fresh, freshMission);
    expect(openCard(fresh, freshMission).subject).toBe("integration");
  });

  it("the row's state: allowed, revoked, waiting on the open card, not now, none before any card", () => {
    const home = dataFolder();
    const missionId = missionIn(home);
    expect(localMergeStateOf(placement(), [])).toEqual({ state: "none", at: null, decisionId: null });
    const card = openMergeCard(home, missionId);
    expect(localMergeStateOf(placement(), [card])).toEqual({ state: "waiting", at: null, decisionId: card.id });
    expect(localMergeStateOf(placement(), [answered(card, "b")])).toEqual({ state: "not-now", at: null, decisionId: card.id });
    expect(localMergeStateOf(placement({ repo: "wks_other" }), [card])).toEqual({ state: "none", at: null, decisionId: null });
    expect(localMergeStateOf(placement({ localMerge: stated() }), [])).toEqual({ state: "allowed", at: NOW.toISOString(), decisionId: "m:mis-0000000001:1" });
    expect(localMergeStateOf(placement({ localMerge: stated({ state: "revoked", revokedAt: NOW.toISOString() }) }), [])).toEqual({ state: "revoked", at: NOW.toISOString(), decisionId: "m:mis-0000000001:1" });
    // A grant for another target no longer holds: the row offers Ask me again.
    expect(localMergeStateOf(placement({ target: "main", localMerge: stated() }), [])).toEqual({ state: "revoked", at: null, decisionId: "m:mis-0000000001:1" });
  });
});
