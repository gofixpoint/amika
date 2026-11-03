//go:build darwin

package platform

// current on macOS: the system sshd is /usr/sbin/sshd, and its
// privilege-separation directory (/var/empty) ships with the OS.
var current Platform = unixPlatform{sshd: SSHD{
	Candidates: []string{"/usr/sbin/sshd"},
}}

// StateDirectory holds root-mode amikad's state. It is the real path of
// /var/lib/amikad: /var is a symlink to /private/var, and secure writes
// refuse a symlink anywhere in a path. Shell scripts can keep using
// /var/lib/amikad.
const StateDirectory = "/private/var/lib/amikad"
