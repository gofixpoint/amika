package sshresume

// replayBuffer holds the bytes [start, end) that this side has read from its
// source and its peer has not acknowledged. start is the peer's ack; end is
// this side's sent count. Its owner keeps it at or below ReplayLimit.
type replayBuffer struct {
	start uint64
	data  []byte
}

func (b *replayBuffer) len() int { return len(b.data) }

func (b *replayBuffer) end() uint64 { return b.start + uint64(len(b.data)) }

func (b *replayBuffer) append(p []byte) { b.data = append(b.data, p...) }

// trimTo drops the bytes before offset, which must be in [start, end]. It
// frees the memory of an emptied buffer, and compacts a mostly empty one, so
// an idle session holds no buffer.
func (b *replayBuffer) trimTo(offset uint64) {
	b.data = b.data[offset-b.start:]
	b.start = offset
	switch {
	case len(b.data) == 0:
		b.data = nil
	case cap(b.data) > 64<<10 && cap(b.data) > 4*len(b.data):
		b.data = append([]byte(nil), b.data...)
	}
}

// copyAt copies the bytes from offset, which must be in [start, end], into
// dst, and returns how many it copied.
func (b *replayBuffer) copyAt(offset uint64, dst []byte) int {
	return copy(dst, b.data[offset-b.start:])
}
