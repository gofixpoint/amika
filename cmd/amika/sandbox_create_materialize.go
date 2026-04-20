package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gofixpoint/amika/internal/agentconfig"
	"github.com/gofixpoint/amika/internal/amikaconfig"
	"github.com/gofixpoint/amika/internal/sandbox"
	"github.com/gofixpoint/amika/internal/txn"
	"github.com/gofixpoint/amika/pkg/amika"
)

func confirmAction(message string, reader *bufio.Reader) (bool, error) {
	for {
		fmt.Printf("%s [y/n] ", message)
		answer, err := reader.ReadString('\n')
		if err != nil {
			return false, fmt.Errorf("failed to read confirmation: %w", err)
		}
		answer = strings.TrimSpace(strings.ToLower(answer))
		switch answer {
		case "y", "yes":
			return true, nil
		case "n", "no":
			return false, nil
		case "":
			fmt.Println("Please enter 'y' or 'n'.")
		default:
			fmt.Println("Invalid response. Please enter 'y' or 'n'.")
		}
	}
}

func promptForConfirmation(reader *bufio.Reader) (bool, error) {
	for {
		fmt.Print("Continue? [y/n] ")
		answer, err := reader.ReadString('\n')
		if err != nil {
			return false, fmt.Errorf("failed to read confirmation: %w", err)
		}
		answer = strings.TrimSpace(strings.ToLower(answer))
		switch answer {
		case "y", "yes":
			return true, nil
		case "n", "no":
			return false, nil
		case "":
			fmt.Println("Please enter 'y' or 'n'.")
		default:
			fmt.Println("Invalid response. Please enter 'y' or 'n'.")
		}
	}
}

func generateRWCopyVolumeName(sandboxName, target string) string {
	sanitizedTarget := strings.NewReplacer("/", "-", "_", "-", ".", "-").Replace(strings.TrimPrefix(target, "/"))
	if sanitizedTarget == "" {
		sanitizedTarget = "root"
	}
	return "amika-rwcopy-" + sandboxName + "-" + sanitizedTarget + "-" + strconv.FormatInt(time.Now().UnixNano(), 10)
}

func generateRWCopyFileMountName(sandboxName, target string) string {
	sanitizedTarget := strings.NewReplacer("/", "-", "_", "-", ".", "-").Replace(strings.TrimPrefix(target, "/"))
	if sanitizedTarget == "" {
		sanitizedTarget = "root"
	}
	return "amika-rwcopy-file-" + sandboxName + "-" + sanitizedTarget + "-" + strconv.FormatInt(time.Now().UnixNano(), 10)
}

type collectedMounts struct {
	Mounts       []sandbox.MountBinding
	VolumeMounts []sandbox.MountBinding
	Ports        []sandbox.PortBinding
	Services     []sandbox.ServiceInfo
	GitInfo      *gitMountInfo
	Cleanup      func()
}

func collectMounts(
	mountStrs, volumeStrs, portStrs []string,
	portHostIP string,
	gitPath string,
	gitFlagChanged bool,
	noClean bool,
	setupScript string,
	setupScriptFlagChanged bool,
	noSetup bool,
	branch string,
	newBranch string,
) (collectedMounts, error) {
	mounts, err := parseMountFlags(mountStrs)
	if err != nil {
		return collectedMounts{}, err
	}
	volumeMounts, err := parseVolumeFlags(volumeStrs)
	if err != nil {
		return collectedMounts{}, err
	}
	publishedPorts, err := parsePortFlags(portStrs, portHostIP)
	if err != nil {
		return collectedMounts{}, err
	}

	cleanup := func() {}
	var gmi *gitMountInfo
	if gitFlagChanged {
		info, cleanupGitMount, err := prepareGitMount(gitPath, noClean, cloneGitRepo, branch, newBranch)
		if err != nil {
			return collectedMounts{}, err
		}
		cleanup = cleanupGitMount
		gmi = &info
		mounts = append(mounts, info.Mount)
	}

	var repoCfg *amikaconfig.Config
	if gmi != nil {
		repoCfg, err = amikaconfig.LoadConfig(gmi.Mount.Source)
		if err != nil {
			cleanup()
			return collectedMounts{}, fmt.Errorf("failed to read .amika/config.toml: %w", err)
		}
	}

	if noSetup {
		setupScriptFlagChanged = true
	}

	if repoCfg != nil && !setupScriptFlagChanged {
		mount, err := setupScriptMountFromLoadedConfig(repoCfg, gmi.Mount.Source)
		if err != nil {
			cleanup()
			return collectedMounts{}, err
		}
		if mount != nil {
			mounts = append(mounts, *mount)
		}
	}

	var serviceInfos []sandbox.ServiceInfo
	if repoCfg != nil {
		svcInfos, additionalPorts, err := amika.ResolveServicesFromConfig(repoCfg, publishedPorts, portHostIP)
		if err != nil {
			cleanup()
			return collectedMounts{}, err
		}
		serviceInfos = svcInfos
		publishedPorts = append(publishedPorts, additionalPorts...)
	}

	if homeDir, err := os.UserHomeDir(); err == nil {
		agentMounts := agentconfig.RWCopyMounts(agentconfig.AllMounts(homeDir))
		mounts = append(mounts, agentMounts...)
	}

	if noSetup {
		noopPath, noopCleanup, err := createNoOpSetupScript()
		if err != nil {
			cleanup()
			return collectedMounts{}, err
		}
		mounts = append(mounts, setupScriptBindMount(noopPath))
		prevCleanup := cleanup
		cleanup = func() {
			noopCleanup()
			prevCleanup()
		}
	} else if setupScript != "" {
		absSetupScript, err := filepath.Abs(setupScript)
		if err != nil {
			cleanup()
			return collectedMounts{}, fmt.Errorf("failed to resolve setup-script path %q: %w", setupScript, err)
		}
		if _, err := os.Stat(absSetupScript); err != nil {
			cleanup()
			return collectedMounts{}, fmt.Errorf("setup-script %q is not accessible: %w", absSetupScript, err)
		}
		mounts = append(mounts, setupScriptBindMount(absSetupScript))
	}

	return collectedMounts{
		Mounts:       mounts,
		VolumeMounts: volumeMounts,
		Ports:        publishedPorts,
		Services:     serviceInfos,
		GitInfo:      gmi,
		Cleanup:      cleanup,
	}, nil
}

func setupScriptMountFromLoadedConfig(cfg *amikaconfig.Config, repoRoot string) (*sandbox.MountBinding, error) {
	if cfg == nil || cfg.Lifecycle.SetupScript == "" {
		return nil, nil
	}
	scriptPath := cfg.Lifecycle.SetupScript
	if !filepath.IsAbs(scriptPath) {
		scriptPath = filepath.Join(repoRoot, scriptPath)
	}
	if _, err := os.Stat(scriptPath); err != nil {
		return nil, fmt.Errorf("setup_script %q from .amika/config.toml is not accessible: %w", cfg.Lifecycle.SetupScript, err)
	}
	m := setupScriptBindMount(scriptPath)
	return &m, nil
}

func setupScriptBindMount(absPath string) sandbox.MountBinding {
	return sandbox.MountBinding{
		Type:   "bind",
		Source: absPath,
		Target: "/usr/local/etc/amikad/setup/setup.sh",
		Mode:   "ro",
	}
}

func createNoOpSetupScript() (string, func(), error) {
	tmpFile, err := os.CreateTemp("", "amika-no-setup-*.sh")
	if err != nil {
		return "", nil, fmt.Errorf("failed to create no-op setup script: %w", err)
	}
	if _, err := tmpFile.WriteString("#!/bin/bash\nexit 0\n"); err != nil {
		tmpFile.Close()
		os.Remove(tmpFile.Name())
		return "", nil, fmt.Errorf("failed to write no-op setup script: %w", err)
	}
	tmpFile.Close()
	if err := os.Chmod(tmpFile.Name(), 0o755); err != nil {
		os.Remove(tmpFile.Name())
		return "", nil, fmt.Errorf("failed to chmod no-op setup script: %w", err)
	}
	return tmpFile.Name(), func() { os.Remove(tmpFile.Name()) }, nil
}

func materializeRWCopyMounts(
	mounts []sandbox.MountBinding,
	sandboxName string,
	volumeStore sandbox.VolumeStore,
	fileMountStore sandbox.FileMountStore,
	fileMountsBaseDir string,
) ([]sandbox.MountBinding, txn.Rollbacker, error) {
	var runtimeMounts []sandbox.MountBinding
	createdVolumes := make([]string, 0)
	addedRefs := make(map[string]bool)
	createdFileMountDirs := make([]string, 0)
	addedFileRefs := make(map[string]bool)

	rb := txn.NewRollbacker(func() {
		for volumeName := range addedRefs {
			_ = volumeStore.RemoveSandboxRef(volumeName, sandboxName)
		}
		for _, volumeName := range createdVolumes {
			_ = volumeStore.Remove(volumeName)
			_ = sandbox.RemoveDockerVolume(volumeName)
		}
		for mountName := range addedFileRefs {
			_ = fileMountStore.Remove(mountName)
		}
		for _, dir := range createdFileMountDirs {
			_ = os.RemoveAll(dir)
		}
	})

	for _, m := range mounts {
		if m.Mode != "rwcopy" {
			runtimeMounts = append(runtimeMounts, m)
			continue
		}

		stat, err := os.Stat(m.Source)
		if err != nil {
			rb.Rollback()
			return nil, rb, fmt.Errorf("rwcopy source %q is not accessible: %w", m.Source, err)
		}

		if stat.IsDir() {
			volumeName := generateRWCopyVolumeName(sandboxName, m.Target)
			if err := sandbox.CreateDockerVolume(volumeName); err != nil {
				rb.Rollback()
				return nil, rb, err
			}
			createdVolumes = append(createdVolumes, volumeName)

			if err := sandbox.CopyHostDirToVolume(volumeName, m.Source); err != nil {
				rb.Rollback()
				return nil, rb, err
			}

			volInfo := sandbox.VolumeInfo{
				Name:        volumeName,
				CreatedAt:   time.Now().UTC().Format(time.RFC3339),
				CreatedBy:   "rwcopy",
				SourcePath:  m.Source,
				SandboxRefs: []string{sandboxName},
			}
			if err := volumeStore.Save(volInfo); err != nil {
				rb.Rollback()
				return nil, rb, fmt.Errorf("failed to save volume state for %q: %w", volumeName, err)
			}
			addedRefs[volumeName] = true

			runtimeMounts = append(runtimeMounts, sandbox.MountBinding{
				Type:         "volume",
				Volume:       volumeName,
				Target:       m.Target,
				Mode:         "rw",
				SnapshotFrom: m.Source,
			})
		} else {
			mountName := generateRWCopyFileMountName(sandboxName, m.Target)
			copyDir := filepath.Join(fileMountsBaseDir, mountName)
			if err := os.MkdirAll(copyDir, 0o755); err != nil {
				rb.Rollback()
				return nil, rb, fmt.Errorf("failed to create file mount directory for %q: %w", mountName, err)
			}
			createdFileMountDirs = append(createdFileMountDirs, copyDir)

			copyPath := filepath.Join(copyDir, filepath.Base(m.Source))
			if err := copyFile(m.Source, copyPath); err != nil {
				rb.Rollback()
				return nil, rb, fmt.Errorf("failed to copy file for rwcopy mount %q: %w", m.Source, err)
			}

			fmInfo := sandbox.FileMountInfo{
				Name:        mountName,
				Type:        "file",
				CreatedAt:   time.Now().UTC().Format(time.RFC3339),
				CreatedBy:   "rwcopy",
				SourcePath:  m.Source,
				CopyPath:    copyPath,
				SandboxRefs: []string{sandboxName},
			}
			if err := fileMountStore.Save(fmInfo); err != nil {
				rb.Rollback()
				return nil, rb, fmt.Errorf("failed to save file mount state for %q: %w", mountName, err)
			}
			addedFileRefs[mountName] = true

			runtimeMounts = append(runtimeMounts, sandbox.MountBinding{
				Type:         "bind",
				Source:       copyPath,
				Target:       m.Target,
				Mode:         "rw",
				SnapshotFrom: m.Source,
			})
		}
	}

	return runtimeMounts, rb, nil
}

func copyFile(src, dst string) error {
	srcInfo, err := os.Stat(src)
	if err != nil {
		return fmt.Errorf("failed to stat source file %q: %w", src, err)
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return fmt.Errorf("failed to read source file %q: %w", src, err)
	}
	if err := os.WriteFile(dst, data, srcInfo.Mode()); err != nil {
		return fmt.Errorf("failed to write destination file %q: %w", dst, err)
	}
	return nil
}
