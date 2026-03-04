package ports

import "os"

// Filesystem defines filesystem operations used by the app layer.
type Filesystem interface {
	Abs(path string) (string, error)
	Stat(path string) (os.FileInfo, error)
	MkdirAll(path string, perm os.FileMode) error
	MkdirTemp(dir, pattern string) (string, error)
	RemoveAll(path string) error
	WriteFile(name string, data []byte, perm os.FileMode) error
	ReadFile(name string) ([]byte, error)
	UserHomeDir() (string, error)
}
