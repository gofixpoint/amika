package main

import (
	"fmt"
	"strings"
	"text/tabwriter"

	"github.com/gofixpoint/amika/internal/config"
	"github.com/gofixpoint/amika/internal/sandbox"
	"github.com/spf13/cobra"
)

var serviceCmd = &cobra.Command{
	Use:   "service",
	Short: "Manage sandbox services",
	Long:  `View and manage declared services and their port bindings across sandboxes.`,
}

var serviceListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List services across sandboxes",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		sandboxName, _ := cmd.Flags().GetString("sandbox-name")

		sandboxesFile, err := config.SandboxesStateFile()
		if err != nil {
			return err
		}
		store := sandbox.NewStore(sandboxesFile)
		sandboxes, err := store.List()
		if err != nil {
			return err
		}

		type serviceRow struct {
			service     string
			sandboxName string
			ports       string
			url         string
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

func init() {
	rootCmd.AddCommand(serviceCmd)
	serviceCmd.AddCommand(serviceListCmd)
	serviceListCmd.Flags().String("sandbox-name", "", "Filter services to a specific sandbox")
}
