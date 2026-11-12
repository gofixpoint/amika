package sandboxcmd

import "os"

// Windows connects directly and does not use an agent directory.
func checkAgentDirectoryOwner(string, os.FileInfo) error { return nil }
