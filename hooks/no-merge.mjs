// PreToolUse hook: agents never merge. A skill pushes only its own story branch and opens its pull
// request; a person merges, and merging is the approval.
//
// Allowed, exactly these two, each as a plain command of its own (it may be chained with others):
//   git push -u origin {branch}   or   git push origin {branch}
//   gh pr create --head {branch} --base {trunk} [--title …] [--body …] [other flags but --repo]
// where {branch} is spec/{nr}, dev/{nr}, learn/{nr} or improve/{nr} and is the branch checked out in
// the folder the command runs in (the hook's cwd, or git's -C {dir}). --set-upstream counts as -u.
//
// Blocked: git merge; any other git push (to the trunk, another story's branch, any remote but
// origin, a refspec with a colon or a +, --force, --force-with-lease, -f, --delete, --mirror, --all,
// --tags or any other flag, git global options other than -C and --no-pager); gh pr merge; gh pr
// review --approve (-a); any other gh pr create (no --head, another head, another base, --repo); and
// a git push, git merge or gh pr merge/create inside a quoted string, backticks, `sh -c` or a heredoc.
// Allowed: git merge-base, creating and switching branches, and every other command.
// Not covered: git pull (fetch + merge), git rebase, git cherry-pick, git aliases, gh api, scripts
// in files, and anything a person does in their own terminal.
import { resolve } from "node:path";
import { existingDir, isMain, mainRoot, trunkOf } from "../lib/common.mjs";
import { allow, block, branchOf, runHook, shellSegments } from "./lib.mjs";

const RULE =
  "Agents never merge. A skill pushes only its own story branch and opens its pull request; a person merges, and merging is the approval.";

/** The branches a skill may push: one story's branch of one step. */
export const STORY_BRANCH = /^(?:spec|dev|learn|improve)\/\d{2,3}$/;

const GIT_MERGE_OR_PUSH =
  /\bgit(?:\s+(?:-C|-c|--git-dir|--work-tree)\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+(merge|push)(?![\w-])/;
const GH_PR = /\bgh\s+pr\s+(merge|create|review)(?![\w-])/;

const realDeps = {
  branchOf,
  trunkOf: (dir) => {
    const root = mainRoot(existingDir(dir));
    return root ? trunkOf(root) : undefined;
  },
};

const blocked = (why) => block(`Blocked: ${why} ${RULE}`);

/** The words of a command after leading VAR=value assignments. */
const commandWords = (words) => {
  let i = 0;
  while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++;
  return words.slice(i);
};

/** The value of a flag given as "--name value", "--name=value" or "-x value". */
const flagValue = (args, long, short) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === long || (short && args[i] === short)) return args[i + 1] ?? "";
    if (args[i].startsWith(`${long}=`)) return args[i].slice(long.length + 1);
  }
  return undefined;
};

const decidePush = (args, dir, deps) => {
  const rest = args.filter((a) => a !== "-u" && a !== "--set-upstream");
  const flag = rest.find((a) => a.startsWith("-"));
  if (flag) return blocked(`git push ${flag}: a skill pushes with "git push -u origin {branch}" and no other flag.`);
  if (rest.length !== 2) return blocked('a push names exactly the remote and the branch: "git push -u origin {branch}".');
  const [remote, ref] = rest;
  if (remote !== "origin") return blocked(`a push goes only to origin, not to "${remote}".`);
  if (ref.includes(":") || ref.startsWith("+")) return blocked(`a push names the branch itself, not the refspec "${ref}".`);
  const branch = deps.branchOf(dir);
  if (!STORY_BRANCH.test(branch))
    return blocked(`a push runs only in a story's worktree (spec/, dev/, learn/ or improve/{nr}); this one is on "${branch || "no branch"}".`);
  if (ref !== branch) return blocked(`this worktree is on ${branch}: it pushes only ${branch}, not ${ref}.`);
  return allow;
};

const decideGit = (words, cwd, deps) => {
  let dir = cwd;
  let i = 1;
  for (; i < words.length && words[i].startsWith("-"); i++) {
    if (words[i] === "-C") dir = resolve(dir, words[++i] ?? "");
    else if (words[i] !== "--no-pager") return blocked(`git ${words[i]} before a push or merge is not allowed.`);
  }
  const sub = words[i];
  if (sub === "merge") return blocked("agents never run git merge.");
  if (sub === "push") return decidePush(words.slice(i + 1), dir, deps);
  return allow;
};

const decideGh = (words, cwd, deps) => {
  if (words[1] !== "pr") return allow;
  const sub = words[2];
  const args = words.slice(3);
  if (sub === "merge") return blocked("agents never run gh pr merge.");
  if (sub === "review")
    return args.some((a) => a === "--approve" || a.startsWith("--approve=") || /^-[A-Za-z]*a/.test(a))
      ? blocked("agents never approve a pull request: the merge is the approval.")
      : allow;
  if (sub !== "create") return allow;
  if (flagValue(args, "--repo", "-R") !== undefined) return blocked("gh pr create --repo: a pull request is opened only in this repository.");
  const head = flagValue(args, "--head", "-H");
  const base = flagValue(args, "--base", "-B");
  const branch = deps.branchOf(cwd);
  if (!STORY_BRANCH.test(branch))
    return blocked(`a pull request is opened only from a story's worktree; this one is on "${branch || "no branch"}".`);
  if (head !== branch) return blocked(`gh pr create needs --head ${branch}, the branch checked out here.`);
  const trunk = deps.trunkOf(cwd);
  if (!trunk || base !== trunk) return blocked(`gh pr create needs --base ${trunk ?? "{the trunk}"}.`);
  return allow;
};

export const decideNoMerge = (input, deps = realDeps) => {
  if (input.tool_name !== "Bash") return allow;
  const command = input.tool_input?.command ?? "";
  const cwd = input.cwd ?? process.cwd();
  const hits = (text) => GIT_MERGE_OR_PUSH.test(text) || GH_PR.test(text);
  let seen = false;
  for (const segment of shellSegments(command)) {
    const text = segment.join(" ");
    if (!hits(text)) continue;
    seen = true;
    const words = commandWords(segment);
    const decision =
      words[0] === "git"
        ? decideGit(words, cwd, deps)
        : words[0] === "gh"
          ? decideGh(words, cwd, deps)
          : blocked(`"${text.slice(0, 80)}" runs git push, git merge or gh pr inside another command: run it as a plain command.`);
    if (!decision.allow) return decision;
  }
  // Named only where no command of its own runs it, e.g. in a heredoc fed to a shell: fail closed.
  if (!seen && hits(command))
    return blocked("the command names git push, git merge or gh pr where it does not run as a plain command (a heredoc or a script).");
  return allow;
};

if (isMain(import.meta.url))
  await runHook("no-merge", decideNoMerge, { failClosed: true });
