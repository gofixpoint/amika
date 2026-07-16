package main

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/sandbox"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

func findSubcommand(t *testing.T, parent *cobra.Command, name string) *cobra.Command {
	t.Helper()
	for _, child := range parent.Commands() {
		if child.Name() == name {
			return child
		}
	}
	t.Fatalf("subcommand %q not found under %q", name, parent.Name())
	return nil
}

func TestSandboxCommandRegistered(t *testing.T) {
	sandboxCmd := findSubcommand(t, rootCmd, "sandbox")
	if sandboxCmd.Name() != "sandbox" {
		t.Fatalf("command name = %q, want sandbox", sandboxCmd.Name())
	}
}

func TestSandboxDeleteAliases(t *testing.T) {
	sandboxCmd := findSubcommand(t, rootCmd, "sandbox")
	deleteCmd := findSubcommand(t, sandboxCmd, "delete")
	if !slices.Contains(deleteCmd.Aliases, "rm") {
		t.Fatal("sandbox delete command must include alias \"rm\"")
	}
	if !slices.Contains(deleteCmd.Aliases, "remove") {
		t.Fatal("sandbox delete command must include alias \"remove\"")
	}
}

func TestSandboxCreateHasConnectFlag(t *testing.T) {
	sandboxCmd := findSubcommand(t, rootCmd, "sandbox")
	createCmd := findSubcommand(t, sandboxCmd, "create")
	flag := createCmd.Flags().Lookup("connect")
	if flag == nil {
		t.Fatal("sandbox create command must define --connect")
	}
	if flag.Value.Type() != "bool" {
		t.Fatalf("connect flag type = %q, want bool", flag.Value.Type())
	}
}

func TestSandboxCreateHasSnapshotFlag(t *testing.T) {
	sandboxCmd := findSubcommand(t, rootCmd, "sandbox")
	createCmd := findSubcommand(t, sandboxCmd, "create")
	flag := createCmd.Flags().Lookup("snapshot")
	if flag == nil {
		t.Fatal("sandbox create command must define --snapshot")
	}
	if flag.Value.Type() != "string" {
		t.Fatalf("snapshot flag type = %q, want string", flag.Value.Type())
	}
}

func TestSandboxCreateSnapshotRequiresRemote(t *testing.T) {
	// runRootCommand shares the package-global rootCmd, and cobra carries flag
	// values and their Changed state across Execute calls. Reset what this test
	// sets so it can't leak --local/--snapshot onto later sandbox tests.
	sandboxCmd := findSubcommand(t, rootCmd, "sandbox")
	createCmd := findSubcommand(t, sandboxCmd, "create")
	t.Cleanup(func() {
		resetFlag(t, sandboxCmd.PersistentFlags().Lookup("local"))
		resetFlag(t, sandboxCmd.PersistentFlags().Lookup("remote"))
		resetFlag(t, createCmd.Flags().Lookup("snapshot"))
	})

	_, err := runRootCommand("sandbox", "create", "--local", "--snapshot", "amika-mono-base")
	if err == nil {
		t.Fatal("expected an error when --snapshot is used without --remote")
	}
	if !strings.Contains(err.Error(), "--snapshot requires --remote mode") {
		t.Fatalf("error = %v, want it to mention --snapshot requires --remote mode", err)
	}
}

// resetFlag restores a cobra/pflag flag to its declared default and clears its
// Changed state, undoing what a runRootCommand call leaves on the shared
// rootCmd (cobra never resets flags between Execute calls).
func resetFlag(t *testing.T, flag *pflag.Flag) {
	t.Helper()
	if flag == nil {
		return
	}
	if err := flag.Value.Set(flag.DefValue); err != nil {
		t.Fatalf("reset flag %q: %v", flag.Name, err)
	}
	flag.Changed = false
}

func TestSandboxListCommand_PrintsRows(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", dir)
	store := sandbox.NewStore(filepath.Join(dir, "sandboxes.jsonl"))
	if err := store.Save(sandbox.Info{
		Name:      "sb-a",
		Provider:  "docker",
		Image:     "img",
		CreatedAt: "now",
		Ports: []sandbox.PortBinding{
			{HostIP: "127.0.0.1", HostPort: 8080, ContainerPort: 80, Protocol: "tcp"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	out, err := runRootCommand("sandbox", "list", "--local")
	if err != nil {
		t.Fatalf("sandbox list failed: %v", err)
	}
	if !strings.Contains(out, "NAME") || !strings.Contains(out, "CREATOR") {
		t.Fatalf("missing header: %s", out)
	}
	if strings.Contains(out, "PROVIDER") || strings.Contains(out, "PORTS") || strings.Contains(out, "IMAGE") {
		t.Fatalf("unexpected wide-only column in default output: %s", out)
	}
	if !strings.Contains(out, "sb-a") {
		t.Fatalf("missing sandbox row: %s", out)
	}

	longOut, err := runRootCommand("sandbox", "list", "--local", "--long")
	if err != nil {
		t.Fatalf("sandbox list --long failed: %v", err)
	}
	if !strings.Contains(longOut, "IMAGE") || !strings.Contains(longOut, "PORTS") {
		t.Fatalf("missing long header: %s", longOut)
	}
	if !strings.Contains(longOut, "127.0.0.1:8080->80/tcp") {
		t.Fatalf("missing ports in long row: %s", longOut)
	}
}
