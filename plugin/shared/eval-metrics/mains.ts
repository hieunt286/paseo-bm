/**
 * A-14 (mission runtime design §10, M-33; ADR-033 decision 5): the turns of
 * the missions' Mains by what started them, from the trace records of the
 * Missions places (ADR-034: the Mission-List root, the earlier shared home,
 * each mission's workspace). A Main turn is a `manager` record of one; what
 * started it is its first inbound message (the record's `sent`: the messages
 * sent to the agent):
 *
 * | Trigger | First inbound message |
 * |---|---|
 * | `owner` | typed in the app (`origin: user`, no plugin marker) |
 * | `report` | `BM-DELIVERY report` or `review` |
 * | `message` | `BM-DELIVERY message` or `no-verdict` |
 * | `peer` | `BM-DELIVERY peer`, `peer-reply` or `peer-message` |
 * | `command` | `BM-COMMAND` |
 * | `state` | `BM-STATE` |
 * | `other` | any other notice or prompt, another agent's message, a record of no origin, none |
 *
 * A `BM-UPDATES` message counts by its first (oldest) item, and once in
 * `batched`. M-33 is `ownerShare` ≥ 50 % on the acceptance scenario.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import type { TraceRecord } from "../contracts";
import { COMMAND_NOTICE_MARKER, STATE_NOTICE_MARKER, isPluginNotice, isPluginPrompt, noticeMarkerOf, parseDelivery, updatesItemsOf } from "../notices";
import { ratio } from "./helpers";
import type { EvalMetrics } from "./types";

/** What started a Main's turn, in a fixed order. */
export const MAIN_TRIGGERS = ["owner", "report", "message", "peer", "command", "state", "other"] as const;
export type MainTrigger = (typeof MAIN_TRIGGERS)[number];

/** What a notice's text started (one item of a `BM-UPDATES` message, or a whole notice). */
function noticeTriggerOf(text: string): MainTrigger {
  const delivery = parseDelivery(text);
  if (delivery !== null) {
    if (delivery.kind === "report" || delivery.kind === "review") return "report";
    if (delivery.kind === "message" || delivery.kind === "no-verdict") return "message";
    return "peer";
  }
  const marker = noticeMarkerOf(text);
  if (marker === COMMAND_NOTICE_MARKER) return "command";
  if (marker === STATE_NOTICE_MARKER) return "state";
  return "other";
}

/** What started one turn, and whether a `BM-UPDATES` message did. Pure. */
export function mainTriggerOf(record: Pick<TraceRecord, "sent">): { trigger: MainTrigger; batched: boolean } {
  const first = [...record.sent].sort((a, b) => a.at.localeCompare(b.at))[0];
  if (first === undefined) return { trigger: "other", batched: false };
  const items = updatesItemsOf(first.text);
  if (items !== null) return { trigger: items[0] === undefined ? "other" : noticeTriggerOf(items[0]), batched: true };
  if (isPluginNotice(first.text)) return { trigger: noticeTriggerOf(first.text), batched: false };
  if (isPluginPrompt(first.text)) return { trigger: "other", batched: false };
  return { trigger: first.origin === "user" ? "owner" : "other", batched: false };
}

/** A-14 over the records in scope; `homeKnown` false (and nothing counted) without the Missions home's id. Pure. */
export function a14Of(records: readonly TraceRecord[], missionsWorkspaceIds: readonly string[] | undefined): EvalMetrics["a14"] {
  const places = new Set(missionsWorkspaceIds ?? []);
  const byTrigger = Object.fromEntries(MAIN_TRIGGERS.map((trigger) => [trigger, 0])) as Record<MainTrigger, number>;
  let turns = 0;
  let batched = 0;
  if (places.size > 0) {
    for (const record of records) {
      if (!places.has(record.workspaceId) || record.role !== "manager") continue;
      const found = mainTriggerOf(record);
      turns += 1;
      byTrigger[found.trigger] += 1;
      if (found.batched) batched += 1;
    }
  }
  return { homeKnown: places.size > 0, turns, byTrigger, ownerShare: ratio(byTrigger.owner, turns), batched };
}
