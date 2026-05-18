package sandbox

import (
	"fmt"
	"time"
)

// TTLResult holds computed expiration timestamps from TTL parameters.
type TTLResult struct {
	ExpiresAt string // RFC3339, empty if no TTL
	WarnAt    string // RFC3339, empty if no TTL
}

// ComputeTTL parses a TTL duration string and optional warn-before duration,
// returning RFC3339 expiration timestamps. If ttl is empty, returns zero-value
// TTLResult. The default warnBefore is 10 minutes if empty.
func ComputeTTL(ttl, warnBefore string, now time.Time) (TTLResult, error) {
	if ttl == "" {
		return TTLResult{}, nil
	}

	ttlDur, err := time.ParseDuration(ttl)
	if err != nil {
		return TTLResult{}, fmt.Errorf("invalid TTL %q: %v", ttl, err)
	}
	if ttlDur <= 0 {
		return TTLResult{}, fmt.Errorf("TTL must be positive")
	}

	warnBeforeDur := 10 * time.Minute
	if warnBefore != "" {
		warnBeforeDur, err = time.ParseDuration(warnBefore)
		if err != nil {
			return TTLResult{}, fmt.Errorf("invalid WarnBefore %q: %v", warnBefore, err)
		}
	}
	if warnBeforeDur >= ttlDur {
		return TTLResult{}, fmt.Errorf("WarnBefore (%s) must be less than TTL (%s)", warnBeforeDur, ttlDur)
	}

	return TTLResult{
		ExpiresAt: now.Add(ttlDur).Format(time.RFC3339),
		WarnAt:    now.Add(ttlDur - warnBeforeDur).Format(time.RFC3339),
	}, nil
}
