// Stop hook: check before done. In a worktree on a dev/ branch, the check (the "Check:" line of
// AGENTS.md) must be green before the agent may finish its turn.
//
// Covered, exactly: every Stop event. Lets the agent stop when stop_hook_active is true (it was
// already sent back once: no loop), when the cwd's branch does not start with "dev/", or when
// specs/{nr}/progress.md of that worktree starts with "State: blocked". When AGENTS.md has no
// "Check:" line it blocks once with that message. Otherwise it runs the check in the worktree root:
// green lets it stop, red blocks the stop (exit 2) with the last 40 lines of the output on stderr.
// Not covered: SubagentStop, interrupts by the user, and API errors (those fire StopFailure).
import { join } from "node:path";
import { agentsLine, isMain, MISSING_CHECK, readText, sh } from "../lib/common.mjs";
import { allow, block, branchOf, runHook, toplevelOf } from "./lib.mjs";

export const RED = (check) =>
  `The check (${check}) is red: fix it before you stop. If you are reviewing, change no code: record it in review.md.`;

export const lastLines = (text, count) =>
  text.replace(/\n+$/, "").split("\n").slice(-count).join("\n");

export const decideStop = (input, deps) => {
  if (input.stop_hook_active === true) return allow;
  const cwd = input.cwd;
  if (!cwd) return allow;
  const branch = deps.branchOf(cwd);
  if (!branch.startsWith("dev/")) return allow;
  const root = deps.toplevelOf(cwd);
  if (!root) return allow;
  const progress = deps.readFile(join(root, "specs", branch.slice("dev/".length), "progress.md"));
  if (progress?.startsWith("State: blocked")) return allow;
  const check = agentsLine(deps.readFile(join(root, "AGENTS.md")), "Check");
  if (!check) return block(MISSING_CHECK);
  const { code, output } = deps.runCheck(root, check);
  if (code === 0) return allow;
  return block(`${RED(check)}\n${lastLines(output, 40)}`);
};

const realDeps = {
  branchOf,
  toplevelOf,
  readFile: readText,
  runCheck: (root, check) => sh(check, root),
};

if (isMain(import.meta.url))
  await runHook("check-before-done", (input) => decideStop(input, realDeps), { failClosed: false });
