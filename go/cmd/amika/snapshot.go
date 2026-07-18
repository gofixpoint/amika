package main

// snapshot.go implements the `amika snapshot` command group: create, list, and
// delete snapshots captured from running remote sandboxes. Snapshots are a
// remote-only concept, so every subcommand talks to the API directly.

import (
	"bufio"
	"fmt"
	"strings"
	"text/tabwriter"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/config"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/spf13/cobra"
)

var snapshotCmd = &cobra.Command{
	Use:   "snapshot",
	Short: "Manage snapshots captured from running sandboxes",
}

var snapshotCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Capture a snapshot from a running sandbox",
	Long: `Capture a snapshot from a running sandbox.

By default this is interactive: it prompts for the capture mode and, for
"scrub and delete", previews the injected secrets that will be removed and asks
for confirmation. Pass --no-interactive for a non-prompting run (which then
requires --mode and --name).`,
	Args: cobra.NoArgs,
	RunE: runSnapshotCreate,
}

var snapshotListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List snapshots captured from sandboxes",
	Args:    cobra.NoArgs,
	RunE:    runSnapshotList,
}

var snapshotDeleteCmd = &cobra.Command{
	Use:     "delete <name-or-id> [<name-or-id>...]",
	Aliases: []string{"rm", "remove"},
	Short:   "Delete one or more sandbox snapshots",
	Args:    cobra.MinimumNArgs(1),
	RunE:    runSnapshotDelete,
}

// getSnapshotClient returns an API client authenticated with the current
// session, resolved per request (AMIKA_API_KEY, stored key, then WorkOS).
func getSnapshotClient() (*apiclient.Client, error) {
	return apiclient.NewClientWithTokenSource(config.APIURL(), apiclient.NewResolvedTokenSource(config.WorkOSClientID())), nil
}

func runSnapshotCreate(cmd *cobra.Command, _ []string) error {
	sandboxRef, _ := cmd.Flags().GetString("sandbox")
	name, _ := cmd.Flags().GetString("name")
	mode, _ := cmd.Flags().GetString("mode")
	description, _ := cmd.Flags().GetString("description")
	noInteractive, _ := cmd.Flags().GetBool("no-interactive")

	if strings.TrimSpace(sandboxRef) == "" {
		return fmt.Errorf("--sandbox is required")
	}

	client, err := getSnapshotClient()
	if err != nil {
		return err
	}

	reader := bufio.NewReader(cmd.InOrStdin())

	if noInteractive {
		if mode == "" {
			return fmt.Errorf("--mode is required with --no-interactive (scrub_and_delete or full)")
		}
		if strings.TrimSpace(name) == "" {
			return fmt.Errorf("--name is required with --no-interactive")
		}
	} else {
		if mode == "" {
			mode, err = promptSnapshotMode(cmd, reader)
			if err != nil {
				return err
			}
		}
		if strings.TrimSpace(name) == "" {
			name, err = promptLine(cmd, reader, "Snapshot name")
			if err != nil {
				return err
			}
			if strings.TrimSpace(name) == "" {
				return fmt.Errorf("a snapshot name is required")
			}
		}
	}

	if mode != "scrub_and_delete" && mode != "full" {
		return fmt.Errorf("invalid --mode %q: must be scrub_and_delete or full", mode)
	}

	// For scrub-and-delete, show what will be removed and confirm before the
	// destructive capture (interactive runs only).
	if mode == "scrub_and_delete" && !noInteractive {
		preview, err := client.GetSandboxScrubPreview(sandboxRef)
		if err != nil {
			return err
		}
		printScrubPreview(cmd, preview)
		confirmed, err := confirmAction(
			"Scrub these secrets, snapshot the sandbox, and delete it?",
			reader,
		)
		if err != nil {
			return err
		}
		if !confirmed {
			fmt.Fprintln(cmd.OutOrStdout(), "Aborted.")
			return nil
		}
	}

	snap, err := client.CreateSandboxSnapshot(apiclient.CreateSandboxSnapshotRequest{
		SandboxRef:  sandboxRef,
		Name:        name,
		Description: description,
		Mode:        mode,
	})
	if err != nil {
		return err
	}

	fmt.Fprintf(
		cmd.OutOrStdout(),
		"Snapshot %q is %s. Capture runs in the background; check `amika snapshot list`.\n",
		snap.Snapshot,
		snap.State,
	)
	return nil
}

func runSnapshotList(cmd *cobra.Command, _ []string) error {
	long, _ := cmd.Flags().GetBool("long")
	sandboxRef, _ := cmd.Flags().GetString("sandbox")
	repoRef, _ := cmd.Flags().GetString("repo")

	client, err := getSnapshotClient()
	if err != nil {
		return err
	}

	var sourceSandboxID, repositoryID string
	if strings.TrimSpace(sandboxRef) != "" {
		sourceSandboxID, err = resolveSandboxID(client, sandboxRef)
		if err != nil {
			return err
		}
	}
	if strings.TrimSpace(repoRef) != "" {
		repositoryID, err = resolveRepositoryID(client, repoRef)
		if err != nil {
			return err
		}
	}

	snapshots, err := client.ListSandboxSnapshots(repositoryID, sourceSandboxID)
	if err != nil {
		return err
	}
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	if format.IsJSON() {
		if snapshots == nil {
			snapshots = []apiclient.SandboxSnapshot{}
		}
		return format.JSON(cmd.OutOrStdout(), snapshots)
	}

	if len(snapshots) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "No snapshots found.")
		return nil
	}

	w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
	if long {
		fmt.Fprintln(w, "NAME\tSTATE\tPROVIDER\tSOURCE\tSIZE\tBASE\tDESCRIPTION\tCREATED\tERROR")
		for _, s := range snapshots {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
				s.Snapshot, s.State, s.Provider, snapshotSource(s),
				deref(s.SandboxSize), deref(s.BaseSnapshot), deref(s.Description),
				s.CreatedAt, deref(s.ErrorMessage))
		}
	} else {
		fmt.Fprintln(w, "NAME\tSTATE\tPROVIDER\tSOURCE\tCREATED")
		for _, s := range snapshots {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
				s.Snapshot, s.State, s.Provider, snapshotSource(s), s.CreatedAt)
		}
	}
	w.Flush()
	return nil
}

func runSnapshotDelete(cmd *cobra.Command, args []string) error {
	force, _ := cmd.Flags().GetBool("force")

	if !force {
		reader := bufio.NewReader(cmd.InOrStdin())
		confirmed, err := confirmAction(
			fmt.Sprintf("Delete snapshot(s) %s?", strings.Join(args, ", ")),
			reader,
		)
		if err != nil {
			return err
		}
		if !confirmed {
			fmt.Fprintln(cmd.OutOrStdout(), "Aborted.")
			return nil
		}
	}

	client, err := getSnapshotClient()
	if err != nil {
		return err
	}

	var errs []string
	for _, ref := range args {
		if err := client.DeleteSandboxSnapshot(ref); err != nil {
			errs = append(errs, fmt.Sprintf("snapshot %q: %v", ref, err))
			continue
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Snapshot %q deleted\n", ref)
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "\n"))
	}
	return nil
}

// promptSnapshotMode asks the user to choose a capture mode, defaulting to
// scrub_and_delete on empty input.
func promptSnapshotMode(cmd *cobra.Command, reader *bufio.Reader) (string, error) {
	out := cmd.OutOrStdout()
	for {
		fmt.Fprintln(out, "Capture mode:")
		fmt.Fprintln(out, "  [1] scrub_and_delete (default): remove injected secrets, snapshot, then delete the sandbox")
		fmt.Fprintln(out, "  [2] full: snapshot everything as-is (keeps secrets and the sandbox; unsafe)")
		fmt.Fprint(out, "Choose [1/2] (default 1): ")
		answer, err := reader.ReadString('\n')
		if err != nil {
			return "", fmt.Errorf("failed to read choice: %w", err)
		}
		switch strings.TrimSpace(strings.ToLower(answer)) {
		case "", "1", "scrub_and_delete":
			return "scrub_and_delete", nil
		case "2", "full":
			return "full", nil
		default:
			fmt.Fprintln(out, "Please enter 1 or 2.")
		}
	}
}

// promptLine prompts for a single line of free-form input.
func promptLine(cmd *cobra.Command, reader *bufio.Reader, label string) (string, error) {
	fmt.Fprintf(cmd.OutOrStdout(), "%s: ", label)
	answer, err := reader.ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("failed to read %s: %w", label, err)
	}
	return strings.TrimSpace(answer), nil
}

func printScrubPreview(cmd *cobra.Command, preview *apiclient.SandboxScrubPreview) {
	out := cmd.OutOrStdout()
	if len(preview.Files) == 0 && len(preview.EnvVars) == 0 {
		fmt.Fprintln(out, "No injected secrets detected; nothing will be scrubbed.")
		return
	}
	fmt.Fprintln(out, "The following injected secrets will be removed before the snapshot:")
	for _, f := range preview.Files {
		fmt.Fprintf(out, "  file: %s\n", f)
	}
	for _, e := range preview.EnvVars {
		fmt.Fprintf(out, "  env:  %s\n", e)
	}
}

// resolveSandboxID resolves a sandbox name-or-id to its id, matching by id
// first, then by name.
func resolveSandboxID(client *apiclient.Client, ref string) (string, error) {
	sandboxes, err := client.ListSandboxes()
	if err != nil {
		return "", err
	}
	for _, s := range sandboxes {
		if s.ID == ref {
			return s.ID, nil
		}
	}
	for _, s := range sandboxes {
		if s.Name == ref {
			return s.ID, nil
		}
	}
	return "", fmt.Errorf("no sandbox found matching %q", ref)
}

// resolveRepositoryID resolves a repository name-or-id to its id, matching by
// id, then exact repo URL, then repo-name basename (rejecting an ambiguous
// basename match).
func resolveRepositoryID(client *apiclient.Client, ref string) (string, error) {
	repos, err := client.ListRepositories()
	if err != nil {
		return "", err
	}
	for _, r := range repos {
		if r.ID == ref {
			return r.ID, nil
		}
	}
	var matches []string
	for _, r := range repos {
		if r.RepoURL == ref || repoBasename(r.RepoURL) == ref {
			matches = append(matches, r.ID)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0], nil
	case 0:
		return "", fmt.Errorf("no repository found matching %q", ref)
	default:
		return "", fmt.Errorf("%q matches multiple repositories; pass a repository id instead", ref)
	}
}

func snapshotSource(s apiclient.SandboxSnapshot) string {
	if s.SourceSandboxName != nil && *s.SourceSandboxName != "" {
		return *s.SourceSandboxName
	}
	if s.SourceSandboxID != nil && *s.SourceSandboxID != "" {
		return *s.SourceSandboxID
	}
	return "-"
}

func deref(s *string) string {
	if s == nil || *s == "" {
		return "-"
	}
	return *s
}

// repoBasename extracts the repo name from a git URL or path, dropping any
// ".git" suffix (e.g. "https://github.com/org/repo.git" -> "repo").
func repoBasename(repoURL string) string {
	p := strings.TrimRight(strings.TrimSpace(repoURL), "/")
	if i := strings.LastIndex(p, "://"); i >= 0 {
		p = p[i+3:]
	}
	if i := strings.LastIndex(p, ":"); i >= 0 {
		p = p[i+1:]
	}
	if i := strings.LastIndex(p, "/"); i >= 0 {
		p = p[i+1:]
	}
	return strings.TrimSuffix(p, ".git")
}

func init() {
	rootCmd.AddCommand(snapshotCmd)
	snapshotCmd.AddCommand(snapshotCreateCmd)
	snapshotCmd.AddCommand(snapshotListCmd)
	snapshotCmd.AddCommand(snapshotDeleteCmd)

	snapshotCreateCmd.Flags().String("sandbox", "", "Source sandbox to snapshot (name or id)")
	snapshotCreateCmd.Flags().String("name", "", "Name for the snapshot")
	snapshotCreateCmd.Flags().String("mode", "", "Capture mode: scrub_and_delete or full (required with --no-interactive)")
	snapshotCreateCmd.Flags().String("description", "", "Optional description shown in the snapshot list")
	snapshotCreateCmd.Flags().Bool("no-interactive", false, "Do not prompt; requires --mode and --name")

	snapshotListCmd.Flags().BoolP("long", "l", false, "Show additional columns")
	snapshotListCmd.Flags().String("sandbox", "", "Only show snapshots captured from this sandbox (name or id)")
	snapshotListCmd.Flags().String("repo", "", "Only show snapshots for this repository (name or id)")

	snapshotDeleteCmd.Flags().BoolP("force", "f", false, "Skip confirmation prompt")
}
