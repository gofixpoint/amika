# @amika/reviews

A TypeScript/React library for reviewing code: upload one or more
`.diff` / `.patch` files (or pass them as text), browse a file tree, view
per-file diffs, and leave threaded comments at line, file, patch, or series
scope. Built on top of [`@pierre/diffs`](https://diffs.com) and
[`@pierre/trees`](https://trees.software).

State lives in plain React (`useReducer` + split state/dispatch contexts +
`useSyncExternalStore`), with no Jotai dependency. The store is also exposed
framework-agnostically through `@amika/reviews/headless` so it works outside
React.

## Install

```bash
pnpm add @amika/reviews
```

Peer deps: `react@^19` and `react-dom@^19`. The pierre packages render inside
shadow DOM and ship their own styling; theme them via their CSS custom
properties (`--trees-*`, diff CSS variables) and `unsafeCSS` if needed.

## Quick start — drop-in UI

```tsx
import "@amika/reviews/styles.css";
import { CodeReview } from "@amika/reviews";

export default function ReviewPage() {
  return <CodeReview author="alice" persistKey="my-review" linkSync />;
}
```

`<CodeReview>` renders a three-pane layout: file tree on the left, diff in
the middle, comment panels on the right. Users drop `.diff`/`.patch` files
into the header dropzone or pass `initialItems` programmatically. The header
also includes an "Export JSON" button.

## Quick start — compose your own UI

```tsx
import {
  ReviewProvider,
  FileTreePanel,
  ItemView,
  FileCommentPanel,
  ItemCommentPanel,
  SeriesCommentPanel,
  UploadDropzone,
  ExportButton,
  useSelectedFile,
  usePatches,
} from "@amika/reviews";

function MyReview() {
  return (
    <ReviewProvider author="alice" persistKey="my-review" linkSync>
      <UploadDropzone />
      <ExportButton />
      <FileTreePanel />
      <Pane />
    </ReviewProvider>
  );
}

function Pane() {
  const selected = useSelectedFile();
  const [first] = usePatches();
  const active = selected?.item ?? first;
  if (!active) return null;
  return (
    <>
      <ItemView item={active} selectedPath={selected?.path ?? null} />
      {selected && (
        <FileCommentPanel itemId={selected.itemId} path={selected.path} />
      )}
      <ItemCommentPanel itemId={active.id} />
      <SeriesCommentPanel />
    </>
  );
}
```

## Loading patches

Two entry points cover the upload-or-text question:

```ts
import { loadFromFiles, loadFromText } from "@amika/reviews";

// In a drop handler:
const items = await loadFromFiles(filesFromDataTransfer);

// From a server response or local string:
const items = loadFromText(diffText);
const items = loadFromText([diffA, diffB]);
```

Or call the same methods on the store / `useReview()` to mutate state directly.

## Five item kinds

A `ReviewItem` is a tagged union; the renderer in `<ItemView>` dispatches to
the right `@pierre/diffs/react` component:

| `kind`            | Pierre component | Use when                                                      |
| ----------------- | ---------------- | ------------------------------------------------------------- |
| `patch`           | `PatchDiff`      | Rendering raw patch text.                                     |
| `multi-file-diff` | `MultiFileDiff`  | You have both pre/post contents for a file (or set of files). |
| `file-diff`       | `FileDiff`       | You already have `FileDiffMetadata`.                          |
| `file`            | `File`           | Single file, no diff.                                         |
| `unresolved-file` | `UnresolvedFile` | Single file with merge conflict markers.                      |

Upload (`.diff`/`.patch` drop) always produces `kind: "patch"`. Use the
imperative API to add the other kinds.

## Public TypeScript API

`useReview()` returns a `ReviewStore` (stable identity), which is also what
`createReviewStore()` returns when used headlessly:

```ts
interface ReviewStore {
  // Read
  getState(): ReviewState;
  subscribe(listener: (state: ReviewState) => void): () => void;

  // Loading
  loadFromText(input: string | string[]): ReviewItem[];
  loadFromFiles(files: File[]): Promise<ReviewItem[]>;
  addItem(item: ReviewItem): void;
  reset(): void;

  // Navigation
  getItems(): ReviewItem[];
  getItem(itemId): ReviewItem | undefined;
  listFiles(itemId?): { itemId; path }[];
  getSelection(): { itemId; path };
  selectFile(itemId, path): void;

  // Comments
  addComment({ scope, body, author? }): Comment;
  reply(parentId, body, author?): Comment;
  editComment(id, body): Comment | undefined;
  deleteComment(id): void;
  setResolved(id, resolved): Comment | undefined;
  getComment(id): Comment | undefined;
  getComments(filter?): Comment[];
  getThread(rootId): Comment[];

  // Deep linking
  getLocation(): ReviewLocation;
  navigate(loc: ReviewLocation): void;
  locationToSearch(loc): string;
  locationFromSearch(search): ReviewLocation;
  onScrollRequest(listener): () => void;

  // Snapshot
  export(): ReviewExportV1;
  import(snapshot: ReviewExportV1): void;
}
```

Hooks: `useReview`, `useReviewState`, `usePatches`, `useComments(filter)`,
`useSelectedFile`, `useReviewLocation`.

## Comment scopes and replies

Every comment has a `scope`:

```ts
type CommentScope =
  | { kind: "line"; itemId; path; line; side?: "old" | "new" }
  | { kind: "file"; itemId; path }
  | { kind: "item"; itemId }
  | { kind: "series" };
```

Replies use a flat `parentId` (`null` for roots). `store.getThread(rootId)`
returns the root + all descendants in `createdAt` order.

## Export schema (`ReviewExportV1`)

```jsonc
{
  "schemaVersion": 1,
  "exportedAt": "2026-05-15T12:34:56.000Z",
  "items": [
    /* ReviewItem objects, preserved verbatim */
  ],
  "comments": [
    {
      "id": "cmt_…",
      "parentId": null,
      "scope": {
        "kind": "line",
        "itemId": "abc123",
        "path": "src/x.ts",
        "line": 42,
        "side": "new",
      },
      "body": "Why are we casting here?",
      "author": "alice",
      "createdAt": "…",
      "updatedAt": "…",
      "resolved": false,
    },
  ],
}
```

Round-tripping is lossless: `import(export())` reconstructs the full state.

## Persistence

Pass `persistKey="..."` to `<ReviewProvider>` or `createReviewStore()` to
back the store with `localStorage`. Cross-tab updates are picked up via the
`storage` event. Omit `persistKey` for purely ephemeral sessions.

## Deep linking

A `ReviewLocation` describes "what's selected and what to scroll to":

```ts
type ReviewLocation =
  | { kind: "none" }
  | { kind: "item"; itemId }
  | { kind: "file"; itemId; path }
  | { kind: "line"; itemId; path; line; side? }
  | { kind: "comment"; commentId };
```

Serialized as flat search params: `?item=…&file=…&line=…&side=…` or
`?comment=…`. Pass `linkSync` to `<ReviewProvider>` to bind it to
`window.location` automatically, or pass a `{ read, write, subscribe? }`
adapter to integrate with Next.js / React Router. Drop in a
`<CopyLinkButton location={...} />` anywhere you want a "copy link" affordance.

Stable IDs: patch items default their `id` to `hashItemId(patchText)`
(FNV-1a content hash, 12 hex chars). Callers can override with an explicit
`id` (commit SHA, etc) by constructing `ReviewItem`s directly via `addItem`.

## Headless usage

For non-React hosts (or to keep React-free code paths), import from
`@amika/reviews/headless`:

```ts
import {
  createReviewStore,
  loadFromText,
  exportReview,
  locationToSearch,
} from "@amika/reviews/headless";

const store = createReviewStore({ persistKey: "demo" });
store.loadFromText(diffText);
store.addComment({ scope: { kind: "series" }, body: "lgtm" });
const json = store.export();
```

The headless entry deliberately omits the React UI and the pierre deps so
size-conscious consumers can skip them.

## Styling and theming

`@amika/reviews/styles.css` provides a minimal default for the chrome we
author ourselves (sidebar, comment threads, dropzone). Pierre internals
remain self-styled. To restyle:

- Skip our CSS entirely and target the `data-amika="..."` attributes we emit.
- Theme pierre via `--trees-*` CSS variables (see
  [trees.software/docs](https://trees.software/docs)) and the diffs variables.
- Use `themeToTreeStyles(theme)` from `@pierre/trees` to derive a full
  palette from a VS Code / Shiki theme.

## Demo

See [`js/reviews-example/`](../reviews-example) for a runnable Vite SPA. It
also hosts the Playwright E2E suite (`pnpm --filter @amika/reviews-example run
test:e2e`) that covers fixture loading, comment CRUD, replies, persistence
across reloads, deep linking, and the JSON export download.

## Testing the library

```bash
pnpm --filter @amika/reviews run typecheck
pnpm --filter @amika/reviews run lint
pnpm --filter @amika/reviews run formatcheck
pnpm --filter @amika/reviews run test    # vitest + @testing-library/react (jsdom)
```

Reducer, store, parser, location serializer, and every UI component are
covered by unit + RTL tests. Diff-rendering interactions that depend on
pierre's shadow DOM live in the Playwright suite under
`js/reviews-example/tests/`.

## Why not Jotai?

We can — and do — implement the full library cleanly with `useReducer` plus
split state/dispatch contexts and `useSyncExternalStore` for selector
subscriptions. Comment volume in a review is small (~hundreds); the diff
renderer dominates render cost. Adding Jotai would introduce a dependency
without measurable benefit. If a future workload changes that calculus
(thousands of comments, multi-megabyte diffs, granular cell updates), the
store layer is framework-agnostic enough to swap in.
