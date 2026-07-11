package sandboxcmd

import (
	"reflect"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
)

func TestParseSCPArgs(t *testing.T) {
	tests := []struct {
		name        string
		args        []string
		wantSandbox string
		wantArgv    []string
		wantPrint   bool
		wantErr     string
	}{
		{
			name:        "basic upload",
			args:        []string{"mybox", "./a.txt", "mybox:/home/amika/a.txt"},
			wantSandbox: "mybox",
			wantArgv:    []string{"./a.txt", "mybox:/home/amika/a.txt"},
		},
		{
			name:        "flags pass through in order",
			args:        []string{"mybox", "-r", "-l", "100", "mybox:/out", "./out"},
			wantSandbox: "mybox",
			wantArgv:    []string{"-r", "-l", "100", "mybox:/out", "./out"},
		},
		{
			name:        "print flag before sandbox",
			args:        []string{"--print", "mybox", "./a", "mybox:/b"},
			wantSandbox: "mybox",
			wantArgv:    []string{"./a", "mybox:/b"},
			wantPrint:   true,
		},
		{
			name:        "print flag after sandbox",
			args:        []string{"mybox", "./a", "mybox:/b", "--print"},
			wantSandbox: "mybox",
			wantArgv:    []string{"./a", "mybox:/b"},
			wantPrint:   true,
		},
		{
			name:        "remote flag accepted and ignored",
			args:        []string{"--remote", "mybox", "mybox:/a", "./a"},
			wantSandbox: "mybox",
			wantArgv:    []string{"mybox:/a", "./a"},
		},
		{
			name:    "local rejected",
			args:    []string{"--local", "mybox", "./a", "mybox:/b"},
			wantErr: "requires a remote sandbox",
		},
		{
			name:    "remote-target rejected",
			args:    []string{"--remote-target", "prod", "mybox", "./a", "mybox:/b"},
			wantErr: "not yet supported",
		},
		{
			name:    "flag as first positional rejected",
			args:    []string{"-r", "./a", "mybox:/b"},
			wantErr: "expected the sandbox name",
		},
		{
			name:    "no sandbox name",
			args:    []string{"--print"},
			wantErr: "missing sandbox name",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plan, err := parseSCPArgs(tt.args)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("parseSCPArgs() error = %v, want substring %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseSCPArgs() unexpected error = %v", err)
			}
			if plan.sandbox != tt.wantSandbox {
				t.Errorf("sandbox = %q, want %q", plan.sandbox, tt.wantSandbox)
			}
			if plan.printOnly != tt.wantPrint {
				t.Errorf("printOnly = %v, want %v", plan.printOnly, tt.wantPrint)
			}
			if !reflect.DeepEqual(plan.scpArgv, tt.wantArgv) {
				t.Errorf("scpArgv = %#v, want %#v", plan.scpArgv, tt.wantArgv)
			}
		})
	}
}

// fixedDest resolves any sandbox name to a static destination for tests.
func fixedDest(d ssh.Destination) destResolver {
	return func(string) (ssh.Destination, error) { return d, nil }
}

func TestBuildSCPInvocation(t *testing.T) {
	daytona := ssh.Destination{User: "user-token", Host: "ssh.app.daytona.io"}
	ported := ssh.Destination{User: "u", Host: "host.example", Port: 2222}

	tests := []struct {
		name    string
		plan    scpPlan
		dest    ssh.Destination
		want    []string
		wantErr string
	}{
		{
			name: "upload local to sandbox",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"./a.txt", "mybox:/home/amika/a.txt"}},
			dest: daytona,
			want: []string{"-o", "StrictHostKeyChecking=accept-new", "./a.txt", "user-token@ssh.app.daytona.io:/home/amika/a.txt"},
		},
		{
			name: "recursive download from sandbox",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"-r", "mybox:/out", "./out"}},
			dest: daytona,
			want: []string{"-o", "StrictHostKeyChecking=accept-new", "-r", "user-token@ssh.app.daytona.io:/out", "./out"},
		},
		{
			name: "sbox uri form",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"./a.txt", "sbox://mybox/home/amika/a.txt"}},
			dest: daytona,
			want: []string{"-o", "StrictHostKeyChecking=accept-new", "./a.txt", "user-token@ssh.app.daytona.io:/home/amika/a.txt"},
		},
		{
			name: "empty sandbox path targets home",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"./a.txt", "mybox:"}},
			dest: daytona,
			want: []string{"-o", "StrictHostKeyChecking=accept-new", "./a.txt", "user-token@ssh.app.daytona.io:"},
		},
		{
			name: "sandbox with port injects -P",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"./a.txt", "mybox:/x"}},
			dest: ported,
			want: []string{"-o", "StrictHostKeyChecking=accept-new", "-P", "2222", "./a.txt", "u@host.example:/x"},
		},
		{
			// An external host is involved, so the sandbox host-key policy is
			// not injected (scp -o options apply to every remote).
			name: "scp uri external host with port",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"mybox:/data.csv", "scp://user@host:22/tmp/data.csv"}},
			dest: daytona,
			want: []string{"-P", "22", "user-token@ssh.app.daytona.io:/data.csv", "user@host:/tmp/data.csv"},
		},
		{
			name: "native host path passthrough with sandbox",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"mybox:/data", "other-host:/backup"}},
			dest: daytona,
			want: []string{"user-token@ssh.app.daytona.io:/data", "other-host:/backup"},
		},
		{
			// A ported sandbox with an implicit-port external remote would force
			// the external host onto the sandbox's port via the global -P.
			name:    "ported sandbox with implicit-port external remote",
			plan:    scpPlan{sandbox: "mybox", scpArgv: []string{"mybox:/data", "other-host:/backup"}},
			dest:    ported,
			wantErr: "different ports",
		},
		{
			name:    "ported sandbox with portless scp uri",
			plan:    scpPlan{sandbox: "mybox", scpArgv: []string{"mybox:/data", "scp://host/backup"}},
			dest:    ported,
			wantErr: "different ports",
		},
		{
			// Explicit port 22 agrees with the implicit default, so -P 22 is safe.
			name: "explicit port 22 with implicit-port remote",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"scp://host:22/data", "other-host:/backup"}},
			dest: daytona,
			want: []string{"-P", "22", "host:/data", "other-host:/backup"},
		},
		{
			name: "user set port is not overridden",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"-P", "9000", "./a", "mybox:/x"}},
			dest: ported,
			want: []string{"-o", "StrictHostKeyChecking=accept-new", "-P", "9000", "./a", "u@host.example:/x"},
		},
		{
			name: "user set StrictHostKeyChecking is not overridden",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"-o", "StrictHostKeyChecking=yes", "./a", "mybox:/x"}},
			dest: daytona,
			want: []string{"-o", "StrictHostKeyChecking=yes", "./a", "user-token@ssh.app.daytona.io:/x"},
		},
		{
			name:    "no remote is an error",
			plan:    scpPlan{sandbox: "mybox", scpArgv: []string{"./a", "./b"}},
			dest:    daytona,
			wantErr: "no remote source or target",
		},
		{
			name:    "mismatched sbox uri name",
			plan:    scpPlan{sandbox: "mybox", scpArgv: []string{"./a", "sbox://otherbox/x"}},
			dest:    daytona,
			wantErr: "connects to \"mybox\"",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := buildSCPInvocation(tt.plan, fixedDest(tt.dest))
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("buildSCPInvocation() error = %v, want substring %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("buildSCPInvocation() unexpected error = %v", err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("buildSCPInvocation()\n got = %#v\nwant = %#v", got, tt.want)
			}
		})
	}
}

func TestBuildSCPInvocationConflictingPorts(t *testing.T) {
	plan := scpPlan{sandbox: "mybox", scpArgv: []string{"mybox:/a", "scp://host:2222/b"}}
	dest := ssh.Destination{User: "u", Host: "h", Port: 22}
	_, err := buildSCPInvocation(plan, fixedDest(dest))
	if err == nil || !strings.Contains(err.Error(), "different ports") {
		t.Fatalf("buildSCPInvocation() error = %v, want ports conflict", err)
	}
}

func TestBuildSCPInvocationResolvesLazily(t *testing.T) {
	called := false
	resolve := func(string) (ssh.Destination, error) {
		called = true
		return ssh.Destination{Host: "h"}, nil
	}
	// Only scp:// remotes: the sandbox destination must not be resolved.
	plan := scpPlan{sandbox: "mybox", scpArgv: []string{"scp://a/x", "scp://b/y"}}
	if _, err := buildSCPInvocation(plan, resolve); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if called {
		t.Error("sandbox destination was resolved even though no argument referenced the sandbox")
	}
}

func TestParseSboxURI(t *testing.T) {
	tests := []struct {
		raw      string
		wantName string
		wantPath string
		wantErr  bool
	}{
		{raw: "sbox://mybox/home/amika/a.txt", wantName: "mybox", wantPath: "/home/amika/a.txt"},
		{raw: "sbox://mybox", wantName: "mybox", wantPath: ""},
		{raw: "sbox:///no-host", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			name, path, err := parseSboxURI(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseSboxURI(%q) expected error", tt.raw)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseSboxURI(%q) error = %v", tt.raw, err)
			}
			if name != tt.wantName || path != tt.wantPath {
				t.Errorf("parseSboxURI(%q) = (%q, %q), want (%q, %q)", tt.raw, name, path, tt.wantName, tt.wantPath)
			}
		})
	}
}

func TestParseSCPURI(t *testing.T) {
	tests := []struct {
		raw      string
		wantSpec string
		wantPort int
		wantErr  bool
	}{
		{raw: "scp://user@host:2222/tmp/x", wantSpec: "user@host:/tmp/x", wantPort: 2222},
		{raw: "scp://host/tmp/x", wantSpec: "host:/tmp/x", wantPort: 0},
		{raw: "scp://host", wantSpec: "host:", wantPort: 0},
		{raw: "scp://host:notaport/x", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			spec, port, err := parseSCPURI(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseSCPURI(%q) expected error", tt.raw)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseSCPURI(%q) error = %v", tt.raw, err)
			}
			if spec != tt.wantSpec || port != tt.wantPort {
				t.Errorf("parseSCPURI(%q) = (%q, %d), want (%q, %d)", tt.raw, spec, port, tt.wantSpec, tt.wantPort)
			}
		})
	}
}

func TestLooksLikeRemote(t *testing.T) {
	remote := []string{"host:/path", "host:", "user@host:path", "mybox:relative"}
	local := []string{"./a.txt", "/abs/path", "relative/path", "-r", "-P", "a/b:c"}
	for _, tok := range remote {
		if !looksLikeRemote(tok) {
			t.Errorf("looksLikeRemote(%q) = false, want true", tok)
		}
	}
	for _, tok := range local {
		if looksLikeRemote(tok) {
			t.Errorf("looksLikeRemote(%q) = true, want false", tok)
		}
	}
}

func TestSCPCommandRegistered(t *testing.T) {
	sandboxCmd := New()
	var scpCmd *cobra.Command
	for _, c := range sandboxCmd.Commands() {
		if c.Name() == "scp" {
			scpCmd = c
			break
		}
	}
	if scpCmd == nil {
		t.Fatal("scp subcommand not registered under sandbox")
	}
	if !scpCmd.DisableFlagParsing {
		t.Error("scp command must disable flag parsing to forward scp flags verbatim")
	}
	if scpCmd.Flags().Lookup("print") == nil {
		t.Error("scp command must define --print")
	}
}
