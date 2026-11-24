---
name: review-spec
description: Review the draft spec of one roadmap story before the person's gate. The read-only pipe:spec-reviewer agent checks form and domain rules in a fresh context; then the user answers every domain item with AskUserQuestion, and specs/{nr}/spec-review.md is written and committed on spec/{nr}, which is then pushed with its pull request open. Never approves or rejects. Use for /pipe:review-spec 01.
argument-hint: "{nr}"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/review-spec.mjs" *)
---

# /pipe:review-spec $ARGUMENTS

You run the review of a draft spec before the user decides at the gate. The judgement comes from the `pipe:spec-reviewer` agent, in a fresh context, never from this session: this session may be the one that wrote the spec. The reviewer cannot edit: it has no Edit, Write or NotebookEdit, and the plugin's hooks block anything else that would change the repository. Its final message is its findings; the plugin saves it. You relay the findings, ask the user, record the answers and commit the record: only you write `spec-review.md`. The spec isn't yours to change, approve or reject.

The guard script `scripts/review-spec.mjs` enforces the loop. While a review is in progress, the plugin's hooks block:

- any AskUserQuestion before the reviewer's findings are in, and any question that doesn't mark exactly one option "(Recommended)";
- any write in the worktree other than `specs/{nr}/spec-review.md`: never `spec.md`, `brainstorm.md` or code;
- a commit that fails `verify`.

`verify` also rejects findings that are not the reviewer's own report, or a report changed after the reviewer gave it. Never work around a block. Fix what it names. If it can't be fixed, stop and tell the user.

## 1. Start: always first

```bash
node "${CLAUDE_SKILL_DIR}/scripts/review-spec.mjs" start $ARGUMENTS
```

- **`STOP: …` (exit 3):** relay the message word for word and end the run. Do nothing else. It stops when the worktree `.worktrees/spec/{nr}` doesn't exist (it is never created here), when it isn't on `spec/{nr}`, when there is no committed draft, when the draft has uncommitted changes, when the spec is already merged, when `spec-review.md` already covers the current revision, and when the repository is not set up (no `Check:` line in AGENTS.md).
- **Exit 0:** it prints `worktree:`, `revision:` and the story.

Then `cd` into the printed worktree. Every file you write and every command you run stays there.

## 2. The review: in the reviewer agent

Start it with the Agent tool, `subagent_type: "pipe:spec-reviewer"`, in the foreground, and this prompt, filled in:

> Review the draft spec of story {nr}. Worktree: {worktree}. Spec revision: {revision}. You did not write it: read it fresh, and strictly. Your final message is the findings and nothing else.

Don't pass along your own view of the spec, the brainstorm, or this conversation. Wait for it to finish. Don't do the review yourself while it runs.

Then run:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/review-spec.mjs" findings {nr}
```

It prints the reviewer's findings (Form, Domain precheck, Missing checks), then the items that go under "Needs you" and the items to ask. If it reports a problem with the findings, run the reviewer again with the same prompt plus the problem. Never write or fix the findings yourself: they would no longer count.

## 3. Tell the user: in the chat, these three parts and nothing else

Read `specs/{nr}/spec.md` to draw them.

1. **What changes:** at most three lines on what the repository gains once this spec is built.
2. **Picture:** a small diagram in a code block, in plain characters so the terminal shows it: screens, interfaces and data, with the new parts marked (`[NEW]`, `[GONE]`).
3. **Needs you:** one line per item that `findings` listed (form check not met, guess, conflict, missing check), naming the spec line. If there are none, write "Nothing".

Then ask every domain item (each guess, conflict and missing check) with AskUserQuestion:

- Use 1 to 4 questions per call, and as many calls as you need.
- Each question stands on its own. It names the spec ("Spec {nr} line 60 / check 25: …") and what the sources say or leave open.
- Each question has 2 to 4 options. Put the reviewer's recommendation first, with "(Recommended)" at the end of its label.
- Wait for the answers. Never answer for the user, never assume an answer, never ask in plain chat text.

Form checks that are not met are findings, not questions. Don't ask them.

## 4. Record it: specs/{nr}/spec-review.md

Write it with the Write tool, in the shape of [format.md](format.md):

- Line 1 is `Revision: {revision}`.
- Then the three parts exactly as you showed them.
- Then Form, Domain precheck and Missing checks, copied word for word from the findings.
- Then every question, exactly as asked, with your recommendation and the user's answer word for word.

If anything needs a change, end with this one line:

```
Findings to address: run /pipe:spec {nr} --address-findings.
```

Something needs a change when a form check is not met, a check is missing, or one of the user's answers asks for a change. Never write a verdict, status or approval: the gate is the user's.

If `spec-review.md` reviews an older revision, replace it: the old review stays in git history, and it is void once the spec has changed.

## 5. Verify and commit

From the worktree (if the repository's check formats Markdown, format the record the way it expects first):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/review-spec.mjs" verify {nr}
```

It must print `verify: ok`. The commit hook runs it again and blocks on any problem. It checks that:

- only `specs/{nr}/spec-review.md` changed: `spec.md`, `brainstorm.md` and the code are untouched;
- line 1 names the current revision of `spec.md`;
- the sections are present and in order, "What changes" has 1 to 3 lines and "Picture" has a code block;
- Form, Domain precheck and Missing checks are the reviewer's findings word for word, and the reviewer gave them for this revision;
- "Needs you" has one line per item, or reads "Nothing";
- every domain item was asked, and every question and answer matches a logged AskUserQuestion call word for word;
- the findings line is there, last, when a form check is not met or a check is missing;
- nothing reads as a verdict.

Commit it on its own. Don't chain other commands, and don't name `spec.md` in the same command, because the spec gate blocks that:

```bash
git add specs/{nr}/spec-review.md
git commit -m "Spec review {nr}"
```

## 6. Push and open the pull request: the last step

Only after the commit, from the worktree:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/review-spec.mjs" publish {nr}
```

It runs `verify` again and pushes nothing unless the record is committed and passes. Then it pushes `spec/{nr}` to origin and opens its pull request, titled "Spec {nr}: {story title}", whose body says what to read and "Merging is the approval." When a pull request for `spec/{nr}` is already open (a later review of the same spec), it pushes again and reuses it. If the push or `gh` fails (no remote, no login, no network), it prints one line with the exact command for a person to run and exits 0: relay that line, don't retry, and end the run normally.

## 7. Limits

- Change neither `spec.md` nor `brainstorm.md`, and write no code.
- Commit only `spec-review.md`, only on `spec/{nr}`, in its worktree.
- Agents never merge. A skill pushes only its own story branch and opens its pull request; a person merges, and merging is the approval. Push only through `publish`, only `spec/{nr}`. Never approve or reject: merging is the user's approval, and "## Gate feedback" is the user's rejection.

## 8. Done

Done means:

- the user answered every question in the chat;
- `verify` printed `ok` and `spec-review.md` is committed on `spec/{nr}`;
- `publish` ran: `spec/{nr}` is pushed with its pull request open, or its line names the command for a person;
- `spec.md` is unchanged.

Then tell the user in three lines:

- the review's commit, and whether it ends with the findings line;
- the pull request's URL, or the command `publish` printed for a person to run;
- that the gate is theirs: merge the pull request of `spec/{nr}` to approve, add "## Gate feedback" to reject, or run `/pipe:spec {nr} --address-findings`.
