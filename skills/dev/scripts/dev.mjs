// The /pipe:dev skill's deterministic parts: the approval gate, the worktree, the mode of the run, the
// implementation revision and the check before "State: ready for review".
//
//   node dev.mjs start <nr> [--address-findings]
//     Run first, from anywhere in the repository. Stops unless spec/{nr} is merged into the trunk and
//     the trunk holds specs/{nr}/spec.md. Creates .worktrees/dev/{nr} on dev/{nr} from an up-to-date
//     trunk when missing (then runs the Install line of AGENTS.md; never recreates either), and prints
//     the mode, the check, how to start the app and the next step. Exit 0: go on. Exit 3: "STOP: ...".
//   node dev.mjs revision <nr>
//     Prints the implementation revision, by the command in AGENTS.md's pipeline rules, as written.
//   node dev.mjs verify <nr>
//     Run in the dev worktree before committing "State: ready for review". Exit 0 "verify: ok",
//     exit 1 with the problems.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  agentsLine,
  branchExists,
  ensureWorktree,
  event,
  git,
  gitOut,
  installIn,
  isMain,
  parseNr,
  readText,
  repoOrStop,
  reviewRevision,
  sameRevision,
  show,
  stop,
  words,
} from "../../../lib/common.mjs";
import { appLines, freePort } from "../../../lib/ports.mjs";
import { hasScreen } from "../../spec/scripts/spec.mjs";

export const parseArgs = (argv) => {
  const all = words(argv);
  const numbers = all.filter((w) => !w.startsWith("--"));
  const flags = all.filter((w) => w.startsWith("--"));
  const usage = "Usage: /pipe:dev {nr} [--address-findings], e.g. /pipe:dev 01.";
  const nr = numbers.length === 1 ? parseNr(numbers[0]) : undefined;
  if (!nr) return { error: usage };
  const unknown = flags.filter((f) => f !== "--address-findings");
  if (unknown.length > 0) return { error: `Unknown option ${unknown.join(" ")}. ${usage}` };
  return { nr, addressFindings: flags.length > 0 };
};

// ---------------------------------------------------------------- progress.md, spec.md, review.md

export const NOT_NEEDED = "Browser: not needed, the spec has no screen";

/**
 * Line 1 the state, line 2 the check, line 3 the browser pass:
 *   "Browser: {k} of {n} checks seen, screenshots at {revision}"
 *   "Browser: not needed, the spec has no screen"
 *   "Browser: not available ({why})"
 */
export const parseProgress = (text) => {
  const [l1 = "", l2 = "", l3 = ""] = text.split("\n");
  const state = l1.match(/^State: (building|blocked|ready for review)\s*$/)?.[1];
  const check = l2.match(/^Check: green at ([0-9a-f]{4,40})\s*$/)?.[1];
  const seen = l3.match(/^Browser: (\d+) of (\d+) checks seen, screenshots at ([0-9a-f]{4,40})\s*$/);
  const unavailable = l3.match(/^Browser: not available \((.+)\)\s*$/);
  const browser = seen
    ? { kind: "seen", seen: Number(seen[1]), of: Number(seen[2]), revision: seen[3] }
    : unavailable
      ? { kind: "not available", why: unavailable[1] }
      : l3.trim() === NOT_NEEDED
        ? { kind: "not needed" }
        : undefined;
  return { state, check, browser };
};

/** The text of a "## {heading}" section, up to the next "## " heading; undefined when absent. */
export const sectionOf = (text, heading) => {
  const all = text.split("\n");
  const start = all.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return undefined;
  const rest = all.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
};

/** The user accepted the spec as it is: "Build as specified" under the proposed revision. */
export const buildAsSpecified = (progress) =>
  /build as specified/i.test(sectionOf(progress, "Proposed spec revision") ?? "");

/** The numbers of the spec's acceptance checks, in order: "1. **Label:** …". */
export const acceptanceChecks = (spec) => {
  const section = spec.split(/^## Acceptance checks\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  return [...section.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
};

/** The numbered findings of review.md, word for word, under a "## …Findings…" heading. */
export const reviewFindings = (review) => {
  const findings = [];
  let inFindings = false;
  let current;
  const flush = () => {
    if (current) findings.push(current.join("\n").trimEnd());
    current = undefined;
  };
  for (const line of review.split("\n")) {
    if (/^#{1,3} /.test(line)) {
      flush();
      inFindings = /findings/i.test(line);
      continue;
    }
    if (!inFindings) continue;
    if (/^\d+\. /.test(line)) {
      flush();
      current = [line];
    } else if (current && (/^\s+\S/.test(line) || line.trim() === "")) current.push(line);
    else flush();
  }
  flush();
  return findings;
};

// ---------------------------------------------------------------- the mode of a run

export const readyLine = (nr, revision) => `dev/${nr} is ready for review at ${revision}: run /pipe:review-dev ${nr}.`;

export const decideMode = (f) => {
  const { nr } = f;
  const trunk = f.trunk ?? "main";
  if (!f.specOnMain)
    return {
      stop: `${trunk} has no specs/${nr}/spec.md: there is no approved spec. Run /pipe:spec ${nr}, then approve it by merging spec/${nr} into ${trunk}.`,
    };
  const progress = f.progress === undefined ? undefined : parseProgress(f.progress);

  if (progress?.state === "blocked") {
    const text = f.progress ?? "";
    if ((f.specChangedAfterBlock && f.specMerged) || buildAsSpecified(text))
      return {
        mode: "resume",
        next: `Set line 1 of progress.md to "State: building" and commit it. Then build against specs/${nr}/spec.md as it is now${buildAsSpecified(text) ? ' (the user wrote "Build as specified": the proposal is declined)' : " (the revised spec)"}, as in mode build.`,
      };
    const proposal = sectionOf(text, "Proposed spec revision") ?? '(no "## Proposed spec revision" section)';
    return {
      stop: `dev/${nr} is blocked on a proposed spec revision:\n\n${proposal}\n\nTo revise: run /pipe:spec ${nr}, approve the revision by merging spec/${nr} into ${trunk}, merge ${trunk} into dev/${nr}, then run /pipe:dev ${nr}. To keep the spec: write "Build as specified" under the proposal in specs/${nr}/progress.md, then run /pipe:dev ${nr}.`,
    };
  }

  if (!f.specMerged)
    return {
      stop: `spec/${nr} is not merged into ${trunk}, so specs/${nr}/spec.md is not approved. Merge spec/${nr} into ${trunk} to approve it, then run /pipe:dev ${nr}.`,
    };

  if (f.progress !== undefined && progress?.state === undefined)
    return {
      stop: `Line 1 of specs/${nr}/progress.md is not "State: building", "State: blocked" or "State: ready for review": fix it, then run /pipe:dev ${nr}.`,
    };

  if (f.addressFindings) {
    if (progress?.state !== "ready for review" || f.revision === undefined)
      return { stop: `Nothing to address: dev/${nr} is not ready for review yet. Run /pipe:dev ${nr} to finish it first.` };
    const reviewed = f.review === undefined ? undefined : reviewRevision(f.review);
    const findings =
      f.review !== undefined && reviewed !== undefined && sameRevision(reviewed, f.revision) ? reviewFindings(f.review) : [];
    const reviewNote =
      f.review === undefined
        ? "There is no review.md."
        : reviewed === undefined || !sameRevision(reviewed, f.revision)
          ? `review.md covers revision ${reviewed ?? "(none named)"}, not ${f.revision}: its findings do not count.`
          : `review.md covers ${f.revision} and has ${findings.length} numbered finding(s).`;
    return {
      mode: "address-findings",
      findings,
      next: `${reviewNote} Ask the user for their own findings on ${f.revision} (in a headless run, where you cannot ask, take only review.md's). No finding at all: stop with "Nothing to address." Otherwise copy them word for word under "## Rework requested" in progress.md, headed with revision ${f.revision}, set "State: building" and commit; fix exactly those, then finish as in mode finish.`,
    };
  }

  if (progress === undefined)
    return {
      mode: "build",
      next: `Start specs/${nr}/progress.md with "State: building" and commit it. Then tests for the acceptance checks first, see them fail, then the code; commit after every green check.`,
    };
  if (progress.state === "building")
    return { mode: "build", next: "Continue from progress.md: the open acceptance checks, then the browser pass, then verify." };

  const rev = f.revision ?? "";
  const browserCurrent =
    progress.browser !== undefined && (progress.browser.kind !== "seen" || sameRevision(progress.browser.revision, rev));
  if (progress.check !== undefined && sameRevision(progress.check, rev) && browserCurrent)
    return { stop: readyLine(nr, rev) };
  return {
    mode: "finish",
    next: `progress.md is ready for review, but its Check and Browser lines do not name the implementation revision ${rev || "(none)"}: something changed after them. Run the check and the browser pass again, update lines 2 and 3, run verify, commit.`,
  };
};

// ---------------------------------------------------------------- verify: before "ready for review"

export const verifyReady = (f) => {
  if (f.progress === undefined) return ["There is no progress.md."];
  if (f.spec === undefined) return ["There is no spec.md."];
  const problems = [];
  const p = parseProgress(f.progress);
  const rev = f.revision ?? "";
  if (p.state !== "ready for review") problems.push('Line 1 is not "State: ready for review".');
  if (p.check === undefined) problems.push('Line 2 is not "Check: green at {revision}".');
  else if (!sameRevision(p.check, rev))
    problems.push(`Line 2 names ${p.check}, but the implementation revision is ${rev || "(none)"}.`);
  const screen = hasScreen(f.spec);
  if (p.browser === undefined)
    problems.push(
      `Line 3 is not "Browser: {n} of {n} checks seen, screenshots at {revision}", "${NOT_NEEDED}" or "Browser: not available ({why})".`,
    );
  else if (p.browser.kind === "not needed" && screen)
    problems.push('Line 3 says the browser is not needed, but the spec has a screen ("## On screen" is not "None.").');
  else if (p.browser.kind === "seen") {
    if (p.browser.seen !== p.browser.of || p.browser.of === 0)
      problems.push(`Line 3 says ${p.browser.seen} of ${p.browser.of} checks seen: all of them must be.`);
    if (!sameRevision(p.browser.revision, rev))
      problems.push(`Line 3 names ${p.browser.revision}, but the implementation revision is ${rev || "(none)"}.`);
    const shots = f.evidence.filter((e) => /-(390|1440)\.png$/.test(e));
    if (shots.length === 0) problems.push("specs/{nr}/evidence/ has no {screen}-390.png / -1440.png.");
    for (const s of shots) {
      const twin = s.endsWith("-390.png") ? s.replace(/-390\.png$/, "-1440.png") : s.replace(/-1440\.png$/, "-390.png");
      if (!f.evidence.includes(twin)) problems.push(`${s} has no ${twin}.`);
    }
  }
  for (const n of acceptanceChecks(f.spec)) {
    const row = f.progress.split("\n").find((l) => new RegExp(`^\\|\\s*${n}\\s*\\|`).test(l));
    if (!row) problems.push(`Acceptance check ${n} has no row in progress.md.`);
    else {
      const cells = row.split("|").map((c) => c.trim());
      const status = cells[3];
      const evidence = cells[4] ?? "";
      if (status !== "done" && !(status === "open" && p.browser?.kind === "not available"))
        problems.push(`Acceptance check ${n} is "${status}", not "done".`);
      if (evidence === "") problems.push(`Acceptance check ${n} has no evidence.`);
    }
  }
  return problems;
};

// ---------------------------------------------------------------- git and the file system

/** The implementation revision: the last commit on dev/{nr} outside progress, review, evidence. */
export const REVISION_PATHSPEC = [
  ".",
  ":!specs/*/progress.md",
  ":!specs/*/review.md",
  ":!specs/*/evidence",
  ":!.claude/skills",
];
export const implementationRevision = (cwd, nr) =>
  gitOut(cwd, "log", "-1", "--format=%h", `dev/${nr}`, "--", ...REVISION_PATHSPEC) || undefined;

/** Did spec.md change on dev/{nr} after the newest commit that set "State: blocked"? */
const specChangedAfterBlock = (wt, nr) => {
  const path = `specs/${nr}/progress.md`;
  const commits = (gitOut(wt, "log", "--format=%H", `dev/${nr}`, "--", path) ?? "").split("\n").filter(Boolean);
  let block;
  for (const c of commits) {
    if (parseProgress(show(wt, c, path) ?? "").state !== "blocked") break;
    block = c;
  }
  if (!block) return false;
  const after = gitOut(wt, "rev-list", "--count", `${block}..dev/${nr}`, "--", `specs/${nr}/spec.md`);
  return Number(after ?? "0") > 0;
};

const start = async (argv) => {
  const args = parseArgs(argv);
  if ("error" in args) stop(args.error);
  const { nr } = args;
  const { root, trunk, agents, check } = repoOrStop(process.cwd());
  const sPath = `specs/${nr}/spec.md`;
  const specOnMain = show(root, trunk, sPath) !== undefined;
  const specMerged = branchExists(root, `spec/${nr}`) && git(root, "merge-base", "--is-ancestor", `spec/${nr}`, trunk).ok;
  const branch = `dev/${nr}`;

  // The gate comes before any worktree: no approved spec, nothing is created.
  if (!branchExists(root, branch)) {
    const gate = decideMode({ nr, trunk, addressFindings: false, specOnMain, specMerged, progress: undefined });
    if ("stop" in gate) {
      event(root, { ticket: nr, step: "dev", event: "stop", outcome: gate.stop.slice(0, 200) });
      stop(gate.stop);
    }
    if (args.addressFindings) stop(`Nothing to address: dev/${nr} does not exist yet.`);
  }

  const { wt, created, fresh } = ensureWorktree(root, trunk, branch);
  const installed = fresh ? installIn(wt, agents) : "worktree reused: nothing installed";

  const mode = decideMode({
    nr,
    trunk,
    addressFindings: args.addressFindings,
    specOnMain,
    specMerged,
    progress: readText(join(wt, `specs/${nr}/progress.md`)),
    specChangedAfterBlock: specChangedAfterBlock(wt, nr),
    revision: implementationRevision(wt, nr),
    review: readText(join(wt, `specs/${nr}/review.md`)),
  });
  if ("stop" in mode) {
    event(root, { ticket: nr, step: "dev", event: "stop", outcome: mode.stop.slice(0, 200) });
    stop(mode.stop);
  }
  event(root, { ticket: nr, step: "dev", event: "start", outcome: mode.mode });
  const spec = readText(join(wt, sPath)) ?? "";
  const port = await freePort(4100);
  const app = appLines(agentsLine(agents, "Run"), agentsLine(agents, "URL"), port);
  console.log(`worktree: ${wt}`);
  console.log(`branch: ${branch}${created ? ` (created from ${trunk})` : ""}`);
  console.log(`install: ${installed}`);
  console.log(`mode: ${mode.mode}`);
  console.log(`revision: ${implementationRevision(wt, nr) ?? "(none yet)"}`);
  console.log(`check: ${check}`);
  console.log(`screen: ${hasScreen(spec) ? "yes: the browser pass is required" : `no: line 3 is "${NOT_NEEDED}"`}`);
  console.log(`app: ${app.run ? `${app.run}  (then open ${app.url ?? "the URL it prints"})` : "(no Run line in AGENTS.md)"}`);
  console.log(`next: ${mode.next}`);
  if (mode.findings !== undefined) {
    console.log("findings in review.md:");
    if (mode.findings.length === 0) console.log("(none)");
    for (const f of mode.findings) console.log(f);
  }
};

if (isMain(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "start") await start(rest);
  else if ("error" in args) stop(args.error);
  else if (command === "revision") {
    const rev = implementationRevision(process.cwd(), args.nr);
    if (!rev) stop(`dev/${args.nr} has no implementation revision yet.`);
    console.log(rev);
  } else if (command === "verify") {
    const root = gitOut(process.cwd(), "rev-parse", "--show-toplevel") ?? process.cwd();
    const dir = join(root, `specs/${args.nr}/evidence`);
    const problems = verifyReady({
      progress: readText(join(root, `specs/${args.nr}/progress.md`)),
      spec: readText(join(root, `specs/${args.nr}/spec.md`)),
      revision: implementationRevision(root, args.nr),
      evidence: existsSync(dir) ? readdirSync(dir) : [],
    });
    if (problems.length > 0) {
      console.log(`verify: ${problems.length} problem(s)\n- ${problems.join("\n- ")}`);
      process.exit(1);
    }
    console.log("verify: ok");
  } else {
    console.log("Usage: node dev.mjs start|revision|verify <nr> [--address-findings]");
    process.exit(64);
  }
}
