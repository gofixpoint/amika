package scpcmd

import (
	"reflect"
	"strings"
	"testing"
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

func TestRunSCPRejectsOutputLongFlag(t *testing.T) {
	cmd := NewV2()
	// The long-form --output is rejected before any resolution/exec, so this
	// makes no network call. The short -o is scp's own option and must NOT be
	// rejected here (it is exercised as pass-through elsewhere).
	err := runSCPV2(cmd, []string{"--output", "json", "a", "b"})
	if err == nil {
		t.Fatal("expected --output to be rejected for scp")
	}
	if !strings.Contains(err.Error(), "--output flag is not supported") {
		t.Fatalf("expected unsupported-flag error, got: %v", err)
	}
}

func TestSCPCommandRegistered(t *testing.T) {
	cmd := NewV2()
	if cmd.Name() != "scp" {
		t.Errorf("command name = %q, want %q", cmd.Name(), "scp")
	}
	if cmd.Hidden {
		t.Error("scp is the supported copy command and must not be hidden")
	}
	if !cmd.DisableFlagParsing {
		t.Error("scp command must disable flag parsing to forward scp flags verbatim")
	}
	// "scpv2" is the pre-promotion name; kept as an alias so existing scripts
	// keep working.
	if want := []string{"scpv2"}; !reflect.DeepEqual(cmd.Aliases, want) {
		t.Errorf("Aliases = %#v, want %#v", cmd.Aliases, want)
	}
}

// TestSCPV1CommandRegistered pins the superseded command's contract: it keeps
// working under its new name, and it stays out of the help listing.
