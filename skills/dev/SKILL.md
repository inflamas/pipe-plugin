---
name: dev
description: Implement the approved spec of one roadmap story on dev/{nr} in its own worktree (.worktrees/dev/{nr}). Tests for the acceptance checks first, then the code, then every screen check by hand in a headless browser with screenshots; ends ready for review, or blocked on a proposed spec revision. --address-findings reworks exactly the findings of the review and the user. Use for /pipe:dev 01, /pipe:dev 02 --address-findings.
argument-hint: "{nr} [--address-findings]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/dev.mjs" *)
---

# /pipe:dev $ARGUMENTS

You implement one story from its approved spec. Merging is the approval: `spec/{nr}` merged into the trunk makes `specs/{nr}/spec.md` the contract. You build exactly that, prove every acceptance check, and leave `dev/{nr}` for a person to review and merge.

The script `${CLAUDE_SKILL_DIR}/scripts/dev.mjs` does the deterministic parts: the gate, the worktree, the mode, the implementation revision and the final check. The pipe plugin's hooks also apply: they block any change to a `spec.md` off a spec/ branch, any merge, any push but a story branch's own, a dependency declared outside the allowed manifests, and the end of your turn while the check is red (unless progress.md says "State: blocked"). Never work around a block. Fix what it names. If you can't, stop and say so.

## 1. Start: always first

```bash
node "${CLAUDE_SKILL_DIR}/scripts/dev.mjs" start $ARGUMENTS
```

- **`STOP: …` (exit 3):** relay the message word for word as your one closing line, and end the run. It stops when the trunk has no `specs/{nr}/spec.md`, when a local `spec/{nr}` holds a spec.md the trunk does not (an unmerged revision; a deleted or squash-merged `spec/{nr}` is fine), when the story is blocked and not yet released, when it is already ready for review at the current revision, when the main checkout is not on an up-to-date trunk, and when AGENTS.md has no `Check:` line.
- **Exit 0:** it prints `worktree:`, `branch:`, `install:`, `mode:`, `revision:`, `check:` (the command from AGENTS.md), `screen:`, `app:` (the Run line with a free port) and `next:`, and with `--address-findings` the findings of `review.md`. When the worktree was missing, it ran `git worktree add .worktrees/dev/{nr} -b dev/{nr}` from the trunk and the Install line of AGENTS.md there. When the worktree exists, it reused it: never recreate it.

From then on, work only in the printed worktree. The Bash tool's working directory can fall back to the repository root between calls, so start every command with `cd {worktree} &&` and give every file path as an absolute path inside the worktree. Change nothing in the repository root.

## 2. Context: before any code

Read these in the worktree: `AGENTS.md`, every file in `specs/guidelines/`, `specs/{nr}/spec.md`, and the code the spec touches. Follow the guidelines. If the spec conflicts with them, stop and ask the user; don't decide it yourself.

## 3. Follow the mode

### `build`: the first run, or continuing from progress.md

1. **progress.md first.** On the first run, create `specs/{nr}/progress.md` (shape in section 5) with line 1 "State: building" and commit it. Otherwise continue from it.
2. **Tests first.** For each numbered acceptance check, write the test before the code, run it, and see it fail. Then implement until it passes.
   - Tests live where `specs/guidelines/architecture.md` says, and the check runs them.
   - Screen checks get markup or component tests too, with what the repository already has: no new dependency. They don't replace the browser: markup can pass while the browser shows something else.
   - Name each test after its check ("check 7: …") and record each check's status and evidence (the test name) in progress.md.
3. **Commit after every green step.** Commit whenever the check (`check:` from `start`) is green. Never commit red.
4. **Stay inside the spec.** No new dependency, module or design token the spec doesn't name. A small open question goes under "## Open questions" in progress.md.
5. **Material gap.** A gap is material when it changes what gets built or how it is checked. When you hit one, stop the affected work. Write the gap and the revision you propose under "## Proposed spec revision", set line 1 to "State: blocked", commit, and end with one line saying why you stopped. Never edit `spec.md`: `/pipe:spec {nr}` revises it on `spec/{nr}`.
6. **Finish:** run section 4.

### `resume`: the block is released

`start` only gives this mode in one of two cases. Either `spec.md` changed on `dev/{nr}` after the commit that set the block and `spec/{nr}` is merged into the trunk (the user approved the revision and merged the trunk into the dev branch), or the user wrote "Build as specified" under the proposal.

1. Set line 1 to "State: building" and commit.
2. Build against `spec.md` as it is now, as in `build`. Re-check every acceptance check the revision changed. Keep the proposal in progress.md as the record.

### `finish`: ready for review, but the revision moved

Something changed after lines 2 and 3 were written. Run section 4 again.

### `address-findings`: rework

1. **Collect the findings on the current revision.**
   - First, the numbered findings of `review.md` that `start` printed. They count only when `review.md` names the current revision.
   - Then ask the user for their own findings with AskUserQuestion, naming the revision.
   - In a headless run you can't ask, so take only review.md's findings.
2. **No finding at all:** end with "Nothing to address."
3. **Record them.** Copy every finding word for word under "## Rework requested" in progress.md, headed `### On {revision}`, marking each finding "review.md" or "user". Set "State: building" and commit.
4. **Fix exactly those findings.** Nothing else: no extra refactor, no unrelated fix. When fixing a finding would break the spec, treat it as a material gap (step 5 of `build`).
5. **Then section 4:** check, browser, the new revision in lines 2 and 3, "State: ready for review".

## 4. Done: check, browser, ready

1. **Every check has evidence and the check is green.** Line 2 of progress.md is "Check: green at {revision}". `{revision}` is always what `node "${CLAUDE_SKILL_DIR}/scripts/dev.mjs" revision {nr}` prints.
2. **The browser pass, when the spec has a screen** (`screen: yes` from `start`). With `screen: no`, line 3 is "Browser: not needed, the spec has no screen": skip to step 6.
   - **The app:** with `APP_URL` set, the runner already started the app there: use it, and never start or stop a server. Otherwise start the `app:` command from `start` in the worktree, in the background, with its output in the scratchpad, and open its URL.
   - **The browser is the plugin's Playwright server, headless:** its tools are `mcp__plugin_pipe_playwright__browser_*`. When they are deferred, load the ones you need in one ToolSearch call.
   - **If the browser is not available, don't fail and don't loop.** That is: no such tools after one ToolSearch, or the first `browser_navigate` fails because the browser cannot start (a missing browser, a sandbox, a container). Then try once more at most, never more, and don't install or debug anything. Write line 3 as "Browser: not available ({the error in a few words})". Leave the screen checks no test proves as `open`, with "browser not available" as their evidence, and go on to step 6. The review then sends the change to a person. Stop only the server you started.
3. **Go through every acceptance check by hand, as a user would,** at the widths `specs/guidelines/ui.md` names (390 and 1440 px if it names none).
   - Set each width with `browser_resize` (height 900).
   - Read what the user reads with `browser_snapshot` and `browser_evaluate`: `innerText`, computed colours, positions, and `scrollWidth` against `clientWidth` for horizontal scroll. The markup alone isn't enough. Click as a user would with `browser_click`.
   - Reach error and empty states for real where you can. Use `browser_run_code_unsafe` with `page.route` to hold a response (for the loading state) or to mock one. Mock only when the real app can't produce the response, and say so in that check's evidence.
   - When a check fails, fix the app, add a test that catches it if one can, and commit after a green check.
4. **Screenshots.** Capture every screen the story touches at both widths into `specs/{nr}/evidence/` as `{screen}-390.png` and `{screen}-1440.png` (the widths ui.md names). A state of a screen is `{screen}-{state}`, e.g. `home-error-390.png`.
   - Use `browser_take_screenshot` with `fullPage: true`, `scale: "css"` and `filename` set to the absolute path in the worktree. If the server refuses that path, save it under its output folder and copy it into `specs/{nr}/evidence/`.
   - Open every screenshot with Read and hold it against `specs/guidelines/ui.md` and the spec's wireframe. Fix what is off. A fix changes the revision, so take every screenshot again after it.
5. **Leave no trace.** Close the browser with `browser_close`. Stop the servers you started, and only those: check a PID's command and working directory before you kill it. Then commit the screenshots.
6. **Lines 2 and 3.** Line 2 is "Check: green at {revision}". Line 3 is one of:
   - "Browser: {n} of {n} checks seen, screenshots at {revision}", where n is the number of checks you saw in the browser;
   - "Browser: not needed, the spec has no screen";
   - "Browser: not available ({why})".

   Set line 1 to "State: ready for review".
7. **Verify, then commit progress.md:**

   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/dev.mjs" verify {nr}
   ```

   It must print `verify: ok`: both lines name the current revision, n of n, every acceptance check has a row with "done" (or "open" when the browser was not available) and evidence, and every screenshot has its twin width. If the repository's check formats Markdown, format progress.md the way it expects first.

Committing progress.md, review.md or `evidence/` doesn't move the revision; any other change does and voids lines 2 and 3. After such a change, run section 4 again.

## 5. progress.md

Write it with the Write and Edit tools, not shell redirects. Its shape:

```markdown
State: building
Check: green at {revision}
Browser: {n} of {n} checks seen, screenshots at {revision}

# Story {nr} progress: {title}

{one paragraph: where the tests live, how the browser pass ran}

## Acceptance checks

| #   | Check | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | {label} | done | `{test name}`; browser: {what was seen}; `{screen}-390.png` |

## Open questions

## Proposed spec revision   (only when blocked)

## Rework requested         (only after --address-findings)
```

Lines 2 and 3 appear only once section 4 has run. Status is `done` or `open`.

## 6. Hygiene

- A fresh worktree ran the Install line; tracked files it rewrote were restored. Never commit that noise.
- Never add a dependency to make a check easier: the browser is the plugin's Playwright server, and data built for a case lives in the scratchpad.
- When a tool you need is missing, say so in progress.md. Don't quietly work around it.

## 7. Limits

- Never edit `spec.md`, on any branch. Agents never merge. A skill pushes only its own story branch and opens its pull request; a person merges, and merging is the approval. /pipe:dev never pushes: its review comes first, and `/pipe:review-dev {nr}` pushes `dev/{nr}` and opens its pull request.
- Work and commit only on `dev/{nr}`, in its worktree.

## 8. The last line

Every run ends with exactly one line in the chat. Either:

> dev/{nr} is ready for review at {revision}: run /pipe:review-dev {nr}.

or why it stopped (the `STOP:` message, the blocked gap, or "Nothing to address.").
