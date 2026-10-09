/**
 * The names of paseo-bm's own agent tools per role, as a bound agent gets them
 * (`toolFacesFor(role, true)` in `bm-tools.ts`), for the client's Tools &
 * skills section. The client shows names only; importing `bm-tools.ts` there
 * would bundle every schema and description. `test/plugin-tools-screen.test.ts`
 * keeps these lists equal to `toolFacesFor`.
 *
 * Pure: no imports.
 */
export const BM_TOOL_NAMES = {
  manager: ["bm_create_worker", "bm_tell_worker", "bm_answers", "bm_peers", "bm_ask_project", "bm_peer_reply", "bm_mission", "bm_mission_start", "bm_mission_update", "bm_answer_worker", "bm_memory", "bm_repo", "bm_link_workers", "bm_ask_mission", "bm_decisions"],
  worker: ["bm_report", "bm_questions", "bm_create_reviewer", "bm_rereview", "bm_peers", "bm_ask_project", "bm_peer_reply", "bm_memory", "bm_reply"],
  reviewer: ["bm_review"],
  orchestrator: [
    "bm_projects", "bm_request", "bm_agent_messages", "bm_send_command", "bm_decisions", "bm_ask_owner", "bm_decide", "bm_predict",
    "bm_direct_worker", "bm_repo", "bm_note", "bm_findings", "bm_compact", "bm_handoff", "bm_why", "bm_reply",
  ],
} as const satisfies Record<"manager" | "worker" | "reviewer" | "orchestrator", readonly string[]>;
