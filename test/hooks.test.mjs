import assert from "node:assert/strict";
import { test } from "node:test";
import { decideStop } from "../hooks/check-before-done.mjs";
import { decideDependencies } from "../hooks/dependencies.mjs";
import { decideNoMerge } from "../hooks/no-merge.mjs";
import { decideReviewerCall, reportOf, reviewerKind } from "../hooks/reviewer.mjs";
import { decideSpecGate } from "../hooks/spec-gate.mjs";

const bash = (command, extra = {}) => ({ tool_name: "Bash", tool_input: { command }, cwd: "/repo", ...extra });
const write = (file_path, extra = {}) => ({ tool_name: "Write", tool_input: { file_path, content: "x" }, cwd: "/repo", ...extra });

test("spec gate: spec.md is written only on a spec/ branch", () => {
  assert.equal(decideSpecGate(write("/repo/specs/01/spec.md"), () => "main").allow, false);
  assert.equal(decideSpecGate(write("/repo/specs/01/spec.md"), () => "dev/01").allow, false);
  assert.equal(decideSpecGate(write("/repo/specs/01/spec.md"), () => "").allow, false);
  assert.equal(decideSpecGate(write("/repo/specs/01/spec.md"), () => "spec/01").allow, true);
  assert.equal(decideSpecGate(write("/repo/specs/01/progress.md"), () => "main").allow, true);
});

test("spec gate: shell commands that can change a spec.md or remove a specs folder", () => {
  const b = (c) => decideSpecGate(bash(c), () => "main").allow;
  assert.equal(b("sed -i s/a/b/ specs/01/spec.md"), false);
  assert.equal(b("cat /tmp/x | tee specs/01/spec.md"), false);
  assert.equal(b("cat specs/01/spec.md | tee /tmp/x"), true);
  assert.equal(b("rm -f /tmp/body.md && git add specs/01/spec.md && git commit -m x"), true);
  assert.equal(b("cp /tmp/new.md specs/01/spec.md"), false);
  assert.equal(b("echo x > specs/01/spec.md"), false);
  assert.equal(b("git checkout main -- specs/01/spec.md"), false);
  assert.equal(b("rm -rf specs/01"), false);
  assert.equal(b("git rm -r specs/"), false);
  assert.equal(b("cat specs/01/spec.md"), true);
  assert.equal(b("git diff main -- specs/01/spec.md 2>/dev/null"), true);
  assert.equal(b("git add specs/01/spec.md && git commit -m 'Spec 01'"), true);
  // Quotes and heredoc bodies hold no redirect.
  assert.equal(b('git add specs/01/spec.md && git commit -m "Spec 01\n\nCo-Authored-By: A <a@example.com>"'), true);
  assert.equal(b("cat >> specs/01/brainstorm.md <<'EOF'\n### Q1. Is spec.md > 1 page?\nEOF"), true);
  assert.equal(b("cat > specs/01/spec.md <<'EOF'\nx\nEOF"), false);
  assert.equal(b('echo x > "specs/01/spec.md"'), false);
  assert.equal(b("python3 - <<'EOF'\nopen('specs/01/spec.md','w')\nEOF"), false);
});

// The worktree of dev/01 at /repo/.worktrees/dev/01, of spec/01 at /repo/.worktrees/spec/01, the
// main checkout /repo on main.
const onBranch = {
  branchOf: (dir) => ({ "/repo": "main", "/repo/.worktrees/dev/01": "dev/01", "/repo/.worktrees/spec/01": "spec/01" })[dir] ?? "",
  trunkOf: () => "main",
};
const push = (command, cwd = "/repo/.worktrees/dev/01") => decideNoMerge(bash(command, { cwd }), onBranch).allow;

test("no merge: a skill pushes only its own story branch", () => {
  assert.equal(push("git push -u origin dev/01"), true);
  assert.equal(push("git push origin dev/01"), true);
  assert.equal(push("git push --set-upstream origin dev/01"), true);
  assert.equal(push("git push -u origin spec/01", "/repo/.worktrees/spec/01"), true);
  assert.equal(push("git -C .worktrees/dev/01 push -u origin dev/01", "/repo"), true);
  assert.equal(push("cd /repo/.worktrees/dev/01 && git push -u origin dev/01 2>&1"), true);
  assert.equal(push("git status && git push -u origin dev/01 && echo done"), true);

  assert.equal(push("git push -u origin spec/01"), false, "another story branch from this worktree");
  assert.equal(push("git push -u origin dev/02"), false, "another story's branch");
  assert.equal(push("git push origin main", "/repo"), false, "the trunk");
  assert.equal(push("git push origin main"), false, "the trunk from a story worktree");
  assert.equal(push("git push"), false, "no remote and branch named");
  assert.equal(push("git push origin"), false, "no branch named");
  assert.equal(push("git push --force origin dev/01"), false);
  assert.equal(push("git push --force-with-lease origin dev/01"), false);
  assert.equal(push("git push -f origin dev/01"), false);
  assert.equal(push("git push -uf origin dev/01"), false);
  assert.equal(push("git push origin +dev/01"), false);
  assert.equal(push("git push --delete origin dev/01"), false);
  assert.equal(push("git push origin --delete dev/01"), false);
  assert.equal(push("git push --mirror origin"), false);
  assert.equal(push("git push --all origin"), false);
  assert.equal(push("git push --tags origin"), false);
  assert.equal(push("git push origin dev/01 --tags"), false);
  assert.equal(push("git push origin dev/01:main"), false, "a refspec with a colon");
  assert.equal(push("git push origin HEAD:dev/01"), false, "a refspec with a colon");
  assert.equal(push("git push upstream dev/01"), false, "a remote other than origin");
  assert.equal(push("git push git@github.com:x/y.git dev/01"), false, "a URL as the remote");
  assert.equal(push("git push origin dev/01 dev/02"), false, "two branches");
  assert.equal(push("git -c remote.origin.url=x push origin dev/01"), false, "a git global option");
  assert.equal(push("git push -u origin dev/01", "/repo"), false, "from the main checkout");
  assert.equal(push("sh -c 'git push -u origin dev/01'"), false, "inside sh -c");
  assert.equal(push("echo `git push -u origin main`"), false, "inside backticks");
  assert.equal(push("sh <<'EOF'\ngit push origin main\nEOF"), false, "in a heredoc fed to a shell");
});

test("no merge: a pull request only for its own branch against the trunk", () => {
  assert.equal(push("gh pr create --head dev/01 --base main --title 'Dev 01: x' --body 'Merging is the approval.'"), true);
  assert.equal(push("gh pr create --head=dev/01 --base=main --fill"), true);
  assert.equal(push("gh pr create -H dev/01 -B main --title \"Dev 01: it's done\" --body x"), true);
  assert.equal(push("gh pr view dev/01 --json url,state"), true);
  assert.equal(push("gh pr review 3 --comment -b 'looks fine'"), true);

  assert.equal(push("gh pr create --base main --title x --body y"), false, "no --head");
  assert.equal(push("gh pr create --head dev/02 --base main"), false, "another branch");
  assert.equal(push("gh pr create --head spec/01 --base main"), false, "another story branch from this worktree");
  assert.equal(push("gh pr create --head dev/01 --base spec/01"), false, "another base");
  assert.equal(push("gh pr create --head dev/01"), false, "no --base");
  assert.equal(push("gh pr create --head main --base main", "/repo"), false, "from the main checkout");
  assert.equal(push("gh pr create --head dev/01 --base main --repo other/repo"), false, "another repository");
  assert.equal(push("gh pr merge 3"), false);
  assert.equal(push("gh pr merge --squash dev/01"), false);
  assert.equal(push("gh pr review 3 --approve"), false);
  assert.equal(push("gh pr review 3 -a"), false);
});

test("no merge: git merge stays blocked, the rest is allowed", () => {
  assert.equal(decideNoMerge(bash("git merge dev/01"), onBranch).allow, false);
  assert.equal(push("git merge main"), false);
  assert.equal(push("git -C /x merge dev/01", "/repo"), false);
  assert.equal(push("git status; git merge --no-ff dev/01"), false);
  assert.equal(decideNoMerge(bash("git merge-base --is-ancestor a b"), onBranch).allow, true);
  assert.equal(decideNoMerge(bash("git worktree add .worktrees/dev/01 -b dev/01"), onBranch).allow, true);
  assert.equal(decideNoMerge(bash('git commit -m "Allow git push of the own branch"'), onBranch).allow, true);
});

test("dependencies: only the allowed manifests declare dependencies", () => {
  const root = (line, prefix = "") => () => ({ root: "/repo", prefix, line });
  assert.equal(decideDependencies(write("/repo/package.json"), root()).allow, true);
  assert.equal(decideDependencies(write("/repo/packages/api/package.json"), root()).allow, false);
  assert.equal(decideDependencies(write("/repo/services/x/pyproject.toml"), root()).allow, false);
  assert.equal(decideDependencies(write("/repo/packages/api/package.json"), root("package.json, packages/api/package.json")).allow, true);
  assert.equal(decideDependencies(write("/repo/README.md"), root()).allow, true);
  assert.equal(decideDependencies(bash("npm install zod"), root()).allow, true);
  assert.equal(decideDependencies(bash("npm install zod --prefix packages/api"), root()).allow, false);
  assert.equal(decideDependencies(bash("cd packages/api && pnpm add zod"), root()).allow, false);
  assert.equal(decideDependencies(bash("pip install requests"), root(undefined, "service/")).allow, false);
  assert.equal(decideDependencies(bash("npm test"), root(undefined, "service/")).allow, true);
});

test("check before done: only on dev/ branches, once, and only while the check is red", () => {
  const deps = (branch, files, code = 1) => ({
    branchOf: () => branch,
    toplevelOf: () => "/repo",
    readFile: (p) => files[p],
    runCheck: () => ({ code, output: "1 failing" }),
  });
  const agents = { "/repo/AGENTS.md": "Check: npm test\n" };
  assert.equal(decideStop({ cwd: "/repo", stop_hook_active: true }, deps("dev/01", agents)).allow, true);
  assert.equal(decideStop({ cwd: "/repo" }, deps("main", agents)).allow, true);
  assert.equal(
    decideStop({ cwd: "/repo" }, deps("dev/01", { ...agents, "/repo/specs/01/progress.md": "State: blocked\n" })).allow,
    true,
  );
  const red = decideStop({ cwd: "/repo" }, deps("dev/01", agents));
  assert.equal(red.allow, false);
  assert.match(red.reason, /npm test/);
  assert.equal(decideStop({ cwd: "/repo" }, deps("dev/01", agents, 0)).allow, true);
  const missing = decideStop({ cwd: "/repo" }, deps("dev/01", { "/repo/AGENTS.md": "# no check\n" }));
  assert.equal(missing.allow, false);
  assert.match(missing.reason, /Check: <command>/);
});

test("reviewer: only the pipe reviewers are guarded", () => {
  assert.equal(reviewerKind("pipe:spec-reviewer"), "spec");
  assert.equal(reviewerKind("pipe:dev-reviewer"), "dev");
  assert.equal(reviewerKind("general-purpose"), undefined);
  assert.equal(decideReviewerCall({ ...write("/repo/README.md"), agent_type: "Explore" }, ["/repo"]).allow, true);
});

test("reviewer: cannot edit, cannot change the repository from the shell", () => {
  const r = (input) => decideReviewerCall({ ...input, agent_type: "pipe:dev-reviewer" }, ["/repo"]).allow;
  assert.equal(r({ tool_name: "Edit", tool_input: { file_path: "/repo/README.md" }, cwd: "/repo" }), false);
  assert.equal(r(write("/tmp/notes.md")), false);
  assert.equal(r({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/repo/a.ipynb" }, cwd: "/repo" }), false);
  for (const c of [
    "git commit -am fix",
    "git add README.md",
    "git checkout -- README.md",
    "git stash",
    "git branch -D dev/01",
    "echo fix > README.md",
    "sed -i 's/teh/the/' README.md",
    "rm README.md",
    "cp /tmp/x src/a.js",
    "npm install left-pad",
  ])
    assert.equal(r(bash(c)), false, c);
  for (const c of [
    "git diff main...dev/01",
    "git log --oneline -5",
    "git status --porcelain",
    "git branch --show-current",
    "git worktree list",
    "npm test",
    "PORT=4300 npm run dev > /tmp/dev.log 2>&1 &",
    "kill 1234",
    "rm -f /tmp/dev.log",
    "cat README.md | head",
  ])
    assert.equal(r(bash(c)), true, c);
});

test("reviewer report: from its first Revision/Verdict line, fence dropped", () => {
  assert.equal(reportOf("spec", "Here you go:\n\nRevision: abc1234\n\n## Form\n"), "Revision: abc1234\n\n## Form\n");
  assert.equal(reportOf("dev", "```markdown\nVerdict: human\nRevision: abc1234\n```"), "Verdict: human\nRevision: abc1234\n");
  assert.equal(reportOf("spec", "I cannot edit files."), undefined);
});
