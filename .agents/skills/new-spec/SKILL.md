---
name: new-spec
description: Create a new specification document in the specs/ directory. Use when the user asks to create a spec, write a specification, draft a spec, add a new spec, or generate a specification document.
---

# Create New Specification

When creating a new spec:

1. **Find the next number**: List files in `specs/` directory and find the highest existing number prefix (e.g., if `002-foo.md` exists, the next is `003`). Use three digits with leading zeros.

2. **Create the file**: Name it `specs/<NNN>-<name>.md` where `<name>` comes from `$ARGUMENTS` or ask the user if not provided.

3. **Use this template**:

```markdown
# <Title>

## Overview

<Brief summary of what this spec covers>

## <Main Sections>

<Detailed content organized into logical sections>

## Dependencies

<External requirements, if any>

## Future Considerations

<Known limitations and potential future work>
```

4. **Fill in content**: Work with the user to populate the spec based on their requirements.

Do not create a `.d` directory up front. It is added later, only if the spec
accumulates supporting material.

## Supporting Documents: the `.d` Directory

A spec can have a sibling directory named after it with `.md` replaced by `.d`:

```
specs/019-sandbox-ssh-stream-relay.md     <- the spec
specs/019-sandbox-ssh-stream-relay.d/     <- its supporting documents
```

The `.md` file is the specification: what is being built and why, durable and
reviewable on its own. The `.d` directory holds working material that supports
the spec but would clutter it, such as implementation plans, test plans,
critiques, run evidence, prompts, follow-up lists, and scratch design notes.

When working with these:

- Put new supporting documents for spec `NNN-name.md` in `specs/NNN-name.d/`,
  creating the directory on first use. Never rename or renumber it separately
  from the spec.
- Treat the `.md` spec as authoritative. If a `.d/` document contradicts it,
  the spec wins; either update the spec or correct the supporting document.
- Keep the spec self-contained. Design decisions belong in the `.md` file, not
  hidden in `.d/`. Link into `.d/` for detail, do not depend on it for meaning.
- Once a `.d` directory holds more than a couple of files, give it a
  `README.md` that links back to the spec and lists each document with a
  one-line purpose.
- A document inside `.d/` may have its own `.d` directory under the same rule.
- Keep raw, unreviewed output (large logs, benchmark dumps) out of Git. Commit
  sanitized evidence only.

## Guidelines

- Specs document product, design, and technical decisions
- Include enough detail for implementation, but avoid raw code dumps
- Document the "why" behind decisions, not just the "what"
- Keep specs human-readable for review
