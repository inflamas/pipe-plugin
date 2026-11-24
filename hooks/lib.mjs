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

/**
 * The command as the shell parses its operators: heredoc bodies dropped, and inside quotes the
 * characters < > | ; & blanked (there they are text, never a redirect or a separator). The words
 * themselves stay, so a quoted path is still seen.
 */
export const maskShell = (command) =>
  dropHeredocBodies(command).replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/[<>|;&]/g, " "));

/** The command without the bodies of its heredocs: they are data, never a command. */
export const dropHeredocBodies = (command) => {
  const kept = [];
  let end;
  for (const line of command.split("\n")) {
    if (end !== undefined) {
      if (line.trim() === end) end = undefined;
      continue;
    }
    kept.push(line);
    const h = line.match(/<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/);
    if (h) end = h[2];
  }
  return kept.join("\n");
};

/**
 * The simple commands of a command line, each as its words, the way the shell splits them: quotes
 * removed, backslash escapes applied, redirections and their targets dropped, heredoc bodies and
 * comments dropped. Separators: ; & && | || newline ( ). A word that holds a command substitution
 * keeps it as text, so `echo $(git push)` stays one command whose first word is "echo".
 */
export const shellSegments = (command) => {
  const text = dropHeredocBodies(command);
  const segments = [];
  let words = [];
  let word = "";
  let inWord = false;
  let dropNext = false;
  const endWord = () => {
    if (inWord) {
      if (dropNext) dropNext = false;
      else words.push(word);
    }
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const to = close < 0 ? text.length : close;
      word += text.slice(i + 1, to);
      inWord = true;
      i = to;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === "\\" && '"\\$`\n'.includes(text[i + 1] ?? "")) i++;
        word += text[i];
      }
    } else if (c === "\\") {
      if (text[i + 1] === "\n") i++;
      else if (i + 1 < text.length) {
        word += text[++i];
        inWord = true;
      }
    } else if (c === "#" && !inWord) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if (c === ">" || c === "<" || (c === "&" && text[i + 1] === ">")) {
      // A redirection: a file descriptor number before it belongs to it, and the next word is its target.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      while (i + 1 < text.length && "<>&|".includes(text[i + 1])) i++;
      if (text.slice(i - 1, i + 1) === "<<" && text[i + 1] === "-") i++;
      dropNext = true;
    } else if (c === ";" || c === "\n" || c === "&" || c === "|" || c === "(" || c === ")") {
      endSegment();
    } else if (c === " " || c === "\t") {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return segments;
};

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
