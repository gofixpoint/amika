package ports

// Mount describes a bind or volume mount at the infrastructure boundary.
type Mount struct {
	Type         string
	Source       string
	Volume       string
	Target       string
	Mode         string
	SnapshotFrom string
}

// DockerClient defines operations the app layer needs from Docker.
type DockerClient interface {
	CreateSandbox(name, image string, mounts []Mount, env []string) (string, error)
	RemoveSandbox(name string) error
	CreateVolume(name string) error
	RemoveVolume(name string) error
	CopyHostDirToVolume(volumeName, hostDir string) error
}
