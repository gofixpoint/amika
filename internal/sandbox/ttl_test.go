package sandbox

import (
	"testing"
	"time"
)

func TestComputeTTL(t *testing.T) {
	now := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)

	t.Run("empty TTL returns zero result", func(t *testing.T) {
		result, err := ComputeTTL("", "", now)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result.ExpiresAt != "" || result.WarnAt != "" {
			t.Fatalf("expected empty result, got %+v", result)
		}
	})

	t.Run("valid TTL with default warn-before", func(t *testing.T) {
		result, err := ComputeTTL("2h", "", now)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		wantExpires := now.Add(2 * time.Hour).Format(time.RFC3339)
		wantWarn := now.Add(2*time.Hour - 10*time.Minute).Format(time.RFC3339)
		if result.ExpiresAt != wantExpires {
			t.Errorf("ExpiresAt = %q, want %q", result.ExpiresAt, wantExpires)
		}
		if result.WarnAt != wantWarn {
			t.Errorf("WarnAt = %q, want %q", result.WarnAt, wantWarn)
		}
	})

	t.Run("valid TTL with custom warn-before", func(t *testing.T) {
		result, err := ComputeTTL("1h", "5m", now)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		wantExpires := now.Add(1 * time.Hour).Format(time.RFC3339)
		wantWarn := now.Add(1*time.Hour - 5*time.Minute).Format(time.RFC3339)
		if result.ExpiresAt != wantExpires {
			t.Errorf("ExpiresAt = %q, want %q", result.ExpiresAt, wantExpires)
		}
		if result.WarnAt != wantWarn {
			t.Errorf("WarnAt = %q, want %q", result.WarnAt, wantWarn)
		}
	})

	t.Run("invalid TTL string", func(t *testing.T) {
		_, err := ComputeTTL("bad", "", now)
		if err == nil {
			t.Fatal("expected error for invalid TTL")
		}
	})

	t.Run("negative TTL", func(t *testing.T) {
		_, err := ComputeTTL("-1h", "", now)
		if err == nil {
			t.Fatal("expected error for negative TTL")
		}
	})

	t.Run("warn-before >= TTL", func(t *testing.T) {
		_, err := ComputeTTL("10m", "10m", now)
		if err == nil {
			t.Fatal("expected error when warn-before >= TTL")
		}
	})

	t.Run("invalid warn-before string", func(t *testing.T) {
		_, err := ComputeTTL("1h", "bad", now)
		if err == nil {
			t.Fatal("expected error for invalid warn-before")
		}
	})
}
