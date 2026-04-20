package sandboxcmd

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"text/tabwriter"

	"github.com/gofixpoint/amika/internal/config"
	"github.com/gofixpoint/amika/internal/runmode"
	"github.com/gofixpoint/amika/internal/sandbox"
	"github.com/gofixpoint/amika/pkg/amika"
	"github.com/spf13/cobra"
)

var runSandboxConnect = func(name, shell string, stdin io.Reader, stdout, stderr io.Writer) error {
	dockerArgs := buildSandboxConnectArgs(name, shell)
	dockerCmd := exec.Command("docker", dockerArgs...)
	dockerCmd.Stdin = stdin
	dockerCmd.Stdout = stdout
	dockerCmd.Stderr = stderr
	return dockerCmd.Run()
}

var sandboxStartCmd = &cobra.Command{
	Use:   "start <name> [<name>...]",
	Short: "Start one or more stopped sandboxes",
	Long:  `Start (resume) one or more stopped sandboxes.`,
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true

		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		mode := runmode.Resolve(cmd)
		if err := runmode.RequireAuth(mode, defaultAuthChecker); err != nil {
			return err
		}

		var errs []string
		if mode == runmode.Remote {
			remoteClient, err := getRemoteClient(target)
			if err != nil {
				return err
			}
			for _, name := range args {
				if remoteErr := remoteClient.StartSandbox(name); remoteErr != nil {
					errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, remoteErr))
					continue
				}
				fmt.Printf("Sandbox %q starting...\n", name)
				if _, remoteErr := remoteClient.WaitForSandboxStart(name); remoteErr != nil {
					errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, remoteErr))
				} else {
					fmt.Printf("Sandbox %q started (remote)\n", name)
				}
			}
		} else {
			sandboxesFile, err := config.SandboxesStateFile()
			if err != nil {
				return err
			}
			store := sandbox.NewStore(sandboxesFile)
			for _, name := range args {
				info, localErr := store.Get(name)
				if localErr != nil {
					errs = append(errs, fmt.Sprintf("sandbox %q not found", name))
					continue
				}
				if info.Provider == "docker" {
					if err := sandbox.StartDockerSandbox(name); err != nil {
						errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, err))
						continue
					}
				}
				fmt.Printf("Sandbox %q started\n", name)
			}
		}
		if len(errs) > 0 {
			return fmt.Errorf("%s", strings.Join(errs, "\n"))
		}
		return nil
	},
}

var sandboxStopCmd = &cobra.Command{
	Use:   "stop <name> [<name>...]",
	Short: "Stop one or more sandboxes",
	Long:  `Stop one or more running sandboxes without removing them.`,
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true

		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		mode := runmode.Resolve(cmd)
		if err := runmode.RequireAuth(mode, defaultAuthChecker); err != nil {
			return err
		}

		var errs []string
		if mode == runmode.Remote {
			remoteClient, err := getRemoteClient(target)
			if err != nil {
				return err
			}
			for _, name := range args {
				if remoteErr := remoteClient.StopSandbox(name); remoteErr != nil {
					errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, remoteErr))
					continue
				}
				fmt.Printf("Sandbox %q stopping...\n", name)
				if _, remoteErr := remoteClient.WaitForSandboxStop(name); remoteErr != nil {
					errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, remoteErr))
				} else {
					fmt.Printf("Sandbox %q stopped (remote)\n", name)
				}
			}
		} else {
			sandboxesFile, err := config.SandboxesStateFile()
			if err != nil {
				return err
			}
			store := sandbox.NewStore(sandboxesFile)
			for _, name := range args {
				info, localErr := store.Get(name)
				if localErr != nil {
					errs = append(errs, fmt.Sprintf("sandbox %q not found", name))
					continue
				}
				if info.Provider == "docker" {
					if err := sandbox.StopDockerSandbox(name); err != nil {
						errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, err))
						continue
					}
				}
				fmt.Printf("Sandbox %q stopped\n", name)
			}
		}
		if len(errs) > 0 {
			return fmt.Errorf("%s", strings.Join(errs, "\n"))
		}
		return nil
	},
}

var sandboxListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List all sandboxes",
	Args:    cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		mode := runmode.Resolve(cmd)
		if err := runmode.RequireAuth(mode, defaultAuthChecker); err != nil {
			return err
		}

		var allItems []amika.Sandbox

		if mode == runmode.Local {
			result, err := amika.NewService(amika.Options{}).ListSandboxes(cmd.Context(), amika.ListSandboxesRequest{})
			if err != nil {
				return err
			}
			for i := range result.Items {
				result.Items[i].Location = "local"
				if result.Items[i].Provider == "docker" {
					state, err := sandbox.GetDockerContainerState(result.Items[i].Name)
					if err != nil {
						result.Items[i].State = "unknown"
					} else {
						result.Items[i].State = state
					}
				}
			}
			allItems = append(allItems, result.Items...)
		} else {
			client, err := getRemoteClient(target)
			if err != nil {
				return err
			}
			remoteSandboxes, err := client.ListSandboxes()
			if err != nil {
				return err
			}
			for _, rs := range remoteSandboxes {
				allItems = append(allItems, amika.Sandbox{
					Name:      rs.Name,
					State:     rs.State,
					Provider:  rs.Provider,
					CreatedAt: rs.CreatedAt,
					Location:  "remote",
					Branch:    rs.Branch,
				})
			}
		}

		if len(allItems) == 0 {
			fmt.Println("No sandboxes found.")
			return nil
		}

		w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
		fmt.Fprintln(w, "NAME\tSTATE\tLOCATION\tPROVIDER\tIMAGE\tBRANCH\tPORTS\tCREATED")
		for _, sb := range allItems {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", sb.Name, sb.State, sb.Location, sb.Provider, sb.Image, sb.Branch, formatPortBindings(sb.Ports), sb.CreatedAt)
		}
		w.Flush()
		return nil
	},
}

var sandboxConnectCmd = &cobra.Command{
	Use:   "connect <name>",
	Short: "Connect to a sandbox console",
	Long:  `Connect to a running sandbox container and open an interactive shell.`,
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true

		name := args[0]
		shell, _ := cmd.Flags().GetString("shell")
		if err := validateShell(shell); err != nil {
			return err
		}

		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		mode := runmode.Resolve(cmd)
		if err := runmode.RequireAuth(mode, defaultAuthChecker); err != nil {
			return err
		}

		if mode == runmode.Local {
			sandboxesFile, err := config.SandboxesStateFile()
			if err != nil {
				return err
			}
			store := sandbox.NewStore(sandboxesFile)
			info, err := store.Get(name)
			if err != nil {
				return fmt.Errorf("sandbox %q not found", name)
			}
			if info.Provider != "docker" {
				return fmt.Errorf("unsupported local provider %q: only \"docker\" is supported", info.Provider)
			}
			if err := runSandboxConnect(name, shell, os.Stdin, os.Stdout, os.Stderr); err != nil {
				return fmt.Errorf("failed to connect to sandbox %q with shell %q: %w", name, shell, err)
			}
			return nil
		}

		client, err := getRemoteClient(target)
		if err != nil {
			return err
		}
		return execSSH(client, name, false, nil)
	},
}

func validateShell(shell string) error {
	if strings.TrimSpace(shell) == "" {
		return fmt.Errorf("--shell must not be empty")
	}
	return nil
}

func buildSandboxConnectArgs(name, shell string) []string {
	return []string{"exec", "-it", "-w", sandboxConnectWorkdir, name, shell}
}
