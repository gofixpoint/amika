package sandbox

import (
	"strings"
	"testing"
)

func TestValidateGithubAuthMode(t *testing.T) {
	tests := []struct {
		name    string
		mode    string
		wantErr string
	}{
		{
			name: "empty is ok (server default)",
			mode: "",
		},
		{
			name: "pat is allowed",
			mode: "pat",
		},
		{
			name: "app_token is allowed",
			mode: "app_token",
		},
		{
			name: "app-token alias is allowed",
			mode: "app-token",
		},
		{
			name:    "unknown value is rejected",
			mode:    "oauth",
			wantErr: "unknown github-auth-mode",
		},
		{
			name:    "junk value is rejected",
			mode:    "junk",
			wantErr: "unknown github-auth-mode",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateGithubAuthMode(tt.mode)
			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("error %q does not contain %q", err.Error(), tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestCanonicalGithubAuthMode(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "app-token alias normalizes",
			in:   "app-token",
			want: "app_token",
		},
		{
			name: "app_token stays unchanged",
			in:   "app_token",
			want: "app_token",
		},
		{
			name: "pat stays unchanged",
			in:   "pat",
			want: "pat",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CanonicalGithubAuthMode(tt.in)
			if got != tt.want {
				t.Fatalf("CanonicalGithubAuthMode(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}
