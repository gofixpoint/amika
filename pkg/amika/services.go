package amika

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"

	"github.com/gofixpoint/amika/internal/amikaconfig"
	"github.com/gofixpoint/amika/internal/sandbox"
)

// resolveServicePorts resolves parsed service declarations into concrete port bindings.
// It returns sandbox ServiceInfo records (for storage) and additional PortBindings to publish.
// existingPorts are the --port flag bindings; conflicts produce an error.
func resolveServicePorts(
	services []amikaconfig.ServiceParsed,
	existingPorts []sandbox.PortBinding,
	hostIP string,
) ([]sandbox.ServiceInfo, []sandbox.PortBinding, error) {
	if len(services) == 0 {
		return nil, nil, nil
	}

	// Build set of existing container port claims (from --port flags).
	existingContainerPorts := make(map[string]bool)
	claimedHostPorts := make(map[string]bool)
	for _, p := range existingPorts {
		cKey := fmt.Sprintf("%d/%s", p.ContainerPort, p.Protocol)
		existingContainerPorts[cKey] = true
		hKey := fmt.Sprintf("%d/%s", p.HostPort, p.Protocol)
		claimedHostPorts[hKey] = true
	}

	var serviceInfos []sandbox.ServiceInfo
	var additionalPorts []sandbox.PortBinding

	for _, svc := range services {
		svcInfo := sandbox.ServiceInfo{Name: svc.Name}

		for _, sp := range svc.Ports {
			cKey := fmt.Sprintf("%d/%s", sp.ContainerPort, sp.Protocol)
			if existingContainerPorts[cKey] {
				return nil, nil, fmt.Errorf("service %q port %s conflicts with --port flag", svc.Name, cKey)
			}

			hostPort, err := resolveHostPort(hostIP, sp.ContainerPort, sp.Protocol, claimedHostPorts)
			if err != nil {
				return nil, nil, fmt.Errorf("service %q port %s: %w", svc.Name, cKey, err)
			}
			hKey := fmt.Sprintf("%d/%s", hostPort, sp.Protocol)
			claimedHostPorts[hKey] = true

			hostDomain := hostDomainForService(hostIP)
			pb := sandbox.PortBinding{
				HostIP:        hostIP,
				HostDomain:    hostDomain,
				HostPort:      hostPort,
				ContainerPort: sp.ContainerPort,
				Protocol:      sp.Protocol,
			}
			additionalPorts = append(additionalPorts, pb)

			url := ""
			if sp.URLScheme != "" {
				url = fmt.Sprintf("%s://%s", sp.URLScheme, net.JoinHostPort(pb.HostDomain, strconv.Itoa(hostPort)))
			}

			svcInfo.Ports = append(svcInfo.Ports, sandbox.ServicePortInfo{
				PortBinding: pb,
				URL:         url,
			})
		}

		serviceInfos = append(serviceInfos, svcInfo)
	}

	return serviceInfos, additionalPorts, nil
}

// resolveHostPort assigns a host port for the given container port and protocol.
//
// Step 1: Try direct mirror — use the same port number on the host as in the
// container. This is the common case when no other binding has claimed that port.
//
// Step 2: If the direct mirror port is already claimed, fall back to an
// OS-assigned ephemeral port. Binding to the configured host IP with port 0
// tells the OS to pick
// any available port; we immediately close the listener/connection and return
// the assigned port number.
//
// TCP and UDP use different listener APIs (net.Listen vs net.ListenPacket)
// because Go's net package exposes them as distinct types.
func resolveHostPort(hostIP string, containerPort int, protocol string, claimed map[string]bool) (int, error) {
	// Step 1: try direct mirror (host port = container port).
	key := fmt.Sprintf("%d/%s", containerPort, protocol)
	if !claimed[key] {
		available, err := isHostPortAvailable(hostIP, containerPort, protocol)
		if err != nil {
			return 0, err
		}
		if available {
			return containerPort, nil
		}
	}

	// Step 2: fall back to OS-assigned ephemeral port by binding to :0.
	port, err := allocateRandomHostPort(hostIP, protocol)
	if err != nil {
		return 0, err
	}
	return port, nil
}

func isHostPortAvailable(hostIP string, port int, protocol string) (bool, error) {
	addr := net.JoinHostPort(hostIPForBinding(hostIP), strconv.Itoa(port))
	if protocol == "udp" {
		conn, err := net.ListenPacket("udp", addr)
		if err != nil {
			if isAddressInUse(err) {
				return false, nil
			}
			return false, fmt.Errorf("failed to probe mirrored host port: %w", err)
		}
		if closeErr := conn.Close(); closeErr != nil {
			return false, fmt.Errorf("failed to release probed mirrored host port: %w", closeErr)
		}
		return true, nil
	}

	listener, err := net.Listen("tcp", addr)
	if err != nil {
		if isAddressInUse(err) {
			return false, nil
		}
		return false, fmt.Errorf("failed to probe mirrored host port: %w", err)
	}
	if closeErr := listener.Close(); closeErr != nil {
		return false, fmt.Errorf("failed to release probed mirrored host port: %w", closeErr)
	}
	return true, nil
}

func allocateRandomHostPort(hostIP string, protocol string) (int, error) {
	addr := net.JoinHostPort(hostIPForBinding(hostIP), "0")
	if protocol == "udp" {
		conn, err := net.ListenPacket("udp", addr)
		if err != nil {
			return 0, fmt.Errorf("failed to allocate random host port: %w", err)
		}
		port := conn.LocalAddr().(*net.UDPAddr).Port
		if closeErr := conn.Close(); closeErr != nil {
			return 0, fmt.Errorf("failed to release allocated random host port: %w", closeErr)
		}
		return port, nil
	}

	// TCP (default)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return 0, fmt.Errorf("failed to allocate random host port: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if closeErr := listener.Close(); closeErr != nil {
		return 0, fmt.Errorf("failed to release allocated random host port: %w", closeErr)
	}
	return port, nil
}

func hostIPForBinding(hostIP string) string {
	if hostIP == "" {
		return "127.0.0.1"
	}
	return hostIP
}

func hostDomainForService(hostIP string) string {
	switch hostIP {
	case "", "127.0.0.1", "::1":
		return "localhost"
	default:
		return hostIP
	}
}

func isAddressInUse(err error) bool {
	var opErr *net.OpError
	if !errors.As(err, &opErr) {
		return false
	}
	return opErr.Err != nil && strings.Contains(opErr.Err.Error(), "address already in use")
}

// ResolveServicesFromConfig parses services from a loaded config
// and resolves port bindings. Returns nil results when no services are configured.
func ResolveServicesFromConfig(
	cfg *amikaconfig.Config,
	existingPorts []sandbox.PortBinding,
	hostIP string,
) ([]sandbox.ServiceInfo, []sandbox.PortBinding, error) {
	if cfg == nil {
		return nil, nil, nil
	}
	services, err := cfg.ParsedServices()
	if err != nil {
		return nil, nil, fmt.Errorf("invalid service declarations: %w", err)
	}
	if len(services) == 0 {
		return nil, nil, nil
	}
	return resolveServicePorts(services, existingPorts, hostIP)
}
