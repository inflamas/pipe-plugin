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

## 1. The team, before the first block

Ask in one AskUserQuestion call, three questions:

- how many people build the pipeline;
- how many of them are remote;
- by when the pipeline must run (a date).

These are facts only the team knows: give plain options (ranges, dates), and mark as "(Recommended)" the option you would plan for if they don't know. Read the answers back in one line.

## 2. Show the blocks

Show the fourteen blocks as one list, one line each, exactly as `start` printed them, each marked "decide now", "fixed", "setup" or "later":

- **decide now:** 1 intake, 2 runtime and trigger, 3 isolation, 7 verification, 8 independent review, 9 merge gate, 10 orchestrator and limits, 11 evals;
- **fixed:** 5 spec gate, 6 build, 12 learn, 13 measurement: written down unchanged (section 4);
- **setup:** 4 context: `/pipe:setup` decides it in the repository;
- **later:** 14 production feedback.

## 3. One block at a time

For each "decide now" block, in order:

1. **Ask** with AskUserQuestion: two to four concrete options. Each option's description says what it costs the team today (time, money, people, risk). Your recommendation comes first, with "(Recommended)" at the end of its label, fitted to the team's size, its remote people and its date. Name the block in each question ("Block 2, runtime and trigger: …") so it stands on its own. A block may take one call with up to four questions; the team can always answer in its own words through "Other".
2. **Read the answer back in one line** ("Block 2: GitHub Actions, started by a label, org-owned API key.") before the next block.
3. **A block nobody can decide within a few minutes:** when the team answers "don't know", "skip", "later" or "revisit", take your recommendation and mark the block "revisit". Don't argue, and don't ask it twice.

What each block asks:

- **1 Intake.** First ask which ticket types the team gets (multiSelect; offer common types, and they name their own through "Other"). Then show a table in the chat scoring each named type on five criteria: small, boring, repeating, low risk, provable by a test (yes or no each, with one word why), and ask which type the pipeline takes first, recommending the best-scoring one. Then ask where those tickets come from and how they reach the pipeline: a person writes each one as a story into `specs/roadmap.md` by hand; the team's issue tracker (Jira, Linear, GitHub Issues, …) read through an MCP server or a script; or what the team names. Say in the question that `/pipe:spec` reads only `specs/roadmap.md` either way, so a tracker means building the step that turns its ticket into a story, and recommend writing stories by hand until the pipeline runs. Then ask for three real example tickets of the chosen type, in one call with one question per ticket: they type each through "Other" (offer drafts as options only to show the shape). They go into pipeline.md under block 1 as "Example tickets:", one line each, word for word. They are not stories: the roadmap never holds them.
- **2 Runtime and trigger.** Where a run executes: the team's laptops, GitHub Actions, Kubernetes, or what the team names. For each option say who starts a run, whose account the agent signs in with (an org-owned API key, workload identity federation, Bedrock or Vertex; a person's own token only with that person's and the company's OK, because it is tied to their subscription), what it costs, and who watches it. Say in the question that today the pipeline is built and debugged locally either way: the choice is the target.
- **3 Isolation.** What a run may read, write and reach on the network, and which secrets it gets. A worktree per ticket is the base (`.worktrees/{branch}`); ask whether a container or a dev container is wanted on top.
- **7 Verification.** The one check command and what it runs (typecheck, lint, tests). It becomes the `Check:` line of AGENTS.md.
- **8 Independent review.** Which kinds of change always go to a person (multiSelect: schema or data, dependencies, auth and secrets, money and dates, the pipeline itself, more than N lines, …). State that the reviewer cannot edit: that part is fixed.
- **9 Merge gate.** Who reads and merges dev pull requests (one named person, any two, the ticket's owner, …).
- **10 Orchestrator and limits.** Per agent step the most turns and minutes; per ticket the most dollars and reviews; and how anyone stops a run at once (a kill switch: a label, a file, a command). Up to four questions in one call.
- **11 Evals.** For `/pipe:review-spec` and `/pipe:review-dev`: one case each must reject and one each must accept. Propose concrete cases drawn from the example tickets, and ask the team to accept or name their own.

## 4. Fixed rules

Write these down unchanged, as `start` printed them, in their blocks: a person merges every spec, dev and learn pull request, and merging is the approval; "Agents never merge. A skill pushes only its own story branch and opens its pull request; a person merges, and merging is the approval."; the reviewer cannot edit; learn after every merge, improve asks, a person decides; the six metrics are lead time, human minutes per gate, review rounds and rework, first-run green, agent cost (estimate), stops and denied calls, all computed automatically from events. Don't ask about them.

## 5. Groups

Propose groups that fit the team: four pieces,

- **A Runner and limits** (blocks 2's runner side, 10),
- **B Runtime, trigger and isolation** (2, 3),
- **C Gates, review and evals** (5, 7, 8, 9, 11),
- **D Measurement** (13, and the event line every piece shares).

With fewer than four people, one person takes two pieces; people in the same place work together, and a remote person takes the piece with the fewest hand-offs (usually D). Ask who takes which, one question per group or one with your proposed split as the recommended option. Read it back in one line.

## 6. Write pipeline.md

Under 120 lines, in the shape of [format.md](format.md): one section per block, numbered as in section 2, holding the decision word for word (`Decision: "{the answer}"`, or `Decision: "{your recommendation}" (revisit)`), or the fixed rule, or the setup line, or "Later."; block 1 also holds "Example tickets:" with the three example tickets, one `- "{ticket}"` line each, word for word; then "## Groups" with the people the team named; then "## Events" with the event line every piece shares: one JSON line per event with ticket, step, event (start, end, stop, denied, limit, push), time, outcome, turns and cost_usd.

## 7. Write specs/roadmap.md

In the shape of [format.md](format.md):

- `## Epic {n}: {name}` per group of blocks (one epic per group, A to D), and under each `### Story {nr}: {title}` with its four lines: **Afterwards a person can**, **On screen when done:** ("None." when nothing is on screen), **Out of scope:**, **Group:**. Each story is one slice its group finishes in about an hour.
- **Story 01 is always the walking skeleton**, in epic 1: start, one headless dev run, the check, one event, a stop for the merge. The thinnest path through every decided block.
- Nothing else: the roadmap holds only the stories that build the pipeline. The tickets the pipeline later implements come in through the intake decided in block 1, never through the roadmap.

## 8. Write specs/roadmap-brainstorm.md

Every question, its options, your recommendation and the answer, word for word, in rounds: one `## Round {k}: {topic}` per AskUserQuestion call, in the shape of [format.md](format.md). Record each round right after its answer.

## 9. Verify

```bash
node "${CLAUDE_SKILL_DIR}/scripts/roadmap.mjs" verify --data "${CLAUDE_PLUGIN_DATA}"
```

It must print `verify: ok`: the record matches the logged calls word for word, pipeline.md has the fourteen sections in order with the decisions word for word, the fixed rules unchanged, the groups and the event line, block 1 lists the three example tickets word for word, and specs/roadmap.md has its epics, their stories and story 01, and nothing but epics. Fix what it names.

## 10. Discuss

Show both files in the chat (pipeline.md whole, the roadmap's headings with each story's first line). Then ask the team, in one AskUserQuestion call:

- is every decided block in a story;
- is story 01 the thinnest path through all of them;
- does each group have its next hour.

Change the files only as the team says, record that round too, and run `verify` again.

## 11. Done

Close with: the three files written, the blocks marked "revisit", and the next steps: commit the files (`git init` first if the folder is not a repository), run `/pipe:setup`, then `/pipe:spec 01`.
