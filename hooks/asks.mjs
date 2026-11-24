// PostToolUse hook on AskUserQuestion: logs every question and the answer the user gave, so each
// skill can check its record (brainstorm.md, spec-review.md, setup.md, roadmap-brainstorm.md, ...)
// word for word against what was really asked and answered.
//
// The log is <git common dir>/pipe/asks.jsonl in a repository, and
// ${CLAUDE_PLUGIN_DATA}/asks/<hash of the folder>.jsonl in a folder that is not a repository yet.
// Each line: {"branch","cwd","tool_input","tool_response","at"}. It never blocks.
import { appendJsonl, asksLogPaths, existingDir, gitOut, isMain, readStdin } from "../lib/common.mjs";

if (isMain(import.meta.url)) {
  try {
    const input = JSON.parse(await readStdin());
    if (input.tool_name === "AskUserQuestion") {
      const cwd = existingDir(input.cwd ?? process.cwd());
      const [path] = asksLogPaths(cwd, process.env.CLAUDE_PLUGIN_DATA);
      if (path)
        appendJsonl(path, {
          branch: gitOut(cwd, "branch", "--show-current") ?? "",
          cwd,
          tool_input: input.tool_input,
          tool_response: input.tool_response,
        });
    }
  } catch (error) {
    process.stderr.write(`pipe asks log error: ${String(error)}\n`);
  }
  process.exit(0);
}
