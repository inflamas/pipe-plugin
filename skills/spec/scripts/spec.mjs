// The /pipe:spec skill's guard rails. The skill's loop is enforced here, not only described in SKILL.md.
//
//   node spec.mjs start <nr> [--address-findings]
//     Run first, from anywhere in the repository. Validates the story, creates the spec worktree
//     .worktrees/spec/{nr} and its branch when missing (never recreates them), and prints the mode
//     the run is in and the next step. Exit 0: go on. Exit 3: "STOP: ..." on stdout; relay it.
//   node spec.mjs verify <nr>
//     The pre-commit gate, run in the spec worktree. Exit 0: the commit may go ahead. Exit 1: the
//     problems on stdout.
//   node spec.mjs hook
//     The plugin's hook entry (hooks/hooks.json), active in every session. Reads the hook input:
//       PreToolUse AskUserQuestion: in a spec worktree during the brainstorm, blocks a round while
//         the previous one is not recorded in brainstorm.md, and blocks a third round.
//       PreToolUse Write/Edit/MultiEdit: brainstorm.md is append-only; spec.md keeps its
//         "## Gate feedback" section, last and only ever growing.
//       PreToolUse Bash running git commit on a spec/ branch: runs verify, blocks on any problem.
//     Exit 2 blocks with the reason on stderr. Outside a spec/ branch every hook lets the call through.
//     The questions and answers themselves are logged by hooks/asks.mjs.
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  askStrings,
  changedPaths,
  ensureWorktree,
  event,
  existingDir,
  git,
  gitOut,
  isMain,
  normalize,
  parseNr,
  readAsks,
  readStdin,
  readText,
  repoOrStop,
  reviewRevision,
  show,
  stop,
  storyIn,
  unquote,
  words,
} from "../../../lib/common.mjs";

// ---------------------------------------------------------------- arguments

export const parseArgs = (argv) => {
  const all = words(argv);
  const numbers = all.filter((w) => !w.startsWith("--"));
  const flags = all.filter((w) => w.startsWith("--"));
  const usage = "Usage: /pipe:spec {nr} [--address-findings], e.g. /pipe:spec 01.";
  const nr = numbers.length === 1 ? parseNr(numbers[0]) : undefined;
  if (!nr) return { error: usage };
  const unknown = flags.filter((f) => f !== "--address-findings");
  if (unknown.length > 0) return { error: `Unknown option ${unknown.join(" ")}. ${usage}` };
  return { nr, addressFindings: flags.length > 0 };
};

// ---------------------------------------------------------------- text helpers

/** Lines outside fenced code blocks, with their index. */
const proseLines = (text) => {
  const out = [];
  let fenced = false;
  text.split("\n").forEach((line, i) => {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    else if (!fenced) out.push([i, line]);
  });
  return out;
};

// ---------------------------------------------------------------- brainstorm.md (and every Q&A record)

export const parseBrainstorm = (text) => {
  const rounds = [];
  const questions = [];
  for (const [, line] of proseLines(text)) {
    const round = line.match(/^## Round (\d+)(?::[^\n]*)?\s*$/);
    if (round) {
      rounds.push(Number(round[1]));
      continue;
    }
    const q = line.match(/^### Q\d+\.\s+(.*)$/);
    if (q) {
      questions.push({
        round: rounds.at(-1) ?? 0,
        question: q[1] ?? "",
        hasOptions: false,
        recommendation: undefined,
        answer: undefined,
      });
      continue;
    }
    const current = questions.at(-1);
    if (!current) continue;
    if (/^Options:\s*$/.test(line)) current.hasOptions = true;
    const rec = line.match(/^Recommendation:\s*(.*)$/);
    if (rec) current.recommendation = rec[1];
    const ans = line.match(/^Answer:\s*(.*)$/);
    if (ans) current.answer = unquote(ans[1] ?? "");
  }
  return { rounds, questions };
};

const inEntry = (strings, text) => {
  const t = normalize(text);
  return t !== "" && strings.some((s) => normalize(s).includes(t));
};

/** The questions of a logged call. */
export const loggedQuestions = (toolInput) => {
  const qs = toolInput?.questions;
  if (!Array.isArray(qs)) return [];
  return qs.map((q) => q?.question).filter((q) => typeof q === "string");
};

/**
 * Checks a Q&A record against the AskUserQuestion log: append-only, rounds numbered 1, 2, ..., at
 * most `maxRounds`, every question with options, a recommendation and an answer, and every new round
 * word for word from one logged call. `name` is the file's name in messages. `log` holds the logged
 * calls as lists of strings.
 */
export const verifyRecord = (name, head, current, log, maxRounds) => {
  const problems = [];
  if (head !== undefined && !current.startsWith(head))
    problems.push(
      `${name} is append-only: text that is already committed was changed or removed. Restore it and only append.`,
    );
  const { rounds, questions } = parseBrainstorm(current);
  if (rounds.length === 0) problems.push(`${name} has no "## Round 1".`);
  rounds.forEach((r, i) => {
    if (r !== i + 1) problems.push(`${name}: round headings must be 1, 2, ...: found Round ${r}.`);
  });
  if (maxRounds !== undefined && rounds.length > maxRounds)
    problems.push(`${name} has more than ${maxRounds} rounds: the limit is ${maxRounds}.`);
  for (const q of questions) {
    const where = `${name}, round ${q.round}, "${q.question}"`;
    if (!q.hasOptions) problems.push(`${where}: no "Options:" list.`);
    if (!q.recommendation) problems.push(`${where}: no "Recommendation:" line.`);
    if (!q.answer) problems.push(`${where}: no "Answer:" line with the answer.`);
  }
  // Every question added since HEAD must come, with its answer word for word, from one logged call
  // per round: one AskUserQuestion per round, and nothing invented or paraphrased.
  const before = head === undefined ? 0 : parseBrainstorm(head).questions.length;
  const added = questions.slice(before);
  const byRound = new Map();
  for (const q of added) byRound.set(q.round, [...(byRound.get(q.round) ?? []), q]);
  for (const [round, qs] of byRound) {
    const fits = (e) =>
      qs.every((q) => inEntry(e, q.question) && q.answer !== undefined && inEntry(e, q.answer));
    if (log.some(fits)) continue;
    const missing = qs.flatMap((q) => {
      const out = [];
      if (!log.some((e) => inEntry(e, q.question))) out.push(`question "${q.question}"`);
      if (q.answer !== undefined && !log.some((e) => inEntry(e, q.answer ?? "")))
        out.push(`answer "${q.answer}"`);
      return out;
    });
    problems.push(
      `${name}, round ${round}: its questions and answers are not word for word from one AskUserQuestion call${
        missing.length > 0 ? ` (not asked or not answered: ${missing.join("; ")})` : ""
      }. Ask the round with AskUserQuestion and copy the questions and the user's answers exactly. If no call was logged at all, the pipe plugin's hooks are not active: check /hooks.`,
    );
  }
  return problems;
};

export const verifyBrainstorm = (head, current, log) =>
  verifyRecord("brainstorm.md", head, current, log, 2);

/** May the next AskUserQuestion round be asked? Only during the brainstorm of a spec worktree. */
export const decideAsk = (nr, brainstorm, specExists, loggedQuestionSets) => {
  if (specExists) return undefined;
  const text = brainstorm ?? "";
  const { rounds } = parseBrainstorm(text);
  if (rounds.length >= 2)
    return `specs/${nr}/brainstorm.md already holds two rounds, the maximum. Do not ask a third: write specs/${nr}/spec.md from the answers.`;
  const recorded = normalize(text);
  const unrecorded = loggedQuestionSets.some((qs) => qs.some((q) => !recorded.includes(normalize(q))));
  if (unrecorded)
    return `The last round is not recorded yet. Append it to specs/${nr}/brainstorm.md first: every question, its options, your recommendation and the user's answer word for word. Then ask the next round.`;
  return undefined;
};

// ---------------------------------------------------------------- spec.md

export const REQUIRED_HEADINGS = [
  "## On screen",
  "## Data",
  "## Interfaces",
  "## Stays out",
  "## Acceptance checks",
];

const GATE = /^## Gate feedback\s*$/m;

/**
 * The spec split at "## Gate feedback": the draft body (trailing blank lines dropped, so adding the
 * section does not count as a body change) and the section (heading included, or "").
 */
export const splitGate = (spec) => {
  const m = GATE.exec(spec);
  return m
    ? { body: spec.slice(0, m.index).trimEnd(), gate: spec.slice(m.index) }
    : { body: spec.trimEnd(), gate: "" };
};

export const sectionOf = (text, heading) => {
  const all = text.split("\n");
  const start = all.findIndex((l) => l.trim() === heading);
  if (start < 0) return undefined;
  const end = all.findIndex((l, i) => i > start && /^## /.test(l));
  return all.slice(start + 1, end < 0 ? undefined : end).join("\n");
};

export const verifySpecEdit = (before, after) => {
  const problems = [];
  const now = splitGate(after);
  if (now.gate !== "" && /^## /m.test(now.gate.split("\n").slice(1).join("\n")))
    problems.push('spec.md: "## Gate feedback" must stay the last section: no "## " heading after it.');
  if (before === undefined) return problems;
  const was = splitGate(before);
  if (was.gate !== "" && !now.gate.startsWith(was.gate.trimEnd()))
    problems.push(
      'spec.md: the "## Gate feedback" section was changed or removed. Keep every word of it where it is; only append.',
    );
  return problems;
};

export const verifySpec = (head, current, brainstorm) => {
  const problems = verifySpecEdit(head, current);
  const { body, gate } = splitGate(current);
  if (brainstorm === undefined) problems.push("spec.md exists without a brainstorm.md beside it.");
  for (const [, line] of proseLines(body))
    if (/^\s*(?:[-*]\s*)?\**status\**\s*:/i.test(line))
      problems.push(`spec.md has a status line ("${line.trim()}"): a spec has none; the merge is the approval.`);
  let at = -1;
  for (const h of REQUIRED_HEADINGS) {
    const i = body.split("\n").findIndex((l) => l.trim() === h);
    if (i < 0) problems.push(`spec.md: missing section "${h}" (write "None." under it if nothing applies).`);
    else if (i < at) problems.push(`spec.md: "${h}" is out of order: ${REQUIRED_HEADINGS.join(", ")}.`);
    else at = i;
  }
  const checks = sectionOf(body, "## Acceptance checks");
  if (checks !== undefined) {
    const numbered = checks.split("\n").filter((l) => /^\d+\.\s/.test(l));
    if (numbered.length === 0) problems.push("spec.md: the acceptance checks are not a numbered list.");
    numbered.forEach((l, i) => {
      const n = Number(l.match(/^(\d+)\./)?.[1]);
      if (n !== i + 1) problems.push(`spec.md: acceptance check "${l.slice(0, 40)}…" should be number ${i + 1}.`);
      if (!/^\d+\.\s+\*\*[^*]+\*\*\s*\S/.test(l))
        problems.push(
          `spec.md: acceptance check ${n} must start with a bold label naming the screen, the interface or the command and the case ("${n}. **Runner, check red:** ..."), then what you do and what you should see.`,
        );
    });
  }
  const screen = sectionOf(body, "## On screen") ?? "";
  if (screen.includes("```") && !(brainstorm ?? "").includes("```"))
    problems.push(
      "spec.md draws a wireframe, but brainstorm.md holds none: show it to the user in a round and record the version they accepted.",
    );
  if (head !== undefined) {
    const was = splitGate(head);
    if (was.gate.trimEnd() !== gate.trimEnd() && was.body !== body)
      problems.push(
        "spec.md: this change touches both the Gate feedback and the draft body. Commit the Gate feedback on its own first, then the revision.",
      );
  }
  return problems;
};

/** Does the spec have a screen? "## On screen" holds more than "None.". */
export const hasScreen = (spec) => {
  const s = normalize(sectionOf(spec, "## On screen") ?? "");
  return s !== "" && !/^none\.?$/i.test(s);
};

export const verifyChangedPaths = (nr, paths) => {
  // A commit of spec-review.md alone is /pipe:review-spec's, checked by its own verify.
  if (paths.length > 0 && paths.every((p) => p === `specs/${nr}/spec-review.md`)) return [];
  const allowed = new Set([`specs/${nr}/brainstorm.md`, `specs/${nr}/spec.md`]);
  const other = paths.filter((p) => !allowed.has(p));
  return other.length === 0
    ? []
    : [
        `Only specs/${nr}/brainstorm.md and specs/${nr}/spec.md may change on spec/${nr}; also changed: ${other.join(", ")}. No code: revert those.`,
      ];
};

// ---------------------------------------------------------------- the mode of a run

/** Is there Gate feedback that no body revision has answered yet? */
export const gateOpen = (current, history) => {
  const { gate } = splitGate(current);
  if (gate === "") return false;
  // The newest commit that changed the draft body (or created the file).
  const i = history.findIndex(
    (s, k) => k === history.length - 1 || splitGate(s).body !== splitGate(history[k + 1] ?? "").body,
  );
  const answered = i < 0 ? "" : splitGate(history[i] ?? "").gate;
  return answered.trimEnd() !== gate.trimEnd();
};

export const revisionMessage = (nr, trunk = "main") =>
  `Review git diff ${trunk} spec/${nr} -- specs/${nr}/spec.md, approve it by merging spec/${nr} into ${trunk}, merge ${trunk} into dev/${nr}, then run /pipe:dev ${nr}.`;

const sameRev = (a, b) => a.startsWith(b) || b.startsWith(a);

export const decideMode = (f) => {
  const { nr } = f;
  const trunk = f.trunk ?? "main";
  // 1. Revision proposed by the implementation.
  const proposed =
    f.devProgress?.startsWith("State: blocked") && /^## Proposed spec revision\s*$/m.test(f.devProgress);
  if (proposed) {
    const p = f.progressTime ?? 0;
    if ((f.branchSpecTime ?? 0) > p && f.specOnBranch !== f.specOnMain && f.specInWorktree === f.specOnBranch)
      return { stop: revisionMessage(nr, trunk) };
    if ((f.mainSpecTime ?? 0) > p)
      return {
        stop: `The revision of spec ${nr} is on ${trunk}. Merge ${trunk} into dev/${nr}, then run /pipe:dev ${nr}.`,
      };
    if (f.specOnBranch === undefined)
      return { stop: `dev/${nr} proposes a spec revision, but spec/${nr} has no spec.md to revise.` };
    return {
      mode: "revision",
      next: `Revise only specs/${nr}/spec.md, as "## Proposed spec revision" in dev/${nr}'s progress.md proposes and as the user commented on it; keep every "## Gate feedback" and every answer of the user. Run verify, commit, then stop with: ${revisionMessage(nr, trunk)}`,
    };
  }
  // 2. Merged: the spec is the contract.
  if (f.specOnMain !== undefined && f.branchMergedIntoMain && f.specInWorktree === f.specOnMain)
    return {
      stop: `spec/${nr} is merged into ${trunk} and no revision is proposed: specs/${nr}/spec.md is the implementation contract. Nothing to change.`,
    };
  // 3. Address the findings of spec-review.md.
  if (f.addressFindings) {
    if (f.specInWorktree === undefined)
      return { stop: `There is no specs/${nr}/spec.md to address yet: run /pipe:spec ${nr} first.` };
    if (f.specReview === undefined) return { stop: "Nothing to address." };
    const reviewed = reviewRevision(f.specReview);
    if (!reviewed || !f.specRevision || !sameRev(reviewed, f.specRevision))
      return {
        stop: `Nothing to address: specs/${nr}/spec-review.md reviews revision ${reviewed ?? "(none named)"}, but the last commit of spec.md is ${f.specRevision ?? "(none)"}. Review the current spec first.`,
      };
    return {
      mode: "address-findings",
      next: `Collect the findings of spec-review.md (revision ${f.specRevision}): every form check not met, every missing check, and every answer of the user that asks for a change; on a domain question the user's answer decides, never the review's recommendation. None: stop with "Nothing to address." Otherwise append them word for word under "## Gate feedback" at the end of spec.md, run verify and commit that alone; then revise the draft body to answer them, run verify and commit.`,
    };
  }
  // 4. A draft exists.
  if (f.specInWorktree !== undefined) {
    if (gateOpen(f.specInWorktree, f.specHistory))
      return {
        mode: "gate-feedback",
        next: `spec.md has "## Gate feedback": that is a rejection. If the feedback is not committed yet, commit it alone first (verify refuses a commit that changes both). Then revise the draft body to answer every point of it; keep the feedback and every answer of the user where they are. Run verify, commit, stop.`,
      };
    if (f.specInWorktree !== (f.specHistory[0] ?? undefined))
      return { mode: "draft", next: "spec.md has uncommitted changes: finish the draft, run verify, commit, stop." };
    return {
      stop: `spec/${nr} holds a draft of specs/${nr}/spec.md that waits for your review. Approve it by merging spec/${nr} into ${trunk}. To reject it, add "## Gate feedback" at the end of spec.md and run /pipe:spec ${nr} again; to fix a review, run /pipe:spec ${nr} --address-findings.`,
    };
  }
  // 5. Brainstorm, then the spec.
  const { rounds, questions } = parseBrainstorm(f.brainstorm ?? "");
  const unanswered = questions.some((q) => !q.answer);
  if (rounds.length >= 2 && !unanswered)
    return { mode: "spec", next: `Two rounds are recorded: write specs/${nr}/spec.md from them, run verify, commit, stop.` };
  return {
    mode: "brainstorm",
    next:
      rounds.length === 0
        ? `Ask round 1 with AskUserQuestion, then record it in specs/${nr}/brainstorm.md.`
        : `${rounds.length} round recorded. Ask round 2 with AskUserQuestion if anything is still open, then record it; if nothing is open, write specs/${nr}/spec.md.`,
  };
};

// ---------------------------------------------------------------- git and the file system

const logFor = (root, branch) => readAsks(root).filter((e) => e.branch === branch);

const verifyIn = (root, nr) => {
  const branch = gitOut(root, "branch", "--show-current") ?? "";
  if (branch !== `spec/${nr}`) return [`verify runs on spec/${nr}, but this worktree is on "${branch}".`];
  const problems = verifyChangedPaths(nr, changedPaths(root));
  const bPath = `specs/${nr}/brainstorm.md`;
  const sPath = `specs/${nr}/spec.md`;
  const brainstorm = readText(join(root, bPath));
  const spec = readText(join(root, sPath));
  if (brainstorm !== undefined) {
    const head = show(root, "HEAD", bPath);
    if (head !== brainstorm)
      problems.push(...verifyBrainstorm(head, brainstorm, logFor(root, branch).map(askStrings)));
  }
  if (spec !== undefined) problems.push(...verifySpec(show(root, "HEAD", sPath), spec, brainstorm));
  return problems;
};

const start = (argv) => {
  const args = parseArgs(argv);
  if ("error" in args) stop(args.error);
  const { nr } = args;
  const { root, trunk } = repoOrStop(process.cwd());
  const roadmap =
    show(root, trunk, "specs/roadmap.md") ??
    stop(`${trunk} has no committed specs/roadmap.md. Run /pipe:roadmap (or /pipe:setup) and commit it first.`);
  const story = storyIn(roadmap, nr) ?? stop(`specs/roadmap.md has no story ${nr}: nothing to spec.`);

  const branch = `spec/${nr}`;
  const { wt } = ensureWorktree(root, trunk, branch);

  const sPath = `specs/${nr}/spec.md`;
  const time = (rev, path) => {
    const t = gitOut(wt, "log", "-1", "--format=%ct", rev, "--", path);
    return t ? Number(t) : undefined;
  };
  const devExists = git(wt, "rev-parse", "--verify", "--quiet", `refs/heads/dev/${nr}`).ok;
  const history = (gitOut(wt, "log", "--format=%H", branch, "--", sPath) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((h) => show(wt, h, sPath))
    .filter((s) => s !== undefined);
  const mode = decideMode({
    nr,
    trunk,
    addressFindings: args.addressFindings,
    specOnMain: show(wt, trunk, sPath),
    specOnBranch: show(wt, branch, sPath),
    specInWorktree: readText(join(wt, sPath)),
    specHistory: history,
    branchMergedIntoMain: git(wt, "merge-base", "--is-ancestor", branch, trunk).ok,
    brainstorm: readText(join(wt, `specs/${nr}/brainstorm.md`)),
    devProgress: devExists ? show(wt, `dev/${nr}`, `specs/${nr}/progress.md`) : undefined,
    progressTime: devExists ? time(`dev/${nr}`, `specs/${nr}/progress.md`) : undefined,
    mainSpecTime: time(trunk, sPath),
    branchSpecTime: time(branch, sPath),
    specReview: readText(join(wt, `specs/${nr}/spec-review.md`)),
    specRevision: gitOut(wt, "log", "-1", "--format=%h", branch, "--", sPath) || undefined,
  });
  if ("stop" in mode) {
    event(root, { ticket: nr, step: "spec", event: "stop", outcome: mode.stop.slice(0, 200) });
    stop(mode.stop);
  }
  event(root, { ticket: nr, step: "spec", event: "start", outcome: mode.mode });
  console.log(`worktree: ${wt}`);
  console.log(`branch: ${branch}`);
  console.log(`mode: ${mode.mode}`);
  console.log(`next: ${mode.next}`);
  console.log(`\n${story}`);
};

// ---------------------------------------------------------------- hooks

/** The file's text after a Write, Edit or MultiEdit; undefined when it cannot be worked out. */
export const afterEdit = (before, input, tool) => {
  if (tool === "Write") return input.content;
  const edits =
    tool === "MultiEdit"
      ? (input.edits ?? [])
      : [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }];
  let text = before ?? "";
  for (const e of edits) {
    if (e.old_string === undefined || e.new_string === undefined) return undefined;
    text = e.replace_all
      ? text.split(e.old_string).join(e.new_string)
      : text.replace(e.old_string, () => e.new_string ?? "");
  }
  return text;
};

const blockWith = (reason) => {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
};

const hook = async () => {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return; // not ours to judge: let the call through
  }
  if (input.hook_event_name !== "PreToolUse") return;
  const tool = input.tool_name ?? "";
  const cwd = input.cwd ?? process.cwd();

  if (tool === "AskUserQuestion") {
    const root = gitOut(existingDir(cwd), "rev-parse", "--show-toplevel");
    const branch = root ? (gitOut(root, "branch", "--show-current") ?? "") : "";
    const nr = branch.match(/^spec\/(\d+)$/)?.[1];
    if (!root || !nr) return;
    const reason = decideAsk(
      nr,
      readText(join(root, `specs/${nr}/brainstorm.md`)),
      existsSync(join(root, `specs/${nr}/spec.md`)),
      logFor(root, branch).map((e) => loggedQuestions(e.tool_input)),
    );
    if (reason) blockWith(`Blocked by /pipe:spec: ${reason}`);
    return;
  }

  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit") {
    const raw = input.tool_input?.file_path;
    if (!raw) return;
    const path = isAbsolute(raw) ? raw : resolve(cwd, raw);
    const m = path.match(/(?:^|\/)specs\/(\d+)\/(brainstorm|spec)\.md$/);
    if (!m) return;
    const branch = gitOut(existingDir(dirname(path)), "branch", "--show-current") ?? "";
    if (!branch.startsWith("spec/")) return; // the spec-gate hook owns spec.md off spec/ branches
    const before = readText(path);
    const after = afterEdit(before, input.tool_input ?? {}, tool);
    if (after === undefined) return;
    if (m[2] === "brainstorm") {
      if (before !== undefined && !after.startsWith(before))
        blockWith(
          "Blocked by /pipe:spec: brainstorm.md is append-only. Never change a question or an answer already in it: append the new round at the end.",
        );
      return;
    }
    const problems = verifySpecEdit(before, after);
    if (problems.length > 0) blockWith(`Blocked by /pipe:spec: ${problems.join(" ")}`);
    return;
  }

  if (tool === "Bash") {
    const command = input.tool_input?.command ?? "";
    if (!/\bgit\b[^;&|\n]*\scommit\b/.test(command)) return;
    const dirFlag = command
      .match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)[^;&|\n]*\scommit\b/)?.[1]
      ?.replace(/^["']|["']$/g, "");
    const cdDir = command.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/)?.[1]?.replace(/^["']|["']$/g, "");
    const dir = dirFlag ? resolve(cwd, dirFlag) : cdDir ? resolve(cwd, cdDir) : cwd;
    const root = gitOut(existingDir(dir), "rev-parse", "--show-toplevel");
    const branch = root ? (gitOut(root, "branch", "--show-current") ?? "") : "";
    const nr = branch.match(/^spec\/(\d+)$/)?.[1];
    if (!root || !nr) return;
    const problems = verifyIn(root, nr);
    if (problems.length > 0)
      blockWith(`Blocked by /pipe:spec: the commit on ${branch} fails verify:\n- ${problems.join("\n- ")}`);
  }
};

if (isMain(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "start") start(rest);
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
      // A broken guard must not trap the session: report it, let the call through.
      process.stderr.write(`/pipe:spec hook error: ${String(error)}\n`);
    }
    process.exit(0);
  } else {
    console.log("Usage: node spec.mjs start <nr> [--address-findings] | verify <nr> | hook");
    process.exit(64);
  }
}
