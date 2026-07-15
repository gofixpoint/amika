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
	daytona22 := ssh.Destination{User: "user-token", Host: "ssh.app.daytona.io", Port: 22}
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
			// An explicit sandbox port 22 is scp's default, so no -P is injected.
			name: "explicit sandbox port 22 needs no -P",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"./a.txt", "mybox:/x"}},
			dest: daytona22,
			want: []string{"-o", "StrictHostKeyChecking=accept-new", "./a.txt", "user-token@ssh.app.daytona.io:/x"},
		},
		{
			// Because :22 needs no -P, it does not conflict with a port-dependent
			// external remote (a native host:path) that also defaults to 22.
			name: "explicit sandbox port 22 does not conflict with implicit-port remote",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"mybox:/data", "other-host:/backup"}},
			dest: daytona22,
			want: []string{"user-token@ssh.app.daytona.io:/data", "other-host:/backup"},
		},
		{
			// An external host is involved, so the sandbox host-key policy is not
			// injected (scp -o options apply to every remote). The URI names its
			// own port, so it is emitted as a self-porting scp:// operand and no
			// global -P is needed; the sandbox uses its implicit default port.
			name: "scp uri external host with explicit port 22",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"mybox:/data.csv", "scp://user@host:22/tmp/data.csv"}},
			dest: daytona,
			want: []string{"user-token@ssh.app.daytona.io:/data.csv", "scp://user@host:22//tmp/data.csv"},
		},
		{
			// Codex's case: a default-port sandbox copying to an external host on
			// a non-default port. The URI self-ports, the sandbox uses its
			// implicit default, and no global -P conflates the two.
			name: "default sandbox to external non-default-port URI",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"mybox:/data", "scp://backup:2222/out"}},
			dest: daytona,
			want: []string{"user-token@ssh.app.daytona.io:/data", "scp://backup:2222//out"},
		},
		{
			// Codex's example: a non-default sandbox port copying to an explicit
			// port-22 URI. The sandbox takes the global -P; the URI self-ports to
			// 22, overriding -P for that host.
			name: "ported sandbox and external URI on different explicit ports",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"mybox:/data", "scp://user@host:22/tmp/out"}},
			dest: ported,
			want: []string{"-P", "2222", "u@host.example:/data", "scp://user@host:22//tmp/out"},
		},
		{
			name: "native host path passthrough with sandbox",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"mybox:/data", "other-host:/backup"}},
			dest: daytona,
			want: []string{"user-token@ssh.app.daytona.io:/data", "other-host:/backup"},
		},
		{
			// A ported sandbox with an implicit-port native remote would force
			// the external host onto the sandbox's port via the global -P.
			name:    "ported sandbox with implicit-port external remote",
			plan:    scpPlan{sandbox: "mybox", scpArgv: []string{"mybox:/data", "other-host:/backup"}},
			dest:    ported,
			wantErr: "unspecified",
		},
		{
			// A portless scp:// URI is port-dependent like a native host:path, so
			// a ported sandbox cannot share the global -P with it.
			name:    "ported sandbox with portless scp uri",
			plan:    scpPlan{sandbox: "mybox", scpArgv: []string{"mybox:/data", "scp://host/backup"}},
			dest:    ported,
			wantErr: "unspecified",
		},
		{
			// The URI names its own port, so it self-ports and does not force the
			// native remote (which resolves its port from SSH config) onto it. No
			// sandbox is referenced, so no -P is injected and both remotes keep
			// their own port.
			name: "explicit-port URI does not force a native remote's port",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"scp://host:22/data", "other-host:/backup"}},
			dest: daytona,
			want: []string{"scp://host:22//data", "other-host:/backup"},
		},
		{
			// The external URI self-ports via its own scp:// operand; the sandbox
			// still needs -P for its port. They agree here, but the URI keeps its
			// own port even when they differ (see the case above).
			name: "external URI self-ports alongside a ported sandbox",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"scp://host:2222/data", "mybox:/backup"}},
			dest: ported,
			want: []string{"-P", "2222", "scp://host:2222//data", "u@host.example:/backup"},
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
			// -J takes a "[user@]host[:port]" jump-host argument; it is not an scp
			// copy endpoint, so it must not be counted as an external remote (which
			// would wrongly trip the mixed-port error on a non-default sandbox
			// port). But scp's -o host-key policy is global, so it would relax the
			// jump host to trust-on-first-use too — hence accept-new is suppressed
			// while -P (which the jump host self-ports past) is still injected.
			name: "jump host suppresses host-key policy but keeps sandbox port",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"-J", "bastion:22", "./a", "mybox:/x"}},
			dest: ported,
			want: []string{"-P", "2222", "-J", "bastion:22", "./a", "u@host.example:/x"},
		},
		{
			// The -o ProxyJump form is detected the same way as -J.
			name: "proxyjump option suppresses host-key policy",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"-o", "ProxyJump=bastion", "./a", "mybox:/x"}},
			dest: daytona,
			want: []string{"-o", "ProxyJump=bastion", "./a", "user-token@ssh.app.daytona.io:/x"},
		},
		{
			// ssh options the server puts in the destination (identity, config,
			// -o settings) are forwarded to scp when the sandbox is the sole
			// remote, so scp connects with the same credentials/routing as ssh.
			name: "sandbox ssh options are forwarded when sandbox is sole remote",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"./a", "mybox:/b"}},
			dest: ssh.Destination{User: "u", Host: "h", Options: []string{"-i", "/tmp/key", "-o", "Compression=yes"}},
			want: []string{"-o", "StrictHostKeyChecking=accept-new", "-i", "/tmp/key", "-o", "Compression=yes", "./a", "u@h:/b"},
		},
		{
			// Those options are global to the scp invocation, so a mixed copy
			// that also touches an external host cannot scope them to the
			// sandbox; the copy is rejected instead of misrouting the external.
			name:    "sandbox ssh options cannot be scoped in a mixed copy",
			plan:    scpPlan{sandbox: "mybox", scpArgv: []string{"mybox:/b", "scp://host/c"}},
			dest:    ssh.Destination{User: "u", Host: "h", Options: []string{"-i", "/tmp/key"}},
			wantErr: "cannot scope",
		},
		{
			// ssh's -W has no scp equivalent, so forwarding it would fail; reject
			// with a clear pointer to `sandbox ssh` instead.
			name:    "ssh-only option is rejected before forwarding to scp",
			plan:    scpPlan{sandbox: "mybox", scpArgv: []string{"./a", "mybox:/b"}},
			dest:    ssh.Destination{User: "u", Host: "h", Options: []string{"-W", "jump:22"}},
			wantErr: "scp does not support",
		},
		{
			// ssh's -P (connection tag) collides with scp's -P (port), so it must
			// not be forwarded even though the letter is shared.
			name:    "ssh -P tag is not forwarded as an scp port",
			plan:    scpPlan{sandbox: "mybox", scpArgv: []string{"./a", "mybox:/b"}},
			dest:    ssh.Destination{User: "u", Host: "h", Options: []string{"-P", "connlabel"}},
			wantErr: "scp does not support",
		},
		{
			// scp stops treating dash tokens as options once operands begin, so a
			// source named "-P" is a file, not the port flag, and the sandbox
			// target after it is still rewritten.
			name: "dash operand after a source is not an option",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"file", "-P", "mybox:/dst"}},
			dest: daytona,
			want: []string{"-o", "StrictHostKeyChecking=accept-new", "file", "-P", "user-token@ssh.app.daytona.io:/dst"},
		},
		{
			// "--" ends option parsing; it is forwarded so scp also stops there,
			// and the following dash token is a file operand.
			name: "double dash ends option parsing",
			plan: scpPlan{sandbox: "mybox", scpArgv: []string{"--", "-P", "mybox:/dst"}},
			dest: daytona,
			want: []string{"-o", "StrictHostKeyChecking=accept-new", "--", "-P", "user-token@ssh.app.daytona.io:/dst"},
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

func TestBuildSCPInvocationPerEndpointPorts(t *testing.T) {
	// A sandbox and an external URI on different explicit ports no longer
	// conflict: the sandbox takes the global -P and the URI self-ports.
	plan := scpPlan{sandbox: "mybox", scpArgv: []string{"mybox:/a", "scp://host:2222/b"}}
	dest := ssh.Destination{User: "u", Host: "h", Port: 2200}
	got, err := buildSCPInvocation(plan, fixedDest(dest))
	if err != nil {
		t.Fatalf("buildSCPInvocation() unexpected error = %v", err)
	}
	want := []string{"-P", "2200", "u@h:/a", "scp://host:2222//b"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("buildSCPInvocation()\n got = %#v\nwant = %#v", got, want)
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
		// A "#" in the path is a literal path character, not a URL fragment.
		{raw: "sbox://mybox/tmp/report#2.txt", wantName: "mybox", wantPath: "/tmp/report#2.txt"},
		{raw: "sbox:///no-host", wantErr: true},
		{raw: "sbox://mybox:2222/x", wantErr: true},
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
		raw         string
		wantOperand string
		wantHasPort bool
		wantErr     bool
	}{
		// A ported URI becomes a self-porting scp:// operand; the path is
		// doubled behind the authority so scp resolves the same absolute path.
		{raw: "scp://user@host:2222/tmp/x", wantOperand: "scp://user@host:2222//tmp/x", wantHasPort: true},
		// A literal "%" (typed as %25) survives round-trip: scp re-decodes it once.
		{raw: "scp://host:2222/tmp/50%25off.pdf", wantOperand: "scp://host:2222//tmp/50%25off.pdf", wantHasPort: true},
		// "@" in the path is encoded so scp does not read it as userinfo.
		{raw: "scp://user@host:2222/tmp/build@2", wantOperand: "scp://user@host:2222//tmp/build%402", wantHasPort: true},
		// "?"/"#" are literal path characters, not query/fragment: preserved for
		// the portless form and re-encoded for the self-porting form.
		{raw: "scp://host/a?b", wantOperand: "host:/a?b"},
		{raw: "scp://host:2222/a#b", wantOperand: "scp://host:2222//a%23b", wantHasPort: true},
		{raw: "scp://host/tmp/x", wantOperand: "host:/tmp/x"},
		{raw: "scp://host", wantOperand: "host:"},
		// An IPv6 literal keeps its brackets in both forms so scp does not misread
		// it as a "host:port" or an unbracketed URI host.
		{raw: "scp://[::1]:2222/tmp/x", wantOperand: "scp://[::1]:2222//tmp/x", wantHasPort: true},
		{raw: "scp://user@[2001:db8::1]:22/data", wantOperand: "scp://user@[2001:db8::1]:22//data", wantHasPort: true},
		{raw: "scp://[::1]/tmp/x", wantOperand: "[::1]:/tmp/x"},
		{raw: "scp://host:notaport/x", wantErr: true},
		// A malformed percent-escape in the path is rejected.
		{raw: "scp://host/tmp/50%off", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			operand, hasPort, err := parseSCPURI(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseSCPURI(%q) expected error", tt.raw)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseSCPURI(%q) error = %v", tt.raw, err)
			}
			if operand != tt.wantOperand || hasPort != tt.wantHasPort {
				t.Errorf("parseSCPURI(%q) = (%q, %v), want (%q, %v)", tt.raw, operand, hasPort, tt.wantOperand, tt.wantHasPort)
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

func TestConsumesNextArg(t *testing.T) {
	tests := []struct {
		tok  string
		want bool
	}{
		{tok: "-J", want: true},                // jump host takes next token
		{tok: "-i", want: true},                // identity file
		{tok: "-o", want: true},                // ssh option
		{tok: "-P", want: true},                // port
		{tok: "-rP", want: true},               // bundled; trailing P takes next token
		{tok: "-oProxyCommand=x", want: false}, // value attached
		{tok: "-P2222", want: false},           // value attached
		{tok: "-r", want: false},               // boolean flag
		{tok: "-4", want: false},               // boolean flag
		{tok: "-rv", want: false},              // bundled booleans
		{tok: "host:/path", want: false},       // operand
		{tok: "./local", want: false},          // operand
		{tok: "-", want: false},                // stdin/stdout operand
		{tok: "--", want: false},               // end-of-options marker
	}
	for _, tt := range tests {
		t.Run(tt.tok, func(t *testing.T) {
			if got := consumesNextArg(tt.tok); got != tt.want {
				t.Errorf("consumesNextArg(%q) = %v, want %v", tt.tok, got, tt.want)
			}
		})
	}
}

func TestHasHelpFlag(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want bool
	}{
		{name: "bare -h", args: []string{"-h"}, want: true},
		{name: "bare --help", args: []string{"--help"}, want: true},
		{name: "help after leading amika flag", args: []string{"--print", "-h"}, want: true},
		{name: "no help", args: []string{"mybox", "./a", "mybox:/b"}},
		{name: "-h as a file operand is not help", args: []string{"mybox", "-h", "mybox:/b"}},
		{name: "--help after the sandbox name is not help", args: []string{"mybox", "./a", "--help"}},
		{name: "-h after -- is a file operand", args: []string{"--", "-h"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := hasHelpFlag(tt.args); got != tt.want {
				t.Errorf("hasHelpFlag(%#v) = %v, want %v", tt.args, got, tt.want)
			}
		})
	}
}

func TestScanUserOptions(t *testing.T) {
	tests := []struct {
		name       string
		argv       []string
		wantPort   bool
		wantStrict bool
		wantJump   bool
	}{
		{name: "no options", argv: []string{"./a", "mybox:/b"}},
		{name: "explicit -P", argv: []string{"-P", "2222", "./a", "mybox:/b"}, wantPort: true},
		{name: "attached -P", argv: []string{"-P2222", "./a", "mybox:/b"}, wantPort: true},
		{name: "bundled -rP", argv: []string{"-rP", "2222", "./a", "mybox:/b"}, wantPort: true},
		{name: "-o Port pair", argv: []string{"-o", "Port=2222", "./a", "mybox:/b"}, wantPort: true},
		{name: "-o Port space form", argv: []string{"-o", "Port 2222", "./a", "mybox:/b"}, wantPort: true},
		{name: "-o StrictHostKeyChecking pair", argv: []string{"-o", "StrictHostKeyChecking=yes", "./a", "mybox:/b"}, wantStrict: true},
		{name: "-o StrictHostKeyChecking space form", argv: []string{"-o", "StrictHostKeyChecking yes", "./a", "mybox:/b"}, wantStrict: true},
		{name: "attached -oStrictHostKeyChecking", argv: []string{"-oStrictHostKeyChecking=no", "./a"}, wantStrict: true},
		{name: "lowercase -p is preserve not port", argv: []string{"-p", "./a", "mybox:/b"}},
		{name: "path containing StrictHostKeyChecking is not an option", argv: []string{"./StrictHostKeyChecking.bak", "mybox:/b"}},
		{name: "path containing P is not a port flag", argv: []string{"./PATH", "mybox:/b"}},
		{name: "-P after an operand is a file, not the port flag", argv: []string{"file", "-P", "mybox:/b"}},
		{name: "-P after -- is a file, not the port flag", argv: []string{"--", "-P", "mybox:/b"}},
		{name: "option argument is not mistaken for an operand", argv: []string{"-J", "bastion:22", "-P", "2222", "./a", "mybox:/b"}, wantPort: true, wantJump: true},
		{name: "-o value is skipped before scanning continues", argv: []string{"-o", "Compression=yes", "-P", "2222", "./a"}, wantPort: true},
		{name: "-J jump host detected", argv: []string{"-J", "bastion:22", "./a", "mybox:/b"}, wantJump: true},
		{name: "attached -J jump host detected", argv: []string{"-Jbastion", "./a", "mybox:/b"}, wantJump: true},
		{name: "bundled -rJ jump host detected", argv: []string{"-rJ", "bastion", "./a", "mybox:/b"}, wantJump: true},
		{name: "-o ProxyJump detected", argv: []string{"-o", "ProxyJump=bastion", "./a", "mybox:/b"}, wantJump: true},
		{name: "attached -oProxyJump detected", argv: []string{"-oProxyJump=bastion", "./a", "mybox:/b"}, wantJump: true},
		{name: "-J after an operand is a file, not a jump host", argv: []string{"file", "-J", "mybox:/b"}},
		// An arg-taking option's attached value must not be scanned for P/J: a
		// capital letter in an identity path is not the port or jump-host flag.
		{name: "capital P in attached identity path is not a port", argv: []string{"-i/home/user/Projects/id", "./a", "mybox:/b"}},
		{name: "capital J in attached identity path is not a jump host", argv: []string{"-i/home/me/Jump/key", "./a", "mybox:/b"}},
		{name: "attached -Jhost is still a jump host", argv: []string{"-Jbastion", "./a", "mybox:/b"}, wantJump: true},
		{name: "attached -P2222 is still a port", argv: []string{"-P2222", "./a", "mybox:/b"}, wantPort: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotPort, gotStrict, gotJump := scanUserOptions(tt.argv)
			if gotPort != tt.wantPort || gotStrict != tt.wantStrict || gotJump != tt.wantJump {
				t.Errorf("scanUserOptions(%#v) = (port=%v, strict=%v, jump=%v), want (port=%v, strict=%v, jump=%v)",
					tt.argv, gotPort, gotStrict, gotJump, tt.wantPort, tt.wantStrict, tt.wantJump)
			}
		})
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
