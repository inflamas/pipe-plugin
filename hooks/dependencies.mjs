// PreToolUse hook: the dependency rule. Dependencies are declared only in the manifests the
// repository allows: the "Dependencies:" line of AGENTS.md lists them (comma-separated paths from the
// repository root); without that line, only the manifests at the repository root.
//
// Covered, exactly (anything not on this list is NOT covered):
//   Write, Edit, MultiEdit whose file is a dependency manifest (package.json, pyproject.toml,
//     requirements*.txt, Pipfile, go.mod, Cargo.toml, Gemfile, composer.json, pom.xml,
//     build.gradle(.kts), *.csproj, mix.exs, pubspec.yaml, deno.json) at a path the rule does not
//     allow. Every edit to such a file is blocked, not only edits to its dependency fields.
//   Bash that installs or adds a package (npm/pnpm/yarn/bun add|install|i, pip install, uv add,
//     poetry add, cargo add, go get, bundle add, composer require, dotnet add package) AND targets
//     another folder: --cwd, --filter, --prefix, --workspace / -w, -C, --manifest-path, `cd` into a
//     subfolder, or a Bash cwd below the repository root, unless that folder holds an allowed
//     manifest.
// Not covered: editing a manifest any other way (sed, a script), npx/bunx/pipx, and anything a person
// does in their own terminal. Installs from the repository root stay allowed; a new dependency is a
// finding for the review ("adds a dependency" goes to a person).
import { dirname, join, relative } from "node:path";
import { agentsLine, isMain, readText } from "../lib/common.mjs";
import { allow, block, FILE_TOOLS, prefixOf, runHook, targetPath, toplevelOf } from "./lib.mjs";

const MANIFEST =
  /(?:^|\/)(?:package\.json|pyproject\.toml|requirements[\w.-]*\.txt|Pipfile|go\.mod|Cargo\.toml|Gemfile|composer\.json|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.csproj|mix\.exs|pubspec\.yaml|deno\.jsonc?)$/;

const INSTALL =
  /(?:^|[\s;&|(`])(?:(?:bun|npm|pnpm|yarn)\b[^;&|\n]*\s(?:add|install|i)(?=\s|$)|pip3?\s+install\b|uv\s+(?:add|pip\s+install)\b|poetry\s+add\b|cargo\s+add\b|go\s+get\b|bundle\s+add\b|composer\s+require\b|dotnet\s+add\b[^;&|\n]*\spackage\b)/;

const TARGETS_ELSEWHERE = [
  /(?:^|\s)--(?:cwd|filter|prefix|workspace|manifest-path|directory)(?:=|\s|$)/,
  /(?:^|\s)-w(?:\s|$)/,
  /(?:^|\s)-C\s/,
  /\bcd\s+["']?(?!\.?\/?["']?(?:\s|$|&|;))[^\s;&|]+/,
];

/** The folders (relative to the repository root, "" for the root) that may declare dependencies. */
export const allowedFolders = (dependenciesLine) =>
  dependenciesLine
    ? dependenciesLine
        .split(/[,\s]+/)
        .filter(Boolean)
        .map((p) => {
          const d = dirname(p.replace(/^\.\//, ""));
          return d === "." ? "" : d;
        })
    : [""];

const rule = (line) =>
  line
    ? `Dependencies are declared only in ${line} (the "Dependencies:" line of AGENTS.md).`
    : 'Dependencies are declared only in the manifests at the repository root (AGENTS.md has no "Dependencies:" line).';

/**
 * `facts(dir)` gives the repository root of `dir`, `dir` relative to it, and AGENTS.md's
 * "Dependencies:" line there.
 */
export const decideDependencies = (input, facts) => {
  if (input.tool_name && FILE_TOOLS.has(input.tool_name)) {
    const path = targetPath(input);
    if (!path || !MANIFEST.test(path)) return allow;
    const f = facts(dirname(path));
    if (!f.root) return allow;
    const rel = relative(f.root, path);
    const folder = dirname(rel) === "." ? "" : dirname(rel);
    const allowed = f.line
      ? f.line
          .split(/[,\s]+/)
          .filter(Boolean)
          .map((p) => p.replace(/^\.\//, ""))
          .includes(rel)
      : folder === "";
    if (allowed) return allow;
    return block(`Blocked: ${rel} is not a manifest that may declare dependencies. ${rule(f.line)}`);
  }
  if (input.tool_name === "Bash") {
    const command = input.tool_input?.command ?? "";
    if (!INSTALL.test(command)) return allow;
    const f = facts(input.cwd ?? process.cwd());
    const folders = allowedFolders(f.line);
    if (folders.some((d) => d !== "")) return allow; // several places allowed: the review judges it
    if (TARGETS_ELSEWHERE.some((re) => re.test(command)))
      return block(`Blocked: this install targets another folder than the root. ${rule(f.line)}`);
    if (f.prefix !== "")
      return block(`Blocked: this install runs inside ${f.prefix}. ${rule(f.line)} Run it from the root.`);
  }
  return allow;
};

const realFacts = (dir) => {
  const root = toplevelOf(dir);
  return {
    root,
    prefix: root ? prefixOf(dir) : "",
    line: root ? agentsLine(readText(join(root, "AGENTS.md")), "Dependencies") : undefined,
  };
};

if (isMain(import.meta.url))
  await runHook("dependencies", (input) => decideDependencies(input, realFacts), { failClosed: true });
