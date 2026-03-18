package auth

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ParseDuration parses a human-friendly duration string.
// Supported suffixes: s (seconds), min (minutes), h (hours), d (days), w (weeks).
// Examples: "60s", "120min", "2h", "7d", "3w".
func ParseDuration(s string) (time.Duration, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("empty duration string")
	}

	// Try suffixes longest-first to avoid "min" matching "m" first.
	suffixes := []struct {
		suffix     string
		multiplier time.Duration
	}{
		{"min", time.Minute},
		{"s", time.Second},
		{"h", time.Hour},
		{"d", 24 * time.Hour},
		{"w", 7 * 24 * time.Hour},
	}

	for _, sf := range suffixes {
		if strings.HasSuffix(s, sf.suffix) {
			numStr := strings.TrimSuffix(s, sf.suffix)
			n, err := strconv.ParseFloat(numStr, 64)
			if err != nil {
				return 0, fmt.Errorf("invalid duration %q: %w", s, err)
			}
			if n <= 0 {
				return 0, fmt.Errorf("duration must be positive: %q", s)
			}
			return time.Duration(n * float64(sf.multiplier)), nil
		}
	}

	return 0, fmt.Errorf("invalid duration %q: must end with s, min, h, d, or w", s)
}
