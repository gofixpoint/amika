// Package buildmeta exposes build-time metadata for Amika binaries.
package buildmeta

import "fmt"

var (
	// AmikaVersion is the version string for the amika CLI.
	AmikaVersion = "dev"
	// AmikaServerVersion is the version string for the amika-server binary.
	AmikaServerVersion = "dev"
	// Commit is the full git SHA for the build.
	Commit = "unknown"
	// Date is the UTC build timestamp.
	Date = "unknown"
)

// Info describes the build metadata emitted by a binary.
type Info struct {
	Component string
	Version   string
	Commit    string
	Date      string
}

// New returns normalized build metadata for a component.
func New(component, version string) Info {
	if version == "" {
		version = "dev"
	}
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
