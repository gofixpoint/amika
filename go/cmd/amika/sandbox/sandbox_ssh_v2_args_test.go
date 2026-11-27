package sandboxcmd

// sandbox_ssh_v2_args_test.go covers how `amika sandbox ssh` divides a
// command line between amika and the system ssh binary. The assertions are on
// the argv the command would exec, which is the whole contract: an argument
// written after the "ssh" subcommand reaches the ssh binary untouched and in
// its original position, and one written before it does not reach ssh at all.

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gofixpoint/amika/go/internal/amikanet"
	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/filelock"
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
	// creator is what prepareSessionTarget received, and client the API
	// client behind it.
	creator ssh.SessionCreator
	client  *stubV2SSHClient
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
		sshV2Parent.PersistentFlags().Bool("remote", true, "Operate on remote rigs; accepted as a no-op since rigs are always remote")
		sshV2Parent.PersistentFlags().String("remote-target", "", "Operate on a specific named remote target")
		// Mirrors the real tree's hidden registration of the retired --local.
		sshV2Parent.PersistentFlags().Bool("local", false, "Removed; rigs are always remote")
		sshV2Parent.PersistentFlags().MarkHidden("local")
		sshV2Parent.PersistentFlags().Bool("new-device-key", false, "Replace the device key")
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
	t.Setenv("AMIKA_NET_AGENT_DIR", filepath.Join(t.TempDir(), "agent"))

	prevArgs, prevExec, prevClient, prevPrepare := osArgs, execSessionSSH, newSSHV2Client, prepareSessionTarget
	osArgs = func() []string { return procArgs }
	execSessionSSH = func(alias string, argv []string) error {
		h.ran, h.alias, h.argv = true, alias, argv
		return nil
	}
	h.client = &stubV2SSHClient{sandbox: &apiclient.RemoteSandbox{Name: "my-box", ID: "sb_abc"}}
	newSSHV2Client = func(string) (sshV2Client, error) { return h.client, nil }
	prepareSessionTarget = func(_ basedir.Paths, creator ssh.SessionCreator, _, _ string) (string, error) {
		h.creator = creator
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
	for _, name := range []string{"local", "remote", "remote-target", "output", "transport", "new-device-key"} {
		resetSSHV2Flag(t, sandboxSSHV2Cmd.Flags().Lookup(name))
	}

	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(out)
	// procArgs carries the binary path at index 0; Cobra wants only the rest.
	root.SetArgs(procArgs[1:])
	return root, h, out
}

func TestSSHV2VerbosePassesToTheProxy(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AMIKA_BINARY_PATH", binary)
	for _, option := range []string{"-v", "-Nvvv"} {
		root, h, _ := newSSHV2Harness(t, []string{"amika", "sandbox", "ssh", option, "my-box"})
		if err := root.Execute(); err != nil {
			t.Fatal(err)
		}
		want := []string{"-o", "ProxyCommand=" + binary + " plumbing ssh-stdio-proxy --verbose %h", option, testV2Alias}
		if !reflect.DeepEqual(h.argv, want) {
			t.Fatalf("ssh argv = %q, want %q", h.argv, want)
		}
	}
}

func TestSSHV2NewDeviceKeyIsExplicit(t *testing.T) {
	previous, previousStop := makeNewDeviceKey, stopDeviceAgent
	t.Cleanup(func() { makeNewDeviceKey, stopDeviceAgent = previous, previousStop })
	calls := 0
	var steps []string
	stopDeviceAgent = func(context.Context) error { steps = append(steps, "stop"); return nil }
	makeNewDeviceKey = func(io.Writer) error { calls++; steps = append(steps, "replace"); return nil }
	for _, replace := range []bool{false, true} {
		args := []string{"amika", "sandbox"}
		if replace {
			args = append(args, "--new-device-key")
		}
		args = append(args, "ssh", "my-box")
		root, h, _ := newSSHV2Harness(t, args)
		if err := root.Execute(); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(h.argv, []string{testV2Alias}) {
			t.Fatalf("ssh argv = %q", h.argv)
		}
		wantCalls := 0
		if replace {
			wantCalls = 1
		}
		if calls != wantCalls {
			t.Fatalf("key replacements = %d, want %d", calls, wantCalls)
		}
	}
	if !reflect.DeepEqual(steps, []string{"stop", "replace"}) {
		t.Fatalf("key replacement steps = %q", steps)
	}
}

func TestSSHV2LeavesTheKeyWhenTheAgentCannotStop(t *testing.T) {
	previous, previousStop := makeNewDeviceKey, stopDeviceAgent
	t.Cleanup(func() { makeNewDeviceKey, stopDeviceAgent = previous, previousStop })
	stopErr := errors.New("agent did not stop")
	stopDeviceAgent = func(context.Context) error { return stopErr }
	makeNewDeviceKey = func(io.Writer) error { t.Fatal("replaced the key after agent stop failed"); return nil }
	root, h, _ := newSSHV2Harness(t, []string{"amika", "sandbox", "--new-device-key", "ssh", "my-box"})
	if err := root.Execute(); !errors.Is(err, stopErr) || h.ran {
		t.Fatalf("err = %v, ran SSH = %v", err, h.ran)
	}
}

func TestStopDeviceAgent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no agent role")
	}
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	argv := filepath.Join(dir, "argv")
	t.Setenv("TEST_AGENT_ARGV", argv)
	binary := filepath.Join(dir, "amika-net")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$TEST_AGENT_ARGV\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := stopDeviceAgent(context.Background()); err != nil {
		t.Fatal(err)
	}
	args, err := os.ReadFile(argv)
	if err != nil || string(args) != "agent\nstop\n" {
		t.Fatalf("agent argv = %q, err = %v", args, err)
	}
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 7\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := stopDeviceAgent(context.Background()); err == nil {
		t.Fatal("ignored an agent stop failure")
	}
	if err := os.Remove(binary); err != nil {
		t.Fatal(err)
	}
	if err := stopDeviceAgent(context.Background()); err != nil {
		t.Fatalf("a missing amika-net should leave the new key ready for later: %v", err)
	}
}

func TestReplaceDeviceKeyExcludesConcurrentAgentStartup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no agent")
	}
	dir := t.TempDir()
	t.Setenv("AMIKA_NET_AGENT_DIR", filepath.Join(dir, "agent"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "config"))
	keyFile, err := amikanet.DeviceKeyFile(basedir.New(""))
	if err != nil {
		t.Fatal(err)
	}
	old, err := amikanet.LoadOrCreateDeviceKey(keyFile)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	seen := make(chan string, 1)
	previous := stopDeviceAgent
	t.Cleanup(func() { stopDeviceAgent = previous })
	stopDeviceAgent = func(context.Context) error {
		lockPath := filepath.Join(dir, "agent", "agent.lock")
		competingCtx, competingCancel := context.WithTimeout(ctx, 50*time.Millisecond)
		defer competingCancel()
		lock, err := filelock.Acquire(competingCtx, lockPath)
		if err == nil {
			_ = lock.Close()
			return errors.New("agent startup entered the key replacement gap")
		}
		if !errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		go func() {
			lock, err := filelock.Acquire(ctx, lockPath)
			if err != nil {
				seen <- "lock failed"
				return
			}
			defer lock.Close()
			key, err := amikanet.LoadOrCreateDeviceKey(keyFile)
			if err != nil {
				seen <- "key load failed"
				return
			}
			seen <- amikanet.EndpointID(key)
		}()
		return nil
	}
	if err := replaceDeviceKey(ctx, io.Discard); err != nil {
		t.Fatal(err)
	}
	current, err := amikanet.LoadOrCreateDeviceKey(keyFile)
	if err != nil || current.Equal(old) {
		t.Fatal("the device key was not replaced")
	}
	select {
	case endpoint := <-seen:
		if endpoint != amikanet.EndpointID(current) {
			t.Fatal("the concurrent agent did not load the replacement key")
		}
	case <-ctx.Done():
		t.Fatal("the agent-start lock was not released after replacement")
	}
}

func TestReplaceDeviceKeyBoundsItsLockWait(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no agent")
	}
	dir := filepath.Join(t.TempDir(), "agent")
	t.Setenv("AMIKA_NET_AGENT_DIR", dir)
	if err := ensurePrivateAgentDir(dir); err != nil {
		t.Fatal(err)
	}
	lock, err := filelock.Acquire(context.Background(), filepath.Join(dir, "agent.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	previous, previousStop := makeNewDeviceKey, stopDeviceAgent
	t.Cleanup(func() { makeNewDeviceKey, stopDeviceAgent = previous, previousStop })
	stopDeviceAgent = func(context.Context) error { t.Fatal("stopped the agent without the lock"); return nil }
	makeNewDeviceKey = func(io.Writer) error { t.Fatal("replaced the key without the lock"); return nil }
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := replaceDeviceKey(ctx, io.Discard); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lock wait error = %v", err)
	}
}

func TestDeviceAgentDirectorySelection(t *testing.T) {
	for _, tc := range []struct {
		env  map[string]string
		want string
	}{
		{map[string]string{"AMIKA_NET_AGENT_DIR": "agent", "XDG_RUNTIME_DIR": "/run/u"}, "agent"},
		{map[string]string{"AMIKA_NET_AGENT_DIR": ""}, "."},
		{map[string]string{"XDG_RUNTIME_DIR": "/run/u", "XDG_CACHE_HOME": "/cache"}, filepath.Join("/run/u", "amika-net")},
		{map[string]string{"XDG_RUNTIME_DIR": "", "XDG_CACHE_HOME": "/cache", "HOME": "/home/u"}, filepath.Join("/cache", "amika", "amika-net")},
		{map[string]string{"XDG_CACHE_HOME": "", "HOME": "/home/u"}, filepath.Join("/home/u", ".cache", "amika", "amika-net")},
	} {
		got, err := deviceAgentDir(func(key string) (string, bool) { v, set := tc.env[key]; return v, set })
		want, _ := filepath.Abs(tc.want)
		absolute, _ := filepath.Abs(got)
		if err != nil || absolute != want {
			t.Fatalf("env = %v: directory = %q, err = %v, want %q", tc.env, got, err, want)
		}
	}
	if _, err := deviceAgentDir(func(string) (string, bool) { return "", false }); err == nil {
		t.Fatal("accepted an unset HOME without another agent directory")
	}
}

func TestAgentDirectoryMustBePrivateAndOwned(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no agent")
	}
	dir := t.TempDir()
	private := filepath.Join(dir, "private")
	if err := ensurePrivateAgentDir(private); err != nil {
		t.Fatal(err)
	}
	shared := filepath.Join(dir, "shared")
	if err := os.Mkdir(shared, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := ensurePrivateAgentDir(shared); err == nil {
		t.Fatal("accepted an agent directory another user can open")
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(private, link); err != nil {
		t.Fatal(err)
	}
	if err := ensurePrivateAgentDir(link); err == nil {
		t.Fatal("accepted a symlink as the agent directory")
	}
	if os.Geteuid() != 0 {
		root, err := os.Stat("/")
		if err != nil {
			t.Fatal(err)
		}
		if err := checkAgentDirectoryOwner("/", root); err == nil {
			t.Fatal("accepted an agent directory owned by root")
		}
	}
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
}

// `ssh` sets DisableFlagParsing, so the root's PersistentPreRunE runs before
// --local has been parsed and cannot catch it there. Both positions have to be
// rejected by the command itself: before the subcommand it lands in the
// amika-owned half, and after it would otherwise be forwarded to ssh verbatim.
func TestSSHV2RejectsRemovedLocalFlag(t *testing.T) {
	for _, tt := range []struct {
		name string
		args []string
	}{
		{name: "before the subcommand", args: []string{"amika", "sandbox", "--local", "ssh", "my-box"}},
		{name: "after the subcommand", args: []string{"amika", "sandbox", "ssh", "--local", "my-box"}},
		{name: "with an explicit value", args: []string{"amika", "sandbox", "--local=false", "ssh", "my-box"}},
		{name: "among ssh options", args: []string{"amika", "sandbox", "ssh", "-t", "--local", "my-box"}},
		// With no rig name there is no remote command to protect, and the
		// retired flag is the more useful of the two things wrong here.
		{name: "with no rig name at all", args: []string{"amika", "sandbox", "ssh", "--local"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			root, h, _ := newSSHV2Harness(t, tt.args)
			err := root.Execute()
			if err == nil || !strings.Contains(err.Error(), "--local has been removed") {
				t.Fatalf("err = %v, want the --local removal message", err)
			}
			if h.ran {
				t.Errorf("ssh ran with argv %#v; --local should never reach it", h.argv)
			}
		})
	}
}

func TestSSHV2MissingName(t *testing.T) {
	root, h, _ := newSSHV2Harness(t, []string{"amika", "sandbox", "ssh", "-N", "-L", "6789:localhost:3010"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "missing rig") {
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

// Only the options ahead of the sandbox name are amika's to reject. Everything
// from the name onward is the command to run on the rig, so a remote program's
// own --local has to reach it untouched rather than tripping the removal check.
func TestSSHV2ForwardsRemoteCommandLocalFlag(t *testing.T) {
	for _, tt := range []struct {
		name string
		args []string
		want string
	}{
		{
			name: "remote command flag",
			args: []string{"amika", "sandbox", "ssh", "my-box", "git", "log", "--local"},
			want: "--local",
		},
		{
			name: "after a bare double dash",
			args: []string{"amika", "sandbox", "ssh", "my-box", "--", "mycmd", "--local"},
			want: "--local",
		},
		{
			// The scan skips a token an ssh short option consumes, so an
			// identity file named "--local" is a value, not amika's flag.
			name: "as the value of an argument-taking ssh option",
			args: []string{"amika", "sandbox", "ssh", "-i", "--local", "my-box"},
			want: "--local",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			root, h, _ := newSSHV2Harness(t, tt.args)
			if err := root.Execute(); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !h.ran {
				t.Fatal("ssh should have run")
			}
			if !slices.Contains(h.argv, tt.want) {
				t.Fatalf("argv = %#v, want it to carry %q through to the remote command", h.argv, tt.want)
			}
		})
	}
}

// The hidden --transport goes into the session's own ProxyCommand on the ssh
// command line, and the create request at prepare time asks for that
// transport alone, so one the server cannot give fails before ssh starts.
func TestSSHV2TransportFlag(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AMIKA_BINARY_PATH", binary)
	for _, transport := range []string{"iroh", "direct_ws"} {
		t.Run(transport, func(t *testing.T) {
			root, h, out := newSSHV2Harness(t, []string{"amika", "sandbox", "--transport", transport, "ssh", "-N", "my-box"})
			if err := root.Execute(); err != nil {
				t.Fatalf("Execute: %v (output %q)", err, out.String())
			}
			wantArgv := []string{"-o", "ProxyCommand=" + binary + " plumbing ssh-stdio-proxy --transport " + transport + " %h", "-N", testV2Alias}
			if !reflect.DeepEqual(h.argv, wantArgv) {
				t.Fatalf("ssh argv = %#v, want %#v", h.argv, wantArgv)
			}
			_, _ = h.creator.CreateSSHSession("sb_abc", nil)
			want := []apiclient.SSHSessionTransport{apiclient.SSHSessionTransport(transport)}
			if !reflect.DeepEqual(h.client.transports, want) {
				t.Fatalf("create request transports = %v, want %v", h.client.transports, want)
			}
		})
	}

	t.Run("no flag keeps the managed ProxyCommand", func(t *testing.T) {
		root, h, _ := newSSHV2Harness(t, []string{"amika", "sandbox", "ssh", "my-box"})
		if err := root.Execute(); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(h.argv, []string{testV2Alias}) {
			t.Fatalf("ssh argv = %#v", h.argv)
		}
	})

	t.Run("unknown transport", func(t *testing.T) {
		root, h, _ := newSSHV2Harness(t, []string{"amika", "sandbox", "--transport", "tunnel", "ssh", "my-box"})
		if err := root.Execute(); err == nil || !strings.Contains(err.Error(), "unknown --transport") {
			t.Fatalf("err = %v", err)
		}
		if h.ran {
			t.Fatal("ssh ran")
		}
	})
}
