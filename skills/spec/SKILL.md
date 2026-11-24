---
name: spec
description: Spec one roadmap story before any code exists. Runs the brainstorm (at most two AskUserQuestion rounds), writes specs/{nr}/brainstorm.md and specs/{nr}/spec.md on spec/{nr} in its own worktree (.worktrees/spec/{nr}), and handles rejections (Gate feedback), review findings (--address-findings) and revisions proposed by the implementation. Use for /pipe:spec 02, /pipe:spec 03 --address-findings.
argument-hint: "{nr} [--address-findings]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/spec.mjs" *)
---

# /pipe:spec $ARGUMENTS

You spec one story of `specs/roadmap.md`. The spec is the contract a person or an agent builds and tests against. You write no code.

The guard script `scripts/spec.mjs` decides the mode and checks every commit. The pipe plugin's hooks are always active, and in a spec worktree they block:

- a brainstorm round asked before the previous one is recorded;
- a third round;
- any change to text already in `brainstorm.md`;
- any change to "## Gate feedback";
- a commit on `spec/{nr}` that fails `verify`.

Never work around a block. Fix what it names. If it cannot be fixed, stop and tell the user.

## 1. Start: always first

```bash
node "${CLAUDE_SKILL_DIR}/scripts/spec.mjs" start $ARGUMENTS
```

- **`STOP: …` (exit 3):** relay the message word for word, then end the run. Do nothing else: no worktree, no file, no commit. It also stops when AGENTS.md has no `Check:` line or `.worktrees/` is not ignored: the repository is not set up yet (`/pipe:setup`).
- **Exit 0:** it prints `worktree:`, `branch:`, `mode:`, `next:` and the story's text from the roadmap. It created the worktree and the branch if they were missing. If they already existed, it reused them: never recreate either.

Then `cd` into the printed worktree. Every file you write and every command you run stays there, including AskUserQuestion: the hooks know the story from the worktree you are in. Change nothing in the repository root.

## 2. Context: before any question

Read these in the worktree:

- `AGENTS.md`
- every file in `specs/guidelines/` (at least `architecture.md`; `ui.md` when the repository has a screen)
- `pipeline.md` and `specs/setup.md`, if they exist
- the story (printed by `start`)
- the code the story touches

Technology, module, data and visual questions are settled by the guidelines: don't re-open them. If the story cannot be built within the guidelines, or conflicts with them, stop and ask the user. Don't decide it yourself.

## 3. Follow the mode

### `brainstorm`

Cover what the story leaves open:

- what a person sees or runs, and in which order (a screen, a command, an API, a file);
- the data and the interfaces it needs;
- what can go wrong: errors, edge cases, invalid data, and the test data each case needs.

Run each round like this:

1. **Ask one round:** one AskUserQuestion call, 1 to 4 questions. Each question names the story ("Story 02 …") and stands on its own. Each has 2 to 4 options. The one you recommend comes first, with "(Recommended)" at the end of its label.
2. **If a screen changes,** draw it as an ASCII wireframe in the `preview` of the layout question's options. The user corrects it in their answer. If they correct it, show the corrected version in round 2 and record the version they accepted.
3. **Wait for the answer.** Never answer for the user, never guess ahead, never ask in plain chat text instead.
4. **Record the round:** append it to `specs/{nr}/brainstorm.md` in the format of [format.md](format.md). Record every question and its options exactly as asked, your recommendation, and the answer word for word. Only append, with the Edit or Write tool, not a shell redirect. `verify` compares the record with the logged AskUserQuestion call.
5. **Then ask the next round.** At most two rounds in total; the story is small. When nothing is left open, go to `spec`.

### `spec`

1. Write `specs/{nr}/spec.md` in the shape of [format.md](format.md). It has no status line: on `spec/{nr}` it is a draft, and the person's merge into the trunk is the approval.
2. Write only what the answers and the guidelines settle. Anything you decide yourself is a choice: list it in the chat at the end.
3. If the story is too big for one small change, don't write a spec. Stop and give the reason: that is a valid result.

### `gate-feedback`

"## Gate feedback" is a rejection.

1. If the user's feedback is not committed yet, commit it alone first.
2. Revise the draft body above it so every point is answered.
3. Keep every word of the feedback, and every answer of the user, where it is.

### `address-findings`

The review in `spec-review.md` covers the current spec revision. Its findings are:

- every form check it marks as not met;
- every acceptance check it says is missing;
- every answer of the user in it that asks for a change.

On a domain question, the user's answer decides, never the review's recommendation.

1. No findings: say "Nothing to address." and stop.
2. Otherwise, append the findings word for word under "## Gate feedback" at the end of `spec.md`. Create the section if it is missing.
3. Run `verify` and commit that change alone.
4. Then revise the body as in `gate-feedback`, run `verify` and commit.

### `revision`

The implementation on `dev/{nr}` is blocked on a "## Proposed spec revision". Read it with `git show dev/{nr}:specs/{nr}/progress.md`.

1. Revise only `spec.md`, exactly as proposed there and as the user commented on it. Nothing else changes.
2. Run `verify` and commit.
3. Stop with exactly the line `start` printed after "then stop with:".

### `draft`

Finish the uncommitted changes to `spec.md`, run `verify` and commit.

## 4. Verify and commit

Run this from the worktree before every commit:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/spec.mjs" verify {nr}
```

It must print `verify: ok`. The commit hook runs it again and blocks on any problem. It checks that:

- only `specs/{nr}/brainstorm.md` and `specs/{nr}/spec.md` changed: no code, no other file;
- `brainstorm.md` is append-only, has at most two rounds, and every question has options, a recommendation and an answer;
- each new round matches one logged AskUserQuestion call word for word;
- `spec.md` has no status line, has the five sections in order, and numbers its acceptance checks 1…n, each starting with a bold label;
- a wireframe in the spec has one in the brainstorm;
- "## Gate feedback" is last, only grows, and is committed apart from body changes.

If the repository's check formats Markdown, format both files the way it expects before you verify. Commit with `git add specs/{nr}/brainstorm.md specs/{nr}/spec.md` and a message such as `Spec {nr}: <story title> (brainstorm and draft spec)`.

## 5. Limits

- No code, no other file. Commit only on `spec/{nr}`, in its worktree.
- Never merge and never push: a person merges, and the merge is the approval.
- A spec merged into the trunk is the contract. `start` stops there, unless the implementation proposes a revision.

## 6. Done

`brainstorm.md` and `spec.md` are committed on `spec/{nr}`, `verify` printed `ok`, and no code was written. Then tell the user, in the chat:

- what the spec fixes: what a person sees or runs, its states, the interfaces and what stays out;
- how many acceptance checks it has;
- every choice you made that the brainstorm did not cover;
- that `/pipe:review-spec {nr}` reviews it, and that merging `spec/{nr}` into the trunk approves it.
