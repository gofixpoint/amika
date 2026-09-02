package gitrepo

// flags.go registers and reads the repo-selection flags, so every command that
// can put a repo in a sandbox spells them the same way.

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

// Flag names for repo selection. FlagRepo is an optional alias for FlagGit
// that a command may register for backward compatibility.
const (
	// FlagGit names the repo to use: a local path or a git URL.
	FlagGit = "git"
	// FlagNoGit skips auto-detection so no repo is used.
	FlagNoGit = "no-git"
	// FlagRepo is the legacy alias for FlagGit.
	FlagRepo = "repo"
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

// AddRepoAlias registers --repo as a hidden alias for --git. `amika send`
// shipped with --repo before --git existed, so the old name keeps working.
func AddRepoAlias(cmd *cobra.Command) {
	cmd.Flags().String(FlagRepo, "", "Deprecated alias for --git")
	_ = cmd.Flags().MarkHidden(FlagRepo)
}

// FromCommand reads the repo-selection flags off cmd and resolves them
// against cwd.
//
// The optional flags are read only when the command registers them: --repo
// stands in for --git where AddRepoAlias was called, and --no-clean applies
// where the command offers it. That keeps a command's call site a single line
// regardless of which of the trio it exposes.
func FromCommand(cmd *cobra.Command, cwd string) (Identity, error) {
	git, _ := cmd.Flags().GetString(FlagGit)
	gitSet := cmd.Flags().Changed(FlagGit)
	if alias := cmd.Flags().Lookup(FlagRepo); alias != nil && alias.Changed {
		aliasValue := alias.Value.String()
		if gitSet && strings.TrimSpace(git) != strings.TrimSpace(aliasValue) {
			return Identity{}, fmt.Errorf("--repo is an alias for --git; pass only one")
		}
		git, gitSet = aliasValue, true
	}
	noGit, _ := cmd.Flags().GetBool(FlagNoGit)
	noClean := false
	if f := cmd.Flags().Lookup(FlagNoClean); f != nil {
		noClean, _ = cmd.Flags().GetBool(FlagNoClean)
	}
	return Resolve(Options{Cwd: cwd, Git: git, GitSet: gitSet, NoGit: noGit, NoClean: noClean})
}

// FlagsChanged reports whether the user explicitly asked for a repo with
// --git or its --repo alias. Commands that can skip repo resolution entirely
// use it to tell an ignored default from an ignored request.
func FlagsChanged(cmd *cobra.Command) bool {
	if cmd.Flags().Changed(FlagGit) {
		return true
	}
	alias := cmd.Flags().Lookup(FlagRepo)
	return alias != nil && alias.Changed
}
