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

## Guidelines

- Specs document product, design, and technical decisions
- Include enough detail for implementation, but avoid raw code dumps
- Document the "why" behind decisions, not just the "what"
- Keep specs human-readable for review
