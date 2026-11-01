# Specifications

This directory contains product, design, and technical specifications for the Amika project.

## Creating a New Spec

### Naming Convention

Spec files are prefixed with a three-digit number for chronological ordering:

```
000-v0-cli-spec.md
001-sandbox-design.md
002-linux-support.md
```

To find the next number, look at the highest existing number and increment by one.

### File Structure

Each spec should include:

1. **Title** - Clear, descriptive name
2. **Overview** - Brief summary of what this spec covers
3. **Detailed sections** - Commands, APIs, behavior, implementation notes as appropriate
4. **Dependencies** - External requirements if any
5. **Future Considerations** - Known limitations and potential future work

### How to Create a Spec

You can create a new spec in two ways:

1. **Slash command**: `/new-spec <name>` (e.g., `/new-spec sandbox-design`)
2. **Natural language**: Just ask Claude to "create a spec" or "write a new specification for X"

Either way, Claude will:
1. Determine the next available number prefix
2. Create a new spec file with the standard template
3. Open it for editing

### Supporting Documents

A spec can have a sibling `.d` directory for its supporting documents. The
directory has the same name as the spec, but `.d` replaces `.md`:

```
003-file-based-rwcopy-mounts.md     <- the spec
003-file-based-rwcopy-mounts.d/     <- its supporting documents
```

Examples of supporting documents are implementation plans, test plans,
critiques, run evidence, and design notes. Do not create a `.d` directory
until the spec has a supporting document.

- The `.md` spec is the authority. If a `.d/` document does not agree with the
  spec, the spec is correct.
- Keep all design decisions in the spec. A reader must understand the spec
  without `.d/`.
- If you rename the spec, rename its `.d` directory too.
- When a `.d` directory has more than two or three files, add a `README.md`
  that links back to the spec and lists each document with its purpose.
- Do not commit raw output, such as large logs or benchmark dumps.

### Guidelines

- Specs should be human-readable and serve as documentation of decisions
- Include enough detail for implementation, but avoid dumping raw code
- Document the "why" behind decisions, not just the "what"
- Update specs when designs change significantly
