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

		var results []output.ItemResult
		if mode == runmode.Remote {
			remoteClient, err := getRemoteClient(target)
			if err != nil {
				return err
			}
			for _, name := range args {
				if remoteErr := remoteClient.StartSandbox(name); remoteErr != nil {
					results = append(results, batchError(name, remoteErr))
					continue
				}
				fmt.Fprintf(pw, "Sandbox %q starting...\n", name)
				if _, remoteErr := remoteClient.WaitForSandboxStart(name); remoteErr != nil {
					results = append(results, batchError(name, remoteErr))
				} else {
					fmt.Fprintf(pw, "Sandbox %q started (remote)\n", name)
					results = append(results, output.ItemResult{Name: name, Status: "started"})
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
					results = append(results, batchError(name, fmt.Errorf("sandbox %q not found", name)))
					continue
				}
				if info.Provider == "docker" {
					if err := sandbox.StartDockerSandbox(name); err != nil {
						results = append(results, batchError(name, err))
						continue
					}
				}
				fmt.Fprintf(pw, "Sandbox %q started\n", name)
				results = append(results, output.ItemResult{Name: name, Status: "started"})
			}
		}
		return finishBatch(cmd, format, results)
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

		var results []output.ItemResult
		if mode == runmode.Remote {
			remoteClient, err := getRemoteClient(target)
			if err != nil {
				return err
			}
			for _, name := range args {
				if remoteErr := remoteClient.StopSandbox(name); remoteErr != nil {
					results = append(results, batchError(name, remoteErr))
					continue
				}
				fmt.Fprintf(pw, "Sandbox %q stopping...\n", name)
				if _, remoteErr := remoteClient.WaitForSandboxStop(name); remoteErr != nil {
					results = append(results, batchError(name, remoteErr))
				} else {
					fmt.Fprintf(pw, "Sandbox %q stopped (remote)\n", name)
					results = append(results, output.ItemResult{Name: name, Status: "stopped"})
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
					results = append(results, batchError(name, fmt.Errorf("sandbox %q not found", name)))
					continue
				}
				if info.Provider == "docker" {
					if err := sandbox.StopDockerSandbox(name); err != nil {
						results = append(results, batchError(name, err))
						continue
					}
				}
				fmt.Fprintf(pw, "Sandbox %q stopped\n", name)
				results = append(results, output.ItemResult{Name: name, Status: "stopped"})
			}
		}
		return finishBatch(cmd, format, results)
	},
}

// batchError builds a failed ItemResult for one item in a batch command.
func batchError(name string, err error) output.ItemResult {
	return output.ItemResult{Name: name, Status: "error", Error: err.Error()}
}

// finishBatch emits the batch results as JSON when requested and returns a
// non-nil error (for a non-zero exit) if any item failed. In text mode the
// per-item progress has already been printed, so it only needs to surface the
// combined failure; in JSON mode the per-item errors are in the emitted array.
func finishBatch(cmd *cobra.Command, format output.Format, results []output.ItemResult) error {
	var failed []string
	for _, r := range results {
		if r.Status == "error" {
			failed = append(failed, fmt.Sprintf("sandbox %q: %s", r.Name, r.Error))
		}
	}
	if format.IsJSON() {
		if results == nil {
			results = []output.ItemResult{}
		}
		if err := format.JSON(cmd.OutOrStdout(), results); err != nil {
			return err
		}
		if len(failed) > 0 {
			return fmt.Errorf("%d of %d sandboxes failed; see JSON output", len(failed), len(results))
		}
		return nil
	}
	if len(failed) > 0 {
		return fmt.Errorf("%s", strings.Join(failed, "\n"))
	}
	return nil
}

// sandboxJSON is the stable JSON shape emitted by `sandbox list -o json`. It is
// defined here, decoupled from the internal amika.Sandbox type, so the CLI's
// JSON contract stays consistent (snake_case) with the other commands and does
// not shift if the internal type gains or renames fields.
type sandboxJSON struct {
	Name      string       `json:"name"`
	State     string       `json:"state"`
	Location  string       `json:"location"`
	Provider  string       `json:"provider,omitempty"`
	Image     string       `json:"image,omitempty"`
	Branch    string       `json:"branch,omitempty"`
	Repos     []string     `json:"repos"`
	Ports     []portJSON   `json:"ports"`
	CreatedBy *creatorJSON `json:"created_by,omitempty"`
	CreatedAt string       `json:"created_at"`
}

// portJSON is the JSON shape of a published port binding.
type portJSON struct {
	HostIP        string `json:"host_ip,omitempty"`
	HostPort      int    `json:"host_port"`
	ContainerPort int    `json:"container_port"`
	Protocol      string `json:"protocol,omitempty"`
}

// creatorJSON identifies the human who created a sandbox.
type creatorJSON struct {
	Name  string `json:"name,omitempty"`
	Email string `json:"email,omitempty"`
}

// sandboxListJSON maps internal sandbox records to the stable JSON shape. It
// always returns a non-nil slice so an empty result marshals as [] rather than
// null.
func sandboxListJSON(items []amika.Sandbox) []sandboxJSON {
	out := make([]sandboxJSON, 0, len(items))
	for _, sb := range items {
		ports := make([]portJSON, 0, len(sb.Ports))
		for _, p := range sb.Ports {
			ports = append(ports, portJSON{
				HostIP:        p.HostIP,
				HostPort:      p.HostPort,
				ContainerPort: p.ContainerPort,
				Protocol:      p.Protocol,
			})
		}
		var creator *creatorJSON
		if sb.CreatedBy != nil {
			creator = &creatorJSON{Name: sb.CreatedBy.Name, Email: sb.CreatedBy.Email}
		}
		repos := sb.Repos
		if repos == nil {
			repos = []string{}
		}
		out = append(out, sandboxJSON{
			Name:      sb.Name,
			State:     sb.State,
			Location:  sb.Location,
			Provider:  sb.Provider,
			Image:     sb.Image,
			Branch:    sb.Branch,
			Repos:     repos,
			Ports:     ports,
			CreatedBy: creator,
			CreatedAt: sb.CreatedAt,
		})
	}
	return out
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
					Repos:     repoNamesFromURL(rs.RepoURL),
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
			return format.JSON(cmd.OutOrStdout(), sandboxListJSON(allItems))
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
