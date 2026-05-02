package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

// configDir is the on-disk root for sandbox metadata that amikad writes and
// amikactl reads. Each entry below is a single-line text file under this dir.
const configDir = "/usr/local/etc/amikad"

const (
	fileSandboxName = "sandbox-name"
	fileCreatedBy   = "created-by"
	fileOrg         = "org"
	fileRepos       = "repos"
)

var whoamiCmd = &cobra.Command{
	Use:   "whoami",
	Short: "Print sandbox identity and contents",
	Long: `Print the sandbox's name, the user and org that created it, and the repos
(with their current git branches) checked out inside it.`,
	RunE: func(cmd *cobra.Command, _ []string) error {
		return runWhoami(cmd.OutOrStdout())
	},
}

func init() {
	rootCmd.AddCommand(whoamiCmd)
}

func runWhoami(out io.Writer) error {
	name := readField(fileSandboxName)
	createdBy := readField(fileCreatedBy)
	org := readField(fileOrg)
	repos, err := readRepos()
	if err != nil {
		return err
	}

	fmt.Fprintf(out, "Sandbox: %s\n", display(name))
	fmt.Fprintf(out, "Created by: %s\n", display(createdBy))
	fmt.Fprintf(out, "Org: %s\n", display(org))

	if len(repos) == 0 {
		fmt.Fprintln(out, "Repos: (none)")
		return nil
	}

	fmt.Fprintln(out, "Repos:")
	for _, repo := range repos {
		branch, branchErr := currentBranch(repo)
		switch {
		case branchErr != nil:
			fmt.Fprintf(out, "  %s\t(branch unknown: %v)\n", repo, branchErr)
		case branch == "":
			fmt.Fprintf(out, "  %s\t(detached HEAD)\n", repo)
		default:
			fmt.Fprintf(out, "  %s\t%s\n", repo, branch)
		}
	}
	return nil
}

func readField(name string) string {
	data, err := os.ReadFile(filepath.Join(configDir, name))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func readRepos() ([]string, error) {
	f, err := os.Open(filepath.Join(configDir, fileRepos))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading %s: %w", fileRepos, err)
	}
	defer f.Close()

	var repos []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		repos = append(repos, line)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("reading %s: %w", fileRepos, err)
	}
	return repos, nil
}

// currentBranch returns the checked-out branch name in repoPath by reading
// .git/HEAD directly. Returns "" for a detached HEAD.
func currentBranch(repoPath string) (string, error) {
	headPath := filepath.Join(repoPath, ".git", "HEAD")
	data, err := os.ReadFile(headPath)
	if err != nil {
		return "", err
	}
	head := strings.TrimSpace(string(data))
	const refPrefix = "ref: refs/heads/"
	if strings.HasPrefix(head, refPrefix) {
		return strings.TrimPrefix(head, refPrefix), nil
	}
	return "", nil
}

func display(value string) string {
	if value == "" {
		return "(unknown)"
	}
	return value
}
