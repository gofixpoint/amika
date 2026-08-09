// Package state owns amikad's sensitive files and scrub manifest.
//
// The contract with the amika-mono control plane is register-before-write:
// WriteAndRegister and WriteAndRegisterOwned durably append a sensitive
// file's absolute path to the manifest before installing the file itself, so
// a consumer that reads the manifest and removes every path it lists can
// never miss a file this package has fully written. Worst case the consumer
// deletes a path that turned out not to be needed; it can never skip one
// that is.
//
// The manifest is a JSON array of absolute file path strings, e.g.
// `["/home/amika/.ssh/authorized_keys", "/var/lib/amikad/connect-token"]`,
// at a fixed path (production: /var/lib/amikad/injected-paths.json — under
// /var/lib per the Filesystem Hierarchy Standard, since this is variable
// runtime state rather than config). Entries must be clean, absolute,
// non-duplicate, and never equal to the manifest path itself; readManifest
// rejects a manifest violating any of those (ErrInvalidManifest).
//
// Before capturing a sandbox into a snapshot, the amika-mono control plane
// scrubs every path the manifest lists — running as root, since some
// registered paths (e.g. the SSH host key) are root-owned — then scrubs the
// manifest file itself last. Scrub verification fails closed: if the control
// plane cannot confirm a listed path is gone, snapshot capture aborts rather
// than let a credential ride along into the snapshot. See the ssh-relay
// repo's specs/019-sandbox-ssh-stream-relay.d/no-relay-websocket-ssh.md
// ("Injection must register its own cleanup") and amika-mono's
// devdocs/sandbox-secret-scrubbing.md for the full mechanism.
package state

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"path/filepath"
	"slices"
	"sync"
)

// ErrInvalidPath marks a sensitive target that is not an absolute clean path.
var ErrInvalidPath = errors.New("invalid sensitive file path")

// ErrSymlinkPath marks a sensitive target that resolves through a symlink.
var ErrSymlinkPath = errors.New("sensitive file path contains a symlink")

// ErrInvalidManifest marks a scrub manifest that cannot be safely extended.
var ErrInvalidManifest = errors.New("invalid injected-paths manifest")

// ErrSensitiveFileTooLarge marks input that exceeds the bounded in-memory
// secret size accepted by the atomic writer.
var ErrSensitiveFileTooLarge = errors.New("sensitive file exceeds size limit")

const maxSensitiveFileBytes = 1 << 20

// SensitiveStore first registers an absolute path by atomically replacing the
// scrub manifest, then atomically replaces the sensitive file. A stale manifest
// entry is safe; an unregistered sensitive file is not.
type SensitiveStore interface {
	// WriteAndRegister uses ctx for cancellation, registers absolutePath in the
	// scrub manifest, reads the replacement contents from contents, and installs
	// the sensitive file with mode after the registration is durable.
	WriteAndRegister(ctx context.Context, absolutePath string, contents io.Reader, mode fs.FileMode) error
	// WriteAndRegisterOwned performs the same ordered replacement while assigning
	// ownership through the temporary file descriptor before the final rename.
	WriteAndRegisterOwned(
		ctx context.Context,
		absolutePath string,
		contents io.Reader,
		mode fs.FileMode,
		ownership Ownership,
	) error
}

// Ownership is the numeric owner applied to a sensitive file before install.
type Ownership struct {
	UID int
	GID int
}

// FileSystem is the minimum filesystem boundary needed for ordered, atomic
// manifest and sensitive-file replacement.
type FileSystem interface {
	ReadFile(string) ([]byte, error)
	Lstat(string) (fs.FileInfo, error)
	WriteFileAtomic(string, []byte, fs.FileMode) error
	WriteFileAtomicOwned(string, []byte, fs.FileMode, Ownership) error
	WithLock(context.Context, string, func() error) error
}

// Store is the manifest-backed sensitive writer. Its implementation remains
// fail-closed until atomic file and manifest replacement land.
type Store struct {
	manifestPath string
	files        FileSystem
	mu           sync.Mutex
}

// NewStore creates a sensitive writer for an explicit manifest path.
func NewStore(manifestPath string, files FileSystem) *Store {
	return &Store{manifestPath: manifestPath, files: files}
}

// WriteAndRegister registers the target before atomically replacing it.
func (s *Store) WriteAndRegister(
	ctx context.Context,
	absolutePath string,
	contents io.Reader,
	mode fs.FileMode,
) error {
	return s.writeAndRegister(ctx, absolutePath, contents, mode, nil)
}

// WriteAndRegisterOwned registers and replaces a sensitive file while setting
// ownership on the still-private temporary file descriptor.
func (s *Store) WriteAndRegisterOwned(
	ctx context.Context,
	absolutePath string,
	contents io.Reader,
	mode fs.FileMode,
	ownership Ownership,
) error {
	if ownership.UID < -1 || ownership.GID < -1 {
		return ErrInvalidPath
	}
	return s.writeAndRegister(ctx, absolutePath, contents, mode, &ownership)
}

func (s *Store) writeAndRegister(
	ctx context.Context,
	absolutePath string,
	contents io.Reader,
	mode fs.FileMode,
	ownership *Ownership,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !isCleanAbsolutePath(absolutePath) || absolutePath == s.manifestPath {
		return ErrInvalidPath
	}
	if mode != mode.Perm() {
		return ErrInvalidPath
	}

	data, err := io.ReadAll(io.LimitReader(contents, maxSensitiveFileBytes+1))
	if err != nil {
		return err
	}
	if len(data) > maxSensitiveFileBytes {
		return ErrSensitiveFileTooLarge
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := ctx.Err(); err != nil {
		return err
	}
	if err := rejectSymlinkComponents(s.files, s.manifestPath); err != nil {
		return err
	}
	if err := rejectSymlinkComponents(s.files, absolutePath); err != nil {
		return err
	}

	return s.files.WithLock(ctx, s.manifestPath+".lock", func() error {
		paths, err := readManifest(s.files, s.manifestPath)
		if err != nil {
			return err
		}
		if !slices.Contains(paths, absolutePath) {
			paths = append(paths, absolutePath)
		}
		manifest, err := json.Marshal(paths)
		if err != nil {
			return errors.Join(ErrInvalidManifest, err)
		}
		manifest = append(manifest, '\n')

		if err := s.files.WriteFileAtomic(s.manifestPath, manifest, 0o600); err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if ownership != nil {
			return s.files.WriteFileAtomicOwned(absolutePath, data, mode, *ownership)
		}
		return s.files.WriteFileAtomic(absolutePath, data, mode)
	})
}

func readManifest(files FileSystem, manifestPath string) ([]string, error) {
	data, err := files.ReadFile(manifestPath)
	if errors.Is(err, fs.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}

	var paths []string
	if err := json.Unmarshal(data, &paths); err != nil || paths == nil {
		return nil, errors.Join(ErrInvalidManifest, err)
	}
	seen := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		if !isCleanAbsolutePath(path) || path == manifestPath {
			return nil, ErrInvalidManifest
		}
		if _, duplicate := seen[path]; duplicate {
			return nil, ErrInvalidManifest
		}
		seen[path] = struct{}{}
	}
	return paths, nil
}

func isCleanAbsolutePath(path string) bool {
	return filepath.IsAbs(path) && filepath.Clean(path) == path
}

func rejectSymlinkComponents(files FileSystem, path string) error {
	if !isCleanAbsolutePath(path) {
		return ErrInvalidPath
	}
	for current := path; ; current = filepath.Dir(current) {
		info, err := files.Lstat(current)
		if err == nil && info.Mode()&fs.ModeSymlink != 0 {
			return ErrSymlinkPath
		}
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil
		}
	}
}
