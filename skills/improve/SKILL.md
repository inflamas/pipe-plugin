---
name: improve
description: After a person merged learn/{nr}, ask them about each proposal of specs/{nr}/retro.md with AskUserQuestion and apply only what they decide, on improve/{nr} in its own worktree, recorded in specs/{nr}/improve.md, then push improve/{nr} and open its pull request. Proposals for the pipe plugin itself are written down for its maintainers, not applied. Never decides for the person. Use for /pipe:improve 01.
argument-hint: "{nr}"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/improve.mjs" *)
---

# /pipe:improve $ARGUMENTS

`/pipe:learn` proposed; you ask, and the person decides. For every proposal in `specs/{nr}/retro.md` you ask once, apply exactly what the person decided, and record each question and answer word for word in `specs/{nr}/improve.md` on `improve/{nr}`. You push `improve/{nr}` and open its pull request last; the person's merge of it is the approval. You never apply a proposal nobody accepted, and you never change one beyond what the person said.

## 1. Start: always first

```bash
node "${CLAUDE_SKILL_DIR}/scripts/improve.mjs" start $ARGUMENTS
```

- **`STOP: …` (exit 3):** relay it word for word and end the run. It stops when the trunk has no `specs/{nr}/retro.md` (merge `learn/{nr}` first) and when AGENTS.md has no `Check:` line.
- **Exit 0:** it prints `worktree:`, `branch:`, `record:` and every proposal. Work only in the printed worktree: start every command with `cd {worktree} &&`.

If the retro has no proposals, write improve.md with "None." under "## Decisions", verify, commit, and stop.

## 2. Ask: one question per proposal

Read `AGENTS.md`, `specs/guidelines/` and the files each proposal names. Then ask with AskUserQuestion, at most four proposals per call, as many calls as needed:

- Each question stands on its own: "Story {nr} retro, proposal {n} ({step}): {the change, in one sentence}. Apply it?"
- Options, with your recommendation first and "(Recommended)" at the end of its label:
  - **Apply as written:** you change exactly the files the proposal names, as it says.
  - **Skip:** nothing changes.
  - **Plugin:** when the change belongs to the pipe plugin (a skill, agent, hook or script under `${CLAUDE_PLUGIN_ROOT}`): it is recorded for the plugin's maintainers and not applied here. Offer it only for such a proposal; it is then usually your recommendation.
- The person can answer in their own words through "Other": that is "apply as changed", and their words are the change.
- Wait for the answers. Never answer for the person, and never ask in plain chat text.

## 3. Apply what was decided, nothing else

On `improve/{nr}`, in the worktree:

- "Apply as written" and "apply as changed": make exactly that change. Never touch a `spec.md` (the spec gate blocks it) or another story's record under `specs/{nr}/`.
- Run the check (`Check:` in AGENTS.md). If an applied change turns it red and the fix isn't part of the decision, undo that change and ask the person again with the failure.
- "Skip" and "Plugin": change nothing.

## 4. Record it: specs/{nr}/improve.md

```markdown
# Story {nr} improve: {story title}

Proposals from specs/{nr}/retro.md on {trunk}. A person decided each one; only what they decided is applied on improve/{nr}.

## Round 1

### Q1. {the question, exactly as asked}

Options:

- **{label} (Recommended)**: {description}
- **{label}**: {description}

Recommendation: {label}.

Answer: "{the person's answer, word for word}"

## Decisions

| # | Proposal | Decision | Applied in |
| --- | --- | --- | --- |
| 1 | {step} | apply | `AGENTS.md`, `.gitignore` |
| 2 | {step} | skip | — |
| 3 | {step} | plugin | the pipe plugin: {the change, for its maintainers} |
```

One "## Round" per AskUserQuestion call. Decision is exactly `apply`, `apply as changed`, `skip` or `plugin`. "Applied in" names every file the decision changed.

## 5. Verify and commit

```bash
node "${CLAUDE_SKILL_DIR}/scripts/improve.mjs" verify $ARGUMENTS
```

It must print `verify: ok`: every proposal has a decision, every question and answer is word for word from a logged AskUserQuestion call, every changed file is named by an applied decision, and no spec or story record changed. Then commit everything that changed together, with a message such as `Improve {nr}: {k} of {n} proposals applied`, and run `verify` once more.

Last, push `improve/{nr}` and open its pull request:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/improve.mjs" publish $ARGUMENTS
```

It pushes nothing unless everything is committed and `verify` passes. Then it pushes `improve/{nr}` to origin and opens its pull request, titled "Improve {nr}: {story title}" (or reuses the open one after pushing again). If the push or `gh` fails (no remote, no login, no network), it prints one line with the exact command for a person to run and exits 0: relay that line, don't retry, and end the run normally.

## 6. Limits and done

- Agents never merge. A skill pushes only its own story branch and opens its pull request; a person merges, and merging is the approval. Push only through `publish`, only `improve/{nr}`: the person's merge of its pull request is the approval.
- Never apply what the person did not accept, and never change a plugin file from here.

Close with: the commit hash on `improve/{nr}`, the pull request's URL (or the command `publish` printed for a person to run), each proposal with its decision in one line, and that merging the pull request of `improve/{nr}` makes the changes part of the pipeline.
