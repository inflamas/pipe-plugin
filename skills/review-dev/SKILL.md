---
name: review-dev
description: Review the implementation of one roadmap story on dev/{nr}, strictly, through the read-only pipe:dev-reviewer agent that never saw the code being written, and commit its verdict (approve, rework or human) as specs/{nr}/review.md. Never changes code. Use for /pipe:review-dev 01.
argument-hint: "{nr}"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/review-dev.mjs" *)
---

# /pipe:review-dev $ARGUMENTS

You run the review of `dev/{nr}`. The judgement comes from the `pipe:dev-reviewer` agent, in a fresh context, never from this session: this session may be the one that wrote the code. The reviewer cannot edit: it has no Edit, Write or NotebookEdit, and the plugin's hooks block every shell command of it that would change the repository. Its final message is the review; the plugin saves it. Only you write `specs/{nr}/review.md`, from that report word for word, and it is the only file you commit. You never change code.

The guard script `${CLAUDE_SKILL_DIR}/scripts/review-dev.mjs` does the deterministic parts. Never work around what it reports. If you can't fix it, say so in your closing message.

## 1. Start: always first

```bash
node "${CLAUDE_SKILL_DIR}/scripts/review-dev.mjs" start {nr}
```

- **`STOP: …` (exit 3):** reply with that message word for word and nothing else. It stops when `.worktrees/dev/{nr}` does not exist (never create it), when it is not on `dev/{nr}`, when a tracked file has uncommitted changes, and when AGENTS.md has no `Check:` line.
- **Exit 0:** it prints `worktree:`, `trunk:`, `revision:` (the implementation revision), `round:`, `progress.md:`, `screenshots:`, `diff:`, `check:` and `app:` (the Run line with a free port).

From then on, work only in the printed worktree: start every command with `cd {worktree} &&`.

## 2. The review: in the reviewer agent

Start it with the Agent tool, `subagent_type: "pipe:dev-reviewer"`, in the foreground, and this prompt, filled in from `start`:

> Review dev/{nr}. Worktree: {worktree}. Trunk: {trunk}. Revision: {revision}. Round: {round}. Check: {check}. App: {app}. You did not write this code: read it fresh, and strictly. Your final message is the review and nothing else.

Don't pass along your own view of the code, the spec or this conversation. Wait for it to finish. Don't review it yourself while it runs.

Then run:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/review-dev.mjs" findings {nr}
```

It prints the reviewer's review when it passes every check of section 4: lines 1 to 3, the sections, a row for every acceptance check, every rule word for word with "fires" or "clear", a finding for every missing screenshot or stale progress line, the browser rule when the browser was not available, and a verdict that follows from the rules, the findings and the round. If it reports problems, start the reviewer again with the same prompt plus the problems, at most twice. Never fix the review yourself: it would no longer count.

## 3. Record and commit

```bash
node "${CLAUDE_SKILL_DIR}/scripts/review-dev.mjs" record {nr}
node "${CLAUDE_SKILL_DIR}/scripts/review-dev.mjs" verify {nr}
```

`record` writes the report to `specs/{nr}/review.md`, word for word. `verify` must print `verify: ok`. It fails when any file other than review.md changed since `start`, when review.md is not the reviewer's report word for word, and on everything `findings` checks. If the repository's check formats Markdown and fails on review.md, format it the way it expects (a formatter's table padding still counts as word for word) and verify again.

Commit review.md alone:

```bash
git add specs/{nr}/review.md
git commit -m "Review {nr}: verdict {verdict} at {revision}"
```

Then run `verify {nr}` once more: it must still print `verify: ok`. Never `git add` anything else, never amend another commit, never merge, never push.

## 4. Limits

- Never change code, tests, the spec, progress.md, evidence or any other file. Only review.md, written by `record`.
- Commit only review.md, only on dev/{nr}, in its worktree.

## 5. Done: your closing message

Done means review.md is committed on dev/{nr}, `verify` printed `ok` after the commit, and no code changed.

Your closing message goes to the user. It holds these three parts, taken from review.md, and nothing else:

1. **What changed**
2. **Picture**, in a code block
3. **Needs you:** the verdict and the revision, the Browser line, every rule that fires with its evidence, the findings in one line each, and the places to read line by line. Last, the review's commit hash, and what comes next: merge `dev/{nr}` to approve (then `/pipe:learn {nr}`), or `/pipe:dev {nr} --address-findings` for rework.
