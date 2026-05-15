import { useState } from "react";
import { useComments, useReview } from "./hooks.js";
import { CommentForm } from "./CommentForm.js";
import { CommentThread } from "./CommentThread.js";
import type { ReviewItemId } from "../types.js";

export interface ItemCommentPanelProps {
  itemId: ReviewItemId;
  author?: string;
  className?: string;
  /** Optional human-readable label shown in the header. */
  label?: string;
}

/**
 * Sidebar panel for comments scoped to an entire item (one uploaded patch
 * or commit). Mirrors FileCommentPanel but at coarser granularity.
 */
export function ItemCommentPanel({
  itemId,
  author,
  className,
  label,
}: ItemCommentPanelProps) {
  const store = useReview();
  const comments = useComments({ scope: "item", itemId });
  const roots = comments.filter((c) => c.parentId === null);
  const [composing, setComposing] = useState(false);

  return (
    <section
      className={className}
      data-amika="item-comment-panel"
      data-amika-item={itemId}
    >
      <header>
        <h3>Patch comments</h3>
        {label && <span data-amika="item-comment-label">{label}</span>}
      </header>

      {roots.length === 0 && !composing && (
        <p data-amika="item-comment-empty">No comments on this patch yet.</p>
      )}

      {roots.map((r) => (
        <CommentThread key={r.id} rootId={r.id} author={author} />
      ))}

      {composing ? (
        <CommentForm
          autoFocus
          submitLabel="Add patch comment"
          onSubmit={(body) => {
            store.addComment({ scope: { kind: "item", itemId }, body, author });
            setComposing(false);
          }}
          onCancel={() => setComposing(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setComposing(true)}
          data-amika="item-comment-trigger"
        >
          Add patch comment
        </button>
      )}
    </section>
  );
}
