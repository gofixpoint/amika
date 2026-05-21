package main

import (
	"fmt"
	"strings"
	"text/tabwriter"

	"github.com/gofixpoint/amika/pkg/amika"
	"github.com/spf13/cobra"
)

// parseSandboxPath splits "sandbox:/path" into (sandboxName, containerPath).
// The container path must be absolute (start with /).
func parseSandboxPath(arg string) (string, string, error) {
	idx := strings.Index(arg, ":")
	if idx < 0 {
		return "", "", fmt.Errorf("invalid format %q: expected <sandbox>:<path>", arg)
	}
	name := arg[:idx]
	path := arg[idx+1:]
	if name == "" {
		return "", "", fmt.Errorf("sandbox name is required in %q", arg)
	}
	if path == "" {
		return "", "", fmt.Errorf("path is required in %q", arg)
	}
	if !strings.HasPrefix(path, "/") {
		return "", "", fmt.Errorf("container path must be absolute (start with /): %q", path)
	}
	return name, path, nil
}

var sandboxCpCmd = &cobra.Command{
	Use:   "cp <sandbox>:<container-path> <host-path>",
	Short: "Copy files from a sandbox to the host",
	Long:  `Copy a file or directory from a sandbox container to the local filesystem.`,
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true
		name, containerPath, err := parseSandboxPath(args[0])
		if err != nil {
			return err
		}
		hostPath := args[1]
		svc := amika.NewService(amika.Options{})
		_, err = svc.CopyFromSandbox(cmd.Context(), amika.CopyFromSandboxRequest{
			Name:          name,
			ContainerPath: containerPath,
			HostPath:      hostPath,
		})
		if err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Copied %s:%s → %s\n", name, containerPath, hostPath)
		return nil
	},
}

var sandboxLsCmd = &cobra.Command{
	Use:   "ls <sandbox>:<path>",
	Short: "List directory contents in a sandbox",
	Long:  `List files and directories at the given path inside a running sandbox.`,
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true
		name, path, err := parseSandboxPath(args[0])
		if err != nil {
			return err
		}
		svc := amika.NewService(amika.Options{})
		result, err := svc.SandboxLs(cmd.Context(), amika.SandboxLsRequest{
			Name: name,
			Path: path,
		})
		if err != nil {
			return err
		}
		if len(result.Entries) == 0 {
			fmt.Fprintln(cmd.OutOrStdout(), "(empty)")
			return nil
		}
		w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
		fmt.Fprintln(w, "NAME\tSIZE\tMODE\tMODIFIED\tTYPE")
		for _, e := range result.Entries {
			typ := "file"
			if e.IsDir {
				typ = "dir"
			}
			fmt.Fprintf(w, "%s\t%d\t%s\t%s\t%s\n", e.Name, e.Size, e.Mode, e.ModTime, typ)
		}
		w.Flush()
		return nil
	},
}

var sandboxCatCmd = &cobra.Command{
	Use:   "cat <sandbox>:<path>",
	Short: "Print file contents from a sandbox",
	Long:  `Read and print the contents of a file inside a running sandbox (10MB limit).`,
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true
		name, path, err := parseSandboxPath(args[0])
		if err != nil {
			return err
		}
		maxBytes, _ := cmd.Flags().GetInt64("max-bytes")
		svc := amika.NewService(amika.Options{})
		result, err := svc.SandboxCat(cmd.Context(), amika.SandboxCatRequest{
			Name:     name,
			Path:     path,
			MaxBytes: maxBytes,
		})
		if err != nil {
			return err
		}
		fmt.Fprint(cmd.OutOrStdout(), result.Content)
		return nil
	},
}

var sandboxRmCmd = &cobra.Command{
	Use:   "rm <sandbox>:<path>",
	Short: "Remove files from a sandbox",
	Long:  `Delete a file or directory inside a running sandbox.`,
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true
		name, path, err := parseSandboxPath(args[0])
		if err != nil {
			return err
		}
		recursive, _ := cmd.Flags().GetBool("recursive")
		force, _ := cmd.Flags().GetBool("force")
		svc := amika.NewService(amika.Options{})
		_, err = svc.SandboxRm(cmd.Context(), amika.SandboxRmRequest{
			Name:      name,
			Path:      path,
			Recursive: recursive,
			Force:     force,
		})
		if err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Removed %s:%s\n", name, path)
		return nil
	},
}

var sandboxStatCmd = &cobra.Command{
	Use:   "stat <sandbox>:<path>",
	Short: "Show file metadata from a sandbox",
	Long:  `Display file or directory metadata (size, permissions, modification time) from a running sandbox.`,
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true
		name, path, err := parseSandboxPath(args[0])
		if err != nil {
			return err
		}
		svc := amika.NewService(amika.Options{})
		result, err := svc.SandboxStat(cmd.Context(), amika.SandboxStatRequest{
			Name: name,
			Path: path,
		})
		if err != nil {
			return err
		}
		info := result.Info
		typ := "file"
		if info.IsDir {
			typ = "directory"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "  Name: %s\n", info.Name)
		fmt.Fprintf(cmd.OutOrStdout(), "  Size: %d\n", info.Size)
		fmt.Fprintf(cmd.OutOrStdout(), "  Mode: %s\n", info.Mode)
		fmt.Fprintf(cmd.OutOrStdout(), "  Type: %s\n", typ)
		fmt.Fprintf(cmd.OutOrStdout(), "Modified: %s\n", info.ModTime)
		return nil
	},
}

func init() {
	sandboxCmd.AddCommand(sandboxCpCmd)
	sandboxCmd.AddCommand(sandboxLsCmd)
	sandboxCmd.AddCommand(sandboxCatCmd)
	sandboxCmd.AddCommand(sandboxRmCmd)
	sandboxCmd.AddCommand(sandboxStatCmd)

	sandboxCatCmd.Flags().Int64("max-bytes", 0, "Maximum bytes to read (default 10MB)")
	sandboxRmCmd.Flags().BoolP("recursive", "r", false, "Remove directories and their contents recursively")
	sandboxRmCmd.Flags().BoolP("force", "f", false, "Ignore nonexistent files, never prompt")
}