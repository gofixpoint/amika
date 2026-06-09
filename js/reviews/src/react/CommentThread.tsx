import { useMemo, useState } from "react";
import { useReview, useReviewState } from "./hooks.js";
import { CommentForm } from "./CommentForm.js";
import type { Comment } from "../store/types.js";
import type { CommentId } from "../types.js";

export interface CommentThreadProps {
  /** Root comment id. The whole descendant tree is rendered. */
  rootId: CommentId;
  /** Currently authenticated user; passed to new replies. */
  author?: string;
  className?: string;
}

/**
 * Renders a single thread (root + replies). Supports inline reply, edit,
 * delete, and resolve actions. Lives inside any panel that needs to display
 * comments: line-pop-out, file panel, item panel, series panel.
 */
export function CommentThread({
  rootId,
  author,
  className,
}: CommentThreadProps) {
  const store = useReview();
  const state = useReviewState();
  const thread = useMemo(() => {
    const root = state.comments[rootId];
    if (!root) return [] as Comment[];
    const out: Comment[] = [root];
    const seen = new Set([rootId]);
    let added = true;
    while (added) {
      added = false;
      for (const c of Object.values(state.comments)) {
        if (c.parentId && seen.has(c.parentId) && !seen.has(c.id)) {
          out.push(c);
          seen.add(c.id);
          added = true;
        }
      }
    }
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return out;
  }, [state.comments, rootId]);

  const [replying, setReplying] = useState(false);

  if (thread.length === 0) return null;

  return (
    <div className={className} data-amika="comment-thread">
      {thread.map((c) => (
        <CommentNode key={c.id} comment={c} isRoot={c.id === rootId} />
      ))}
      {replying ? (
        <CommentForm
          autoFocus
          submitLabel="Reply"
          onSubmit={(body) => {
            store.reply(rootId, body, author);
            setReplying(false);
          }}
          onCancel={() => setReplying(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setReplying(true)}
          data-amika="comment-thread-reply-trigger"
        >
          Reply
        </button>
      )}
    </div>
  );
}

function CommentNode({
  comment,
  isRoot,
}: {
  comment: Comment;
  isRoot: boolean;
}) {
  const store = useReview();
  const [editing, setEditing] = useState(false);

  return (
    <article
      data-amika="comment"
      data-amika-comment-id={comment.id}
      data-amika-comment-resolved={comment.resolved}
    >
      <header>
        <span data-amika="comment-author">{comment.author ?? "anonymous"}</span>
        <time dateTime={comment.createdAt}>{comment.createdAt}</time>
      </header>
      {editing ? (
        <CommentForm
          autoFocus
          initialBody={comment.body}
          submitLabel="Save"
          onSubmit={(body) => {
            store.editComment(comment.id, body);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <p data-amika="comment-body">{comment.body}</p>
      )}
      <footer data-amika="comment-actions">
        {!editing && (
          <>
            <button type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              type="button"
              onClick={() => store.deleteComment(comment.id)}
            >
              Delete
            </button>
            {isRoot && (
              <button
                type="button"
                onClick={() => store.setResolved(comment.id, !comment.resolved)}
              >
                {comment.resolved ? "Reopen" : "Resolve"}
              </button>
            )}
          </>
        )}
      </footer>
    </article>
  );
}
