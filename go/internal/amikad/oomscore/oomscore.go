// Package oomscore keeps amikad near the back of the Linux OOM killer's queue
// without passing that protection on to the processes it starts.
//
// amikad bridges all SSH access to the machine, so losing it to the OOM
// killer cuts the user off. A process's oom_score_adj is inherited across
// fork and exec, though, and OpenSSH's sshd saves the value it starts with
// and restores it into every session it forks. Every child amikad starts
// therefore resets itself to ChildScoreAdj before running the real command.
package oomscore

const (
	// DaemonScoreAdj is amikad's own oom_score_adj. It is one above -1000,
	// which would exempt amikad entirely, so a leak in amikad itself can
	// still be killed as a last resort instead of panicking the kernel.
	DaemonScoreAdj = -999

	// ChildScoreAdj is the oom_score_adj every child of amikad starts with:
	// the kernel default, as if amikad had not lowered its own.
	ChildScoreAdj = 0
)
