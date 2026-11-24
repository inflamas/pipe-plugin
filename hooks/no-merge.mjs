// PreToolUse hook: no merge, no push. Merging is the approval, for the spec and for the code, so
// only a person merges, locally, after approving; agents never merge and never push.
//
// Covered, exactly (anything not on this list is NOT covered):
//   Bash whose command runs `git merge` or `git push` (also after git global options such as
//   -C {dir}, -c k=v, --no-pager) or `gh pr merge`.
// Allowed: git merge-base, creating and switching branches (git branch, git switch, git checkout -b,
// git worktree add), and every other command.
// Not covered: git pull (fetch + merge), git rebase, git cherry-pick, git aliases, scripts in files,
// and anything a person does in their own terminal.
import { isMain } from "../lib/common.mjs";
import { allow, block, runHook } from "./lib.mjs";

const WHY = "A person merges, locally, after approving.";

const GIT_MERGE_OR_PUSH =
  /\bgit(?:\s+(?:-C|-c|--git-dir|--work-tree)\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+(merge|push)(?![\w-])/;
const GH_PR_MERGE = /\bgh\s+pr\s+merge(?![\w-])/;

export const decideNoMerge = (input) => {
  if (input.tool_name !== "Bash") return allow;
  const command = input.tool_input?.command ?? "";
  const git = command.match(GIT_MERGE_OR_PUSH);
  if (git) return block(`Blocked: agents never run git ${git[1]}. ${WHY}`);
  if (GH_PR_MERGE.test(command)) return block(`Blocked: agents never run gh pr merge. ${WHY}`);
  return allow;
};

if (isMain(import.meta.url))
  await runHook("no-merge", decideNoMerge, { failClosed: true });
