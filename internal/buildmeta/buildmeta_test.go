package buildmeta

import "testing"

func TestNewDefaults(t *testing.T) {
	originalCommit := Commit
	originalDate := Date
	t.Cleanup(func() {
		Commit = originalCommit
		Date = originalDate
	})

	Commit = ""
	Date = ""

	info := New("amika", SemVer{Dev: true})
	if got := info.Version.String(); got != "dev" {
		t.Fatalf("info.Version.String() = %q, want %q", got, "dev")
	}
	if info.Commit != "unknown" {
		t.Fatalf("info.Commit = %q, want %q", info.Commit, "unknown")
	}
	if info.Date != "unknown" {
		t.Fatalf("info.Date = %q, want %q", info.Date, "unknown")
	}
}

func TestInfoString(t *testing.T) {
	info := Info{
		Component: "amika-server",
		Version:   SemVer{Major: 1, Minor: 2, Patch: 3, PreRelease: "rc.1"},
		Commit:    "abcdef123456",
		Date:      "2026-03-17T12:00:00Z",
	}

	got := info.String()
	want := "amika-server version v1.2.3-rc.1\ncommit: abcdef123456\ndate: 2026-03-17T12:00:00Z"
	if got != want {
		t.Fatalf("info.String() = %q, want %q", got, want)
	}
}

func TestParseSemVer(t *testing.T) {
	tests := []struct {
		input string
		want  SemVer
	}{
		{
			input: "dev",
			want:  SemVer{Dev: true},
		},
		{
			input: "v1.2.3",
			want:  SemVer{Major: 1, Minor: 2, Patch: 3},
		},
		{
			input: "v1.2.3-beta.1",
			want:  SemVer{Major: 1, Minor: 2, Patch: 3, PreRelease: "beta.1"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got, err := ParseSemVer(tt.input)
			if err != nil {
				t.Fatalf("ParseSemVer() error = %v", err)
			}
			if got != tt.want {
				t.Fatalf("ParseSemVer() = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestSemVerString(t *testing.T) {
	tests := []struct {
		name    string
		version SemVer
		want    string
	}{
		{
			name:    "dev",
			version: SemVer{Dev: true},
			want:    "dev",
		},
		{
			name:    "stable",
			version: SemVer{Major: 1, Minor: 2, Patch: 3},
			want:    "v1.2.3",
		},
		{
			name:    "prerelease",
			version: SemVer{Major: 1, Minor: 2, Patch: 3, PreRelease: "rc.1"},
			want:    "v1.2.3-rc.1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.version.String(); got != tt.want {
				t.Fatalf("SemVer.String() = %q, want %q", got, tt.want)
			}
		})
	}
}
