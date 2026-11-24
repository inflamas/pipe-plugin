// The /pipe:review-dev skill's deterministic parts: the worktree, the implementation revision, the
// round, a free port for the browser pass, the reviewer's report, and the check of review.md.
//
//   node review-dev.mjs start <nr>
//     Run first, from anywhere in the repository. Stops unless .worktrees/dev/{nr} exists, is on
//     dev/{nr} and has no uncommitted change to a tracked file. Logs the start (HEAD, revision,
//     round) and prints what the pipe:dev-reviewer agent needs. Exit 0: go on. Exit 3: "STOP: ...".
//   node review-dev.mjs findings <nr>
//     After the agent finished: prints its report (saved by the plugin's SubagentStop hook) when it
//     is unchanged and passes the review checks; exit 1 with the problems otherwise.
//   node review-dev.mjs record <nr>
//     Writes the report to specs/{nr}/review.md, word for word. Only the skill writes review.md.
//   node review-dev.mjs verify <nr>
//     Run in the dev worktree before and after committing review.md. Exit 0 "verify: ok", exit 1
//     with the problems.
//   node review-dev.mjs publish <nr>
//     The last step, once review.md is committed and verify passes. On "approve" or "human": pushes
//     dev/{nr} to origin and opens its pull request (or reuses the open one); a person merges it. On
//     "rework": pushes nothing. A push or gh that fails is one line with the command for a person;
//     exit 0 either way.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentsLine,
  appendJsonl,
  event,
  git,
  gitOut,
  isMain,
  normalize,
  parseNr,
  readJsonl,
  readText,
  repoOrStop,
  reviewRevision,
  sameRevision,
  sha256,
  stateDir,
  stop,
  storyTitle,
  words,
  worktreePath,
} from "../../../lib/common.mjs";
import { fileLink, originOf, publish } from "../../../lib/publish.mjs";
import { appLines, freePort } from "../../../lib/ports.mjs";
import { implementationRevision, parseProgress } from "../../dev/scripts/dev.mjs";
import { canon } from "../../review-spec/scripts/review-spec.mjs";

// ---------------------------------------------------------------- the escalation rules, word for word

export const RULES = [
  "an acceptance check has no passing test, or the check is red",
  "the diff does more than the spec asked, or progress.md proposes a spec revision",
  "it touches a rule under Settled in specs/roadmap.md or in specs/guidelines/, or money, dates or time zones",
  "it changes the schema, seed data or an existing endpoint, or adds a dependency",
  "it touches the harness (AGENTS.md, guidelines, .claude/, hooks, skills, scripts/), input handling, authentication or secrets",
  "more than 200 lines changed outside specs/",
  "the browser was not available, so a screen was not seen in a browser",
  "you are unsure. Doubt goes to me.",
];
export const BROWSER_RULE = RULES[6];

export const SECTIONS = ["What changed", "Picture", "Acceptance checks", "Rules", "Findings", "Read line by line"];

export const REVIEWER = "pipe:dev-reviewer";

// ---------------------------------------------------------------- reading review.md

/** The body of each "## {name}" section, by name. */
export const sections = (text) => {
  const out = new Map();
  let name;
  let body = [];
  let fenced = false;
  const flush = () => {
    if (name !== undefined) out.set(name, body.join("\n").trim());
  };
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    const h = fenced ? null : line.match(/^## (.+?)\s*$/);
    if (h) {
      flush();
      name = h[1];
      body = [];
    } else if (name !== undefined) body.push(line);
  }
  flush();
  return out;
};

/** The numbered items ("1. …") of a section, first line only. */
export const numbered = (body) => body.split("\n").filter((l) => /^\d+\. \S/.test(l));

/** The verdict the rules dictate. Round 3 or later with findings goes to the person. */
export const expectedVerdict = (anyFires, findings, round) => {
  if (anyFires) return "human";
  if (findings > 0) return round >= 3 ? "human" : "rework";
  return "approve";
};

/** The numbers of the spec's acceptance checks: numbered items under "## Acceptance checks". */
export const specCheckNumbers = (spec) =>
  (sections(spec).get("Acceptance checks") ?? "")
    .split("\n")
    .map((l) => l.match(/^(\d+)\. /)?.[1])
    .filter((n) => n !== undefined)
    .map(Number);

/** Screenshot names the spec asks for ("evidence/home-390.png"). */
export const specScreenshots = (spec) => [...new Set([...spec.matchAll(/evidence\/([\w.-]+\.png)/g)].map((m) => m[1]))];

/**
 * Checks review.md (or the reviewer's report). Lines 1 to 3: "Verdict: …", "Revision: …",
 * "Browser: used | not needed | not available ({why})".
 */
export const checkReview = (f) => {
  const problems = [];
  const all = f.review.split("\n");
  const verdict = all[0]?.match(/^Verdict: (approve|rework|human)$/)?.[1];
  if (!verdict) problems.push('Line 1 is not "Verdict: approve", "Verdict: rework" or "Verdict: human".');
  const rev = all[1]?.match(/^Revision: ([0-9a-f]{4,40})$/)?.[1];
  if (!rev) problems.push('Line 2 is not "Revision: {revision}".');
  else if (!sameRevision(rev, f.revision))
    problems.push(`Line 2 names ${rev}, but the implementation revision is ${f.revision}.`);
  const browser = all[2]?.match(/^Browser: (used|not needed|not available)\b(.*)$/);
  if (!browser) problems.push('Line 3 is not "Browser: used", "Browser: not needed" or "Browser: not available ({why})".');

  const s = sections(f.review);
  const order = [...s.keys()].filter((k) => SECTIONS.includes(k));
  if (order.join("|") !== SECTIONS.join("|"))
    problems.push(`The sections must be, in this order: ${SECTIONS.map((x) => `"## ${x}"`).join(", ")}.`);

  const changed = (s.get("What changed") ?? "").split("\n").filter((l) => l.trim() !== "");
  if (changed.length < 1 || changed.length > 3) problems.push('"What changed" must have 1 to 3 lines.');
  if (!/```[\s\S]*```/.test(s.get("Picture") ?? "")) problems.push('"Picture" needs a code block.');

  const checks = s.get("Acceptance checks") ?? "";
  for (const n of f.checkNumbers)
    if (!new RegExp(`^\\|\\s*${n}\\s*\\|`, "m").test(checks))
      problems.push(`"Acceptance checks" has no row for spec check ${n}.`);

  let anyFires = false;
  const ruleLines = (s.get("Rules") ?? "").split("\n");
  const fired = new Set();
  for (const rule of RULES) {
    const row = ruleLines.find((l) => normalize(l).includes(rule));
    const after = row ? normalize(row).slice(normalize(row).indexOf(rule) + rule.length) : "";
    const result = after.match(/\b(fires|clear)\b/)?.[1];
    if (!row) problems.push(`"Rules" does not name this rule word for word: "${rule}".`);
    else if (!result) problems.push(`"Rules": the rule "${rule}" is neither "fires" nor "clear".`);
    else if (result === "fires") {
      anyFires = true;
      fired.add(rule);
    }
  }
  const unavailable = browser?.[1] === "not available" || f.progressBrowser === "not available";
  if (unavailable && !fired.has(BROWSER_RULE))
    problems.push(`The browser was not available (review line 3 or progress.md line 3), so the rule "${BROWSER_RULE}" fires.`);

  const findingsBody = s.get("Findings") ?? "";
  const findings = numbered(findingsBody);
  if (findings.length === 0 && findingsBody !== "None.")
    problems.push('"Findings" must be numbered items ("1. …") or exactly "None.".');
  for (const shot of f.missingScreenshots)
    if (!findingsBody.includes(shot)) problems.push(`The screenshot ${shot} is missing: that is a finding naming it.`);
  for (const line of f.staleProgressLines)
    if (!findingsBody.includes(line.split(":")[0] ?? line))
      problems.push(`progress.md "${line}" is for another revision: that is a finding.`);

  const read = numbered(s.get("Read line by line") ?? "");
  if (read.length < 1 || read.length > 3) problems.push('"Read line by line" must list 1 to 3 places.');

  if (verdict) {
    const expected = expectedVerdict(anyFires, findings.length, f.round);
    if (verdict !== expected)
      problems.push(
        `Verdict is "${verdict}", but the rules give "${expected}" (a rule fires: ${anyFires}, findings: ${findings.length}, round: ${f.round}).`,
      );
  }
  return problems;
};

// ---------------------------------------------------------------- git and the file system

const reviewDir = (cwd) => {
  const s = stateDir(cwd);
  return s ? join(s, "review-dev") : undefined;
};
const logOf = (dir, nr) => readJsonl(join(dir, "log.jsonl")).filter((e) => e.nr === nr);

/** Commits on dev/{nr} that touched review.md, up to `rev`. */
const reviewCommits = (cwd, rev, nr) =>
  (gitOut(cwd, "log", "--format=%h", rev, "--", `specs/${nr}/review.md`) ?? "").split("\n").filter(Boolean).length;

const factsFor = (wt, nr, round) => {
  const revision = implementationRevision(wt, nr) ?? "";
  const spec = readText(join(wt, `specs/${nr}/spec.md`)) ?? "";
  const progressText = readText(join(wt, `specs/${nr}/progress.md`)) ?? "";
  const progressLines = progressText.split("\n").slice(1, 3);
  const evidence = join(wt, `specs/${nr}/evidence`);
  return {
    revision,
    round,
    checkNumbers: specCheckNumbers(spec),
    missingScreenshots: specScreenshots(spec).filter((f) => !existsSync(join(evidence, f))),
    progressBrowser: parseProgress(progressText).browser?.kind,
    staleProgressLines: progressLines.filter((l) => {
      if (/^Browser: not (?:needed|available)\b/.test(l)) return false;
      const rev = l.match(/^(?:Check|Browser):.*\b([0-9a-f]{7,40})\s*$/)?.[1];
      return rev === undefined || !sameRevision(rev, revision);
    }),
  };
};

/** The reviewer's report for the latest start, when unchanged since the hook saved it. */
const loadReport = (wt, nr) => {
  const dir = reviewDir(wt);
  if (!dir) return { problems: ["No git directory found."] };
  const log = logOf(dir, nr);
  const s = log.findLastIndex((e) => e.kind === "start");
  if (s < 0) return { problems: [`No review started: run "start ${nr}" first.`] };
  const after = log.slice(s + 1);
  const r = after.findLastIndex((e) => e.kind === "report");
  const path = join(dir, `review-${nr}.md`);
  const text = readText(path);
  if (r < 0 || text === undefined)
    return {
      start: log[s],
      problems: [
        after.at(-1)?.kind === "no-report"
          ? `The ${REVIEWER} agent ended without a report starting with "Verdict:". Run it again and remind it that its final message is the review and nothing else.`
          : `No report from the ${REVIEWER} agent since this review started. Run it with the Agent tool, subagent_type "${REVIEWER}", and wait for it to finish.`,
      ],
    };
  if (after[r].sha !== sha256(text))
    return { start: log[s], problems: [`${path} was changed after the ${REVIEWER} agent reported: it no longer counts. Run the agent again.`] };
  return { start: log[s], report: text, problems: [] };
};

const worktreeOrStop = (root, nr) => {
  const wt = worktreePath(root, `dev/${nr}`);
  if (!existsSync(wt))
    stop(`The worktree .worktrees/dev/${nr} does not exist: there is nothing to review. Run /pipe:dev ${nr} first.`);
  const branch = gitOut(wt, "branch", "--show-current");
  if (branch !== `dev/${nr}`) stop(`.worktrees/dev/${nr} is on ${branch || "a detached HEAD"}, not dev/${nr}.`);
  return wt;
};

const start = async (nr) => {
  const { root, trunk, agents, check } = repoOrStop(process.cwd());
  const wt = worktreeOrStop(root, nr);
  const dirty = (gitOut(wt, "status", "--porcelain", "--untracked-files=no") ?? "").split("\n").filter(Boolean);
  if (dirty.length > 0)
    stop(`dev/${nr} has uncommitted changes (${dirty.join("; ")}): review only committed work. Commit or discard them first.`);
  const head = gitOut(wt, "rev-parse", "HEAD") ?? "";
  const revision = implementationRevision(wt, nr) ?? "";
  const round = reviewCommits(wt, "HEAD", nr) + 1;
  const dir = reviewDir(wt) ?? stop("No git directory found.");
  appendJsonl(join(dir, "log.jsonl"), { kind: "start", nr, head, revision, round });
  event(root, { ticket: nr, step: "review-dev", event: "start", outcome: `round ${round}` });
  const progress = readText(join(wt, `specs/${nr}/progress.md`))?.split("\n").slice(0, 3) ?? [];
  const evidence = join(wt, `specs/${nr}/evidence`);
  const shots = existsSync(evidence) ? readdirSync(evidence).filter((f) => f.endsWith(".png")) : [];
  const port = await freePort(4300);
  const app = appLines(agentsLine(agents, "Run"), agentsLine(agents, "URL"), port);
  console.log(`worktree: ${wt}`);
  console.log(`trunk: ${trunk}`);
  console.log(`revision: ${revision}`);
  console.log(`round: ${round}${round >= 3 ? ' (a review with any finding ends in "Verdict: human")' : ""}`);
  console.log(`started at: ${head}`);
  console.log(`progress.md: ${progress.length ? progress.join(" / ") : "(missing)"}`);
  console.log(`screenshots: ${shots.length ? shots.join(", ") : "(none)"}`);
  console.log(`diff: git diff ${trunk}...dev/${nr}   (everything)`);
  console.log(`check: ${check}`);
  console.log(`app: ${app.run ? `${app.run}  (then open ${app.url ?? "the URL it prints"})` : "(no Run line in AGENTS.md)"}`);
};

const findings = (nr) => {
  const { root } = repoOrStop(process.cwd());
  const wt = worktreeOrStop(root, nr);
  const loaded = loadReport(wt, nr);
  const problems = [...loaded.problems];
  if (loaded.report !== undefined) problems.push(...checkReview({ review: loaded.report, ...factsFor(wt, nr, loaded.start.round) }));
  if (problems.length > 0) {
    console.log(`findings: ${problems.length} problem(s)\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(loaded.report.trimEnd());
};

const record = (nr) => {
  const { root } = repoOrStop(process.cwd());
  const wt = worktreeOrStop(root, nr);
  const loaded = loadReport(wt, nr);
  if (loaded.report === undefined) {
    console.log(`record: ${loaded.problems.join(" ")}`);
    process.exit(1);
  }
  writeFileSync(join(wt, `specs/${nr}/review.md`), loaded.report);
  console.log(`record: specs/${nr}/review.md written from the reviewer's report`);
};

/** Everything verify checks, as a list of problems. */
const verifyProblems = (wt, nr) => {
  const problems = [];
  if (gitOut(wt, "branch", "--show-current") !== `dev/${nr}`) problems.push(`Run verify inside .worktrees/dev/${nr}, on dev/${nr}.`);
  const reviewPath = `specs/${nr}/review.md`;
  const loaded = loadReport(wt, nr);
  const startHead = loaded.start?.head;
  if (!startHead) problems.push(`No start recorded: run "start ${nr}" first.`);
  else {
    const touched = (gitOut(wt, "diff", "--name-only", startHead) ?? "").split("\n").filter(Boolean);
    const untracked = (gitOut(wt, "ls-files", "--others", "--exclude-standard") ?? "").split("\n").filter(Boolean);
    const committed = (gitOut(wt, "diff", "--name-only", startHead, "HEAD") ?? "").split("\n").filter(Boolean);
    for (const f of new Set([...touched, ...untracked, ...committed]))
      if (f !== reviewPath) problems.push(`${f} changed since the review started: only ${reviewPath} may change. Restore it.`);
  }
  const review = readText(join(wt, reviewPath));
  if (review === undefined) problems.push(`${reviewPath} does not exist.`);
  problems.push(...loaded.problems);
  if (review !== undefined && loaded.report !== undefined) {
    if (canon(review) !== canon(loaded.report))
      problems.push(`${reviewPath} is not the ${REVIEWER} agent's report word for word: run "record ${nr}" again.`);
    problems.push(...checkReview({ review, ...factsFor(wt, nr, loaded.start.round) }));
  }
  return problems;
};

const verify = (nr) => {
  const wt = gitOut(process.cwd(), "rev-parse", "--show-toplevel") ?? process.cwd();
  const reviewPath = `specs/${nr}/review.md`;
  const problems = verifyProblems(wt, nr);
  if (problems.length > 0) {
    console.log(`verify: ${problems.length} problem(s)\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  const dirty = (gitOut(wt, "status", "--porcelain", "--", reviewPath) ?? "") !== "";
  console.log(dirty ? "verify: ok (review.md not committed yet)" : `verify: ok (review.md committed at ${gitOut(wt, "log", "-1", "--format=%h", "--", reviewPath)})`);
};

/** The verdict on line 1 of a review: approve, rework or human. */
export const verdictOf = (review) => (review ?? "").match(/^Verdict: (approve|rework|human)\b/)?.[1];

/** On approve or human, pushes dev/{nr} and opens its pull request, once review.md is committed. */
const publishDev = (nr) => {
  const { root, trunk } = repoOrStop(process.cwd());
  const wt = worktreeOrStop(root, nr);
  const reviewPath = `specs/${nr}/review.md`;
  const problems = verifyProblems(wt, nr);
  if ((gitOut(wt, "status", "--porcelain", "--", reviewPath) ?? "") !== "") problems.push(`${reviewPath} is not committed yet.`);
  if (problems.length > 0) {
    console.log(`publish: nothing pushed, the review is not done:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  const review = readText(join(wt, reviewPath)) ?? "";
  const verdict = verdictOf(review);
  const revision = reviewRevision(review);
  if (verdict === "rework") {
    console.log(`publish: verdict rework: nothing pushed. Next: /pipe:dev ${nr} --address-findings.`);
    return;
  }
  const branch = `dev/${nr}`;
  const result = publish({
    wt,
    nr,
    step: "review-dev",
    branch,
    trunk,
    title: `Dev ${nr}: ${storyTitle(readText(join(wt, "specs/roadmap.md")), nr) ?? `story ${nr}`}`,
    body: [
      `Verdict: ${verdict} at ${revision}.`,
      `Review: ${fileLink(originOf(wt), branch, reviewPath)}${verdict === "human" ? ": it names what needs a person" : ""}.`,
      `Merging is the approval; then run /pipe:learn ${nr}.`,
    ].join(" "),
  });
  console.log(result.lines.join("\n"));
};

if (isMain(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const all = words(rest);
  const nr = all.length === 1 ? parseNr(all[0]) : undefined;
  if (!nr || !["start", "findings", "record", "verify", "publish"].includes(command)) {
    console.log("Usage: node review-dev.mjs start|findings|record|verify|publish {nr}, e.g. start 01.");
    process.exit(64);
  }
  if (command === "start") await start(nr);
  else if (command === "findings") findings(nr);
  else if (command === "record") record(nr);
  else if (command === "publish") publishDev(nr);
  else verify(nr);
}

