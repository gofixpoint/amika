package ssh

import (
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
)

func TestShellQuote(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", "''"},
		{"plain", "'plain'"},
		{"a b&c?d", "'a b&c?d'"},
		{"has'quote", `'has'\''quote'`},
	}
	for _, c := range cases {
		if got := shellQuote(c.in); got != c.want {
			t.Errorf("shellQuote(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestProxyCommandEscapesURL(t *testing.T) {
	// A signed wss URL with %-encoded bytes and shell metacharacters must survive
	// both ssh's %-token expansion (each literal % doubled) and the shell (whole
	// URL single-quoted), or the tunnel breaks.
	url := "wss://host-2222.vercel.run/?token=a%2Fb&sig=c%3Dd"
	got := proxyCommand(url)
	want := "websocat --binary - 'wss://host-2222.vercel.run/?token=a%%2Fb&sig=c%%3Dd'"
	if got != want {
		t.Fatalf("proxyCommand(%q) = %q, want %q", url, got, want)
	}
	// Every literal % in the source URL must be doubled: an odd count would mean a
	// token leaked through ssh's %-expansion unescaped.
	if n := strings.Count(got, "%"); n%2 != 0 {
		t.Errorf("proxyCommand left an odd number of %% (%d): %q", n, got)
	}
}

func TestTunnelSSHArgs(t *testing.T) {
	info := &apiclient.SSHInfo{
		SSHDestination:    "vercel-sandbox@crimson-luanda",
		WebSocketProxyURL: "wss://crimson-luanda-2222.vercel.run/",
	}
	args, err := tunnelSSHArgs(info, "/tmp/key", true)
	if err != nil {
		t.Fatalf("tunnelSSHArgs: %v", err)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"-i /tmp/key",
		"IdentitiesOnly=yes",
		"StrictHostKeyChecking=accept-new",
		"ProxyCommand=websocat --binary - 'wss://crimson-luanda-2222.vercel.run/'",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("tunnelSSHArgs missing %q in %q", want, joined)
		}
	}
	// forcePTY=true adds -t, and the destination must be the final argument.
	if args[len(args)-1] != "vercel-sandbox@crimson-luanda" {
		t.Errorf("last arg = %q, want destination", args[len(args)-1])
	}
	sawPTY := false
	for _, a := range args {
		if a == "-t" {
			sawPTY = true
		}
	}
	if !sawPTY {
		t.Errorf("forcePTY did not add -t: %q", joined)
	}
}
