---
name: distill-session
description: "Review the current chat session and distill any new conventions, file layouts, frontmatter fields, or workflow rules that emerged into the repo's agent docs. Proposes updates to AGENTS.md/CLAUDE.md and to skills (in `.agents/skills` or `.claude/skills`), then runs a sub-agent simplification pass over the changes before committing."
---

# Distill session learnings

Use when the user asks you to look over the chat session and update the repo's agent docs: `AGENTS.md`/`CLAUDE.md` files or skills.

**Usage:** `/distill-session`

---

## Phase 1: Identify what to write down

Re-read the session and list every concrete thing future agents would benefit from knowing. Focus on new file layouts or directories, new or required frontmatter fields, section heading conventions, rules about when not to do something, optional fields in existing schemas, and workflow steps the user corrected or explicitly validated.

Skip one-off content (the actual work product written this session), things already documented in the repo's agent docs, and anything derivable from sibling files in the same directory.

If nothing meets the bar, say so and stop.

## Phase 2: Present the list and confirm

The targets for distilled learnings are:

- `AGENTS.md` / `CLAUDE.md` files (the instruction file closest to the relevant code).
- Skills, defined under `.agents/skills/` or `.claude/skills/`.

Show the user the distilled list grouped by destination file, mapping each learning to the most appropriate existing file. Propose a new file only when no existing one fits. For each item, name the destination file and give a one-line summary of the change. Ask the user to confirm or trim before editing.

## Phase 3: Make the edits

For each confirmed item, edit or create the target file. Match the conventions of the file you're editing. If the repo links these files via symlinks (e.g. a `CLAUDE.md` symlinked to `AGENTS.md`, or `.claude/skills/` symlinked to `.agents/skills/`), edit only one side and preserve the link.

## Phase 4: Sub-agent simplification pass

Spawn an `Explore` (read-only) sub-agent and ask it to review only the files changed in this session for opportunities to simplify. Pass the list of changed file paths. Brief it with the project's documentation style, plus these defaults:

- Cut trivial bullets.
- Default to sentences over bullets unless items are genuinely parallel.
- Lead with the sharpest point.
- Remove redundant directory structure trees when a folder has one file type.
- Cut sentences whose removal wouldn't lose information.

Have the sub-agent report a punch list of specific simplifications. Don't have the sub-agent edit files; apply its suggestions in the main agent so the user can see the diff. Skip any that would lose information the user explicitly asked for.

## Phase 5: Commit

Stage only the distillation files — the agent-doc files edited or created in Phase 3 (the same list passed to the Phase 4 sub-agent). Do not use `git add -A` / `git add .`, since the worktree may contain unrelated in-progress work or the actual session work product. Then commit with a single message describing the distillation, following the repo's commit conventions.

After committing, show the user the diffstat.
