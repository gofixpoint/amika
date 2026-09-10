package sandboxcmd

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/spf13/cobra"
)

var sandboxBindGitHubBranchCmd = &cobra.Command{
	Use:   "bind-github-branch <sandbox>",
	Short: "Bind a remote sandbox to its GitHub branch",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if runmode.Resolve(cmd) != runmode.Remote {
			return fmt.Errorf("bind-github-branch is only supported for remote sandboxes")
		}
		if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
			return err
		}
		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}
		format, err := output.FormatFrom(cmd)
		if err != nil {
			return err
		}
		client, err := getRemoteClient(target)
		if err != nil {
			return err
		}

		sandboxRef := args[0]
		sandbox, err := client.GetSandbox(sandboxRef)
		if err != nil {
			return err
		}
		owner, _ := cmd.Flags().GetString("owner")
		repo, _ := cmd.Flags().GetString("repo")
		branch, _ := cmd.Flags().GetString("branch")
		rebind, _ := cmd.Flags().GetBool("rebind")

		if owner == "" || repo == "" {
			if sandbox.RepoURL == nil {
				return fmt.Errorf("sandbox %q has no repository; pass --owner and --repo", sandboxRef)
			}
			resolvedOwner, resolvedRepo, parseErr := parseGitHubRepositoryURL(*sandbox.RepoURL)
			if parseErr != nil {
				return parseErr
			}
			if owner == "" {
				owner = resolvedOwner
			}
			if repo == "" {
				repo = resolvedRepo
			}
		}
		if branch == "" && sandbox.Branch != nil {
			branch = *sandbox.Branch
		}
		if branch == "" {
			return fmt.Errorf("sandbox %q has no branch; pass --branch", sandboxRef)
		}

		binding, err := client.BindSandboxGitHubBranch(sandboxRef, owner, repo, branch, rebind)
		if err != nil {
			return err
		}
		if format.IsJSON() {
			return format.JSON(cmd.OutOrStdout(), binding)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Bound sandbox %q to %s/%s branch %q (%s).\n", sandboxRef, owner, repo, branch, binding.ID)
		return nil
	},
}

func parseGitHubRepositoryURL(rawURL string) (string, string, error) {
	value := strings.TrimSpace(rawURL)
	if value == "" {
		return "", "", fmt.Errorf("sandbox repository URL is empty")
	}

	var host, path string
	if strings.HasPrefix(value, "git@github.com:") {
		host = "github.com"
		path = strings.TrimPrefix(value, "git@github.com:")
	} else {
		parsed, err := url.Parse(value)
		if err != nil {
			return "", "", fmt.Errorf("parse sandbox repository URL: %w", err)
		}
		host = parsed.Hostname()
		path = parsed.Path
	}
	if !strings.EqualFold(host, "github.com") {
		return "", "", fmt.Errorf("sandbox repository %q is not hosted on github.com", rawURL)
	}

	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) != 2 {
		return "", "", fmt.Errorf("sandbox repository %q is not a GitHub owner/repository URL", rawURL)
	}
	owner := strings.TrimSpace(parts[0])
	repo := strings.TrimSuffix(strings.TrimSpace(parts[1]), ".git")
	if owner == "" || repo == "" || repo == "." || repo == ".." {
		return "", "", fmt.Errorf("sandbox repository %q is not a GitHub owner/repository URL", rawURL)
	}
	return owner, repo, nil
}
