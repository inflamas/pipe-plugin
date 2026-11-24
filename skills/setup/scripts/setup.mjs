// The /pipe:setup skill's deterministic parts: what the repository already holds, the roadmap it
// must keep unchanged, and the check of what setup wrote.
//
//   node setup.mjs start [--data <plugin data dir>]
//     Stops unless the folder is a git repository. Prints what exists (AGENTS.md and its Check line,
//     pipeline.md, specs/roadmap.md, specs/setup.md, specs/guidelines/, .gitignore) and records the
//     roadmap's hash: setup keeps an existing roadmap unchanged.
//   node setup.mjs verify [--data <plugin data dir>]
//     Exit 0 "verify: ok", exit 1 with the problems.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  agentsLine,
  appendJsonl,
  askStrings,
  gitOut,
  isIgnored,
  isMain,
  normalize,
  readAsks,
  readJsonl,
  readText,
  sha256,
  stateDir,
  stop,
  takeOption,
  WORKTREES,
} from "../../../lib/common.mjs";
import { checkRoadmap } from "../../roadmap/scripts/roadmap.mjs";
import { parseBrainstorm, verifyRecord } from "../../spec/scripts/spec.mjs";

/** The lines of AGENTS.md setup writes from the team's answers; Check is required. */
export const LINES = ["Check", "Install", "Run", "URL", "Dependencies"];

export const PIPELINE_RULES_HEADING = "## Pipeline rules";

export const checkSetup = ({ setup, agents, architecture, ui, roadmapBefore, roadmapNow, ignored, log }) => {
  const problems = [];
  if (setup === undefined) problems.push("specs/setup.md does not exist.");
  else problems.push(...verifyRecord("specs/setup.md", undefined, setup, log, undefined));
  const answers = normalize(
    parseBrainstorm(setup ?? "")
      .questions.map((q) => q.answer ?? "")
      .join(" \n "),
  );
  if (agents === undefined) problems.push("AGENTS.md does not exist.");
  else {
    if (!agentsLine(agents, "Check")) problems.push('AGENTS.md has no line "Check: <command>".');
    for (const name of LINES) {
      const value = agentsLine(agents, name);
      if (value && !answers.includes(normalize(value)))
        problems.push(
          `AGENTS.md "${name}: ${value}" is not an answer in specs/setup.md, word for word: setup writes only what the team answered.`,
        );
    }
    if (!agents.includes(PIPELINE_RULES_HEADING)) problems.push(`AGENTS.md has no "${PIPELINE_RULES_HEADING}" section.`);
  }
  if (architecture === undefined) problems.push("specs/guidelines/architecture.md does not exist.");
  if (agents !== undefined && agentsLine(agents, "Run") && ui === undefined)
    problems.push("AGENTS.md has a Run line (there is a screen), but specs/guidelines/ui.md does not exist.");
  if (roadmapBefore !== undefined && roadmapNow !== roadmapBefore)
    problems.push("specs/roadmap.md existed before setup and changed: setup keeps an existing roadmap unchanged. Restore it.");
  if (roadmapNow === undefined) problems.push("specs/roadmap.md does not exist.");
  else if (roadmapBefore === undefined) problems.push(...checkRoadmapLight(roadmapNow));
  if (!ignored) problems.push(`.gitignore does not ignore ${WORKTREES}/: add the line "${WORKTREES}/".`);
  return problems;
};

/** A roadmap setup wrote (no /pipe:roadmap before it): stories in the form /pipe:spec reads. */
const checkRoadmapLight = (roadmap) =>
  checkRoadmap(roadmap).filter((p) => !/Tickets for the pipeline|Story 10[123]|walking skeleton/.test(p));

const stateFile = (cwd) => join(stateDir(cwd) ?? ".", "setup", "log.jsonl");

const start = (argv) => {
  const root = gitOut(process.cwd(), "rev-parse", "--show-toplevel");
  if (!root)
    stop("This folder is not a git repository yet. Create it first (git init -b main, and a first commit), then run /pipe:setup again.");
  const [data] = takeOption(argv, "--data");
  const roadmap = readText(join(root, "specs/roadmap.md"));
  appendJsonl(stateFile(root), { kind: "start", roadmap: roadmap === undefined ? null : sha256(roadmap) });
  const agents = readText(join(root, "AGENTS.md"));
  const has = (p) => existsSync(join(root, p));
  const guidelines = has("specs/guidelines") ? readdirSync(join(root, "specs/guidelines")) : [];
  console.log(`repository: ${root}`);
  console.log(`asks log: ${data ? "ok" : "(no --data given)"}`);
  console.log(`AGENTS.md: ${agents === undefined ? "not yet" : `exists${agentsLine(agents, "Check") ? `, Check: ${agentsLine(agents, "Check")}` : ", no Check line"}`}`);
  console.log(`pipeline.md: ${has("pipeline.md") ? "exists: read it, its decisions inform your recommendations" : "not there"}`);
  console.log(`specs/roadmap.md: ${roadmap === undefined ? "not there: ask for the first tickets" : "exists: keep it unchanged, do not ask for tickets"}`);
  console.log(`specs/setup.md: ${has("specs/setup.md") ? "exists: continue it" : "not yet"}`);
  console.log(`specs/guidelines/: ${guidelines.length ? guidelines.join(", ") : "empty"}`);
  console.log(`.gitignore: ${isIgnored(root, `${WORKTREES}/x`) ? `ignores ${WORKTREES}/` : `does not ignore ${WORKTREES}/ yet`}`);
};

const verify = (argv) => {
  const root = gitOut(process.cwd(), "rev-parse", "--show-toplevel") ?? process.cwd();
  const [data] = takeOption(argv, "--data");
  const started = readJsonl(stateFile(root)).filter((e) => e.kind === "start")[0];
  const roadmapNow = readText(join(root, "specs/roadmap.md"));
  const problems = [];
  if (!started) problems.push('No start record: run "setup.mjs start" first.');
  const roadmapBefore =
    started?.roadmap && roadmapNow !== undefined && sha256(roadmapNow) === started.roadmap ? roadmapNow : started?.roadmap ? "(changed)" : undefined;
  problems.push(
    ...checkSetup({
      setup: readText(join(root, "specs/setup.md")),
      agents: readText(join(root, "AGENTS.md")),
      architecture: readText(join(root, "specs/guidelines/architecture.md")),
      ui: readText(join(root, "specs/guidelines/ui.md")),
      roadmapBefore,
      roadmapNow,
      ignored: isIgnored(root, `${WORKTREES}/x`),
      log: readAsks(root, data).map(askStrings),
    }),
  );
  if (problems.length > 0) {
    console.log(`verify: ${problems.length} problem(s)\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("verify: ok");
};

if (isMain(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "start") start(rest);
  else if (command === "verify") verify(rest);
  else {
    console.log("Usage: node setup.mjs start|verify [--data <dir>]");
    process.exit(64);
  }
}
