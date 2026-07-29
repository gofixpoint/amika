package services

import (
	"strings"
	"testing"
)

// ValidatePort accepts ordinary ports and rejects out-of-range ports and any
// port inside the reserved Amika range, including its inclusive boundaries.
func TestValidatePort(t *testing.T) {
	cases := []struct {
		name    string
		port    int
		wantErr string // "" means expect success
	}{
		{"typical", 3000, ""},
		{"low boundary", 1, ""},
		{"high boundary", 65535, ""},
		{"just below reserved", ReservedPortMin - 1, ""},
		{"just above reserved", ReservedPortMax + 1, ""},
		{"zero", 0, "must be between 1 and 65535"},
		{"negative", -1, "must be between 1 and 65535"},
		{"too large", 70000, "must be between 1 and 65535"},
		{"reserved low boundary", ReservedPortMin, "reserved for internal Amika services"},
		{"reserved high boundary", ReservedPortMax, "reserved for internal Amika services"},
		{"reserved middle", 60950, "reserved for internal Amika services"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidatePort(tc.port)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("ValidatePort(%d) = %v, want nil", tc.port, err)
				}
				return
			}
			if err == nil {
				t.Fatalf("ValidatePort(%d) = nil, want error containing %q", tc.port, tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("ValidatePort(%d) = %v, want containing %q", tc.port, err, tc.wantErr)
			}
		})
	}
}
