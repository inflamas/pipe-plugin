// Runs the real scripts and hook processes in a throwaway git repository.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = realpathSync(mkdtempSync(join(tmpdir(), "pipe-flow-")));
after(() => rmSync(repo, { recursive: true, force: true }));

const sh = (cmd, cwd = repo) => spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
const node = (script, args, cwd = repo, input) =>
  spawnSync("node", [join(PLUGIN, script), ...args], { cwd, encoding: "utf8", input });
const hook = (script, args, input) => node(script, args, input.cwd ?? repo, JSON.stringify(input));
const write = (path, text) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};

test("a story from the roadmap to a recorded review", () => {
  sh("git init -q -b main && git config user.email t@example.com && git config user.name Test");
  write("README.md", "# Test\n");
  sh("git add -A && git commit -qm init");

  // No AGENTS.md: every skill stops with the check message.
  let r = node("skills/spec/scripts/spec.mjs", ["start", "01"]);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /Check: <command>/);

  write("AGENTS.md", "# Test\n\nCheck: true\n");
  r = sh("git add -A && git commit -qm agents");
  r = node("skills/spec/scripts/spec.mjs", ["start", "01"]);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /\.worktrees\/ is not in \.gitignore/);

  write(".gitignore", ".worktrees/\n");
  write("specs/roadmap.md", "# Roadmap\n\n## Epic 1: Runner\n\n### Story 01: Walking skeleton\n\n**Afterwards a person can** run it.\n\n**On screen when done:** None.\n\n**Out of scope:** more.\n\n**Group:** A\n");
  sh("git add -A && git commit -qm roadmap");

  r = node("skills/spec/scripts/spec.mjs", ["start", "01"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const wt = join(repo, ".worktrees/spec/01");
  assert.match(r.stdout, new RegExp(`worktree: ${wt}`));
  assert.match(r.stdout, /mode: brainstorm/);
  const link = readFileSync(join(wt, ".git"), "utf8");
  if (/relative-paths/.test(sh("git help worktree").stdout ?? "")) assert.doesNotMatch(link, new RegExp(repo));

  // Starting again reuses the worktree.
  r = node("skills/spec/scripts/spec.mjs", ["start", "01"]);
  assert.equal(r.status, 0);

  // The spec gate: spec.md on main is blocked, on spec/01 allowed.
  const onMain = hook("hooks/spec-gate.mjs", [], {
    tool_name: "Write",
    tool_input: { file_path: join(repo, "specs/01/spec.md"), content: "x" },
    cwd: repo,
  });
  assert.equal(onMain.status, 2);
  const onSpec = hook("hooks/spec-gate.mjs", [], {
    tool_name: "Write",
    tool_input: { file_path: join(wt, "specs/01/spec.md"), content: "x" },
    cwd: wt,
  });
  assert.equal(onSpec.status, 0);

  // An event was written for the start, and a denied one for the block.
  const events = readFileSync(join(repo, ".git/pipe/events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(events.some((e) => e.step === "spec" && e.event === "start" && e.ticket === "01"));
  assert.ok(events.some((e) => e.step === "spec-gate" && e.event === "denied"));
  assert.deepEqual(Object.keys(events[0]), ["ticket", "step", "event", "time", "outcome", "turns", "cost_usd"]);

  // /pipe:dev stops: the spec is not approved.
  r = node("skills/dev/scripts/dev.mjs", ["start", "01"]);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /no specs\/01\/spec.md|not merged/);

  // The asks log: one AskUserQuestion call on spec/01.
  r = hook("hooks/asks.mjs", [], {
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Story 01: which runner?", options: [{ label: "Node (Recommended)" }] }] },
    tool_response: { answers: { "Story 01: which runner?": "Node" } },
    cwd: wt,
  });
  assert.equal(r.status, 0);
  const asks = readFileSync(join(repo, ".git/pipe/asks.jsonl"), "utf8");
  assert.match(asks, /"branch":"spec\/01"/);
});

test("changedPaths keeps the first character of an unstaged first line", async () => {
  const { changedPaths } = await import("../lib/common.mjs");
  writeFileSync(join(repo, "README.md"), "# Changed\n");
  assert.deepEqual(changedPaths(repo), ["README.md"]);
  sh("git checkout -- README.md");
});

test("review-dev: only the reviewer's captured report becomes review.md", () => {
  const wt = join(repo, ".worktrees/dev/01");
  sh("git branch dev/01 main && git worktree add -q .worktrees/dev/01 dev/01");
  sh(`mkdir -p specs/01 && printf 'State: ready for review\\n' > specs/01/progress.md && git add -A && git commit -qm progress`, wt);
  let r = node("skills/review-dev/scripts/review-dev.mjs", ["start", "01"], wt);
  assert.equal(r.status, 0, r.stdout);
  const revision = r.stdout.match(/^revision: (\S+)/m)[1];

  // The reviewer stops; the SubagentStop hook takes its last message.
  const report = `Verdict: human\nRevision: ${revision}\nBrowser: not needed\n\n# Story 01 review: x\n`;
  r = hook("hooks/reviewer.mjs", ["capture"], {
    hook_event_name: "SubagentStop",
    agent_type: "pipe:dev-reviewer",
    last_assistant_message: `Here is the review.\n\n${report}`,
    cwd: wt,
  });
  assert.equal(r.status, 0);
  r = node("skills/review-dev/scripts/review-dev.mjs", ["record", "01"], wt);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(readFileSync(join(wt, "specs/01/review.md"), "utf8"), report);

  // A review.md that is not the report fails verify.
  writeFileSync(join(wt, "specs/01/review.md"), report.replace("human", "approve"));
  r = node("skills/review-dev/scripts/review-dev.mjs", ["verify", "01"], wt);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not the pipe:dev-reviewer agent's report word for word/);

  // The reviewer itself cannot write it.
  r = hook("hooks/reviewer.mjs", ["guard"], {
    hook_event_name: "PreToolUse",
    agent_type: "pipe:dev-reviewer",
    tool_name: "Bash",
    tool_input: { command: "echo approve > specs/01/review.md" },
    cwd: wt,
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot change the repository/);
});
