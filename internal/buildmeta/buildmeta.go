// Package buildmeta exposes build-time metadata for Amika binaries.
package buildmeta

import (
	"fmt"
	"strconv"
	"strings"
)

var (
	amikaVersionValue       = "dev"
	amikaServerVersionValue = "dev"

	// AmikaVersion is the parsed semantic version for the amika CLI.
	AmikaVersion = MustParseSemVer(amikaVersionValue)
	// AmikaServerVersion is the parsed semantic version for the amika-server binary.
	AmikaServerVersion = MustParseSemVer(amikaServerVersionValue)
	// Commit is the full git SHA for the build.
	Commit = "unknown"
	// Date is the UTC build timestamp.
	Date = "unknown"
)

// SemVer describes an Amika semantic version or the local dev build.
type SemVer struct {
	Major      int
	Minor      int
	Patch      int
	PreRelease string
	Dev        bool
}

// String renders the semantic version in canonical CLI output format.
func (v SemVer) String() string {
	if v.Dev {
		return "dev"
	}
	if v.PreRelease != "" {
		return fmt.Sprintf("v%d.%d.%d-%s", v.Major, v.Minor, v.Patch, v.PreRelease)
	}
	return fmt.Sprintf("v%d.%d.%d", v.Major, v.Minor, v.Patch)
}

// ParseSemVer parses a canonical Amika version string.
func ParseSemVer(value string) (SemVer, error) {
	if value == "" || value == "dev" {
		return SemVer{Dev: true}, nil
	}
	if !strings.HasPrefix(value, "v") {
		return SemVer{}, fmt.Errorf("version %q must start with v", value)
	}

	version := strings.TrimPrefix(value, "v")
	core := version
	preRelease := ""
	if idx := strings.Index(version, "-"); idx >= 0 {
		core = version[:idx]
		preRelease = version[idx+1:]
		if preRelease == "" {
			return SemVer{}, fmt.Errorf("version %q has empty prerelease", value)
		}
	}

	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return SemVer{}, fmt.Errorf("version %q must have major, minor, and patch", value)
	}

	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return SemVer{}, fmt.Errorf("invalid major version in %q: %w", value, err)
	}
	minor, err := strconv.Atoi(parts[1])
	if err != nil {
		return SemVer{}, fmt.Errorf("invalid minor version in %q: %w", value, err)
	}
	patch, err := strconv.Atoi(parts[2])
	if err != nil {
		return SemVer{}, fmt.Errorf("invalid patch version in %q: %w", value, err)
	}

	return SemVer{
		Major:      major,
		Minor:      minor,
		Patch:      patch,
		PreRelease: preRelease,
	}, nil
}

// MustParseSemVer parses a canonical Amika version string and panics on failure.
func MustParseSemVer(value string) SemVer {
	version, err := ParseSemVer(value)
	if err != nil {
		panic(err)
	}
	return version
}

// Info describes the build metadata emitted by a binary.
type Info struct {
	Component string
	Version   SemVer
	Commit    string
	Date      string
}

// New returns normalized build metadata for a component.
func New(component string, version SemVer) Info {
	commit := Commit
	if commit == "" {
		commit = "unknown"
	}
	date := Date
	if date == "" {
		date = "unknown"
	}
	return Info{
		Component: component,
		Version:   version,
		Commit:    commit,
		Date:      date,
	}
}

// String renders the build metadata for human-readable CLI output.
func (i Info) String() string {
	return fmt.Sprintf("%s version %s\ncommit: %s\ndate: %s", i.Component, i.Version, i.Commit, i.Date)
}
