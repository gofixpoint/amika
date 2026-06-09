import type { ReviewItem } from "../types.js";
import type { Comment, ReviewState } from "./types.js";

export interface ReviewExportV1 {
  schemaVersion: 1;
  exportedAt: string;
  items: ReviewItem[];
  comments: Comment[];
}

export function exportReview(
  state: ReviewState,
  now: () => string = () => new Date().toISOString(),
): ReviewExportV1 {
  return {
    schemaVersion: 1,
    exportedAt: now(),
    items: state.items,
    comments: Object.values(state.comments),
  };
}

export function isReviewExportV1(value: unknown): value is ReviewExportV1 {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.schemaVersion === 1 &&
    Array.isArray(v.items) &&
    Array.isArray(v.comments) &&
    typeof v.exportedAt === "string"
  );
}
