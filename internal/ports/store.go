package ports

// ServiceRecord describes a named service and its resolved port bindings.
type ServiceRecord struct {
	Name  string
	Ports []ServicePortRecord
}

// ServicePortRecord is a resolved port binding with an optional generated URL.
type ServicePortRecord struct {
	PortBinding
	URL string
}

// SandboxRecord stores sandbox metadata.
type SandboxRecord struct {
	Name        string
	Provider    string
	ContainerID string
	Image       string
	CreatedAt   string
	Preset      string
	Mounts      []Mount
	Env         []string
	Ports       []PortBinding
	Services    []ServiceRecord
}

// VolumeRecord stores tracked volume metadata.
type VolumeRecord struct {
	Name        string
	Type        string
	CreatedAt   string
	CreatedBy   string
	SourcePath  string
	CopyPath    string
	SandboxRefs []string
}

// SandboxStore persists sandbox records.
type SandboxStore interface {
	Save(info SandboxRecord) error
	Get(name string) (SandboxRecord, error)
	Remove(name string) error
	List() ([]SandboxRecord, error)
}

// VolumeStore persists directory-volume records.
type VolumeStore interface {
	Save(info VolumeRecord) error
	Get(name string) (VolumeRecord, error)
	Remove(name string) error
	List() ([]VolumeRecord, error)
	AddSandboxRef(name, sandbox string) error
	RemoveSandboxRef(name, sandbox string) error
	ForSandbox(name string) ([]VolumeRecord, error)
}

// FileMountStore persists rwcopy file mount records.
type FileMountStore interface {
	Save(info VolumeRecord) error
	Get(name string) (VolumeRecord, error)
	Remove(name string) error
	List() ([]VolumeRecord, error)
	AddSandboxRef(name, sandbox string) error
	RemoveSandboxRef(name, sandbox string) error
	ForSandbox(name string) ([]VolumeRecord, error)
}
