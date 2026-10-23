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
      "glab mr create/update": "release",
      "glab mr merge": "release",
      "gh pr create/edit": "release",
      "gh pr merge": "release",
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
      "glab mr create --target-branch develop --fill",
      "glab mr merge 12",
      "gh pr edit --base develop",
      "gh pr merge 3",
      "glab mr view",
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

  it("reads the SQL a command runs, not the SQL a here-document only writes (design §7.17.8 f)", () => {
    const actionOf = (command: string) => effectfulCommandOf(command, null, WORKSPACE_DIRECTORY).action;
    // Written into a file: text.
    expect(actionOf("cat > migrations/down.sql <<EOF\nDROP TABLE invoices;\nTRUNCATE invoices;\nDELETE FROM invoices;\nEOF")).toBeNull();
    expect(actionOf("cat > A.tsx <<'EOF'\n<div className=\"truncate\">\n<p className=\"truncate text-sm\">x</p>\nEOF")).toBeNull();
    // The field trace: a stdin script that writes rollback migrations, naming no driver.
    expect(actionOf("python3 - <<'EOF'\nfrom pathlib import Path\nPath('down.sql').write_text('DROP TABLE invoices;')\nEOF")).toBeNull();
    // Fed to a database client: SQL that runs, read case-insensitively.
    expect(actionOf("psql <<EOF\nDROP TABLE invoices;\nEOF")).toBe("DROP TABLE/DATABASE");
    expect(actionOf("cat <<EOF | psql app\ntruncate invoices;\nEOF")).toBe("TRUNCATE");
    expect(actionOf("sqlite3 app.db <<-SQL\n\tdelete from invoices;\n\tSQL")).toBe("DELETE FROM without WHERE");
    // An interpreter's stdin script that imports a driver, by word or import.
    expect(actionOf("python - <<EOF\nimport psycopg\nconn.execute('DROP TABLE invoices')\nEOF")).toBe("DROP TABLE/DATABASE");
    expect(actionOf("node - <<'EOF'\nconst { Client } = require(\"pg\");\nawait client.query(\"truncate invoices\");\nEOF")).toBe("TRUNCATE");
    // A driver name inside another word is not a driver.
    expect(actionOf("node - <<'EOF'\nconst pgUrl = 'x'; write('DROP TABLE invoices');\nEOF")).toBeNull();
    // A shell's stdin body is read as a command line.
    expect(actionOf("bash -s <<'EOF'\npsql -c \"drop table invoices\"\nEOF")).toBe("DROP TABLE/DATABASE");
    expect(actionOf("bash <<'EOF'\ncat > down.sql <<SQL\nDROP TABLE invoices;\nSQL\nEOF")).toBeNull();
    // A body whose file a client then runs on the same line.
    expect(actionOf("cat > down.sql <<EOF && psql -f down.sql\nDROP TABLE invoices;\nEOF")).toBe("DROP TABLE/DATABASE");
    // The SQL outside a body keeps its reading.
    expect(actionOf("cat > down.sql <<EOF\nselect 1;\nEOF\npsql -c \"DROP TABLE invoices\"")).toBe("DROP TABLE/DATABASE");
  });

  it("reads a here-document body as SQL that runs unless its head only writes it to files or is a driverless stdin script (default deny)", () => {
    const actionOf = (command: string) => effectfulCommandOf(command, null, WORKSPACE_DIRECTORY).action;
    // Exempt: pure file sinks, and stdin scripts naming no driver.
    expect(actionOf("cat > V2__down.sql <<EOF\nDROP TABLE x;\nEOF")).toBeNull();
    expect(actionOf("cat >> down.sql <<'EOF'\nDROP TABLE x;\nEOF")).toBeNull();
    expect(actionOf("tee a.sql b.sql <<EOF > /dev/null\nDROP TABLE x;\nEOF")).toBeNull();
    expect(actionOf("cat > A.tsx <<EOF\n<div className=\"truncate\">\nEOF")).toBeNull();
    expect(actionOf("python3 - <<'EOF'\nopen('V2__down.sql', 'w').write('DROP TABLE x;')\nEOF")).toBeNull();
    // A sink whose output another command consumes is not exempt.
    expect(actionOf("tee down.sql <<EOF | bash\npsql -c 'DROP TABLE x'\nEOF")).toBe("DROP TABLE/DATABASE");
    expect(actionOf("tee down.sql <<EOF | some-tool\nDROP TABLE x;\nEOF")).toBe("DROP TABLE/DATABASE");
    // Remote, container and shell wrappers: the body is read as commands.
    expect(actionOf('ssh db1 <<EOF\npsql -c "DROP TABLE users"\nEOF')).toBe("DROP TABLE/DATABASE");
    expect(actionOf("docker exec -i pg bash <<EOF\npsql -U app <<SQL\nDROP TABLE users;\nSQL\nEOF")).toBe("DROP TABLE/DATABASE");
    expect(actionOf("kubectl exec -i pod -- sh <<EOF\nmysql -e 'DROP DATABASE prod'\nEOF")).toBe("DROP TABLE/DATABASE");
    // Any other head: the body is SQL that runs.
    expect(actionOf("python3 manage.py shell <<EOF\nfrom django.db import connection\nconnection.cursor().execute('DROP TABLE users')\nEOF")).toBe("DROP TABLE/DATABASE");
    expect(actionOf("python3 manage.py dbshell <<EOF\nDROP TABLE users;\nEOF")).toBe("DROP TABLE/DATABASE");
    expect(actionOf("npx prisma db execute --stdin <<EOF\nDROP TABLE users;\nEOF")).toBe("DROP TABLE/DATABASE");
    // A stdin script naming a driver runs its SQL.
    expect(actionOf("node <<EOF\nconst mysql = require('mysql2');\nawait conn.query('DROP TABLE users');\nEOF")).toBe("DROP TABLE/DATABASE");
    expect(actionOf("node <<EOF\nconst Database = require('better-sqlite3');\nnew Database('app.db').exec('DROP TABLE users');\nEOF")).toBe("DROP TABLE/DATABASE");
    expect(actionOf("python3 - <<EOF\nimport pymysql\nc.execute('DROP TABLE users')\nEOF")).toBe("DROP TABLE/DATABASE");
    expect(actionOf("python3 - <<EOF\nimport asyncpg\nawait conn.execute('DROP TABLE users')\nEOF")).toBe("DROP TABLE/DATABASE");
  });

  it("outside a database client a bare truncate is TRUNCATE TABLE or an upper-case TRUNCATE <name>", () => {
    const actionOf = (command: string) => effectfulCommandOf(command, null, WORKSPACE_DIRECTORY).action;
    expect(actionOf("TRUNCATE TABLE invoices")).toBe("TRUNCATE");
    expect(actionOf(`echo "truncate table invoices" | some-tool`)).toBe("TRUNCATE");
    expect(actionOf(`echo "TRUNCATE invoices" | some-tool`)).toBe("TRUNCATE");
    expect(actionOf(`psql -c "truncate users"`)).toBe("TRUNCATE");
    expect(actionOf(`docker compose exec db psql -U app -c "truncate users"`)).toBe("TRUNCATE");
    expect(actionOf(`bq query "truncate users"`)).toBe("TRUNCATE");
    expect(actionOf(`clickhouse-client --query "truncate users"`)).toBe("TRUNCATE");
    expect(actionOf(`sed -i 's/flex/flex truncate text-sm/' src/A.tsx`)).toBeNull();
    expect(actionOf(`grep -rn 'className="truncate w-full"' src`)).toBeNull();
    expect(actionOf("truncate -s 0 app.log")).toBeNull();
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

// ── A placement's branch (delivery line design §4.2) ──

const PLACE = "/Users/owner/.paseo/worktrees/m-abc-fe";
const ROOT = "/work/frontend";
const MISSION = { directory: PLACE, branch: "m/ABC/fe", target: "develop", remote: "origin" as const };
const placed = (overrides: Partial<BoundaryContext> = {}): BoundaryContext => context({ cwd: PLACE, workspaceDirectory: PLACE, mission: MISSION, ...overrides });
/** Each held finding of a command run in the placement: what, its first effect, and whether the grant may cover it. */
const rows = (command: string, overrides: Partial<BoundaryContext> = {}) =>
  boundaryVerdictOfCommand(command, placed(overrides)).findings.map((finding) => ({
    what: finding.what,
    effect: finding.unreadable ? "unreadable" : finding.effects[0],
    covered: finding.integration === true ? "integration" : finding.forgeRead === true ? "forgeRead" : null,
  }));

describe("git and the forge CLIs in a placement (delivery line design §4.2)", () => {
  it("a push of the mission branch to origin is integration: the branch, HEAD, or none, with harmless flags only", () => {
    for (const command of [
      "git push -u origin m/ABC/fe",
      "git push origin HEAD",
      "git push origin",
      "git push --set-upstream origin HEAD:m/ABC/fe",
      "git push origin refs/heads/m/ABC/fe:refs/heads/m/ABC/fe",
      `git -C ${PLACE} push -q origin m/ABC/fe`,
      "cd src && git push origin m/ABC/fe",
      "git add -A && git commit -m 'feat: x' && git push -u origin m/ABC/fe",
    ]) {
      expect([command, rows(command)]).toEqual([command, [{ what: "git push m/ABC/fe", effect: "push", covered: "integration" }]]);
    }
  });

  it("any other push is a push as today: another branch or remote, forced, deleting, all, tags, rewired, or not spelled out", () => {
    for (const command of [
      "git push origin main",
      "git push origin m/ABC/fe:develop",
      "git push upstream m/ABC/fe",
      "git push",
      "git push -f origin m/ABC/fe",
      "git push --force-with-lease origin m/ABC/fe",
      "git push origin +m/ABC/fe",
      "git push origin :m/ABC/fe",
      "git push --delete origin m/ABC/fe",
      "git push --mirror origin",
      "git push --all origin",
      "git push --tags origin",
      "git push origin m/ABC/fe develop",
      "git push origin $BRANCH",
      "git -c remote.origin.url=git@evil:x.git push origin m/ABC/fe",
      "GIT_DIR=/work/frontend/.git git push origin m/ABC/fe",
      `git -C ${ROOT} push origin m/ABC/fe`,
      "git switch develop && git push origin HEAD",
      "git remote set-url origin git@evil:x.git && git push origin m/ABC/fe",
    ]) {
      expect([command, rows(command).find((row) => row.effect === "push")]).toEqual([command, { what: "git push", effect: "push", covered: null }]);
    }
  });

  it("commit, merge, cherry-pick and revert on the mission branch in the placement hold nothing", () => {
    for (const command of [
      "git add -A && git commit -m 'feat: the form'",
      "git merge origin/develop",
      "git cherry-pick abc1234",
      "git revert --no-edit abc1234",
      "git checkout -- src/a.ts",
      "git checkout src/a.ts",
      "git checkout HEAD~1 src/a.ts",
      "git switch m/ABC/fe",
      "git reset --soft HEAD~1",
      "git branch --list",
      "git status && git log -1",
      "git rebase --abort",
    ]) {
      expect([command, rows(command)]).toEqual([command, []]);
    }
  });

  it("the same outside the placement is outside-workspace; a folder not spelled out is unreadable", () => {
    expect(rows(`git -C ${ROOT} commit -m x`)).toEqual([{ what: "git commit outside the mission's worktree", effect: "outside-workspace", covered: null }]);
    expect(rows(`cd ${ROOT} && git merge origin/develop`)).toEqual([{ what: "git merge outside the mission's worktree", effect: "outside-workspace", covered: null }]);
    expect(rows("git commit -m x", { cwd: ROOT })).toEqual([{ what: "git commit outside the mission's worktree", effect: "outside-workspace", covered: null }]);
    expect(rows("cd $DIR && git commit -m x")).toEqual([{ what: "git commit in a folder the command does not spell out", effect: "unreadable", covered: null }]);
    expect(rows("git $SUB")).toEqual([{ what: "git with a subcommand the command does not spell out", effect: "unreadable", covered: null }]);
  });

  it("leaving the mission branch is held as a commit: switch, checkout, rebase, reset --hard, branch -D/-m, and a commit after a switch", () => {
    const off = (sub: string) => ({ what: `git ${sub} off the mission branch`, effect: "commit", covered: null });
    expect(rows("git switch develop")).toEqual([off("switch")]);
    expect(rows("git switch -c spike")).toEqual([off("switch")]);
    expect(rows("git checkout develop")).toEqual([off("checkout")]);
    expect(rows("git checkout -b spike")).toEqual([off("checkout")]);
    expect(rows("git rebase origin/develop")).toEqual([off("rebase")]);
    expect(rows("git reset --hard origin/develop")).toEqual([off("reset")]);
    expect(rows("git branch -D old")).toEqual([off("branch")]);
    expect(rows("git branch -m new-name")).toEqual([off("branch")]);
    expect(rows("git checkout develop && git commit -m x")).toEqual([off("checkout"), off("commit")]);
    // Back on the mission branch, a commit is the mission's again.
    expect(rows("git checkout develop && git checkout m/ABC/fe && git commit -m x")).toEqual([off("checkout")]);
  });

  it("changing a remote writes the repository's shared config: outside-workspace", () => {
    expect(rows("git remote set-url origin git@evil:x.git")).toEqual([{ what: "git remote set-url (the repository's config, shared with its root checkout)", effect: "outside-workspace", covered: null }]);
    expect(rows("git config remote.origin.pushurl git@evil:x.git")[0]?.effect).toBe("outside-workspace");
    expect(rows("git remote -v")).toEqual([]);
    expect(rows("git config --get remote.origin.url")).toEqual([]);
  });

  it("glab mr create or update of the mission branch into the integration branch is integration; anything else is not", () => {
    const covered = (command: string) => rows(command).map((row) => row.covered);
    expect(covered("glab mr create --target-branch develop --fill --yes")).toEqual(["integration"]);
    expect(covered("glab mr create -s m/ABC/fe -b develop -t 'feat: x' -d 'body'")).toEqual(["integration"]);
    expect(covered("glab mr create --source-branch=m/ABC/fe --target-branch=develop --push")).toEqual(["integration"]);
    expect(covered("glab mr update --title 'feat: y'")).toEqual(["integration"]);
    expect(covered("glab mr update m/ABC/fe --ready")).toEqual(["integration"]);
    expect(rows("glab mr update --title y")).toEqual([{ what: "glab mr update", effect: "push", covered: "integration" }]);
    for (const command of [
      "glab mr create --fill",
      "glab mr create --target-branch main --fill",
      "glab mr create -s other -b develop",
      "glab mr create -b develop -R group/other",
      "glab mr create -b develop --some-new-flag",
      "glab mr create -b $TARGET",
      "glab mr update 12 --title y",
      "glab mr update --target-branch main",
    ]) {
      expect([command, rows(command)]).toEqual([command, [{ what: rows(command)[0]!.what, effect: "push", covered: null }]]);
    }
  });

  it("gh pr create and edit are read like glab's", () => {
    expect(rows("gh pr create --base develop --fill")).toEqual([{ what: "gh pr create", effect: "push", covered: "integration" }]);
    expect(rows("gh pr create -B develop -H m/ABC/fe -t x -b body")).toEqual([{ what: "gh pr create", effect: "push", covered: "integration" }]);
    expect(rows("gh pr edit --title y")).toEqual([{ what: "gh pr edit", effect: "push", covered: "integration" }]);
    expect(rows("gh pr create --base main")).toEqual([{ what: "gh pr create", effect: "push", covered: null }]);
    expect(rows("gh pr edit 3 --title y")).toEqual([{ what: "gh pr edit", effect: "push", covered: null }]);
    expect(rows("gh pr merge 3")).toEqual([{ what: "gh pr merge", effect: "push", covered: null }]);
  });

  it("merging, approving, closing, CI runs and glab api are never covered; forge reads are forgeRead", () => {
    expect(rows("glab mr merge 12")).toEqual([{ what: "glab mr merge", effect: "push", covered: null }]);
    for (const [command, what] of [
      ["glab mr approve 12", "glab mr approve"],
      ["glab mr close 12", "glab mr close"],
      ["glab mr delete 12", "glab mr delete"],
      ["glab mr rebase 12", "glab mr rebase"],
      ["glab ci run", "glab ci run"],
      ["glab ci retry 99", "glab ci retry"],
      ["glab ci cancel", "glab ci cancel"],
      ["glab ci delete 99", "glab ci delete"],
      ["glab api projects/1/merge_requests", "glab api"],
    ] as const) {
      expect([command, rows(command)]).toEqual([command, [{ what, effect: "network", covered: null }]]);
    }
    for (const command of ["glab mr view", "glab mr list", "glab mr diff 12", "glab ci status", "glab ci view", "glab ci list", "glab ci get", "glab ci trace 5", "glab pipeline list", "glab pipeline status", "glab pipeline view"]) {
      expect([command, rows(command)]).toEqual([command, [{ what: "glab (read)", effect: "network", covered: "forgeRead" }]]);
    }
    // The forge read rows hold outside a placement too: glab is the network.
    expect(declaredEffectsOf(boundaryVerdictOfCommand("glab mr view", context()).findings)).toEqual(["network"]);
  });

  it("outside a placement git and the forge request rows are as before, never integration", () => {
    const plain = (command: string) => boundaryVerdictOfCommand(command, context()).findings;
    expect(plain("git push -u origin m/ABC/fe")).toEqual([{ what: "git push", effects: ["push"], unreadable: false }]);
    expect(plain("git checkout develop && git commit -m x")).toEqual([]);
    expect(plain("glab mr create --target-branch develop --fill")).toEqual([{ what: "glab mr create", effects: ["push"], unreadable: false }]);
    expect(plain("gh pr create --base develop")).toEqual([{ what: "gh pr create", effects: ["push"], unreadable: false }]);
  });

  it("the watch and A-6 name the new actions", () => {
    expect(effectfulActionOf("glab mr create --target-branch develop", PLACE)).toBe("glab mr create/update");
    expect(effectfulActionOf("glab mr update --title y", PLACE)).toBe("glab mr create/update");
    expect(effectfulActionOf("glab mr merge 12", PLACE)).toBe("glab mr merge");
    expect(effectfulActionOf("gh pr create --base develop", PLACE)).toBe("gh pr create/edit");
    expect(effectfulActionOf("gh pr merge 3", PLACE)).toBe("gh pr merge");
    expect(effectfulActionOf("glab mr view", PLACE)).toBeNull();
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
