package norelay

import (
	"context"
	"net"
)

// NetDialer opens the configured loopback TCP stream with the standard
// library network dialer.
type NetDialer struct {
	dialer net.Dialer
}

// DialContext opens one cancellable network stream.
func (d *NetDialer) DialContext(ctx context.Context, network, address string) (Stream, error) {
	return d.dialer.DialContext(ctx, network, address)
}
