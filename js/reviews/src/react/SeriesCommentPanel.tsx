import { useState } from "react";
import { useComments, useReview } from "./hooks.js";
import { CommentForm } from "./CommentForm.js";
import { CommentThread } from "./CommentThread.js";

export interface SeriesCommentPanelProps {
  author?: string;
  className?: string;
}

/**
 * Sidebar panel for comments scoped to the entire review series (all items
 * together). One per `<CodeReview>`.
 */
export function SeriesCommentPanel({
  author,
  className,
}: SeriesCommentPanelProps) {
  const store = useReview();
  const comments = useComments({ scope: "series" });
  const roots = comments.filter((c) => c.parentId === null);
  const [composing, setComposing] = useState(false);

  return (
    <section className={className} data-amika="series-comment-panel">
      <header>
        <h3>Review comments</h3>
      </header>

      {roots.length === 0 && !composing && (
        <p data-amika="series-comment-empty">No review-level comments yet.</p>
      )}

      {roots.map((r) => (
        <CommentThread key={r.id} rootId={r.id} author={author} />
      ))}

      {composing ? (
        <CommentForm
          autoFocus
          submitLabel="Add review comment"
          onSubmit={(body) => {
            store.addComment({ scope: { kind: "series" }, body, author });
            setComposing(false);
          }}
          onCancel={() => setComposing(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setComposing(true)}
          data-amika="series-comment-trigger"
        >
          Add review comment
        </button>
      )}
    </section>
  );
}
