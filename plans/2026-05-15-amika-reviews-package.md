# `@amika/reviews` — code review library

## Context

We're adding a new TypeScript/React library, `@amika/reviews`, that provides a Github-style code-review UI plus a public imperative TS API. It is the first JS package in the `amika` repo, so this work also bootstraps a pnpm workspace at the repo root mirroring the conventions used in the sibling `amika-mono` monorepo (`/home/amika/workspace/amika-mono`).

The library will:

1. Accept patches/files in any of the 5 modes supported by `@pierre/diffs/react` (`MultiFileDiff`, `PatchDiff`, `FileDiff`, `File`, `UnresolvedFile`) via either drag-and-drop upload **or** plain-text strings.
2. Render a file tree (via `@pierre/trees/react`) and a per-file diff viewer.
3. Let users leave threaded comments (with replies) at four scopes: line / file / item (single patch or commit) / series (entire review).
4. Expose a public imperative TypeScript API (`ReviewAPI`) for navigation, comment CRUD, and reading comments — plus React hooks (`useReview`, `useComments`, `usePatches`, `useSelectedFile`).
5. Export comments + transcript in a versioned JSON schema.
6. Persist state to `localStorage` when a `persistKey` prop is supplied (opt-in).

State is implemented in **plain React** — `useReducer` + split state/dispatch contexts — no Jotai. Justification: comment volume in a review is small (~hundreds), the diff renderer dominates render cost, and a vanilla store keeps the public API simpler.

Both pierre libraries render through a shadow root and ship their own styling, exposed via `--trees-*` / diff CSS variables and an `unsafeCSS` escape hatch. `@amika/reviews` will not attempt to make them headless; instead, our own chrome (comment threads, side panels, dropzone) is authored with minimal CSS and theming-friendly class hooks.

## Repository setup (new)

The `amika` repo currently has no JS infrastructure. This work introduces:

- Root `pnpm-workspace.yaml`: `packages: ["js/*"]`.
- Root `package.json`: `private: true`, `packageManager: "pnpm@10.18.2"`, with `pnpm.onlyBuiltDependencies` for `esbuild` (and any others surfaced during install).
- `.gitignore`: add `node_modules/`, `js/**/dist/`.
- `js/reviews/` package directory.

Conventions copied directly from `amika-mono/js/components` (matched file-for-file unless noted): `tsconfig.json` (target ES2017, jsx react-jsx, moduleResolution bundler, strict), `eslint.config.mjs` (flat config, `js.configs.recommended` + `typescript-eslint`), `vitest.config.ts` (jsdom, `src/test/setup.ts` importing `@testing-library/jest-dom/vitest`), Prettier defaults.

## Package shape — `js/reviews/package.json`

```jsonc
{
  "name": "@amika/reviews",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format": "prettier --write .",
    "formatcheck": "prettier --check .",
    "test": "vitest run"
  },
  "exports": {
    ".":          "./src/index.ts",
    "./headless": "./src/headless.ts",
    "./styles.css": "./src/styles.css"
  },
  "dependencies": {
    "@pierre/diffs": "latest",
    "@pierre/trees": "latest",
    "parse-diff":   "^0.11.1"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": { /* mirrors js/components: eslint, prettier, vitest, jsdom, testing-library, typescript-eslint, globals */ }
}
```

`./headless` re-exports only the store + types + parser + export — no React UI, no pierre deps pulled in.

## Public TypeScript API

### Data model

```ts
type Side = "old" | "new";

type ReviewItem =
  | { id: string; kind: "patch";          patchText: string;          label?: string }
  | { id: string; kind: "multi-file-diff"; before: FileMap; after: FileMap; label?: string }
  | { id: string; kind: "file-diff";      metadata: FileDiffMetadata; label?: string }
  | { id: string; kind: "file";           path: string; content: string; label?: string }
  | { id: string; kind: "unresolved-file"; path: string; content: string; label?: string };

type CommentScope =
  | { kind: "line";   itemId: string; path: string; line: number; side?: Side }
  | { kind: "file";   itemId: string; path: string }
  | { kind: "item";   itemId: string }
  | { kind: "series" };

interface Comment {
  id: CommentId;
  parentId: CommentId | null;   // replies live here; flat with parentId
  scope: CommentScope;
  body: string;
  author?: string;
  createdAt: string;            // ISO-8601
  updatedAt: string;            // ISO-8601
  resolved: boolean;
}

interface ReviewState {
  items: ReviewItem[];
  comments: Record<CommentId, Comment>;
  selection: { itemId: string | null; path: string | null };
}
```

### `ReviewAPI`

```ts
interface ReviewAPI {
  // Loading
  loadFromText(input: string | string[]): ReviewItem[]; // assumes patch text
  loadFromFiles(files: File[]): Promise<ReviewItem[]>;  // .diff / .patch
  addItem(item: ReviewItem): void;
  reset(): void;

  // Navigation
  getItems(): ReviewItem[];
  getItem(itemId: string): ReviewItem | undefined;
  listFiles(itemId?: string): { itemId: string; path: string }[];
  getSelection(): { itemId: string | null; path: string | null };
  selectFile(itemId: string, path: string | null): void;

  // Comment CRUD
  addComment(input: { scope: CommentScope; body: string; author?: string }): Comment;
  reply(parentId: CommentId, body: string, author?: string): Comment;
  editComment(id: CommentId, body: string): Comment;
  deleteComment(id: CommentId): void;
  setResolved(id: CommentId, resolved: boolean): Comment;

  // Read
  getComment(id: CommentId): Comment | undefined;
  getComments(filter?: { scope?: CommentScope["kind"]; itemId?: string; path?: string; line?: number }): Comment[];
  getThread(rootId: CommentId): Comment[];   // root + descendants in order

  // Deep linking
  getLocation(): ReviewLocation;
  navigate(loc: ReviewLocation): void;            // selects item/file, scrolls to line/comment
  locationToSearch(loc: ReviewLocation): string;  // produces `?item=...&file=...&line=...`
  locationFromSearch(search: string): ReviewLocation;

  // Snapshot
  export(): ReviewExportV1;
  import(snapshot: ReviewExportV1): void;

  // Observation
  subscribe(listener: (state: ReviewState) => void): () => void;
}
```

### React surface

```ts
<ReviewProvider
  initialItems?
  persistKey?
  author?
  linkSync?         // boolean | { read(): string; write(search: string): void }
> {children} </ReviewProvider>

useReview(): ReviewAPI
useReviewState(): ReviewState
useComments(filter): Comment[]
usePatches(): ReviewItem[]
useSelectedFile(): { itemId, path, item } | null
useReviewLocation(): readonly [ReviewLocation, (next: ReviewLocation) => void]
```

When `linkSync` is `true`, the provider binds to `window.location` (search params), pushes on navigation, and reacts to `popstate`. Callers who use a router (Next.js, React Router) can pass an adapter `{ read, write }` to bridge instead.

### Headless surface (`@amika/reviews/headless`)

```ts
createReviewStore(options): ReviewAPI & {
  getState(): ReviewState;
};
```

Same API, but framework-agnostic. The React provider is a thin wrapper around `createReviewStore` that bridges to React via `useSyncExternalStore`.

## Deep linking

### URL scheme

A single `ReviewLocation` describes "what's selected and what to scroll to":

```ts
type ReviewLocation =
  | { kind: "none" }
  | { kind: "item";    itemId: string }
  | { kind: "file";    itemId: string; path: string }
  | { kind: "line";    itemId: string; path: string; line: number; side?: Side }
  | { kind: "comment"; commentId: CommentId };  // self-resolves to its scope
```

Serialized as URL search params (single, flat, easy to embed in any host app):

```
?item=<itemId>
?item=<itemId>&file=<urlencoded path>
?item=<itemId>&file=<urlencoded path>&line=42&side=new
?comment=<commentId>
```

The comment form is the most useful in practice — one short link resolves to "open this exact item, this exact file, scroll to this line, highlight this thread."

### Stable IDs

For shareable links to survive reloads, item IDs must be deterministic:

- `kind: "patch"`: `id = sha1(patchText).slice(0, 12)` by default, but callers may pass an explicit `id` or `commitSha` (preferred when available) via `addItem` / `loadFromText`.
- `kind: "multi-file-diff" | "file-diff" | "file" | "unresolved-file"`: deterministic hash of structural content, or caller-supplied id.
- Comment IDs are random (`cmt_<nanoid>`); they survive reloads because state is persisted via `persistKey`. Comment links across machines work only after the JSON export is shared and re-imported.

### Behavior

- `navigate(loc)` selects the right item/file and emits a scroll-into-view request for line / comment targets. The diff component is rendered inside a shadow root, so scroll-to-line uses the pierre API (or a `ref` on our annotation wrapper) rather than `document.querySelector`.
- "Copy link" affordances ship on: each item header, each file row in the tree, each comment thread, and each line gutter (small inline button on hover). They write a relative link (just the search portion) so the host page's origin/path is preserved.

### React integration

- `linkSync` prop (see React surface above) controls automatic bidirectional sync.
- `useReviewLocation()` is the manual hook for hosts that want full control.
- The `<CodeReview>` UI surfaces the copy-link buttons but never decides the host URL — it always calls `api.locationToSearch(loc)` and lets the consumer combine with `window.location.pathname`.

## Export schema — `ReviewExportV1`

```jsonc
{
  "schemaVersion": 1,
  "exportedAt": "2026-05-15T12:34:56.000Z",
  "items": [
    { "id": "...", "kind": "patch", "patchText": "...", "label": "..." }
    // other ReviewItem shapes preserved verbatim
  ],
  "comments": [
    {
      "id": "cmt_...",
      "parentId": null,
      "scope": { "kind": "line", "itemId": "...", "path": "src/x.ts", "line": 42, "side": "new" },
      "body": "Why are we casting here?",
      "author": "alice",
      "createdAt": "...",
      "updatedAt": "...",
      "resolved": false
    }
  ]
}
```

Threading is reconstructed via `parentId`. The schema is intentionally flat for round-tripping.

## Working style

- The plan itself is checked in first (Commit 0), so future agents and humans can read what we agreed to.
- After each numbered commit below: run the relevant checks (typecheck/lint/test/Playwright for the commits that need it), commit with a clear message, and `git push` to `origin`. No batching — every green step is pushed.
- If a check fails after a commit attempt: fix forward in the *next* commit rather than amending. Keeps history honest and reviewable.

## Commit-by-commit breakdown

### Commit 0 — Check in this plan
Copy `/home/amika/.claude/plans/there-should-also-be-immutable-lynx.md` to `plans/2026-05-15-amika-reviews-package.md` inside the repo (creating the `plans/` directory). This freezes the agreed approach into git so subsequent commits can reference it.

### Commit 1 — Bootstrap workspace and empty `@amika/reviews`
Repo root: `pnpm-workspace.yaml`, `package.json`, `.gitignore` additions. `js/reviews/`: `package.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `src/test/setup.ts`, empty `src/index.ts`, `src/headless.ts`, `src/styles.css`, `README.md` (one-paragraph stub). Verify: `pnpm install && pnpm --filter @amika/reviews run typecheck lint formatcheck test` all succeed on an empty package.

### Commit 2 — Types, parser, loaders
Files: `src/types.ts`, `src/parser.ts`, `src/io.ts`, `src/parser.test.ts`. Parser wraps `parse-diff` and normalizes to `Patch` items. `loadFromFiles` reads `File` objects via `text()`. Includes fixtures (`src/test/fixtures/*.patch`) for single-file, multi-file, rename, binary marker, malformed input.

### Commit 3 — Store, reducer, persistence, export
Files: `src/store/reducer.ts`, `src/store/store.ts` (`createReviewStore`), `src/store/persistence.ts`, `src/store/export.ts`, `src/store/reducer.test.ts`, `src/store/store.test.ts`. Pure reducer; `createReviewStore` is framework-agnostic and is what the headless entrypoint re-exports. Persistence is a small adapter triggered when `persistKey` is supplied; uses `localStorage` with try/catch + `storage` event listener for cross-tab sync.

### Commit 4 — React provider, hooks, public API exports
Files: `src/react/ReviewProvider.tsx`, `src/react/hooks.ts`, `src/react/context.ts`, `src/react/ReviewProvider.test.tsx`. Two contexts: state (via `useSyncExternalStore` over the store) and api (stable identity). `useComments` memoizes selection via a filter argument. `src/index.ts` re-exports the React surface + types; `src/headless.ts` re-exports only `createReviewStore` + types + parser + `export`.

### Commit 5 — File tree panel
Files: `src/react/FileTreePanel.tsx`, test. Builds `paths` from `listFiles()`; wires `useFileTree({ paths, onSelectionChange })`. Uses `renderRowDecoration` to show per-file comment counts. Selection drives `selectFile()` on the API.

### Commit 6 — Item viewer dispatch + line/file comments
Files: `src/react/ItemView.tsx` (switches on `item.kind` → renders the right pierre component), `src/react/LineCommentLayer.tsx` (builds `DiffLineAnnotation[]` / `LineAnnotation[]` from state), `src/react/CommentThread.tsx`, `src/react/CommentForm.tsx`, `src/react/FileCommentPanel.tsx`, tests. Click on a line → opens form → submit → adds to state → annotation appears. Side support: when the diff component reports `side`, we pass it through to the line scope.

### Commit 7 — Item-level and series-level comments
Files: `src/react/ItemCommentPanel.tsx`, `src/react/SeriesCommentPanel.tsx`, threading UI shared via `CommentThread`. Decision documented in README: one uploaded `.diff`/`.patch` file = one `ReviewItem` (kind `patch`); the in-memory collection = the series.

### Commit 8 — `<CodeReview>` composition, upload dropzone, export button
Files: `src/react/CodeReview.tsx`, `src/react/UploadDropzone.tsx`, `src/styles.css`. Three-pane layout (tree / diff / sidebar). Drop zone accepts `.diff` / `.patch`; "Add item" menu surfaces the four other modes (`MultiFileDiff`, `FileDiff`, `File`, `UnresolvedFile`) for programmatic users; "Export JSON" button triggers `api.export()` and downloads.

### Commit 9 — Deep linking (location API + `linkSync` + copy-link UI)
Files: `src/location/types.ts`, `src/location/serialize.ts`, `src/location/serialize.test.ts`, `src/store/store.ts` (extend with `navigate`, `getLocation`, scroll-request emitter), `src/react/useReviewLocation.ts`, `src/react/ReviewProvider.tsx` (add `linkSync` prop), `src/react/CopyLinkButton.tsx`, hook ins into existing item/file/line/thread components. Includes stable-id helper `src/util/hashItemId.ts` (sha-1 via WebCrypto). Tests: round-trip serialize/parse, `navigate({ kind: "comment", commentId })` resolves to correct underlying scope, `linkSync` writes/reads `window.location.search`, popstate updates selection.

### Commit 10 — `@amika/reviews-example` SPA (checked in)
A real, committed Vite + React SPA at `js/reviews-example/`. Wires `<CodeReview>` with two entry buttons: "Load fixture series" (loads `.patch` files from `public/fixtures/`) and "Drop your own." Useful both as runnable docs and as the host for Playwright E2E.

Files:
- `js/reviews-example/package.json` (`@amika/reviews-example`, private, depends on `@amika/reviews: "workspace:*"`, scripts: `dev`, `build`, `preview`, `test:e2e`, `test:e2e:ui`).
- `js/reviews-example/vite.config.ts`, `tsconfig.json`, `index.html`, `src/{main.tsx,App.tsx}`.
- `js/reviews-example/public/fixtures/{simple.patch,multi-file.patch,rename.patch}` (small, hand-curated; same content used in unit-test fixtures, copied here for the SPA).

### Commit 11 — Playwright E2E suite
Files: `js/reviews-example/playwright.config.ts` (`webServer: { command: "pnpm dev", url: "http://localhost:5173", reuseExistingServer: !process.env.CI }`), `js/reviews-example/tests/*.spec.ts`. Devices: chromium only for v0. Scenarios listed in **Testing strategy** below.

### Commit 12 — README
Expanded `README.md` covering: install, two load flows (upload vs. text), 5 item kinds with snippets, public API reference, export schema, persistence, styling/theming notes (pointing at `--trees-*` and `unsafeCSS`), pointer to the SPA + Playwright suite.

## Testing strategy

Three layers, all run in CI:

**1. Unit tests** — `vitest` in jsdom, scoped to `js/reviews/`. Pure-function coverage. Run via `pnpm --filter @amika/reviews run test`.
- Reducer: every action (add/edit/delete/reply/resolve, at every scope), idempotency of resolve, reply with non-existent parent rejected, scope filter correctness.
- Parser: fixtures for single-file, multi-file, rename, binary marker, malformed input. Snapshot the normalized `Patch[]`.
- Export/import: round-trip equality.
- Persistence: writes and re-hydrates from a faked `localStorage`; corrupt JSON is ignored gracefully.

**2. Component tests** — `@testing-library/react` + `@testing-library/jest-dom` inside the same vitest run.
- `<ReviewProvider>`: `useReview()` returns stable identity; state hook re-renders only on relevant slice changes; persistence prop integrates end-to-end with the storage mock.
- `<FileTreePanel>`: builds correct path list from items; clicking a row calls `selectFile`; comment-count decoration updates when comments are added.
- `<CommentForm>` / `<CommentThread>`: typing + submit dispatches add, reply chain renders nested, edit/delete/resolve buttons behave.
- `<UploadDropzone>`: simulated drop of `File` objects loads items into the store.
- `<CodeReview>`: integration smoke — provider + tree + dropzone + sidebar render together and a comment can be created end-to-end from RTL events.

Note: the pierre `<PatchDiff>` / `<FileTree>` internals render inside shadow roots, so RTL cannot reach inside them. We assert against our own DOM (forms, threads, side panels, decoration counts) and the public API state. The shadow-DOM-internal click-on-line interaction is covered in the Playwright layer below using real browser APIs.

**3. End-to-end tests** — Playwright, against the checked-in `@amika/reviews-example` SPA.
- Boot: `webServer` runs `pnpm --filter @amika/reviews-example dev`.
- Scenarios:
  1. Load fixture series → file tree shows expected paths → diff renders.
  2. Click a line inside the diff (using `page.locator(...).locator(":scope >>> ...")` to pierce the shadow root, or the data-testid hooks we ship on our annotation wrappers) → comment form appears → submit → annotation visible.
  3. Reply to comment → threaded reply rendered.
  4. Add file-level comment in the sidebar → visible.
  5. Add patch- and series-level comments → visible in their panels.
  6. Click "Export JSON" → use Playwright's `page.waitForEvent('download')` → parse downloaded file → assert shape matches `ReviewExportV1` and contains the comments created above.
  7. With `?persistKey=demo` in the URL, reload → previously created comments survive.
  8. **Deep link — item**: navigate to `/?item=<itemId>` → that item is selected, others collapsed.
  9. **Deep link — file**: navigate to `/?item=<itemId>&file=src/x.ts` → tree highlights the row, diff renders.
 10. **Deep link — line**: navigate to `/?item=<itemId>&file=src/x.ts&line=42&side=new` → page scrolls so line 42 is in view.
 11. **Deep link — comment**: create a comment, click its "copy link" button → assert clipboard contents are a `?comment=<id>` URL; open that URL in a fresh page → comment is scrolled to and visually highlighted.
 12. **Browser back/forward**: select item A, then item B, then press Back → selection returns to A; `popstate` honored.

Run via `pnpm --filter @amika/reviews-example test:e2e`. In CI: install browsers with `pnpm exec playwright install --with-deps chromium`.

## Critical files to be created

- `/home/amika/workspace/amika/plans/2026-05-15-amika-reviews-package.md` (Commit 0)
- `/home/amika/workspace/amika/pnpm-workspace.yaml`
- `/home/amika/workspace/amika/package.json`
- `/home/amika/workspace/amika/.gitignore` (modify)
- `/home/amika/workspace/amika/js/reviews/package.json`
- `/home/amika/workspace/amika/js/reviews/tsconfig.json`
- `/home/amika/workspace/amika/js/reviews/eslint.config.mjs`
- `/home/amika/workspace/amika/js/reviews/vitest.config.ts`
- `/home/amika/workspace/amika/js/reviews/src/{index.ts,headless.ts,styles.css,types.ts,parser.ts,io.ts}`
- `/home/amika/workspace/amika/js/reviews/src/store/{reducer.ts,store.ts,persistence.ts,export.ts}`
- `/home/amika/workspace/amika/js/reviews/src/react/{ReviewProvider.tsx,hooks.ts,context.ts,FileTreePanel.tsx,ItemView.tsx,LineCommentLayer.tsx,CommentThread.tsx,CommentForm.tsx,FileCommentPanel.tsx,ItemCommentPanel.tsx,SeriesCommentPanel.tsx,CodeReview.tsx,UploadDropzone.tsx,CopyLinkButton.tsx,useReviewLocation.ts}`
- `/home/amika/workspace/amika/js/reviews/src/location/{types.ts,serialize.ts}`
- `/home/amika/workspace/amika/js/reviews/src/util/hashItemId.ts`
- `/home/amika/workspace/amika/js/reviews/src/test/{setup.ts, fixtures/*.patch}`
- `/home/amika/workspace/amika/js/reviews/README.md`
- `/home/amika/workspace/amika/js/reviews-example/package.json`
- `/home/amika/workspace/amika/js/reviews-example/vite.config.ts`
- `/home/amika/workspace/amika/js/reviews-example/tsconfig.json`
- `/home/amika/workspace/amika/js/reviews-example/index.html`
- `/home/amika/workspace/amika/js/reviews-example/src/{main.tsx,App.tsx}`
- `/home/amika/workspace/amika/js/reviews-example/public/fixtures/*.patch`
- `/home/amika/workspace/amika/js/reviews-example/playwright.config.ts`
- `/home/amika/workspace/amika/js/reviews-example/tests/*.spec.ts`

## Reused libraries / utilities

- `@pierre/trees/react` — `useFileTree`, `<FileTree>`, `renderRowDecoration` for comment counts, `onSelectionChange` for file selection.
- `@pierre/diffs/react` — `<MultiFileDiff>`, `<PatchDiff>`, `<FileDiff>`, `<File>`, `<UnresolvedFile>`. `DiffLineAnnotation` and `LineAnnotation` for comment layering. Token callbacks not used in v0.
- `parse-diff` — small, mature unified-diff parser; output normalized into our internal `Patch` shape so we can swap implementations later.
- `useSyncExternalStore` (React 18+) — wires the framework-agnostic store into React without re-renders on unrelated state slices.
- Conventions / configs copied from `/home/amika/workspace/amika-mono/js/components/{tsconfig.json,eslint.config.mjs,vitest.config.ts,src/test/setup.ts}`.

## Verification

After each commit:

1. `pnpm --filter @amika/reviews run typecheck lint formatcheck test` — all green (covers unit + RTL component tests).
2. After commit 9 the SPA also gets `pnpm --filter @amika/reviews-example run typecheck build`.
3. After commit 10 the Playwright suite runs: `pnpm exec playwright install --with-deps chromium && pnpm --filter @amika/reviews-example run test:e2e`.

Final end-to-end smoke (after commit 11): boot `pnpm --filter @amika/reviews-example dev`, manually walk through all 7 Playwright scenarios in a real browser to sanity-check what automation can't capture (visual layout, focus behavior).

## Known unknowns / deferred

- **`FileDiffMetadata` shape**: not enumerated in `diffs.com/docs` excerpt — will read at implementation time from the published `@pierre/diffs/react` types.
- **Token-level commenting** (sub-line ranges) is out of scope for v0 — `onTokenClick` etc. noted as available for v1.
- **Server sync** (POSTing comments somewhere) — not in scope; export JSON is the bridge.
