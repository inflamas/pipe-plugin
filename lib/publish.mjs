// The last step of /pipe:review-spec, /pipe:review-dev, /pipe:learn and /pipe:improve: push the
// story's own branch to origin and open its pull request, or reuse the one already open. A person
// merges it, and merging is the approval.
//
// Each command is checked against the no-merge hook's rule before it runs, so the script can run
// nothing the hook would block. A push or a pull request that fails (no remote, no login, no network,
// gh not installed) is reported in one line with the exact command for a person to run; it never
// retries and never fails the skill. A push writes the event "push" with the pull request's URL.
import { decideNoMerge } from "../hooks/no-merge.mjs";
import { event, gitOut, run } from "./common.mjs";

/** One word as the shell reads it back: plain, or in single quotes. */
export const shellQuote = (word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);
export const commandLine = (argv) => argv.map(shellQuote).join(" ");

/**
 * The web address of a remote, for links in a pull request: git@host:o/r.git, ssh://git@host/o/r.git
 * and https://host/o/r.git all give https://host/o/r. undefined for a local path.
 */
export const webUrlOf = (remote) => {
  const r = (remote ?? "").trim().replace(/\.git$/, "");
  const scp = r.match(/^[\w.-]+@([\w.-]+):(?!\/)(.+)$/);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const url = r.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+)$/);
  return url ? `https://${url[1]}/${url[2]}` : undefined;
};

/** A link to a file on the branch, or its path when the remote has no web address. */
export const fileLink = (remote, branch, path) => {
  const web = webUrlOf(remote);
  return web ? `[${path}](${web}/blob/${branch}/${path})` : path;
};

const firstLine = (text) => (text ?? "").split("\n").find((l) => l.trim() !== "")?.trim().slice(0, 160) ?? "no output";
const urlIn = (text) => (text ?? "").match(/https?:\/\/\S+/g)?.at(-1);

const QUIET = {
  timeout: 120_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
};

/**
 * Pushes `branch` from its worktree `wt` and opens its pull request against `trunk`, or reuses the
 * open one. Returns { lines, pushed, url }; it never throws and never exits.
 */
export const publish = ({ wt, nr, step, branch, trunk, title, body }) => {
  const gh = process.env.PIPE_GH || "gh";
  const push = ["git", "push", "-u", "origin", branch];
  const create = ["gh", "pr", "create", "--head", branch, "--base", trunk, "--title", title, "--body", body];
  const forPerson = (argv) => `cd ${shellQuote(wt)} && ${commandLine(argv)}`;
  for (const argv of [push, create]) {
    const d = decideNoMerge({ tool_name: "Bash", tool_input: { command: commandLine(argv) }, cwd: wt });
    if (!d.allow) return { pushed: false, lines: [`publish: nothing pushed. ${d.reason}`] };
  }

  if (gitOut(wt, "remote", "get-url", "origin") === undefined)
    return { pushed: false, lines: [`push: not pushed (this repository has no remote "origin"). A person can run: ${forPerson(push)}`] };
  const pushed = run(push, wt, QUIET);
  if (!pushed.ok)
    return { pushed: false, lines: [`push: not pushed (${firstLine(pushed.out)}). A person can run: ${forPerson(push)}`] };
  const lines = [`pushed: ${branch} to origin at ${gitOut(wt, "rev-parse", "--short", "HEAD")}`];

  let url;
  const view = run([gh, "pr", "view", branch, "--json", "url,state"], wt, QUIET);
  if (view.ok) {
    try {
      const pr = JSON.parse(view.stdout);
      if (pr.state === "OPEN") url = pr.url;
    } catch {}
  }
  if (url) lines.push(`pull request: ${url} (already open: reused)`);
  else {
    const made = run([gh, ...create.slice(1)], wt, QUIET);
    url = made.ok ? urlIn(made.stdout) : undefined;
    lines.push(
      url
        ? `pull request: ${url} (opened)`
        : `pull request: not opened (${firstLine(made.out)}). A person can run: ${forPerson(create)}`,
    );
  }
  event(wt, { ticket: nr, step, event: "push", outcome: url ?? "pushed; no pull request" });
  return { pushed: true, url, lines };
};

/** The remote origin's address, for links; undefined when there is none. */
export const originOf = (wt) => gitOut(wt, "remote", "get-url", "origin");
