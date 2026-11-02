package apiclient

import (
	"strings"
	"testing"
)

func TestValidSSHUserAcceptsAccountNames(t *testing.T) {
	for _, name := range []string{
		"amika",
		"jakub",
		"Jakub",
		"ubuntu",
		"_svc",
		"first.last",
		"build-bot_2",
		"0day",
		strings.Repeat("a", 64),
	} {
		if !ValidSSHUser(name) {
			t.Errorf("ValidSSHUser(%q) = false, want true", name)
		}
	}
}

func TestValidSSHUserRejectsUnsafeNames(t *testing.T) {
	for _, name := range []string{
		"",
		strings.Repeat("a", 65),
		"-oProxyCommand=x",
		".hidden",
		"two words",
		"tab\there",
		"line\nbreak",
		"nul\x00",
		"del\x7f",
		"root@host",
		"host:22",
		"a/b",
		`back\slash`,
		`"quoted"`,
		"'quoted'",
		"%u",
		"#comment",
		"$(id)",
		"semi;colon",
		"jürgen",
	} {
		if ValidSSHUser(name) {
			t.Errorf("ValidSSHUser(%q) = true, want false", name)
		}
	}
}
