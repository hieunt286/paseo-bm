import { describe, expect, it } from "vitest";
import { parseAnswers } from "../plugin/shared/bm-questions";
import { COMMAND_NOTICE_MARKER, isPluginNotice, noticeMarkerOf } from "../plugin/shared/notices";
import { MAX_PROPOSAL_COMMAND_CHARS, MAX_PROPOSAL_REASON_CHARS, MAX_SENT_TEXT_CHARS } from "../plugin/shared/orchestrator";
import { EFFECTS, preparedActionSchema, type Effect } from "../plugin/shared/decisions";
import {
  COMMAND_FROM,
  COMMAND_INTENTS,
  COMMAND_LIMITS,
  COMMAND_MARKER,
  COMMAND_TO,
  COMMAND_VIA,
  MAX_COMMAND_BLOCK_CHARS,
  MAX_COMMAND_BODY_CHARS,
  MAX_COMMAND_DECISION_ID_CHARS,
  MAX_COMMAND_RE_CHARS,
  MAX_COMMAND_WHY_CHARS,
  commandBlockOf,
  commandInputProblems,
  commandOf,
  decisionAuthorityOf,
  decisionIdOfAuthority,
  effectsWithheldBy,
  isCommandAuthority,
  limitsOf,
  parseCommandBlock,
  type CommandInput,
} from "../plugin/shared/orchestrator-command";

/** The `BM-COMMAND` block (Orchestrator design §6B.1; version 2, autonomy design §A.7): builder, parser, limits. */

const REQ = "req-20260929T101500Z";

const input = (over: Partial<CommandInput> = {}): CommandInput => ({
  from: "orchestrator",
  via: "autopilot",
  to: "manager",
  requestId: REQ,
  re: "Answer the Worker's question on the export format",
  body: "Tell the Worker to use CSV.",
  why: "The owner said CSV last week.",
  ...over,
});

describe("the block's exact shape (autonomy design §A.7)", () => {
  it("writes every field in order, the v2 header after re:, limits only from the Orchestrator, why after a blank line", () => {
    expect(commandBlockOf(input({ intent: "answer", effects: ["none"] }))).toBe(
      [
        "BM-COMMAND",
        "from: orchestrator",
        "via: autopilot",
        "to: manager",
        `requestId: ${REQ}`,
        "re: Answer the Worker's question on the export format",
        "intent: answer",
        "effects: none",
        "authority: autopilot",
        "approved: none",
        "limits: no-commit-push-deploy, no-real-data",
        "",
        "Tell the Worker to use CSV.",
        "",
        "why: The owner said CSV last week.",
      ].join("\n"),
    );
  });

  it("a decision's grant: effects and approved in EFFECTS order, the approved effects gone from the limits", () => {
    const block = commandBlockOf(
      input({ via: "chat", intent: "release", effects: ["push", "commit"], authority: "decision:o:8f14e45f-ceea-467f-a0e6-0b5b0d2f4c11", approved: ["push", "commit"] }),
    );
    expect(block.split("\n\n")[0]!.split("\n").slice(6)).toEqual([
      "intent: release",
      "effects: commit, push",
      "authority: decision:o:8f14e45f-ceea-467f-a0e6-0b5b0d2f4c11",
      "approved: commit, push",
      "limits: no-deploy, no-real-data",
    ]);
  });

  it("the Manager's copy of a Worker command says copy: yes; the owner's has no limits; no request writes none; no why writes no line", () => {
    expect(commandBlockOf(input({ to: "worker", copy: true }))).toContain("to: worker\ncopy: yes\nrequestId:");
    expect(commandBlockOf(input({ from: "owner", via: "tab", requestId: null, why: null }))).toBe(
      [
        "BM-COMMAND",
        "from: owner",
        "via: tab",
        "to: manager",
        "requestId: none",
        "re: Answer the Worker's question on the export format",
        "intent: other",
        "effects: none",
        "authority: owner",
        "approved: none",
        "",
        "Tell the Worker to use CSV.",
      ].join("\n"),
    );
  });

  it("an input without the v2 fields gets intent other, no effect, and the authority its path implies", () => {
    expect(commandOf(input())).toMatchObject({ version: 2, intent: "other", effects: [], authority: "autopilot", approved: [] });
    expect(commandOf(input({ via: "chat" })).authority).toBe("owner");
    expect(commandOf(input({ via: "tab" })).authority).toBe("owner");
    expect(commandOf(input({ from: "owner", via: "tab" })).authority).toBe("owner");
  });

  it("starts with the notice marker the collector skips", () => {
    expect(COMMAND_MARKER).toBe(COMMAND_NOTICE_MARKER);
    const block = commandBlockOf(input());
    expect(isPluginNotice(block)).toBe(true);
    expect(noticeMarkerOf(block)).toBe("BM-COMMAND");
  });

  it("collapses the one-line fields and trims the blank lines around the body", () => {
    const command = commandOf(input({ re: "  Answer\nthe   question ", body: "\n\n  - step one\n  - step two  \n\n", why: " because\n\nof  this " }));
    expect(command.re).toBe("Answer the question");
    expect(command.body).toBe("  - step one\n  - step two");
    expect(command.why).toBe("because of this");
    expect(commandOf(input({ why: "   " })).why).toBeNull();
  });
});

describe("round trip: parseCommandBlock(commandBlockOf(x)) equals commandOf(x)", () => {
  const bodies = [
    "Go on with option B.",
    "## Next\n\n- run the tests\n- report\n\n```sh\nnpm test\n```",
    "why: this line is part of the body, alone",
  ];
  const cases: CommandInput[] = [];
  for (const from of COMMAND_FROM) {
    for (const via of COMMAND_VIA) {
      for (const to of COMMAND_TO) {
        for (const copy of to === "worker" ? [false, true] : [false]) {
          for (const requestId of [REQ, "req:agent-9:turn-1", null]) {
            for (const why of ["Because the owner asked.", null]) {
              for (const body of bodies) cases.push({ from, via, to, copy, requestId, re: "Subject", body, why });
            }
          }
        }
      }
    }
  }

  it(`covers ${cases.length} combinations of from, via, to, copy, requestId, why and body`, () => {
    expect(cases.length).toBe(2 * 3 * 3 * 3 * 2 * 3);
    for (const command of cases) {
      const parsed = parseCommandBlock(commandBlockOf(command));
      expect(parsed, JSON.stringify(command)).toEqual(commandOf(command));
      expect(parsed!.limits).toEqual(command.from === "orchestrator" ? [...COMMAND_LIMITS] : []);
    }
  });

  it("round-trips every intent, every effect declared and approved, and every authority", () => {
    const real = EFFECTS.filter((effect) => effect !== "none");
    const authorities = ["autopilot", "owner", "decision:o:1a2b", "decision:q:req-1:Q4", "decision:f:incident-7"] as const;
    let count = 0;
    for (const intent of COMMAND_INTENTS) {
      for (const authority of authorities) {
        for (const effect of real) {
          for (const approved of [[], [effect]] as Effect[][]) {
            const command = input({ via: authority === "autopilot" ? "autopilot" : "chat", intent, effects: [effect, "none"], authority, approved });
            const parsed = parseCommandBlock(commandBlockOf(command));
            expect(parsed, JSON.stringify(command)).toEqual(commandOf(command));
            expect(parsed!.limits.flatMap(effectsWithheldBy).some((withheld) => parsed!.approved.includes(withheld))).toBe(false);
            count += 1;
          }
        }
      }
    }
    expect(count).toBe(COMMAND_INTENTS.length * authorities.length * real.length * 2);
  });

  it("a body that already ends with a why paragraph keeps it when a why is given", () => {
    const command = input({ body: "Do this.\n\nwhy: part of the body" });
    expect(parseCommandBlock(commandBlockOf(command))).toEqual(commandOf(command));
    expect(parseCommandBlock(commandBlockOf(command))!.body).toBe("Do this.\n\nwhy: part of the body");
  });

  it("reads \\r\\n line ends and trailing whitespace", () => {
    const block = `${commandBlockOf(input())}\n\n`.replace(/\n/g, "\r\n");
    expect(parseCommandBlock(block)).toEqual(commandOf(input()));
  });

  it("keeps every limit at its longest", () => {
    const every = EFFECTS.filter((effect) => effect !== "none");
    const longest = input({
      to: "worker",
      copy: true,
      intent: "continue",
      effects: every,
      approved: every,
      via: "chat",
      authority: `decision:q:${"i".repeat(MAX_COMMAND_DECISION_ID_CHARS - 5)}:Q1`,
      requestId: "r".repeat(128),
      re: "r".repeat(MAX_COMMAND_RE_CHARS),
      body: "b".repeat(MAX_COMMAND_BODY_CHARS),
      why: "w".repeat(MAX_COMMAND_WHY_CHARS),
    });
    const block = commandBlockOf(longest);
    expect(block.length).toBeLessThanOrEqual(MAX_COMMAND_BLOCK_CHARS);
    expect(parseCommandBlock(block)).toEqual(commandOf(longest));
  });
});

describe("an answer embeds a BM-ANSWERS block, kept intact", () => {
  const answers = ["BM-ANSWERS", `requestId: ${REQ}`, "Q1: b — CSV, one file per month", "Q2: other — keep the header row"].join("\n");

  it("the body carries the block as given, and parseAnswers still reads it in the whole text", () => {
    const command = input({ to: "worker", body: `The owner's answers:\n\n${answers}` });
    const block = commandBlockOf(command);
    expect(block).toContain(`\n${answers}\n\nwhy: `);
    expect(parseCommandBlock(block)!.body).toBe(`The owner's answers:\n\n${answers}`);
    expect(parseAnswers(block)).toEqual({
      requestId: REQ,
      answers: [
        { id: "Q1", text: "b — CSV, one file per month" },
        { id: "Q2", text: "other — keep the header row" },
      ],
    });
  });

  it("with no why, the answers end the block", () => {
    const block = commandBlockOf(input({ body: answers, why: null }));
    expect(parseCommandBlock(block)).toMatchObject({ body: answers, why: null });
    expect(parseAnswers(block)?.answers).toHaveLength(2);
  });
});

describe("validation of the builder's input", () => {
  it("accepts a valid input with no problem", () => {
    expect(commandInputProblems(input())).toEqual([]);
  });

  it.each([
    ["an empty re", { re: " \n " }, "re is empty"],
    ["a re over 120 characters", { re: "r".repeat(MAX_COMMAND_RE_CHARS + 1) }, "re is longer than 120 characters"],
    ["an empty body", { body: "\n  \n" }, "body is empty"],
    ["a body over 4,000 characters", { body: "b".repeat(MAX_COMMAND_BODY_CHARS + 1) }, "body is longer than 4000 characters"],
    ["a why over 300 characters", { why: "w".repeat(MAX_COMMAND_WHY_CHARS + 1) }, "why is longer than 300 characters"],
    ["a copy of a Manager command", { copy: true }, "copy is only for the Manager's copy of a Worker command (to: worker)"],
    ["a request id with a space", { requestId: "req 1" }, "requestId must be one token"],
    ["the request id none", { requestId: "none" }, "requestId must be one token"],
    ["a body ending in a why paragraph without why", { body: "Do it.\n\nwhy: because", why: null }, 'the body\'s last paragraph is a "why:" line'],
    ["an unknown from", { from: "someone" as CommandInput["from"] }, "from must be one of orchestrator, owner"],
    ["an unknown intent", { intent: "ship" as CommandInput["intent"] }, "intent must be one of answer, continue, redirect, stop, release, other"],
    ["an unknown effect", { effects: ["rocket" as Effect] }, "effects must be among"],
    ["an approved effect not declared", { effects: ["commit"], approved: ["commit", "push"] }, "approved names push, which effects does not declare"],
    ["an authority that is none of the three", { authority: "policy:tests" as CommandInput["authority"] }, "authority must be owner, autopilot or decision:"],
    ["a decision authority with no decision id", { authority: "decision:tomorrow" as CommandInput["authority"] }, "authority must be owner, autopilot or decision:"],
    ["the owner's own command on another authority", { from: "owner", via: "tab", authority: "autopilot" }, "the owner's own command has authority owner"],
    ["autopilot authority off Autopilot", { via: "chat", authority: "autopilot" }, "authority autopilot is only for a command via autopilot"],
  ])("refuses %s", (_label, over, problem) => {
    const bad = input(over as Partial<CommandInput>);
    expect(commandInputProblems(bad).join("\n")).toContain(problem);
    expect(() => commandBlockOf(bad)).toThrow(/^Not a valid BM-COMMAND: /);
  });

  it("the body limit is the proposal's command limit, why fits a proposal's reason, and a whole block fits the stored text sent", () => {
    expect(MAX_COMMAND_BODY_CHARS).toBe(MAX_PROPOSAL_COMMAND_CHARS);
    expect(MAX_COMMAND_WHY_CHARS).toBe(MAX_PROPOSAL_REASON_CHARS);
    expect(MAX_SENT_TEXT_CHARS).toBeGreaterThanOrEqual(MAX_COMMAND_BLOCK_CHARS);
  });
});

describe("the parser refuses what the builder never writes", () => {
  const good = commandBlockOf(input());
  const ownerGood = commandBlockOf(input({ from: "owner", via: "tab" }));
  const granted = commandBlockOf(input({ via: "chat", intent: "release", effects: ["push"], authority: "decision:o:1a2b", approved: ["push"] }));
  const without = (line: string) => good.split("\n").filter((each) => !each.startsWith(line)).join("\n");

  it.each([
    ["not a string", 42],
    ["text without the marker", "Please go on with option B."],
    ["the marker not on the first line", `Hello\n${good}`],
    ["the marker with more words", good.replace("BM-COMMAND", "BM-COMMAND now")],
    ["no from", without("from:")],
    ["no via", without("via:")],
    ["no to", without("to:")],
    ["no requestId", without("requestId:")],
    ["no re", without("re:")],
    ["an unknown via", good.replace("via: autopilot", "via: email")],
    ["copy on a Manager command", good.replace("to: manager", "to: manager\ncopy: yes")],
    ["copy that is not yes", commandBlockOf(input({ to: "worker", copy: true })).replace("copy: yes", "copy: no")],
    ["a repeated key", good.replace("to: manager", "to: manager\nto: worker")],
    ["a header line that is not key: value", good.replace("to: manager", "to: manager\nplease read this")],
    ["no body", good.split("\n\n")[0]!],
    ["an empty why", good.replace("why: The owner said CSV last week.", "why:")],
    ["a re over the limit", good.replace(/^re: .*$/m, `re: ${"r".repeat(MAX_COMMAND_RE_CHARS + 1)}`)],
    ["a body over the limit", commandBlockOf(input({ why: null })).replace("Tell the Worker to use CSV.", "b".repeat(MAX_COMMAND_BODY_CHARS + 1))],
    ["a why over the limit", good.replace("why: The owner said CSV last week.", `why: ${"w".repeat(MAX_COMMAND_WHY_CHARS + 1)}`)],
    ["a v2 block without approved", without("approved:")],
    ["a v2 block without intent", without("intent:")],
    ["an unknown intent", good.replace("intent: other", "intent: ship")],
    ["an unknown effect", good.replace("effects: none", "effects: rocket")],
    ["none beside an effect", good.replace("effects: none", "effects: none, push")],
    ["a repeated effect", granted.replace("effects: push", "effects: push, push")],
    ["an approved effect not declared", granted.replace("approved: push", "approved: push, deploy")],
    ["an unknown authority", good.replace("authority: autopilot", "authority: policy:tests")],
    ["the owner's command on the Autopilot's authority", ownerGood.replace("authority: owner", "authority: autopilot")],
    ["autopilot authority via chat", good.replace("via: autopilot", "via: chat")],
    ["a limit that withholds an approved effect", granted.replace("limits: no-commit, no-deploy, no-real-data", "limits: no-commit-push-deploy, no-real-data")],
    ["a no-<effect> limit that withholds an approved effect", granted.replace("limits: no-commit, no-deploy, no-real-data", "limits: no-push")],
  ])("%s → null", (_label, text) => {
    expect(parseCommandBlock(text)).toBeNull();
  });

  it("a lone why: line after the header is the body, as the builder writes a one-line body", () => {
    expect(parseCommandBlock(`${good.split("\n\n")[0]!}\n\nwhy: nothing else`)).toMatchObject({ body: "why: nothing else", why: null });
  });

  it("ignores a header key it does not know, and reads keys in any case", () => {
    expect(parseCommandBlock(good.replace("to: manager", "to: manager\npriority: high"))).toEqual(commandOf(input()));
    expect(parseCommandBlock(good.replace("requestId:", "REQUESTID:"))).toEqual(commandOf(input()));
  });
});

describe("version 1 blocks still read (autonomy design §A.7)", () => {
  /** A block as 0.5 wrote it: no intent, effects, authority or approved. */
  const v1 = [
    "BM-COMMAND",
    "from: orchestrator",
    "via: autopilot",
    "to: worker",
    "copy: yes",
    `requestId: ${REQ}`,
    "re: stop and report",
    "limits: no-commit-push-deploy, no-real-data",
    "",
    "Stop and report.",
    "",
    "why: The owner is away.",
  ].join("\n");

  it("reads as version 1: its limits as written, no intent, effects, authority or approval", () => {
    expect(parseCommandBlock(v1)).toEqual({
      version: 1,
      from: "orchestrator",
      via: "autopilot",
      to: "worker",
      copy: true,
      requestId: REQ,
      re: "stop and report",
      intent: null,
      effects: [],
      authority: null,
      approved: [],
      limits: ["no-commit-push-deploy", "no-real-data"],
      body: "Stop and report.",
      why: "The owner is away.",
    });
    // The owner's v1 command has no limits line; a limit a later plugin added is kept as written.
    expect(parseCommandBlock(v1.replace("from: orchestrator", "from: owner").replace("via: autopilot", "via: tab").replace(/^limits: .*\n/m, ""))).toMatchObject({ version: 1, limits: [] });
    expect(parseCommandBlock(v1.replace("no-real-data", "no-spend"))!.limits).toEqual(["no-commit-push-deploy", "no-spend"]);
  });

  it("a block with some of the v2 fields is neither version: not a command block", () => {
    expect(parseCommandBlock(v1.replace("re: stop and report", "re: stop and report\nintent: stop"))).toBeNull();
    expect(parseCommandBlock(v1.replace("re: stop and report", "re: stop and report\neffects: none\nauthority: autopilot\napproved: none"))).toBeNull();
  });
});

describe("limits never contradict the approval (autonomy design §A.7)", () => {
  it("no approval keeps both fixed limits; a partly approved limit keeps its other effects one by one; a wholly approved one goes", () => {
    expect(limitsOf([])).toEqual(["no-commit-push-deploy", "no-real-data"]);
    expect(limitsOf(["push"])).toEqual(["no-commit", "no-deploy", "no-real-data"]);
    expect(limitsOf(["commit", "push"])).toEqual(["no-deploy", "no-real-data"]);
    expect(limitsOf(["commit", "push", "deploy"])).toEqual(["no-real-data"]);
    expect(limitsOf(["real-data"])).toEqual(["no-commit-push-deploy"]);
    expect(limitsOf(["commit", "push", "deploy", "real-data"])).toEqual([]);
    // Effects no fixed limit withholds change nothing.
    expect(limitsOf(["publish", "migration", "network", "cost"])).toEqual([...COMMAND_LIMITS]);
  });

  it("for every set of approved effects, no limit withholds one of them, and every unapproved fixed effect stays withheld", () => {
    const fixed: Effect[] = ["commit", "push", "deploy", "real-data"];
    for (let mask = 0; mask < 1 << fixed.length; mask += 1) {
      const approved = fixed.filter((_, index) => (mask & (1 << index)) !== 0);
      const withheld = limitsOf(approved).flatMap(effectsWithheldBy);
      expect(withheld.filter((effect) => approved.includes(effect)), approved.join()).toEqual([]);
      expect(new Set(withheld), approved.join()).toEqual(new Set(fixed.filter((effect) => !approved.includes(effect))));
    }
  });

  it("reads which effects a limit withholds; a limit this build does not know withholds none", () => {
    expect(effectsWithheldBy("no-commit-push-deploy")).toEqual(["commit", "push", "deploy"]);
    expect(effectsWithheldBy("no-real-data")).toEqual(["real-data"]);
    expect(effectsWithheldBy("no-push")).toEqual(["push"]);
    expect(effectsWithheldBy("no-spend")).toEqual([]);
    expect(effectsWithheldBy("no-none")).toEqual([]);
  });

  it("the owner's own command carries no limits whatever it declares", () => {
    expect(commandOf(input({ from: "owner", via: "tab", effects: ["push"], approved: [] })).limits).toEqual([]);
  });
});

describe("authority values", () => {
  it("owner, autopilot, or decision:<a decision id> of at most 200 characters", () => {
    expect(isCommandAuthority("owner")).toBe(true);
    expect(isCommandAuthority("autopilot")).toBe(true);
    expect(isCommandAuthority(decisionAuthorityOf("o:1a2b"))).toBe(true);
    expect(isCommandAuthority("decision:q:req-20260929T073348Z:Q4")).toBe(true);
    expect(isCommandAuthority(`decision:f:${"x".repeat(MAX_COMMAND_DECISION_ID_CHARS - 1)}`)).toBe(false);
    for (const bad of ["", "Owner", "decision:", "decision:o:", "decision:x:1", "policy:tests", 7, null]) expect(isCommandAuthority(bad)).toBe(false);
    expect(decisionIdOfAuthority("decision:o:1a2b")).toBe("o:1a2b");
    expect(decisionIdOfAuthority("owner")).toBeNull();
    expect(decisionIdOfAuthority(null)).toBeNull();
  });

  it("the intents are a prepared command's", () => {
    // Every intent is one a prepared command takes, and nothing else is.
    const prepared = (intent: string) => preparedActionSchema.safeParse({ kind: "command", to: "worker", agentId: "a", intent, body: "b", effects: [] }).success;
    for (const intent of COMMAND_INTENTS) expect(prepared(intent), intent).toBe(true);
    expect(prepared("ship")).toBe(false);
  });
});
