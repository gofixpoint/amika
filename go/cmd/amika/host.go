package main

// host.go implements the `amika host` command group: list, inspect, and
// delete the organization's own hosts (bring-your-own-compute). Hosts are a
// control-plane resource, so every subcommand talks to the API directly.
//
// Adding a host is not here, and deliberately: a host registers itself from
// the machine, where its secret already lives. `amika-hostd up` posts the
// hostname, secret, and sizes, and `amika-hostd register-url` completes the
// registration with the URL the control plane reaches it on. These commands
// are the control-plane view of the records that leaves behind.

import (
	"bufio"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/cliprompt"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/spf13/cobra"
)

var hostCmd = &cobra.Command{
	Use:     "host",
	Aliases: []string{"hosts"},
	Short:   "Manage your organization's own hosts",
	Long: `Manage your organization's own hosts (bring-your-own-compute).

A host registers itself when ` + "`amika-hostd up`" + ` runs on the machine, which is
also where its secret lives, so these commands inspect and retire hosts rather
than add them.`,
}

var hostListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List your organization's hosts",
	Args:    cobra.NoArgs,
	RunE:    runHostList,
}

var hostGetCmd = &cobra.Command{
	Use:   "get <hostname-or-id>",
	Short: "Show one host",
	Args:  cobra.ExactArgs(1),
	RunE:  runHostGet,
}

var hostDeleteCmd = &cobra.Command{
	Use:     "delete <hostname-or-id> [<hostname-or-id>...]",
	Aliases: []string{"rm", "remove"},
	Short:   "Delete one or more hosts and their stored secrets",
	Long: `Delete one or more hosts and their stored secrets.

A host that still has rigs on it is refused; delete those rigs first. To find
them, take the host's id from ` + "`amika host get <hostname> -o json`" + ` and filter
` + "`amika rig list -o json`" + ` on it. The
machine itself is untouched: stop its daemon with ` + "`amika-hostd down`" + `, or it
will register itself again on the next ` + "`amika-hostd up`" + `.`,
	Args: cobra.MinimumNArgs(1),
	RunE: runHostDelete,
}

func runHostList(cmd *cobra.Command, _ []string) error {
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}

	hosts, err := runmode.NewRemoteClient().ListHosts()
	if err != nil {
		return err
	}

	if format.IsJSON() {
		if hosts == nil {
			hosts = []apiclient.Host{}
		}
		return format.JSON(cmd.OutOrStdout(), hosts)
	}

	if len(hosts) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "No hosts found.")
		return nil
	}

	// One listing, no --long: a host is addressed by hostname everywhere this
	// command group accepts one, and `host get` (or -o json) has the id, the
	// timestamps, and the per-size resources for the one host you care about.
	w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "HOSTNAME\tURL\tSIZES")
	for _, h := range hosts {
		fmt.Fprintf(w, "%s\t%s\t%s\n", h.Hostname, hostURL(h), hostSizeNames(h))
	}
	return w.Flush()
}

func runHostGet(cmd *cobra.Command, args []string) error {
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}

	host, err := runmode.NewRemoteClient().FindHost(args[0])
	if err != nil {
		return err
	}

	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), host)
	}

	w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
	fmt.Fprintf(w, "Hostname:\t%s\n", host.Hostname)
	fmt.Fprintf(w, "ID:\t%s\n", host.ID)
	fmt.Fprintf(w, "URL:\t%s\n", hostURL(*host))
	fmt.Fprintf(w, "Created:\t%s\n", host.CreatedAt)
	fmt.Fprintf(w, "Updated:\t%s\n", host.UpdatedAt)
	if len(host.Sizes) == 0 {
		fmt.Fprintf(w, "Sizes:\t-\n")
		return w.Flush()
	}
	fmt.Fprintln(w, "\nSIZE\tVCPU\tMEMORY\tDISK")
	for _, name := range sortedSizeNames(host.Sizes) {
		s := host.Sizes[name]
		grow := ""
		if s.DiskGrowOnly {
			grow = "≥ "
		}
		fmt.Fprintf(w, "%s\t%d\t%s GiB\t%s%d GiB\n", tableCell(name), s.VCPUs, formatGiB(s.MemoryGiB), grow, s.DiskGiB)
	}
	return w.Flush()
}

func runHostDelete(cmd *cobra.Command, args []string) error {
	force, _ := cmd.Flags().GetBool("force")

	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}

	// Before the prompt, not after: asking someone to approve a delete that
	// cannot run wastes their answer, and a non-interactive caller would get
	// "failed to read confirmation: EOF" in place of the login error.
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}

	if !force && format.IsJSON() {
		return fmt.Errorf("refusing to prompt for confirmation with --%s %s; pass --force to delete", output.FlagName, format)
	}

	client := runmode.NewRemoteClient()

	// One listing for every ref: resolving each one separately would re-fetch
	// it per argument and, worse, report the same listing failure once per
	// argument instead of failing the command outright. It also runs before
	// the prompt below, for the same reason the auth check does — with
	// bring-your-own-compute off the whole /hosts surface 404s, and the
	// operator should not spend a `y` on a delete that cannot happen.
	hosts, err := client.ListHosts()
	if err != nil {
		return err
	}

	targets, hostnames := resolveDeleteTargets(hosts, args)
	// Nothing resolved: no prompt, since nothing would be deleted. The loop
	// below still reports one failure per argument.
	if !force && len(hostnames) > 0 {
		confirmed, err := cliprompt.Confirm(
			fmt.Sprintf("Delete host(s) %s and their stored secrets?", strings.Join(hostnames, ", ")),
			bufio.NewReader(cmd.InOrStdin()),
		)
		if err != nil {
			return err
		}
		if !confirmed {
			fmt.Fprintln(cmd.OutOrStdout(), "Aborted.")
			return nil
		}
	}

	pw := format.Progress(cmd.OutOrStdout())
	var errs []string
	results := []output.ItemResult{}
	// Two refs can name one host (a hostname and its id, or the same name
	// twice). One DELETE goes out for it and the second ref replays that
	// outcome: repeating the request would 404 on a host this command just
	// removed, or take a second refusal for the one it did not. Each ref
	// still gets its own result, since callers index the array against the
	// arguments they passed.
	attempted := map[string]error{}
	for _, t := range targets {
		ref, err := t.ref, t.err
		if err == nil {
			outcome, done := attempted[t.host.ID]
			if !done {
				outcome = client.DeleteHost(t.host.ID)
				attempted[t.host.ID] = outcome
			}
			err = outcome
		}
		if err != nil {
			errs = append(errs, fmt.Sprintf("host %q: %v", ref, err))
			results = append(results, output.ItemResult{Name: ref, Status: "error", Error: err.Error()})
			continue
		}
		fmt.Fprintf(pw, "Host %q deleted\n", ref)
		results = append(results, output.ItemResult{Name: ref, Status: "deleted"})
	}

	if format.IsJSON() {
		if err := format.JSON(cmd.OutOrStdout(), results); err != nil {
			return err
		}
		if len(errs) > 0 {
			return fmt.Errorf("%d of %d failed; see JSON output", len(errs), len(results))
		}
		return nil
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "\n"))
	}
	return nil
}

// hostURL renders a host's URL for a table cell, as "-" while it has none.
func hostURL(h apiclient.Host) string {
	if h.URL == nil || *h.URL == "" {
		return "-"
	}
	return *h.URL
}

// hostSizeNames renders a host's size names for a table cell, as "-" when the
// host offers none.
func hostSizeNames(h apiclient.Host) string {
	if len(h.Sizes) == 0 {
		return "-"
	}
	return tableCell(strings.Join(sortedSizeNames(h.Sizes), ","))
}

// tableCell makes a value safe to put in a tabwriter row. Size names come
// from the host's own config and are only `z.string().min(1)` server-side, so
// a tab or newline in one would end the column block and misalign every row
// after it, not just its own.
func tableCell(value string) string {
	return strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return ' '
		}
		return r
	}, value)
}

// formatGiB renders a size's memory without %g's exponent form, which turns
// an implausible but legal `memoryGib` into "1.048576e+06".
func formatGiB(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// deleteTarget pairs one `host delete` argument with the host it names, or
// with the error saying it names none.
type deleteTarget struct {
	ref  string
	host *apiclient.Host
	err  error
}

// resolveDeleteTargets matches every argument against the listing, and
// returns the distinct hostnames behind them for the confirmation prompt.
// The prompt names hosts rather than the spellings the caller typed, so
// `host delete alpha.lan host_1` asks about one host rather than two.
func resolveDeleteTargets(hosts []apiclient.Host, args []string) ([]deleteTarget, []string) {
	targets := make([]deleteTarget, 0, len(args))
	hostnames := []string{}
	seen := map[string]bool{}
	for _, ref := range args {
		host, err := apiclient.MatchHost(hosts, ref)
		targets = append(targets, deleteTarget{ref: ref, host: host, err: err})
		if err == nil && !seen[host.ID] {
			seen[host.ID] = true
			hostnames = append(hostnames, host.Hostname)
		}
	}
	return targets, hostnames
}

// sortedSizeNames orders a host's size names so two runs print the same rows
// in the same order; a JSON object's key order carries no meaning.
func sortedSizeNames(sizes map[string]apiclient.HostSize) []string {
	names := make([]string, 0, len(sizes))
	for name := range sizes {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func init() {
	rootCmd.AddCommand(hostCmd)
	hostCmd.AddCommand(hostListCmd)
	hostCmd.AddCommand(hostGetCmd)
	hostCmd.AddCommand(hostDeleteCmd)

	hostDeleteCmd.Flags().BoolP("force", "f", false, "Skip confirmation prompt")
}
