import { useState } from "react";
import { useComments, useReview } from "./hooks.js";
import { CommentForm } from "./CommentForm.js";
import { CommentThread } from "./CommentThread.js";
import type { ReviewItemId } from "../types.js";

export interface FileCommentPanelProps {
  itemId: ReviewItemId;
  path: string;
  author?: string;
  className?: string;
}

/**
 * Sidebar panel showing all file-scope comments on a single file plus a
 * composer for new ones. Threads (replies) are rendered through CommentThread.
 */
export function FileCommentPanel({
  itemId,
  path,
  author,
  className,
}: FileCommentPanelProps) {
  const store = useReview();
  const comments = useComments({ scope: "file", itemId, path });
  const roots = comments.filter((c) => c.parentId === null);
  const [composing, setComposing] = useState(false);

  return (
    <section
      className={className}
      data-amika="file-comment-panel"
      data-amika-file={path}
    >
      <header>
        <h3>File comments</h3>
        <span data-amika="file-comment-path">{path}</span>
      </header>

      {roots.length === 0 && !composing && (
        <p data-amika="file-comment-empty">No file-level comments yet.</p>
      )}

      {roots.map((r) => (
        <CommentThread key={r.id} rootId={r.id} author={author} />
      ))}

      {composing ? (
        <CommentForm
          autoFocus
          submitLabel="Add file comment"
          onSubmit={(body) => {
            store.addComment({
              scope: { kind: "file", itemId, path },
              body,
              author,
            });
            setComposing(false);
          }}
          onCancel={() => setComposing(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setComposing(true)}
          data-amika="file-comment-trigger"
        >
          Add file comment
        </button>
      )}
    </section>
  );
}
