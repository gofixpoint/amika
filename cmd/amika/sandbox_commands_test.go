package main

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/internal/sandbox"
	"github.com/spf13/cobra"
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
	if !strings.Contains(out, "NAME") || !strings.Contains(out, "PROVIDER") || !strings.Contains(out, "PORTS") {
		t.Fatalf("missing header: %s", out)
	}
	if !strings.Contains(out, "sb-a") {
		t.Fatalf("missing sandbox row: %s", out)
	}
	if !strings.Contains(out, "127.0.0.1:8080->80/tcp") {
		t.Fatalf("missing ports in row: %s", out)
	}
}
