# CLI command guidance

## Usage and help text

- Treat a Cobra command's `Use` as a precise synopsis. Write required
  positional arguments as `<value>`, optional arguments in brackets, and
  repeatable arguments with `...`.
- When a command accepts multiple distinct positional forms, show each complete
  invocation on its own line under `Usage:`, following Git's help style. Do not
  join variants with `|` in a single usage line.
- Keep the first or most common form in `Use` so Cobra's command name,
  completion, and generated-document behavior remain well-defined. Use a
  command-specific usage template to render additional forms while preserving
  the standard `Aliases`, `Flags`, and `Global Flags` sections.
- Use the full command path in every rendered variant and include `[flags]`
  consistently when the command accepts flags.
- Keep `Short` descriptions concise and action-oriented. Put behavioral detail,
  constraints, and explanations in `Long`, `Example`, or flag descriptions
  rather than overloading the synopsis.
- Add or update a help-output test when introducing a custom usage template.
