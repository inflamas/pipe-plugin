// Shared by every script of the pipe plugin: git, the repository's AGENTS.md lines, the roadmap,
// worktrees, the asked-questions log and the event log. Plain Node.js, no dependencies.
//
// The decisions in each script are pure functions; this file is the thin layer that touches git and
// the file system.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- processes and files

/**
 * Runs a command without a shell. ok: exit 0. out: stdout, or stderr when stdout is empty, or why
 * the command could not start (not installed, timed out).
 */
export const run = (cmd, cwd, options = {}) => {
  const r = spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  const stdout = (r.stdout ?? "").trim();
  const stderr = (r.stderr ?? "").trim();
  const failed = r.error ? (r.error.code === "ENOENT" ? `${cmd[0]}: not installed` : String(r.error.message)) : "";
  return { ok: r.status === 0, code: r.status, out: stdout || stderr || failed, stdout, stderr };
};

/** Runs a command line through the shell, stdout and stderr together, in order. */
export const sh = (command, cwd, timeoutMs = 20 * 60 * 1000) => {
  const r = spawnSync("sh", ["-c", `${command} 2>&1`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return { code: r.status ?? 1, output: r.stdout ?? "" };
};

export const git = (cwd, ...args) => run(["git", ...args], cwd);
export const gitOut = (cwd, ...args) => {
  const r = git(cwd, ...args);
  return r.ok ? r.stdout : undefined;
};

/** A file's text at a revision, untrimmed; undefined when it does not exist there. */
export const show = (cwd, rev, path) => {
  const r = spawnSync("git", ["show", `${rev}:${path}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : undefined;
};

export const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

/** The nearest folder of `path` that exists: a file being created may live in a new folder. */
export const existingDir = (path) => {
  let dir = path;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
};

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export const lines = (text) => (text ?? "").split("\n").filter(Boolean);

export async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/** Prints "STOP: ..." and exits 3: the skill relays the message and ends the run. */
export function stop(message) {
  console.log(`STOP: ${message}`);
  process.exit(3);
}

// ---------------------------------------------------------------- text

export const normalize = (s) => String(s).replace(/\s+/g, " ").trim();

/** The answer as written after "Answer:", without the quotes around it. */
export const unquote = (s) => {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
};

export const leafStrings = (value) => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(leafStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(leafStrings);
  return [];
};

export const sameRevision = (a, b) =>
  !!a && !!b && a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));

/** The revision a review names: its "Revision: {rev}" line. */
export const reviewRevision = (review) =>
  review.match(/^\s*(?:[-*]\s*)?\**Revision\**\s*:\**\s*`?([0-9a-f]{4,40})`?/im)?.[1];

/** Story numbers: one to three digits, padded to two ("1" → "01", "101" stays). */
export const parseNr = (word) =>
  /^\d{1,3}$/.test(word ?? "") ? String(word).padStart(2, "0") : undefined;

export const words = (argv) => argv.flatMap((a) => a.split(/\s+/)).filter((a) => a !== "");

/** "--data <dir>" passes ${CLAUDE_PLUGIN_DATA} to a script; returns [value, rest]. */
export const takeOption = (argv, name) => {
  const all = words(argv);
  const i = all.indexOf(name);
  if (i < 0) return [undefined, all];
  return [all[i + 1], [...all.slice(0, i), ...all.slice(i + 2)]];
};

// ---------------------------------------------------------------- the roadmap

/**
 * A story's section: "## Story {nr}: ..." or "### Story {nr}: ..." (under an epic), up to the next
 * heading of the same or a higher level. undefined when the roadmap has no such story.
 */
export const storyIn = (roadmap, nr) => {
  const all = roadmap.split("\n");
  const start = all.findIndex((l) => new RegExp(`^#{2,3} Story ${nr}:`).test(l));
  if (start < 0) return undefined;
  const level = all[start].match(/^#+/)[0].length;
  const end = all.findIndex((l, i) => {
    if (i <= start) return false;
    const h = l.match(/^(#+) /);
    return h !== null && h[1].length <= level;
  });
  return all
    .slice(start, end < 0 ? undefined : end)
    .join("\n")
    .trim();
};

/** A story's title: "### Story 01: Walking skeleton" → "Walking skeleton"; undefined when missing. */
export const storyTitle = (roadmap, nr) =>
  storyIn(roadmap ?? "", nr)?.split("\n")[0].match(/^#{2,3} Story \d+:\s*(.+?)\s*$/)?.[1];

/** The "## Settled ..." section of the roadmap, or undefined. */
export const settledIn = (roadmap) => {
  const all = roadmap.split("\n");
  const start = all.findIndex((l) => /^## Settled/.test(l));
  if (start < 0) return undefined;
  const end = all.findIndex((l, i) => i > start && l.startsWith("## "));
  return all
    .slice(start, end < 0 ? undefined : end)
    .join("\n")
    .trim();
};

// ---------------------------------------------------------------- AGENTS.md

/**
 * The pipeline's lines in AGENTS.md, each "Name: value" at the start of a line:
 *   Check: <command>         required: the one check every skill and hook runs
 *   Install: <command>       optional: run once in a fresh worktree
 *   Run: <command>           optional: starts the app; {port} is replaced by a free port
 *   URL: <url>               optional: where the app opens; {port} as above
 *   Dependencies: <paths>    optional: the only manifests that may declare dependencies
 */
export const agentsLine = (agents, name) => {
  const m = (agents ?? "").match(new RegExp(`^${name}:[ \\t]*(.+?)[ \\t]*$`, "m"));
  const value = m?.[1]?.replace(/^`(.*)`$/, "$1").trim();
  return value ? value : undefined;
};

export const MISSING_CHECK =
  'AGENTS.md has no check line. Add one line "Check: <command>" (the one command that runs the typecheck, the lint and every test, and exits non-zero on any failure), or run /pipe:setup. Nothing runs without it.';

/** The check command from AGENTS.md in `dir`, or the reason it is missing. */
export const checkCommandIn = (dir) => {
  const agents = readText(join(dir, "AGENTS.md"));
  if (agents === undefined)
    return { error: `There is no AGENTS.md in ${dir}. ${MISSING_CHECK}` };
  const check = agentsLine(agents, "Check");
  return check ? { check, agents } : { error: MISSING_CHECK };
};

// ---------------------------------------------------------------- the repository and its worktrees

/** Every worktree git lists, the main checkout first. */
export const worktrees = (cwd) => {
  const out = [];
  for (const block of (gitOut(cwd, "worktree", "list", "--porcelain") ?? "").split("\n\n")) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) continue;
    out.push({ path, branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] });
  }
  return out;
};

/** The main checkout: the first worktree git lists. */
export const mainRoot = (cwd) => worktrees(cwd)[0]?.path;

export const branchExists = (cwd, branch) =>
  git(cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).ok;

/** The trunk: "main", else "master", else the branch the main checkout is on. */
export const trunkOf = (root) => {
  if (branchExists(root, "main")) return "main";
  if (branchExists(root, "master")) return "master";
  return gitOut(root, "branch", "--show-current") || "main";
};

export const WORKTREES = ".worktrees";

/** Every story branch has its worktree at .worktrees/{branch}, e.g. .worktrees/spec/01. */
export const worktreePath = (root, branch) => join(root, WORKTREES, ...branch.split("/"));

export const isIgnored = (root, rel) => git(root, "check-ignore", "-q", rel).ok;

/**
 * The repository a skill runs in: the main checkout, its trunk, and the check command from AGENTS.md
 * on the trunk. Stops with a clear message when any is missing.
 */
export const repoOrStop = (cwd) => {
  const root = mainRoot(cwd) ?? stop("Not inside a git repository. Run /pipe:setup first.");
  const trunk = trunkOf(root);
  const agents = show(root, trunk, "AGENTS.md");
  if (agents === undefined)
    stop(`${trunk} has no committed AGENTS.md. ${MISSING_CHECK}`);
  const check = agentsLine(agents, "Check") ?? stop(MISSING_CHECK);
  if (!isIgnored(root, `${WORKTREES}/x`))
    stop(
      `${WORKTREES}/ is not in .gitignore. Add the line "${WORKTREES}/" to .gitignore on ${trunk} (or run /pipe:setup): every story's worktree lives there.`,
    );
  return { root, trunk, agents, check };
};

/** git worktree add, with --relative-paths when this git has it: the links survive a moved mount. */
export const addWorktree = (root, path, args) => {
  const first = git(root, "worktree", "add", "--relative-paths", path, ...args);
  if (first.ok) return first;
  if (/relative-paths/.test(first.out)) return git(root, "worktree", "add", path, ...args);
  return first;
};

/**
 * Finds or creates the worktree of `branch`. Never recreates one: an existing worktree or branch is
 * reused. A new branch starts from an up-to-date trunk in the main checkout.
 */
export const ensureWorktree = (root, trunk, branch) => {
  const wt = worktreePath(root, branch);
  const registered = worktrees(root).some((w) => w.path === wt);
  let created = false;
  if (!registered) {
    if (existsSync(wt)) stop(`${wt} exists but is not a git worktree: look at it before going on.`);
    if (branchExists(root, branch)) {
      const r = addWorktree(root, wt, [branch]);
      if (!r.ok) stop(`Could not attach the existing ${branch} to ${wt}: ${r.out}`);
    } else {
      if (gitOut(root, "branch", "--show-current") !== trunk)
        stop(`The main checkout ${root} is not on ${trunk}.`);
      const upstream = gitOut(root, "rev-parse", "--abbrev-ref", `${trunk}@{upstream}`);
      if (upstream) {
        const behind = Number(gitOut(root, "rev-list", "--count", `${trunk}..${upstream}`) ?? "0");
        if (behind > 0)
          stop(`${trunk} is ${behind} commit(s) behind ${upstream}: bring ${trunk} up to date first.`);
      }
      const r = addWorktree(root, wt, ["-b", branch, trunk]);
      if (!r.ok) stop(`git worktree add failed: ${r.out}`);
      created = true;
    }
  }
  const onBranch = gitOut(wt, "branch", "--show-current");
  if (onBranch !== branch) stop(`${wt} is on "${onBranch}", not ${branch}.`);
  return { wt, created, fresh: !registered };
};

/**
 * In a fresh worktree, runs the Install line of AGENTS.md if there is one, then restores tracked
 * files it rewrote (a lockfile, say): that is not the story's change.
 */
export const installIn = (wt, agents) => {
  const install = agentsLine(agents, "Install");
  if (!install) return "no Install line in AGENTS.md: nothing installed";
  const r = sh(install, wt);
  if (r.code !== 0)
    stop(`The Install command (${install}) failed in ${wt}:\n${r.output.split("\n").slice(-20).join("\n")}`);
  git(wt, "checkout", "--", ".");
  return `ran: ${install}`;
};

/** The changed paths of a worktree, untracked files included. */
export const changedPaths = (root) =>
  // Untrimmed: the first line's status may start with a space (" M path").
  (spawnSync("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, encoding: "utf8" }).stdout ?? "")
    .split("\n")
    .filter((l) => l.length > 3)
    .flatMap((l) => l.slice(3).split(" -> "))
    .map((p) => p.replace(/^"|"$/g, ""));

// ---------------------------------------------------------------- state outside the worktrees

/** The pipeline's own state: <git common dir>/pipe. Shared by every worktree, never committed. */
export const stateDir = (cwd) => {
  const common = gitOut(existingDir(cwd), "rev-parse", "--path-format=absolute", "--git-common-dir");
  return common ? join(common, "pipe") : undefined;
};

export const appendJsonl = (path, entry) => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
};

export const readJsonl = (path) =>
  (readText(path) ?? "")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });

/**
 * Where AskUserQuestion calls are logged: <git common dir>/pipe/asks.jsonl in a repository, and
 * <plugin data>/asks/<hash of the folder>.jsonl in a folder that is not one yet (/pipe:roadmap runs
 * in an empty folder).
 */
export const asksLogPaths = (cwd, pluginData) => {
  const out = [];
  const state = stateDir(cwd);
  if (state) out.push(join(state, "asks.jsonl"));
  if (pluginData) {
    let real = cwd;
    try {
      real = realpathSync(existingDir(cwd));
    } catch {}
    out.push(join(pluginData, "asks", `${sha256(real).slice(0, 16)}.jsonl`));
  }
  return out;
};

/** Every logged AskUserQuestion call for this folder: { branch, cwd, at, tool_input, tool_response }. */
export const readAsks = (cwd, pluginData) =>
  asksLogPaths(cwd, pluginData).flatMap((p) => readJsonl(p));

/** One logged call as plain strings, for word-for-word checks. */
export const askStrings = (entry) => leafStrings([entry.tool_input, entry.tool_response]);

/** The questions of a logged call, and the user's answer to each, normalized. */
export const askOf = (entry) => {
  const qs = entry.tool_input?.questions;
  const questions = Array.isArray(qs) ? qs.map((q) => normalize(String(q?.question ?? ""))) : [];
  const answers = new Map();
  for (const source of [entry.tool_input, entry.tool_response]) {
    const a = source?.answers;
    if (a && typeof a === "object")
      for (const [q, v] of Object.entries(a))
        answers.set(normalize(q), normalize(Array.isArray(v) ? v.join(", ") : String(v)));
  }
  return { questions, answers };
};

/**
 * One event per line, shared by every piece of the pipeline:
 * {"ticket","step","event":"start|end|stop|denied|limit|push","time","outcome","turns","cost_usd"}.
 * A push's outcome is the URL of the branch's pull request.
 * Written to <git common dir>/pipe/events.jsonl; never fails the caller.
 */
export const event = (cwd, entry) => {
  try {
    const dir = stateDir(cwd);
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    const line = {
      ticket: entry.ticket ?? null,
      step: entry.step,
      event: entry.event,
      time: new Date().toISOString(),
      outcome: entry.outcome ?? null,
      turns: entry.turns ?? null,
      cost_usd: entry.cost_usd ?? null,
    };
    appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify(line)}\n`);
  } catch {}
};

/** True when the module at `metaUrl` is the script node was started with. */
export const isMain = (metaUrl) => {
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
};
