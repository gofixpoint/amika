---
name: naive-reader-review
description: "Pressure-test a docs page for clarity by having a naive sub-agent read it cold. A Sonnet sub-agent with no prior context reports what the tool seems to do, gaps between what's promised and what the commands deliver, passages that needed a re-read, and terms it couldn't define. The supervisor then revises the doc from that feedback."
---

# Naive reader review

Use when you want to know whether a docs page (a file under `docs/`, a README
section, a tutorial) actually lands with a developer who has no prior context
on this product.

**Usage:** `/naive-reader-review <path to the doc>`

---

## Phase 1: Spawn the naive reader

Spawn a sub-agent with the Agent tool:

- `subagent_type: general-purpose`
- `model: sonnet`
- Point it at exactly one file. Tell it to read only that file: no exploring the repo, no outside knowledge about this product or company, no charitable assumptions. It should answer only from the literal words in the doc.

Brief it as a blunt, impatient developer landing on the page cold (from a link
or search). It has the audience's baseline knowledge — it vaguely knows what AI
coding agents like Claude Code are — but knows nothing about amika or this
repo, and will not fill in gaps. Have it answer:

1. What does this tool do?
2. What problem does it claim to solve, and did the problem feel real and concrete?
3. What value would the reader get, specifically? Could they tell what they'd actually do with the tool after following the doc?
4. Does the solution deliver on the problem, or is there a gap between what's promised and what the commands let you do?
5. Was everything understandable on one read? List every spot that needed a re-read or felt like a logical leap.
6. List every term or phrase it can't define from the text alone (jargon, product names used without introduction, references that assume context it doesn't have).

Ask it to keep the answer short.

## Phase 2: Revise

Read the sub-agent's answers. Each point of confusion is a fix:

- If it misread what the tool does or the value, the value prop isn't leading clearly enough.
- If it found a gap between the promise and what the commands actually do, show the mechanism or state the boundary honestly; don't paper over it with bigger claims.
- If it flagged an undefined term, define it in context or cut it.

Apply the fixes in the main agent so the user sees the diff. Skip changes that
would lose something the user explicitly asked for.

## Notes

- Run the reader on one representative page when several are near-identical; apply the resulting fixes to all of them.
- The point is clarity to a cold reader, not polish. Don't let the revision get longer or more hedged.
