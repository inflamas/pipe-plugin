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

test("publish: the shell reads a published command back word for word, links point at the branch", async () => {
  const { commandLine, fileLink, webUrlOf } = await import("../lib/publish.mjs");
  const { shellSegments } = await import("../hooks/lib.mjs");
  const argv = ["gh", "pr", "create", "--head", "dev/01", "--base", "main", "--title", "Dev 01: it's \"done\"", "--body", "a\nb $HOME `x` ; && |"];
  assert.deepEqual(shellSegments(commandLine(argv)), [argv]);
  assert.equal(webUrlOf("git@github.com:inflamas/pipe-plugin.git"), "https://github.com/inflamas/pipe-plugin");
  assert.equal(webUrlOf("https://github.com/inflamas/pipe-plugin.git"), "https://github.com/inflamas/pipe-plugin");
  assert.equal(webUrlOf("ssh://git@example.com:2222/team/app.git"), "https://example.com/team/app");
  assert.equal(webUrlOf("/tmp/origin.git"), undefined);
  assert.equal(fileLink("/tmp/origin.git", "dev/01", "specs/01/review.md"), "specs/01/review.md");
  assert.equal(
    fileLink("git@github.com:o/r.git", "dev/01", "specs/01/review.md"),
    "[specs/01/review.md](https://github.com/o/r/blob/dev/01/specs/01/review.md)",
  );
});

test("publish: a story branch goes to a bare origin; no gh means one line for a person", async () => {
  const { publish } = await import("../lib/publish.mjs");
  const wt = join(repo, ".worktrees/dev/01");
  const specWt = join(repo, ".worktrees/spec/01");
  const origin = realpathSync(mkdtempSync(join(tmpdir(), "pipe-origin-")));
  after(() => rmSync(origin, { recursive: true, force: true }));
  const before = process.env.PIPE_GH;
  process.env.PIPE_GH = join(origin, "no-such-gh");
  after(() => (before === undefined ? delete process.env.PIPE_GH : (process.env.PIPE_GH = before)));
  const args = { wt, nr: "01", step: "review-dev", branch: "dev/01", trunk: "main", title: "Dev 01: Walking skeleton", body: "Merging is the approval." };

  // No origin yet: nothing pushed, one line with the command.
  let r = publish(args);
  assert.equal(r.pushed, false);
  assert.match(r.lines.join("\n"), /^push: not pushed \(this repository has no remote "origin"\)\. A person can run: cd \S+ && git push -u origin dev\/01$/);

  sh(`git init -q --bare ${origin} && git remote add origin ${origin}`);
  sh("git checkout -q -- specs/01/review.md 2>/dev/null; git add -A && git commit -qm review --allow-empty", wt);
  r = publish(args);
  assert.equal(r.pushed, true, r.lines.join("\n"));
  const remoteTip = () => sh("git ls-remote origin refs/heads/dev/01", wt).stdout.split(/\s/)[0];
  assert.equal(remoteTip(), sh("git rev-parse HEAD", wt).stdout.trim());
  assert.equal(r.lines.length, 2);
  assert.match(r.lines[1], /^pull request: not opened \(.*not installed\)\. A person can run: cd \S+ && gh pr create --head dev\/01 --base main --title 'Dev 01: Walking skeleton' --body 'Merging is the approval\.'$/);
  assert.equal(sh("git rev-parse --abbrev-ref dev/01@{upstream}", wt).stdout.trim(), "origin/dev/01");
  assert.equal(sh("git ls-remote origin refs/heads/main", wt).stdout, "", "the trunk is never pushed");

  // A later run pushes again.
  sh("git commit -qm again --allow-empty", wt);
  r = publish(args);
  assert.equal(r.pushed, true);
  assert.equal(remoteTip(), sh("git rev-parse HEAD", wt).stdout.trim());

  // Each push wrote a "push" event.
  const events = readFileSync(join(repo, ".git/pipe/events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const pushes = events.filter((e) => e.event === "push");
  assert.equal(pushes.length, 2);
  assert.deepEqual([pushes[0].ticket, pushes[0].step, pushes[0].outcome], ["01", "review-dev", "pushed; no pull request"]);

  // The hook, as a process: dev/01 may be pushed from its worktree, not from spec/01's.
  const pushFrom = (cwd, command) => hook("hooks/no-merge.mjs", [], { tool_name: "Bash", tool_input: { command }, cwd }).status;
  assert.equal(pushFrom(wt, "git push -u origin dev/01"), 0);
  assert.equal(pushFrom(specWt, "git push -u origin dev/01"), 2);
  assert.equal(pushFrom(specWt, "git push -u origin spec/01"), 0);
  assert.equal(pushFrom(repo, "git push origin main"), 2);
  assert.equal(pushFrom(wt, "gh pr create --head dev/01 --base main --title x --body y"), 0);
  assert.equal(pushFrom(wt, "gh pr create --head dev/01 --base master --title x --body y"), 2);
});

test("publish: review-dev pushes nothing while the review is not done", () => {
  const wt = join(repo, ".worktrees/dev/01");
  const r = node("skills/review-dev/scripts/review-dev.mjs", ["publish", "01"], wt);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^publish: nothing pushed, the review is not done/);
});

test("roadmap: a roadmap without tickets, the example tickets under block 1 of pipeline.md", async () => {
  const { createHash } = await import("node:crypto");
  const { BLOCKS, EVENT_FIELDS, EVENT_KINDS, EXAMPLE_TICKETS, FIXED, LATER_LINE, REVIEW_FIXED, SETUP_LINE } = await import(
    "../skills/roadmap/scripts/roadmap.mjs"
  );
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "pipe-roadmap-")));
  const data = realpathSync(mkdtempSync(join(tmpdir(), "pipe-data-")));
  after(() => [folder, data].forEach((d) => rmSync(d, { recursive: true, force: true })));
  const put = (path, text) => {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  };

  // The AskUserQuestion log, as hooks/asks.mjs writes it for a folder that is not a repository yet.
  const examples = ["Fix the typo in the --help text", "Add a --version flag", "Return 404 for an unknown id"];
  const calls = [
    [["Block 2, runtime and trigger: where does a run execute?", "Laptop"]],
    examples.map((e, i) => [`Block 1, intake: example ticket ${i + 1}?`, e]),
  ];
  const log = calls.map((qs) => ({
    branch: "",
    cwd: folder,
    tool_input: { questions: qs.map(([q]) => ({ question: q, options: [{ label: "A draft (Recommended)", description: "x" }] })) },
    tool_response: { answers: Object.fromEntries(qs) },
    at: new Date().toISOString(),
  }));
  const asks = join(data, "asks", `${createHash("sha256").update(folder).digest("hex").slice(0, 16)}.jsonl`);
  mkdirSync(dirname(asks), { recursive: true });
  writeFileSync(asks, log.map((e) => JSON.stringify(e)).join("\n") + "\n");

  put(
    "specs/roadmap-brainstorm.md",
    `# Pipeline brainstorm\n\n${calls
      .map(
        (qs, r) =>
          `## Round ${r + 1}: Block ${r === 0 ? 2 : 1}\n\n` +
          qs.map(([q, a], i) => `### Q${i + 1}. ${q}\n\nOptions:\n\n- **A draft (Recommended)**: x\n\nRecommendation: A draft.\n\nAnswer: "${a}"\n`).join("\n"),
      )
      .join("\n")}`,
  );
  const body = (n, mark) =>
    mark === "fixed"
      ? FIXED[n]
      : mark === "setup"
        ? SETUP_LINE
        : mark === "later"
          ? LATER_LINE
          : n === 1
            ? `Decision: "Laptop"\n\n${EXAMPLE_TICKETS}\n\n${examples.map((e) => `- "${e}"`).join("\n")}`
            : n === 8
              ? `Decision: "Laptop"\n${REVIEW_FIXED}`
              : 'Decision: "Laptop"';
  put(
    "pipeline.md",
    `# Pipeline\n\n${BLOCKS.map(([n, name, mark]) => `## ${n}. ${name}\n\n${body(n, mark)}\n`).join("\n")}
## Groups

- **A Runner and limits** (blocks 2, 10): Ana
- **B Runtime, trigger and isolation** (blocks 2, 3): Ana
- **C Gates, review and evals** (blocks 5, 7, 8, 9, 11): Ben
- **D Measurement** (block 13): Ben

## Events

One JSON line per event; events: ${EVENT_KINDS}.

${JSON.stringify(Object.fromEntries(EVENT_FIELDS.map((f) => [f, null])))}
`,
  );
  const story = (nr, title, group) =>
    `### Story ${nr}: ${title}\n\n**Afterwards a person can** run it${nr === "01" ? ": the walking skeleton" : ""}.\n\n**On screen when done:** None.\n\n**Out of scope:** more.\n\n**Group:** ${group}\n`;
  const roadmap = `# Roadmap\n\nThe pipeline, built.\n\n## Epic 1: Runner and limits\n\n${story("01", "Walking skeleton", "A")}\n## Epic 2: Measurement\n\n${story("02", "Events", "D")}`;
  put("specs/roadmap.md", roadmap);

  const verify = () => node("skills/roadmap/scripts/roadmap.mjs", ["verify", "--data", data], folder);
  let r = verify();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^verify: ok/);
  const written = readFileSync(join(folder, "pipeline.md"), "utf8");
  const intake = written.slice(written.indexOf("## 1. Intake"), written.indexOf("## 2. "));
  for (const e of examples) assert.ok(intake.includes(`- "${e}"`), e);
  assert.doesNotMatch(readFileSync(join(folder, "specs/roadmap.md"), "utf8"), /Tickets|Story 10\d/);

  // A ticket in the roadmap fails verify.
  put("specs/roadmap.md", `${roadmap}\n## Tickets for the pipeline\n\n${story("101", "Typo", "the pipeline")}`);
  r = verify();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /"## Tickets for the pipeline" is not an epic/);

  // An example ticket that is not the team's answer word for word fails verify.
  put("specs/roadmap.md", roadmap);
  put("pipeline.md", written.replace('- "Add a --version flag"', '- "Add a version flag"'));
  r = verify();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /example ticket "Add a version flag" is not an answer/);
});
