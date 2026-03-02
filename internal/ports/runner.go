package ports

import "context"

// CommandRunner executes external commands.
type CommandRunner interface {
	Run(ctx context.Context, name string, args []string, opts RunOptions) (RunResult, error)
}

// RunOptions configures command execution.
type RunOptions struct {
	Env    []string
	Stdin  any
	Stdout any
	Stderr any
	Dir    string
}

// RunResult captures process output.
type RunResult struct {
	Stdout string
	Stderr string
	Code   int
}
