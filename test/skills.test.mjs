import assert from "node:assert/strict";
import { test } from "node:test";
import { agentsLine, parseNr, storyIn } from "../lib/common.mjs";
import { NOT_NEEDED, parseProgress, verifyReady } from "../skills/dev/scripts/dev.mjs";
import { checkImprove, proposalsOf } from "../skills/improve/scripts/improve.mjs";
import { checkRetro, cleanupPlan } from "../skills/learn/scripts/learn.mjs";
import { BROWSER_RULE, checkReview, expectedVerdict, RULES } from "../skills/review-dev/scripts/review-dev.mjs";
import { FORM_CHECKS, verifyFindings } from "../skills/review-spec/scripts/review-spec.mjs";
import { BLOCKS, checkPipeline, checkRoadmap, EVENT_FIELDS, FIXED, LATER_LINE, REVIEW_FIXED, SETUP_LINE } from "../skills/roadmap/scripts/roadmap.mjs";
import { checkSetup } from "../skills/setup/scripts/setup.mjs";
import { decideMode, hasScreen, parseArgs, verifyRecord, verifySpec } from "../skills/spec/scripts/spec.mjs";

const ROADMAP = `# Roadmap

The pipeline.

## Epic 1: Runner and limits

### Story 01: Walking skeleton

**Afterwards a person can** start one headless dev run: the walking skeleton.

**On screen when done:** None.

**Out of scope:** everything else.

**Group:** A

### Story 02: Limits

**Afterwards a person can** stop a run.

**On screen when done:** None.

**Out of scope:** dollars.

**Group:** A

## Tickets for the pipeline

### Story 101: Health endpoint

**Afterwards a person can** call /health.

**On screen when done:** None.

**Out of scope:** auth.

**Group:** the pipeline

### Story 102: Typo

**Afterwards a person can** read the help.

**On screen when done:** None.

**Out of scope:** more.

**Group:** the pipeline

### Story 103: Version flag

**Afterwards a person can** print the version.

**On screen when done:** None.

**Out of scope:** more.

**Group:** the pipeline
`;

test("common: story numbers, roadmap stories under epics, AGENTS.md lines", () => {
  assert.equal(parseNr("1"), "01");
  assert.equal(parseNr("101"), "101");
  assert.equal(parseNr("1001"), undefined);
  assert.match(storyIn(ROADMAP, "01"), /^### Story 01: Walking skeleton/);
  assert.doesNotMatch(storyIn(ROADMAP, "01"), /Story 02/);
  assert.doesNotMatch(storyIn(ROADMAP, "02"), /Tickets for the pipeline/);
  assert.match(storyIn(ROADMAP, "103"), /Version flag/);
  assert.equal(storyIn(ROADMAP, "04"), undefined);
  const agents = "# X\n\nCheck: `npm run check`\nRun: npm run dev -- --port {port}\n- Check: not this one\n";
  assert.equal(agentsLine(agents, "Check"), "npm run check");
  assert.equal(agentsLine(agents, "Run"), "npm run dev -- --port {port}");
  assert.equal(agentsLine(agents, "Install"), undefined);
  assert.deepEqual(parseArgs(["101", "--address-findings"]), { nr: "101", addressFindings: true });
});

const SPEC = (screen = "None.") => `# Story 01 spec: Walking skeleton

Roadmap: story 01.

One run.

## On screen

${screen}

## Data

None.

## Interfaces

The runner.

## Stays out

- Limits (story 02).

## Acceptance checks

1. **Runner, green:** run it → one event line.
2. **Guidelines:** the check passes.
`;

test("spec: sections in order, numbered bold checks, the screen", () => {
  assert.deepEqual(verifySpec(undefined, SPEC(), "x"), []);
  assert.equal(hasScreen(SPEC()), false);
  assert.equal(hasScreen(SPEC("A page.")), true);
  const bad = SPEC().replace("## Data", "## The data").replace("2. **Guidelines:**", "3. Guidelines:");
  const problems = verifySpec(undefined, bad, "x");
  assert.ok(problems.some((p) => /missing section "## Data"/.test(p)));
  assert.ok(problems.some((p) => /should be number 2/.test(p)));
  assert.ok(verifySpec(undefined, `${SPEC()}\nStatus: approved\n`, "x").some((p) => /status line/.test(p)));
});

test("spec: a record must be word for word from one logged call", () => {
  const record = `# Story 01 brainstorm: x

## Round 1: The run

### Q1. Story 01: which runner?

Options:

- **Node script (Recommended)**: small.

Recommendation: Node script.

Answer: "Node script"
`;
  const log = [["Story 01: which runner?", "Node script (Recommended)", "Node script"]];
  assert.deepEqual(verifyRecord("brainstorm.md", undefined, record, log, 2), []);
  const invented = record.replace('Answer: "Node script"', 'Answer: "A shell script"');
  assert.equal(verifyRecord("brainstorm.md", undefined, invented, log, 2).length, 1);
  assert.equal(verifyRecord("brainstorm.md", `${record}x`, record, log, 2).length, 1);
});

test("spec: the mode of a run", () => {
  const base = { nr: "01", specHistory: [], branchMergedIntoMain: false };
  assert.equal(decideMode(base).mode, "brainstorm");
  assert.match(decideMode({ ...base, specInWorktree: "x", specHistory: ["x"] }).stop, /waits for your review/);
  assert.match(
    decideMode({ ...base, specOnMain: "x", specInWorktree: "x", branchMergedIntoMain: true }).stop,
    /implementation contract/,
  );
});

test("review-spec: the reviewer's findings are checked", () => {
  const findings = `Revision: abc1234

## Form

| Check | Verdict | Rests on |
| --- | --- | --- |
${FORM_CHECKS.map((c) => `| ${c} | Met | l.10: fine |`).join("\n")}

## Domain precheck

| # | Rule in the spec | Line | Verdict | Source | Recommendation |
| --- | --- | --- | --- | --- | --- |
| 1 | one event per run | l.12 | Traced | pipeline.md block 13 | — |

## Missing checks

None.
`;
  assert.deepEqual(verifyFindings(findings, "abc1234"), []);
  assert.equal(verifyFindings(findings, "def5678").length, 1);
  assert.ok(verifyFindings(findings.replace("| Met |", "| Fine |"), "abc1234").length > 0);
});

test("dev: the three browser lines", () => {
  assert.equal(parseProgress(`State: ready for review\nCheck: green at abc1234\n${NOT_NEEDED}\n`).browser.kind, "not needed");
  assert.equal(parseProgress("State: x\nCheck: x\nBrowser: not available (chrome missing)\n").browser.why, "chrome missing");
  assert.equal(parseProgress("a\nb\nBrowser: 3 of 3 checks seen, screenshots at abc1234\n").browser.seen, 3);
  const progress = (line3, status = "done") =>
    `State: ready for review\nCheck: green at abc1234\n${line3}\n\n| # | Check | Status | Evidence |\n| --- | --- | --- | --- |\n| 1 | a | ${status} | test 1 |\n| 2 | b | ${status} | test 2 |\n`;
  const facts = (line3, spec = SPEC(), evidence = [], status) => ({ progress: progress(line3, status), spec, revision: "abc1234", evidence });
  assert.deepEqual(verifyReady(facts(NOT_NEEDED)), []);
  assert.ok(verifyReady(facts(NOT_NEEDED, SPEC("A page."))).some((p) => /has a screen/.test(p)));
  assert.deepEqual(verifyReady(facts("Browser: not available (no browser)", SPEC("A page."), [], "open")), []);
  assert.ok(verifyReady(facts("Browser: 2 of 2 checks seen, screenshots at abc1234", SPEC("A page."))).some((p) => /no \{screen\}-390/.test(p)));
  assert.deepEqual(
    verifyReady(facts("Browser: 2 of 2 checks seen, screenshots at abc1234", SPEC("A page."), ["home-390.png", "home-1440.png"])),
    [],
  );
});

const REVIEW = (verdict, line3, ruleResult = () => "clear", findings = "None.") => `Verdict: ${verdict}
Revision: abc1234
${line3}

# Story 01 review: x

Read it.

## What changed

A page.

## Picture

\`\`\`
page -> server
\`\`\`

## Acceptance checks

| # | Check | Proved by |
| --- | --- | --- |
| 1 | a | test 1 |
| 2 | b | test 2 |

## Rules

| Rule | Result | Evidence |
| --- | --- | --- |
${RULES.map((r) => `| ${r} | ${ruleResult(r)} | checked |`).join("\n")}

## Findings

${findings}

## Read line by line

1. \`src/a.js:1-3\`: the page.
`;

test("review-dev: verdicts follow the rules, the browser rule sends it to a person", () => {
  const facts = (review, progressBrowser = "seen") => ({
    review,
    revision: "abc1234",
    round: 1,
    checkNumbers: [1, 2],
    missingScreenshots: [],
    staleProgressLines: [],
    progressBrowser,
  });
  assert.deepEqual(checkReview(facts(REVIEW("approve", "Browser: used"))), []);
  assert.ok(checkReview(facts(REVIEW("approve", "Browser: not available (no chrome)"))).some((p) => p.includes(BROWSER_RULE)));
  const human = REVIEW("human", "Browser: not available (no chrome)", (r) => (r === BROWSER_RULE ? "fires" : "clear"));
  assert.deepEqual(checkReview(facts(human)), []);
  assert.ok(checkReview(facts(REVIEW("approve", "Browser: used"), "not available")).length > 0);
  assert.equal(expectedVerdict(false, 1, 3), "human");
  assert.equal(expectedVerdict(false, 1, 2), "rework");
});

test("learn: retro form and cleanup plan", () => {
  const retro = `# Story 01 retro: x

After abc1234f, merged locally, not released.

## What happened

It ran.

## Proposals

1. **/pipe:dev.** Change: x. Evidence: y.

## Cleanup

removed: a

## Noticed by me

Nothing.
`;
  assert.deepEqual(checkRetro({ nr: "01", retro, merge: "abc1234f00" }), []);
  const plan = cleanupPlan({
    worktrees: [
      { path: "/r", branch: "main" },
      { path: "/r/.worktrees/spec/01", branch: "spec/01" },
      { path: "/r/.worktrees/learn/01", branch: "learn/01" },
      { path: "/r/.worktrees/dev/02", branch: "dev/02" },
    ],
    own: "/r/.worktrees/learn/01",
    under: "/r/.worktrees",
    merged: (b) => b !== "dev/02",
    onMainLine: () => false,
  });
  assert.deepEqual(plan.map((s) => s.action), ["remove", "keep"]);
  assert.equal(proposalsOf(retro)[0].step, "/pipe:dev");
});

test("improve: every proposal decided, every change named", () => {
  const improve = `# Story 01 improve: x

## Round 1

### Q1. Story 01 retro, proposal 1 (/pipe:dev): x. Apply it?

Options:

- **Apply as written (Recommended)**: change it.

Recommendation: Apply as written.

Answer: "Apply as written"

## Decisions

| # | Proposal | Decision | Applied in |
| --- | --- | --- | --- |
| 1 | /pipe:dev | apply | \`AGENTS.md\` |
`;
  const log = [["Story 01 retro, proposal 1 (/pipe:dev): x. Apply it?", "Apply as written"]];
  const proposals = [{ text: "1. **/pipe:dev.**", step: "/pipe:dev" }];
  assert.deepEqual(checkImprove({ nr: "01", improve, proposals, changed: ["AGENTS.md", "specs/01/improve.md"], log }), []);
  assert.ok(checkImprove({ nr: "01", improve, proposals, changed: ["src/x.js"], log }).length > 0);
  assert.ok(checkImprove({ nr: "01", improve, proposals, changed: ["specs/01/spec.md"], log }).length > 0);
});

const PIPELINE = (decision = 'Decision: "Laptop"') => `# Pipeline

Team: 3.

${BLOCKS.map(([n, name, mark]) => {
  const body =
    mark === "fixed" ? FIXED[n] : mark === "setup" ? SETUP_LINE : mark === "later" ? LATER_LINE : n === 8 ? `${decision}\n${REVIEW_FIXED}` : decision;
  return `## ${n}. ${name}\n\n${body}\n`;
}).join("\n")}
## Groups

- **A Runner and limits** (10): Ana
- **B Runtime, trigger and isolation** (2, 3): Ana
- **C Gates, review and evals** (5, 7, 8, 9, 11): Ben
- **D Measurement** (13): Chris

## Events

One JSON line per event; events: start, end, stop, denied, limit.

${JSON.stringify(Object.fromEntries(EVENT_FIELDS.map((f) => [f, null])))}
`;

test("roadmap: pipeline.md and specs/roadmap.md", () => {
  const record = `## Round 1\n\n### Q1. Block 2?\n\nOptions:\n\n- **Laptop (Recommended)**: x\n\nRecommendation: Laptop.\n\nAnswer: "Laptop"\n`;
  assert.deepEqual(checkPipeline(PIPELINE(), record), []);
  assert.ok(checkPipeline(PIPELINE('Decision: "GitHub Actions"'), record).length > 0);
  assert.deepEqual(checkPipeline(PIPELINE('Decision: "Laptop" (revisit)'), record), []);
  assert.ok(checkPipeline(PIPELINE().replace(FIXED[12], "Learn sometimes."), record).some((p) => /fixed rule/.test(p)));
  assert.deepEqual(checkRoadmap(ROADMAP), []);
  assert.ok(checkRoadmap(ROADMAP.replace("### Story 102: Typo", "### Typo")).some((p) => /102/.test(p)));
  assert.ok(checkRoadmap(ROADMAP.replace(": the walking skeleton", "").replace("Story 01: Walking skeleton", "Story 01: First run")).some((p) => /walking skeleton/.test(p)));
});

test("setup: AGENTS.md lines come from the answers, the roadmap is kept", () => {
  const setup = `# Setup\n\n## Round 1: The check\n\n### Q1. Setup, round 1: the check?\n\nOptions:\n\n- **npm test (Recommended)**: x\n\nRecommendation: npm test.\n\nAnswer: "npm test"\n`;
  const facts = {
    setup,
    agents: "# X\n\nCheck: npm test\n\n## Pipeline rules\n",
    architecture: "# A",
    ui: undefined,
    roadmapBefore: ROADMAP,
    roadmapNow: ROADMAP,
    ignored: true,
    log: [["Setup, round 1: the check?", "npm test"]],
  };
  assert.deepEqual(checkSetup(facts), []);
  assert.ok(checkSetup({ ...facts, agents: "Check: make check\n## Pipeline rules" }).some((p) => /not an answer/.test(p)));
  assert.ok(checkSetup({ ...facts, roadmapNow: `${ROADMAP}x` }).some((p) => /unchanged/.test(p)));
  assert.ok(checkSetup({ ...facts, ignored: false }).length > 0);
});
