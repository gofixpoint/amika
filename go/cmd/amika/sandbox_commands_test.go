package main

import (
	"slices"
	"testing"

	"github.com/spf13/cobra"
)

func findSubcommand(t *testing.T, parent *cobra.Command, name string) *cobra.Command {
	t.Helper()
	for _, child := range parent.Commands() {
		if child.Name() == name || slices.Contains(child.Aliases, name) {
			return child
		}
	}
	t.Fatalf("subcommand %q not found under %q", name, parent.Name())
	return nil
}

func TestRigCommandRegistered(t *testing.T) {
	rigCmd := findSubcommand(t, rootCmd, "rig")
	if rigCmd.Name() != "rig" {
		t.Fatalf("command name = %q, want rig", rigCmd.Name())
	}
	if !slices.Contains(rigCmd.Aliases, "sandbox") {
		t.Fatal("rig command must include alias \"sandbox\"")
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
