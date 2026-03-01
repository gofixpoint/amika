package main

import (
	"fmt"
	"os"
	"path/filepath"
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

		fileMountsFile, err := config.FileMountsStateFile()
		if err != nil {
			return err
		}
		fmStore := sandbox.NewFileMountStore(fileMountsFile)

		volumes, err := store.List()
		if err != nil {
			return err
		}
		fileMounts, err := fmStore.List()
		if err != nil {
			return err
		}
		if len(volumes) == 0 && len(fileMounts) == 0 {
			fmt.Fprintln(cmd.OutOrStdout(), "No volumes found.")
			return nil
		}

		w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
		fmt.Fprintln(w, "NAME\tTYPE\tCREATED\tIN_USE\tSANDBOXES\tSOURCE")
		for _, v := range volumes {
			inUse := "no"
			if len(v.SandboxRefs) > 0 {
				inUse = "yes"
			}
			fmt.Fprintf(
				w,
				"%s\t%s\t%s\t%s\t%s\t%s\n",
				v.Name,
				"directory",
				v.CreatedAt,
				inUse,
				strings.Join(v.SandboxRefs, ","),
				v.SourcePath,
			)
		}
		for _, fm := range fileMounts {
			inUse := "no"
			if len(fm.SandboxRefs) > 0 {
				inUse = "yes"
			}
			fmt.Fprintf(
				w,
				"%s\t%s\t%s\t%s\t%s\t%s\n",
				fm.Name,
				"file",
				fm.CreatedAt,
				inUse,
				strings.Join(fm.SandboxRefs, ","),
				fm.SourcePath,
			)
		}
		w.Flush()
		return nil
	},
}

var volumeDeleteCmd = &cobra.Command{
	Use:     "delete <name>",
	Aliases: []string{"rm", "remove"},
	Short:   "Delete a tracked volume",
	Args:    cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]
		force, _ := cmd.Flags().GetBool("force")

		volumesFile, err := config.VolumesStateFile()
		if err != nil {
			return err
		}
		store := sandbox.NewVolumeStore(volumesFile)

		fileMountsFile, err := config.FileMountsStateFile()
		if err != nil {
			return err
		}
		fmStore := sandbox.NewFileMountStore(fileMountsFile)

		if _, err := store.Get(name); err == nil {
			if err := deleteTrackedVolume(store, name, force, sandbox.RemoveDockerVolume); err != nil {
				return err
			}
			fmt.Printf("Volume %q deleted\n", name)
			return nil
		}

		if _, err := fmStore.Get(name); err == nil {
			if err := deleteTrackedFileMount(fmStore, name, force); err != nil {
				return err
			}
			fmt.Printf("Volume %q deleted\n", name)
			return nil
		}

		return fmt.Errorf("no volume found with name: %s", name)
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

func deleteTrackedFileMount(
	store sandbox.FileMountStore,
	name string,
	force bool,
) error {
	fm, err := store.Get(name)
	if err != nil {
		return err
	}

	if len(fm.SandboxRefs) > 0 && !force {
		return fmt.Errorf("volume %q is in use by sandboxes: %s (use --force to delete)", name, strings.Join(fm.SandboxRefs, ", "))
	}

	if err := os.RemoveAll(filepath.Dir(fm.CopyPath)); err != nil {
		return fmt.Errorf("failed to remove file mount directory: %w", err)
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
