# amikalog Fast Push: JSONL-per-Session Format, Parallel Upload, and Versioning

## Overview

`amikalog beta:push` is slow because capture writes one file per event and push
uploads each file serially with two network round-trips (sign + PUT), rewriting
a manifest of every file ever uploaded after each success (O(N²)). This spec
changes three things, all client-side:

1. **On-disk format** — one append-only JSONL file per session instead of one
   JSON file per event.
2. **Upload concurrency** — batch-sign URLs and upload sessions through a
   bounded parallel worker pool.
3. **Versioning** — concrete forwards/backwards-compatibility rules for a
   bucket that permanently mixes old and new objects.

The server (amika-mono) is a pure signed-URL broker: it mints signed
upload/download URLs for an org-derived bucket, sanitizes client-chosen object
keys (≤1024 bytes, ≤100 keys per batch-sign call), and lists keys with size +
last_modified. It never reads, parses, or migrates object content. All format
and versioning decisions are therefore amikalog's responsibility.

**Nothing is deployed yet** — there is no existing data, bucket content, or
installed client to preserve — so v0 adopts the new format wholesale, with no
legacy per-event read/write path. The versioning scheme (§3) exists only so
that *future* format changes stay compatible once data and clients are in the
wild; it adds version markers now and defers all multi-version handling code
until there is actually more than one version.

**v0 requirement:** fetched storage content must be directly useful with no
server-side transformation — `beta:fetch` round-trips the bucket back to a
local filesystem tree. Cloud-side transformation is explicitly future (v1).

## 1. On-Disk Format: One JSONL File per Session

Replace `<state>/events/<source>/sessions/<ts>_<session>/event_<seq>_<ts>.json`
with a single append-only log per session:

```
<state>/events/<source>/sessions/<ts>_<session>/events.jsonl
```

- Each line is one `Event` record, compact-encoded (no indent), same fields as
  today plus a new `"v": 1` schema-version field (§3).
- **Why whole-session JSONL, not rolling segments:** immutable segments
  (`events.000.jsonl`, …) only *bound* the mutable-object problem — the newest
  segment is still open and growing unless every push seals it, which under
  frequent (cron) pushes fragments right back toward file-per-event. Because
  the file is append-only and uncompressed, its size is monotone, so "remote
  size < local size" is as robust a sync predicate as segment set-difference
  (§2). Segments would only save re-sent bytes on very large sessions; that
  optimization is deferred (Future Considerations).
- **Write path:** keep the existing cross-process flock on the source's
  sessions root (concurrent hook *processes* — Claude fires parallel
  PostToolUse hooks — cannot be serialized in-process, and the root-level lock
  also serializes session-dir creation). Under the lock, append the marshaled
  event + `\n` with a single `O_APPEND` write.
- **Seq:** derived from the last complete, parseable line's `seq` + 1 (read the
  file tail under the lock), starting at 0. No more counting files.
- **Crash tolerance:** per-line append loses temp-then-rename atomicity, so a
  crash (kernel panic, ENOSPC) can leave a partial trailing line. Two rules
  replace atomicity:
  - *Writers self-heal:* under the lock, if the file is non-empty and does not
    end in `\n`, write a `\n` before appending — the junk becomes one
    unparseable line.
  - *Readers tolerate:* every consumer (push, fetch output users, future
    readers) MUST skip an unterminated final line and skip-with-warning any
    line that fails to parse, never erroring out.
- `resolveRepoSegment` reads git context from the first parseable line.

## 2. Push: Sync Algorithm and Parallel Upload

### Object keys

Unchanged convention: the object key mirrors the path relative to
`<state>/events`, prefixed with the session's repo basename and lowercased
(storage listings fold case in directory segments):

```
<repo>/<source>/sessions/<session-dir>/events.jsonl
```

PUT with `Content-Type: application/x-ndjson` and `upsert: true`.

### What gets uploaded

A session's `events.jsonl` is uploaded **whole**, but truncated at the last
`\n` in the bytes read — push never uploads a partial trailing line, so the
remote object always ends on a line boundary and its size always corresponds
to a complete-line offset in the local file. Object storage cannot append, so
a grown session is re-PUT in full; this re-sends prior bytes but is bounded by
session size and keeps every push idempotent (same key, superset content,
upsert overwrites).

### Checkpoint (fast path) + upsert (correctness)

Replace the per-event manifest with a small per-session checkpoint in
`<state>/events/.amikalog-push-state.json`:

```json
{
  "version": 1,
  "sessions": { "<rel session path>": { "pushed_bytes": 12345, "pushed_at": "ts" } }
}
```

- A session is pushed when its local complete-line size exceeds
  `pushed_bytes` (or has no entry). Persist the checkpoint once per session on
  success and once at end of run — never per event — eliminating the O(N²)
  rewrite.
- **The checkpoint is only a cache.** Because every upload is an idempotent
  upsert of deterministic keys, a lost, stale, or corrupt checkpoint degrades
  to re-uploading sessions, never to wrong data. The bucket listing (size per
  key) is the true remote "have" set; a listing-based `--reconcile` that
  rebuilds `pushed_bytes` from remote sizes is the robust mode (Future
  Considerations) — correctness in v0 does not depend on it.

### Parallelism

- Collect all to-push objects first, then mint signed URLs via
  `/storage/uploads/batch` in waves of ≤100 keys, uploading each wave promptly
  (URLs expire; same pattern fetch uses per listing page).
- Upload through a bounded worker pool, default **8** concurrent PUTs
  (flag/env-overridable). Per-object failures are collected in the report and
  do not abort the run.
- Push does not take the writer flock; the truncate-at-last-`\n` rule makes
  reading a live file safe.

### Compression: none in v0

Gzip would break the three things v0 leans on: (a) the monotone
remote-size-vs-local-size sync predicate (compressed size reveals nothing
exact about content without downloading), (b) fetch's "directly useful
filesystem tree" requirement, and (c) provider-neutrality (Content-Encoding
transcoding behavior differs across storage backends behind the opaque signed
URL). Compression belongs with sealed immutable segments later, where key
set-difference replaces size comparison.

## 3. Versioning for Forwards/Backwards Compatibility

There is only one version today, so v0 builds **no multi-version handling
code**. The job here is to stamp markers now and fix the rules, so the *first*
format change later is a clean, compatible add rather than a migration. Two
layers:

1. **Container format = filename token in the object key.** `events.jsonl` is
   the v1 session-log container. Any future container (segments, compression)
   gets a new, distinguishable filename (e.g. `events.v2.<nnn>.jsonl.gz`) —
   never a reinterpretation of an existing name. Consumers dispatch on the
   filename without reading bytes.
2. **Record schema = per-line `"v"` field.** Each JSONL line carries `"v": 1`,
   per-line (not per-file) so any line is interpretable out of context if
   events are later extracted or streamed individually.

The rules a future format change MUST follow (and that v0 readers are written
to honor up front, so they don't need changing when v2 ships):

- **Additive changes** (new optional JSON fields, new key prefixes/trees)
  require **no** version bump. Readers MUST ignore unknown fields (Go's
  default) and tolerate unknown sibling keys.
- **Breaking record changes** (rename/retype/remove a field, change `seq` or
  `timestamp` semantics) bump `v`; readers switch on `v` per line.
- **Breaking structural changes** (how events are grouped into objects) get a
  new filename token; the key layout (`<repo>/<source>/sessions/...`) itself
  changes only additively.
- **Unknown formats:** a reader that meets a filename token or `v` it does not
  know MUST skip it with a warning, never crash. This single rule is what makes
  a v1 client forward-compatible with v2 objects, and it is the only
  version-handling behavior v0 actually implements.

Considered and rejected for v0: a per-session manifest/index object in the
bucket. It would double PUTs, reintroduce a second mutable object per session,
and duplicate what the listing (key + size) already conveys.

## Dependencies

- amika-mono `/api/v0beta1/storage/uploads/batch` (≤100 keys/call, upsert) and
  `/api/v0beta1/storage/downloads` (paginated listing with size +
  last_modified) — unchanged; the server stays an opaque blob broker.

## Future Considerations

- **Listing-based reconcile (`beta:push --reconcile`):** page the bucket
  listing, compare each session object's remote size against the local
  complete-line size, rebuild the checkpoint. Self-heals lost checkpoints and
  supports multi-machine pushes of disjoint sessions; cheap to add since fetch
  already pages the listing. v0 is correct without it (upsert), just less
  bandwidth-optimal after checkpoint loss.
- **Immutable rolling segments + gzip:** when long-lived sessions make
  whole-file re-PUTs expensive, seal completed chunks as
  `events.v2.<nnn>.jsonl.gz` (immutable, compressed, synced by key
  set-difference) with only the open tail uncompressed. The filename-token
  rule above means this lands as a new container version coexisting with v1
  objects.
- **ETag as content hash:** the listing doesn't expose ETags today, and
  monotone size makes them unnecessary for append-only JSONL; revisit only if
  a future format loses size-monotonicity.
- **v1 cloud transformation:** when pushing to our own cloud with server-side
  processing, the in-key container token and per-line `v` give the server a
  stable contract to branch on; nothing in this design assumes the server
  stays blind.
