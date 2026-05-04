package amika

// Mount represents a mount binding request or response shape.
type Mount struct {
	Type         string
	Source       string
	Volume       string
	Target       string
	Mode         string
	SnapshotFrom string
}

// PortBinding represents a published container port.
type PortBinding struct {
	HostIP        string `json:"HostIP,omitempty"`
	HostPort      int    `json:"HostPort"`
	ContainerPort int    `json:"ContainerPort"`
	Protocol      string `json:"Protocol,omitempty"`
}

// CreateSandboxRequest describes sandbox creation input.
type CreateSandboxRequest struct {
	Provider        string
	Name            string
	Image           string
	Preset          string
	Mounts          []Mount
	Volumes         []Mount
	GitRepo         string `json:"GitRepo,omitempty"`
	NoClean         bool
	Env             []string
	Ports           []PortBinding `json:"Ports,omitempty"`
	SetupScript     string        `json:"SetupScript,omitempty"`
	SetupScriptText string        `json:"SetupScriptText,omitempty"`
	Branch          string        `json:"Branch,omitempty"`
}

// DeleteSandboxRequest describes sandbox deletion input.
type DeleteSandboxRequest struct {
	Names         []string
	DeleteVolumes bool
	KeepVolumes   bool
}

// ListSandboxesRequest describes sandbox listing input.
type ListSandboxesRequest struct{}

// ConnectSandboxRequest describes connect input.
type ConnectSandboxRequest struct {
	Name  string
	Shell string
}

// MaterializeRequest describes materialization input.
type MaterializeRequest struct {
	Script      string
	ScriptArgs  []string
	Cmd         string
	Outdir      string
	Destdir     string
	Image       string
	Preset      string
	Mounts      []Mount
	Env         []string
	Interactive bool
	SetupScript string
}

// ListVolumesRequest describes volume listing input.
type ListVolumesRequest struct{}

// DeleteVolumeRequest describes volume deletion input.
type DeleteVolumeRequest struct {
	Names []string
	Force bool
}

// AuthExtractRequest describes credential extraction input.
type AuthExtractRequest struct {
	WithExport bool
	HomeDir    string
	NoOAuth    bool
}

// UpdateSandboxRequest describes sandbox metadata update input.
// Only non-zero fields are applied.
type UpdateSandboxRequest struct {
	Name              string  `json:"Name"`                        // sandbox to update (required)
	NewName           *string `json:"NewName,omitempty"`           // rename the sandbox
	TTL               *string `json:"TTL,omitempty"`               // time-to-live duration (e.g. "2h", "30m")
	InactivityTimeout *string `json:"InactivityTimeout,omitempty"` // inactivity timeout duration
	AutoDeleteTimeout *string `json:"AutoDeleteTimeout,omitempty"` // auto-delete timeout for suspended sandboxes
}

// ListServicesRequest describes service listing input.
type ListServicesRequest struct {
	SandboxName string // optional filter
}
