import { describe, expect, it } from "vitest";
import {
  GATE_CATEGORIES,
  GATE_NEGATIONS,
  gateMatchesOf,
  GATE_CATEGORY_EFFECTS,
  gateOf,
  undeclaredCategoriesOf,
  undeclaredRefusalOf,
  type GateCategory,
} from "../plugin/shared/decision-gate";
import { CONFIRM_EFFECTS, EFFECTS } from "../plugin/shared/decisions";

/** The big-decision gate (Orchestrator design §6B.5, ADR-016 decision 3). */

describe("categories", () => {
  it("names the five categories in the design's order", () => {
    expect(GATE_CATEGORIES).toEqual(["security", "release", "data", "cost", "dependency"]);
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

  it("reports every match with its negation, in text order", () => {
    expect(gateMatchesOf("Do not push; deploy the fix")).toEqual([
      { category: "release", term: "push", index: 7, negated: true },
      { category: "release", term: "deploy", index: 13, negated: false },
    ]);
  });
});

describe("nothing silences the gate: Allow… is retired (autonomy design §B.8)", () => {
  /** What a caller of an earlier build passed: the categories the owner allowed for the project. */
  const withAllow = (fn: (...args: never[]) => GateCategory[], ...args: unknown[]) => (fn as unknown as (...rest: unknown[]) => GateCategory[])(...args);

  it("every category the text shows counts, and a list of allowed categories changes nothing", () => {
    const text = "Push the fix and rotate the token";
    expect(gateOf(text)).toEqual(["security", "release"]);
    expect(withAllow(gateOf, text, ["release", "security"])).toEqual(["security", "release"]);
    expect(withAllow(gateOf, "Triển khai và thêm thư viện", ["dependency"])).toEqual(["release", "dependency"]);
    // The backstop refuses an undeclared category even where Allow… once allowed it.
    expect(withAllow(undeclaredCategoriesOf, text, [], ["release", "security"])).toEqual(["security", "release"]);
    expect(gateOf.length).toBe(1);
    expect(undeclaredCategoriesOf.length).toBe(2);
  });

  it("nothing matched gates nothing", () => {
    expect(gateOf("Run the tests and report.")).toEqual([]);
    expect(gateOf("")).toEqual([]);
  });
});

describe("the backstop: a category the declared effects do not cover (autonomy design §A.7)", () => {
  it("maps every category to the effects that declare it, all of them real effects", () => {
    // Derived from CLASS_OF_EFFECT (code review 2026-09-30 §3.5): the literal it replaces.
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

  it("negated mentions and a declared-nothing text pass", () => {
    expect(undeclaredCategoriesOf("Fix the date. Do not push.", [])).toEqual([]);
    expect(undeclaredCategoriesOf("Run the tests and report.", [])).toEqual([]);
  });

  it("whatever the authority (autonomy design §B.9): no effect the owner's policy can cover declares a release, data, security or cost the text shows", () => {
    // The policy covers every effect but CONFIRM_EFFECTS; a text that shows one of those is refused under any authority.
    const delegable = EFFECTS.filter((effect) => effect !== "none" && !CONFIRM_EFFECTS.includes(effect));
    expect(delegable).toEqual(["commit", "dependency-install", "network", "outside-workspace"]);
    expect(undeclaredCategoriesOf("Commit, then git push.", ["none"])).toEqual(["release"]);
    expect(undeclaredCategoriesOf("Commit, then git push.", ["commit"])).toEqual(["release"]);
    expect(undeclaredCategoriesOf("Commit, git push, drop table users, rotate the token, upgrade the paid plan.", delegable)).toEqual(["security", "release", "data", "cost"]);
  });

  it("the refusal names what the text shows and says to declare the effect or ask the owner", () => {
    expect(undeclaredRefusalOf(["security", "release"])).toBe(
      "the text shows security (security), release (push, publish or deploy) that effects does not declare: declare the effect or ask the owner with bm_ask_owner",
    );
  });
});

describe("a stop of a Worker's open danger has no exemption any more (autonomy design §B.8)", () => {
  /** The Orchestrator's stop the gate held in the coordination run of 2026-09-29 (F2), word for word. */
  const F2_STOP =
    "stop and report\nStop what you are doing now: run no more git push and no more waits. Send your report: how many git push runs you made, what git said each time, which steps you didn't run, and confirm that nothing was changed or sent anywhere.";

  it("a stop that names the push un-negated is held as release, as any command", () => {
    expect(gateOf(F2_STOP)).toEqual(["release"]);
    expect(undeclaredCategoriesOf(F2_STOP, ["none"])).toEqual(["release"]);
  });

  it("a stop word before what it stops is a negation, so the stop itself passes", () => {
    for (const text of ["Stop the push now and report.", "Do not push again.", "Don't push again.", "Never push from this branch; report.", "Dừng git push lại và báo cáo."]) {
      expect([text, undeclaredCategoriesOf(text, ["none"])]).toEqual([text, []]);
    }
  });
});
