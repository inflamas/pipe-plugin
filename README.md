# pipe

A Claude Code plugin that gives a team a shared AI delivery pipeline in its own repository. It starts with two interviews: one decides the pipeline, the other sets up the repository. After that, every ticket runs through the same gated steps: spec, independent spec review, build, read-only code review, learn and improve. Agents do the work in git worktrees, and the review steps push their branch and open its pull request. A person decides every gate, and merging is the approval. Hooks enforce the rules, so the skills don't just describe them.

The plugin is repository-neutral. It knows no stack and no product. It reads the check command and the guidelines from the repository, and it needs only `git` and Node.js.

## Install

In Claude Code, from the repository you want to set up:

```
/plugin marketplace add inflamas/pipe-plugin
/plugin install pipe@pipe-plugin
```

From a local clone, use `/plugin marketplace add ./path/to/pipe-plugin` instead. Run `/reload-plugins` (or start a new session), then `/pipe:roadmap`.

Requirements: Claude Code, `git` (2.48 or later links worktrees with relative paths, and older versions work too), and Node.js 20 or later. The hook scripts run on Node, and so does the bundled headless Playwright server (`npx @playwright/mcp`). For screen checks the browser server needs Google Chrome: `npx playwright install chrome` installs it. Without it, screen checks are recorded as "Browser: not available" and the change goes to a person.

For the pull requests: an `origin` remote and the GitHub CLI `gh`, logged in. Without them nothing fails: the skill prints the exact `git push` or `gh pr create` command for a person to run.

## The commands, in pipeline order

| Command | When | What it does | Writes |
| --- | --- | --- | --- |
| `/pipe:roadmap` | once, first, in an empty folder or a fresh repository | Moderates the team's pipeline brainstorm. It shows the 14 building blocks, then takes each block to decide one at a time with options, costs and a recommendation. It proposes groups and writes the decisions down. | `pipeline.md`, `specs/roadmap.md`, `specs/roadmap-brainstorm.md` |
| `/pipe:setup` | once, after the roadmap | Sets up the repository in question rounds: stack and why, modules and what each owns, UI rules, the domain rules nobody may guess, the check command, and the first tickets only if there is no roadmap. It writes only what the team answered and keeps an existing roadmap unchanged. It ends by running the check. | `AGENTS.md`, `specs/guidelines/architecture.md` (and `ui.md` if there is a screen), `specs/roadmap.md` if missing, `specs/setup.md`, `.gitignore` |
| `/pipe:spec {nr}` | per story | Brainstorms the story with you (at most two rounds) and writes the draft spec on `spec/{nr}`. `--address-findings` answers a spec review. | `specs/{nr}/brainstorm.md`, `spec.md` |
| `/pipe:review-spec {nr}` | after the spec | The read-only `pipe:spec-reviewer` agent checks form and domain rules in a fresh context. You answer each guess, and the record is committed. Then it pushes `spec/{nr}` and opens its pull request. Never approves. | `specs/{nr}/spec-review.md` |
| *you merge the pull request of `spec/{nr}`* | | Merging approves the spec: it becomes the contract. | |
| `/pipe:dev {nr}` | after the spec merge | Implements the spec on `dev/{nr}`: tests first, then the code, then each screen check in a headless browser with screenshots. It ends ready for review, or blocked on a proposed spec revision. `--address-findings` reworks a review. | code, `specs/{nr}/progress.md`, `evidence/` |
| `/pipe:review-dev {nr}` | after dev | The read-only `pipe:dev-reviewer` agent reviews the diff, runs the check and looks in the browser. Its report becomes `review.md` word for word, with the verdict `approve`, `rework` or `human`. On `approve` or `human` it pushes `dev/{nr}` and opens its pull request; on `rework` it pushes nothing. | `specs/{nr}/review.md` |
| *you merge the pull request of `dev/{nr}`* | | Merging approves the implementation. | |
| `/pipe:learn {nr}` | after every dev merge | The retro: one proposal per lesson, with step, change and evidence. It asks what you noticed and removes merged worktrees. Applies nothing. Pushes `learn/{nr}` and opens its pull request. | `specs/{nr}/retro.md` on `learn/{nr}` |
| *you merge the pull request of `learn/{nr}`* | | | |
| `/pipe:improve {nr}` | after the learn merge | Asks you about each proposal and applies only what you decide. Proposals for the plugin itself are written down for its maintainers. Pushes `improve/{nr}` and opens its pull request. | `specs/{nr}/improve.md` and the accepted changes, on `improve/{nr}` |

The roadmap builds the pipeline: `specs/roadmap.md` holds only its epics and stories, story 01 the walking skeleton, numbered with two digits (`01`). The tickets the pipeline implements are not in it. They come in through the intake the team decided in `pipeline.md` (for example a Jira ticket or a label), and each ticket keeps its own id there. `/pipe:roadmap` writes three real example tickets under block 1 of `pipeline.md`, to show what the pipeline will take in.

## What the repository must provide

`/pipe:setup` writes all of this. Without it, every skill stops with a message that says what is missing.

- **`AGENTS.md` with one line `Check: <command>`**: the one command that runs the typecheck, the lint and every test, and exits non-zero on any failure. Every skill and the Stop hook run exactly this. Optional lines, each `Name: value` at the start of a line:
  - `Install: <command>` runs once in a fresh worktree.
  - `Run: <command>` starts the app for the browser, with `{port}` where a free port goes.
  - `URL: <url>` is where the app opens, also with `{port}`.
  - `Dependencies: <paths>` lists the only manifests that may declare dependencies. Without it, only the root manifests may.
- **`specs/guidelines/`**: `architecture.md`, plus `ui.md` if there is a screen. The plugin only reads them.
- **`specs/roadmap.md`**: stories as `## Story {nr}: …` or `### Story {nr}: …` under `## Epic {n}: …`, each with **Afterwards a person can**, **On screen when done:**, **Out of scope:** and **Group:**.
- **`.worktrees/` in `.gitignore`**: every branch gets its worktree at `.worktrees/{branch}`, for example `.worktrees/dev/01`. Worktrees are created with `git worktree add --relative-paths` when git supports it.
- **A trunk**: `main`, or `master`.

## The rules the plugin enforces

- **Agents never merge. A skill pushes only its own story branch and opens its pull request; a person merges, and merging is the approval.** `/pipe:review-spec`, `/pipe:review-dev` (not on `rework`), `/pipe:learn` and `/pipe:improve` push as their last step, once their record is committed and verified. `/pipe:spec` and `/pipe:dev` never push: their review comes first. A later run on the same branch pushes again and reuses the open pull request. A hook allows exactly two commands:
  - `git push -u origin {branch}` (or without `-u`), where `{branch}` is `spec/`, `dev/`, `learn/` or `improve/{nr}` and is the branch checked out where the command runs
  - `gh pr create --head {branch} --base {trunk}`, for that same branch

  It blocks `git merge`, `gh pr merge`, `gh pr review --approve`, a push to the trunk, of another story's branch, or to any remote but `origin`, a refspec with a colon, and `--force`, `--force-with-lease`, `-f`, `--delete`, `--mirror`, `--all`, `--tags` and every other push flag.
- **The spec is written only on a `spec/` branch.** On the trunk it is the contract: a hook blocks every change to a `spec.md` elsewhere. A gap found while building goes under "## Proposed spec revision" in `progress.md`, the story is blocked, and the spec is revised on `spec/{nr}`.
- **Dependencies** are declared only in the allowed manifests (hook). A new dependency always goes to a person in the review.
- **Check before done:** on a `dev/` branch, a turn can't end while the check is red, unless `progress.md` says "State: blocked".
- **The reviewers cannot edit.** `pipe:spec-reviewer` and `pipe:dev-reviewer` have no Edit, Write or NotebookEdit tools. A hook blocks every shell command of theirs that would change the repository. Their last message is their report, and only the review skill writes `spec-review.md` or `review.md`, word for word from that report.
- **Review verdicts:** `human` if an escalation rule fires, `rework` if there is a finding, and `approve` otherwise. A third round with findings goes to a person. The escalation rules:
  - an acceptance check without a passing test, or a red check
  - more than the spec, or a proposed revision
  - settled rules, money, dates or time zones
  - schema, seed data, an existing endpoint, or a dependency
  - the harness, input handling, auth or secrets
  - more than 200 changed lines
  - the browser was not available
  - doubt
- **The revision rule:** a green check and a verdict count only for the implementation revision they name. Any later change voids them.
- **Records are checked word for word:** every question and answer in a brainstorm, review, setup or roadmap record must come from a logged AskUserQuestion call.
- **Learn after every merge:** `/pipe:improve` asks, and a person decides.

Each step appends an event line to `<git common dir>/pipe/events.jsonl`, with the fields `ticket`, `step`, `event` (`start`, `stop`, `denied`, or `push` with the pull request's URL as its outcome), `time`, `outcome`, `turns` and `cost_usd`. The metrics in `pipeline.md` are computed from these lines. That state lives in the git directory, so it is never committed.

## If you use a dev container

Nothing in the plugin depends on where Claude Code runs. Worktrees use relative links, all state lives in the git directory, and a missing browser never blocks a run.

- **Headless browser:** the plugin starts Playwright headless (`--headless --isolated`). Install Chrome in the container (`npx playwright install --with-deps chrome`). If it can't start, for example because of a sandbox error when running as root, `/pipe:dev` and `/pipe:review-dev` record "Browser: not available" and the review goes to a person. They don't fail or retry in a loop.
- **The dev server must be reachable from where the browser runs.** If both run in the container, `localhost` works. If the browser runs on the host, publish the port and let the server listen on `0.0.0.0`.
- **If git refuses the mounted repository** ("detected dubious ownership"), run `git config --global --add safe.directory /path/to/repo` inside the container.

## Develop the plugin

```
npm test                          # node --test: the hooks, the scripts, and a flow in a throwaway repository
claude plugin validate .
claude --plugin-dir .             # try it in a session without installing
```

The scripts are plain Node.js ESM with no dependencies. Each decision is a pure function, tested in `test/`. Git and the file system are touched only in a thin layer (`lib/common.mjs`).

## License

MIT
