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

test("no merge: git merge, git push and gh pr merge are blocked", () => {
  assert.equal(decideNoMerge(bash("git merge dev/01")).allow, false);
  assert.equal(decideNoMerge(bash("git -C /x push origin main")).allow, false);
  assert.equal(decideNoMerge(bash("gh pr merge 3")).allow, false);
  assert.equal(decideNoMerge(bash("git merge-base --is-ancestor a b")).allow, true);
  assert.equal(decideNoMerge(bash("git worktree add .worktrees/dev/01 -b dev/01")).allow, true);
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
