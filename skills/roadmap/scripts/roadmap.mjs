// The /pipe:roadmap skill's deterministic parts: the fourteen blocks, the fixed rules written down
// unchanged, and the checks of pipeline.md, specs/roadmap.md and specs/roadmap-brainstorm.md.
//
//   node roadmap.mjs start [--data <plugin data dir>]
//     Prints the folder, what already exists (continue it), the block list and the fixed texts.
//   node roadmap.mjs verify [--data <plugin data dir>]
//     Exit 0 "verify: ok", exit 1 with the problems. The record's questions and answers must be word
//     for word from logged AskUserQuestion calls (hooks/asks.mjs).
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  askStrings,
  gitOut,
  isMain,
  normalize,
  readAsks,
  readText,
  storyIn,
  takeOption,
} from "../../../lib/common.mjs";
import { parseBrainstorm, verifyRecord } from "../../spec/scripts/spec.mjs";

export const BLOCKS = [
  [1, "Intake", "decide now", "which tickets enter the pipeline, and three real examples"],
  [2, "Runtime and trigger", "decide now", "where a run executes, who starts it, whose account the agent signs in with"],
  [3, "Isolation", "decide now", "what a run may read, write and reach, which secrets it gets; a worktree per ticket"],
  [4, "Context", "setup", "AGENTS.md, specs/guidelines/ and the check line, written by /pipe:setup"],
  [5, "Spec gate", "fixed", "/pipe:spec and /pipe:review-spec; a person merges the spec"],
  [6, "Build", "fixed", "/pipe:dev in its own worktree; agents never merge or push"],
  [7, "Verification", "decide now", "the one check command and what it runs"],
  [8, "Independent review", "decide now", "/pipe:review-dev by a reviewer that cannot edit; what always goes to a person"],
  [9, "Merge gate", "decide now", "who reads and merges dev pull requests"],
  [10, "Orchestrator and limits", "decide now", "turns, minutes, dollars and reviews per step and ticket; the stop switch"],
  [11, "Evals", "decide now", "for each reviewer, one case it must reject and one it must accept"],
  [12, "Learn", "fixed", "/pipe:learn after every merge, /pipe:improve asks, a person decides"],
  [13, "Measurement", "fixed", "six metrics computed from the events"],
  [14, "Production feedback", "later", "what production tells the pipeline"],
];

/** The fixed blocks, written down unchanged. */
export const FIXED = {
  5: "Fixed: a person merges every spec, dev and learn pull request; merging is the approval. The spec is written only on a spec/ branch.",
  6: "Fixed: agents never merge and never push; the runner (code) pushes. The build runs in its own worktree and ends only when the check is green.",
  12: "Fixed: learn after every merge; improve asks, a person decides.",
  13: "Fixed: six metrics: lead time, human minutes per gate, review rounds and rework, first-run green, agent cost (estimate), stops and denied calls, all computed automatically from events.",
};
export const REVIEW_FIXED = "The reviewer cannot edit.";
export const SETUP_LINE = "Setup: /pipe:setup writes AGENTS.md with the Check line, specs/guidelines/ and .gitignore.";
export const LATER_LINE = "Later.";
export const EVENT_FIELDS = ["ticket", "step", "event", "time", "outcome", "turns", "cost_usd"];
export const EVENT_KINDS = "start, end, stop, denied, limit";
export const GROUPS = [
  ["A", "Runner and limits"],
  ["B", "Runtime, trigger and isolation"],
  ["C", "Gates, review and evals"],
  ["D", "Measurement"],
];
export const STORY_FIELDS = ["**Afterwards a person can**", "**On screen when done:**", "**Out of scope:**", "**Group:**"];

const headingOf = ([n, name]) => `## ${n}. ${name}`;

/** "## {n}. {name}" sections in order, each body up to the next "## ". */
const numberedSections = (text) => {
  const out = new Map();
  let key;
  let body = [];
  const flush = () => {
    if (key !== undefined) out.set(key, body.join("\n").trim());
  };
  for (const line of text.split("\n")) {
    const h = line.match(/^## (.+?)\s*$/);
    if (h) {
      flush();
      key = h[1];
      body = [];
    } else if (key !== undefined) body.push(line);
  }
  flush();
  return out;
};

export const checkPipeline = (pipeline, brainstorm) => {
  if (pipeline === undefined) return ["pipeline.md does not exist."];
  const problems = [];
  const all = pipeline.split("\n");
  if (all.length >= 120) problems.push(`pipeline.md has ${all.length} lines: keep it under 120.`);
  const s = numberedSections(pipeline);
  const keys = [...s.keys()];
  let at = -1;
  const recorded = parseBrainstorm(brainstorm ?? "").questions;
  const answers = recorded.map((q) => normalize(q.answer ?? ""));
  const recommendations = recorded.map((q) => normalize(q.recommendation ?? "").replace(/\.$/, ""));
  for (const block of BLOCKS) {
    const [n, name, mark] = block;
    const key = `${n}. ${name}`;
    const i = keys.indexOf(key);
    if (i < 0) {
      problems.push(`pipeline.md: missing section "${headingOf(block)}".`);
      continue;
    }
    if (i < at) problems.push(`pipeline.md: "${headingOf(block)}" is out of order (1 to 14).`);
    at = i;
    const body = s.get(key) ?? "";
    if (mark === "fixed" && !normalize(body).includes(normalize(FIXED[n])))
      problems.push(`pipeline.md, ${key}: write the fixed rule unchanged: "${FIXED[n]}"`);
    if (mark === "setup" && !normalize(body).includes(normalize(SETUP_LINE)))
      problems.push(`pipeline.md, ${key}: write "${SETUP_LINE}"`);
    if (mark === "later" && !normalize(body).startsWith(LATER_LINE))
      problems.push(`pipeline.md, ${key}: write "${LATER_LINE}"`);
    if (mark === "decide now") {
      const decisions = [...body.matchAll(/^Decision: "(.*)"(\s+\(revisit\))?\s*$/gm)].map((m) => ({
        text: normalize(m[1]),
        revisit: Boolean(m[2]),
      }));
      if (decisions.length === 0)
        problems.push(
          `pipeline.md, ${key}: no line 'Decision: "{the team's answer, word for word}"' (or 'Decision: "{the recommendation}" (revisit)').`,
        );
      for (const d of decisions) {
        const candidates = d.revisit ? recommendations : answers;
        if (!candidates.includes(d.text))
          problems.push(
            `pipeline.md, ${key}: the decision "${d.text.slice(0, 60)}" is not ${d.revisit ? "a recommendation" : "an answer"} in specs/roadmap-brainstorm.md, word for word.`,
          );
      }
      if (n === 8 && !normalize(body).includes(REVIEW_FIXED))
        problems.push(`pipeline.md, ${key}: write the fixed rule "${REVIEW_FIXED}"`);
    }
  }
  const groups = s.get("Groups");
  if (groups === undefined) problems.push('pipeline.md: missing section "## Groups".');
  else
    for (const [letter, name] of GROUPS)
      if (!new RegExp(`^- \\*\\*${letter} ${name}\\*\\*`, "m").test(groups))
        problems.push(`pipeline.md, Groups: missing "- **${letter} ${name}**" with its blocks and its people.`);
  const events = s.get("Events");
  if (events === undefined) problems.push('pipeline.md: missing section "## Events".');
  else {
    const line = events.split("\n").find((l) => l.trim().startsWith("{"));
    let parsed;
    try {
      parsed = line ? JSON.parse(line.trim()) : undefined;
    } catch {}
    if (!parsed) problems.push("pipeline.md, Events: one JSON example line of an event.");
    else if (Object.keys(parsed).join(",") !== EVENT_FIELDS.join(","))
      problems.push(`pipeline.md, Events: the event line has exactly the fields ${EVENT_FIELDS.join(", ")}, in this order.`);
    if (!events.includes(EVENT_KINDS)) problems.push(`pipeline.md, Events: name the events "${EVENT_KINDS}".`);
  }
  return problems;
};

/** Every "### Story {nr}: ..." heading with its section. */
export const storiesOf = (roadmap) =>
  [...roadmap.matchAll(/^### Story (\d{2,3}): (.+)$/gm)].map((m) => ({ nr: m[1], title: m[2], text: storyIn(roadmap, m[1]) ?? "" }));

export const checkRoadmap = (roadmap) => {
  if (roadmap === undefined) return ["specs/roadmap.md does not exist."];
  const problems = [];
  if (!/^# Roadmap\b/.test(roadmap)) problems.push('specs/roadmap.md: line 1 is "# Roadmap".');
  const ticketsAt = roadmap.search(/^## Tickets for the pipeline\s*$/m);
  if (ticketsAt < 0) problems.push('specs/roadmap.md: missing "## Tickets for the pipeline".');
  const epicsPart = ticketsAt < 0 ? roadmap : roadmap.slice(0, ticketsAt);
  const ticketsPart = ticketsAt < 0 ? "" : roadmap.slice(ticketsAt);
  if (!/^## Epic \d+: \S/m.test(epicsPart)) problems.push('specs/roadmap.md: no "## Epic {n}: {name}".');
  for (const block of epicsPart.split(/^(?=## Epic \d+: )/m).filter((b) => b.startsWith("## Epic")))
    if (!/^### Story \d{2,3}: /m.test(block))
      problems.push(`specs/roadmap.md: "${block.split("\n")[0]}" has no "### Story {nr}: {title}".`);
  const stories = storiesOf(roadmap);
  const seen = new Set();
  for (const s of stories) {
    if (seen.has(s.nr)) problems.push(`specs/roadmap.md: story ${s.nr} appears twice.`);
    seen.add(s.nr);
    for (const f of STORY_FIELDS)
      if (!s.text.includes(f)) problems.push(`specs/roadmap.md, story ${s.nr}: no line starting with ${f}.`);
  }
  const first = storiesOf(epicsPart)[0];
  if (!first || first.nr !== "01") problems.push("specs/roadmap.md: the first story is Story 01.");
  else if (!/walking skeleton/i.test(first.text)) problems.push("specs/roadmap.md: Story 01 is the walking skeleton: say so.");
  for (const nr of ["101", "102", "103"])
    if (!storiesOf(ticketsPart).some((s) => s.nr === nr))
      problems.push(`specs/roadmap.md: "## Tickets for the pipeline" has no "### Story ${nr}: ...".`);
  return problems;
};

const folderOf = (cwd) => gitOut(cwd, "rev-parse", "--show-toplevel") ?? cwd;

const start = (argv) => {
  const [data] = takeOption(argv, "--data");
  const dir = folderOf(process.cwd());
  const has = (p) => (existsSync(join(dir, p)) ? "exists: continue it" : "not yet");
  console.log(`folder: ${dir}${gitOut(dir, "rev-parse", "--show-toplevel") ? "" : " (not a git repository yet: that is fine)"}`);
  console.log(`asks log: ${data ? "plugin data" : "(no --data given: the record cannot be checked)"}`);
  console.log(`pipeline.md: ${has("pipeline.md")}`);
  console.log(`specs/roadmap.md: ${has("specs/roadmap.md")}`);
  console.log(`specs/roadmap-brainstorm.md: ${has("specs/roadmap-brainstorm.md")}`);
  console.log("\nThe fourteen blocks:");
  for (const [n, name, mark, what] of BLOCKS) console.log(`${String(n).padStart(2)}. ${name} [${mark}]: ${what}`);
  console.log("\nFixed texts, written unchanged:");
  for (const [n, text] of Object.entries(FIXED)) console.log(`  ${n}: ${text}`);
  console.log(`  8 (with the team's decision): ${REVIEW_FIXED}`);
  console.log(`  4: ${SETUP_LINE}`);
  console.log(`  14: ${LATER_LINE}`);
  console.log(`\nEvent line fields, in order: ${EVENT_FIELDS.join(", ")}; events: ${EVENT_KINDS}.`);
};

const verify = (argv) => {
  const [data] = takeOption(argv, "--data");
  const dir = folderOf(process.cwd());
  const brainstorm = readText(join(dir, "specs/roadmap-brainstorm.md"));
  const problems = [];
  if (brainstorm === undefined) problems.push("specs/roadmap-brainstorm.md does not exist.");
  else
    problems.push(
      ...verifyRecord("specs/roadmap-brainstorm.md", undefined, brainstorm, readAsks(dir, data).map(askStrings), undefined),
    );
  problems.push(...checkPipeline(readText(join(dir, "pipeline.md")), brainstorm));
  problems.push(...checkRoadmap(readText(join(dir, "specs/roadmap.md"))));
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
    console.log("Usage: node roadmap.mjs start|verify [--data <dir>]");
    process.exit(64);
  }
}
