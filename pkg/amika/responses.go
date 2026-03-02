package amika

// Sandbox is a tracked sandbox description.
type Sandbox struct {
	Name        string
	Provider    string
	ContainerID string
	Image       string
	CreatedAt   string
	Preset      string
	Mounts      []Mount
	Env         []string
	Ports       []PortBinding
}

// DeleteSandboxResult reports sandbox deletion details.
type DeleteSandboxResult struct {
	Deleted         []string
	VolumeStatus    []string
	FileMountStatus []string
}

// ListSandboxesResult reports listed sandboxes.
type ListSandboxesResult struct {
	Items []Sandbox
}

// MaterializeResult reports materialize output.
type MaterializeResult struct {
	Destdir string
}

// Volume describes a tracked volume or file mount.
type Volume struct {
	Name       string
	Type       string
	CreatedAt  string
	InUse      bool
	Sandboxes  []string
	SourcePath string
}

// ListVolumesResult reports listed volumes.
type ListVolumesResult struct {
	Items []Volume
}

// DeleteVolumeResult reports deleted volumes.
type DeleteVolumeResult struct {
	Deleted []string
}

// AuthExtractResult reports extracted env assignment lines.
type AuthExtractResult struct {
	Lines []string
}
