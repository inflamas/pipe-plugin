// PreToolUse hook: the spec gate. An approved spec (specs/{nr}/spec.md on the trunk) is the
// implementation contract; it is written only on a spec/ branch and changes only through a merge.
//
// Covered, exactly (anything not on this list is NOT covered):
//   Write, Edit, MultiEdit, NotebookEdit whose file path ends in specs/{folder}/spec.md:
//     allowed only when `git branch --show-current` in the file's nearest existing folder starts
//     with "spec/"; blocked on the trunk, on dev/ branches, on a detached HEAD and outside git.
//   Bash with a > or >> redirect whose target is a spec.md.
//   Bash whose command names "spec.md" literally AND contains any of:
//     tee, sed -i / --in-place,
//     perl -i, mv, cp, rm, truncate, git mv, git rm, git checkout ... --, git restore,
//     or an inline python/node/bun/deno/ruby/perl script (-c, -e, --eval, -p, --print, or a heredoc).
//     This is a co-occurrence check on the whole command, regardless of branch: `cat spec.md | tee x`
//     is blocked too. Use Write/Edit on a spec/ branch instead.
//   Bash that runs rm, mv, git rm or git mv on a folder under specs/ (a specs/... argument whose last
//     segment has no file extension, ends in "/", or contains a * glob), and on specs itself.
// The command is read as the shell parses it: a heredoc body and text inside quotes hold no redirect
// (`git commit -m "a <b@c>"` and `cat >> brainstorm.md <<'EOF' ... spec.md ... EOF` are allowed).
// Not covered: a spec.md reached without naming it (globs like sp*c.md, shell variables), scripts in
// files, MCP tools, and anything a person does in their own terminal.
// Allowed: reading (cat, grep, git diff, git log, ...), git add, git commit.
import { dirname } from "node:path";
import { isMain } from "../lib/common.mjs";
import { allow, block, branchOf, FILE_TOOLS, maskShell, runHook, targetPath } from "./lib.mjs";

const WHY = "An approved spec changes only through a spec merge, and a person merges.";

const SPEC_PATH = /(^|\/)specs\/[^/]+\/spec\.md$/;
const NAMES_SPEC = /(?:^|[^\w-])spec\.md(?![\w.])/;

const word = (name) => new RegExp(`(?:^|[\\s;&|(\`])${name}(?=\\s|$)`);
const gitSub = (sub) => new RegExp(`\\bgit\\s+(?:-C\\s+\\S+\\s+)?${sub}(?![\\w-])`);
const before = "(?:^|[\\s;&|(`])";
const args = "(?:[^;&|\\n]*\\s)?";

/** The targets of the > and >> redirects of a masked command (no /dev/null, no >& duplication). */
export const redirectTargets = (masked) =>
  Array.from(masked.matchAll(/(?<![=\->])\d*>>?(?![&>])\s*([^\s;&|)]*)/g))
    .map((m) => m[1].replace(/^["']|["']$/g, ""))
    .filter((t) => t !== "/dev/null");

const MUTATORS = [
  ["tee", (c) => word("tee").test(c)],
  ["sed -i", (c) => new RegExp(`${before}sed\\s${args}(?:-[a-zA-Z]*i|--in-place)`).test(c)],
  ["perl -i", (c) => new RegExp(`${before}perl\\s${args}-[a-zA-Z]*i`).test(c)],
  ["git mv", (c) => gitSub("mv").test(c)],
  ["git rm", (c) => gitSub("rm").test(c)],
  ["git checkout --", (c) => /\bgit\s+(?:-C\s+\S+\s+)?checkout\b[^;&|\n]*\s--(?:\s|$)/.test(c)],
  ["git restore", (c) => gitSub("restore").test(c)],
  ["mv", (c) => word("mv").test(c)],
  ["cp", (c) => word("cp").test(c)],
  ["rm", (c) => word("rm").test(c)],
  ["truncate", (c) => word("truncate").test(c)],
  [
    "an inline script",
    (c) =>
      new RegExp(
        `${before}(?:python[\\d.]*|node|bun|deno|ruby|perl)\\s${args}(?:-c|-e|--eval|-p|--print)(?=\\s|$)`,
      ).test(c) ||
      new RegExp(`${before}(?:python[\\d.]*|node|bun|deno|ruby|perl)\\b[^;&|\\n]*<<`).test(c),
  ],
];

const unquote = (token) => token.replace(/^["']|["']$/g, "");

const isSpecsFolder = (token) => {
  const path = unquote(token).replace(/^\.\//, "");
  if (!/(^|\/)specs(\/|$)/.test(path)) return false;
  if (path.includes("*") || path.endsWith("/")) return true;
  return !(path.split("/").pop() ?? "").includes(".");
};

/** rm, mv, git rm or git mv with a folder under specs/ (or specs itself) as an argument. */
const removesSpecsFolder = (command) =>
  command.split(/[;&|\n]+/).some((segment) => {
    const tokens = segment.trim().split(/\s+/);
    const at = tokens.findIndex((t) => t === "rm" || t === "mv");
    if (at < 0) return false;
    return tokens.slice(at + 1).some((t) => !t.startsWith("-") && isSpecsFolder(t));
  });

export const decideSpecGate = (input, branch) => {
  if (input.tool_name && FILE_TOOLS.has(input.tool_name)) {
    const path = targetPath(input);
    if (!path || !SPEC_PATH.test(path)) return allow;
    const current = branch(dirname(path));
    if (current.startsWith("spec/")) return allow;
    const where = current ? `on branch "${current}"` : "outside any branch";
    return block(
      `Blocked: ${path} is ${where}, not on a spec/ branch; there the spec is the approved contract. ${WHY}`,
    );
  }
  if (input.tool_name === "Bash") {
    const command = input.tool_input?.command ?? "";
    const masked = maskShell(command);
    if (redirectTargets(masked).some((t) => /(?:^|\/)spec\.md$/.test(t)))
      return block(`Blocked: this command redirects into a spec.md. ${WHY}`);
    if (removesSpecsFolder(masked))
      return block(`Blocked: this command removes or moves a folder under specs/. ${WHY}`);
    if (!NAMES_SPEC.test(command)) return allow;
    const hit = MUTATORS.find(([name, test]) => test(name === "an inline script" ? command : masked));
    if (hit) return block(`Blocked: this command can change a spec.md (${hit[0]}). ${WHY}`);
  }
  return allow;
};

if (isMain(import.meta.url))
  await runHook("spec-gate", (input) => decideSpecGate(input, branchOf), { failClosed: true });
