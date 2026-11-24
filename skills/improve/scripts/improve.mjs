// The /pipe:improve skill's deterministic parts: the gate (the retro is merged), the improve worktree,
// the proposals of the retro, and the check of specs/{nr}/improve.md and of what was applied.
//
//   node improve.mjs start <nr>
//     Stops unless the trunk holds specs/{nr}/retro.md (learn/{nr} merged). Creates
//     .worktrees/improve/{nr} on improve/{nr} from the trunk, or continues it. Prints the proposals.
//   node improve.mjs verify <nr>
//     Run in the improve worktree before and after the commit. Every proposal has a decision, every
//     decision was asked and answered word for word (AskUserQuestion log), and every file that
//     changed is named by an applied decision. No spec.md and no other story's record changes.
//   node improve.mjs publish <nr>
//     The last step, once everything is committed and verify passes: pushes improve/{nr} to origin
//     and opens its pull request (or reuses the open one). A person merges it. A push or gh that
//     fails is one line with the command for a person; exit 0 either way.
import { join } from "node:path";
import {
  appendJsonl,
  changedPaths,
  askStrings,
  ensureWorktree,
  event,
  gitOut,
  isMain,
  lines,
  mainRoot,
  normalize,
  parseNr,
  readAsks,
  readJsonl,
  readText,
  repoOrStop,
  show,
  stateDir,
  stop,
  storyTitle,
  trunkOf,
  words,
} from "../../../lib/common.mjs";
import { publish } from "../../../lib/publish.mjs";
import { items, sections } from "../../learn/scripts/learn.mjs";
import { verifyRecord } from "../../spec/scripts/spec.mjs";

export const DECISIONS = ["apply", "apply as changed", "skip", "plugin"];

/** The numbered proposals of a retro, each with its step. */
export const proposalsOf = (retro) =>
  items(sections(retro).get("Proposals") ?? "").map((p) => ({
    text: p,
    step: p.match(/^\d+\. \*\*([^*]+)\*\*/)?.[1]?.replace(/\.$/, "") ?? "",
  }));

const tableRows = (body) =>
  body
    .split("\n")
    .filter((l) => /^\|\s*\d+\s*\|/.test(l))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim()),
    );

export const checkImprove = ({ nr, improve, proposals, changed, log }) => {
  if (improve === undefined) return [`specs/${nr}/improve.md does not exist.`];
  const problems = [];
  if (!new RegExp(`^# Story ${nr} improve: \\S`).test(improve.split("\n")[0] ?? ""))
    problems.push(`Line 1 is not "# Story ${nr} improve: {story title}".`);
  const questionsPart = improve.split(/^## Decisions\s*$/m)[0] ?? "";
  if (proposals.length > 0) problems.push(...verifyRecord("improve.md", undefined, questionsPart, log, undefined));
  const decisions = sections(improve).get("Decisions");
  if (decisions === undefined) return [...problems, 'improve.md has no "## Decisions" section.'];
  const rows = tableRows(decisions);
  if (proposals.length === 0 && !/^None\./m.test(decisions))
    problems.push('The retro has no proposals: "## Decisions" reads "None.".');
  proposals.forEach((p, i) => {
    const row = rows.find((r) => Number(r[0]) === i + 1);
    if (!row) problems.push(`Proposal ${i + 1} (${p.step}) has no row in "## Decisions".`);
    else if (!DECISIONS.includes(normalize(row[2] ?? "").toLowerCase()))
      problems.push(`Proposal ${i + 1}: the decision must be one of ${DECISIONS.map((d) => `"${d}"`).join(", ")}, not "${row[2]}".`);
  });
  const applied = rows
    .filter((r) => /^apply/i.test(r[2] ?? ""))
    .map((r) => r[3] ?? "")
    .join(" ");
  for (const path of changed) {
    if (path === `specs/${nr}/improve.md`) continue;
    if (/(^|\/)specs\/[^/]+\/spec\.md$/.test(path)) problems.push(`${path} changed: /pipe:improve never changes a spec.`);
    else if (/^specs\/\d+\//.test(path)) problems.push(`${path} changed: it is a story's record, not the pipeline.`);
    else if (!applied.includes(path)) problems.push(`${path} changed, but no applied decision names it under "Applied in".`);
  }
  return problems;
};

const logPath = (cwd) => join(stateDir(cwd) ?? ".", "improve", "log.jsonl");
const startHead = (cwd, nr) => readJsonl(logPath(cwd)).filter((e) => e.kind === "start" && e.nr === nr)[0]?.head;

const start = (nr) => {
  const { root, trunk } = repoOrStop(process.cwd());
  const retro =
    show(root, trunk, `specs/${nr}/retro.md`) ??
    stop(`${trunk} has no specs/${nr}/retro.md: run /pipe:learn ${nr} and merge learn/${nr} first.`);
  const { wt, created } = ensureWorktree(root, trunk, `improve/${nr}`);
  if (!startHead(wt, nr)) appendJsonl(logPath(wt), { kind: "start", nr, head: gitOut(wt, "rev-parse", "HEAD") });
  event(root, { ticket: nr, step: "improve", event: "start" });
  const proposals = proposalsOf(retro);
  console.log(`worktree: ${wt}`);
  console.log(`branch: improve/${nr} ${created ? `(created from ${trunk})` : "(continued)"}`);
  console.log(`record: specs/${nr}/improve.md ${readText(join(wt, `specs/${nr}/improve.md`)) ? "exists: continue it" : "not written yet"}`);
  console.log(`proposals: ${proposals.length}`);
  for (const p of proposals) console.log(p.text);
};

/** Everything verify checks, as a list of problems. */
const verifyProblems = (wt, nr) => {
  const root = mainRoot(wt) ?? wt;
  const trunk = trunkOf(root);
  const problems = [];
  const branch = gitOut(wt, "branch", "--show-current");
  if (branch !== `improve/${nr}`) problems.push(`Run verify in the improve worktree: this is "${branch}", not improve/${nr}.`);
  const base = startHead(wt, nr);
  if (!base) problems.push(`No start record: run \`improve.mjs start ${nr}\` first.`);
  const changed = base
    ? [
        ...new Set([
          ...lines(gitOut(wt, "diff", "--name-only", base, "HEAD")),
          ...changedPaths(wt),
        ]),
      ]
    : [];
  problems.push(
    ...checkImprove({
      nr,
      improve: readText(join(wt, `specs/${nr}/improve.md`)),
      proposals: proposalsOf(show(root, trunk, `specs/${nr}/retro.md`) ?? ""),
      changed,
      log: readAsks(wt).filter((e) => e.branch === `improve/${nr}`).map(askStrings),
    }),
  );
  return problems;
};

const verify = (nr) => {
  const wt = gitOut(process.cwd(), "rev-parse", "--show-toplevel") ?? process.cwd();
  const problems = verifyProblems(wt, nr);
  if (problems.length > 0) {
    console.log(`verify: ${problems.length} problem(s)\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("verify: ok");
};

/** Pushes improve/{nr} and opens its pull request, once everything is committed and verified. */
const publishImprove = (nr) => {
  const wt = gitOut(process.cwd(), "rev-parse", "--show-toplevel") ?? process.cwd();
  const rPath = `specs/${nr}/improve.md`;
  const problems = verifyProblems(wt, nr);
  if (changedPaths(wt).length > 0) problems.push("the worktree has uncommitted changes: commit them first.");
  else if (show(wt, "HEAD", rPath) === undefined) problems.push(`${rPath} is not committed yet.`);
  if (problems.length > 0) {
    console.log(`publish: nothing pushed, the improvement is not done:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  const result = publish({
    wt,
    nr,
    step: "improve",
    branch: `improve/${nr}`,
    trunk: trunkOf(mainRoot(wt) ?? wt),
    title: `Improve ${nr}: ${storyTitle(readText(join(wt, "specs/roadmap.md")), nr) ?? `story ${nr}`}`,
    body: `Read ${rPath}: each proposal of the retro with its decision, and the files it changed. Merging is the approval: it makes the accepted changes part of the pipeline.`,
  });
  console.log(result.lines.join("\n"));
};

if (isMain(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const all = words(rest);
  const nr = all.length === 1 ? parseNr(all[0]) : undefined;
  if (!nr) stop("Give one story number, e.g. /pipe:improve 01.");
  else if (command === "start") start(nr);
  else if (command === "verify") verify(nr);
  else if (command === "publish") publishImprove(nr);
  else {
    console.log("Usage: node improve.mjs start|verify|publish <nr>");
    process.exit(64);
  }
}
