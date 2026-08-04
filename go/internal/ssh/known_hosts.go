package ssh

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gofixpoint/amika/go/internal/filelock"
)

// FileHostKeyPinStore atomically maintains the dedicated alias-keyed known
// hosts file.
type FileHostKeyPinStore struct {
	Path string
}

// Pin adds a new alias pin, accepts an identical existing pin, and refuses a
// changed key.
func (s FileHostKeyPinStore) Pin(alias, hostPublicKey string) error {
	line, err := KnownHostLine(alias, hostPublicKey)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o700); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	lock, err := filelock.Acquire(ctx, s.Path+".lock")
	if err != nil {
		return err
	}
	defer lock.Close()

	pins, err := readPins(s.Path)
	if err != nil {
		return err
	}
	canonical := strings.TrimSuffix(line, "\n")
	if existing, found := pins[alias]; found {
		if existing != canonical {
			return ErrHostKeyMismatch
		}
		return nil
	}
	pins[alias] = canonical
	aliases := make([]string, 0, len(pins))
	for pinnedAlias := range pins {
		aliases = append(aliases, pinnedAlias)
	}
	sort.Strings(aliases)
	var output strings.Builder
	for _, pinnedAlias := range aliases {
		output.WriteString(pins[pinnedAlias])
		output.WriteByte('\n')
	}
	return writeFileAtomic(s.Path, []byte(output.String()), 0o600)
}

func readPins(path string) (map[string]string, error) {
	pins := make(map[string]string)
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return pins, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 3 {
			return nil, fmt.Errorf("invalid managed known-host line")
		}
		canonical, err := KnownHostLine(fields[0], fields[1]+" "+fields[2])
		if err != nil {
			return nil, err
		}
		if _, duplicate := pins[fields[0]]; duplicate {
			return nil, fmt.Errorf("duplicate managed known-host alias")
		}
		pins[fields[0]] = strings.TrimSuffix(canonical, "\n")
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return pins, nil
}
