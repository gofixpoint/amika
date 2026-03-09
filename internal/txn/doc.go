// Package txn provides primitives for managing transactional operations that
// may need to be rolled back on failure. It is intended for use cases where a
// sequence of side-effectful steps (creating files, writing store entries,
// allocating resources) must be undone atomically if any step fails, and
// cleanly committed once all steps succeed.
package txn
