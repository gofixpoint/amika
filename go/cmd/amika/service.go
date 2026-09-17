package main

import (
	"bufio"
	"fmt"
	"regexp"
	"strings"
	"text/tabwriter"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/services"
	"github.com/spf13/cobra"
)

// serviceListItem is the JSON representation of one `service list` row. Ports
// and URL are display strings (comma/space-joined) matching the text columns
// rather than structured arrays, since a service row aggregates several bindings
// into a single cell.
type serviceListItem struct {
	Service string `json:"service"`
	Sandbox string `json:"sandbox"`
	Ports   string `json:"ports"`
	URL     string `json:"url"`
}

var serviceCmd = &cobra.Command{
	Use:     "service",
	Aliases: []string{"services"},
	Short:   "Manage sandbox services",
	Long:    `View and manage declared services and their port bindings across sandboxes.`,
}

// dnsLabelRe matches a single RFC 1123 DNS label (a sandbox service name):
// lowercase letters, digits, and hyphens, not starting or ending with a hyphen.
// Length (1-63) is enforced separately. The server is the source of truth; this
// is a fast client-side check so obviously invalid names fail before a round
// trip.
var dnsLabelRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)

// validateServiceName checks name against the single-DNS-label rules.
func validateServiceName(name string) error {
	if len(name) > 63 || !dnsLabelRe.MatchString(name) {
		return fmt.Errorf("invalid --name %q: must be a single DNS label (lowercase letters, digits, and hyphens; 1-63 chars; no leading or trailing hyphen)", name)
	}
	return nil
}

var serviceCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a service on a running sandbox",
	Args:  cobra.NoArgs,
	RunE:  runServiceCreate,
}

var serviceDeleteCmd = &cobra.Command{
	Use:     "delete",
	Aliases: []string{"rm", "remove"},
	Short:   "Delete a service from a sandbox",
	Args:    cobra.NoArgs,
	RunE:    runServiceDelete,
}

func runServiceCreate(cmd *cobra.Command, _ []string) error {
	rigRef, _ := cmd.Flags().GetString("rig")
	name, _ := cmd.Flags().GetString("name")
	port, _ := cmd.Flags().GetInt("port")
	urlScheme, _ := cmd.Flags().GetString("url-scheme")

	if strings.TrimSpace(rigRef) == "" {
		return fmt.Errorf("--rig is required")
	}
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("--name is required")
	}
	if port == 0 {
		return fmt.Errorf("--port is required")
	}
	if err := services.ValidatePort(port); err != nil {
		return err
	}
	if strings.TrimSpace(urlScheme) == "" {
		return fmt.Errorf("--url-scheme is required")
	}
	if err := validateServiceName(name); err != nil {
		return err
	}
	if urlScheme != "http" && urlScheme != "https" {
		return fmt.Errorf("invalid --url-scheme %q: must be \"http\" or \"https\"", urlScheme)
	}

	// Validate --remote-target up front, unconditionally, matching `service
	// list`: a bad value fails the same way regardless of auth state.
	if _, err := getServiceRemoteTarget(cmd); err != nil {
		return err
	}

	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}

	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}

	svc, err := runmode.NewRemoteClient().CreateSandboxService(rigRef, apiclient.SandboxServiceRequest{
		Name:      name,
		Port:      port,
		URLScheme: urlScheme,
	})
	if err != nil {
		return err
	}
	if format.IsJSON() {
		// Remote-backed command: emit the API's response schema verbatim (see
		// AGENTS.md "Remote-backed commands emit the API's response schema") so
		// every field round-trips, including the id and a pending url as null.
		return format.JSON(cmd.OutOrStdout(), svc)
	}
	printService(cmd, svc)
	return nil
}

func runServiceDelete(cmd *cobra.Command, _ []string) error {
	rigRef, _ := cmd.Flags().GetString("rig")
	name, _ := cmd.Flags().GetString("name")
	force, _ := cmd.Flags().GetBool("force")

	if strings.TrimSpace(rigRef) == "" {
		return fmt.Errorf("--rig is required")
	}
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("--name is required")
	}

	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}

	// Validate --remote-target up front, unconditionally, matching `service
	// list`: a bad value fails the same way regardless of mode or auth state.
	if _, err := getServiceRemoteTarget(cmd); err != nil {
		return err
	}

	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}

	if !force {
		if format.IsJSON() {
			return fmt.Errorf("refusing to prompt for confirmation with --%s %s; pass --force to delete", output.FlagName, format)
		}
		reader := bufio.NewReader(cmd.InOrStdin())
		confirmed, err := confirmAction(
			fmt.Sprintf("Delete service %q from sandbox %q?", name, rigRef),
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

	if err := runmode.NewRemoteClient().DeleteSandboxService(rigRef, name); err != nil {
		return err
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), output.ItemResult{Name: name, Status: "deleted"})
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Service %q deleted\n", name)
	return nil
}

// printService renders a single created service as a one-row table
// (NAME/PORT/SCHEME/URL), using the same "-" placeholder as `service list`
// when no URL has been provisioned.
func printService(cmd *cobra.Command, svc *apiclient.SandboxServiceResource) {
	w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tPORT\tSCHEME\tURL")
	scheme := deref(svc.URLScheme)
	if scheme == "" {
		scheme = "-"
	}
	url := deref(svc.URL)
	if url == "" {
		url = "-"
	}
	fmt.Fprintf(w, "%s\t%d\t%s\t%s\n", svc.Name, svc.Port, scheme, url)
	w.Flush()
}

// serviceRow is one line of the `service list` table: a named service, the
// sandbox it belongs to, its port binding(s), and any generated URL(s).
type serviceRow struct {
	service     string
	sandboxName string
	ports       string
	url         string
}

var serviceListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List services across sandboxes",
	Args:    cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		rigName, _ := cmd.Flags().GetString("rig-name")

		// Validate --remote-target up front, unconditionally, matching the
		// sandbox command: a bad value fails the same way regardless of auth
		// state.
		if _, err := getServiceRemoteTarget(cmd); err != nil {
			return err
		}

		if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
			return err
		}

		var rows []serviceRow
		var err error
		if cmd.Flags().Changed("rig-name") && strings.TrimSpace(rigName) == "" {
			// An explicitly empty --rig-name names no rig, so it matches no
			// rig. An omitted filter continues to list every rig.
			rows = nil
		} else {
			rows, err = remoteServiceRows(rigName)
		}
		if err != nil {
			return err
		}

		format, err := output.FormatFrom(cmd)
		if err != nil {
			return err
		}
		if format.IsJSON() {
			items := make([]serviceListItem, 0, len(rows))
			for _, r := range rows {
				items = append(items, serviceListItem{
					Service: r.service,
					Sandbox: r.sandboxName,
					Ports:   r.ports,
					URL:     r.url,
				})
			}
			return format.JSON(cmd.OutOrStdout(), items)
		}

		if len(rows) == 0 {
			fmt.Fprintln(cmd.OutOrStdout(), "No services found.")
			return nil
		}

		w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
		fmt.Fprintln(w, "SERVICE\tSANDBOX\tPORTS\tURL")
		for _, r := range rows {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", r.service, r.sandboxName, r.ports, r.url)
		}
		w.Flush()
		return nil
	},
}

// remoteServiceRows fetches services from the remote API. The list endpoint
// returns each sandbox's provisioned services (name, port, and generated URL),
// so no local state is involved.
func remoteServiceRows(sandboxName string) ([]serviceRow, error) {
	sandboxes, err := runmode.NewRemoteClient().ListSandboxes()
	if err != nil {
		return nil, err
	}

	var rows []serviceRow
	for _, sb := range sandboxes {
		if sandboxName != "" && sb.Name != sandboxName {
			continue
		}
		rows = append(rows, groupRemoteServices(sb.Name, sb.Services)...)
	}
	return rows, nil
}

// groupRemoteServices collapses a sandbox's flat service entries into one row
// per service name, joining multiple ports/URLs the way the local path groups a
// ServiceInfo's ports. Order follows first appearance in the API response.
func groupRemoteServices(sandboxName string, services []apiclient.RemoteSandboxService) []serviceRow {
	var order []string
	byName := make(map[string]*serviceRow, len(services))
	for _, svc := range services {
		row, ok := byName[svc.Name]
		if !ok {
			row = &serviceRow{service: svc.Name, sandboxName: sandboxName}
			byName[svc.Name] = row
			order = append(order, svc.Name)
		}
		if row.ports == "" {
			row.ports = formatRemoteServicePort(svc)
		} else {
			row.ports += "," + formatRemoteServicePort(svc)
		}
		if svc.URL != "" {
			if row.url == "" {
				row.url = svc.URL
			} else {
				row.url += " " + svc.URL
			}
		}
	}

	rows := make([]serviceRow, 0, len(order))
	for _, name := range order {
		row := byName[name]
		if row.url == "" {
			row.url = "-"
		}
		rows = append(rows, *row)
	}
	return rows
}

// formatRemoteServicePort renders a remote service's published port binding as
// hostPort->containerPort/protocol, matching how `sandbox list -l` renders the
// same remote binding (see formatPortBindings). Remote sandboxes are reached
// via a generated URL rather than a host IP, so no host IP is shown.
func formatRemoteServicePort(svc apiclient.RemoteSandboxService) string {
	protocol := svc.Protocol
	if strings.TrimSpace(protocol) == "" {
		protocol = "tcp"
	}
	return fmt.Sprintf("%d->%d/%s", svc.HostPort, svc.ContainerPort, protocol)
}

// getServiceRemoteTarget mirrors the sandbox command's --remote-target
// validation: the flag is accepted but not yet supported.
func getServiceRemoteTarget(cmd *cobra.Command) (string, error) {
	target, _ := cmd.Flags().GetString("remote-target")
	if target != "" {
		return "", fmt.Errorf("--remote-target is not yet supported")
	}
	return target, nil
}

func init() {
	rootCmd.AddCommand(serviceCmd)
	serviceCmd.AddCommand(serviceListCmd)
	serviceCmd.AddCommand(serviceCreateCmd)
	serviceCmd.AddCommand(serviceDeleteCmd)
	serviceCmd.PersistentFlags().Bool("remote", true, "Operate on remote rigs; accepted as a no-op since rigs are always remote")
	serviceCmd.PersistentFlags().String("remote-target", "", "Operate on a specific named remote target")
	serviceCmd.PersistentFlags().MarkHidden("remote-target")
	serviceListCmd.Flags().String("rig-name", "", "Filter services to a specific rig")

	serviceCreateCmd.Flags().String("rig", "", "Rig to create the service on (name or id)")
	serviceCreateCmd.Flags().String("name", "", "Service name (a single DNS label)")
	serviceCreateCmd.Flags().Int("port", 0, "Container port the service listens on")
	serviceCreateCmd.Flags().String("url-scheme", "", "URL scheme for the generated URL: http or https")

	serviceDeleteCmd.Flags().String("rig", "", "Rig the service belongs to (name or id)")
	serviceDeleteCmd.Flags().String("name", "", "Name of the service to delete")
	serviceDeleteCmd.Flags().BoolP("force", "f", false, "Skip confirmation prompt")
}
