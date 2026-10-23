import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundaryOf, challengerOf, modeOf } from "../plugin/shared/autonomy";
import { answerDecision } from "../plugin/shared/decisions";
import { deciderOf } from "../plugin/shared/authority";
import { PRECEDENT_SCOPE_ALL } from "../plugin/shared/precedents";
import { authorityFactsOf } from "../plugin/server/authority-facts";
import { applyPreparedChange } from "../plugin/server/prepared-changes";
import { DECISION_UI_IDLE } from "../plugin/client/chat-card-decision";
import { precedentSuggestionView } from "../plugin/client/chat-card-precedent";
import { createAutonomyStore, currentPolicy } from "../plugin/server/autonomy-store";
import { handleAutonomyPolicy, handlePrecedentsList, handlePrecedentsSave } from "../plugin/server/autonomy-rpc";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { createDecisionStore } from "../plugin/server/decision-store";
import { outsideCharterOf } from "../plugin/server/event-bus";
import { createMemoryStore } from "../plugin/server/memory-store";
import { missionOfWorkspace } from "../plugin/server/mission-legacy";
import { createMissionRoster } from "../plugin/server/mission-roster";
import { MISSIONS_DIR_NAME, MISSION_INDEX_FILE_NAME, createMissionStore, type Mission, type Placement } from "../plugin/server/mission-store";
import { chainFor, createPeerLinkStore } from "../plugin/server/peer-links";
import { effectivePolicy, inCharter, placementEntryOf, placementOf, policyWithPlacements, repoKeyOf } from "../plugin/server/placements";
import { createPrecedentStore } from "../plugin/server/precedent-store";
import { resolveByPrecedent } from "../plugin/server/precedent-resolve";
import { creationProjectOf } from "../plugin/server/role-instructions";
import { projectWorkspacesOf } from "../plugin/client/work-model";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { makeDecision } from "./helpers/decisions";

/**
 * Placements and the repo key (delivery line design §3.1, §3.2; ADR-035
 * decision 2): with no placement every reader is as before; with one (a
 * fixture here — WP-8.2 creates them), policy, memory, precedents and charter
 * resolve through its repo, and Settings never lists it as a project.
 * Temporary data folders only.
 */

const NOW = new Date("2026-10-21T10:00:00.000Z");
const REPO = "wks_repo";
const OTHER = "wks_other";
const PLACE = "wks_place";

afterEach(() => {
  clearJsonFileCache();
  removeDataFolders();
});

function placement(over: Partial<Placement> = {}): Placement {
  return {
    repo: REPO,
    workspaceId: PLACE,
    directory: "/tmp/worktrees/m-abc-repo",
    branch: "m/ABC/repo",
    target: "develop",
    base: "origin/develop",
    worktreeSlug: "m-abc-repo",
    state: "ready",
    requestKey: "bm-place-mis-0000000001-wks_repo",
    createdAt: NOW.toISOString(),
    deps: { cloned: [], at: null, note: null },
    integration: null,
    ...over,
  };
}

/** A mission of `REPO` and `OTHER`, with `placements` when given. */
function missionIn(home: string, placements?: Placement[]): Mission {
  const store = createMissionStore(home, { now: () => NOW });
  const made = store.create({ code: "ABC", name: "Alpha", goal: "Ship it.", repos: [REPO, OTHER], createdBy: "owner", mainId: "main-1" });
  if (!made.ok) throw new Error(made.reasons.join("\n"));
  if (placements === undefined) return made.mission;
  const updated = store.update(made.mission.missionId, (mission) => ({ ...mission, placements }));
  if (!updated.ok) throw new Error(updated.reasons.join("\n"));
  return updated.mission;
}

describe("the record and the index (§3.2)", () => {
  it("stores placements on the mission and maps them in the index; an older index reads as none", () => {
    const home = dataFolder();
    const mission = missionIn(home, [placement(), placement({ repo: OTHER, workspaceId: null, state: "creating" })]);
    expect(createMissionStore(home).get(mission.missionId)?.placements).toHaveLength(2);
    const indexPath = join(home, MISSIONS_DIR_NAME, MISSION_INDEX_FILE_NAME);
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as { placements: unknown };
    // Only a placement with a workspace is mapped.
    expect(index.placements).toEqual({ [PLACE]: { missionId: mission.missionId, repo: REPO } });
    expect(placementOf(home, mission.missionId, REPO)?.workspaceId).toBe(PLACE);
    expect(placementOf(home, mission.missionId, "wks_none")).toBeNull();

    // An index an older build wrote has no map: a mission without placements reads as before.
    const plain = dataFolder();
    const old = missionIn(plain);
    const oldIndex = join(plain, MISSIONS_DIR_NAME, MISSION_INDEX_FILE_NAME);
    const body = JSON.parse(readFileSync(oldIndex, "utf8")) as Record<string, unknown>;
    delete body["placements"];
    writeFileSync(oldIndex, JSON.stringify(body));
    expect(createMissionStore(plain).placements()).toEqual({});
    expect(createMissionStore(plain).list().map((entry) => entry.missionId)).toEqual([old.missionId]);
    expect(createMissionStore(plain).get(old.missionId)?.placements).toBeUndefined();
  });

  it("resolves a placement to its repo and everything else to itself, following the index as it changes", () => {
    const home = dataFolder();
    expect(repoKeyOf(home, PLACE)).toBe(PLACE);
    expect(repoKeyOf(null, PLACE)).toBe(PLACE);
    const mission = missionIn(home);
    expect(repoKeyOf(home, PLACE)).toBe(PLACE);
    createMissionStore(home).update(mission.missionId, (current) => ({ ...current, placements: [placement()] }));
    expect(repoKeyOf(home, PLACE)).toBe(REPO);
    expect(repoKeyOf(home, REPO)).toBe(REPO);
    expect(repoKeyOf(home, OTHER)).toBe(OTHER);
    expect(placementEntryOf(home, PLACE)).toEqual({ missionId: mission.missionId, repo: REPO });
    expect(placementEntryOf(home, REPO)).toBeNull();
  });
});

describe("policy (§3.1)", () => {
  it("aliases a placement to its repo's cells, challenger and boundary for enforcement; Settings never lists it", () => {
    const home = dataFolder();
    missionIn(home, [placement()]);
    const autonomy = createAutonomyStore(home);
    autonomy.set({ workspaceId: REPO, class: "dependency", mode: "delegate", confirmed: true }, NOW.toISOString());
    autonomy.setChallenger({ workspaceId: REPO, enabled: true });
    autonomy.setBoundary({ workspaceId: REPO, enabled: true, confirmed: true }, NOW.toISOString());

    const effective = effectivePolicy(home);
    expect(modeOf(effective, PLACE, "dependency")).toBe("delegate");
    expect(challengerOf(effective, PLACE)).toBe(true);
    expect(boundaryOf(effective, PLACE)).not.toBeNull();
    expect(modeOf(effective, OTHER, "dependency")).toBe("owner");

    // The stored policy and the Settings read name the repo only.
    expect(Object.keys(currentPolicy(home).projects)).toEqual([REPO]);
    const read = handleAutonomyPolicy({}, { home });
    expect(Object.keys(read.policy.projects)).toEqual([REPO]);
    expect(Object.keys(read.levels)).toEqual([REPO]);
    expect(projectWorkspacesOf([{ id: REPO }, { id: PLACE }, { id: OTHER }], { homes: [], placements: { [PLACE]: REPO } }, false)?.map((entry) => entry.id)).toEqual([REPO, OTHER]);
  });

  it("is the stored policy with no placement", () => {
    const home = dataFolder();
    missionIn(home);
    createAutonomyStore(home).set({ workspaceId: REPO, class: "dependency", mode: "delegate", confirmed: true }, NOW.toISOString());
    expect(effectivePolicy(home)).toEqual(currentPolicy(home));
    const policy = currentPolicy(home);
    expect(policyWithPlacements(policy, {})).toEqual(policy);
    expect(projectWorkspacesOf([{ id: REPO }, { id: PLACE }], { homes: [] }, false)?.map((entry) => entry.id)).toEqual([REPO, PLACE]);
  });

  it("gives a creation in a placement its repo key and the repo's boundary switch", async () => {
    const home = dataFolder();
    missionIn(home, [placement()]);
    createAutonomyStore(home).setBoundary({ workspaceId: REPO, enabled: true, confirmed: true }, NOW.toISOString());
    const lookup = { repoKeyOf: (id: string) => repoKeyOf(home, id), boundaryOn: (id: string) => boundaryOf(currentPolicy(home), id) !== null };
    expect(await creationProjectOf(undefined, { ...lookup, workspaceId: PLACE })).toEqual({ workspaceId: PLACE, repoKey: REPO, boundary: "on" });
    expect(await creationProjectOf(undefined, { ...lookup, workspaceId: OTHER })).toEqual({ workspaceId: OTHER, repoKey: OTHER, boundary: "off" });
    expect(await creationProjectOf(undefined, lookup)).toEqual({ workspaceId: null, repoKey: null, boundary: "unknown" });
  });
});

describe("memory and precedents (§3.1)", () => {
  it("reads and adds to the repo's memory from a placement", () => {
    const home = dataFolder();
    missionIn(home, [placement()]);
    const memory = createMemoryStore(home, { now: () => NOW });
    const added = memory.add(PLACE, { kind: "fact", text: "The API listens on 8080.", source: "README.md", by: { role: "main", agentId: "main-1", missionId: null } });
    expect(added.ok).toBe(true);
    expect(memory.active(REPO).map((entry) => entry.text)).toEqual(["The API listens on 8080."]);
    expect(memory.active(PLACE)).toEqual(memory.active(REPO));
    expect(memory.active(OTHER)).toEqual([]);
  });

  it("applies the repo's precedents to a placement's decision, answered where it is stored", () => {
    const home = dataFolder();
    missionIn(home, [placement()]);
    const precedents = createPrecedentStore(home, { newId: () => "p-1" });
    precedents.save({ scope: REPO, subject: "test-db", text: "SQLite", sourceDecisionId: null, expiresInDays: 30 }, NOW);
    expect(precedents.active(NOW, PLACE).map((entry) => entry.subject)).toEqual(["test-db"]);
    expect(precedents.active(NOW, OTHER)).toEqual([]);

    const decision = makeDecision({
      workspaceId: PLACE,
      subject: "test-db",
      class: "dependency",
      options: [
        { key: "a", label: "SQLite", recommended: true, effects: ["none"] },
        { key: "b", label: "Postgres", recommended: false, effects: ["dependency-install"] },
      ],
    });
    const opened = createDecisionStore(home).open(decision).decision;
    const resolved = resolveByPrecedent(opened, { home, now: NOW, log: () => undefined });
    expect(resolved.resolved).toBe(true);
    expect(resolved.decision.workspaceId).toBe(PLACE);
    expect(createDecisionStore(home).get(decision.id, PLACE)?.status).toBe("answered");

    // Saved from a placement's decision the owner answered, for "its own project", a precedent holds in the repo.
    const asked = makeDecision({ requestId: "req-20261021T090000Z", workspaceId: PLACE, subject: "port-choice", class: "dependency" });
    const store = createDecisionStore(home);
    store.open(asked);
    const answered = store.transition(asked.id, (current) => answerDecision(current, { by: "owner", via: "inbox", optionKey: "c", class: "dependency", at: NOW.toISOString() }), PLACE);
    expect(answered.status).toBe("updated");
    expect(handlePrecedentsSave({ decisionId: asked.id, scope: PLACE }, { home, now: () => NOW }).precedent.scope).toBe(REPO);
    expect(handlePrecedentsSave({ decisionId: asked.id, scope: PRECEDENT_SCOPE_ALL }, { home, now: () => NOW }).precedent.scope).toBe(PRECEDENT_SCOPE_ALL);
  });
});

describe("who decides, and what a prepared change writes (§3.1)", () => {
  it("decides a q: opened in a placement as for its repo: a delegated class goes to the Main", () => {
    const home = dataFolder();
    const mission = missionIn(home, [placement()]);
    createMissionRoster(home).add(mission.missionId, { requestId: "req-20261021T100000Z", workspaceId: PLACE, topic: "inside" });
    createAutonomyStore(home).set({ workspaceId: REPO, class: "dependency", mode: "delegate", confirmed: true }, NOW.toISOString());
    const asked = makeDecision({
      requestId: "req-20261021T100000Z",
      workspaceId: PLACE,
      class: "dependency",
      options: [
        { key: "a", label: "SQLite", recommended: true, effects: ["none"] },
        { key: "b", label: "Postgres", recommended: false, effects: ["none"] },
      ],
    });
    expect(deciderOf(asked, authorityFactsOf(home))).toMatchObject({ decider: "main", rule: "delegated-main" });
    // Read under the stored policy alone, the placement would send it to the owner.
    expect(deciderOf(asked, { ...authorityFactsOf(home), modeOf: (workspaceId, decisionClass) => modeOf(currentPolicy(home), workspaceId, decisionClass) })).toMatchObject({ decider: "owner" });
  });

  it("writes a prepared autonomy change answered on a placement's decision under the repo's cell", () => {
    const home = dataFolder();
    missionIn(home, [placement()]);
    const decision = makeDecision({
      id: "o:place-1",
      workspaceId: PLACE,
      askedBy: { role: "orchestrator", agentId: "agent-orchestrator" },
      subject: "advice",
      options: [{ key: "a", label: "Delegate dependencies", recommended: true, effects: ["none"], action: { kind: "autonomy.set", class: "dependency", mode: "delegate" } }],
    });
    const answered = answerDecision(decision, { by: "owner", via: "inbox", optionKey: "a", at: NOW.toISOString() });
    if (!answered.ok) throw new Error(answered.message);
    expect(applyPreparedChange(answered.decision, { home, now: NOW, log: () => undefined })).toMatchObject({ applied: true, wrote: true });
    expect(Object.keys(currentPolicy(home).projects)).toEqual([REPO]);
    expect(modeOf(currentPolicy(home), REPO, "dependency")).toBe("delegate");
  });

  it("suggests the repo's precedent on a placement's card: precedents.list names the repo key", () => {
    const home = dataFolder();
    missionIn(home, [placement()]);
    createPrecedentStore(home).save({ scope: REPO, subject: "test-db", text: "SQLite", sourceDecisionId: null, expiresInDays: 30 }, NOW);
    const listed = handlePrecedentsList({ workspaceId: PLACE }, { home, now: () => NOW });
    expect(listed.repoKey).toBe(REPO);
    expect(handlePrecedentsList({ workspaceId: REPO }, { home, now: () => NOW }).repoKey).toBeUndefined();
    const decision = makeDecision({ workspaceId: PLACE, subject: "test-db" });
    expect(precedentSuggestionView(decision, listed.precedents, DECISION_UI_IDLE, NOW)).toBeNull();
    expect(precedentSuggestionView(decision, listed.precedents, DECISION_UI_IDLE, NOW, listed.repoKey)?.line).toContain("SQLite");
  });
});

describe("charter membership and links (§3.1)", () => {
  it("counts a placement's request inside the charter, and names the repo of one outside", () => {
    const home = dataFolder();
    const mission = missionIn(home, [placement(), placement({ repo: "wks_far", workspaceId: "wks_far_place" })]);
    expect(inCharter(home, mission, PLACE)).toBe(true);
    expect(inCharter(home, mission, REPO)).toBe(true);
    expect(inCharter(home, mission, "wks_far_place")).toBe(false);
    const roster = createMissionRoster(home);
    roster.add(mission.missionId, { requestId: "req-20261021T100000Z", workspaceId: PLACE, topic: "inside" });
    roster.add(mission.missionId, { requestId: "req-20261021T100100Z", workspaceId: "wks_far_place", topic: "outside" });
    expect(outsideCharterOf(home, mission).map((event) => [event.workspaceId, event.requestId])).toEqual([["wks_far", "req-20261021T100100Z"]]);
  });

  it("finds the mission of a placement exactly, so no legacy mission is made there", () => {
    const home = dataFolder();
    const mission = missionIn(home, [placement()]);
    expect(missionOfWorkspace(home, PLACE)?.missionId).toBe(mission.missionId);
    expect(missionOfWorkspace(home, REPO)?.missionId).toBe(mission.missionId);
    expect(missionOfWorkspace(home, "wks_unknown")).toBeNull();
  });

  it("writes a link's target as the repo key and refuses a placement asking its own repo", () => {
    const home = dataFolder();
    missionIn(home, [placement()]);
    const keyOf = (id: string) => repoKeyOf(home, id);
    const from = { workspaceId: PLACE, requestId: "req-20261021T100000Z" };
    expect(chainFor([], from, REPO, "project", keyOf)).toEqual({ ok: false, reasons: ["a project cannot ask itself; ask another project"] });
    expect(chainFor([], from, REPO)).toEqual({ ok: true, chain: { workspaces: [PLACE], depth: 1 } });
    const links = createPeerLinkStore(home, { now: () => NOW, onEvent: () => undefined });
    const asked = links.createLink({ kind: "question", from: { workspaceId: OTHER, requestId: "req-20261021T100200Z", agentId: "worker-1", role: "worker" }, to: { workspaceId: PLACE, managerId: "manager-1" }, text: "Which port?" });
    if (!asked.ok) throw new Error(asked.reasons.join("\n"));
    expect(asked.link.to.workspaceId).toBe(REPO);
    // A Worker of the placement takes it, and is found on the answering side.
    expect(links.takeLink(asked.link.linkId, { workspaceId: PLACE, requestId: "req-20261021T100300Z", workerId: "worker-2" }).ok).toBe(true);
    expect(links.linksOfRequest(PLACE, "req-20261021T100300Z", "answerer").map((link) => link.linkId)).toEqual([asked.link.linkId]);
  });
});
