---
name: new-spec
description: Create a new specification document in the specs/ directory. Use when the user asks to create a spec, write a specification, draft a spec, add a new spec, or generate a specification document.
---

# Create a New Specification

## Procedure

1. **Find the next number.** List the files in `specs/`. Find the highest
   number prefix. Add 1 to it. Use three digits with leading zeros. For
   example, if `002-foo.md` is the highest, the next number is `003`.

2. **Create the file.** Use the name `specs/<NNN>-<name>.md`. Get `<name>` from
   `$ARGUMENTS`. If `$ARGUMENTS` is empty, ask the user for a name.

3. **Use this template:**

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

4. **Write the content.** Work with the user to fill in the spec from their
   requirements.

Do not create a `.d` directory when you create the spec. Create it only when
the spec has supporting documents.

## Supporting Documents: the `.d` Directory

A spec can have a sibling directory. The directory has the same name as the
spec, but `.d` replaces `.md`:

```
specs/019-sandbox-ssh-stream-relay.md     <- the spec
specs/019-sandbox-ssh-stream-relay.d/     <- its supporting documents
```

The `.md` file is the specification. It tells what the team will build and
why. It must be complete and easy to review alone.

The `.d` directory holds working documents that support the spec. These
documents would make the spec too long. Examples are implementation plans,
test plans, critiques, run evidence, prompts, follow-up lists, and design
notes.

Obey these rules:

- Put supporting documents for `specs/NNN-name.md` in `specs/NNN-name.d/`.
  Create the directory when you add the first document.
- Do not rename or renumber the `.d` directory alone. If you rename the spec,
  rename its `.d` directory too.
- The `.md` spec is the authority. If a `.d/` document does not agree with the
  spec, the spec is correct. Update the spec or correct the document.
- Keep all design decisions in the `.md` spec, not in `.d/`. The spec can link
  to `.d/` for more detail. A reader must understand the spec without `.d/`.
- When a `.d` directory has more than two or three files, add a `README.md` to
  it. The `README.md` links back to the spec. It lists each document and gives
  its purpose in one line.
- A document in `.d/` can have its own `.d` directory. The same rules apply.
- Do not commit raw output, such as large logs or benchmark dumps. Commit only
  evidence that you examined and cleaned.

## Guidelines

- Use specs to record product, design, and technical decisions.
- Give sufficient detail to implement the spec. Do not paste large blocks of
  code.
- Tell why you made a decision, not only what the decision is.
- Write for human reviewers.
