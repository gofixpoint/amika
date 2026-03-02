package ports

// IDGenerator produces deterministic or random IDs for runtime resources.
type IDGenerator interface {
	New(prefix string) string
}
