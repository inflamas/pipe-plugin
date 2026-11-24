// The reviewers cannot edit. The agents pipe:spec-reviewer and pipe:dev-reviewer have no Edit, Write
// or NotebookEdit (agents/*.md); these hooks close the rest and take their report.
//
//   node reviewer.mjs guard     PreToolUse, every tool. Acts only when the call comes from a reviewer
//     (agent_type "...spec-reviewer" or "...dev-reviewer"). Blocks every file tool, and every Bash
//     command that can change the repository: git other than reading (status, diff, log, show, ...),
//     package installs, sed -i / perl -i, and rm, mv, cp, touch, mkdir, truncate, ln, chmod, tee or a
//     > redirect whose target lies inside the repository. Targets outside it (the scratchpad, /tmp)
//     and starting or stopping a dev server stay allowed.
//   node reviewer.mjs capture   SubagentStop. When a reviewer stops, its last message is its report:
//     the findings of /pipe:review-spec or the review of /pipe:review-dev. It is saved under
//     <git common dir>/pipe/review-spec/findings-{nr}.md or .../review-dev/review-{nr}.md, with its
//     hash in the log, for the story whose review started last. Only the skill writes spec-review.md
//     or review.md, and its verify compares them with this report word for word.
// Not covered: a file changed by a script the reviewer runs (node -e, a test that writes files), and
// anything a person does in their own terminal.
import { writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  appendJsonl,
  existingDir,
  gitOut,
  isMain,
  mainRoot,
  readJsonl,
  readStdin,
  readText,
  sha256,
  stateDir,
} from "../lib/common.mjs";
import { allow, block, FILE_TOOLS, maskShell, runHook } from "./lib.mjs";

export const reviewerKind = (agentType) => {
  const m = (agentType ?? "").match(/(?:^|:)(spec|dev)-reviewer$/);
  return m ? m[1] : undefined;
};

const WHY = "A reviewer only reads, runs and looks; only the review skill writes the review.";

const READ_ONLY_GIT = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "merge-base",
  "blame",
  "grep",
  "cat-file",
  "describe",
  "shortlog",
  "name-rev",
  "for-each-ref",
  "branch",
  "worktree",
  "config",
  "check-ignore",
  "whatchanged",
  "--version",
]);

const READ_ONLY_FORMS = {
  branch: /^(?:--show-current|--list|-a|-r|-v|-vv|--contains|--merged|--no-merged|$)/,
  worktree: /^list\b/,
  config: /^(?:--get|--list|-l\b)/,
};

const tokens = (segment) =>
  (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ""));

/** Is `token` a path inside the repository? Relative paths resolve against the cwd. */
const inside = (token, cwd, roots) => {
  if (!token || token.startsWith("-") || token === "/dev/null") return false;
  if (!/[/.\w]/.test(token)) return false;
  const p = isAbsolute(token) ? token : resolve(cwd, token);
  return roots.some((r) => p === r || p.startsWith(`${r}/`));
};

const WRITERS = new Set(["rm", "mv", "cp", "touch", "mkdir", "truncate", "ln", "chmod", "chown", "tee", "dd", "install", "patch", "rsync"]);

/** Why a reviewer's Bash command could change the repository; undefined when it cannot. */
export const reviewerBashProblem = (command, cwd, roots) => {
  command = maskShell(command);
  for (const m of command.matchAll(/(?<![=\->])\d*>>?(?![&>])\s*("[^"]*"|'[^']*'|[^\s;&|)]+)/g)) {
    const target = m[1].replace(/^["']|["']$/g, "");
    if (inside(target, cwd, roots)) return `a redirect into the repository (${target})`;
  }
  for (const segment of command.split(/&&|\|\||[;|\n&]/)) {
    const t = tokens(segment.trim());
    let i = 0;
    while (i < t.length && /^\w+=/.test(t[i])) i++; // VAR=value prefixes
    const cmd = t[i];
    if (!cmd) continue;
    const rest = t.slice(i + 1);
    if (cmd === "git") {
      let j = 0;
      while (j < rest.length && /^-/.test(rest[j])) j += /^(?:-C|-c|--git-dir|--work-tree)$/.test(rest[j]) ? 2 : 1;
      const sub = rest[j];
      if (sub === undefined) continue;
      if (!READ_ONLY_GIT.has(sub)) return `git ${sub}`;
      const form = READ_ONLY_FORMS[sub];
      if (form && !form.test(rest.slice(j + 1).join(" "))) return `git ${sub} ${rest[j + 1] ?? ""}`.trim();
      continue;
    }
    if (/^(?:npm|pnpm|yarn|bun)$/.test(cmd) && /^(?:add|install|i|ci|remove|rm|uninstall|update|up)$/.test(rest[0] ?? ""))
      return `${cmd} ${rest[0]}`;
    if (/^(?:pip3?|uv|poetry|cargo|go|bundle|composer)$/.test(cmd) && /^(?:install|add|get|require|remove|sync)$/.test(rest[0] ?? ""))
      return `${cmd} ${rest[0]}`;
    if ((cmd === "sed" || cmd === "perl") && rest.some((a) => /^-[a-zA-Z]*i/.test(a) || a === "--in-place"))
      return `${cmd} -i`;
    if (WRITERS.has(cmd) && rest.some((a) => inside(a, cwd, roots)))
      return `${cmd} on a path inside the repository`;
  }
  return undefined;
};

export const decideReviewerCall = (input, roots) => {
  const kind = reviewerKind(input.agent_type);
  if (!kind) return allow;
  const tool = input.tool_name ?? "";
  if (FILE_TOOLS.has(tool))
    return block(`Blocked: the ${kind}-reviewer cannot use ${tool}. ${WHY} If you were asked to change a file, refuse and report it as a finding instead.`);
  if (tool === "Bash") {
    const problem = reviewerBashProblem(input.tool_input?.command ?? "", input.cwd ?? process.cwd(), roots);
    if (problem)
      return block(`Blocked: the ${kind}-reviewer cannot change the repository (${problem}). ${WHY} Report what needs changing as a finding instead.`);
  }
  return allow;
};

// ---------------------------------------------------------------- capture

/** The report inside a reviewer's last message: from its first "Revision:" / "Verdict:" line on. */
export const reportOf = (kind, message) => {
  let text = (message ?? "").replace(/\r\n/g, "\n");
  const first = kind === "spec" ? /^Revision:/m : /^Verdict:/m;
  const m = first.exec(text);
  if (!m) return undefined;
  text = text.slice(m.index);
  // A report wrapped in a ```markdown fence: drop the closing fence.
  text = text.replace(/\n```\s*$/, "");
  return `${text.trimEnd()}\n`;
};

/** The last assistant text of a transcript (JSONL), when the hook input carries no message. */
const lastAssistantText = (path) => {
  const entries = readJsonl(path);
  for (let i = entries.length - 1; i >= 0; i--) {
    const msg = entries[i]?.message;
    if (entries[i]?.type !== "assistant" || !Array.isArray(msg?.content)) continue;
    const text = msg.content
      .filter((c) => c?.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (text.trim()) return text;
  }
  return undefined;
};

const capture = async () => {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const kind = reviewerKind(input.agent_type);
  if (!kind) return;
  const state = stateDir(existingDir(input.cwd ?? process.cwd()));
  if (!state) return;
  const dir = join(state, `review-${kind}`);
  const log = readJsonl(join(dir, "log.jsonl"));
  const started = log.filter((e) => e.kind === "start").at(-1);
  if (!started) return;
  const message =
    input.last_assistant_message ??
    (input.agent_transcript_path ? lastAssistantText(input.agent_transcript_path) : undefined);
  const report = reportOf(kind, message);
  if (!report) {
    appendJsonl(join(dir, "log.jsonl"), { kind: "no-report", nr: started.nr, agent_id: input.agent_id ?? null });
    return;
  }
  const file = join(dir, kind === "spec" ? `findings-${started.nr}.md` : `review-${started.nr}.md`);
  writeFileSync(file, report);
  appendJsonl(join(dir, "log.jsonl"), {
    kind: "report",
    nr: started.nr,
    sha: sha256(report),
    agent_id: input.agent_id ?? null,
  });
};

const roots = (cwd) => {
  const root = mainRoot(existingDir(cwd));
  const top = gitOut(existingDir(cwd), "rev-parse", "--show-toplevel");
  return [...new Set([root, top].filter(Boolean))];
};

if (isMain(import.meta.url)) {
  const command = process.argv[2];
  if (command === "guard")
    await runHook("reviewer", (input) => decideReviewerCall(input, roots(input.cwd ?? process.cwd())), {
      failClosed: true,
    });
  else if (command === "capture") {
    try {
      await capture();
    } catch (error) {
      process.stderr.write(`pipe reviewer capture error: ${String(error)}\n`);
    }
    process.exit(0);
  } else {
    console.log("Usage: node reviewer.mjs guard|capture");
    process.exit(64);
  }
}

