package amika

import (
	"net"
	"strconv"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/internal/amikaconfig"
	"github.com/gofixpoint/amika/internal/sandbox"
)

func TestResolveServicePorts_DirectMirror(t *testing.T) {
	services := []amikaconfig.ServiceParsed{
		{Name: "api", Ports: []amikaconfig.ServicePortParsed{
			{ContainerPort: 4838, Protocol: "tcp"},
		}},
	}
	infos, ports, err := resolveServicePorts(services, nil, "127.0.0.1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(infos) != 1 || infos[0].Name != "api" {
		t.Fatalf("expected 1 service 'api', got %+v", infos)
	}
	if len(ports) != 1 {
		t.Fatalf("expected 1 port, got %d", len(ports))
	}
	if ports[0].HostPort != 4838 || ports[0].ContainerPort != 4838 {
		t.Errorf("expected direct mirror 4838->4838, got %d->%d", ports[0].HostPort, ports[0].ContainerPort)
	}
}

func TestResolveServicePorts_ConflictSameContainerPort(t *testing.T) {
	services := []amikaconfig.ServiceParsed{
		{Name: "api", Ports: []amikaconfig.ServicePortParsed{
			{ContainerPort: 4838, Protocol: "tcp"},
		}},
	}
	existing := []sandbox.PortBinding{
		{HostIP: "127.0.0.1", HostPort: 4838, ContainerPort: 4838, Protocol: "tcp"},
	}
	_, _, err := resolveServicePorts(services, existing, "127.0.0.1")
	// This should error because the same container port conflicts with --port flag.
	if err == nil {
		t.Fatal("expected error for conflicting container port, got nil")
	}
}

func TestResolveServicePorts_FallbackRandomWhenHostPortTaken(t *testing.T) {
	// Service wants container port 5000, but host port 5000 is already
	// claimed by a different container port mapping. The service should
	// fall back to an OS-assigned random host port.
	services := []amikaconfig.ServiceParsed{
		{Name: "api", Ports: []amikaconfig.ServicePortParsed{
			{ContainerPort: 5000, Protocol: "tcp"},
		}},
	}
	existing := []sandbox.PortBinding{
		{HostIP: "127.0.0.1", HostPort: 5000, ContainerPort: 9999, Protocol: "tcp"},
	}
	infos, ports, err := resolveServicePorts(services, existing, "127.0.0.1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(ports) != 1 {
		t.Fatalf("expected 1 port, got %d", len(ports))
	}
	if ports[0].HostPort == 5000 {
		t.Errorf("expected random fallback port, got direct mirror 5000")
	}
	if ports[0].HostPort == 0 {
		t.Errorf("expected non-zero host port")
	}
	if ports[0].ContainerPort != 5000 {
		t.Errorf("expected container port 5000, got %d", ports[0].ContainerPort)
	}
	if len(infos) != 1 || infos[0].Ports[0].HostPort != ports[0].HostPort {
		t.Errorf("service info host port should match allocated port")
	}
}

func TestResolveServicePorts_FallbackRandomWhenMirroredHostPortInUse(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to reserve test host port: %v", err)
	}
	defer listener.Close()

	reservedPort := listener.Addr().(*net.TCPAddr).Port
	services := []amikaconfig.ServiceParsed{
		{Name: "api", Ports: []amikaconfig.ServicePortParsed{
			{ContainerPort: reservedPort, Protocol: "tcp"},
		}},
	}

	infos, ports, err := resolveServicePorts(services, nil, "127.0.0.1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(ports) != 1 {
		t.Fatalf("expected 1 port, got %d", len(ports))
	}
	if ports[0].HostPort == reservedPort {
		t.Fatalf("expected fallback away from occupied host port %d", reservedPort)
	}
	if ports[0].HostPort == 0 {
		t.Fatal("expected non-zero fallback host port")
	}
	if ports[0].ContainerPort != reservedPort {
		t.Fatalf("expected container port %d, got %d", reservedPort, ports[0].ContainerPort)
	}
	if infos[0].Ports[0].HostPort != ports[0].HostPort {
		t.Fatalf("expected service info host port %d, got %d", ports[0].HostPort, infos[0].Ports[0].HostPort)
	}

	probeListener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(ports[0].HostPort)))
	if err != nil {
		t.Fatalf("expected fallback host port %d to be free after allocation, got %v", ports[0].HostPort, err)
	}
	probeListener.Close()
}

func TestResolveServicePorts_ConflictWithPortFlag(t *testing.T) {
	services := []amikaconfig.ServiceParsed{
		{Name: "api", Ports: []amikaconfig.ServicePortParsed{
			{ContainerPort: 4838, Protocol: "tcp"},
		}},
	}
	existing := []sandbox.PortBinding{
		{HostIP: "127.0.0.1", HostPort: 9999, ContainerPort: 4838, Protocol: "tcp"},
	}
	_, _, err := resolveServicePorts(services, existing, "127.0.0.1")
	if err == nil {
		t.Fatal("expected error for conflicting container port, got nil")
	}
}

func TestResolveServicePorts_MultipleServices(t *testing.T) {
	services := []amikaconfig.ServiceParsed{
		{Name: "api", Ports: []amikaconfig.ServicePortParsed{
			{ContainerPort: 4838, Protocol: "tcp"},
		}},
		{Name: "metrics", Ports: []amikaconfig.ServicePortParsed{
			{ContainerPort: 9090, Protocol: "tcp"},
		}},
	}
	infos, ports, err := resolveServicePorts(services, nil, "127.0.0.1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(infos) != 2 {
		t.Fatalf("expected 2 services, got %d", len(infos))
	}
	if len(ports) != 2 {
		t.Fatalf("expected 2 ports, got %d", len(ports))
	}
}

func TestResolveServicePorts_URLGeneration(t *testing.T) {
	services := []amikaconfig.ServiceParsed{
		{Name: "api", Ports: []amikaconfig.ServicePortParsed{
			{ContainerPort: 4838, Protocol: "tcp", URLScheme: "http"},
		}},
	}
	infos, _, err := resolveServicePorts(services, nil, "127.0.0.1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if infos[0].Ports[0].URL != "http://localhost:4838" {
		t.Errorf("expected URL %q, got %q", "http://localhost:4838", infos[0].Ports[0].URL)
	}
}

func TestResolveServicePorts_URLGenerationUsesConfiguredBindAddress(t *testing.T) {
	services := []amikaconfig.ServiceParsed{
		{Name: "api", Ports: []amikaconfig.ServicePortParsed{
			{ContainerPort: 4838, Protocol: "tcp", URLScheme: "http"},
		}},
	}
	infos, ports, err := resolveServicePorts(services, nil, "0.0.0.0")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ports[0].HostDomain != "0.0.0.0" {
		t.Fatalf("expected HostDomain %q, got %q", "0.0.0.0", ports[0].HostDomain)
	}
	if infos[0].Ports[0].URL != "http://0.0.0.0:4838" {
		t.Errorf("expected URL %q, got %q", "http://0.0.0.0:4838", infos[0].Ports[0].URL)
	}
}

func TestResolveServicePorts_MultiPortURLGeneration(t *testing.T) {
	services := []amikaconfig.ServiceParsed{
		{Name: "web", Ports: []amikaconfig.ServicePortParsed{
			{ContainerPort: 3000, Protocol: "tcp", URLScheme: "https"},
			{ContainerPort: 3001, Protocol: "tcp", URLScheme: ""},
			{ContainerPort: 9090, Protocol: "udp", URLScheme: ""},
		}},
	}
	infos, _, err := resolveServicePorts(services, nil, "127.0.0.1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	ports := infos[0].Ports
	if ports[0].URL != "http://localhost:3000" {
		t.Errorf("port 3000: expected URL %q, got %q (https downgraded to http for local host)", "http://localhost:3000", ports[0].URL)
	}
	if ports[1].URL != "" {
		t.Errorf("port 3001: expected empty URL, got %q", ports[1].URL)
	}
	if ports[2].URL != "" {
		t.Errorf("port 9090: expected empty URL, got %q", ports[2].URL)
	}
}

func TestResolveServicePorts_NoURLScheme(t *testing.T) {
	services := []amikaconfig.ServiceParsed{
		{Name: "api", Ports: []amikaconfig.ServicePortParsed{
			{ContainerPort: 4838, Protocol: "tcp", URLScheme: ""},
		}},
	}
	infos, _, err := resolveServicePorts(services, nil, "127.0.0.1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if infos[0].Ports[0].URL != "" {
		t.Errorf("expected empty URL, got %q", infos[0].Ports[0].URL)
	}
}

func TestResolveServicePorts_HTTPSDowngradedToHTTPForLocalHost(t *testing.T) {
	services := []amikaconfig.ServiceParsed{
		{Name: "web", Ports: []amikaconfig.ServicePortParsed{
			{ContainerPort: 3000, Protocol: "tcp", URLScheme: "https"},
		}},
	}
	// 127.0.0.1 is local — https must become http.
	infos, _, err := resolveServicePorts(services, nil, "127.0.0.1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if infos[0].Ports[0].URL != "http://localhost:3000" {
		t.Errorf("expected https downgraded to http, got %q", infos[0].Ports[0].URL)
	}
}

func TestResolveServicePorts_HTTPSPreservedForNonLocalHost(t *testing.T) {
	services := []amikaconfig.ServiceParsed{
		{Name: "web", Ports: []amikaconfig.ServicePortParsed{
			{ContainerPort: 3000, Protocol: "tcp", URLScheme: "https"},
		}},
	}
	// 0.0.0.0 is not a local loopback — https is preserved.
	infos, _, err := resolveServicePorts(services, nil, "0.0.0.0")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	url := infos[0].Ports[0].URL
	if !strings.HasPrefix(url, "https://") {
		t.Errorf("expected https preserved for non-local host, got %q", url)
	}
}
