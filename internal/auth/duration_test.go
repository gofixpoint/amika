package auth

import (
	"testing"
	"time"
)

func TestParseDuration(t *testing.T) {
	tests := []struct {
		input string
		want  time.Duration
	}{
		{"60s", 60 * time.Second},
		{"120min", 120 * time.Minute},
		{"2h", 2 * time.Hour},
		{"7d", 7 * 24 * time.Hour},
		{"3w", 3 * 7 * 24 * time.Hour},
		{"0.5h", 30 * time.Minute},
		{"1d", 24 * time.Hour},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got, err := ParseDuration(tt.input)
			if err != nil {
				t.Fatalf("ParseDuration(%q) error: %v", tt.input, err)
			}
			if got != tt.want {
				t.Errorf("ParseDuration(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

func TestParseDurationErrors(t *testing.T) {
	tests := []string{
		"",
		"abc",
		"10",
		"10x",
		"-5d",
		"0s",
	}

	for _, input := range tests {
		t.Run(input, func(t *testing.T) {
			_, err := ParseDuration(input)
			if err == nil {
				t.Errorf("ParseDuration(%q) expected error, got nil", input)
			}
		})
	}
}
