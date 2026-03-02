package main

import (
	"fmt"
	"strings"
	"text/tabwriter"

	"github.com/gofixpoint/amika/internal/config"
	"github.com/gofixpoint/amika/internal/sandbox"
	"github.com/spf13/cobra"
)

var volumeCmd = &cobra.Command{
	Use:   "volume",
	Short: "Manage tracked sandbox volumes",
}

var volumeListCmd = &cobra.Command{
	Use:   "list",
	Short: "List tracked volumes",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		volumesFile, err := config.VolumesStateFile()
		if err != nil {
			return err
		}
		store := sandbox.NewVolumeStore(volumesFile)

		volumes, err := store.List()
		if err != nil {
			return err
		}
		if len(volumes) == 0 {
			fmt.Fprintln(cmd.OutOrStdout(), "No volumes found.")
			return nil
		}

		w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
		fmt.Fprintln(w, "NAME\tCREATED\tIN_USE\tSANDBOXES\tSOURCE")
		for _, v := range volumes {
			inUse := "no"
			if len(v.SandboxRefs) > 0 {
				inUse = "yes"
			}
			fmt.Fprintf(
				w,
				"%s\t%s\t%s\t%s\t%s\n",
				v.Name,
				v.CreatedAt,
				inUse,
				strings.Join(v.SandboxRefs, ","),
				v.SourcePath,
			)
		}
		w.Flush()
		return nil
	},
}

var volumeDeleteCmd = &cobra.Command{
	Use:     "delete <name> [<name>...]",
	Aliases: []string{"rm", "remove"},
	Short:   "Delete one or more tracked volumes",
	Args:    cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		force, _ := cmd.Flags().GetBool("force")

		volumesFile, err := config.VolumesStateFile()
		if err != nil {
			return err
		}
		store := sandbox.NewVolumeStore(volumesFile)

		var errs []string
		for _, name := range args {
			if err := deleteTrackedVolume(store, name, force, sandbox.RemoveDockerVolume); err != nil {
				errs = append(errs, fmt.Sprintf("volume %q: %v", name, err))
				continue
			}
			fmt.Printf("Volume %q deleted\n", name)
		}
		if len(errs) > 0 {
			return fmt.Errorf("%s", strings.Join(errs, "\n"))
		}
		return nil
	},
}

func deleteTrackedVolume(
	store sandbox.VolumeStore,
	name string,
	force bool,
	removeVolumeFn func(string) error,
) error {
	volume, err := store.Get(name)
	if err != nil {
		return err
	}

	if len(volume.SandboxRefs) > 0 && !force {
		return fmt.Errorf("volume %q is in use by sandboxes: %s (use --force to delete)", name, strings.Join(volume.SandboxRefs, ", "))
	}

	if err := removeVolumeFn(name); err != nil {
		return err
	}
	if err := store.Remove(name); err != nil {
		return err
	}
	return nil
}

func init() {
	rootCmd.AddCommand(volumeCmd)
	volumeCmd.AddCommand(volumeListCmd)
	volumeCmd.AddCommand(volumeDeleteCmd)
	volumeDeleteCmd.Flags().Bool("force", false, "Delete volume even if referenced by sandboxes")
}
