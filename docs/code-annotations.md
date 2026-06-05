# Code Annotations

Annotate your code to preserve invariants, enforce rules, and inject relevant context when an agent reads or modifies specific files or code symbols.

> **Research preview** — Code annotations are under active development. APIs and behavior may change.

Code annotations are rules embedded directly in your source that control how
agents can interact with specific symbols. Freeze a function to block all agent
edits; attach a prompt to fire context at the agent the moment it touches a
method. Because `amikalyze` enforces these at write time — not by asking a
model to remember them — you get a hard guarantee, not a soft suggestion. Two
annotation types are available:

- **`#amika/frozen`** — the next symbol is off-limits. Edits to it are
  blocked.
- **`#amika/prompt`** — when an agent modifies the next symbol, this prompt
  is injected into the agent's context for that edit.

Annotations live in regular code comments, so they work in any language and
travel with the code in git. `amikalyze`, the parser and enforcer built into
the `amika` CLI, runs at the points you configure: agent hooks, git hooks, or
PR checks.

## Comment syntax

Annotations use [EDN](https://github.com/edn-format/edn) inside ordinary
comments. EDN is used here instead of TOML or JSON because it parses
cleanly out of any language's comment syntax — the `#amika/foo` tag is a
single greppable token that survives wrapped lines and mixed indent.

The basic shape is `#amika/<name>` followed by an optional EDN value:

```typescript
// #amika/frozen
function computeChecksum(buf: Buffer) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
```

An annotation applies to the next symbol below it: a function, class, or
top-level variable. At the top of a file, it applies to the whole module.

`amikalyze` uses [tree-sitter](https://tree-sitter.github.io/) to find the
"next symbol", so language support follows whatever tree-sitter grammars
ship with the release. TypeScript, JavaScript, Python, Go, and Rust
are the initial targets.

### Multi-line annotations

For annotations that span multiple lines of comment, repeat the language's
comment prefix on every line — the parser strips the prefix before reading
the EDN value:

```typescript
// #amika/prompt "
// First line of the prompt.
// Second line of the prompt.
// "
```

```python
# #amika/prompt "
# First line of the prompt.
# Second line of the prompt.
# "
```

Block comments work the same way:

```typescript
/*
 * #amika/frozen { :label "computeChecksum" }
 */
```

## Freeze a symbol

`#amika/frozen` prevents agents from modifying the symbol that follows.

```typescript
// #amika/frozen
export const SCHEMA_VERSION = 7;
```

```python
# #amika/frozen
def parse_legacy_format(blob: bytes) -> dict:
    # Format spec is locked; don't let agents "improve" this.
    ...
```

A frozen symbol is blocked at every enforcement point:

- **Agent hook** stops an agent from writing the edit in the first place.
- **Pre-commit hook** blocks the commit if a frozen symbol changed,
  regardless of whether a human or an agent made the edit.
- **PR check** fails the PR if a commit modifies a frozen symbol.

Freezes apply to all writers, not just agent hooks. This is intentional — once
a symbol is frozen, the only way to change it is through an explicit
override, so the rule survives whether the edit came from a model or a
person.

### Override a freeze

```typescript
/*
 * #amika/frozen { :label "frozen-checksum" }
 */
export function wrappedChecksum(buf: Buffer) {
  // The agent is blocked from editing wrappedChecksum unless you override the
  // "frozen-checksum" label.
  return computeChecksum(buf);
}
```

By default, agents will be stopped from modifying `wrappedChecksum`,
unless you override the "frozen-checksum" label:

```bash
amikalyze --ignore frozen-checksum --ignore some-other-label

# or set environment variables when running your coding agent:
AMIKALYZE_IGNORE="frozen-checksum,some-other-label" claude
```

## Attach a prompt to a symbol

`#amika/prompt` adds an instruction that's injected into the agent's
context whenever it modifies the symbol below the comment.

```typescript
// #amika/prompt "
// This function is on the hot path for request parsing. Avoid
// allocations in the inner loop. If you need to change the signature,
// update the matching benchmark in bench/parse.ts.
// "
export function parseRequest(raw: string): Request {
  // ...
}
```

The prompt fires once per agent turn that touches the symbol. It's not a
guarantee — the agent can still make a bad change — but it ensures the
agent sees the constraint before deciding what to do.

### Prompt options

To pass options to the model, wrap the prompt and an options map in
parens:

```typescript
// #amika/prompt (
//   "Be especially careful here. Prefer minimal diffs."
//   { :model "claude-opus-4-7", :effort "high" }
// )
function migrateUsers() {
  // ...
}
```

| Option | Type | Meaning |
| --- | --- | --- |
| `:model` | string | Override the model used for this edit |
| `:effort` | `"low"`, `"medium"`, `"high"` | Reasoning budget for the edit |

## Apply rules across a directory

Inline annotations are good for single symbols. To freeze whole
directories or match files by glob, drop a `.amikalyze.edn` file in any
directory of your repo:

```clojure
; freeze every file in this directory and its subtree
#amika/frozen-paths (
  "schema/**/*.sql"
  "proto/**/*.proto"
  "vendor/**"
)
```

`.amikalyze.edn` applies to the directory it lives in and everything
below it. Glob patterns are relative to that directory.

If you'd rather keep the file out of the way, `.amika/amikalyze.edn`
works too.

## Enable code annotations for a repo

Annotations are processed by the built-in `amikalyze` check. Turn it on
in `.amika/config.toml`:

```toml
[checks.amikalyze]
enabled = true
```

With this set, `amikalyze` runs in its own sandbox on every PR,
alongside any other checks you've defined in `.amika/checks/`.

To enforce annotations on every local edit as well, install the agent
hook and the pre-commit hook:

```bash
# Agent hook
amika checks init agenthooks

# Pre-commit hook
amika checks init githooks
```

For annotations, the agent hook runs `amikalyze` on each file write the
agent attempts (Claude Code, Codex, OpenCode), blocking the write if it
hits a frozen symbol and surfacing prompts inline. `amikalyze` is fast
enough to gate every write — unlike sandboxed checks, which run after
the agent's turn ends.

The pre-commit hook is the safety net for any edit — human or agent —
that slipped past the agent hook.

## Where annotations are enforced

It's up to you where you enforce annotations. You can run `amikalyze` directly,
or run it at one of these enforcement points:

| Enforcement point | What it catches |
| --- | --- |
| **Agent hook** (local) | Blocks the agent before it writes to a frozen symbol, or fires the prompt before it touches an annotated one |
| **Git pre-commit hook** | Blocks the commit if a frozen symbol was modified by any writer |
| **PR check** | Fails the PR if a commit modifies a frozen symbol |

All three run the same `amikalyze` parser — a symbol frozen locally is
frozen in CI.
