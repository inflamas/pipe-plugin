# spec-review.md: the format checked by `verify`

Line 1 is the revision. The three parts follow, exactly as shown in the chat. Form, Domain precheck and Missing checks are the reviewer's findings, copied word for word. Then come the questions. These sections, in this order:

````markdown
Revision: {last commit of specs/{nr}/spec.md}

# Story {nr} spec review: {story title}

## Summary

### What changes

{one to three lines}

### Picture

```
{plain-character diagram: screens, interfaces, data, new parts marked [NEW] / [GONE]}
```

### Needs you

- Form not met: {check}: {spec line and why}.
- Guess: {rule} ({spec line}).
- Conflict: {rule} contradicts {source} ({spec line}).
- Missing check: {what is missing}.

{or exactly "Nothing" when there are no items}

## Form

{from the findings, word for word}

## Domain precheck

{from the findings, word for word}

## Missing checks

{from the findings, word for word}

## Questions and answers

### Q1. {the question, exactly as asked}

Recommendation: {the option you marked (Recommended)}.

Answer: "{the user's answer, word for word}"

### Q2. …

{or exactly "None." when nothing was asked}

Findings to address: run /pipe:spec {nr} --address-findings.   ← only when something needs a change; always last
````

"Needs you" has one line for each form check that is not met, each guess, each conflict and each missing check. Every guess, conflict and missing check is asked, so there are at least that many questions. A form check that is not met is not asked: it is already a finding.
