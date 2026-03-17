package amikaconfig_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/gofixpoint/amika/internal/amikaconfig"
)

func TestLoadConfig_NotExist(t *testing.T) {
	dir := t.TempDir()
	cfg, err := amikaconfig.LoadConfig(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg != nil {
		t.Fatalf("expected nil config, got %+v", cfg)
	}
}

func TestLoadConfig_ValidConfig(t *testing.T) {
	dir := t.TempDir()
	amikaDir := filepath.Join(dir, ".amika")
	if err := os.Mkdir(amikaDir, 0755); err != nil {
		t.Fatal(err)
	}
	content := `[api]
api_url = "https://example.amika.dev"
auth_client_id = "client_123"

[lifecycle]
setup_script = "scripts/setup.sh"
`
	if err := os.WriteFile(filepath.Join(amikaDir, "config.toml"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := amikaconfig.LoadConfig(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg == nil {
		t.Fatal("expected non-nil config")
	}
	if cfg.API.APIURL != "https://example.amika.dev" {
		t.Errorf("expected api_url %q, got %q", "https://example.amika.dev", cfg.API.APIURL)
	}
	if cfg.API.AuthClientID != "client_123" {
		t.Errorf("expected auth_client_id %q, got %q", "client_123", cfg.API.AuthClientID)
	}
	if cfg.Lifecycle.SetupScript != "scripts/setup.sh" {
		t.Errorf("expected setup_script %q, got %q", "scripts/setup.sh", cfg.Lifecycle.SetupScript)
	}
}

func TestLoadConfig_MalformedTOML(t *testing.T) {
	dir := t.TempDir()
	amikaDir := filepath.Join(dir, ".amika")
	if err := os.Mkdir(amikaDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(amikaDir, "config.toml"), []byte("not = valid [[["), 0644); err != nil {
		t.Fatal(err)
	}

	_, err := amikaconfig.LoadConfig(dir)
	if err == nil {
		t.Fatal("expected error for malformed TOML, got nil")
	}
}

func TestLoadConfig_EmptyLifecycleSection(t *testing.T) {
	dir := t.TempDir()
	amikaDir := filepath.Join(dir, ".amika")
	if err := os.Mkdir(amikaDir, 0755); err != nil {
		t.Fatal(err)
	}
	content := `[lifecycle]
`
	if err := os.WriteFile(filepath.Join(amikaDir, "config.toml"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := amikaconfig.LoadConfig(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg == nil {
		t.Fatal("expected non-nil config")
	}
	if cfg.Lifecycle.SetupScript != "" {
		t.Errorf("expected empty setup_script, got %q", cfg.Lifecycle.SetupScript)
	}
}

func TestLoadConfig_APISectionOnly(t *testing.T) {
	dir := t.TempDir()
	amikaDir := filepath.Join(dir, ".amika")
	if err := os.Mkdir(amikaDir, 0755); err != nil {
		t.Fatal(err)
	}
	content := `[api]
api_url = "https://api.example.test"
auth_client_id = "client_abc"
`
	if err := os.WriteFile(filepath.Join(amikaDir, "config.toml"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := amikaconfig.LoadConfig(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg == nil {
		t.Fatal("expected non-nil config")
	}
	if cfg.API.APIURL != "https://api.example.test" {
		t.Errorf("expected api_url %q, got %q", "https://api.example.test", cfg.API.APIURL)
	}
	if cfg.API.AuthClientID != "client_abc" {
		t.Errorf("expected auth_client_id %q, got %q", "client_abc", cfg.API.AuthClientID)
	}
}

func TestLoadGlobalConfig_NotExist(t *testing.T) {
	home := t.TempDir()
	setXDGConfigHome(t, filepath.Join(home, ".config"))

	cfg, err := amikaconfig.LoadGlobalConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg != nil {
		t.Fatalf("expected nil config, got %+v", cfg)
	}
}

func TestLoadGlobalConfig_ValidConfig(t *testing.T) {
	home := t.TempDir()
	configHome := filepath.Join(home, ".config")
	setXDGConfigHome(t, configHome)
	writeConfigFile(t, filepath.Join(configHome, "amika", "config.toml"), `[api]
api_url = "https://global.example.test"
auth_client_id = "global-client"
`)

	cfg, err := amikaconfig.LoadGlobalConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg == nil {
		t.Fatal("expected non-nil config")
	}
	if cfg.API.APIURL != "https://global.example.test" {
		t.Errorf("expected api_url %q, got %q", "https://global.example.test", cfg.API.APIURL)
	}
	if cfg.API.AuthClientID != "global-client" {
		t.Errorf("expected auth_client_id %q, got %q", "global-client", cfg.API.AuthClientID)
	}
}

func TestMerge_RepoOverridesGlobal(t *testing.T) {
	globalCfg := &amikaconfig.Config{
		API: amikaconfig.APIConfig{
			APIURL:       "https://global.example.test",
			AuthClientID: "global-client",
		},
		Lifecycle: amikaconfig.LifecycleConfig{
			SetupScript: "global-setup.sh",
		},
		Services: map[string]amikaconfig.ServiceConfig{
			"api": {Port: int64(8080)},
			"web": {Port: int64(3000)},
		},
	}
	repoCfg := &amikaconfig.Config{
		API: amikaconfig.APIConfig{
			APIURL: "https://repo.example.test",
		},
		Lifecycle: amikaconfig.LifecycleConfig{
			SetupScript: "repo-setup.sh",
		},
		Services: map[string]amikaconfig.ServiceConfig{
			"api":     {Port: int64(9090)},
			"metrics": {Port: "9091/tcp"},
		},
	}

	merged := amikaconfig.Merge(globalCfg, repoCfg)
	if merged == nil {
		t.Fatal("expected non-nil merged config")
	}
	if merged.API.APIURL != "https://repo.example.test" {
		t.Errorf("expected repo api_url override, got %q", merged.API.APIURL)
	}
	if merged.API.AuthClientID != "global-client" {
		t.Errorf("expected inherited auth_client_id, got %q", merged.API.AuthClientID)
	}
	if merged.Lifecycle.SetupScript != "repo-setup.sh" {
		t.Errorf("expected repo setup_script override, got %q", merged.Lifecycle.SetupScript)
	}
	if got := merged.Services["api"].Port; got != int64(9090) {
		t.Errorf("expected repo api service override, got %#v", got)
	}
	if got := merged.Services["web"].Port; got != int64(3000) {
		t.Errorf("expected inherited web service, got %#v", got)
	}
	if got := merged.Services["metrics"].Port; got != "9091/tcp" {
		t.Errorf("expected repo metrics service, got %#v", got)
	}
}

func TestLoadEffectiveConfig_MergesGlobalAndRepo(t *testing.T) {
	home := t.TempDir()
	configHome := filepath.Join(home, ".config")
	setXDGConfigHome(t, configHome)
	writeConfigFile(t, filepath.Join(configHome, "amika", "config.toml"), `[api]
api_url = "https://global.example.test"
auth_client_id = "global-client"

[services.api]
port = 8080
`)

	repoRoot := t.TempDir()
	writeConfigFile(t, filepath.Join(repoRoot, ".amika", "config.toml"), `[api]
auth_client_id = "repo-client"

[services.web]
port = 3000
`)

	cfg, err := amikaconfig.LoadEffectiveConfig(repoRoot)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg == nil {
		t.Fatal("expected non-nil config")
	}
	if cfg.API.APIURL != "https://global.example.test" {
		t.Errorf("expected inherited api_url, got %q", cfg.API.APIURL)
	}
	if cfg.API.AuthClientID != "repo-client" {
		t.Errorf("expected repo auth_client_id override, got %q", cfg.API.AuthClientID)
	}
	if got := cfg.Services["api"].Port; got != int64(8080) {
		t.Errorf("expected inherited api service, got %#v", got)
	}
	if got := cfg.Services["web"].Port; got != int64(3000) {
		t.Errorf("expected repo web service, got %#v", got)
	}
}

// Helper to load a config from TOML content.
func loadFromTOML(t *testing.T, content string) *amikaconfig.Config {
	t.Helper()
	dir := t.TempDir()
	amikaDir := filepath.Join(dir, ".amika")
	if err := os.Mkdir(amikaDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(amikaDir, "config.toml"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	cfg, err := amikaconfig.LoadConfig(dir)
	if err != nil {
		t.Fatalf("unexpected error loading config: %v", err)
	}
	if cfg == nil {
		t.Fatal("expected non-nil config")
	}
	return cfg
}

func setXDGConfigHome(t *testing.T, path string) {
	t.Helper()
	orig, had := os.LookupEnv("XDG_CONFIG_HOME")
	if err := os.Setenv("XDG_CONFIG_HOME", path); err != nil {
		t.Fatalf("Setenv(XDG_CONFIG_HOME): %v", err)
	}
	t.Cleanup(func() {
		if had {
			_ = os.Setenv("XDG_CONFIG_HOME", orig)
		} else {
			_ = os.Unsetenv("XDG_CONFIG_HOME")
		}
	})
}

func writeConfigFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("failed to create config dir: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("failed to write config file: %v", err)
	}
}

// Test 1: Single port = 4838 → 4838/tcp
func TestParsedServices_SinglePortInt(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.api]
port = 4838
`)
	services, err := cfg.ParsedServices()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(services) != 1 {
		t.Fatalf("expected 1 service, got %d", len(services))
	}
	if services[0].Name != "api" {
		t.Errorf("expected name %q, got %q", "api", services[0].Name)
	}
	if len(services[0].Ports) != 1 {
		t.Fatalf("expected 1 port, got %d", len(services[0].Ports))
	}
	p := services[0].Ports[0]
	if p.ContainerPort != 4838 || p.Protocol != "tcp" {
		t.Errorf("expected 4838/tcp, got %d/%s", p.ContainerPort, p.Protocol)
	}
}

// Test 2: port = "9090/udp" → 9090/udp
func TestParsedServices_SinglePortStringUDP(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.metrics]
port = "9090/udp"
`)
	services, err := cfg.ParsedServices()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	p := services[0].Ports[0]
	if p.ContainerPort != 9090 || p.Protocol != "udp" {
		t.Errorf("expected 9090/udp, got %d/%s", p.ContainerPort, p.Protocol)
	}
}

// Test 3: ports = [3000, "3001/tcp", "9090/udp"] → three ports
func TestParsedServices_MultiplePorts(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.web]
ports = [3000, "3001/tcp", "9090/udp"]
`)
	services, err := cfg.ParsedServices()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	ports := services[0].Ports
	if len(ports) != 3 {
		t.Fatalf("expected 3 ports, got %d", len(ports))
	}
	expected := []struct {
		port  int
		proto string
	}{
		{3000, "tcp"},
		{3001, "tcp"},
		{9090, "udp"},
	}
	for i, e := range expected {
		if ports[i].ContainerPort != e.port || ports[i].Protocol != e.proto {
			t.Errorf("port %d: expected %d/%s, got %d/%s", i, e.port, e.proto, ports[i].ContainerPort, ports[i].Protocol)
		}
	}
}

// Test 4: Both port and ports set → error
func TestParsedServices_ErrorBothPortAndPorts(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.api]
port = 4838
ports = [3000]
`)
	_, err := cfg.ParsedServices()
	if err == nil {
		t.Fatal("expected error for both port and ports, got nil")
	}
}

// Test 5: Neither port nor ports → valid metadata-only service
func TestParsedServices_NeitherPortNorPorts(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.api]
`)
	services, err := cfg.ParsedServices()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(services) != 1 {
		t.Fatalf("expected 1 service, got %d", len(services))
	}
	if services[0].Name != "api" {
		t.Errorf("expected name %q, got %q", "api", services[0].Name)
	}
	if len(services[0].Ports) != 0 {
		t.Errorf("expected 0 ports, got %d", len(services[0].Ports))
	}
}

// Test 6: Port outside 1-65535 → error
func TestParsedServices_ErrorPortOutOfRange(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.api]
port = 70000
`)
	_, err := cfg.ParsedServices()
	if err == nil {
		t.Fatal("expected error for port out of range, got nil")
	}
}

// Test 7: Invalid protocol → error
func TestParsedServices_ErrorInvalidProtocol(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.api]
port = "4838/sctp"
`)
	_, err := cfg.ParsedServices()
	if err == nil {
		t.Fatal("expected error for invalid protocol, got nil")
	}
}

// Test 8: Reserved port in range 60899-60999 → error
func TestParsedServices_ErrorReservedPort(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.api]
port = 60900
`)
	_, err := cfg.ParsedServices()
	if err == nil {
		t.Fatal("expected error for reserved port, got nil")
	}
}

// Test 9: Duplicate container port/protocol across services → error
func TestParsedServices_ErrorDuplicateAcrossServices(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.api]
port = 4838

[services.other]
port = 4838
`)
	_, err := cfg.ParsedServices()
	if err == nil {
		t.Fatal("expected error for duplicate port across services, got nil")
	}
}

// Test 10: No services sections → nil services, no error
func TestParsedServices_NoServices(t *testing.T) {
	cfg := loadFromTOML(t, `
[lifecycle]
setup_script = "setup.sh"
`)
	services, err := cfg.ParsedServices()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if services != nil {
		t.Fatalf("expected nil services, got %v", services)
	}
}

// Test 11: Single-port with url_scheme = "http"
func TestParsedServices_URLSchemeHTTP(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.api]
port = 4838
url_scheme = "http"
`)
	services, err := cfg.ParsedServices()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if services[0].Ports[0].URLScheme != "http" {
		t.Errorf("expected URLScheme %q, got %q", "http", services[0].Ports[0].URLScheme)
	}
}

// Test 12: Single-port with url_scheme = "https"
func TestParsedServices_URLSchemeHTTPS(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.api]
port = 4838
url_scheme = "https"
`)
	services, err := cfg.ParsedServices()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if services[0].Ports[0].URLScheme != "https" {
		t.Errorf("expected URLScheme %q, got %q", "https", services[0].Ports[0].URLScheme)
	}
}

// Test 13: No url_scheme → empty URLScheme on all ports
func TestParsedServices_NoURLScheme(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.api]
port = 4838
`)
	services, err := cfg.ParsedServices()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if services[0].Ports[0].URLScheme != "" {
		t.Errorf("expected empty URLScheme, got %q", services[0].Ports[0].URLScheme)
	}
}

// Test 14: Invalid scheme value → error
func TestParsedServices_ErrorInvalidScheme(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.api]
port = 4838
url_scheme = "ftp"
`)
	_, err := cfg.ParsedServices()
	if err == nil {
		t.Fatal("expected error for invalid scheme, got nil")
	}
}

// Test 15: Multi-port with url_scheme list — only mapped port gets scheme
func TestParsedServices_MultiPortURLScheme(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.web]
ports = [3000, "3001/tcp"]
url_scheme = [
  { port = 3000, scheme = "http" },
]
`)
	services, err := cfg.ParsedServices()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	ports := services[0].Ports
	if ports[0].URLScheme != "http" {
		t.Errorf("port 3000: expected URLScheme %q, got %q", "http", ports[0].URLScheme)
	}
	if ports[1].URLScheme != "" {
		t.Errorf("port 3001: expected empty URLScheme, got %q", ports[1].URLScheme)
	}
}

// Test 16: port used with list-form url_scheme → allowed
func TestParsedServices_PortWithListScheme(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.api]
port = 4838
url_scheme = [
  { port = 4838, scheme = "http" },
]
`)
	services, err := cfg.ParsedServices()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(services) != 1 {
		t.Fatalf("expected 1 service, got %d", len(services))
	}
	if services[0].Ports[0].URLScheme != "http" {
		t.Errorf("expected URLScheme %q, got %q", "http", services[0].Ports[0].URLScheme)
	}
}

func TestParsedServices_PortWithEmptyListScheme(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.api]
port = 4838
url_scheme = []
`)
	services, err := cfg.ParsedServices()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if services[0].Ports[0].URLScheme != "" {
		t.Errorf("expected empty URLScheme, got %q", services[0].Ports[0].URLScheme)
	}
}

func TestParsedServices_ErrorPortWithMismatchedListSchemePort(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.api]
port = 4838
url_scheme = [
  { port = 9999, scheme = "http" },
]
`)
	_, err := cfg.ParsedServices()
	if err == nil {
		t.Fatal("expected error for mismatched single-port url_scheme entry, got nil")
	}
}

func TestParsedServices_ErrorPortWithMultipleListSchemes(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.api]
port = 4838
url_scheme = [
  { port = 4838, scheme = "http" },
  { port = 4838, scheme = "https" },
]
`)
	_, err := cfg.ParsedServices()
	if err == nil {
		t.Fatal("expected error for multiple single-port url_scheme entries, got nil")
	}
}

// Test 17: ports used with string url_scheme → error
func TestParsedServices_ErrorPortsWithStringScheme(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.api]
ports = [4838]
url_scheme = "http"
`)
	_, err := cfg.ParsedServices()
	if err == nil {
		t.Fatal("expected error for ports with string url_scheme, got nil")
	}
}

// Test 18: url_scheme references undeclared port → error
func TestParsedServices_ErrorSchemeUndeclaredPort(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.web]
ports = [3000]
url_scheme = [
  { port = 9999, scheme = "http" },
]
`)
	_, err := cfg.ParsedServices()
	if err == nil {
		t.Fatal("expected error for url_scheme referencing undeclared port, got nil")
	}
}

// Test 19: Duplicate port in url_scheme list → error
func TestParsedServices_ErrorDuplicateSchemePort(t *testing.T) {
	cfg := loadFromTOML(t, `
[services.web]
ports = [3000, 3001]
url_scheme = [
  { port = 3000, scheme = "http" },
  { port = 3000, scheme = "https" },
]
`)
	_, err := cfg.ParsedServices()
	if err == nil {
		t.Fatal("expected error for duplicate port in url_scheme, got nil")
	}
}
