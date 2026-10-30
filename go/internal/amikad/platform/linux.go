//go:build linux

package platform

// current on Linux: distributions install sshd under /usr/sbin, and a root
// sshd refuses to start without its privilege-separation directory, which
// lives on the /run tmpfs and so must be recreated after every boot.
var current Platform = unixPlatform{sshd: SSHD{
	Candidates:       []string{"/usr/sbin/sshd", "/usr/bin/sshd"},
	PrivsepDirectory: "/run/sshd",
}}
