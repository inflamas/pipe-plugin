// The /pipe:review-spec skill's guard rails. The loop is enforced here, not only described in SKILL.md.
//
//   node review-spec.mjs start <nr>
//     Run first. Finds the spec worktree .worktrees/spec/{nr} on spec/{nr} (never creates it),
//     checks there is a committed draft to review, logs the start of the review of that spec
//     revision and prints the worktree, the revision and the story. Exit 0: go on. Exit 3:
//     "STOP: ..." on stdout; relay it and end the run.
//   node review-spec.mjs findings <nr>
//     Run in the worktree after the pipe:spec-reviewer agent finished. Prints its findings when the
//     agent's report (saved by the plugin's SubagentStop hook) is for the current revision, unchanged
//     and well formed, plus the items that go under "Needs you". Exit 1 with the problems otherwise.
//   node review-spec.mjs verify <nr>
//     The pre-commit gate for spec-review.md. Exit 0: the commit may go ahead. Exit 1: the problems.
//   node review-spec.mjs hook
//     The plugin's hook entry (hooks/hooks.json), active in every session. While a review of the
//     current revision is in progress in a spec worktree:
//       PreToolUse AskUserQuestion: blocked until the reviewer's findings are in; every question
//         needs exactly one option marked "(Recommended)".
//       PreToolUse Write/Edit/MultiEdit/NotebookEdit: inside the worktree only
//         specs/{nr}/spec-review.md may be written: never spec.md, brainstorm.md or code.
//       PreToolUse Bash running git commit: runs verify and blocks on any problem.
//     Always: the review state (<git common dir>/pipe/) can't be written by a file tool or a shell
//     command.
//
// Exit 2 from a hook blocks the call with the reason on stderr. The decisions are pure functions,
// tested in test/review-spec.test.mjs; git and the file system sit in the thin layer below.
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  appendJsonl,
  askOf,
  changedPaths,
  event,
  existingDir,
  git,
  gitOut,
  isMain,
  normalize,
  parseNr,
  readAsks,
  readJsonl,
  readStdin,
  readText,
  repoOrStop,
  reviewRevision,
  sameRevision,
  settledIn,
  sha256,
  show,
  stateDir,
  stop,
  storyIn,
  unquote,
  words,
  worktreePath,
  worktrees,
} from "../../../lib/common.mjs";

export const FINDINGS_LINE = (nr) => `Findings to address: run /pipe:spec ${nr} --address-findings.`;
export const REVIEWER = "pipe:spec-reviewer";

export const parseArgs = (argv) => {
  const all = words(argv);
  const usage = "Usage: /pipe:review-spec {nr}, e.g. /pipe:review-spec 01.";
  const nr = all.length === 1 ? parseNr(all[0]) : undefined;
  return nr ? { nr } : { error: usage };
};

// ---------------------------------------------------------------- start

export const decideStart = (f) => {
  const { nr } = f;
  const trunk = f.trunk ?? "main";
  if (!f.worktreeRegistered)
    return { stop: `There is no worktree .worktrees/spec/${nr}: nothing to review. Run /pipe:spec ${nr} first.` };
  if (f.branch !== `spec/${nr}`)
    return { stop: `.worktrees/spec/${nr} is on "${f.branch ?? ""}", not spec/${nr}: look at it before going on.` };
  if (!f.specExists || !f.revision)
    return { stop: `spec/${nr} holds no committed specs/${nr}/spec.md: nothing to review. Run /pipe:spec ${nr} first.` };
  if (!f.brainstormExists)
    return { stop: `spec/${nr} has a spec.md but no brainstorm.md: run /pipe:spec ${nr} first.` };
  if (f.draftDirty)
    return {
      stop: `specs/${nr}/spec.md or brainstorm.md has uncommitted changes: a review covers a committed revision. Finish the draft with /pipe:spec ${nr} first.`,
    };
  if (f.approved)
    return {
      stop: `spec/${nr} is merged into ${trunk}: specs/${nr}/spec.md is approved and is the implementation contract. Nothing to review.`,
    };
  const reviewed = f.committedReview ? reviewRevision(f.committedReview) : undefined;
  if (reviewed && sameRevision(reviewed, f.revision))
    return {
      stop: `specs/${nr}/spec-review.md already reviews revision ${f.revision}, the current one. The gate is yours: merge spec/${nr} to approve it, add "## Gate feedback" to reject it, or run /pipe:spec ${nr} --address-findings.`,
    };
  return { ok: true };
};

// ---------------------------------------------------------------- markdown helpers

/** Sections by "## " heading (outside fences): heading line → body. */
export const sections = (text) => {
  const out = new Map();
  let current;
  let body = [];
  let fenced = false;
  const flush = () => {
    if (current !== undefined) out.set(current, body.join("\n").trim());
  };
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    if (!fenced && /^## /.test(line)) {
      flush();
      current = line.trim();
      body = [];
    } else body.push(line);
  }
  flush();
  return out;
};

const subsections = (body) => sections(body.replace(/^### /gm, "## ").replace(/^#### /gm, "### "));

const tableRows = (body) =>
  body
    .split("\n")
    .filter((l) => l.trim().startsWith("|"))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim()),
    );

/** Text compared word for word: table padding and separator length (a formatter's work) ignored. */
export const canon = (text) =>
  normalize(
    text
      .split("\n")
      .map((l) =>
        l.trim().startsWith("|")
          ? l
              .trim()
              .replace(/^\||\|$/g, "")
              .split("|")
              .map((c) => (/^\s*:?-+:?\s*$/.test(c) ? "---" : c.trim()))
              .join(" | ")
          : l,
      )
      .join("\n"),
  );

const isSeparator = (row) => row.every((c) => /^:?-+:?$/.test(c));
const plain = (cell) => cell.replace(/[*_`]/g, "").trim();
const bullets = (body) => body.split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l));
const LINE_REF = /\bl\.\s?\d+|\blines?\s+\d+|\bchecks?\s+\d+/i;

// ---------------------------------------------------------------- the reviewer's findings

export const FORM_CHECKS = [
  "Every acceptance check can be verified by a test or a person",
  "One small change, and what stays out is written down",
  "Nothing contradicts AGENTS.md or specs/guidelines/",
  "Says what to build, not how",
];

export const parseFindings = (text) => {
  const s = sections(text);
  const form = tableRows(s.get("## Form") ?? "")
    .slice(1)
    .filter((r) => !isSeparator(r))
    .map((r) => ({ check: plain(r[0] ?? ""), verdict: plain(r[1] ?? ""), restsOn: r[2] ?? "" }));
  const rows = tableRows(s.get("## Domain precheck") ?? "");
  const header = (rows[0] ?? []).map((c) => plain(c).toLowerCase());
  const col = (name) => header.indexOf(name);
  const rules = rows
    .slice(1)
    .filter((r) => !isSeparator(r))
    .map((r) => ({
      rule: plain(r[col("rule in the spec")] ?? ""),
      verdict: plain(r[col("verdict")] ?? ""),
      source: plain(r[col("source")] ?? ""),
      recommendation: plain(r[col("recommendation")] ?? ""),
    }));
  const raw = {};
  for (const [key, h] of [
    ["form", "## Form"],
    ["precheck", "## Domain precheck"],
    ["missing", "## Missing checks"],
  ])
    if (s.get(h) !== undefined) raw[key] = s.get(h);
  return {
    revision: text.split("\n")[0]?.match(/^Revision:\s*`?([0-9a-f]{4,40})`?\s*$/)?.[1],
    form,
    rules,
    missing: bullets(s.get("## Missing checks") ?? ""),
    raw,
  };
};

const EMPTY = /^(?:—|-|–|none\.?|n\/a)?$/i;

export const verifyFindings = (text, revision) => {
  const problems = [];
  const f = parseFindings(text);
  if (!f.revision) problems.push('findings: line 1 must be "Revision: <the spec revision>".');
  else if (!sameRevision(f.revision, revision))
    problems.push(`findings: they review revision ${f.revision}, but the current spec revision is ${revision}.`);
  for (const [key, h] of [
    ["form", "## Form"],
    ["precheck", "## Domain precheck"],
    ["missing", "## Missing checks"],
  ])
    if (f.raw[key] === undefined) problems.push(`findings: missing section "${h}".`);
  if (f.form.length !== FORM_CHECKS.length)
    problems.push(
      `findings, Form: ${f.form.length} row(s); there must be exactly the ${FORM_CHECKS.length} form checks, in order.`,
    );
  f.form.forEach((r, i) => {
    const expected = FORM_CHECKS[i];
    if (expected && normalize(r.check) !== normalize(expected))
      problems.push(`findings, Form row ${i + 1}: the check must read "${expected}".`);
    if (r.verdict !== "Met" && r.verdict !== "Not met")
      problems.push(`findings, Form row ${i + 1}: the verdict must be "Met" or "Not met", not "${r.verdict}".`);
    if (!LINE_REF.test(r.restsOn))
      problems.push(`findings, Form row ${i + 1}: name the spec line it rests on ("l.81", "line 81" or "check 20").`);
  });
  if (f.rules.length === 0)
    problems.push(
      'findings: the "## Domain precheck" table has no rules, or lacks the columns "Rule in the spec", "Verdict", "Source", "Recommendation".',
    );
  f.rules.forEach((r, i) => {
    const where = `findings, Domain precheck row ${i + 1}`;
    if (!["Traced", "Guessed", "Conflicts"].includes(r.verdict))
      problems.push(`${where}: the verdict must be "Traced", "Guessed" or "Conflicts", not "${r.verdict}".`);
    if (r.verdict !== "Guessed" && EMPTY.test(r.source))
      problems.push(`${where}: name the source it ${r.verdict === "Conflicts" ? "contradicts" : "rests on"}.`);
    if (r.verdict !== "Traced" && EMPTY.test(r.recommendation))
      problems.push(`${where}: a ${r.verdict.toLowerCase()} rule needs a recommendation.`);
  });
  const missingBody = f.raw.missing?.trim() ?? "";
  if (f.missing.length === 0 && missingBody !== "None.")
    problems.push('findings, Missing checks: one bullet per missing acceptance check, or exactly "None.".');
  for (const m of f.missing)
    if (!/Recommendation:/.test(m))
      problems.push(`findings, Missing checks: "${m.trim().slice(0, 50)}…" needs a "Recommendation:".`);
  return problems;
};

/** What must go under "Needs you", and what must be asked. */
export const itemsOf = (f) => {
  const notMet = f.form.filter((r) => r.verdict === "Not met");
  const domain = [
    ...f.rules.filter((r) => r.verdict === "Guessed").map((r) => `Guess: ${r.rule}`),
    ...f.rules.filter((r) => r.verdict === "Conflicts").map((r) => `Conflict: ${r.rule}`),
    ...f.missing.map((m) => `Missing check: ${m.replace(/^\s*[-*]\s+/, "")}`),
  ];
  return { form: notMet.map((r) => `Form not met: ${r.check}`), domain };
};

// ---------------------------------------------------------------- spec-review.md

export const parseQuestions = (body) => {
  const out = [];
  for (const line of body.split("\n")) {
    const q = line.match(/^### Q\d+\.\s+(.*)$/);
    if (q) {
      out.push({ question: q[1] ?? "", recommendation: undefined, answer: undefined });
      continue;
    }
    const cur = out.at(-1);
    if (!cur) continue;
    const rec = line.match(/^Recommendation:\s*(.*)$/);
    if (rec) cur.recommendation = rec[1];
    const ans = line.match(/^Answer:\s*(.*)$/);
    if (ans) cur.answer = unquote(ans[1] ?? "");
  }
  return out;
};

export const REVIEW_SECTIONS = [
  "## Summary",
  "## Form",
  "## Domain precheck",
  "## Missing checks",
  "## Questions and answers",
];

export const verifyReview = ({ nr, revision, review, findings, asks }) => {
  const problems = [];
  const first = review.split("\n")[0] ?? "";
  const named = first.match(/^Revision:\s*([0-9a-f]{4,40})\s*$/)?.[1];
  if (!named) problems.push('spec-review.md: line 1 must be "Revision: <hash>", the last commit of spec.md.');
  else if (!sameRevision(named, revision))
    problems.push(
      `spec-review.md: line 1 names revision ${named}, but the last commit of specs/${nr}/spec.md is ${revision}.`,
    );

  const s = sections(review);
  let at = -1;
  const order = [...s.keys()];
  for (const h of REVIEW_SECTIONS) {
    const i = order.indexOf(h);
    if (i < 0) problems.push(`spec-review.md: missing section "${h}".`);
    else if (i < at) problems.push(`spec-review.md: "${h}" is out of order: ${REVIEW_SECTIONS.join(", ")}.`);
    else at = i;
  }

  const summary = subsections(s.get("## Summary") ?? "");
  const changes = (summary.get("## What changes") ?? "").split("\n").filter((l) => l.trim() !== "");
  if (changes.length === 0 || changes.length > 3)
    problems.push('spec-review.md, "### What changes": one to three lines.');
  if (!(summary.get("## Picture") ?? "").includes("```"))
    problems.push('spec-review.md, "### Picture": a plain-character diagram in a code block.');
  const needs = summary.get("## Needs you");
  if (needs === undefined) problems.push('spec-review.md: missing "### Needs you" under "## Summary".');

  // Form, Domain precheck and Missing checks are the reviewer's, word for word.
  const f = parseFindings(findings);
  for (const [h, theirs] of [
    ["## Form", f.raw.form],
    ["## Domain precheck", f.raw.precheck],
    ["## Missing checks", f.raw.missing],
  ])
    if (theirs !== undefined && canon(s.get(h) ?? "") !== canon(theirs))
      problems.push(`spec-review.md, "${h}": must be the reviewer's findings word for word; it was changed.`);

  const items = itemsOf(f);
  const expected = items.form.length + items.domain.length;
  if (needs !== undefined) {
    const list = bullets(needs);
    if (expected === 0 && normalize(needs) !== "Nothing")
      problems.push('spec-review.md, "### Needs you": nothing needs the user, so it reads exactly "Nothing".');
    if (expected > 0 && list.length !== expected)
      problems.push(
        `spec-review.md, "### Needs you": ${list.length} line(s), but the findings hold ${expected} item(s): ${[...items.form, ...items.domain].join("; ")}. One line each.`,
      );
  }

  const questions = parseQuestions(s.get("## Questions and answers") ?? "");
  if (questions.length < items.domain.length)
    problems.push(
      `spec-review.md, "## Questions and answers": ${questions.length} question(s) for ${items.domain.length} domain item(s). Ask every guess, conflict and missing check with AskUserQuestion and record each.`,
    );
  if (items.domain.length === 0 && questions.length === 0 && normalize(s.get("## Questions and answers") ?? "") !== "None.")
    problems.push('spec-review.md, "## Questions and answers": write "None." when nothing was asked.');
  for (const q of questions) {
    const where = `spec-review.md, question "${q.question.slice(0, 60)}"`;
    if (!q.recommendation) problems.push(`${where}: no "Recommendation:" line.`);
    if (!q.answer) problems.push(`${where}: no "Answer:" line with the user's answer.`);
    const key = normalize(q.question);
    const asked = asks.find((a) => a.answers.has(key) || a.questions.includes(key));
    if (!asked)
      problems.push(`${where}: never asked with AskUserQuestion during this review. Ask it; never answer for the user.`);
    else if (q.answer !== undefined && asked.answers.get(key) !== normalize(q.answer))
      problems.push(
        `${where}: the answer "${q.answer}" is not the user's answer word for word${asked.answers.has(key) ? ` ("${asked.answers.get(key)}")` : ""}.`,
      );
  }

  const last = review.trimEnd().split("\n").at(-1)?.trim() ?? "";
  const line = FINDINGS_LINE(nr);
  const needsChange = items.form.length > 0 || f.missing.length > 0;
  if (needsChange && last !== line)
    problems.push(`spec-review.md: a form check is not met or a check is missing, so the last line must be exactly: ${line}`);
  if (review.includes(line) && last !== line) problems.push(`spec-review.md: "${line}" must be the last line.`);
  for (const l of review.split("\n"))
    if (/^\s*(?:[-*]\s*)?\**(?:status|verdict|approved|rejected|approval)\b/i.test(l))
      problems.push(`spec-review.md: "${l.trim()}" reads as a verdict. Never approve or reject a spec: the gate is the user's.`);
  return problems;
};

export const verifyChangedPaths = (nr, paths) => {
  const mine = `specs/${nr}/spec-review.md`;
  const other = paths.filter((p) => p !== mine);
  const problems = [];
  if (other.length > 0)
    problems.push(
      `A review commits only ${mine}; also changed: ${other.join(", ")}. Never change spec.md, brainstorm.md or code: revert those.`,
    );
  if (!paths.includes(mine)) problems.push(`${mine} has no changes to commit.`);
  return problems;
};

/** The questions of one AskUserQuestion call: each needs exactly one "(Recommended)" option. */
export const decideAskInput = (toolInput) => {
  const qs = toolInput?.questions;
  if (!Array.isArray(qs)) return undefined;
  for (const q of qs) {
    const labels = Array.isArray(q?.options) ? q.options.map((o) => String(o?.label ?? "")) : [];
    if (labels.filter((l) => /\(Recommended\)\s*$/.test(l)).length !== 1)
      return `"${String(q?.question).slice(0, 60)}": mark exactly one option, your recommendation, with "(Recommended)" at the end of its label, and put it first.`;
  }
  return undefined;
};

// ---------------------------------------------------------------- git and the file system

const reviewDir = (cwd) => {
  const s = stateDir(cwd);
  return s ? join(s, "review-spec") : undefined;
};
const logOf = (dir, nr) => readJsonl(join(dir, "log.jsonl")).filter((e) => e.nr === nr);
const revisionOf = (root, nr) => gitOut(root, "log", "-1", "--format=%h", "--", `specs/${nr}/spec.md`) || undefined;

/** The spec worktree holding `dir` and its story number, when it is on spec/{nr}. */
const specWorktree = (dir) => {
  const root = gitOut(existingDir(dir), "rev-parse", "--show-toplevel");
  const nr = root ? gitOut(root, "branch", "--show-current")?.match(/^spec\/(\d+)$/)?.[1] : undefined;
  return root && nr ? { root, nr } : undefined;
};

/** A review of the current revision was started and spec-review.md at HEAD does not cover it yet. */
const inProgress = (root, nr) => {
  const dir = reviewDir(root);
  const revision = revisionOf(root, nr);
  if (!dir || !revision) return false;
  const started = logOf(dir, nr).some((e) => e.kind === "start" && sameRevision(e.revision, revision));
  const committed = show(root, "HEAD", `specs/${nr}/spec-review.md`);
  const covered = committed ? reviewRevision(committed) : undefined;
  return started && !(covered && sameRevision(covered, revision));
};

/** The reviewer's findings, when its last report is unchanged; with what was asked since. */
const loadFindings = (root, nr) => {
  const dir = reviewDir(root);
  const revision = revisionOf(root, nr);
  if (!dir || !revision) return { asks: [], problems: [`No committed specs/${nr}/spec.md here.`] };
  const path = join(dir, `findings-${nr}.md`);
  const text = readText(path);
  const log = logOf(dir, nr);
  const i = log.findLastIndex((e) => e.kind === "report");
  const since = i < 0 ? "" : log[i].at;
  const asks = readAsks(root)
    .filter((e) => e.branch === `spec/${nr}` && e.at > since)
    .map(askOf);
  const noReport = log.at(-1)?.kind === "no-report";
  if (text === undefined || i < 0 || noReport)
    return {
      asks,
      problems: [
        noReport
          ? `The ${REVIEWER} agent ended without a report starting with "Revision:". Run it again and remind it that its final message is the findings and nothing else.`
          : `No findings from the ${REVIEWER} agent yet. Run it with the Agent tool, subagent_type "${REVIEWER}", and wait for it to finish.`,
      ],
    };
  if (log[i].sha !== sha256(text))
    return { asks, problems: [`${path} was changed after the ${REVIEWER} agent reported: it no longer counts. Run the agent again.`] };
  return { findings: text, asks, problems: verifyFindings(text, revision) };
};

const verifyIn = (root, nr) => {
  const branch = gitOut(root, "branch", "--show-current") ?? "";
  if (branch !== `spec/${nr}`) return [`verify runs on spec/${nr}, but this worktree is on "${branch}".`];
  const problems = verifyChangedPaths(nr, changedPaths(root));
  const revision = revisionOf(root, nr);
  if (!revision) return [...problems, `spec/${nr} has no committed spec.md.`];
  const review = readText(join(root, `specs/${nr}/spec-review.md`));
  if (review === undefined) return [...problems, `specs/${nr}/spec-review.md does not exist.`];
  const loaded = loadFindings(root, nr);
  if (loaded.findings === undefined || loaded.problems.length > 0) return [...problems, ...loaded.problems];
  return [...problems, ...verifyReview({ nr, revision, review, findings: loaded.findings, asks: loaded.asks })];
};

const start = (argv) => {
  const args = parseArgs(argv);
  if ("error" in args) stop(args.error);
  const { nr } = args;
  const { root, trunk } = repoOrStop(process.cwd());
  const wt = worktreePath(root, `spec/${nr}`);
  const registered = worktrees(root).some((w) => w.path === wt) && existsSync(wt);
  const branch = registered ? gitOut(wt, "branch", "--show-current") : undefined;
  const sPath = `specs/${nr}/spec.md`;
  const bPath = `specs/${nr}/brainstorm.md`;
  const revision = registered ? revisionOf(wt, nr) : undefined;
  const dirty = registered ? (gitOut(wt, "status", "--porcelain", "--", sPath, bPath) ?? "") !== "" : false;
  const onTrunk = show(root, trunk, sPath);
  const merged = registered && git(wt, "merge-base", "--is-ancestor", `spec/${nr}`, trunk).ok;
  const decision = decideStart({
    nr,
    trunk,
    worktreeRegistered: registered,
    branch,
    specExists: registered && existsSync(join(wt, sPath)),
    brainstormExists: registered && existsSync(join(wt, bPath)),
    draftDirty: dirty,
    revision,
    approved: merged && onTrunk !== undefined && onTrunk === show(wt, "HEAD", sPath),
    committedReview: registered ? show(wt, "HEAD", `specs/${nr}/spec-review.md`) : undefined,
  });
  if ("stop" in decision) {
    event(root, { ticket: nr, step: "review-spec", event: "stop", outcome: decision.stop.slice(0, 200) });
    stop(decision.stop);
  }
  const dir = reviewDir(wt) ?? stop("No git directory found.");
  appendJsonl(join(dir, "log.jsonl"), { kind: "start", nr, revision: revision ?? "" });
  event(root, { ticket: nr, step: "review-spec", event: "start", outcome: revision });
  const roadmap = readText(join(wt, "specs/roadmap.md")) ?? "";
  console.log(`worktree: ${wt}`);
  console.log(`branch: spec/${nr}`);
  console.log(`revision: ${revision}`);
  console.log(
    `next: cd into the worktree; start the ${REVIEWER} agent (Agent tool, subagent_type "${REVIEWER}") with the prompt from SKILL.md and wait for it to finish; then run: node review-spec.mjs findings ${nr}`,
  );
  console.log(`\n${storyIn(roadmap, nr) ?? `(specs/roadmap.md has no story ${nr})`}\n\n${settledIn(roadmap) ?? ""}`);
};

const findings = (argv) => {
  const args = parseArgs(argv);
  if ("error" in args) stop(args.error);
  const root = gitOut(process.cwd(), "rev-parse", "--show-toplevel") ?? process.cwd();
  const loaded = loadFindings(root, args.nr);
  if (loaded.findings === undefined || loaded.problems.length > 0) {
    console.log(`findings: ${loaded.problems.length} problem(s)\n- ${loaded.problems.join("\n- ")}`);
    process.exit(1);
  }
  const items = itemsOf(parseFindings(loaded.findings));
  console.log(loaded.findings.trimEnd());
  console.log("\n---\nNeeds you (one line each, in the chat and in spec-review.md):");
  const all = [...items.form, ...items.domain];
  console.log(all.length === 0 ? "Nothing" : all.map((l) => `- ${l}`).join("\n"));
  console.log(`\nAsk with AskUserQuestion (${items.domain.length}):`);
  console.log(items.domain.length === 0 ? "none" : items.domain.map((l) => `- ${l}`).join("\n"));
};

// ---------------------------------------------------------------- hooks

const blockWith = (reason) => {
  process.stderr.write(`Blocked by /pipe:review-spec: ${reason}\n`);
  process.exit(2);
};

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const STATE_FILE = /(?:^|\/)pipe\/(?:asks\.jsonl|events\.jsonl|review-(?:spec|dev)\/)/;
const MUTATOR = /(?<![=\->])\d*>>?(?![&>])|\btee\b|\bsed\s[^;&|\n]*-[a-zA-Z]*i\b|\b(?:rm|mv|cp|truncate)\s/;

export const decideFileWrite = (path, worktree, reviewing) => {
  if (STATE_FILE.test(path)) return "the pipeline's state is written only by its hooks and scripts.";
  if (!worktree || !reviewing) return undefined;
  const allowed = join(worktree.root, `specs/${worktree.nr}/spec-review.md`);
  if (path.startsWith(`${worktree.root}/`) && path !== allowed)
    return `during the review of spec ${worktree.nr} only specs/${worktree.nr}/spec-review.md may be written in this worktree, not ${path.slice(worktree.root.length + 1)}. Never change spec.md, brainstorm.md or code.`;
  return undefined;
};

const hook = async () => {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  if (input.hook_event_name !== "PreToolUse") return;
  const tool = input.tool_name ?? "";
  const cwd = input.cwd ?? process.cwd();

  if (tool === "AskUserQuestion") {
    const wt = specWorktree(cwd);
    if (!wt || !inProgress(wt.root, wt.nr)) return;
    const loaded = loadFindings(wt.root, wt.nr);
    if (loaded.problems.length > 0)
      blockWith(`ask only after the ${REVIEWER} agent's findings are in. ${loaded.problems.join(" ")}`);
    const reason = decideAskInput(input.tool_input);
    if (reason) blockWith(reason);
    return;
  }

  if (FILE_TOOLS.has(tool)) {
    const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (!raw) return;
    const path = isAbsolute(raw) ? raw : resolve(cwd, raw);
    const wt = specWorktree(dirname(path));
    const reason = decideFileWrite(path, wt, wt ? inProgress(wt.root, wt.nr) : false);
    if (reason) blockWith(reason);
    return;
  }

  if (tool === "Bash") {
    const command = input.tool_input?.command ?? "";
    if (STATE_FILE.test(command) && MUTATOR.test(command))
      blockWith("the pipeline's state is written only by its hooks and scripts.");
    if (!/\bgit\b[^;&|\n]*\scommit\b/.test(command)) return;
    const dirFlag = command
      .match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)[^;&|\n]*\scommit\b/)?.[1]
      ?.replace(/^["']|["']$/g, "");
    const cdDir = command.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/)?.[1]?.replace(/^["']|["']$/g, "");
    const wt = specWorktree(dirFlag ? resolve(cwd, dirFlag) : cdDir ? resolve(cwd, cdDir) : cwd);
    if (!wt) return;
    const touchesReview = changedPaths(wt.root).includes(`specs/${wt.nr}/spec-review.md`);
    if (!touchesReview && !inProgress(wt.root, wt.nr)) return;
    const problems = verifyIn(wt.root, wt.nr);
    if (problems.length > 0) blockWith(`the commit on spec/${wt.nr} fails verify:\n- ${problems.join("\n- ")}`);
  }
};

if (isMain(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "start") start(rest);
  else if (command === "findings") findings(rest);
  else if (command === "verify") {
    const args = parseArgs(rest);
    if ("error" in args) stop(args.error);
    const root = gitOut(process.cwd(), "rev-parse", "--show-toplevel") ?? process.cwd();
    const problems = verifyIn(root, args.nr);
    if (problems.length > 0) {
      console.log(`verify: ${problems.length} problem(s)\n- ${problems.join("\n- ")}`);
      process.exit(1);
    }
    console.log("verify: ok");
  } else if (command === "hook") {
    try {
      await hook();
    } catch (error) {
      process.stderr.write(`/pipe:review-spec hook error: ${String(error)}\n`);
    }
    process.exit(0);
  } else {
    console.log("Usage: node review-spec.mjs start <nr> | findings <nr> | verify <nr> | hook");
    process.exit(64);
  }
}
