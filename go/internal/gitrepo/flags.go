package gitrepo

// flags.go registers and reads the repo-selection flags, so every command that
// can put a repo in a sandbox spells them the same way.

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

// Flag names for repo selection.
const (
	// FlagGit names the repo to use: a local path or a git URL.
	FlagGit = "git"
	// FlagNoGit skips auto-detection so no repo is used.
	FlagNoGit = "no-git"
	// FlagRepo is a legacy alias for FlagGit that a command may register.
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

// AddRepoAlias registers --repo as a deprecated alias for --git. `amika send`
// shipped with --repo before --git existed, so the old spelling keeps working
// and resolves identically — including accepting a local path, which it did
// not before.
//
// MarkDeprecated rather than MarkHidden: both keep the flag out of --help, but
// only this one prints a notice when it is used. Since the alias also tightened
// what it accepts, a script that breaks after upgrading needs to be told where
// the flag went — and --help can no longer be the place it finds out.
func AddRepoAlias(cmd *cobra.Command) {
	cmd.Flags().String(FlagRepo, "", "Deprecated alias for --"+FlagGit)
	_ = cmd.Flags().MarkDeprecated(FlagRepo, "use --"+FlagGit)
}

// RequestedFlag returns the flag through which the caller explicitly asked for
// a repo — FlagGit or its FlagRepo alias — or "" if neither was passed. A
// command that cannot honor repo selection in some mode uses it both to tell
// an unused default from a real request and to name the right flag when
// refusing.
func RequestedFlag(cmd *cobra.Command) string {
	for _, name := range []string{FlagGit, FlagRepo} {
		if f := cmd.Flags().Lookup(name); f != nil && f.Changed {
			return name
		}
	}
	return ""
}

// readFlags translates cmd's repo-selection flags into Options, leaving Cwd
// unset.
//
// Only --no-git is required of a caller. --git, --repo, and --no-clean are
// read when the command registers them and treated as unset otherwise, so a
// command offering some of the set resolves the same way as one offering all
// of it rather than tripping over a flag it never exposed.
func readFlags(cmd *cobra.Command) (Options, error) {
	git, gitSet, gitFlagName := "", false, FlagGit
	if f := cmd.Flags().Lookup(FlagGit); f != nil {
		git, gitSet = f.Value.String(), f.Changed
	}
	// --repo is the same input under an older name, so it feeds the same
	// field. Both set to different values is ambiguous rather than a
	// last-one-wins guess.
	if f := cmd.Flags().Lookup(FlagRepo); f != nil && f.Changed {
		alias := f.Value.String()
		if gitSet && strings.TrimSpace(git) != strings.TrimSpace(alias) {
			return Options{}, fmt.Errorf(
				"--%s and --%s are the same flag under two names; pass one, not both with different values",
				FlagGit, FlagRepo)
		}
		// Name the alias only when it is the sole spelling used, so one
		// invocation is never reported under two different flag names
		// depending on which check happens to fire. RequestedFlag prefers
		// --git for the same reason.
		if !gitSet {
			gitFlagName = FlagRepo
		}
		git, gitSet = alias, true
	}
	noGit, _ := cmd.Flags().GetBool(FlagNoGit)
	noClean := false
	if f := cmd.Flags().Lookup(FlagNoClean); f != nil {
		noClean, _ = cmd.Flags().GetBool(FlagNoClean)
	}
	return Options{
		Git: git, GitSet: gitSet, GitFlagName: gitFlagName,
		NoGit: noGit, NoClean: noClean,
	}, nil
}

// ValidateFlags rejects a contradictory combination of cmd's repo-selection
// flags without touching the filesystem. A command whose resolution happens
// late — after an auth gate, say — calls this early so a mistyped invocation
// is reported on its own terms rather than behind an unrelated error.
func ValidateFlags(cmd *cobra.Command) error {
	opts, err := readFlags(cmd)
	if err != nil {
		return err
	}
	return opts.Validate()
}

// FromCommand reads the repo-selection flags off cmd and resolves them
// against cwd. See readFlags for which flags a caller must register.
func FromCommand(cmd *cobra.Command, cwd string) (Identity, error) {
	opts, err := readFlags(cmd)
	if err != nil {
		return Identity{}, err
	}
	opts.Cwd = cwd
	return Resolve(opts)
}
