package scpcmd

import (
	"reflect"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/ssh"
)

func TestParseSCPArgs(t *testing.T) {
	tests := []struct {
		name      string
		args      []string
		wantArgv  []string
		wantPrint bool
		wantErr   string
	}{
		{
			name:     "basic upload",
			args:     []string{"./a.txt", "mybox:a.txt"},
			wantArgv: []string{"./a.txt", "mybox:a.txt"},
		},
		{
			name:      "print flag before operands",
			args:      []string{"--print", "./a", "mybox:/b"},
			wantArgv:  []string{"./a", "mybox:/b"},
			wantPrint: true,
		},
		{
			name:      "print flag after operands",
			args:      []string{"./a", "mybox:/b", "--print"},
			wantArgv:  []string{"./a", "mybox:/b"},
			wantPrint: true,
		},
		{
			name:     "flags pass through in order",
			args:     []string{"-r", "-l", "100", "mybox:/out", "./out"},
			wantArgv: []string{"-r", "-l", "100", "mybox:/out", "./out"},
		},
		{
			name:    "no operands",
			args:    []string{"--print"},
			wantErr: "missing operands",
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
	acceptNew := []string{"-o", "StrictHostKeyChecking=accept-new"}

	tests := []struct {
		name    string
		argv    []string
		dest    ssh.Destination
		want    []string
		wantErr string
	}{
		{
			// A relative sandbox path resolves under the sandbox home.
			name: "upload local to sandbox relative path",
			argv: []string{"./a.txt", "mybox:my/path"},
			dest: daytona,
			want: append(acceptNew, "./a.txt", "user-token@ssh.app.daytona.io:/home/amika/my/path"),
		},
		{
			// An absolute sandbox path is used verbatim.
			name: "upload local to sandbox absolute path",
			argv: []string{"./a.txt", "mybox:/my/root/path"},
			dest: daytona,
			want: append(acceptNew, "./a.txt", "user-token@ssh.app.daytona.io:/my/root/path"),
		},
		{
			name: "empty sandbox path is the home directory",
			argv: []string{"./a.txt", "mybox:"},
			dest: daytona,
			want: append(acceptNew, "./a.txt", "user-token@ssh.app.daytona.io:/home/amika"),
		},
		{
			// sbox:// paths are absolute.
			name: "sbox uri absolute path",
			argv: []string{"./a.txt", "sbox://mybox/my/root/path"},
			dest: daytona,
			want: append(acceptNew, "./a.txt", "user-token@ssh.app.daytona.io:/my/root/path"),
		},
		{
			// A leading "~" in an sbox:// path expands to the home directory.
			name: "sbox uri tilde expands to home",
			argv: []string{"./a.txt", "sbox://mybox/~/my-file"},
			dest: daytona,
			want: append(acceptNew, "./a.txt", "user-token@ssh.app.daytona.io:/home/amika/my-file"),
		},
		{
			// A percent-encoded "/" in the sbox:// name is decoded to the real name.
			name: "sbox uri percent-encoded name",
			argv: []string{"./a.txt", "sbox://dylan%2Fmy-sandbox/~/f"},
			dest: daytona,
			want: append(acceptNew, "./a.txt", "user-token@ssh.app.daytona.io:/home/amika/f"),
		},
		{
			// A non-default sandbox port is carried inline as a self-porting
			// scp:// URI, so no global -P is needed.
			name: "ported sandbox becomes a self-porting uri",
			argv: []string{"./a", "mybox:/x"},
			dest: ported,
			want: append(acceptNew, "./a", "scp://u@host.example:2222//x"),
		},
		{
			// Sandbox names are resolved wherever they appear: two sandboxes in one
			// copy. No external host, so the host-key policy is still injected.
			name: "two sandboxes in one copy",
			argv: []string{"mybox:/a", "otherbox:/b"},
			dest: daytona,
			want: append(acceptNew, "user-token@ssh.app.daytona.io:/a", "user-token@ssh.app.daytona.io:/b"),
		},
		{
			// An external scp:// host suppresses the host-key policy (scp's global
			// -o would relax it too); the URI self-ports and the sandbox uses its
			// default port.
			name: "sandbox to external scp host",
			argv: []string{"mybox:/data.csv", "scp://user@host:22/tmp/data.csv"},
			dest: daytona,
			want: []string{"user-token@ssh.app.daytona.io:/data.csv", "scp://user@host:22//tmp/data.csv"},
		},
		{
			name:    "all local is an error",
			argv:    []string{"./a", "./b"},
			dest:    daytona,
			wantErr: "no remote source or target",
		},
		{
			name: "user set StrictHostKeyChecking is not overridden",
			argv: []string{"-o", "StrictHostKeyChecking=yes", "./a", "mybox:/x"},
			dest: daytona,
			want: []string{"-o", "StrictHostKeyChecking=yes", "./a", "user-token@ssh.app.daytona.io:/x"},
		},
		{
			// -J routes through a jump host, whose key scp's global -o would relax,
			// so the host-key policy is suppressed.
			name: "user jump host suppresses host-key policy",
			argv: []string{"-J", "bastion:22", "./a", "mybox:/x"},
			dest: daytona,
			want: []string{"-J", "bastion:22", "./a", "user-token@ssh.app.daytona.io:/x"},
		},
		{
			// ssh options the server puts in the destination are forwarded when the
			// sandbox is the sole remote.
			name: "sandbox ssh options forwarded when sole remote",
			argv: []string{"./a", "mybox:/b"},
			dest: ssh.Destination{User: "u", Host: "h", Options: []string{"-i", "/tmp/key", "-o", "Compression=yes"}},
			want: []string{"-o", "StrictHostKeyChecking=accept-new", "-i", "/tmp/key", "-o", "Compression=yes", "./a", "u@h:/b"},
		},
		{
			// A host-key policy set by the server is not overridden by accept-new.
			name: "sandbox destination host-key policy is not overridden",
			argv: []string{"./a", "mybox:/b"},
			dest: ssh.Destination{User: "u", Host: "h", Options: []string{"-o", "StrictHostKeyChecking=yes"}},
			want: []string{"-o", "StrictHostKeyChecking=yes", "./a", "u@h:/b"},
		},
		{
			// A jump host supplied by the server suppresses accept-new too.
			name: "sandbox destination jump host suppresses accept-new",
			argv: []string{"./a", "mybox:/b"},
			dest: ssh.Destination{User: "u", Host: "h", Options: []string{"-J", "bastion"}},
			want: []string{"-J", "bastion", "./a", "u@h:/b"},
		},
		{
			// Sandbox options are global, so a mixed copy that also touches an
			// external host cannot scope them; the copy is rejected.
			name:    "sandbox options cannot be scoped with an external host",
			argv:    []string{"mybox:/b", "scp://host/c"},
			dest:    ssh.Destination{User: "u", Host: "h", Options: []string{"-i", "/tmp/key"}},
			wantErr: "cannot scope",
		},
		{
			// Nor when two sandboxes are involved.
			name:    "sandbox options cannot be scoped across two sandboxes",
			argv:    []string{"mybox:/b", "otherbox:/c"},
			dest:    ssh.Destination{User: "u", Host: "h", Options: []string{"-i", "/tmp/key"}},
			wantErr: "cannot scope",
		},
		{
			// ssh's -W has no scp equivalent, so forwarding it would fail.
			name:    "ssh-only option is rejected",
			argv:    []string{"./a", "mybox:/b"},
			dest:    ssh.Destination{User: "u", Host: "h", Options: []string{"-W", "jump:22"}},
			wantErr: "scp does not support",
		},
		{
			// ssh's -P (connection tag) collides with scp's -P (port).
			name:    "ssh -P tag is not forwarded",
			argv:    []string{"./a", "mybox:/b"},
			dest:    ssh.Destination{User: "u", Host: "h", Options: []string{"-P", "connlabel"}},
			wantErr: "scp does not support",
		},
		{
			// scp stops treating dash tokens as options once operands begin.
			name: "dash operand after a source is not an option",
			argv: []string{"file", "-P", "mybox:/dst"},
			dest: daytona,
			want: append(acceptNew, "file", "-P", "user-token@ssh.app.daytona.io:/dst"),
		},
		{
			name: "double dash ends option parsing",
			argv: []string{"--", "-P", "mybox:/dst"},
			dest: daytona,
			want: append(acceptNew, "--", "-P", "user-token@ssh.app.daytona.io:/dst"),
		},
		{
			// An external IPv6 host keeps its brackets in the self-porting URI.
			name: "external ipv6 host",
			argv: []string{"./a", "scp://[::1]:2222/x"},
			dest: daytona,
			want: []string{"./a", "scp://[::1]:2222//x"},
		},
		{
			name:    "sbox uri password-free scp uri with password is rejected",
			argv:    []string{"./a", "scp://user:pw@host/x"},
			dest:    daytona,
			wantErr: "password",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := buildSCPInvocation(scpPlan{scpArgv: tt.argv}, fixedDest(tt.dest))
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

func TestBuildSCPInvocationResolvesLazily(t *testing.T) {
	called := false
	resolve := func(string) (ssh.Destination, error) {
		called = true
		return ssh.Destination{Host: "h"}, nil
	}
	// Only scp:// remotes: no sandbox destination must be resolved.
	plan := scpPlan{scpArgv: []string{"scp://a/x", "scp://b/y"}}
	if _, err := buildSCPInvocation(plan, resolve); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if called {
		t.Error("sandbox destination was resolved even though no argument referenced a sandbox")
	}
}

func TestBuildSCPInvocationResolvesEachNameOnce(t *testing.T) {
	names := []string{}
	resolve := func(name string) (ssh.Destination, error) {
		names = append(names, name)
		return ssh.Destination{User: "u", Host: "h"}, nil
	}
	// The same sandbox referenced as both source and target resolves once.
	plan := scpPlan{scpArgv: []string{"mybox:/a", "mybox:/b"}}
	if _, err := buildSCPInvocation(plan, resolve); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !reflect.DeepEqual(names, []string{"mybox"}) {
		t.Errorf("resolver calls = %#v, want a single %q", names, "mybox")
	}
}

func TestBuildSCPInvocationDecodesNameBeforeResolving(t *testing.T) {
	var got string
	resolve := func(name string) (ssh.Destination, error) {
		got = name
		return ssh.Destination{User: "u", Host: "h"}, nil
	}
	plan := scpPlan{scpArgv: []string{"./a", "sbox://dylan%2Fmy-sandbox/x"}}
	if _, err := buildSCPInvocation(plan, resolve); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "dylan/my-sandbox" {
		t.Errorf("resolver got name %q, want %q", got, "dylan/my-sandbox")
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
		{raw: "sbox://mybox/~/f", wantName: "mybox", wantPath: "/~/f"},
		// A "/" in the name is percent-encoded and decoded back.
		{raw: "sbox://dylan%2Fmy-sandbox/~/f", wantName: "dylan/my-sandbox", wantPath: "/~/f"},
		// A "#" in the path is a literal path character.
		{raw: "sbox://mybox/tmp/report#2.txt", wantName: "mybox", wantPath: "/tmp/report#2.txt"},
		{raw: "sbox://", wantErr: true},
		// A ':' or space in the decoded name is not allowed.
		{raw: "sbox://a%3Ab/x", wantErr: true},
		{raw: "sbox://a%20b/x", wantErr: true},
		// Malformed percent-encoding.
		{raw: "sbox://bad%zz/x", wantErr: true},
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
		wantErr     bool
	}{
		// A ported URI becomes a self-porting scp:// operand; the path is doubled
		// behind the authority so scp resolves the same absolute path.
		{raw: "scp://user@host:2222/tmp/x", wantOperand: "scp://user@host:2222//tmp/x"},
		// A literal "%" (typed as %25) survives round-trip.
		{raw: "scp://host:2222/tmp/50%25off.pdf", wantOperand: "scp://host:2222//tmp/50%25off.pdf"},
		// "@" in the path is encoded so scp does not read it as userinfo.
		{raw: "scp://user@host:2222/tmp/build@2", wantOperand: "scp://user@host:2222//tmp/build%402"},
		{raw: "scp://host/tmp/x", wantOperand: "host:/tmp/x"},
		{raw: "scp://host", wantOperand: "host:"},
		// An IPv6 literal keeps its brackets in both forms.
		{raw: "scp://[::1]:2222/tmp/x", wantOperand: "scp://[::1]:2222//tmp/x"},
		{raw: "scp://[::1]/tmp/x", wantOperand: "[::1]:/tmp/x"},
		// A password cannot be used by scp.
		{raw: "scp://user:pw@host/x", wantErr: true},
		{raw: "scp://host:notaport/x", wantErr: true},
		// A malformed percent-escape in the path is rejected.
		{raw: "scp://host/tmp/50%off", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			operand, err := parseSCPURI(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseSCPURI(%q) expected error", tt.raw)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseSCPURI(%q) error = %v", tt.raw, err)
			}
			if operand != tt.wantOperand {
				t.Errorf("parseSCPURI(%q) = %q, want %q", tt.raw, operand, tt.wantOperand)
			}
		})
	}
}

func TestResolveSandboxScpPath(t *testing.T) {
	tests := []struct{ in, want string }{
		{"", "/home/amika"},
		{"~", "/home/amika"},
		{"~/x", "/home/amika/x"},
		{"my/path", "/home/amika/my/path"},
		{"/my/root/path", "/my/root/path"},
	}
	for _, tt := range tests {
		if got := resolveSandboxScpPath(tt.in); got != tt.want {
			t.Errorf("resolveSandboxScpPath(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestResolveSandboxURIPath(t *testing.T) {
	tests := []struct{ in, want string }{
		{"", "/home/amika"},
		{"/~", "/home/amika"},
		{"/~/my-file", "/home/amika/my-file"},
		{"/my/root/path", "/my/root/path"},
	}
	for _, tt := range tests {
		if got := resolveSandboxURIPath(tt.in); got != tt.want {
			t.Errorf("resolveSandboxURIPath(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestRenderSandboxOperand(t *testing.T) {
	tests := []struct {
		name string
		dest ssh.Destination
		path string
		want string
	}{
		{name: "default port plain form", dest: ssh.Destination{User: "user-token", Host: "ssh.app.daytona.io"}, path: "/home/amika/x", want: "user-token@ssh.app.daytona.io:/home/amika/x"},
		{name: "explicit port 22 stays plain", dest: ssh.Destination{User: "u", Host: "h", Port: 22}, path: "/x", want: "u@h:/x"},
		{name: "non-default port self-ports", dest: ssh.Destination{User: "u", Host: "host.example", Port: 2222}, path: "/x", want: "scp://u@host.example:2222//x"},
		{name: "no user", dest: ssh.Destination{Host: "h"}, path: "/x", want: "h:/x"},
		{name: "ipv6 host with port", dest: ssh.Destination{Host: "::1", Port: 2222}, path: "/x", want: "scp://[::1]:2222//x"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := renderSandboxOperand(tt.dest, tt.path); got != tt.want {
				t.Errorf("renderSandboxOperand() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSplitSandboxRef(t *testing.T) {
	tests := []struct{ tok, name, path string }{
		{"mybox:/x", "mybox", "/x"},
		{"mybox:rel", "mybox", "rel"},
		{"mybox:", "mybox", ""},
	}
	for _, tt := range tests {
		name, path := splitSandboxRef(tt.tok)
		if name != tt.name || path != tt.path {
			t.Errorf("splitSandboxRef(%q) = (%q, %q), want (%q, %q)", tt.tok, name, path, tt.name, tt.path)
		}
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
		{tok: "-J", want: true},
		{tok: "-i", want: true},
		{tok: "-o", want: true},
		{tok: "-P", want: true},
		{tok: "-rP", want: true},
		{tok: "-oProxyCommand=x", want: false},
		{tok: "-P2222", want: false},
		{tok: "-r", want: false},
		{tok: "-4", want: false},
		{tok: "-rv", want: false},
		{tok: "host:/path", want: false},
		{tok: "./local", want: false},
		{tok: "-", want: false},
		{tok: "--", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.tok, func(t *testing.T) {
			if got := consumesNextArg(tt.tok); got != tt.want {
				t.Errorf("consumesNextArg(%q) = %v, want %v", tt.tok, got, tt.want)
			}
		})
	}
}

func TestScanUserOptions(t *testing.T) {
	tests := []struct {
		name       string
		argv       []string
		wantStrict bool
		wantJump   bool
	}{
		{name: "no options", argv: []string{"./a", "mybox:/b"}},
		{name: "-o StrictHostKeyChecking pair", argv: []string{"-o", "StrictHostKeyChecking=yes", "./a"}, wantStrict: true},
		{name: "-o StrictHostKeyChecking space form", argv: []string{"-o", "StrictHostKeyChecking yes", "./a"}, wantStrict: true},
		{name: "attached -oStrictHostKeyChecking", argv: []string{"-oStrictHostKeyChecking=no", "./a"}, wantStrict: true},
		{name: "path containing StrictHostKeyChecking is not an option", argv: []string{"./StrictHostKeyChecking.bak", "mybox:/b"}},
		{name: "-J jump host", argv: []string{"-J", "bastion:22", "./a"}, wantJump: true},
		{name: "attached -Jhost", argv: []string{"-Jbastion", "./a"}, wantJump: true},
		{name: "bundled -rJ", argv: []string{"-rJ", "bastion", "./a"}, wantJump: true},
		{name: "-o ProxyJump", argv: []string{"-o", "ProxyJump=bastion", "./a"}, wantJump: true},
		{name: "attached -oProxyJump", argv: []string{"-oProxyJump=bastion", "./a"}, wantJump: true},
		{name: "capital J in attached identity path is not a jump host", argv: []string{"-i/home/me/Jump/key", "./a", "mybox:/b"}},
		{name: "-J after an operand is a file", argv: []string{"file", "-J", "mybox:/b"}},
		{name: "port flags are ignored", argv: []string{"-P", "2222", "./a"}},
		{name: "lowercase -p is not tracked", argv: []string{"-p", "./a"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotStrict, gotJump := scanUserOptions(tt.argv)
			if gotStrict != tt.wantStrict || gotJump != tt.wantJump {
				t.Errorf("scanUserOptions(%#v) = (strict=%v, jump=%v), want (strict=%v, jump=%v)",
					tt.argv, gotStrict, gotJump, tt.wantStrict, tt.wantJump)
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
		{name: "help after leading flag", args: []string{"--print", "-h"}, want: true},
		{name: "no help", args: []string{"./a", "mybox:/b"}},
		{name: "-h as a file operand is not help", args: []string{"file", "-h", "mybox:/b"}},
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

func TestSCPCommandRegistered(t *testing.T) {
	cmd := New()
	if cmd.Name() != "scp" {
		t.Errorf("command name = %q, want %q", cmd.Name(), "scp")
	}
	if !cmd.DisableFlagParsing {
		t.Error("scp command must disable flag parsing to forward scp flags verbatim")
	}
	if cmd.Flags().Lookup("print") == nil {
		t.Error("scp command must define --print")
	}
}
