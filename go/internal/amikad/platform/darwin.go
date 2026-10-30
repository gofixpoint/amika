//go:build darwin

package platform

// current on macOS: the system sshd is /usr/sbin/sshd, and its
// privilege-separation directory (/var/empty) ships with the OS.
var current Platform = unixPlatform{sshd: SSHD{
	Candidates: []string{"/usr/sbin/sshd"},
}}
