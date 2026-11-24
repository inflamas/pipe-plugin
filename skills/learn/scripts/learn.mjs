// The /pipe:learn skill's deterministic parts: the gate (dev/{nr} merged), the learn worktree, the
// merge commit M and the files of the run, the cleanup of merged worktrees, and the check of retro.md.
//
//   node learn.mjs start <nr>
//     Run first, from anywhere in the repository. Stops unless dev/{nr} is merged into the trunk
//     through a merge commit. Creates .worktrees/learn/{nr} on a new learn/{nr} from the trunk, or
//     reuses it (never recreates it). Records the HEAD it started from. Prints worktree, branch,
//     merge, log, files. Exit 0: go on. Exit 3: "STOP: ..." on stdout; relay it and end the run.
//   node learn.mjs cleanup <nr>
//     After the retro is written. Runs `git worktree remove` (never --force) on every worktree under
//     .worktrees/ whose branch is merged into the trunk, except learn/{nr} itself. Prints one line
//     per worktree: removed, or kept with the reason and the files that block it.
//   node learn.mjs verify <nr>
//     Run in the learn worktree before and after committing retro.md. Exit 0 "verify: ok ...",
//     exit 1 with the problems.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  appendJsonl,
  changedPaths,
  branchExists,
  ensureWorktree,
  event,
  git,
  gitOut,
  isMain,
  lines,
  mainRoot,
  parseNr,
  readJsonl,
  readText,
  repoOrStop,
  stateDir,
  stop,
  trunkOf,
  WORKTREES,
  words,
  worktreePath,
  worktrees,
} from "../../../lib/common.mjs";

export const SECTIONS = ["What happened", "Proposals", "Cleanup", "Noticed by me"];
export const NOT_ASKED = "Not asked: headless run";
export const NOT_MERGED = (nr) => `Merge dev/${nr} first, then run /pipe:learn ${nr}.`;

// ---------------------------------------------------------------- the merge commit

/**
 * M: the first commit on the trunk's first-parent line (oldest first) that contains the dev tip. It
 * must be a merge whose second parent contains the tip; a fast-forward has no M.
 */
export const findMerge = (firstParentOldestFirst, contains, parents) => {
  const m = firstParentOldestFirst.find(contains);
  if (!m) return { error: "not merged" };
  if (parents(m).length < 2) return { error: `${m.slice(0, 7)} is not a merge commit: dev was fast-forwarded into the trunk.` };
  return { merge: m };
};

// ---------------------------------------------------------------- cleanup

export const cleanupPlan = (f) =>
  f.worktrees
    .filter((w) => w.path.startsWith(`${f.under}/`) && w.path !== f.own)
    .map((w) => {
      const branch = w.branch ?? "(detached)";
      if (!w.branch) return { path: w.path, branch, action: "keep", why: "detached HEAD" };
      if (!f.merged(w.branch)) return { path: w.path, branch, action: "keep", why: "not merged into the trunk" };
      if (f.onMainLine(w.branch))
        return { path: w.path, branch, action: "keep", why: "nothing merged from it yet (no commit of its own)" };
      return { path: w.path, branch, action: "remove" };
    });

// ---------------------------------------------------------------- retro.md

export const sections = (text) => {
  const out = new Map();
  let name;
  let body = [];
  const flush = () => {
    if (name !== undefined) out.set(name, body.join("\n").trim());
  };
  for (const line of text.split("\n")) {
    const h = line.match(/^## (.+?)\s*$/);
    if (h) {
      flush();
      name = h[1];
      body = [];
    } else if (name !== undefined) body.push(line);
  }
  flush();
  return out;
};

/** The numbered items of a section, each with its continuation lines. */
export const items = (body) => {
  const out = [];
  for (const line of body.split("\n")) {
    if (/^\d+\. \S/.test(line)) out.push(line);
    else if (out.length > 0 && line.trim() !== "") out[out.length - 1] += `\n${line}`;
  }
  return out;
};

export const checkRetro = (f) => {
  if (f.retro === undefined) return [`specs/${f.nr}/retro.md does not exist.`];
  const problems = [];
  const all = f.retro.split("\n");
  if (!new RegExp(`^# Story ${f.nr} retro: \\S`).test(all[0] ?? ""))
    problems.push(`Line 1 is not "# Story ${f.nr} retro: {story title}".`);
  const intro = f.retro.split(/^## /m)[0] ?? "";
  if (!intro.includes(f.merge.slice(0, 7))) problems.push(`The intro does not name the merge commit ${f.merge.slice(0, 7)}.`);
  if (!/merged locally/i.test(intro) || !/not released/i.test(intro))
    problems.push('The intro does not state that the work is "merged locally" and "not released".');

  const s = sections(f.retro);
  const order = [...s.keys()].filter((k) => SECTIONS.includes(k));
  if (order.join("|") !== SECTIONS.join("|"))
    problems.push(`The sections must be, in this order: ${SECTIONS.map((x) => `"## ${x}"`).join(", ")}.`);
  if ([...s.keys()].at(-1) !== "Noticed by me") problems.push('"## Noticed by me" must be the last section.');

  const happened = (s.get("What happened") ?? "").split("\n").filter((l) => l.trim() !== "");
  if (happened.length < 1 || happened.length > 3) problems.push('"What happened" must have 1 to 3 lines.');

  const proposals = s.get("Proposals") ?? "";
  const list = items(proposals);
  if (list.length === 0 && !/^No reusable lesson\b/m.test(proposals))
    problems.push('"Proposals" has no numbered proposal and does not say "No reusable lesson".');
  list.forEach((p, i) => {
    if (!/^\d+\. \*\*[^*]+\*\*/.test(p)) problems.push(`Proposal ${i + 1} does not start with its step in bold.`);
    if (!/\bChange:/.test(p)) problems.push(`Proposal ${i + 1} has no "Change:".`);
    if (!/\bEvidence:/.test(p)) problems.push(`Proposal ${i + 1} has no "Evidence:".`);
  });

  if ((s.get("Cleanup") ?? "") === "") problems.push('"Cleanup" is empty: copy what `cleanup` printed.');
  if ((s.get("Noticed by me") ?? "") === "")
    problems.push(`"Noticed by me" is empty: the user's answer word for word, or "${NOT_ASKED}".`);
  return problems;
};

/** Only retro.md may change on learn/{nr}: nothing else is written, nothing is applied. */
export const checkScope = (nr, changed) =>
  changed
    .filter((p) => p !== `specs/${nr}/retro.md`)
    .map((p) => `${p} changed: /pipe:learn writes only specs/${nr}/retro.md and applies no change.`);

// ---------------------------------------------------------------- git and the file system

const mergeOf = (root, trunk, nr) => {
  const dev = `dev/${nr}`;
  if (!branchExists(root, dev) || !git(root, "merge-base", "--is-ancestor", dev, trunk).ok) return { error: NOT_MERGED(nr) };
  const found = findMerge(
    lines(gitOut(root, "rev-list", "--first-parent", "--reverse", trunk)),
    (c) => git(root, "merge-base", "--is-ancestor", dev, c).ok,
    (c) => lines(gitOut(root, "rev-list", "--parents", "-n", "1", c)?.split(" ").slice(1).join("\n")),
  );
  return "error" in found && found.error === "not merged" ? { error: NOT_MERGED(nr) } : found;
};

const logPath = (cwd) => join(stateDir(cwd) ?? ".", "learn", "log.jsonl");
const startHead = (cwd, nr) => readJsonl(logPath(cwd)).filter((e) => e.kind === "start" && e.nr === nr)[0]?.head;

const start = (nr) => {
  const { root, trunk } = repoOrStop(process.cwd());
  const found = mergeOf(root, trunk, nr);
  if ("error" in found) {
    event(root, { ticket: nr, step: "learn", event: "stop", outcome: found.error });
    stop(found.error);
  }
  const m = found.merge;
  const branch = `learn/${nr}`;
  const { wt, created } = ensureWorktree(root, trunk, branch);
  if (!startHead(wt, nr)) appendJsonl(logPath(wt), { kind: "start", nr, head: gitOut(wt, "rev-parse", "HEAD") });
  event(root, { ticket: nr, step: "learn", event: "start", outcome: m.slice(0, 7) });

  const short = m.slice(0, 7);
  const files = lines(gitOut(root, "ls-tree", "-r", "--name-only", trunk, `specs/${nr}/`));
  console.log(`worktree: ${wt}`);
  console.log(`branch: ${branch} ${created ? `(created from ${trunk})` : "(continued)"}`);
  console.log(`trunk: ${trunk}`);
  console.log(`merge: ${short} (${gitOut(root, "log", "-1", "--format=%s", m)})`);
  console.log(`log: git log ${short}^1..${short}^2`);
  console.log(`retro: specs/${nr}/retro.md ${existsSync(join(wt, `specs/${nr}/retro.md`)) ? "exists: continue it" : "not written yet"}`);
  console.log("files:");
  for (const f of files) console.log(`  ${f}`);
};

const cleanup = (nr) => {
  const root = mainRoot(process.cwd()) ?? stop("Not inside a git repository.");
  const trunk = trunkOf(root);
  const plan = cleanupPlan({
    worktrees: worktrees(root),
    own: worktreePath(root, `learn/${nr}`),
    under: join(root, WORKTREES),
    merged: (b) => git(root, "merge-base", "--is-ancestor", b, trunk).ok,
    onMainLine: (b) => {
      const tip = gitOut(root, "rev-parse", b);
      return tip !== undefined && lines(gitOut(root, "rev-list", "--first-parent", trunk)).includes(tip);
    },
  });
  if (plan.length === 0) console.log(`cleanup: no other worktree under ${WORKTREES}/`);
  for (const step of plan) {
    if (step.action === "keep") {
      console.log(`kept: ${step.path} (${step.branch}): ${step.why}`);
      continue;
    }
    const r = git(root, "worktree", "remove", step.path);
    if (r.ok) {
      console.log(`removed: ${step.path} (${step.branch}, merged into ${trunk})`);
      continue;
    }
    const blocking = lines(gitOut(step.path, "status", "--porcelain", "--untracked-files=all"));
    console.log(`kept: ${step.path} (${step.branch}, merged): git refused: ${r.out}`);
    for (const b of blocking) console.log(`  ${b}`);
  }
};

const verify = (nr) => {
  const wt = gitOut(process.cwd(), "rev-parse", "--show-toplevel") ?? process.cwd();
  const root = mainRoot(wt) ?? wt;
  const trunk = trunkOf(root);
  const problems = [];
  const branch = gitOut(wt, "branch", "--show-current");
  if (branch !== `learn/${nr}`) problems.push(`Run verify in the learn worktree: this is "${branch}", not learn/${nr}.`);
  const found = mergeOf(root, trunk, nr);
  if ("error" in found) problems.push(found.error);
  else problems.push(...checkRetro({ nr, retro: readText(join(wt, `specs/${nr}/retro.md`)), merge: found.merge }));

  const base = startHead(wt, nr);
  if (!base) problems.push(`No start record: run \`learn.mjs start ${nr}\` first.`);
  else {
    const changed = new Set([
      ...lines(gitOut(wt, "diff", "--name-only", base, "HEAD")),
      ...changedPaths(wt),
    ]);
    problems.push(...checkScope(nr, [...changed]));
  }
  if (problems.length > 0) {
    console.log(`verify: ${problems.length} problem(s)\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  const dirty = lines(gitOut(wt, "status", "--porcelain", "--", `specs/${nr}/retro.md`)).length > 0;
  console.log(
    dirty
      ? "verify: ok (retro.md not committed yet)"
      : `verify: ok (retro.md committed at ${gitOut(wt, "log", "-1", "--format=%h", "--", `specs/${nr}/retro.md`)})`,
  );
};

if (isMain(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const all = words(rest);
  const nr = all.length === 1 ? parseNr(all[0]) : undefined;
  if (!nr) stop("Give one story number, e.g. /pipe:learn 01.");
  else if (command === "start") start(nr);
  else if (command === "cleanup") cleanup(nr);
  else if (command === "verify") verify(nr);
  else {
    console.log("Usage: node learn.mjs start|cleanup|verify <nr>");
    process.exit(64);
  }
}
