package sandbox

import "io/fs"

// lifecycleHookDirectory holds the rig lifecycle hooks the base image
// installs into /usr/lib/amikad, mirrored from sandbox-image/assets/hooks.
const lifecycleHookDirectory = "sandbox-image/assets/hooks"

// LifecycleHookFS returns the lifecycle hooks compiled into the binary.
// `amikad bootstrap` writes them onto a rig that booted the provider's own
// image, so both kinds of rig run the same hooks.
func LifecycleHookFS() fs.FS {
	hooks, err := fs.Sub(sandboxImageFS, lifecycleHookDirectory)
	if err != nil {
		// fs.Sub fails only for an invalid path, and this one is a constant.
		panic(err)
	}
	return hooks
}
