package main

import (
	"bufio"
	"fmt"
	"regexp"
	"strings"
	"text/tabwriter"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/config"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/sandbox"
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
	sandboxRef, _ := cmd.Flags().GetString("sandbox")
	name, _ := cmd.Flags().GetString("name")
	port, _ := cmd.Flags().GetInt("port")
	urlScheme, _ := cmd.Flags().GetString("url-scheme")

	if strings.TrimSpace(sandboxRef) == "" {
		return fmt.Errorf("--sandbox is required")
	}
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("--name is required")
	}
	if port == 0 {
		return fmt.Errorf("--port is required")
	}
	if port < 1 || port > 65535 {
		return fmt.Errorf("invalid --port %d: must be between 1 and 65535", port)
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
	// list`: a bad value fails the same way regardless of mode or auth state.
	if _, err := getServiceRemoteTarget(cmd); err != nil {
		return err
	}

	mode := runmode.Resolve(cmd)
	if mode == runmode.Local {
		return fmt.Errorf("service create is only supported for remote sandboxes; omit --local (local sandbox services are declared in the repo config at creation time)")
	}
	if err := runmode.RequireAuth(mode, runmode.DefaultAuthChecker); err != nil {
		return err
	}

	svc, err := runmode.NewRemoteClient().CreateSandboxService(sandboxRef, apiclient.SandboxServiceRequest{
		Name:      name,
		Port:      port,
		URLScheme: urlScheme,
	})
	if err != nil {
		return err
	}
	printService(cmd, svc)
	return nil
}

func runServiceDelete(cmd *cobra.Command, _ []string) error {
	sandboxRef, _ := cmd.Flags().GetString("sandbox")
	name, _ := cmd.Flags().GetString("name")
	force, _ := cmd.Flags().GetBool("force")

	if strings.TrimSpace(sandboxRef) == "" {
		return fmt.Errorf("--sandbox is required")
	}
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("--name is required")
	}

	// Validate --remote-target up front, unconditionally, matching `service
	// list`: a bad value fails the same way regardless of mode or auth state.
	if _, err := getServiceRemoteTarget(cmd); err != nil {
		return err
	}

	mode := runmode.Resolve(cmd)
	if mode == runmode.Local {
		return fmt.Errorf("service delete is only supported for remote sandboxes; omit --local (local sandbox services are declared in the repo config at creation time)")
	}
	if err := runmode.RequireAuth(mode, runmode.DefaultAuthChecker); err != nil {
		return err
	}

	if !force {
		reader := bufio.NewReader(cmd.InOrStdin())
		confirmed, err := confirmAction(
			fmt.Sprintf("Delete service %q from sandbox %q?", name, sandboxRef),
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

	if err := runmode.NewRemoteClient().DeleteSandboxService(sandboxRef, name); err != nil {
		return err
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Service %q deleted\n", name)
	return nil
}

// printService renders a single created/updated service as a one-row table,
// matching the columns of `service list`.
func printService(cmd *cobra.Command, svc *apiclient.SandboxServiceResource) {
	w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tPORT\tSCHEME\tURL")
	url := deref(svc.URL)
	if url == "" {
		url = "-"
	}
	fmt.Fprintf(w, "%s\t%d\t%s\t%s\n", svc.Name, svc.Port, svc.URLScheme, url)
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
		sandboxName, _ := cmd.Flags().GetString("sandbox-name")

		// Validate --remote-target up front, unconditionally, matching the
		// sandbox command: a bad value fails the same way regardless of mode or
		// auth state, rather than being silently ignored in local mode.
		if _, err := getServiceRemoteTarget(cmd); err != nil {
			return err
		}

		mode := runmode.Resolve(cmd)
		if err := runmode.RequireAuth(mode, runmode.DefaultAuthChecker); err != nil {
			return err
		}

		var rows []serviceRow
		var err error
		if mode == runmode.Remote {
			rows, err = remoteServiceRows(sandboxName)
		} else {
			rows, err = localServiceRows(sandboxName)
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

// localServiceRows reads services from the local sandbox state file.
func localServiceRows(sandboxName string) ([]serviceRow, error) {
	sandboxesFile, err := config.SandboxesStateFile()
	if err != nil {
		return nil, err
	}
	store := sandbox.NewStore(sandboxesFile)
	sandboxes, err := store.List()
	if err != nil {
		return nil, err
	}

	var rows []serviceRow
	for _, sb := range sandboxes {
		if sandboxName != "" && sb.Name != sandboxName {
			continue
		}
		for _, svc := range sb.Services {
			portStrs := make([]string, 0, len(svc.Ports))
			var urls []string
			for _, p := range svc.Ports {
				portStrs = append(portStrs, formatPortBinding(p.PortBinding))
				if p.URL != "" {
					urls = append(urls, p.URL)
				}
			}
			urlStr := "-"
			if len(urls) > 0 {
				urlStr = strings.Join(urls, " ")
			}
			rows = append(rows, serviceRow{
				service:     svc.Name,
				sandboxName: sb.Name,
				ports:       strings.Join(portStrs, ","),
				url:         urlStr,
			})
		}
	}
	return rows, nil
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
	serviceCmd.PersistentFlags().Bool("local", false, "Only operate on local sandboxes")
	serviceCmd.PersistentFlags().Bool("remote", false, "Only operate on remote sandboxes")
	serviceCmd.PersistentFlags().String("remote-target", "", "Operate on a specific named remote target")
	serviceCmd.PersistentFlags().MarkHidden("remote-target")
	serviceListCmd.Flags().String("sandbox-name", "", "Filter services to a specific sandbox")

	serviceCreateCmd.Flags().String("sandbox", "", "Sandbox to create the service on (name or id)")
	serviceCreateCmd.Flags().String("name", "", "Service name (a single DNS label)")
	serviceCreateCmd.Flags().Int("port", 0, "Container port the service listens on")
	serviceCreateCmd.Flags().String("url-scheme", "", "URL scheme for the generated URL: http or https")

	serviceDeleteCmd.Flags().String("sandbox", "", "Sandbox the service belongs to (name or id)")
	serviceDeleteCmd.Flags().String("name", "", "Name of the service to delete")
	serviceDeleteCmd.Flags().BoolP("force", "f", false, "Skip confirmation prompt")
}
