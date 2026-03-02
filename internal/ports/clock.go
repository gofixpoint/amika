package ports

import "time"

// Clock returns the current time.
type Clock interface {
	Now() time.Time
}
