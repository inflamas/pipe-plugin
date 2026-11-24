---
name: learn
description: Run the learning checkpoint (retro) of one roadmap story after a person merged dev/{nr} into the trunk. Reads every file of the run and the merged commits, proposes one change per lesson with step, exact change and evidence, asks the user what they noticed, commits specs/{nr}/retro.md on learn/{nr} in its own worktree, and removes the worktrees whose branch is merged. Never applies a change: /pipe:improve does, after asking. Use for /pipe:learn 01.
argument-hint: "{nr}"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/learn.mjs" *)
---

# /pipe:learn $ARGUMENTS

You run the learning checkpoint of story $ARGUMENTS, right after a person merged `dev/{nr}` into the trunk: accepted locally, nothing released. You find what went wrong or needed a human correction, and propose where the pipeline or its harness should change. You propose; you never apply. The only file you write is `specs/{nr}/retro.md`, committed on `learn/{nr}`. The person's merge of `learn/{nr}` is the approval of the retro; `/pipe:improve {nr}` then asks which proposals to apply.

The script `${CLAUDE_SKILL_DIR}/scripts/learn.mjs` does the deterministic parts: the gate, the worktree, the merge commit, the cleanup and the check of retro.md. The plugin's hooks also apply. Never work around a block. Fix what it names. If you can't, stop and say so.

## 1. Start: always first

```bash
node "${CLAUDE_SKILL_DIR}/scripts/learn.mjs" start $ARGUMENTS
```

- **`STOP: …` (exit 3):** relay the message word for word as your one closing line, and end the run. When `dev/{nr}` is not merged into the trunk, it says "Merge dev/{nr} first, then run /pipe:learn {nr}." It also stops when dev/{nr} was fast-forwarded (no merge commit M), when the worktree is on another branch, and when AGENTS.md has no `Check:` line.
- **Exit 0:** it prints `worktree:`, `branch:`, `trunk:`, `merge:` (M, the merge commit of dev/{nr}), `log:` (`git log M^1..M^2`), `retro:` and `files:` (every file under `specs/{nr}/` on the trunk). When `learn/{nr}` did not exist, it created `.worktrees/learn/{nr}` on a new `learn/{nr}` from the trunk. When it exists, it continued in it: never recreate it, and keep a retro.md already written there (in particular "## Noticed by me").

From then on, work only in the printed worktree: start every command with `cd {worktree} &&` and use absolute paths inside it. Change nothing in the repository root or in another worktree.

## 2. Context

Read, in the worktree:

- `AGENTS.md`, `pipeline.md` if it exists, `specs/roadmap.md` (the story), `specs/guidelines/`.
- Every file `start` listed under `files:`: brainstorm, spec, spec-review, progress, review, and look at the screenshots in `evidence/`.
- The merged commits: `git log --stat M^1..M^2`, and the spec's own merge into the trunk (`git log --merges --first-parent {trunk}`), with the diff of anything that looks like a correction, a re-run or a revert.
- The pipeline's events: `<git common dir>/pipe/events.jsonl` (find the folder with `git rev-parse --git-common-dir`), the lines whose `ticket` is `{nr}`: stops, denied calls, limits.
- The harness the run went through: the pipe plugin's skills, agents and hooks under `${CLAUDE_PLUGIN_ROOT}`, and anything the repository adds under `.claude/`.

Look for what went wrong or needed a human correction: a review answer that never reached the spec, a check that had to be re-run, a finding, an open question in progress.md, a rule that fired, a denied call, a commit that fixed an earlier one, a file left outside its worktree, a step that only a person caught.

## 3. Retro: one proposal per lesson

For each lesson:

- **Step:** the part of the pipeline or its harness that should change: the story, `/pipe:spec`, the spec gate, `/pipe:review-spec`, `/pipe:dev`, the check, `/pipe:review-dev`, `/pipe:learn`, `AGENTS.md`, a guideline, a hook, `pipeline.md`.
- **Change:** the exact change, concrete enough to apply without asking (the rule's new wording, the check a script makes, the line in `.gitignore`). Say whether it lands in this repository or in the pipe plugin.
- **Evidence:** a file and line, a commit hash, an event line, or a command you ran and what it printed.

If nothing is worth changing, write "No reusable lesson" and why: that is a valid result. Something that went wrong once, with no step that would have prevented it, is not a lesson.

## 4. Tell the user, ask the user

In the chat only:

1. **What happened**, at most three lines.
2. **Proposals**, one line each with its evidence.

Then ask with AskUserQuestion what they noticed that you missed. Make the question stand on its own (name the story) and let them answer in their own words through "Other". Wait for the answer. You record it word for word under "## Noticed by me".

In a headless run, where you cannot ask, don't ask: write "Not asked: headless run" there.

## 5. Write it: specs/{nr}/retro.md

If retro.md already exists, continue it: keep what the user wrote.

```markdown
# Story {nr} retro: {story title}

Learning checkpoint after the local merge of dev/{nr} into {trunk} ({M}, `git log {M}^1..{M}^2`): merged locally, not released. Nothing below is applied.

## What happened

{at most three lines}

## Proposals

1. **{step}.** Change: {the exact change}. Evidence: {file:line, commit, event or command and output}.

{or: No reusable lesson: {why}.}

## Cleanup

{what `cleanup` printed, one line per worktree; name every file that blocked a removal}

## Noticed by me

{the user's answer word for word, or "Not asked: headless run"}
```

## 6. Cleanup: after the retro is written

```bash
node "${CLAUDE_SKILL_DIR}/scripts/learn.mjs" cleanup $ARGUMENTS
```

It runs `git worktree remove`, never `--force`, on every worktree under `.worktrees/` whose branch is merged into the trunk: the story's spec and dev worktrees and earlier learn and improve worktrees too. It never touches `learn/{nr}` itself, and keeps a branch that has no commit of its own yet. When git refuses because a worktree holds changes, leave it: never delete its files to make the removal pass. Copy every line it printed under "## Cleanup", including the files that blocked a removal.

## 7. Verify and commit

From the worktree (if the repository's check formats Markdown, format retro.md the way it expects first):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/learn.mjs" verify $ARGUMENTS
```

It must print `verify: ok`. It fails when the worktree is not on `learn/{nr}`, when a file other than retro.md changed since `start`, when the intro does not name M or does not say "merged locally" and "not released", when a section is missing or out of order, when "What happened" has more than three lines, when a proposal lacks its step, "Change:" or "Evidence:", and when "Cleanup" or "Noticed by me" is empty. Fix retro.md until it passes.

Commit retro.md alone, on `learn/{nr}`:

```bash
git add specs/{nr}/retro.md
git commit -m "Retro {nr}: {how many} proposal(s), nothing applied"
```

Then run `verify` once more: it must print `verify: ok (retro.md committed at …)`.

## 8. Limits

- Never apply a change: no edit to a skill, hook, script, guideline, AGENTS.md, spec, code or `.gitignore`. Proposals only.
- Write and commit only `specs/{nr}/retro.md`, only on `learn/{nr}`, never on the trunk. Never `git add` anything else.
- Never merge and never push: the person's merge of `learn/{nr}` is the approval.
- Never `git worktree remove --force`, and never delete files to unblock a removal.

## 9. Done: your closing message

Done means the user answered (or "Not asked: headless run" is recorded), retro.md is committed on `learn/{nr}` and `verify` printed `ok` after the commit, and every merged worktree is removed or named in "## Cleanup".

Your closing message holds:

1. The retro's commit hash on `learn/{nr}`.
2. The worktrees removed, and each one kept with the files that block it.
3. That story {nr} is merged locally and not released, that `learn/{nr}` reaches the trunk when the user merges it, and that `/pipe:improve {nr}` then asks which proposals to apply.
