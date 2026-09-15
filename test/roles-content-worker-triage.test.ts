/**
 * Content checks for part one of plugin/roles/worker.md (bead bm-wp-115-51j.1):
 * the ordered size-triage rule (Design §2.6 E) and the label contract
 * (Design §2.6 A).
 *
 * The instructions are natural language, so the test does two things: it checks
 * that every rule is stated, and it checks the worked examples against the
 * expected answers. For labels it also re-implements the normalisation rule the
 * file states and proves every example is what that rule produces, so the file
 * cannot teach one rule and show examples that follow another.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const text = readFileSync(fileURLToPath(new URL("../plugin/roles/worker.md", import.meta.url)), "utf8");

function block(startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  expect(start, `missing ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(endMarker, start + startMarker.length);
  return text.slice(start, end === -1 ? undefined : end);
}

const triage = block("### Step 1", "### Step 2");
const labels = block("### Step 2", "### Step 3");

/** Rows of every markdown table in a block, as trimmed cells, header and divider removed. */
function tableRows(source: string): string[][] {
  return source
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|[\s|-]+\|$/.test(line))
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));
}

/** The normalisation rule exactly as the file states it. */
function slug(noun: string): string {
  return noun
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

describe("worker.md part one — size triage", () => {
  it("states the ordered rule, stopping at the first match", () => {
    expect(triage).toMatch(/in order and stop at the first one that matches/);
    const rule1 = triage.indexOf("1. The request touches a **public contract");
    const rule2 = triage.indexOf("2. The request satisfies **all**");
    const rule3 = triage.indexOf("3. Anything else → **Medium**");
    expect(rule1).toBeGreaterThan(0);
    expect(rule2).toBeGreaterThan(rule1);
    expect(rule3).toBeGreaterThan(rule2);
    for (const risk of ["public contract", "data schema", "authentication", "permissions", "weak rollback", "several independent components"]) {
      expect(triage).toContain(risk);
    }
    expect(triage).toMatch(/→ \*\*Large\*\*,\s+however small it sounds/);
  });

  it("says risk wins over size and forbids using the bead count", () => {
    expect(triage).toMatch(/Risk always wins over how small a request sounds/);
    expect(triage).toMatch(/Never use the number of\s+beads as evidence for the tier/);
  });

  it("gives Small no new document and one review after implementation, and makes Large ask before implementing", () => {
    const rows = tableRows(triage);
    const documents = rows.find((row) => row[0] === "Documents");
    const review = rows.find((row) => row[0] === "Review");
    const polish = rows.find((row) => row[0] === "Polish beads");
    const before = rows.find((row) => row[0] === "Before implementation");
    expect(documents?.[1]).toMatch(/no new document/);
    expect(review?.[1]).toMatch(/exactly 1 call, after implementation/);
    expect(review?.slice(2)).toEqual(["at most 2 calls per batch", "at most 2 calls per batch"]);
    expect(polish?.[1]).toMatch(/none/);
    expect(before?.[3]).toMatch(/ask the user to confirm first/);
  });

  it("raises the tier mid-way with a report, and lets the user override", () => {
    expect(triage).toMatch(/raise the tier, tell the user, and\s+only then continue/);
    expect(triage).toMatch(/The user may override the tier/);
  });

  const expectedTiers: readonly (readonly [string, string])[] = [
    ["Change one wording in an API response that clients rely on", "Large"],
    ["Add a column to a table", "Large"],
    ["Let users sign in with Google", "Large"],
    ["Fix a wrong date format shown in one component", "Small"],
    ["Fix a typo in a button label", "Small"],
    ["Add a new filter to an existing screen", "Medium"],
  ];

  it("classifies the sample requests into the expected tiers", () => {
    const rows = tableRows(triage).filter((row) => row.length === 3 && row[0] !== "Request");
    expect(rows.map((row) => [row[0], row[1]])).toEqual(expectedTiers);
    for (const row of rows) {
      const rule = row[1] === "Large" ? "1" : row[1] === "Small" ? "2" : "3";
      expect(row[2]?.startsWith(`${rule} — `), row[0]).toBe(true);
    }
  });
});

describe("worker.md part one — label contract", () => {
  it("states namespaces, normalisation, source, reuse and user-label rules", () => {
    expect(labels).toMatch(/`feature:<slug>` is \*\*required\*\*/);
    expect(labels).toContain("`area:<slug>`");
    expect(labels).toContain("`component:<slug>`");
    expect(labels).toMatch(/lowercase/);
    expect(labels).toMatch(/Vietnamese diacritics removed/);
    expect(labels).toMatch(/at most \*\*32 characters\*\*/);
    expect(labels).toMatch(/\*\*reuse that label\*\*/);
    expect(labels).toMatch(/you only add labels, you never remove them/);
  });

  it("requires feature:<slug> on every bead, lets extra labels coexist, and re-checks before beads-done (bm-fbp)", () => {
    const text = labels.replace(/\s+/g, " ");
    expect(text).toContain("**Every bead you create or update must carry `feature:<slug>`.**");
    expect(text).toContain("Extra labels such as `size:*` or the `requestId` may be added, but they never replace `feature:*`.");
    expect(text).toContain("Before sending `beads-done`, list the request's beads with their labels and add any missing `feature:*` label first.");
  });

  it("forbids any new document file for Small, including feature-workflow quick briefs or plans (bm-fbp)", () => {
    const documents = block("### Step 3", "### Step 4").replace(/\s+/g, " ");
    expect(documents).toContain("**Do not create any new document file** — no quick brief, quick plan or other lightweight artifact, even when feature-workflow suggests one.");
    expect(documents).toContain("Put the classification and the short plan in the bead description.");
  });

  it("queries open beads by feature label and widens to area when empty", () => {
    expect(labels).toMatch(/\*\*not closed\*\* and carry `feature:<slug>`/);
    expect(labels).toMatch(/widen the query to\s+`area:<slug>`/);
  });

  it("handles none / one / many, and stops to ask when several beads match", () => {
    const rows = tableRows(labels);
    expect(rows.find((row) => row[0] === "No bead")?.[1]).toMatch(/create a new bead/);
    expect(rows.find((row) => row[0] === "Exactly one bead")?.[1]).toMatch(/update that bead/);
    expect(rows.find((row) => row[0] === "**More than one bead**")?.[1]).toMatch(/stop and ask the user which bead to use/);
  });

  const expectedLabels: readonly (readonly [string, string, readonly string[]])[] = [
    ["Sửa lỗi định dạng ngày trên màn hình Hoá đơn", "none", ["feature:hoa-don"]],
    ["Thêm bộ lọc mới cho màn hình Báo cáo doanh thu trong module Kế toán", "none", ["feature:bao-cao-doanh-thu", "area:ke-toan"]],
    ["Phân quyền người dùng theo dự án", "none", ["feature:phan-quyen-nguoi-dung"]],
    ["Add CSV export to the Order List", "`feature:order-list`", ["feature:order-list"]],
    ["Add CSV export to the orders list page", "`feature:order-list`", ["feature:order-list"]],
  ];

  it("gives the expected label set for the sample requests", () => {
    const rows = tableRows(labels).filter((row) => row.length === 3 && row[0] !== "Request");
    const unquote = (cell: string | undefined) => (cell ?? "").replace(/^`|`$/g, "");
    expect(rows.map((row) => [unquote(row[0]), row[1], [...(row[2] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1])])).toEqual(
      expectedLabels,
    );
  });

  it("uses slugs that the stated normalisation rule actually produces", () => {
    expect(slug("Hoá đơn")).toBe("hoa-don");
    expect(slug("Báo cáo doanh thu")).toBe("bao-cao-doanh-thu");
    expect(slug("Kế toán")).toBe("ke-toan");
    expect(slug("phân quyền người dùng")).toBe("phan-quyen-nguoi-dung");
    expect(slug("Order List")).toBe("order-list");
    const long = slug("Quản lý phân quyền người dùng theo tổ chức");
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long.endsWith("-")).toBe(false);
    for (const [, , expected] of expectedLabels) {
      for (const label of expected) {
        const value = label.slice(label.indexOf(":") + 1);
        expect(slug(value), label).toBe(value);
      }
    }
  });

  it("is English apart from the sample requests, which are quoted as code", () => {
    for (const [request] of expectedLabels) {
      if (/\P{ASCII}/u.test(request)) {
        expect(text, request).toContain(`\`${request}\``);
      }
    }
    const withoutSamples = text.replace(/`[^`\n]*`/g, "");
    expect(withoutSamples).not.toMatch(/[ăâêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i);
  });
});
