---
name: setup
description: Lead a team through setting up its new repository for the pipe pipeline, in rounds of AskUserQuestion (stack and why, modules and what each owns, UI rules, the domain rules nobody may guess, the check command, and the first tickets only if there is no roadmap), recording every question and answer in specs/setup.md, then writing AGENTS.md with the Check line, specs/guidelines/, specs/roadmap.md and .gitignore, and running the check. Keeps an existing roadmap unchanged. Use for /pipe:setup.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/setup.mjs" *)
---

# /pipe:setup

You lead the team through setting up its repository. **You ask; the team answers; you write only what it answered.** You have no defaults of your own: you recommend an answer in every round, but nothing reaches a file unless the team gave it. Every question goes through AskUserQuestion, never plain chat. The plugin logs every call, and `verify` checks your record against that log word for word, and checks that every line you write into AGENTS.md is one of the team's answers.

## 0. Start

```bash
node "${CLAUDE_SKILL_DIR}/scripts/setup.mjs" start --data "${CLAUDE_PLUGIN_DATA}"
```

- **`STOP: …`:** relay it and end the run (the folder is not a git repository yet).
- Otherwise it prints what exists. Read `pipeline.md` and `specs/roadmap.md` if present: their decisions shape your recommendations (`pipeline.md` block 7 names the check). **An existing roadmap stays unchanged:** don't edit it, and don't ask for tickets. If `specs/setup.md` exists, continue it: keep every answer, ask only what is open. Read the code if there is any.

## 1. The rounds

One AskUserQuestion call per round, 1 to 4 questions, each standing on its own ("Setup, round 2: …"), each with 2 to 4 options, your recommendation first with "(Recommended)" at the end of its label. The team can always answer in its own words through "Other". Wait for the answers, record the round (section 2), read it back in one line, then ask the next round.

1. **Stack and why.** The language and runtime, the main frameworks, the test runner, and why the team picks them (offer the reasons that apply: what the team knows, what the product needs, what it costs). Recommend from `pipeline.md` and the code, if any.
2. **Modules and what each owns.** The parts of the repository (folders, packages, services) and what each one owns and must not do; where dependencies are declared (only the root manifest, or which manifests); where tests live.
3. **UI rules,** only if there is a screen: ask first whether there is one. Then the widths it must work at, the design tokens or the style source, the one accent, what is never allowed (horizontal scroll, clipped text, …), and how the app starts for a browser (the command, with `{port}` where the port goes, and its URL).
4. **The domain rules nobody may guess.** The rules of the product that an agent would otherwise make up: names, numbers, limits, time zones, money, states. Offer the questions the stack and the tickets raise; the team types the rules.
5. **The check.** The one command that runs the typecheck, the lint and every test and exits non-zero on any failure, what it runs, and the command that installs dependencies in a fresh checkout (or none).
6. **The first tickets, only if there is no `specs/roadmap.md`.** Ask for the first stories: for each, what a person can do afterwards, what is on screen, and what stays out. If `/pipe:roadmap` hasn't run, say that it is the better start for a pipeline.

## 2. Record every round: specs/setup.md

Right after each answer, append the round in the same shape as a brainstorm:

````markdown
# Setup

## Round 1: Stack and why

### Q1. {the question, exactly as asked}

Options:

- **{label 1} (Recommended)**: {its description}
- **{label 2}**: {its description}

Recommendation: {label 1}.

Answer: "{the team's answer, word for word}"
````

Only append; never change a recorded answer.

## 3. Write the files: only from the answers

- **AGENTS.md**, in this shape. Each `Name: value` line is a team answer, copied word for word; leave out a line nobody answered (only `Check:` is required):

  ```markdown
  # {repository name}

  {one line: what the repository is, from the answers}

  Check: {the check command}
  Install: {the install command}
  Run: {the command that starts the app, with {port}}
  URL: {the app's URL, with {port}}
  Dependencies: {the manifests that may declare dependencies, comma-separated, if not only the root}

  ## Read first

  - `specs/guidelines/architecture.md` before adding a module, service or dependency.
  - `specs/guidelines/ui.md` before building a screen.   ← only with a screen
  - `pipeline.md` for how the pipeline itself is decided.  ← only if it exists

  ## Pipeline rules

  - Every story gets its branches, each in its own git worktree at `.worktrees/{branch}` (gitignored), created from an up-to-date trunk: `spec/{nr}` for the brainstorm and the spec, `dev/{nr}` for the implementation and the review, `learn/{nr}` for the retro, `improve/{nr}` for what the team accepts from it. The main checkout stays on the trunk.
  - An agent works only inside the worktree of its branch.
  - Agents never merge and never push; a person merges each branch after approving it. Merging is the approval: there is no approval file and no status line.
  - If a story's branch or file already exists, continue on it; never recreate a branch or overwrite a record.
  - Everything a story's run produces lives in `specs/{nr}/` (brainstorm, spec, spec-review, progress, review, retro, improve, and `evidence/` for screenshots).
  - The spec is written and revised only on `spec/{nr}`. A spec on the trunk is the implementation contract: never modify, delete, rename or replace it on the trunk or on a dev branch.
  - The first line of `progress.md` is the implementation state: "State: building", "State: blocked" or "State: ready for review".
  - A material gap found while building goes under "## Proposed spec revision" in `progress.md`, with "State: blocked"; the work resumes only after a person has merged the revised spec and merged the trunk into the dev branch.
  - The implementation revision of a story is the last commit on its dev branch outside `progress.md`, `review.md` and `evidence/`: `git log -1 --format=%h dev/{nr} -- . ':!specs/*/progress.md' ':!specs/*/review.md' ':!specs/*/evidence' ':!.claude/skills'`. A green check and a review verdict count only while they name it.
  - The reviewer cannot edit. Review verdicts are approve, rework or human; a third round with findings goes to a person.
  - After every merge of `dev/{nr}`: `/pipe:learn {nr}`; after its merge, `/pipe:improve {nr}` asks and a person decides.
  ```

- **specs/guidelines/architecture.md:** the stack and why, the modules and what each owns, the dependency rule, where tests live, the check and what it runs, and "## Domain rules (settled)" with every domain rule the team gave, word for word. A rule nobody gave isn't written.
- **specs/guidelines/ui.md,** only if there is a screen: the widths, the tokens or style source, the accent, what is never allowed.
- **specs/roadmap.md,** only if there was none: `# Roadmap`, then `## Epic 1: {name}` with a `### Story {nr}: {title}` per ticket the team gave, each with **Afterwards a person can**, **On screen when done:**, **Out of scope:** and **Group:** lines, numbered from 01.
- **.gitignore:** add the line `.worktrees/` if it is missing; keep every other line.

## 4. Verify and run the check

```bash
node "${CLAUDE_SKILL_DIR}/scripts/setup.mjs" verify --data "${CLAUDE_PLUGIN_DATA}"
```

It must print `verify: ok`. Then run the check command from AGENTS.md in the repository root, and show its output's last lines. A red check in an empty repository is information, not your problem to fix with code: say what it needs (for example a first test) and leave it to the team.

## 5. Done

Show what you wrote: each file's path and its content (AGENTS.md whole, the guidelines whole, the roadmap's headings). Then say: review these files and commit them on the trunk; the merge into the trunk (or the commit) is the approval; then run `/pipe:spec 01`. You commit nothing yourself.
