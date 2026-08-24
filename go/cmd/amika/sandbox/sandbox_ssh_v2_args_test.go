package sandboxcmd

// sandbox_ssh_v2_args_test.go covers how `amika sandbox ssh` divides a
// command line between amika and the system ssh binary. The assertions are on
// the argv the command would exec, which is the whole contract: an argument
// written after the "ssh" subcommand reaches the ssh binary untouched and in
// its original position, and one written before it does not reach ssh at all.

import (
	"bytes"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

const testV2Alias = "my-box.sb_abc.app-amika-dev.amika"

// sshV2Harness drives the real `sandbox ssh` command (the v2 direct-WebSocket
// transport) with every outward call replaced, and records the argv that would
// have been handed to ssh.
type sshV2Harness struct {
	argv  []string
	alias string
	ran   bool
}

// sandboxSSHV2Cmd is a package-level singleton and New() may be called only
// once per process, so the tests hang a minimal amika/sandbox tree around the
// real command object instead, built once and reused.
var (
	sshV2TreeOnce sync.Once
	sshV2Root     *cobra.Command
	sshV2Parent   *cobra.Command
)

func sshV2TestTree() (*cobra.Command, *cobra.Command) {
	sshV2TreeOnce.Do(func() {
		sshV2Root = &cobra.Command{Use: "amika", SilenceUsage: true, SilenceErrors: true}
		sshV2Root.PersistentFlags().StringP("output", "o", "text", "output format")
		sshV2Parent = &cobra.Command{Use: "sandbox"}
		sshV2Parent.PersistentFlags().Bool("local", false, "Only operate on local sandboxes")
		sshV2Parent.PersistentFlags().Bool("remote", false, "Only operate on remote sandboxes")
		sshV2Parent.PersistentFlags().String("remote-target", "", "Operate on a specific named remote target")
		sshV2Root.AddCommand(sshV2Parent)
	})
	return sshV2Root, sshV2Parent
}

// newSSHV2Harness wires the seams for one invocation and returns the shared
// tree, so Cobra's routing and flag inheritance are exercised rather than
// simulated.
func newSSHV2Harness(t *testing.T, procArgs []string) (*cobra.Command, *sshV2Harness, *bytes.Buffer) {
	t.Helper()
	h := &sshV2Harness{}

	// AMIKA_API_KEY short-circuits RequireAuth, so the command reaches the
	// argv-building step without a login.
	t.Setenv("AMIKA_API_KEY", "test-key")

	prevArgs, prevExec, prevClient, prevPrepare := osArgs, execSessionSSH, newSSHV2Client, prepareSessionTarget
	osArgs = func() []string { return procArgs }
	execSessionSSH = func(alias string, argv []string) error {
		h.ran, h.alias, h.argv = true, alias, argv
		return nil
	}
	newSSHV2Client = func(string) (sshV2Client, error) {
		return &stubV2SSHClient{sandbox: &apiclient.RemoteSandbox{Name: "my-box", ID: "sb_abc"}}, nil
	}
	prepareSessionTarget = func(basedir.Paths, ssh.SessionCreator, string, string) (string, error) {
		return testV2Alias, nil
	}
	t.Cleanup(func() {
		osArgs, execSessionSSH, newSSHV2Client, prepareSessionTarget = prevArgs, prevExec, prevClient, prevPrepare
	})

	root, parent := sshV2TestTree()
	// Another test in this package calls New(), which re-parents the shared
	// command; reattach it here so the tree is whatever this test expects.
	if sandboxSSHV2Cmd.Parent() != parent {
		parent.AddCommand(sandboxSSHV2Cmd)
	}
	// Force Cobra's persistent-flag merge, then clear what a previous Execute
	// left behind: Cobra never resets flag values or their Changed state. Both
	// the command's parse and its reads go through Flags(), so resetting there
	// is what the command actually observes.
	_ = sandboxSSHV2Cmd.InheritedFlags()
	for _, name := range []string{"local", "remote", "remote-target", "output"} {
		resetSSHV2Flag(t, sandboxSSHV2Cmd.Flags().Lookup(name))
	}

	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(out)
	// procArgs carries the binary path at index 0; Cobra wants only the rest.
	root.SetArgs(procArgs[1:])
	return root, h, out
}

// resetSSHV2Flag restores a flag to its declared default and clears Changed.
func resetSSHV2Flag(t *testing.T, f *pflag.Flag) {
	t.Helper()
	if f == nil {
		return
	}
	if err := f.Value.Set(f.DefValue); err != nil {
		t.Fatalf("reset flag %q: %v", f.Name, err)
	}
	f.Changed = false
}

func TestSSHV2ForwardsArgsToSSH(t *testing.T) {
	tests := []struct {
		name     string
		procArgs []string
		wantArgv []string
	}{
		{
			name:     "bare name becomes the alias",
			procArgs: []string{"amika", "sandbox", "ssh", "my-box"},
			wantArgv: []string{testV2Alias},
		},
		{
			// The point of the change: -L reaches ssh ahead of the destination,
			// where ssh reads it as a client option.
			name:     "local port forward",
			procArgs: []string{"amika", "sandbox", "ssh", "-N", "-L", "6789:localhost:3010", "my-box"},
			wantArgv: []string{"-N", "-L", "6789:localhost:3010", testV2Alias},
		},
		{
			name:     "dynamic port forward",
			procArgs: []string{"amika", "sandbox", "ssh", "-N", "-D", "1080", "my-box"},
			wantArgv: []string{"-N", "-D", "1080", testV2Alias},
		},
		{
			name:     "ssh config option with a separate value",
			procArgs: []string{"amika", "sandbox", "ssh", "-o", "BatchMode=yes", "my-box"},
			wantArgv: []string{"-o", "BatchMode=yes", testV2Alias},
		},
		{
			// -t no longer belongs to amika; it passes through to ssh.
			name:     "force pty",
			procArgs: []string{"amika", "sandbox", "ssh", "-t", "my-box", "top"},
			wantArgv: []string{"-t", testV2Alias, "top"},
		},
		{
			name:     "remote command stays after the destination",
			procArgs: []string{"amika", "sandbox", "ssh", "my-box", "uptime"},
			wantArgv: []string{testV2Alias, "uptime"},
		},
		{
			name:     "options and a remote command",
			procArgs: []string{"amika", "sandbox", "ssh", "-L", "6789:localhost:3010", "my-box", "ls", "-la"},
			wantArgv: []string{"-L", "6789:localhost:3010", testV2Alias, "ls", "-la"},
		},
		{
			// An amika flag before the subcommand is consumed by amika.
			name:     "sandbox flag before the subcommand is not forwarded",
			procArgs: []string{"amika", "sandbox", "--remote", "ssh", "-N", "my-box"},
			wantArgv: []string{"-N", testV2Alias},
		},
		{
			// The same spelling after the subcommand belongs to ssh, which is
			// what makes the rule positional rather than name-based.
			name:     "output flag after the subcommand is forwarded",
			procArgs: []string{"amika", "sandbox", "ssh", "-o", "SendEnv=FOO", "my-box"},
			wantArgv: []string{"-o", "SendEnv=FOO", testV2Alias},
		},
		{
			name:     "end of options marker before the name",
			procArgs: []string{"amika", "sandbox", "ssh", "--", "my-box"},
			wantArgv: []string{"--", testV2Alias},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root, h, out := newSSHV2Harness(t, tt.procArgs)
			if err := root.Execute(); err != nil {
				t.Fatalf("Execute: %v (output %q)", err, out.String())
			}
			if !h.ran {
				t.Fatal("ssh was never invoked")
			}
			if h.alias != testV2Alias {
				t.Errorf("alias = %q, want %q", h.alias, testV2Alias)
			}
			if !reflect.DeepEqual(h.argv, tt.wantArgv) {
				t.Errorf("ssh argv = %#v, want %#v", h.argv, tt.wantArgv)
			}
		})
	}
}

// TestSSHV2AliasForwardsArgsToSSH pins the "sshv2" alias to the same
// positional-split contract as "ssh": the split must key off the token
// actually typed (via cmd.CalledAs()), not the command's primary name, or an
// amika flag written before the alias would wrongly be forwarded to ssh.
func TestSSHV2AliasForwardsArgsToSSH(t *testing.T) {
	root, h, out := newSSHV2Harness(t, []string{"amika", "sandbox", "sshv2", "-N", "-L", "6789:localhost:3010", "my-box"})
	if err := root.Execute(); err != nil {
		t.Fatalf("Execute: %v (output %q)", err, out.String())
	}
	if !h.ran {
		t.Fatal("ssh was never invoked")
	}
	if h.alias != testV2Alias {
		t.Errorf("alias = %q, want %q", h.alias, testV2Alias)
	}
	wantArgv := []string{"-N", "-L", "6789:localhost:3010", testV2Alias}
	if !reflect.DeepEqual(h.argv, wantArgv) {
		t.Errorf("ssh argv = %#v, want %#v", h.argv, wantArgv)
	}
}

func TestSSHV2AmikaFlagsBeforeSubcommand(t *testing.T) {
	t.Run("output flag before the subcommand is rejected, not forwarded", func(t *testing.T) {
		root, h, _ := newSSHV2Harness(t, []string{"amika", "--output", "json", "sandbox", "ssh", "my-box"})
		err := root.Execute()
		if err == nil {
			t.Fatal("expected --output to be rejected")
		}
		if h.ran {
			t.Errorf("ssh ran with argv %#v; --output should never reach it", h.argv)
		}
	})

	t.Run("local flag before the subcommand is honored", func(t *testing.T) {
		root, h, _ := newSSHV2Harness(t, []string{"amika", "sandbox", "--local", "ssh", "my-box"})
		err := root.Execute()
		if err == nil || !strings.Contains(err.Error(), "requires a remote sandbox") {
			t.Fatalf("err = %v, want a remote-sandbox error", err)
		}
		if h.ran {
			t.Error("ssh should not run for a local sandbox")
		}
	})
}

func TestSSHV2MissingName(t *testing.T) {
	root, h, _ := newSSHV2Harness(t, []string{"amika", "sandbox", "ssh", "-N", "-L", "6789:localhost:3010"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "missing sandbox name") {
		t.Fatalf("err = %v, want a missing-name error", err)
	}
	if h.ran {
		t.Error("ssh should not run without a sandbox name")
	}
}

func TestSSHV2Help(t *testing.T) {
	// --help is the documented exception to the forwarding rule, and the help
	// subcommand must reach the same text.
	for _, tt := range []struct {
		name     string
		procArgs []string
	}{
		{name: "help flag after the subcommand", procArgs: []string{"amika", "sandbox", "ssh", "--help"}},
		{name: "short help flag", procArgs: []string{"amika", "sandbox", "ssh", "-h"}},
		{name: "help subcommand", procArgs: []string{"amika", "help", "sandbox", "ssh"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			root, h, out := newSSHV2Harness(t, tt.procArgs)
			if err := root.Execute(); err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if h.ran {
				t.Errorf("ssh ran with argv %#v; --help must not reach it", h.argv)
			}
			got := out.String()
			for _, want := range []string{
				"amika sandbox ssh",
				"Use it like ssh",
				"-L 6789:localhost:3010",
			} {
				if !strings.Contains(got, want) {
					t.Errorf("help output missing %q; got:\n%s", want, got)
				}
			}
		})
	}
}
