package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/gofixpoint/amika/internal/config"
	"github.com/gofixpoint/amika/internal/runmode"
	"github.com/gofixpoint/amika/internal/sandbox"
	"github.com/spf13/cobra"
)

var sandboxDeleteCmd = &cobra.Command{
	Use:     "delete <name> [<name>...]",
	Aliases: []string{"rm", "remove"},
	Short:   "Delete one or more sandboxes",
	Long:    `Delete one or more sandboxes and remove their backing containers.`,
	Args:    cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		force, _ := cmd.Flags().GetBool("force")

		if !force {
			reader := bufio.NewReader(cmd.InOrStdin())
			confirmed, err := confirmAction(
				fmt.Sprintf("Delete sandbox(es) %s?", strings.Join(args, ", ")),
				reader,
			)
			if err != nil {
				return err
			}
			if !confirmed {
				fmt.Println("Aborted.")
				return nil
			}
		}

		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		mode := runmode.Resolve(cmd)
		if err := runmode.RequireAuth(mode, defaultAuthChecker); err != nil {
			return err
		}

		deleteVolumes, _ := cmd.Flags().GetBool("delete-volumes")
		keepVolumes, _ := cmd.Flags().GetBool("keep-volumes")
		deleteVolumesSet := cmd.Flags().Changed("delete-volumes")
		keepVolumesSet := cmd.Flags().Changed("keep-volumes")
		if err := validateDeleteVolumeFlags(deleteVolumesSet, deleteVolumes, keepVolumesSet, keepVolumes); err != nil {
			return err
		}

		var errs []string
		if mode == runmode.Remote {
			remoteClient, err := getRemoteClient(target)
			if err != nil {
				return err
			}
			for _, name := range args {
				if remoteErr := remoteClient.DeleteSandbox(name); remoteErr != nil {
					errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, remoteErr))
				} else {
					fmt.Printf("Sandbox %q deleted (remote)\n", name)
				}
			}
		} else {
			sandboxesFile, err := config.SandboxesStateFile()
			if err != nil {
				return err
			}
			store := sandbox.NewStore(sandboxesFile)
			volumesFile, err := config.VolumesStateFile()
			if err != nil {
				return err
			}
			volumeStore := sandbox.NewVolumeStore(volumesFile)
			fileMountsFile, err := config.FileMountsStateFile()
			if err != nil {
				return err
			}
			fileMountStore := sandbox.NewFileMountStore(fileMountsFile)

			for _, name := range args {
				info, localErr := store.Get(name)
				if localErr != nil {
					errs = append(errs, fmt.Sprintf("sandbox %q not found", name))
					continue
				}

				deleteVols, err := resolveDeleteVolumes(
					volumeStore,
					fileMountStore,
					name,
					deleteVolumesSet,
					keepVolumesSet,
					bufio.NewReader(cmd.InOrStdin()),
				)
				if err != nil {
					errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, err))
					continue
				}

				if info.Provider == "docker" {
					if err := sandbox.RemoveDockerSandbox(name); err != nil {
						errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, err))
						continue
					}
				}

				volumeStatuses, volumeErr := cleanupSandboxVolumes(volumeStore, name, deleteVols, sandbox.RemoveDockerVolume)
				fileMountStatuses, fileMountErr := cleanupSandboxFileMounts(fileMountStore, name, deleteVols)

				if err := store.Remove(name); err != nil {
					errs = append(errs, fmt.Sprintf("sandbox %q: container removed but failed to update state: %v", name, err))
					continue
				}

				fmt.Printf("Sandbox %q deleted\n", name)
				for _, line := range volumeStatuses {
					fmt.Println(line)
				}
				for _, line := range fileMountStatuses {
					fmt.Println(line)
				}
				if volumeErr != nil {
					errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, volumeErr))
				}
				if fileMountErr != nil {
					errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, fileMountErr))
				}
			}
		}
		if len(errs) > 0 {
			return fmt.Errorf("%s", strings.Join(errs, "\n"))
		}
		return nil
	},
}

func cleanupSandboxVolumes(
	volumeStore sandbox.VolumeStore,
	sandboxName string,
	deleteVolumes bool,
	removeVolumeFn func(string) error,
) ([]string, error) {
	volumes, err := volumeStore.VolumesForSandbox(sandboxName)
	if err != nil {
		return nil, fmt.Errorf("failed to load associated volumes: %w", err)
	}
	if len(volumes) == 0 {
		return nil, nil
	}

	statuses := make([]string, 0, len(volumes))
	var errs []string

	for _, volume := range volumes {
		if err := volumeStore.RemoveSandboxRef(volume.Name, sandboxName); err != nil {
			statuses = append(statuses, fmt.Sprintf("volume %s: delete-failed: failed to update refs", volume.Name))
			errs = append(errs, fmt.Sprintf("failed to remove sandbox ref for volume %q: %v", volume.Name, err))
			continue
		}

		if !deleteVolumes {
			statuses = append(statuses, fmt.Sprintf("volume %s: preserved", volume.Name))
			continue
		}

		inUse, err := volumeStore.IsInUse(volume.Name)
		if err != nil {
			statuses = append(statuses, fmt.Sprintf("volume %s: delete-failed: failed to check usage", volume.Name))
			errs = append(errs, fmt.Sprintf("failed to check usage for volume %q: %v", volume.Name, err))
			continue
		}
		if inUse {
			statuses = append(statuses, fmt.Sprintf("volume %s: preserved (still referenced)", volume.Name))
			continue
		}

		if err := removeVolumeFn(volume.Name); err != nil {
			statuses = append(statuses, fmt.Sprintf("volume %s: delete-failed: %v", volume.Name, err))
			errs = append(errs, fmt.Sprintf("failed to delete volume %q: %v", volume.Name, err))
			continue
		}
		if err := volumeStore.Remove(volume.Name); err != nil {
			statuses = append(statuses, fmt.Sprintf("volume %s: delete-failed: failed to remove state entry", volume.Name))
			errs = append(errs, fmt.Sprintf("failed to remove volume state for %q: %v", volume.Name, err))
			continue
		}
		statuses = append(statuses, fmt.Sprintf("volume %s: deleted", volume.Name))
	}

	if len(errs) > 0 {
		return statuses, fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return statuses, nil
}

func cleanupSandboxFileMounts(
	fileMountStore sandbox.FileMountStore,
	sandboxName string,
	deleteMounts bool,
) ([]string, error) {
	mounts, err := fileMountStore.FileMountsForSandbox(sandboxName)
	if err != nil {
		return nil, fmt.Errorf("failed to load associated file mounts: %w", err)
	}
	if len(mounts) == 0 {
		return nil, nil
	}

	statuses := make([]string, 0, len(mounts))
	var errs []string

	for _, fm := range mounts {
		if err := fileMountStore.RemoveSandboxRef(fm.Name, sandboxName); err != nil {
			statuses = append(statuses, fmt.Sprintf("file-mount %s: delete-failed: failed to update refs", fm.Name))
			errs = append(errs, fmt.Sprintf("failed to remove sandbox ref for file mount %q: %v", fm.Name, err))
			continue
		}

		if !deleteMounts {
			statuses = append(statuses, fmt.Sprintf("file-mount %s: preserved", fm.Name))
			continue
		}

		inUse, err := fileMountStore.IsInUse(fm.Name)
		if err != nil {
			statuses = append(statuses, fmt.Sprintf("file-mount %s: delete-failed: failed to check usage", fm.Name))
			errs = append(errs, fmt.Sprintf("failed to check usage for file mount %q: %v", fm.Name, err))
			continue
		}
		if inUse {
			statuses = append(statuses, fmt.Sprintf("file-mount %s: preserved (still referenced)", fm.Name))
			continue
		}

		if err := os.RemoveAll(filepath.Dir(fm.CopyPath)); err != nil {
			statuses = append(statuses, fmt.Sprintf("file-mount %s: delete-failed: %v", fm.Name, err))
			errs = append(errs, fmt.Sprintf("failed to delete file mount directory for %q: %v", fm.Name, err))
			continue
		}
		if err := fileMountStore.Remove(fm.Name); err != nil {
			statuses = append(statuses, fmt.Sprintf("file-mount %s: delete-failed: failed to remove state entry", fm.Name))
			errs = append(errs, fmt.Sprintf("failed to remove file mount state for %q: %v", fm.Name, err))
			continue
		}
		statuses = append(statuses, fmt.Sprintf("file-mount %s: deleted", fm.Name))
	}

	if len(errs) > 0 {
		return statuses, fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return statuses, nil
}

func validateDeleteVolumeFlags(
	deleteVolumesSet bool,
	deleteVolumes bool,
	keepVolumesSet bool,
	keepVolumes bool,
) error {
	if deleteVolumesSet && !deleteVolumes {
		return fmt.Errorf("--delete-volumes does not accept an explicit value; use --delete-volumes or omit the flag")
	}
	if keepVolumesSet && !keepVolumes {
		return fmt.Errorf("--keep-volumes does not accept an explicit value; use --keep-volumes or omit the flag")
	}
	if deleteVolumesSet && keepVolumesSet {
		return fmt.Errorf("cannot use --delete-volumes and --keep-volumes together")
	}
	return nil
}

func resolveDeleteVolumes(
	volumeStore sandbox.VolumeStore,
	fileMountStore sandbox.FileMountStore,
	sandboxName string,
	deleteVolumesSet bool,
	keepVolumesSet bool,
	reader *bufio.Reader,
) (bool, error) {
	if deleteVolumesSet {
		return true, nil
	}
	if keepVolumesSet {
		return false, nil
	}

	volumes, err := volumeStore.VolumesForSandbox(sandboxName)
	if err != nil {
		return false, fmt.Errorf("failed to load associated volumes: %w", err)
	}

	var exclusive []string
	for _, volume := range volumes {
		exclusiveToSandbox := true
		for _, ref := range volume.SandboxRefs {
			if ref != sandboxName {
				exclusiveToSandbox = false
				break
			}
		}
		if exclusiveToSandbox {
			exclusive = append(exclusive, volume.Name)
		}
	}

	fileMounts, err := fileMountStore.FileMountsForSandbox(sandboxName)
	if err != nil {
		return false, fmt.Errorf("failed to load associated file mounts: %w", err)
	}
	for _, fm := range fileMounts {
		exclusiveToSandbox := true
		for _, ref := range fm.SandboxRefs {
			if ref != sandboxName {
				exclusiveToSandbox = false
				break
			}
		}
		if exclusiveToSandbox {
			exclusive = append(exclusive, fm.Name)
		}
	}

	if len(exclusive) == 0 {
		return false, nil
	}

	fmt.Printf("Sandbox %q is the only user of volumes: %s\n", sandboxName, strings.Join(exclusive, ", "))
	fmt.Println("Delete these volumes as part of sandbox deletion?")
	confirmed, err := promptForConfirmation(reader)
	if err != nil {
		return false, err
	}
	return confirmed, nil
}
