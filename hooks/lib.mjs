// Shared by the hooks in this folder: the decision type, the stdin wrapper and the git lookups. The
// decision logic itself lives in each hook as a pure function.
import { isAbsolute, resolve } from "node:path";
import { event, existingDir, gitOut, readStdin } from "../lib/common.mjs";

export const allow = { allow: true };
export const block = (reason) => ({ allow: false, reason });

export const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** The absolute path a file tool targets, or undefined when the call carries none. */
export const targetPath = (input) => {
  const path = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!path) return undefined;
  return isAbsolute(path) ? path : resolve(input.cwd ?? process.cwd(), path);
};

/** `git branch --show-current` in the nearest existing folder; "" outside git or detached. */
export const branchOf = (dir) => gitOut(existingDir(dir), "branch", "--show-current") ?? "";

/** `dir` relative to the root of its worktree, e.g. "packages/api/"; "" at the root or outside git. */
export const prefixOf = (dir) => gitOut(existingDir(dir), "rev-parse", "--show-prefix") ?? "";

/** The root of the worktree holding `dir`; "" outside git. */
export const toplevelOf = (dir) => gitOut(existingDir(dir), "rev-parse", "--show-toplevel") ?? "";

/** The story a branch belongs to: "dev/01" → "01". */
export const ticketOf = (branch) => branch.match(/^[a-z]+\/(\d+)$/)?.[1] ?? null;

/**
 * Reads the hook input from stdin, decides, and exits: 0 lets the call (or the stop) go ahead, 2
 * blocks it with the reason on stderr. When the input cannot be read, a PreToolUse hook blocks
 * (failClosed) and the Stop hook lets the agent stop, so a broken hook never traps it in a loop.
 */
export async function runHook(step, decide, { failClosed }) {
  let input = {};
  let decision;
  try {
    const text = await readStdin();
    input = text.trim() ? JSON.parse(text) : {};
    decision = decide(input);
  } catch (error) {
    if (!failClosed) process.exit(0);
    decision = block(`Blocked: the ${step} hook could not decide (${String(error)}).`);
  }
  if (decision.allow) process.exit(0);
  const cwd = input.cwd ?? process.cwd();
  event(cwd, {
    ticket: ticketOf(branchOf(cwd)),
    step,
    event: input.hook_event_name === "Stop" ? "stop" : "denied",
    outcome: decision.reason.split("\n")[0].slice(0, 200),
  });
  process.stderr.write(`${decision.reason}\n`);
  process.exit(2);
}
