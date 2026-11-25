---
name: roadmap
description: Moderate a team's brainstorm of its AI pipeline, block by block, and write the decisions to pipeline.md and specs/roadmap.md (only the epics and one-hour stories that build the pipeline, story 01 the walking skeleton; the team's three example tickets go into pipeline.md under block 1). The team decides; the skill asks with AskUserQuestion, recommends and writes it down. Works in an empty folder or a fresh repository, before /pipe:setup. Use for /pipe:roadmap.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/roadmap.mjs" *)
---

# /pipe:roadmap

You moderate the team's pipeline brainstorm. **The team decides; you ask and write it down. You never decide for the team.** Every question goes through AskUserQuestion, never plain chat; you recommend an answer for every block, and you write only what the team answered. Everything happens in the folder the session runs in, which may be empty and need not be a git repository yet. You write three files: `pipeline.md`, `specs/roadmap.md` and `specs/roadmap-brainstorm.md`. You commit nothing; the team reads and commits them.

The plugin logs every AskUserQuestion call, and `verify` checks your record against that log word for word.

## 0. Start

```bash
node "${CLAUDE_SKILL_DIR}/scripts/roadmap.mjs" start --data "${CLAUDE_PLUGIN_DATA}"
```

It prints the folder, which of the three files exist, the fourteen blocks, and the fixed texts you write unchanged. If a file exists, continue it: keep every answer already recorded, and ask only what is still open.

## 1. Show the blocks

Show the fourteen blocks as one list, one line each, exactly as `start` printed them, each marked "decide now", "fixed", "setup" or "later":

- **decide now:** 1 intake, 2 runtime and trigger, 3 isolation, 7 verification, 8 independent review, 9 merge gate, 10 orchestrator and limits, 11 evals, 13 measurement (only where the events are collected: the six metrics are fixed);
- **fixed:** 5 spec gate, 6 build, 12 learn: written down unchanged (section 3);
- **setup:** 4 context: `/pipe:setup` decides it in the repository;
- **later:** 14 production feedback.

## 2. One block at a time

For each "decide now" block, in order:

1. **Ask** with AskUserQuestion: two to four concrete options. Each option's description says what it costs the team today (time, money, people, risk). Your recommendation comes first, with "(Recommended)" at the end of its label. Name the block in each question ("Block 2, runtime and trigger: …") so it stands on its own. A block may take one call with up to four questions; the team can always answer in its own words through "Other".
2. **Read the answer back in one line** ("Block 2: GitHub Actions, started by a label, org-owned API key.") before the next block.
3. **A block nobody can decide within a few minutes:** when the team answers "don't know", "skip", "later" or "revisit", take your recommendation and mark the block "revisit". Don't argue, and don't ask it twice.

What each block asks:

- **1 Intake.** First ask which ticket types the team gets (multiSelect; offer common types, and they name their own through "Other"). Then show a table in the chat scoring each named type on five criteria: small, boring, repeating, low risk, provable by a test (yes or no each, with one word why), and ask which type the pipeline takes first, recommending the best-scoring one. Then ask where those tickets come from and how they reach the pipeline: a person writes each one as a story into `specs/roadmap.md` by hand; the team's issue tracker (Jira, Linear, GitHub Issues, …) read through an MCP server or a script; or what the team names. Say in the question that `/pipe:spec` reads only `specs/roadmap.md` either way, so a tracker means building the step that turns its ticket into a story, and recommend writing stories by hand until the pipeline runs. Then ask which steps the pipeline runs for each ticket, and where it starts: the whole chain from `/pipe:spec` (`/pipe:spec`, `/pipe:review-spec`, a person merges the spec, `/pipe:dev`, `/pipe:review-dev`, a person merges, `/pipe:learn`); starting at `/pipe:dev` (`/pipe:dev`, `/pipe:review-dev`, a person merges, `/pipe:learn`), because the spec is written before the ticket reaches the pipeline; or what the team names. Every option ends with `/pipe:learn`: learn always runs after the merge (block 12), and "No reusable lesson" is a valid result, so don't offer leaving it out. Say in the question that `/pipe:dev` stops unless `specs/{nr}/spec.md` is merged into the trunk, so starting at `/pipe:dev` means a person writes and merges that spec, or the team builds the step that writes it, before each run. Recommend the whole chain: the stories it needs then are the ones the roadmap builds anyway. Then ask for three real example tickets of the chosen type, in one call with one question per ticket: they type each through "Other" (offer drafts as options only to show the shape). They go into pipeline.md under block 1 as "Example tickets:", one line each, word for word. They are not stories: the roadmap never holds them. Last, ask for today's baseline: for one of the example tickets, roughly how long it takes today from ticket to merge, and how many minutes people spend on it (writing, reviewing, merging). The team types it through "Other"; offer rough ranges as options only to show the shape. Say in the question that group D compares the pipeline's metrics against it, so without it nobody can tell later whether the pipeline helps. It goes into block 1 as a `Decision:` line, word for word.
- **2 Runtime and trigger.** Where a run executes: the team's laptops, GitHub Actions, Kubernetes, or what the team names. For each option say who starts a run, whose account the agent signs in with (an org-owned API key, workload identity federation, Bedrock or Vertex; a person's own token only with that person's and the company's OK, because it is tied to their subscription), what it costs, and who watches it. Say in the question that today the pipeline is built and debugged locally either way: the choice is the target. Then, in one call, ask which harness runs each step: Claude Code headless (`claude -p`) with the pipe plugin installed, recommended because the pipe skills are Claude Code plugin skills and its hooks keep the gates; the Claude Agent SDK loading the pipe plugin; or what the team names. In the same call, ask (multiSelect) what else the runner needs installed besides the pipe plugin: the tracker's MCP server when block 1 chose a tracker, the team's own skills or plugins, the toolchain the check command needs, or what the team names. Say in that question that the pipe skills a run uses are the steps block 1 chose and come with the plugin, and that the plugin itself needs Node.js 20 or later, git, an authenticated `gh` and a Playwright browser for `/pipe:dev`'s screen checks. In the same call, ask which GitHub identity pushes the story branches and opens the pull requests: a GitHub App installed on the repository, recommended (scoped, short-lived tokens, nobody's seat); a bot or machine user; or a person's own token, only with that person's OK, since their name is on every push. Say in that question that this identity must not be able to merge: the plugin's no-merge hook only stops the agent from trying, and branch protection on the trunk is what makes the rule hold.
- **3 Isolation.** What a run may read, write and reach on the network, and which secrets it gets. A worktree per ticket is the base (`.worktrees/{branch}`); ask what goes on top: a dev container (`.devcontainer/devcontainer.json`) that holds the harness and everything block 2 listed, so laptops and the target run the same environment, recommended; a plain container image the target runs; or nothing beyond the worktree. For each option say what it costs (Docker on every laptop, an image to build and keep current, or differences between laptops and the target that each run can trip over).
- **7 Verification.** The one check command and what it runs (typecheck, lint, tests). It becomes the `Check:` line of AGENTS.md.
- **8 Independent review.** Which kinds of change always go to a person (multiSelect: schema or data, dependencies, auth and secrets, money and dates, the pipeline itself, more than N lines, …). State that the reviewer cannot edit: that part is fixed.
- **9 Merge gate.** Who reads and merges dev pull requests (one named person, any two, the ticket's owner, …). In the same call, ask how a person learns that a pull request waits for them: GitHub's own notification for a requested reviewer, recommended; a message in the team's chat (Slack, Teams, …); a label or board someone checks; or what the team names. Say in the question that "human minutes per gate" counts the wait too, and that anything beyond what the team already watches is a story to build.
- **10 Orchestrator and limits.** Per agent step the most turns and minutes; per ticket the most dollars and reviews; how anyone stops a run at once (a kill switch: a label, a file, a command); and which model each step runs with (`/pipe:spec`, `/pipe:review-spec`, `/pipe:dev`, `/pipe:review-dev`, `/pipe:learn`): one model for all, a stronger one for dev and the reviewers, or what the team names, each option saying what it does to the cost per ticket and to the dollar limit. Up to four questions in one call.
- **11 Evals.** For `/pipe:review-spec` and `/pipe:review-dev`: one case each must reject and one each must accept. Propose concrete cases drawn from the example tickets, and ask the team to accept or name their own.
- **13 Measurement.** The six metrics are fixed (section 3); ask only where the events are collected so they outlive a run. Each step appends them to `<git common dir>/pipe/events.jsonl` on the machine that runs it, which is gone when an ephemeral runner (GitHub Actions, a pod) ends. Options: uploaded as a CI artifact after each run; appended to an events branch in the repository; shipped to a bucket or log store the team already has; or left on the laptops, only while runs are local. Recommend by block 2's answer. Block 13 holds this `Decision:` line and the fixed rule.

## 3. Fixed rules

Write these down unchanged, as `start` printed them, in their blocks: a person merges every spec, dev and learn pull request, and merging is the approval; "Agents never merge. A skill pushes only its own story branch and opens its pull request; a person merges, and merging is the approval."; the reviewer cannot edit; learn after every merge, even when it finds no reusable lesson, improve asks, a person decides; the six metrics are lead time, human minutes per gate, review rounds and rework, first-run green, agent cost (estimate), stops and denied calls, all computed automatically from events. Don't ask about them.

## 4. Groups

Propose how the team splits into four pieces:

- **A Runner and limits** (block 2's runner, 10): the command that runs one step on one ticket headless, with block 10's limits, the stop switch and the event line. It runs on a laptop first and works the same on any target; it doesn't choose one.
- **B Runtime, trigger and isolation** (block 2's target, trigger and account, 3): puts A's runner where block 2 decided with the harness block 2 chose installed, wires what starts a run and the account the agent signs in with, and isolates the run (block 3). Block 2's decision belongs to B; A builds what B deploys.
- **C Gates, review and evals** (5, 7, 8, 9, 11),
- **D Measurement** (13: where the events are collected, the metrics, and the event line every piece shares).

Ask who takes which, one question per group; the team names its people through "Other". One person may take several pieces. Read it back in one line.

## 5. Write pipeline.md

Under 120 lines, in the shape of [format.md](format.md): one section per block, numbered as in section 1, holding the decision word for word (`Decision: "{the answer}"`, or `Decision: "{your recommendation}" (revisit)`), or the fixed rule, or the setup line, or "Later."; block 1 also holds "Example tickets:" with the three example tickets, one `- "{ticket}"` line each, word for word; then "## Groups" with the people the team named; then "## Events" with the event line every piece shares: one JSON line per event with ticket, step, event (start, end, stop, denied, limit, push), time, outcome, turns and cost_usd.

## 6. Write specs/roadmap.md

In the shape of [format.md](format.md):

- `## Epic {n}: {name}` per group of blocks (one epic per group, A to D), and under each `### Story {nr}: {title}` with its four lines: **Afterwards a person can**, **On screen when done:** ("None." when nothing is on screen), **Out of scope:**, **Group:**. Each story is one slice its group finishes in about an hour.
- **Story 01 is always the walking skeleton**, in epic 1: start, one headless dev run, the check, one event, a stop for the merge. The thinnest path through every decided block.
- **One story in group B's epic installs the harness on the runner:** the harness block 2 chose at a pinned version, the pipe plugin with what it needs (Node.js 20 or later, git, an authenticated `gh`, the Playwright browser), and everything else block 2 listed. When block 3 chose a dev container or a container image, the story installs all of it there, and the target runs that container; otherwise it installs it on the target directly. Afterwards a person can start a run on the target and see the pipe skills and the listed MCP servers loaded; with a dev container, also on a laptop that opens it. Until then the walking skeleton runs on a laptop that already has them.
- **One story in group B's epic protects the trunk:** branch protection that lets only people merge, and the pushing identity block 2 chose, scoped so it can push story branches and open pull requests but not merge. Afterwards a person can see that identity's merge attempt refused.
- **One story in group D's epic collects the events** where block 13 decided, so a run's events outlive its runner. Afterwards a person can find the event lines of a finished run there.
- **When block 9 chose a notification the team doesn't already get,** one story in group C's epic builds it.
- The stories build only the steps decided in block 1: when the pipeline starts at `/pipe:dev`, no story builds `/pipe:spec` or `/pipe:review-spec`, and, unless a person writes each spec by hand, one story builds the step that writes `specs/{nr}/spec.md` and gets it merged before a run.
- Nothing else: the roadmap holds only the stories that build the pipeline. The tickets the pipeline later implements come in through the intake decided in block 1, never through the roadmap.

## 7. Write specs/roadmap-brainstorm.md

Every question, its options, your recommendation and the answer, word for word, in rounds: one `## Round {k}: {topic}` per AskUserQuestion call, in the shape of [format.md](format.md). Record each round right after its answer.

## 8. Verify

```bash
node "${CLAUDE_SKILL_DIR}/scripts/roadmap.mjs" verify --data "${CLAUDE_PLUGIN_DATA}"
```

It must print `verify: ok`: the record matches the logged calls word for word, pipeline.md has the fourteen sections in order with the decisions word for word, the fixed rules unchanged, the groups and the event line, block 1 lists the three example tickets word for word, and specs/roadmap.md has its epics, their stories and story 01, and nothing but epics. Fix what it names.

## 9. Discuss

Show both files in the chat (pipeline.md whole, the roadmap's headings with each story's first line). Then ask the team, in one AskUserQuestion call:

- is every decided block in a story;
- is story 01 the thinnest path through all of them;
- does each group have its next hour.

Change the files only as the team says, record that round too, and run `verify` again.

## 10. Done

Close with: the three files written, the blocks marked "revisit", and the next steps: commit the files (`git init` first if the folder is not a repository), run `/pipe:setup`, then `/pipe:spec 01`.
