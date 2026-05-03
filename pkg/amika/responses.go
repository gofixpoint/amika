package amika

// Sandbox is a tracked sandbox description.
type Sandbox struct {
	Name        string
	State       string
	Provider    string
	ContainerID string
	Image       string
	CreatedAt   string
	ExpiresAt   string `json:"ExpiresAt,omitempty"`
	WarnAt      string `json:"WarnAt,omitempty"`
	Preset      string
	Location    string // "local" or "remote"
	Branch      string
	Mounts      []Mount
	Env         []string
	Ports       []PortBinding
	Services    []ServiceInfo
}

// ServiceInfo describes a named service running in a sandbox.
type ServiceInfo struct {
	Name  string            `json:"Name"`
	Ports []ServicePortInfo `json:"Ports"`
}

// ServicePortInfo is a resolved port binding with an optional generated URL.
type ServicePortInfo struct {
	PortBinding
	URL string `json:"URL,omitempty"`
}

// ListServicesResult reports listed services.
type ListServicesResult struct {
	Items []ServiceListItem
}

// ServiceListItem is a service with its owning sandbox name.
type ServiceListItem struct {
	Service     string
	SandboxName string
	Ports       []ServicePortInfo
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
