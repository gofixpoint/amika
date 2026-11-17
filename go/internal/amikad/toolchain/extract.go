package toolchain

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// maxExtractedBytes bounds what one archive may write, so a hostile or
// corrupt archive cannot fill the disk. The largest tool today is Node at
// under 250 MiB unpacked.
const maxExtractedBytes = 2 << 30

// extractTarGz unpacks the gzip tarball at archivePath into dest, dropping
// strip leading path components. Every entry must stay inside dest: absolute
// names, `..` components, and symlinks or hard links that point outside are
// refused. Device files and FIFOs are skipped.
func extractTarGz(archivePath, dest string, strip int) error {
	file, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer file.Close()
	gz, err := gzip.NewReader(file)
	if err != nil {
		return fmt.Errorf("read gzip: %w", err)
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	var written int64
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read tar: %w", err)
		}
		name, ok, err := strippedName(header.Name, strip)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		target := filepath.Join(dest, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, dirMode(header)); err != nil {
				return err
			}
		case tar.TypeReg:
			written += header.Size
			if written > maxExtractedBytes {
				return errors.New("archive is larger than the extraction limit")
			}
			if err := writeEntry(target, reader, header); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := checkLinkTarget(name, header.Linkname); err != nil {
				return fmt.Errorf("symlink %s: %w", header.Name, err)
			}
			_ = os.Remove(target)
			if err := os.Symlink(header.Linkname, target); err != nil {
				return err
			}
		case tar.TypeLink:
			linked, ok, err := strippedName(header.Linkname, strip)
			if err != nil || !ok {
				return fmt.Errorf("hard link %s: target outside the archive", header.Name)
			}
			_ = os.Remove(target)
			if err := os.Link(filepath.Join(dest, filepath.FromSlash(linked)), target); err != nil {
				return err
			}
		default:
			// Devices, FIFOs, and extended headers carry nothing a tool needs.
		}
	}
}

// strippedName cleans an entry name and drops strip leading components.
// ok is false for an entry that strip removes entirely (a top directory).
func strippedName(name string, strip int) (string, bool, error) {
	cleaned := path.Clean(strings.TrimPrefix(name, "./"))
	if strings.HasPrefix(name, "/") || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", false, fmt.Errorf("archive entry %q leaves the tool directory", name)
	}
	parts := strings.Split(cleaned, "/")
	if cleaned == "." || len(parts) <= strip {
		return "", false, nil
	}
	return strings.Join(parts[strip:], "/"), true, nil
}

// checkLinkTarget refuses a symlink whose target, resolved from the link's
// own directory, leaves the extraction root.
func checkLinkTarget(linkName, target string) error {
	if strings.HasPrefix(target, "/") {
		return errors.New("absolute target")
	}
	resolved := path.Clean(path.Join(path.Dir(linkName), target))
	if resolved == ".." || strings.HasPrefix(resolved, "../") {
		return errors.New("target leaves the tool directory")
	}
	return nil
}

func writeEntry(target string, reader io.Reader, header *tar.Header) error {
	_ = os.Remove(target)
	file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, fileMode(header))
	if err != nil {
		return err
	}
	if _, err := io.CopyN(file, reader, header.Size); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

// fileMode keeps the archive's permission bits but drops setuid, setgid, and
// write access for anyone but the owner.
func fileMode(header *tar.Header) os.FileMode {
	return os.FileMode(header.Mode).Perm() &^ 0o022
}

func dirMode(header *tar.Header) os.FileMode {
	return (os.FileMode(header.Mode).Perm() | 0o700) &^ 0o022
}
