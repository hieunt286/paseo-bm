import { describe, expect, it } from "vitest";
import { dangerOfCommand } from "../plugin/server/worker-watch";
import {
  ACTION_CATEGORY,
  EFFECTFUL_ACTIONS,
  boundaryVerdictOfCommand,
  boundaryVerdictOfWrite,
  classifyCommand,
  declaredEffectsOf,
  effectfulActionOf,
  effectfulCommandOf,
  heldClassOf,
  namesAction,
  pathVerdictOf,
  type BoundaryContext,
} from "../plugin/shared/effectful-actions";
import { parseShellLine } from "../plugin/shared/shell";
import { WORKSPACE_DIRECTORY } from "./fixtures/orchestrator-traces";

/** One list for the Worker watch's `danger` and A-6 (Orchestrator design §6B.3; code review 2026-09-30 §3.5). */
describe("the effectful actions", () => {
  it("derives each action's gate category from its effects: the literal it replaces", () => {
    expect(ACTION_CATEGORY).toEqual({
      "git push": "release",
      "npm publish": "release",
      "pnpm publish": "release",
      "yarn publish": "release",
      "kubectl apply/delete": "release",
      "terraform apply/destroy": "release",
      "helm install/upgrade/uninstall": "release",
      "vercel --prod": "release",
      "docker push": "release",
      "DROP TABLE/DATABASE": "data",
      TRUNCATE: "data",
      "DELETE FROM without WHERE": "data",
      "rm -rf outside the workspace": null,
    });
    expect(Object.keys(ACTION_CATEGORY)).toEqual([...EFFECTFUL_ACTIONS]);
  });

  it("an owner's text names an action by a word of that category, or rm -rf by delete / remove", () => {
    expect(namesAction("Ship it: publish the image.", "docker push")).toBe(true);
    expect(namesAction("Do not push.", "git push")).toBe(false);
    expect(namesAction("Run the migration.", "TRUNCATE")).toBe(true);
    expect(namesAction("Run the migration.", "git push")).toBe(false);
    expect(namesAction("Xóa thư mục build cũ.", "rm -rf outside the workspace")).toBe(true);
  });

  it("the Worker watch and A-6 read a command the same way", () => {
    const commands = [
      "git push",
      "git -C repo push origin main",
      "npm publish --access public",
      "pnpm publish",
      "yarn publish",
      "kubectl -n prod apply -f deploy.yaml",
      "kubectl delete pod web-1",
      "terraform apply -auto-approve",
      "terraform destroy",
      "helm upgrade web ./chart",
      "helm uninstall web",
      "vercel deploy --prod",
      "docker push registry/app:1",
      `psql -c "DROP TABLE invoices"`,
      `psql -c "TRUNCATE invoices"`,
      `sqlite3 app.db "DELETE FROM invoices;"`,
      "rm -rf /",
      "rm -rf ~/projects",
      "sudo rm -fr $HOME/cache",
      "rm -rf /work/other-app",
      "rm -r -f ../other-app",
      "cd src && rm -rf ../../etc",
      "git status",
      "npm test",
      "kubectl get pods",
      "terraform plan",
      "vercel deploy",
      `sqlite3 app.db "DELETE FROM invoices WHERE id = 3"`,
      "truncate -s 0 app.log",
      "rm -rf dist",
      `rm -rf ${WORKSPACE_DIRECTORY}/build`,
      "rm -r /tmp/scratch",
      "rm -rf $TMPDIR/scratch",
    ];
    for (const command of commands) {
      const watch = dangerOfCommand(command, null, WORKSPACE_DIRECTORY) !== null;
      expect([command, effectfulActionOf(command, WORKSPACE_DIRECTORY) !== null]).toEqual([command, watch]);
    }
    for (const command of commands) {
      const watch = dangerOfCommand(command, null, null) !== null;
      expect([command, effectfulActionOf(command, null) !== null]).toEqual([command, watch]);
    }
  });

  it("names the action, or the rm -rf target judged; a relative target is judged from where it ran", () => {
    expect(effectfulCommandOf("git -C repo push origin main", null, WORKSPACE_DIRECTORY)).toEqual({ action: "git push", name: "git push" });
    expect(effectfulCommandOf(`rm -rf "build" /etc`, null, WORKSPACE_DIRECTORY)).toEqual({ action: "rm -rf outside the workspace", name: "rm -rf /etc" });
    expect(effectfulCommandOf("rm -rf build", "/work/elsewhere", WORKSPACE_DIRECTORY)).toEqual({ action: "rm -rf outside the workspace", name: "rm -rf build" });
    expect(effectfulCommandOf("rm -rf build", null, WORKSPACE_DIRECTORY)).toEqual({ action: null, rmNotJudged: false, scratchRm: false });
    expect(effectfulCommandOf("rm -rf $OUT build", null, WORKSPACE_DIRECTORY)).toEqual({ action: null, rmNotJudged: true, scratchRm: false });
    expect(effectfulCommandOf("rm -rf build", null, null)).toEqual({ action: null, rmNotJudged: true, scratchRm: false });
  });
});

// ── The action boundary's classes (autonomy design §D.2, change-009 C4–C5) ──

const WS = WORKSPACE_DIRECTORY;
const SCRIPTS: Record<string, string> = {
  test: "vitest run",
  build: "tsup && tsc --noEmit",
  release: "npm run build && npm publish",
  deploy: "vercel --prod",
  fetchdata: "curl -s https://example.com/data.json -o data.json",
};
const context = (overrides: Partial<BoundaryContext> = {}): BoundaryContext => ({
  cwd: WS,
  workspaceDirectory: WS,
  homeDirectory: "/Users/owner",
  scriptBodyOf: (name) => SCRIPTS[name] ?? null,
  ...overrides,
});
/** The declared effects of a command's held findings; [] when nothing is held. */
const held = (command: string, overrides: Partial<BoundaryContext> = {}) => declaredEffectsOf(boundaryVerdictOfCommand(command, context(overrides)).findings);

describe("the action boundary's classification", () => {
  it("holds each class of §D.2: release, data, dependency-install, network, outside-workspace", () => {
    expect(held("git push origin main")).toEqual(["push"]);
    expect(held("git -C sub push --force")).toEqual(["push"]);
    expect(held("npm publish --access public")).toEqual(["publish"]);
    expect(held("pnpm publish")).toEqual(["publish"]);
    expect(held("gh release create v1.0.0")).toEqual(["publish"]);
    expect(held("docker push registry/app:1")).toEqual(["push"]);
    expect(held("kubectl -n prod apply -f deploy.yaml")).toEqual(["deploy"]);
    expect(held("terraform apply -auto-approve")).toEqual(["deploy"]);
    expect(held("vercel deploy --prod")).toEqual(["deploy"]);
    expect(held(`sqlite3 scratch.db "DROP TABLE users;"`)).toEqual(["real-data"]);
    expect(held(`psql -c "UPDATE invoices SET paid = true"`)).toEqual(["real-data"]);
    expect(held("npx prisma migrate deploy")).toEqual(["migration"]);
    expect(held("npm install left-pad")).toEqual(["dependency-install"]);
    expect(held("pnpm add -D zod")).toEqual(["dependency-install"]);
    expect(held("pip install requests")).toEqual(["dependency-install"]);
    expect(held("brew install jq")).toEqual(["dependency-install"]);
    expect(held("curl -s 127.0.0.1:6897/net/probe")).toEqual(["network"]);
    expect(held("wget https://example.com/x.tar.gz")).toEqual(["network"]);
    expect(held("ssh host uptime")).toEqual(["network"]);
    expect(held("rsync -a dist/ deploy@host:/srv/app")).toEqual(["network"]);
    expect(held("echo hi > /work/other-app/notes.txt")).toEqual(["outside-workspace"]);
    expect(held("rm -rf /work/other-app")).toEqual(["outside-workspace"]);
    expect(held("cp build.zip ~/Desktop/")).toEqual(["outside-workspace"]);
    expect(held("mkdir -p ../sibling/out")).toEqual(["outside-workspace"]);
    expect(held("sed -i '' 's/a/b/' /etc/hosts")).toEqual(["outside-workspace"]);
    expect(boundaryVerdictOfWrite("/etc/hosts", context()).findings.map((finding) => finding.effects[0])).toEqual(["outside-workspace"]);
  });

  it("holds nothing of ordinary work: tests, reads, edits and deletions inside, a lockfile install, git fetch and commit", () => {
    for (const command of [
      "npm test",
      "npm run build",
      "yarn test",
      "cat README.md",
      "ls -la src",
      "grep -rn TODO src | head -20",
      "npm install",
      "npm ci",
      "pnpm install --frozen-lockfile",
      "pip install -r requirements.txt",
      "git fetch origin",
      "git pull --rebase",
      "git clone ../upstream.git vendor/upstream",
      "git add -A && git commit -m 'fix: git push notes'",
      "rm -rf dist node_modules/.cache",
      "echo done > build.log 2>&1",
      "npm test > /dev/null 2>&1",
      "truncate -s 0 app.log",
      "cd src && mkdir -p generated && touch generated/index.ts",
      "br update bm-1 --status in_progress",
    ]) {
      expect([command, held(command)]).toEqual([command, []]);
    }
    expect(boundaryVerdictOfWrite(`${WS}/src/app.ts`, context()).findings).toEqual([]);
    expect(boundaryVerdictOfWrite("src/app.ts", context()).findings).toEqual([]);
  });

  it("the scratch area is not outside: the temp roots, $TMPDIR, the daemon's TMPDIR and a mktemp variable of the same command", () => {
    const scratch = (command: string, overrides: Partial<BoundaryContext> = {}) => boundaryVerdictOfCommand(command, context(overrides));
    for (const command of [
      "rm -rf /tmp/bm-scratch",
      "mkdir -p /private/tmp/x && echo 1 > /private/tmp/x/y",
      "rm -rf $TMPDIR/scratch",
      `d=$(mktemp -d) && cp -r src "$d" && rm -rf "$d"`,
      "rm -rf /var/folders/ab/cd1234/T/tmp.X1",
    ]) {
      const verdict = scratch(command);
      expect([command, verdict.findings]).toEqual([command, []]);
      expect(verdict.scratchWrites).toBeGreaterThan(0);
    }
    expect(scratch("rm -rf /opt/daemon-tmp/x", { scratchRoots: ["/opt/daemon-tmp"] }).findings).toEqual([]);
    // Out of the scratch area again through `..`: outside.
    expect(held("rm -rf /tmp/../etc")).toEqual(["outside-workspace"]);
  });

  it("reads package scripts from their body, sh -c bodies, substitutions, and skips here-document text", () => {
    expect(held("npm run release")).toEqual(["publish"]);
    expect(held("npm run deploy")).toEqual(["deploy"]);
    expect(held("yarn fetchdata")).toEqual(["network"]);
    expect(held(`bash -c "npm publish"`)).toEqual(["publish"]);
    expect(held("echo $(curl -s https://example.com)")).toEqual(["network"]);
    expect(held("cat > notes.md <<'EOF'\ncurl https://example.com && git push\nEOF")).toEqual([]);
    // A script with no body: nothing runs. A script that cannot be read: unreadable.
    expect(held("npm run missing")).toEqual([]);
    const unread = boundaryVerdictOfCommand("npm run build", context({ scriptBodyOf: () => undefined }));
    expect(unread.findings).toEqual([expect.objectContaining({ unreadable: true, effects: ["security"] })]);
    expect(boundaryVerdictOfCommand("npm test", context({ scriptBodyOf: undefined })).findings[0]?.unreadable).toBe(true);
  });

  it("a path or command the text does not spell out is unreadable, held as security", () => {
    for (const command of [`rm -rf "$OUT"`, "mkdir -p $BUILD_DIR/x", "$CMD --all", "cd $DIR && touch a.txt", "find . -name '*.log' | xargs rm -f", `echo "unclosed`]) {
      const verdict = boundaryVerdictOfCommand(command, context());
      expect([command, verdict.findings.some((finding) => finding.unreadable)]).toEqual([command, true]);
      expect(heldClassOf(verdict.findings)).toBe("security");
    }
    expect(boundaryVerdictOfCommand("", context()).findings[0]?.unreadable).toBe(true);
    expect(boundaryVerdictOfWrite("", context()).findings[0]?.unreadable).toBe(true);
  });

  it("the class of a held request is its riskiest effect's", () => {
    expect(heldClassOf(boundaryVerdictOfCommand("npm install x && git push", context()).findings)).toBe("release");
    expect(heldClassOf(boundaryVerdictOfCommand("curl x && npm install y", context()).findings)).toBe("dependency");
    expect(heldClassOf(boundaryVerdictOfCommand("curl x", context()).findings)).toBe("environment");
  });

  it("judges a path against the workspace and the scratch area", () => {
    expect(pathVerdictOf("src/a.ts", { cwd: WS, workspaceDirectory: WS })).toBe("inside");
    expect(pathVerdictOf("/tmp/a", { cwd: WS, workspaceDirectory: WS })).toBe("scratch");
    expect(pathVerdictOf("~/a", { cwd: WS, workspaceDirectory: WS })).toBe("outside");
    expect(pathVerdictOf("~/work/invoice-app/a", { cwd: WS, workspaceDirectory: WS, homeDirectory: "/Users/owner" })).toBe("outside");
    expect(pathVerdictOf("a", { cwd: null, workspaceDirectory: WS })).toBe("unjudged");
    expect(pathVerdictOf("$d/x", { cwd: WS, workspaceDirectory: WS }, new Map([["d", "scratch"]]))).toBe("scratch");
    expect(pathVerdictOf("/dev/null", { cwd: WS, workspaceDirectory: WS })).toBe("inside");
    // macOS's TMPDIR ends with a slash; the default and pwd forms (field replay, change-009 C9).
    expect(pathVerdictOf("${TMPDIR}bm-x", { cwd: WS, workspaceDirectory: WS })).toBe("scratch");
    expect(pathVerdictOf("${TMPDIR:-/tmp}/bm-$$", { cwd: WS, workspaceDirectory: WS })).toBe("scratch");
    expect(pathVerdictOf("${TMPDIR}/../etc", { cwd: WS, workspaceDirectory: WS })).toBe("unjudged");
    expect(pathVerdictOf("$(pwd)/out", { cwd: WS, workspaceDirectory: WS })).toBe("inside");
    expect(pathVerdictOf("$Sx/out", { cwd: WS, workspaceDirectory: WS }, new Map([["S", "scratch"]]))).toBe("unjudged");
  });

  it("a script under a variable is a script (the limit); a bare variable as the command is unreadable", () => {
    expect(held("$S/check.sh --all")).toEqual([]);
    expect(held(`"$S/check.sh"`)).toEqual([]);
    expect(held("$CMD --all")).toEqual(["security"]);
    expect(held("${RUN} x")).toEqual(["security"]);
    expect(held("$(which git) push")).toEqual(["security"]);
  });

  it("A-6 and the watch use the same scratch rule: a scratch rm -rf is no action, reported apart", () => {
    expect(classifyCommand("rm -rf /tmp/bm-x", WS)).toEqual({ action: null, rmNotJudged: false, scratchRm: true });
    expect(classifyCommand(`d=$(mktemp -d) && rm -rf "$d"`, WS)).toEqual({ action: null, rmNotJudged: false, scratchRm: true });
    expect(dangerOfCommand("rm -rf /tmp/bm-x", null, WS)).toBeNull();
    expect(classifyCommand("rm -rf ../other", WS, `${WS}/src`).action).toBeNull();
    expect(classifyCommand("rm -rf ../../other", WS, `${WS}/src`).action).toBe("rm -rf outside the workspace");
  });
});

describe("the shell line reader", () => {
  it("splits commands, keeps quoted words whole, and reads redirections and assignments apart", () => {
    const parsed = parseShellLine(`FOO=1 npm test -- --grep "a b" 2>&1 | tee out.log && d=$(mktemp -d); echo 'x;y' >> "$d/f"`);
    expect(parsed.unbalanced).toBe(false);
    expect(parsed.commands.map((command) => command.words.map((word) => word.value))).toEqual([
      ["npm", "test", "--", "--grep", "a b"],
      ["tee", "out.log"],
      [],
      ["mktemp", "-d"],
      ["echo", "x;y"],
    ]);
    expect(parsed.commands[0]!.assignments.map((entry) => entry.name)).toEqual(["FOO"]);
    expect(parsed.commands[2]!.assignments[0]!.value.substitutions).toEqual(["mktemp -d"]);
    expect(parsed.commands[4]!.writes.map((word) => word.value)).toEqual(["$d/f"]);
  });
});
