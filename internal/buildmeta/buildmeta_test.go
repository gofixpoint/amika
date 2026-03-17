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

	info := New("amika", "")
	if info.Version != "dev" {
		t.Fatalf("info.Version = %q, want %q", info.Version, "dev")
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
		Version:   "v1.2.3-rc.1",
		Commit:    "abcdef123456",
		Date:      "2026-03-17T12:00:00Z",
	}

	got := info.String()
	want := "amika-server version v1.2.3-rc.1\ncommit: abcdef123456\ndate: 2026-03-17T12:00:00Z"
	if got != want {
		t.Fatalf("info.String() = %q, want %q", got, want)
	}
}
