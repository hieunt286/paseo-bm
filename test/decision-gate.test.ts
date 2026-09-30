import { describe, expect, it } from "vitest";
import {
  DANGER_STOP_CATEGORIES,
  GATE_CATEGORIES,
  GATE_NEGATIONS,
  GATE_STOP_WORDS,
  gateMatchesOf,
  GATE_CATEGORY_EFFECTS,
  gateOf,
  isGateCategory,
  isStopCommand,
  undeclaredCategoriesOf,
  undeclaredRefusalOf,
  type GateCategory,
} from "../plugin/shared/decision-gate";
import { EFFECTS } from "../plugin/shared/decisions";
import { ORCHESTRATOR_LIMIT_LINE } from "../plugin/shared/orchestrator";

/** The big-decision gate (Orchestrator design §6B.5, ADR-016 decision 3). */

describe("categories", () => {
  it("names the five categories in the design's order", () => {
    expect(GATE_CATEGORIES).toEqual(["security", "release", "data", "cost", "dependency"]);
    expect(isGateCategory("release")).toBe(true);
    expect(isGateCategory("deploy")).toBe(false);
  });

  const cases: Array<[GateCategory, string[]]> = [
    [
      "security",
      [
        "Check the security headers",
        "Give the bot write permissions",
        "Add the authorization check",
        "Fix authentication on the admin page",
        "Use login-as for the support user",
        "Impersonate the customer to reproduce it",
        "Rotate the API token",
        "Store the secrets in the vault",
        "Reset the password",
        "Read the credentials file",
        "Kiểm tra bảo mật của API",
        "Sửa phân quyền cho nhóm admin",
        "Đăng nhập hộ khách hàng",
        "Đổi mật khẩu",
      ],
    ],
    [
      "release",
      [
        "Push the branch",
        "git push origin main",
        "Deploy it",
        "Start the deployment",
        "Publish 0.5.0",
        "Cut a release",
        "It is released",
        "Check production logs",
        "Check the prod logs",
        "Merge into main when green",
        "Triển khai bản mới",
        "Phát hành 0.5.0",
      ],
    ],
    [
      "data",
      [
        "DROP TABLE users;",
        "Truncate the log table",
        "DELETE FROM sessions",
        "Migrate the schema",
        "Write the migration",
        "Try it on real data",
        "Copy the production data",
        "Xoá dữ liệu cũ",
        "Xóa dữ liệu cũ",
        "Chạy trên dữ liệu thật",
        "Kết nối cơ sở dữ liệu thật",
      ],
    ],
    [
      "cost",
      ["Check the billing page", "What does it cost", "Raise the price", "Update the pricing table", "Use the paid tier", "Cancel the subscription", "Giảm chi phí"],
    ],
    [
      "dependency",
      [
        "npm install lodash",
        "pnpm add zod",
        "yarn add react",
        "Add a dependency for dates",
        "It needs a new dependency",
        "Check the license",
        "Thêm thư viện date-fns",
      ],
    ],
  ];

  for (const [category, texts] of cases) {
    it.each(texts)(`${category}: %s`, (text) => {
      expect(gateOf(text)).toContain(category);
    });
  }

  it("returns each category once, in the design's order, whatever the order in the text", () => {
    expect(gateOf("Add a new dependency, then push, then rotate the token and push again")).toEqual(["security", "release", "dependency"]);
  });

  it("is case-insensitive, in English and in Vietnamese (upper case and combining marks too)", () => {
    expect(gateOf("PUSH IT")).toEqual(["release"]);
    expect(gateOf("TRIỂN KHAI")).toEqual(["release"]);
    expect(gateOf("Đổi mật khẩu".normalize("NFD"))).toEqual(["security"]);
    expect(gateOf("triển   khai\nngay")).toEqual(["release"]);
  });
});

describe("word boundaries", () => {
  it.each([
    ["product", "Improve the product page"],
    ["products", "List the products"],
    ["prepaid", "Show the prepaid balance"],
    ["pushover", "Send a pushover alert"],
    ["costume", "Fix the costume picker"],
    ["tokenizer", "Rewrite the tokenizer"],
    ["deployer_id", "Rename deployer_id"],
    ["priceless", "The UI is priceless"],
    ["npm installer", "Update the npm installer script"],
  ])("does not match %s", (_word, text) => {
    expect(gateOf(text)).toEqual([]);
  });

  it("matches the inflected forms the terms list", () => {
    for (const text of ["pushed", "pushing", "deployed", "deploying", "published", "releases", "migrated", "migrating", "migrations", "costs", "prices", "subscriptions"]) {
      expect(gateOf(text), text).not.toEqual([]);
    }
  });

  it("a mention in punctuation or code still counts", () => {
    expect(gateOf("Run `git push`.")).toEqual(["release"]);
    expect(gateOf("(deploy)")).toEqual(["release"]);
    expect(gateOf("pre-push hook")).toEqual(["release"]);
  });
});

describe("negations within 4 words (design §6B.5)", () => {
  it("names the negations of the design", () => {
    expect(GATE_NEGATIONS).toEqual(["not", "no", "never", "don't", "without", "stop", "avoid", "không", "đừng", "chưa", "cấm", "dừng", "tránh"]);
  });

  it("reads a stop or an avoidance as a negation, in English and Vietnamese", () => {
    expect(gateOf("Stop the push and run the tests again.")).toEqual([]);
    expect(gateOf("Avoid any deploy until the review passes.")).toEqual([]);
    expect(gateOf("Dừng việc push lại.")).toEqual([]);
    expect(gateOf("Tránh triển khai lúc này.")).toEqual([]);
    expect(gateOf("Push the branch now.")).toEqual(["release"]);
  });

  it.each([
    "Do not push.",
    "Don't push the branch",
    "Don’t push the branch",
    "DO NOT DEPLOY",
    "No deploy today",
    "Never publish from a branch",
    "Fix it without a release",
    "Do not commit or push",
    "Không push lên main",
    "Đừng triển khai",
    "Chưa phát hành",
    "Cấm xoá dữ liệu",
    "Không được đổi mật khẩu",
  ])("%s → nothing", (text) => {
    expect(gateOf(text)).toEqual([]);
  });

  it("a negation more than 4 words before does not count", () => {
    expect(gateOf("Do not change the tests, just push")).toEqual(["release"]);
    expect(gateOf("Not now: first fix the linter then push")).toEqual(["release"]);
  });

  it("a negation in an earlier sentence does not count", () => {
    expect(gateOf("Do not deploy. Push the fix.")).toEqual(["release"]);
    expect(gateOf("Không cần.\nTriển khai ngay")).toEqual(["release"]);
  });

  it("one negated mention does not hide another that is not", () => {
    expect(gateOf("Do not push yet; push after the review")).toEqual(["release"]);
  });

  it("a word that only contains a negation is not one", () => {
    expect(gateOf("Nothing to push")).toEqual(["release"]);
    expect(gateOf("Another deploy")).toEqual(["release"]);
  });

  it("the Orchestrator's own limit line would be negated, but the gate never reads the limits field", () => {
    expect(gateMatchesOf(ORCHESTRATOR_LIMIT_LINE).filter((match) => match.category === "release").every((match) => match.negated)).toBe(true);
  });

  it("reports every match with its negation, in text order", () => {
    expect(gateMatchesOf("Do not push; deploy the fix")).toEqual([
      { category: "release", term: "push", index: 7, negated: true },
      { category: "release", term: "deploy", index: 13, negated: false },
    ]);
  });
});

describe("categories the owner allowed", () => {
  it("an allowed category does not count; the others still do", () => {
    const text = "Push the fix and rotate the token";
    expect(gateOf(text)).toEqual(["security", "release"]);
    expect(gateOf(text, ["release"])).toEqual(["security"]);
    expect(gateOf(text, ["release", "security"])).toEqual([]);
    expect(gateOf("Triển khai và thêm thư viện", ["dependency"])).toEqual(["release"]);
  });

  it("nothing matched, or nothing given, gates nothing", () => {
    expect(gateOf("Run the tests and report.")).toEqual([]);
    expect(gateOf("")).toEqual([]);
  });

});

describe("the backstop: a category the declared effects do not cover (autonomy design §A.7)", () => {
  it("maps every category to the effects that declare it, all of them real effects", () => {
    expect(GATE_CATEGORY_EFFECTS).toEqual({
      security: ["security"],
      release: ["push", "publish", "deploy"],
      data: ["real-data", "migration"],
      cost: ["cost"],
      dependency: ["dependency-install"],
    });
    for (const effects of Object.values(GATE_CATEGORY_EFFECTS)) {
      for (const effect of effects) expect(EFFECTS.filter((known) => known !== "none")).toContain(effect);
    }
  });

  it("a category is declared by any one of its effects; the text's other categories stay undeclared", () => {
    const text = "Push the fix and rotate the token";
    expect(undeclaredCategoriesOf(text, [])).toEqual(["security", "release"]);
    expect(undeclaredCategoriesOf(text, ["none"])).toEqual(["security", "release"]);
    expect(undeclaredCategoriesOf(text, ["push"])).toEqual(["security"]);
    // Declaring deploy declares the release category too: the backstop only checks the text shows nothing undeclared.
    expect(undeclaredCategoriesOf(text, ["deploy", "security"])).toEqual([]);
    expect(undeclaredCategoriesOf("Run the migration on the real data.", ["migration"])).toEqual([]);
    expect(undeclaredCategoriesOf("npm install left-pad", ["dependency-install"])).toEqual([]);
    expect(undeclaredCategoriesOf("npm install left-pad", ["commit", "network"])).toEqual(["dependency"]);
  });

  it("negated mentions, allowed categories and a declared-nothing text pass", () => {
    expect(undeclaredCategoriesOf("Fix the date. Do not push.", [])).toEqual([]);
    expect(undeclaredCategoriesOf("Push the fix and rotate the token", [], ["release"])).toEqual(["security"]);
    expect(undeclaredCategoriesOf("Run the tests and report.", [])).toEqual([]);
  });

  it("the refusal names what the text shows and says to declare the effect or ask the owner", () => {
    expect(undeclaredRefusalOf(["security", "release"])).toBe(
      "the text shows security (security), release (push, publish or deploy) that effects does not declare: declare the effect or ask the owner with bm_ask_owner",
    );
  });
});

describe("a stop of a Worker's open danger (design §6B.5, coordination run 2026-09-29 F2)", () => {
  /** The Orchestrator's stop the gate held in the run, word for word. */
  const F2_STOP =
    "stop and report\nStop what you are doing now: run no more git push and no more waits. Send your report: how many git push runs you made, what git said each time, which steps you didn't run, and confirm that nothing was changed or sent anywhere.";

  it("the run's stop names the push un-negated, so the gate alone holds it as release", () => {
    expect(gateOf(F2_STOP)).toEqual(["release"]);
    expect(isStopCommand(F2_STOP)).toBe(true);
    expect(gateOf(F2_STOP, DANGER_STOP_CATEGORIES)).toEqual([]);
  });

  it("the exemption covers release and data only", () => {
    expect(DANGER_STOP_CATEGORIES).toEqual(["release", "data"]);
    expect(gateOf("Stop. Rotate the token and tell me the cost.", DANGER_STOP_CATEGORIES)).toEqual(["security", "cost"]);
  });

  it("every stop word counts, in any case, with its inflections; Vietnamese in both spellings", () => {
    expect(GATE_STOP_WORDS).toEqual(["stop", "halt", "cancel", "do not", "don't", "never", "dừng", "không được", "huỷ", "hủy"]);
    for (const text of [
      "STOP the push now",
      "Halt the deploy.",
      "Cancel the migration and report.",
      "Cancelled: report how far the migration got.",
      "Do  not push again.",
      "Don't push again.",
      "Don’t push again.",
      "Never push from this branch; report.",
      "Stopping here: report how many pushes ran.",
      "Dừng git push lại và báo cáo.",
      "Không được push nữa.",
      "Huỷ lệnh push.",
      "Hủy lệnh push.",
      "Hu\u1ef7 l\u1ec7nh push.".normalize("NFD"),
    ]) {
      expect([text, isStopCommand(text)]).toEqual([text, true]);
    }
  });

  it("a word that only contains a stop word, or no stop word at all, is not a stop", () => {
    for (const text of ["Push the fix to main.", "Run the unstoppable build and push.", "The cancellation policy: push it.", "Unhalting worker: push.", "Report the backstop and push.", ""]) {
      expect([text, isStopCommand(text)]).toEqual([text, false]);
    }
  });
});
