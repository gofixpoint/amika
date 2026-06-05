---
name: amika-annotations
description: "Find and process Amika annotations (EDN #amika/<type> and XML <amika:type>) in a file, directory, or the current diff. Act on each annotation's intent, keep or delete it per type/args, respect frozen boundaries, and report everything done."
argument-hint: "[path]"
---

# Process Amika Annotations

Find Amika annotations in the target, act on each one's intent, dispose of it (keep or
delete), and report what you did. This skill is a **processor**, not the amikalyze
enforcement engine: it does not install hooks, fire prompts, or enforce freezes. It only
acts on imperative annotations and stays out of the way of the deterministic tooling.

**Usage:** `/amika-annotations [path]`

- `path` (optional): a file or directory to process. If omitted, process the files in the
  current git diff / working tree (`git status --porcelain`, plus staged changes).

---

## Phase 1: Find the annotations

1. **Resolve scope.**
   - If `path` is given, scope to that file or directory subtree.
   - Otherwise, scope to changed files: `git diff --name-only HEAD` plus untracked files
     from `git status --porcelain`. If there are no changes, say so and stop.

2. **Grep for both markers** across the scoped files:
   - EDN: `#amika/[A-Za-z][\w-]*`
   - XML: `<amika:[A-Za-z][\w-]*`

3. For each hit, read enough surrounding context to parse the **full** annotation (EDN
   expressions and XML elements can span multiple lines) and to identify what it targets.

If nothing is found, report that and stop.

---

## Phase 2: Parse each annotation

There are two syntaxes. Parse the whole expression before acting.

### EDN style: `#amika/<type> ...`

- The value after the type is an [EDN](https://github.com/edn-format/edn) expression. It
  may be:
  - a bare string: `#amika/generate "create a zod schema for the type below"`
  - a bare map of args: `#amika/frozen { :override "computeChecksum" }`
  - a paren form pairing a string with an options map:
    `#amika/rewrite ( "tighten this" { :model "claude-opus-4-7" :effort "high" } )`
- **Multi-line:** the comment prefix is repeated on every line. Strip the leading prefix
  (`//`, `#`, or ` * ` inside a block comment) from each line before reading the EDN value.
- **Target:** by default an EDN annotation applies to the **next semantic block** below it
  (a function, class, or top-level variable; at the top of a file it applies to the whole
  module). If there is no following block (e.g. it sits at the end of a section, or in
  prose/markdown), treat it as an **inline** instruction to act at that point.

### XML style: `<amika:<type>>…</amika:<type>>`

- A paired element **describes the content it wraps**: the text/code between the tags is
  the subject the annotation acts on.
- A self-closing element `<amika:<type> … />` is a **point annotation** with no contained
  content; it acts at its location.
- Attributes on the tag are the annotation's args/options (analogous to the EDN options
  map).

---

## Phase 3: Decide behavior

Look up the type in the **built-in table** below. If it isn't there, **infer** the behavior
from the type name, the content, and the args.

### Built-in table

**Constraint / advisory types (respected, never processed or deleted here):**

| Type | What you do |
|------|-------------|
| `frozen` | Treat the target symbol as a **read-only boundary**. Never let an action in this run modify a frozen symbol. If an imperative annotation's action would change it, **stop that action and report the conflict** instead. Leave the annotation untouched. |
| `frozen-paths` | Same boundary rule, applied to the matching file globs. Leave untouched. |
| `prompt` | Advisory. If your action touches a symbol carrying a `#amika/prompt`, read and follow its guidance while you work. Do **not** fire it as a turn-prompt, and leave it untouched. |

These belong to the amikalyze tooling/hooks. This skill only reads them so it doesn't
trample what they protect.

**Imperative types (acted on, then disposed of; default is delete after acting):**

| Type | Syntax | Action | Default disposition |
|------|--------|--------|---------------------|
| `generate` | EDN or XML | Produce the described code/content as the target block (or inline if none). | delete |
| `expand` | EDN or XML | Flesh out the stub/placeholder it targets into a full implementation. | delete |
| `rewrite` | EDN or XML | Rewrite the target block (EDN) or the wrapped content (XML) per the instruction. | delete (XML: unwrap) |
| `edit` | XML | Rewrite the wrapped content per the instruction in the annotation's `prompt` attribute or its own content. Equivalent to `rewrite` in XML form — prefer this name in prose/MDX files. | unwrap (drop tags, keep rewritten content) |
| `review-change` | XML | The wrapped content was changed by the author and is flagged for review. Evaluate the change against the surrounding context. If it's an improvement, accept it (unwrap). If it should be reverted, note it as a conflict and leave the tags for the user to handle — you cannot recover the original automatically. | unwrap if accepted; leave tagged if rejected |
| `todo` | EDN or XML | Perform the described task on/around the target. | delete |
| `note` | EDN | A standing label or informational marker. Incorporate its content into the surrounding prose or action context, then delete. If it marks something that should remain (e.g. a label the user explicitly wants to keep), leave it — use judgment. | delete |

> The imperative set above is a **starter**. It's safe to extend this table as new types
> appear; until then, unknown types are handled by inference (below).

### Inference for unknown types

If the type isn't in the table:

1. Read the type name, content, and args and determine the intent.
2. Carry out that intent on the resolved target (next block, inline, or wrapped content).
3. Decide keep vs. delete yourself using the disposition rules below.
4. **Flag it as inferred** in the report so the user can review your judgment.

---

## Phase 4: Act and dispose

For each annotation, in file order:

1. **Check boundaries first.** If acting would modify a `frozen` symbol or a
   `frozen-paths` glob (and no override is present), do **not** act. Record a
   boundary conflict and move on.

2. **Act** on the intent against the resolved target.

3. **Dispose** of the annotation. Disposition is decided in this priority order:
   1. **Per-annotation override wins.** `:keep true` (EDN) or `keep="true"` (XML attr)
      forces keep; `:once true` / `once="true"` forces delete-after-acting.
   2. Otherwise use the **table default** for a known imperative type.
   3. Otherwise (inferred type) use your judgment: an instruction that is *consumed* by
      doing it (generate, do this task) should be deleted; an annotation that remains
      *true about* the content (a description, a standing note) should be kept.
   - When deleting an EDN annotation, remove its whole comment (all continuation lines).
     When "unwrapping" an XML element, remove the open/close tags but keep the
     (possibly transformed) content. Removing a self-closing tag removes just that tag.

4. Never leave an annotation **unprocessed**. Every one found is either acted on, or
   recorded as a boundary conflict, or (for the respected constraint types) intentionally
   left in place, and every case appears in the report.

---

## Phase 5: Report

End with a summary so the user can review the judgment calls. Use a table:

| File:line | Type | Syntax | Action taken | Disposition | Notes |
|-----------|------|--------|--------------|-------------|-------|

Then call out, as separate short lists:

- **Inferred types:** annotations whose behavior you guessed (type was not in the table).
- **Boundary conflicts:** actions you refused because they'd touch a frozen symbol/path.
- **Left in place:** `frozen` / `frozen-paths` / `prompt` annotations you respected.

Do not commit anything. Stop after reporting so the user can review the edits.
