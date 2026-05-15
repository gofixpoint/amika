import { useState, type FormEvent } from "react";

export interface CommentFormProps {
  /** Initial body when editing; empty for new comments. */
  initialBody?: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (body: string) => void;
  onCancel?: () => void;
  className?: string;
  autoFocus?: boolean;
}

/**
 * Bare comment composer: textarea + submit + optional cancel. Reused by new
 * comments, replies, and edits. The component holds local draft state; submit
 * only fires for non-empty bodies (whitespace trimmed).
 */
export function CommentForm({
  initialBody = "",
  placeholder = "Leave a comment…",
  submitLabel = "Comment",
  onSubmit,
  onCancel,
  className,
  autoFocus,
}: CommentFormProps) {
  const [body, setBody] = useState(initialBody);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setBody("");
  }

  return (
    <form
      className={className}
      onSubmit={handleSubmit}
      data-amika="comment-form"
    >
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        rows={3}
        data-amika="comment-form-input"
      />
      <div data-amika="comment-form-actions">
        <button type="submit" disabled={!body.trim()}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
