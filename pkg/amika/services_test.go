package amika

import (
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

func TestResolveServicePorts_FallbackRandomWhenTaken(t *testing.T) {
	services := []amikaconfig.ServiceParsed{
		{Name: "api", Ports: []amikaconfig.ServicePortParsed{
			{ContainerPort: 4838, Protocol: "tcp"},
		}},
	}
	existing := []sandbox.PortBinding{
		{HostIP: "127.0.0.1", HostPort: 4838, ContainerPort: 4838, Protocol: "tcp"},
	}
	_, _, err := resolveServicePorts(services, existing, "127.0.0.1")
	// This should error because the same container port conflicts with --port flag
	if err == nil {
		t.Fatal("expected error for conflicting container port, got nil")
	}
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
	if infos[0].Ports[0].URL != "http://127.0.0.1:4838" {
		t.Errorf("expected URL %q, got %q", "http://127.0.0.1:4838", infos[0].Ports[0].URL)
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
	if ports[0].URL != "https://127.0.0.1:3000" {
		t.Errorf("port 3000: expected URL %q, got %q", "https://127.0.0.1:3000", ports[0].URL)
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
