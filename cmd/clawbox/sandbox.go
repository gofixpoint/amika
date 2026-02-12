package main

import (
	"fmt"
	"text/tabwriter"
	"time"

	"github.com/gofixpoint/clawbox/internal/sandbox"
	"github.com/spf13/cobra"
)

const sandboxStoreDir = ".clawbox"

var sandboxCmd = &cobra.Command{
	Use:   "sandbox",
	Short: "Manage sandboxes",
	Long:  `Create and delete sandboxed environments backed by container providers.`,
}

var sandboxCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a new sandbox",
	Long:  `Create a new sandbox using the specified provider. Currently only "docker" is supported.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true

		provider, _ := cmd.Flags().GetString("provider")
		name, _ := cmd.Flags().GetString("name")
		image, _ := cmd.Flags().GetString("image")

		if provider != "docker" {
			return fmt.Errorf("unsupported provider %q: only \"docker\" is supported", provider)
		}

		store := sandbox.NewSandboxStore(sandboxStoreDir)

		// Generate a name if not provided
		if name == "" {
			for {
				name = sandbox.GenerateName()
				if _, err := store.Get(name); err != nil {
					break // name is available
				}
			}
		} else if _, err := store.Get(name); err == nil {
			return fmt.Errorf("sandbox %q already exists", name)
		}

		containerID, err := sandbox.CreateDockerSandbox(name, image)
		if err != nil {
			return err
		}

		info := sandbox.SandboxInfo{
			Name:        name,
			Provider:    provider,
			ContainerID: containerID,
			Image:       image,
			CreatedAt:   time.Now().UTC().Format(time.RFC3339),
		}
		if err := store.Save(info); err != nil {
			return fmt.Errorf("sandbox created but failed to save state: %w", err)
		}

		fmt.Printf("Sandbox %q created (container %s)\n", name, containerID[:12])
		return nil
	},
}

var sandboxDeleteCmd = &cobra.Command{
	Use:   "delete",
	Short: "Delete a sandbox",
	Long:  `Delete a sandbox and remove its backing container.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true

		name, _ := cmd.Flags().GetString("name")

		store := sandbox.NewSandboxStore(sandboxStoreDir)

		info, err := store.Get(name)
		if err != nil {
			return fmt.Errorf("sandbox %q not found", name)
		}

		if info.Provider == "docker" {
			if err := sandbox.RemoveDockerSandbox(name); err != nil {
				return err
			}
		}

		if err := store.Remove(name); err != nil {
			return fmt.Errorf("container removed but failed to update state: %w", err)
		}

		fmt.Printf("Sandbox %q deleted\n", name)
		return nil
	},
}

var sandboxListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all sandboxes",
	RunE: func(cmd *cobra.Command, args []string) error {
		store := sandbox.NewSandboxStore(sandboxStoreDir)

		sandboxes, err := store.List()
		if err != nil {
			return err
		}

		if len(sandboxes) == 0 {
			fmt.Println("No sandboxes found.")
			return nil
		}

		w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
		fmt.Fprintln(w, "NAME\tPROVIDER\tIMAGE\tCREATED")
		for _, sb := range sandboxes {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", sb.Name, sb.Provider, sb.Image, sb.CreatedAt)
		}
		w.Flush()
		return nil
	},
}

func init() {
	rootCmd.AddCommand(sandboxCmd)
	sandboxCmd.AddCommand(sandboxCreateCmd)
	sandboxCmd.AddCommand(sandboxDeleteCmd)
	sandboxCmd.AddCommand(sandboxListCmd)

	// Create flags
	sandboxCreateCmd.Flags().String("provider", "docker", "Sandbox provider")
	sandboxCreateCmd.Flags().String("name", "", "Name for the sandbox (auto-generated if not set)")
	sandboxCreateCmd.Flags().String("image", "ubuntu:latest", "Docker image to use")

	// Delete flags
	sandboxDeleteCmd.Flags().String("name", "", "Name of the sandbox to delete (required)")
	sandboxDeleteCmd.MarkFlagRequired("name")
}
