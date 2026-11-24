# Formats checked by `verify`

## brainstorm.md

Append-only. One "## Round" per AskUserQuestion call, two at most. Keep the blank lines as shown: a blank line between "Options:" and its list. Copy each question exactly as you asked it, and each answer exactly as the user gave it: the selected label, or the free text they typed.

````markdown
# Story {nr} brainstorm: {story title}

## Round 1

### Q1. {the question, exactly as asked}

Options:

- **{label 1} (Recommended)**: {its description}
- **{label 2}**: {its description}

Wireframe shown with the recommended option:   ← only for a screen; omit otherwise

```
{the ASCII wireframe from the preview}
```

Recommendation: {label 1}.

Answer: "{the user's answer, word for word}"

### Q2. …

## Round 2

…
````

If the user corrected the wireframe, record the corrected version they accepted in round 2, under its question.

## spec.md

No status line. These five sections, in this order. Write "None." under a section that does not apply (a story without a screen has "None." under "## On screen"). Add others between them if the story needs it.

````markdown
# Story {nr} spec: {story title}

Roadmap: story {nr} in `specs/roadmap.md`. Decisions: `specs/{nr}/brainstorm.md`.

{one paragraph: what a person can do afterwards, within the guidelines}

## On screen

{the accepted ASCII wireframe, top-to-bottom order, then the states, or "None."}
### Ready state
### Loading state
### Error state
### Empty states
### Layout            ← the widths specs/guidelines/ui.md names

## Data

{what is read and written, how rows or records are chosen and ordered; schema or seed changes, or "None."}

## Interfaces

{each API endpoint, command, file or event: its input, its output on success as an example, every failure with its output, what is logged; or "None."}

## Stays out

{bullets: what this story explicitly does not do, naming the story that does it}

## Acceptance checks

{how they are verified: the check (AGENTS.md) for code, the browser plus screenshots in specs/{nr}/evidence/ for a screen}

### {Interface or command}

1. **{Interface}, {case}:** {setup / what you do} → {what you should see}.

### Screen: {screen name}   ← only with a screen

2. **{Screen name}, {case}:** {what you do} → {what you should see}.

N. **Guidelines:** the check (`{the Check line of AGENTS.md}`) passes.
````

Acceptance checks:

- They are numbered 1…n with no gaps, across subsections.
- Each starts with a bold label naming the screen, the interface or the command and the case, followed by what you do and what you should see.
- They include the error and edge cases (and for a screen the empty, loading and error states), not only the happy path.
- Each is concrete enough for a test or a person to verify.

## Gate feedback

The person writes it, or `--address-findings` appends findings word for word. It is always the last section of `spec.md`, and it only grows:

```markdown
## Gate feedback

{the person's feedback, or the review's findings copied word for word}
```
