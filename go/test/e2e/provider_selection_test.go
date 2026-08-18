package e2e_test

import "testing"

func TestResolveSandboxProvider(t *testing.T) {
	tests := []struct {
		name         string
		flagProvider string
		envProvider  string
		want         string
		wantErr      bool
	}{
		{name: "defaults to daytona", want: "daytona"},
		{name: "uses environment", envProvider: "sailbox", want: "sailbox"},
		{
			name:         "flag overrides environment",
			flagProvider: "vercel",
			envProvider:  "sailbox",
			want:         "vercel",
		},
		{name: "rejects invalid environment", envProvider: "unknown", wantErr: true},
		{
			name:         "rejects invalid flag before environment",
			flagProvider: "unknown",
			envProvider:  "sailbox",
			wantErr:      true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveSandboxProvider(tt.flagProvider, tt.envProvider)
			if tt.wantErr {
				if err == nil {
					t.Fatal("resolveSandboxProvider() error = nil, want error")
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveSandboxProvider() error = %v", err)
			}
			if got != tt.want {
				t.Errorf("resolveSandboxProvider() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSelectsSandboxProvider(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want bool
	}{
		{
			name: "uses suite provider template",
			args: []string{"sandbox", "create", "--remote", "--provider", "{{sandbox_provider}}"},
			want: true,
		},
		{
			name: "uses literal provider",
			args: []string{"sandbox", "create", "--remote", "--provider", "sailbox"},
			want: true,
		},
		{
			name: "uses equals form",
			args: []string{"sandbox", "create", "--remote", "--provider=vercel"},
			want: true,
		},
		{
			name: "rejects missing provider",
			args: []string{"sandbox", "create", "--remote"},
			want: false,
		},
		{
			name: "rejects unsupported provider",
			args: []string{"sandbox", "create", "--remote", "--provider", "unknown"},
			want: false,
		},
		{
			name: "uses last provider flag",
			args: []string{"sandbox", "create", "--remote", "--provider", "unknown", "--provider", "freestyle"},
			want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := selectsSandboxProvider(tt.args); got != tt.want {
				t.Errorf("selectsSandboxProvider() = %t, want %t", got, tt.want)
			}
		})
	}
}
