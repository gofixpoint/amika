package sandbox

import (
	"strings"
	"testing"
)

func TestPresetPreSetup_UsesFixedAmikaInternalPaths(t *testing.T) {
	data, err := presetFS.ReadFile("presets/pre-setup.sh")
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}

	content := string(data)
	for _, want := range []string{
		`AMIKA_STATE_DIR="/var/lib/amikad"`,
		`AMIKA_LOG_DIR="/var/log/amikad"`,
		`AMIKA_RUN_DIR="/run/amikad"`,
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("pre-setup.sh missing %q", want)
		}
	}
	for _, forbidden := range []string{
		`${AMIKA_STATE_DIR:-/var/lib/amikad}`,
		`${AMIKA_LOG_DIR:-/var/log/amikad}`,
		`${AMIKA_RUN_DIR:-/run/amikad}`,
	} {
		if strings.Contains(content, forbidden) {
			t.Fatalf("pre-setup.sh should not allow overriding %q", forbidden)
		}
	}
}

func TestPresetPreSetup_OpenCodeGatingContract(t *testing.T) {
	data, err := presetFS.ReadFile("presets/pre-setup.sh")
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}

	content := string(data)
	if !strings.Contains(content, `[[ "${AMIKA_OPENCODE_WEB:-1}" != "0" ]]`) {
		t.Fatal("pre-setup.sh should allow opting out of opencode web startup via AMIKA_OPENCODE_WEB=0")
	}
	if !strings.Contains(content, `OPENCODE_SERVER_PASSWORD must be set`) {
		t.Fatal("pre-setup.sh should require OPENCODE_SERVER_PASSWORD when opencode web startup is enabled")
	}
}
