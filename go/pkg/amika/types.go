package amika

// Sandbox describes a rig as the CLI shows it in `rig list`.
type Sandbox struct {
	Name      string
	State     string
	Provider  string
	CreatedAt string
	Branch    string
	Repos     []string
	Ports     []PortBinding
	CreatedBy *SandboxCreator
}

// PortBinding represents a published container port.
type PortBinding struct {
	HostIP        string `json:"HostIP,omitempty"`
	HostPort      int    `json:"HostPort"`
	ContainerPort int    `json:"ContainerPort"`
	Protocol      string `json:"Protocol,omitempty"`
}

// SandboxCreator identifies the human who created a sandbox. Both fields may
// be empty when the server could not resolve the creator (deleted user,
// API-key principal, or noop auth mode).
type SandboxCreator struct {
	Name  string
	Email string
}
