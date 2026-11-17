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

// maxEntries bounds the entries one archive may create. Node, the largest
// tool today, has about 6,000.
const maxEntries = 200_000

// maxLinkHops bounds the symlinks followed while resolving one path.
const maxLinkHops = 40

// extractTarGz unpacks the gzip tarball at archivePath into dest, dropping
// strip leading path components. Every entry must stay inside dest: absolute
// names, `..` components, entries under a symlink the archive made, and
// symlinks or hard links that point outside are refused. Device files and
// FIFOs are skipped.
func extractTarGz(archivePath, dest string, strip int) error {
	links, err := extractEntries(archivePath, dest, strip)
	if err != nil {
		return err
	}
	// A link's text can stay inside while the links it passes through lead
	// out; resolve each one through the extracted tree.
	for _, link := range links {
		if !resolvesInside(dest, link) {
			return fmt.Errorf("symlink %s: target leaves the tool directory", link)
		}
	}
	return nil
}

// extractEntries writes the archive's entries and returns the symlinks it
// made, by their stripped names.
func extractEntries(archivePath, dest string, strip int) ([]string, error) {
	file, err := os.Open(archivePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	gz, err := gzip.NewReader(file)
	if err != nil {
		return nil, fmt.Errorf("read gzip: %w", err)
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	var (
		written int64
		entries int
		links   []string
	)
	isLink := map[string]bool{}
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return links, nil
		}
		if err != nil {
			return nil, fmt.Errorf("read tar: %w", err)
		}
		name, ok, err := strippedName(header.Name, strip)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		if entries++; entries > maxEntries {
			return nil, errors.New("archive has more entries than the extraction limit")
		}
		// An entry under a symlink the archive made would be written wherever
		// that link points.
		if underLink(name, isLink) {
			return nil, fmt.Errorf("archive entry %q is under a symlink", header.Name)
		}
		target := filepath.Join(dest, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return nil, err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if isLink[name] {
				return nil, fmt.Errorf("archive entry %q is under a symlink", header.Name)
			}
			if err := os.MkdirAll(target, dirMode(header)); err != nil {
				return nil, err
			}
		case tar.TypeReg:
			written += header.Size
			if written > maxExtractedBytes {
				return nil, errors.New("archive is larger than the extraction limit")
			}
			if err := writeEntry(target, reader, header); err != nil {
				return nil, err
			}
			delete(isLink, name)
		case tar.TypeSymlink:
			if err := checkLinkTarget(name, header.Linkname); err != nil {
				return nil, fmt.Errorf("symlink %s: %w", header.Name, err)
			}
			if err := os.RemoveAll(target); err != nil {
				return nil, err
			}
			if err := os.Symlink(header.Linkname, target); err != nil {
				return nil, err
			}
			if !isLink[name] {
				links = append(links, name)
			}
			isLink[name] = true
		case tar.TypeLink:
			linked, ok, err := strippedName(header.Linkname, strip)
			if err != nil || !ok || underLink(linked, isLink) || isLink[linked] {
				return nil, fmt.Errorf("hard link %s: target outside the archive's own files", header.Name)
			}
			if err := os.RemoveAll(target); err != nil {
				return nil, err
			}
			if err := os.Link(filepath.Join(dest, filepath.FromSlash(linked)), target); err != nil {
				return nil, err
			}
			delete(isLink, name)
		default:
			// Devices, FIFOs, and extended headers carry nothing a tool needs.
		}
	}
}

// underLink reports whether a proper ancestor of name is a symlink the
// archive made.
func underLink(name string, isLink map[string]bool) bool {
	parts := strings.Split(name, "/")
	for i := 1; i < len(parts); i++ {
		if isLink[strings.Join(parts[:i], "/")] {
			return true
		}
	}
	return false
}

// resolvesInside reports whether rel, resolved under root with every
// symlink on the way followed, stays inside root. A missing component is
// taken as it is written.
func resolvesInside(root, rel string) bool {
	pending := strings.Split(rel, "/")
	var resolved []string
	for hops := 0; len(pending) > 0; {
		part := pending[0]
		pending = pending[1:]
		switch part {
		case "", ".":
			continue
		case "..":
			if len(resolved) == 0 {
				return false
			}
			resolved = resolved[:len(resolved)-1]
			continue
		}
		resolved = append(resolved, part)
		full := filepath.Join(root, filepath.FromSlash(strings.Join(resolved, "/")))
		info, err := os.Lstat(full)
		if err != nil || info.Mode()&os.ModeSymlink == 0 {
			continue
		}
		if hops++; hops > maxLinkHops {
			return false
		}
		target, err := os.Readlink(full)
		if err != nil || strings.HasPrefix(target, "/") {
			return false
		}
		resolved = resolved[:len(resolved)-1]
		pending = append(strings.Split(target, "/"), pending...)
	}
	return true
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
