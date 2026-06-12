# akfs

`akfs` (Amika filesystem) is experimental tooling for treating files as
structured data that humans and AI agents can both work with.

Today it focuses on one thing: extract YAML frontmatter, the `---`-delimited
metadata block at the top of a Markdown file, and emit it as JSON Lines —
optionally alongside (or instead of) the document body. That makes a directory
of posts, docs, notes, or plans queryable with standard tools like `jq`,
scripts, databases, or a content management system (CMS) import.

For example, a docs directory might store `title`, `status`, `author`, and
`tags` in each Markdown file. `akfs fm` can stream that metadata so you can list
drafts, audit fields, or export records without writing a one-off parser.

Amika is a software factory for AI coding agents: sandboxed agents that
understand your codebase, connect to your data, run checks, and open pull
requests. Labs tools like `akfs` explore the filesystem-data layer those agents
can use.

`akfs` is **experimental** and the interface is **unstable**.

- CLI: [`go/labs/cmd/akfs/`](../../go/labs/cmd/akfs/)
- Library: [`go/labs/akfs/`](../../go/labs/akfs/) — import path
  `github.com/gofixpoint/amika/go/labs/akfs`
- Frontmatter parser: [`go/labs/akfs/frontmatter/`](../../go/labs/akfs/frontmatter/)

## Building and running

Prerequisites:

- Run commands from the repository root.
- Use the Go version declared by [`go/go.mod`](../../go/go.mod).
- `akfs` is built from this repo; it is not a standalone package.

```bash
make build-akfs          # builds dist/akfs
./dist/akfs --help

# Or use the wrapper, which auto-builds and runs dist/akfs:
./bin/akfs --help
```

`./bin/akfs` is a contributor wrapper for this repo, not a system-wide install.

## Commands

### `akfs frontmatter`

Parse the YAML frontmatter block from one or more documents and emit it as JSON.
Aliased as `akfs fm`.

A document's frontmatter begins on the first line with a `---` delimiter and
ends with a matching `---` (or `...`) delimiter line; the block between is parsed
as YAML. A document with no leading `---` is treated as having no frontmatter
(see [Files without frontmatter](#files-without-frontmatter)). For example:

```markdown
---
author: Ada
status: draft
tags: [planning, agents]
title: Quarterly planning notes
---

# Body content starts here
```

#### Input modes

| Invocation                  | Behavior                                                                                 |
|-----------------------------|------------------------------------------------------------------------------------------|
| `akfs fm a.md b.md`         | Parse each file argument, in order.                                                      |
| `akfs fm -`                 | Parse a **single document** read from stdin.                                             |
| `akfs fm a.md - b.md`       | Mix file arguments and a stdin document (`-`) in any order.                              |
| `akfs fm` (no arguments)    | Read stdin as a **newline-delimited list of file paths** and parse each in list order.   |

The two stdin modes are distinct:

- `akfs fm -` means the single Markdown document is on stdin.
- `akfs fm` with no arguments means stdin is a list of file paths, one per line.

In file-list mode, blank lines are skipped and trailing carriage returns are
trimmed.

#### Output

One line of compact JSON per document (JSON Lines), each an object with:

- `filename` — the source file path. Present for file arguments and paths read
  from stdin file-list mode; omitted only when the document was read via `-`.
- `frontmatter` — the parsed frontmatter.

Within `frontmatter`, keys are emitted in sorted lexicographic order.

```bash
$ akfs fm notes/plan.md
{"filename":"notes/plan.md","frontmatter":{"author":"Ada","status":"draft","tags":["planning","agents"],"title":"Quarterly planning notes"}}
```

#### Including the document body (`--content`)

By default `akfs fm` emits only the frontmatter. The `--content` flag controls
whether the document body — everything after the closing delimiter — is
included under a top-level `content` key:

| `--content` | Output                                                          |
|-------------|-----------------------------------------------------------------|
| `none`      | Only `frontmatter` (the default).                               |
| `also`      | Both `frontmatter` and `content`.                               |
| `only`      | Only `content`; the `frontmatter` field is dropped.             |

The `content` value is the document body as if the frontmatter block were not
there: the single newline separating the closing delimiter from the body is
stripped, while any trailing newline at the end of the file is preserved. When
present, fields are ordered `filename`, `frontmatter`, `content`.

```bash
$ akfs fm --content also notes/plan.md
{"filename":"notes/plan.md","frontmatter":{"author":"Ada","status":"draft","tags":["planning","agents"],"title":"Quarterly planning notes"},"content":"# Body content starts here\n"}

$ akfs fm --content only notes/plan.md
{"filename":"notes/plan.md","content":"# Body content starts here\n"}
```

#### Examples

```bash
# A single file
akfs fm notes/plan.md

# Multiple files — one JSON line each, in order
akfs fm posts/one.md posts/two.md

# A document piped on stdin (filename omitted from the output)
cat notes/plan.md | akfs fm -

# A list of files piped on stdin — parse every matched markdown file
find ./content -name '*.md' | akfs fm

# Optional: fd is a third-party finder; find works everywhere
fd -e md . ./content | akfs fm
```

JSON Lines works well in pipelines because each input file produces one JSON
object on one line:

```bash
# List draft files
find ./content -name '*.md' | akfs fm | jq -r 'select(.frontmatter.status == "draft") | .filename'

# Export filename, title, and author as TSV
find ./content -name '*.md' | akfs fm | jq -r '[.filename, .frontmatter.title, .frontmatter.author] | @tsv'
```

#### Files without frontmatter

A document that does not start with a `---` delimiter is **not** an error: it is
treated as having no frontmatter. The `frontmatter` field is an empty object,
and (with `--content`) the entire file is returned as the body. This makes it
safe to run `akfs fm` across a directory that mixes documents with and without
frontmatter.

```bash
$ printf 'Just some prose.\n' | akfs fm -
{"frontmatter":{}}

$ printf 'Just some prose.\n' | akfs fm --content also -
{"frontmatter":{},"content":"Just some prose.\n"}
```

#### Errors

Parsing fails (non-zero exit) only when a document opens with a `---` delimiter
but is missing its closing delimiter (`unterminated frontmatter`). Errors are
prefixed with the source name — the file path, or `<stdin>` for a stdin
document:

```bash
$ printf -- '---\ntitle: hi\n' | akfs fm -
<stdin>: unterminated frontmatter: missing closing '---'
```

When processing multiple inputs, the first failing document aborts the run.
Output already emitted for earlier documents remains on stdout; the error is
reported on stderr.

## Planned / not yet implemented

`akfs` currently ships only frontmatter and document-body extraction:
`akfs frontmatter`, its alias `akfs fm`, and `akfs version`. The top-level Go
library is still a scaffold; the implemented library logic is the frontmatter
parser.

Possible future directions:

- Search or filter files by frontmatter fields. For now, pipe `akfs fm` into
  `jq` or your own scripts.
- Validate frontmatter against schemas. For now, use external validation tools.
- Sync file metadata with SQL, a CMS, or another store. Directionality,
  conflict handling, credentials, and schema design are not implemented.
