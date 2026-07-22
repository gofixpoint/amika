package ssh

import (
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
)

func TestBuildSSHArgs(t *testing.T) {
	tests := []struct {
		name      string
		alias     string
		options   []string
		forcePTY  bool
		extraArgs []string
		want      []string
	}{
		{
			name:  "interactive session connects via alias",
			alias: "amika-sb_abc",
			want:  []string{"amika-sb_abc"},
		},
		{
			name:      "remote command follows the destination",
			alias:     "amika-sb_abc",
			extraArgs: []string{"ls", "-la"},
			want:      []string{"amika-sb_abc", "ls", "-la"},
		},
		{
			name:      "forcePTY places -t before the destination",
			alias:     "amika-sb_abc",
			forcePTY:  true,
			extraArgs: []string{"top"},
			want:      []string{"-t", "amika-sb_abc", "top"},
		},
		{
			name:      "server options precede the destination",
			alias:     "amika-sb_abc",
			options:   []string{"-i", "/key", "-o", "ProxyCommand=pc"},
			forcePTY:  true,
			extraArgs: []string{"top"},
			want:      []string{"-i", "/key", "-o", "ProxyCommand=pc", "-t", "amika-sb_abc", "top"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildSSHArgs(tt.alias, tt.options, tt.forcePTY, tt.extraArgs)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("buildSSHArgs(%q, %v, %v, %v) = %v, want %v",
					tt.alias, tt.options, tt.forcePTY, tt.extraArgs, got, tt.want)
			}
		})
	}
}

// stubInfoClient implements InfoClient for testing.
type stubInfoClient struct {
	info    *apiclient.SSHInfo
	sandbox *apiclient.RemoteSandbox
}

func (s *stubInfoClient) GetSSH(_ string) (*apiclient.SSHInfo, error) {
	return s.info, nil
}

func (s *stubInfoClient) GetSandbox(_ string) (*apiclient.RemoteSandbox, error) {
	return s.sandbox, nil
}

func TestResolveHostWritesManagedConfig(t *testing.T) {
	client := &stubInfoClient{info: &apiclient.SSHInfo{
		SSHDestination: "-i /key -p 2222 tok@ssh.app.daytona.io",
		SandboxID:      "sb_abc",
		SandboxName:    "my-sandbox",
	}}
	paths := testPaths(t)

	alias, info, options, err := ResolveHost(client, paths, "my-sandbox")
	if err != nil {
		t.Fatalf("ResolveHost: %v", err)
	}
	if alias != "amika-sb_abc" {
		t.Errorf("alias = %q, want %q", alias, "amika-sb_abc")
	}
	if info.SSHDestination != client.info.SSHDestination {
		t.Errorf("info.SSHDestination = %q, want %q", info.SSHDestination, client.info.SSHDestination)
	}
	// Options the alias block cannot express must be surfaced for forwarding.
	if want := []string{"-i", "/key"}; !reflect.DeepEqual(options, want) {
		t.Errorf("options = %v, want %v", options, want)
	}

	// The managed config must carry the alias block and accept-new so the first
	// connection to a fresh host does not fail host key verification.
	confPath, err := paths.SSHAmikaConfigFile()
	if err != nil {
		t.Fatalf("SSHAmikaConfigFile: %v", err)
	}
	conf, err := os.ReadFile(confPath)
	if err != nil {
		t.Fatalf("read amika.conf: %v", err)
	}
	if !strings.Contains(string(conf), "Host amika-sb_abc") {
		t.Errorf("amika.conf missing alias block:\n%s", conf)
	}
	if !strings.Contains(string(conf), "StrictHostKeyChecking accept-new") {
		t.Errorf("amika.conf missing accept-new:\n%s", conf)
	}
	// HostKeyAlias keys known_hosts by the stable alias so accept-new verifies
	// the sandbox's key on reconnect even when the gateway HostName rotates.
	if !strings.Contains(string(conf), "HostKeyAlias amika-sb_abc") {
		t.Errorf("amika.conf missing HostKeyAlias:\n%s", conf)
	}
}

func TestResolveHostFallsBackToSandboxID(t *testing.T) {
	client := &stubInfoClient{
		info: &apiclient.SSHInfo{
			SSHDestination: "-p 2222 tok@ssh.app.daytona.io",
			// SandboxID empty: an older server that predates the field.
		},
		sandbox: &apiclient.RemoteSandbox{ID: "sb_xyz", Name: "fallback-name"},
	}

	alias, _, _, err := ResolveHost(client, testPaths(t), "my-sandbox")
	if err != nil {
		t.Fatalf("ResolveHost: %v", err)
	}
	if alias != "amika-sb_xyz" {
		t.Errorf("alias = %q, want %q", alias, "amika-sb_xyz")
	}
}

func TestResolveHostEmptyDestination(t *testing.T) {
	client := &stubInfoClient{info: &apiclient.SSHInfo{SSHDestination: ""}}
	if _, _, _, err := ResolveHost(client, testPaths(t), "my-sandbox"); err == nil {
		t.Fatal("expected error for empty SSH destination")
	}
}

func TestResolveHostRejectsConfigFileOption(t *testing.T) {
	// -F selects an alternate config file, so ssh would never see the managed
	// alias block; reject it rather than silently fail to connect. Covers the
	// standalone, attached, and bundled-after-a-boolean-flag getopt spellings.
	for _, dest := range []string{
		"-F /etc/ssh/other tok@ssh.app.daytona.io",
		"-F/etc/ssh/other tok@ssh.app.daytona.io",
		"-4F /etc/ssh/other tok@ssh.app.daytona.io",
	} {
		client := &stubInfoClient{info: &apiclient.SSHInfo{
			SSHDestination: dest,
			SandboxID:      "sb_abc",
			SandboxName:    "my-sandbox",
		}}
		if _, _, _, err := ResolveHost(client, testPaths(t), "my-sandbox"); err == nil {
			t.Errorf("ResolveHost(%q): expected error for -F option", dest)
		}
	}
}

func TestConfigFileOption(t *testing.T) {
	tests := []struct {
		name    string
		options []string
		want    bool
	}{
		{name: "standalone -F", options: []string{"-F", "/etc/other"}, want: true},
		{name: "attached -Ffile", options: []string{"-F/etc/other"}, want: true},
		{name: "bundled after boolean flag", options: []string{"-4F", "/etc/other"}, want: true},
		{name: "bundled with attached file", options: []string{"-4F/etc/other"}, want: true},
		{name: "no options", options: nil, want: false},
		{name: "identity only", options: []string{"-i", "/key"}, want: false},
		{name: "option value ends cluster before F", options: []string{"-o", "SendEnv=FOO"}, want: false},
		{name: "F inside another option's attached value", options: []string{"-iF"}, want: false},
		{name: "jump host", options: []string{"-J", "gw@host"}, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, got := configFileOption(tt.options); got != tt.want {
				t.Errorf("configFileOption(%v) = %v, want %v", tt.options, got, tt.want)
			}
		})
	}
}
