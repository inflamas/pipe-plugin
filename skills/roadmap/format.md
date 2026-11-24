# Formats checked by `verify`

## pipeline.md (under 120 lines)

```markdown
# Pipeline

Team: {n} people build it, {m} remote. It runs by {date}. Decided with /pipe:roadmap; every question and answer is in specs/roadmap-brainstorm.md.

## 1. Intake

Decision: "{the team's answer, word for word}"
Decision: "{where the tickets come from, word for word}"
{one line: the chosen ticket type and why it scored best}

Example tickets:

- "{the first example ticket, word for word}"
- "{the second example ticket, word for word}"
- "{the third example ticket, word for word}"

## 2. Runtime and trigger

Decision: "{answer}"
Decision: "{a second answer of the same block, if it took several questions}"

## 3. Isolation

Decision: "{your recommendation, word for word}" (revisit)

## 4. Context

Setup: /pipe:setup writes AGENTS.md with the Check line, specs/guidelines/ and .gitignore.

## 5. Spec gate

Fixed: a person merges every spec, dev and learn pull request; merging is the approval. The spec is written only on a spec/ branch.

## 6. Build

Fixed: Agents never merge. A skill pushes only its own story branch and opens its pull request; a person merges, and merging is the approval. The build runs in its own worktree and ends only when the check is green.

## 7. Verification

Decision: "{answer}"

## 8. Independent review

Decision: "{answer}"
The reviewer cannot edit.

## 9. Merge gate

Decision: "{answer}"

## 10. Orchestrator and limits

Decision: "{answer}"

## 11. Evals

Decision: "{answer}"

## 12. Learn

Fixed: learn after every merge; improve asks, a person decides.

## 13. Measurement

Fixed: six metrics: lead time, human minutes per gate, review rounds and rework, first-run green, agent cost (estimate), stops and denied calls, all computed automatically from events.

## 14. Production feedback

Later.

## Groups

- **A Runner and limits** (blocks 2, 10): {people}
- **B Runtime, trigger and isolation** (blocks 2, 3): {people}
- **C Gates, review and evals** (blocks 5, 7, 8, 9, 11): {people}
- **D Measurement** (block 13): {people}

## Events

One JSON line per event, appended by every piece; events: start, end, stop, denied, limit, push.

{"ticket":"01","step":"dev","event":"end","time":"2026-01-01T10:00:00Z","outcome":"green","turns":14,"cost_usd":0.62}
```

The `Decision:` text is the answer exactly as the team gave it (the selected label, or the words they typed). A block that took the recommendation ends its line with `(revisit)`, and its text is the recommendation exactly as recorded.

"Example tickets:" holds exactly three lines, each one example ticket exactly as the team typed it. They show what the pipeline will take in; they are not stories, and they never go into specs/roadmap.md.

## specs/roadmap.md

```markdown
# Roadmap

{one paragraph: what the pipeline does once these stories are built}

## Epic 1: Runner and limits

### Story 01: Walking skeleton

**Afterwards a person can** start one headless dev run on a ticket, see the check run, find one event line, and see the run stop for the merge.

**On screen when done:** None.

**Out of scope:** {what the later stories add}

**Group:** A

### Story 02: {title}

…

## Epic 2: Runtime, trigger and isolation

…
```

The roadmap holds only the epics and the stories that build the pipeline: every `## ` heading is an epic (a `## Settled …` section of rules the team settled later may follow). Story numbers are two digits (01, 02, …), each appears once, and story 01 is the walking skeleton. The tickets the pipeline later implements are never in it: they come in through the intake decided in block 1 of pipeline.md, and each keeps its own id there.

## specs/roadmap-brainstorm.md

One round per AskUserQuestion call, recorded right after its answer. Copy each question and option exactly as asked, and each answer exactly as given.

````markdown
# Pipeline brainstorm

## Round 1: The team

### Q1. {the question, exactly as asked}

Options:

- **{label 1} (Recommended)**: {its description}
- **{label 2}**: {its description}

Recommendation: {label 1}.

Answer: "{the answer, word for word}"

## Round 2: Block 1, intake

…
````
