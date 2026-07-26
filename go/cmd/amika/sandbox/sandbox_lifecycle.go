package sandboxcmd

// sandbox_lifecycle.go implements start, stop, list, and connect commands.

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"text/tabwriter"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/config"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/sandbox"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/gofixpoint/amika/go/pkg/amika"
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
		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		mode := runmode.Resolve(cmd)
		if err := runmode.RequireAuth(mode, runmode.DefaultAuthChecker); err != nil {
			return err
		}

		format, err := output.FormatFrom(cmd)
		if err != nil {
			return err
		}
		pw := format.Progress(cmd.OutOrStdout())

		// items carries the JSON payload for -o json: the target's final Sandbox
		// (API shape) on success, or an output.ItemResult{status:"error",...} on
		// failure (there is no resource to report for a target that never
		// started) — see finishBatch and decision 3 in the output-format work
		// ("batch start/stop emit an array of final resources").
		var items []any
		var failed []string
		if mode == runmode.Remote {
			remoteClient, err := getRemoteClient(target)
			if err != nil {
				return err
			}
			for _, name := range args {
				if remoteErr := remoteClient.StartSandbox(name); remoteErr != nil {
					appendBatchFailure(&items, &failed, name, remoteErr)
					continue
				}
				fmt.Fprintf(pw, "Sandbox %q starting...\n", name)
				polled, remoteErr := remoteClient.WaitForSandboxStart(name)
				if remoteErr != nil {
					appendBatchFailure(&items, &failed, name, remoteErr)
					continue
				}
				fmt.Fprintf(pw, "Sandbox %q started (remote)\n", name)
				items = append(items, normalizeSandboxJSON(*polled))
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
					appendBatchFailure(&items, &failed, name, fmt.Errorf("sandbox %q not found", name))
					continue
				}
				state := "running"
				if info.Provider == "docker" {
					if err := sandbox.StartDockerSandbox(name); err != nil {
						appendBatchFailure(&items, &failed, name, err)
						continue
					}
					state = localDockerState(name)
				}
				fmt.Fprintf(pw, "Sandbox %q started\n", name)
				items = append(items, normalizeSandboxJSON(remoteSandboxFromInfo(info, state)))
			}
		}
		return finishBatch(cmd, format, items, failed)
	},
}

var sandboxStopCmd = &cobra.Command{
	Use:   "stop <name> [<name>...]",
	Short: "Stop one or more sandboxes",
	Long:  `Stop one or more running sandboxes without removing them.`,
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		mode := runmode.Resolve(cmd)
		if err := runmode.RequireAuth(mode, runmode.DefaultAuthChecker); err != nil {
			return err
		}

		format, err := output.FormatFrom(cmd)
		if err != nil {
			return err
		}
		pw := format.Progress(cmd.OutOrStdout())

		// items carries the JSON payload for -o json: see the matching comment
		// in sandboxStartCmd.
		var items []any
		var failed []string
		if mode == runmode.Remote {
			remoteClient, err := getRemoteClient(target)
			if err != nil {
				return err
			}
			for _, name := range args {
				if remoteErr := remoteClient.StopSandbox(name); remoteErr != nil {
					appendBatchFailure(&items, &failed, name, remoteErr)
					continue
				}
				fmt.Fprintf(pw, "Sandbox %q stopping...\n", name)
				polled, remoteErr := remoteClient.WaitForSandboxStop(name)
				if remoteErr != nil {
					appendBatchFailure(&items, &failed, name, remoteErr)
					continue
				}
				fmt.Fprintf(pw, "Sandbox %q stopped (remote)\n", name)
				items = append(items, normalizeSandboxJSON(*polled))
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
					appendBatchFailure(&items, &failed, name, fmt.Errorf("sandbox %q not found", name))
					continue
				}
				state := "stopped"
				if info.Provider == "docker" {
					if err := sandbox.StopDockerSandbox(name); err != nil {
						appendBatchFailure(&items, &failed, name, err)
						continue
					}
					state = localDockerState(name)
				}
				fmt.Fprintf(pw, "Sandbox %q stopped\n", name)
				items = append(items, normalizeSandboxJSON(remoteSandboxFromInfo(info, state)))
			}
		}
		return finishBatch(cmd, format, items, failed)
	},
}

// batchError builds a failed ItemResult for one item in a batch command.
func batchError(name string, err error) output.ItemResult {
	return output.ItemResult{Name: name, Status: "error", Error: err.Error()}
}

// localDockerState reads a local Docker sandbox's live container state (e.g.
// "running", "exited"), falling back to "unknown" if the state cannot be
// determined (matching `sandbox list`'s treatment of the same failure).
func localDockerState(name string) string {
	state, err := sandbox.GetDockerContainerState(name)
	if err != nil {
		return "unknown"
	}
	return state
}

// appendBatchFailure records one failed batch item both in items (the JSON
// payload, as an output.ItemResult) and in failed (the text-mode combined
// error message), keeping the two in sync as sandbox start/stop build up
// their mixed-shape result array.
func appendBatchFailure(items *[]any, failed *[]string, name string, err error) {
	*items = append(*items, batchError(name, err))
	*failed = append(*failed, fmt.Sprintf("sandbox %q: %s", name, err.Error()))
}

// finishBatch emits items as the JSON array for `-o json`/`-o json-pretty` and
// returns a non-nil error (for a non-zero exit) if any item failed; failed
// carries the human-readable per-item failure messages used to build the
// text-mode combined error. In text mode the per-item progress has already
// been printed, so it only needs to surface the combined failure; in JSON
// mode each element of items carries its own per-item detail (see
// appendBatchFailure and the sandbox start/stop RunE bodies for the mixed
// success/failure shape).
func finishBatch(cmd *cobra.Command, format output.Format, items []any, failed []string) error {
	if format.IsJSON() {
		if items == nil {
			items = []any{}
		}
		if err := format.JSON(cmd.OutOrStdout(), items); err != nil {
			return err
		}
		if len(failed) > 0 {
			return fmt.Errorf("%d of %d sandboxes failed; see JSON output", len(failed), len(items))
		}
		return nil
	}
	if len(failed) > 0 {
		return fmt.Errorf("%s", strings.Join(failed, "\n"))
	}
	return nil
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
		if err := runmode.RequireAuth(mode, runmode.DefaultAuthChecker); err != nil {
			return err
		}

		var allItems []amika.Sandbox
		// jsonItems mirrors the API's ListSandboxesResponse shape (an array of
		// Sandbox) for -o json, per the unification decision: local sandboxes are
		// emitted in the same shape as remote ones (see remoteSandboxFromPublic),
		// rather than the CLI-only DTO previously used here.
		var jsonItems []apiclient.RemoteSandbox

		if mode == runmode.Local {
			result, err := amika.NewService(amika.Options{}).ListSandboxes(cmd.Context(), amika.ListSandboxesRequest{})
			if err != nil {
				return err
			}
			for i := range result.Items {
				result.Items[i].Location = "local"
				if result.Items[i].Provider == "docker" {
					result.Items[i].State = localDockerState(result.Items[i].Name)
				}
			}
			allItems = append(allItems, result.Items...)
			for _, sb := range result.Items {
				jsonItems = append(jsonItems, remoteSandboxFromPublic(sb))
			}
		} else {
			client, err := getRemoteClient(target)
			if err != nil {
				return err
			}
			remoteSandboxes, err := client.ListSandboxes()
			if err != nil {
				return err
			}
			jsonItems = remoteSandboxes
			for _, rs := range remoteSandboxes {
				allItems = append(allItems, amika.Sandbox{
					Name:      rs.Name,
					State:     rs.State,
					Provider:  deref(rs.Provider),
					CreatedAt: rs.CreatedAt,
					Location:  "remote",
					Branch:    deref(rs.Branch),
					Repos:     repoNamesFromURL(deref(rs.RepoURL)),
					Ports:     portBindingsFromRemoteServices(rs.Services),
					CreatedBy: creatorFromRemote(rs.CreatedBy),
				})
			}
		}

		format, err := output.FormatFrom(cmd)
		if err != nil {
			return err
		}
		if format.IsJSON() {
			if jsonItems == nil {
				jsonItems = []apiclient.RemoteSandbox{}
			}
			return format.JSON(cmd.OutOrStdout(), jsonItems)
		}

		if len(allItems) == 0 {
			fmt.Println("No sandboxes found.")
			return nil
		}

		long, err := cmd.Flags().GetBool("long")
		if err != nil {
			return err
		}

		w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
		if long {
			fmt.Fprintln(w, "NAME\tSTATE\tLOCATION\tIMAGE\tBRANCH\tREPO\tCREATOR\tPORTS\tCREATED")
			for _, sb := range allItems {
				fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", sb.Name, sb.State, sb.Location, sb.Image, sb.Branch, formatRepos(sb.Repos), formatCreatedBy(sb.CreatedBy), formatPortBindings(sb.Ports), sb.CreatedAt)
			}
		} else {
			fmt.Fprintln(w, "NAME\tSTATE\tLOCATION\tBRANCH\tREPO\tCREATOR\tCREATED")
			for _, sb := range allItems {
				fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", sb.Name, sb.State, sb.Location, sb.Branch, formatRepos(sb.Repos), formatCreatedBy(sb.CreatedBy), sb.CreatedAt)
			}
		}
		w.Flush()
		return nil
	},
}

// portBindingsFromRemoteServices derives the published port bindings of a
// remote sandbox from its provisioned services, so `sandbox list -l` can show a
// PORTS column instead of "-". Remote sandboxes have no host IP (services are
// reached via generated URLs), so HostIP is left empty and formatPortBindings
// omits it.
func portBindingsFromRemoteServices(services []apiclient.RemoteSandboxService) []amika.PortBinding {
	if len(services) == 0 {
		return nil
	}
	ports := make([]amika.PortBinding, 0, len(services))
	for _, svc := range services {
		ports = append(ports, amika.PortBinding{
			HostPort:      svc.HostPort,
			ContainerPort: svc.ContainerPort,
			Protocol:      svc.Protocol,
		})
	}
	return ports
}

func creatorFromRemote(c *apiclient.RemoteSandboxCreator) *amika.SandboxCreator {
	if c == nil {
		return nil
	}
	out := &amika.SandboxCreator{}
	if c.Name != nil {
		out.Name = *c.Name
	}
	if c.Email != nil {
		out.Email = *c.Email
	}
	return out
}

func formatCreatedBy(c *amika.SandboxCreator) string {
	if c == nil {
		return "-"
	}
	if c.Name != "" {
		return c.Name
	}
	if c.Email != "" {
		return c.Email
	}
	return "-"
}

func formatRepos(repos []string) string {
	if len(repos) == 0 {
		return ""
	}
	return strings.Join(repos, ",")
}

func repoNamesFromURL(repoURL string) []string {
	repoURL = strings.TrimSpace(repoURL)
	if repoURL == "" {
		return nil
	}
	name := repoBasenameFromURL(repoURL)
	if name == "" {
		return nil
	}
	return []string{name}
}

func repoBasenameFromURL(repoURL string) string {
	p := strings.TrimRight(repoURL, "/")
	if i := strings.LastIndex(p, "://"); i >= 0 {
		p = p[i+3:]
	}
	if i := strings.LastIndex(p, ":"); i >= 0 {
		// SCP-style or URL with port; take what's after the last colon as path.
		p = p[i+1:]
	}
	if i := strings.LastIndex(p, "/"); i >= 0 {
		p = p[i+1:]
	}
	return strings.TrimSuffix(p, ".git")
}

var sandboxConnectCmd = &cobra.Command{
	Use:   "connect <name>",
	Short: "Connect to a sandbox console",
	Long:  `Connect to a running sandbox container and open an interactive shell.`,
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]
		// connect opens an interactive shell, so it has no JSON result.
		if err := output.RejectJSON(cmd); err != nil {
			return err
		}
		shell, _ := cmd.Flags().GetString("shell")
		if err := validateShell(shell); err != nil {
			return err
		}

		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		mode := runmode.Resolve(cmd)
		if err := runmode.RequireAuth(mode, runmode.DefaultAuthChecker); err != nil {
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
		return ssh.ExecSSH(client, name, false, nil)
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
