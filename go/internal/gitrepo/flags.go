package gitrepo

// flags.go registers and reads the repo-selection flags, so every command that
// can put a repo in a sandbox spells them the same way.

import (
	"github.com/spf13/cobra"
)

// Flag names for repo selection.
const (
	// FlagGit names the repo to use: a local path or a git URL.
	FlagGit = "git"
	// FlagNoGit skips auto-detection so no repo is used.
	FlagNoGit = "no-git"
	// FlagNoClean includes the working tree's untracked files instead of a
	// clean clone. Only local sandboxes offer it.
	FlagNoClean = "no-clean"
)

// AddFlags registers --git and --no-git on cmd. The usage strings stay
// per-command because a local sandbox mounts the repo while a remote one
// clones it, but the names, types, and defaults live here so every command
// accepts exactly the same input.
func AddFlags(cmd *cobra.Command, gitUsage, noGitUsage string) {
	cmd.Flags().String(FlagGit, "", gitUsage)
	cmd.Flags().Bool(FlagNoGit, false, noGitUsage)
}

// FromCommand reads the repo-selection flags off cmd and resolves them
// against cwd.
//
// --no-clean is read only when the command registers it, so a command that
// does not offer it resolves as if it were unset rather than tripping over a
// flag it never exposed.
func FromCommand(cmd *cobra.Command, cwd string) (Identity, error) {
	git, _ := cmd.Flags().GetString(FlagGit)
	gitSet := cmd.Flags().Changed(FlagGit)
	noGit, _ := cmd.Flags().GetBool(FlagNoGit)
	noClean := false
	if f := cmd.Flags().Lookup(FlagNoClean); f != nil {
		noClean, _ = cmd.Flags().GetBool(FlagNoClean)
	}
	return Resolve(Options{Cwd: cwd, Git: git, GitSet: gitSet, NoGit: noGit, NoClean: noClean})
}
