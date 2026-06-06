# akfs

`akfs` is an experimental Amika filesystem CLI. It lives in the
[labs subtree](README.md) and is **unstable**: commands, flags, and behavior may
change or be removed at any time, with no compatibility guarantees.

- CLI: [`go/labs/cmd/akfs/`](../../go/labs/cmd/akfs/)
- Library: [`go/labs/akfs/`](../../go/labs/akfs/) — import path
  `github.com/gofixpoint/amika/go/labs/akfs`

## Building and running

```bash
make build-akfs          # builds dist/akfs
./dist/akfs --help

# Or use the wrapper, which auto-builds and runs dist/akfs:
./bin/akfs --help
```

## Commands

### `akfs version`

Print version information.

```bash
akfs version
akfs --version
```

### `akfs frontmatter`

Parse the [YAML frontmatter](https://jekyllrb.com/docs/front-matter/) block from
one or more documents and emit it as JSON. Aliased as `akfs fm`.

A document's frontmatter must begin on the first line with a `---` delimiter and
end with a matching `---` (or `...`) delimiter line; the block between is parsed
as YAML. For example:

```markdown
---
title: The components of a software factory
status: draft
tags: [software-factory, agents, infrastructure]
slides: content/slides/components-of-a-software-factory/slides.md
---

# Body content starts here
```

#### Input modes

| Invocation | Behavior |
| ---------- | -------- |
| `akfs fm a.md b.md` | Parse each file argument, in order. |
| `akfs fm -` | Parse a **single document** read from stdin. |
| `akfs fm a.md - b.md` | Mix file arguments and a stdin document (`-`) in any order. |
| `akfs fm` (no arguments) | Read stdin as a **newline-delimited list of file paths** and parse each. |

The two stdin modes are distinct: a bare `-` argument means "the document is on
stdin", whereas no arguments at all means "stdin is a list of files to open"
(handy for `fd`/`find` pipelines). In the file-list mode, blank lines are
skipped and trailing carriage returns are trimmed.

#### Output

One line of compact JSON per document (JSON Lines), each an object with:

- `filename` — the source file path. Omitted when the document was read from
  stdin via `-`.
- `data` — the parsed frontmatter.

```bash
$ akfs fm slides.md
{"filename":"slides.md","data":{"slides":"content/slides/components-of-a-software-factory/slides.md","status":"draft","tags":["software-factory","agents","infrastructure"],"title":"The components of a software factory"}}
```

#### Examples

```bash
# A single file
akfs fm slides.md

# Multiple files — one JSON line each, in order
akfs fm content/pieces/one.md content/pieces/two.md

# A document piped on stdin (filename omitted from the output)
cat slides.md | akfs fm -

# A list of files piped on stdin — parse every matched markdown file
fd -p 'content/pieces/.*\.md' ./biz | akfs fm

# Equivalent with find
find ./biz -path '*content/pieces/*.md' | akfs fm
```

#### Errors

Parsing fails (non-zero exit) when a document does not start with `---`
(`no frontmatter found`) or is missing its closing delimiter
(`unterminated frontmatter`). Errors are prefixed with the source name — the
file path, or `<stdin>` for a stdin document:

```bash
$ printf 'no frontmatter here\n' | akfs fm -
<stdin>: no frontmatter found: input does not start with '---'
```

When processing multiple inputs, the first failing document aborts the run.
