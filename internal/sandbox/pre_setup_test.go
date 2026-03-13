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
		`AMIKA_USER_STATE_DIR="/var/lib/amika"`,
		`AMIKA_LOG_DIR="/var/log/amikad"`,
		`AMIKA_USER_LOG_DIR="/var/log/amika"`,
		`AMIKA_RUN_DIR="/run/amikad"`,
		`AMIKA_USER_RUN_DIR="/run/amika"`,
		`AMIKA_TMP_DIR="/tmp/amikad"`,
		`AMIKA_USER_TMP_DIR="/tmp/amika"`,
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("pre-setup.sh missing %q", want)
		}
	}
	for _, forbidden := range []string{
		`${AMIKA_STATE_DIR:-/var/lib/amikad}`,
		`${AMIKA_USER_STATE_DIR:-/var/lib/amika}`,
		`${AMIKA_LOG_DIR:-/var/log/amikad}`,
		`${AMIKA_USER_LOG_DIR:-/var/log/amika}`,
		`${AMIKA_RUN_DIR:-/run/amikad}`,
		`${AMIKA_USER_RUN_DIR:-/run/amika}`,
		`${AMIKA_TMP_DIR:-/tmp/amikad}`,
		`${AMIKA_USER_TMP_DIR:-/tmp/amika}`,
	} {
		if strings.Contains(content, forbidden) {
			t.Fatalf("pre-setup.sh should not allow overriding %q", forbidden)
		}
	}
}

func TestPresetPreSetup_CreatesAmikaAndAmikadDirectories(t *testing.T) {
	data, err := presetFS.ReadFile("presets/pre-setup.sh")
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}

	content := string(data)
	for _, want := range []string{
		`"$AMIKA_STATE_DIR" "$AMIKA_USER_STATE_DIR"`,
		`"$AMIKA_LOG_DIR" "$AMIKA_USER_LOG_DIR"`,
		`"$AMIKA_RUN_DIR" "$AMIKA_USER_RUN_DIR"`,
		`"$AMIKA_TMP_DIR" "$AMIKA_USER_TMP_DIR"`,
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("pre-setup.sh should create paired amika/amikad directories, missing %q", want)
		}
	}
}

func TestPresetPreSetup_ChownsUserManagedAmikaDirectories(t *testing.T) {
	data, err := presetFS.ReadFile("presets/pre-setup.sh")
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}

	content := string(data)
	if !strings.Contains(content, `chown -R amika:amika \`) {
		t.Fatal("pre-setup.sh should chown user-managed amika directories to the amika user")
	}
	for _, want := range []string{
		`"$AMIKA_USER_STATE_DIR"`,
		`"$AMIKA_USER_LOG_DIR"`,
		`"$AMIKA_USER_RUN_DIR"`,
		`"$AMIKA_USER_TMP_DIR"`,
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("pre-setup.sh should chown %q", want)
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

func TestPresetRunHook_UsesAmikaOnlyForSetupAndMirrorsItToAmikad(t *testing.T) {
	data, err := presetFS.ReadFile("presets/run-hook.sh")
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}

	content := string(data)
	for _, want := range []string{
		`daemon_log_dir="/var/log/amikad"`,
		`daemon_log_file="$daemon_log_dir/${script_name%.sh}.log"`,
		`if [[ "$script_name" == "setup.sh" ]]; then`,
		`log_file="/var/log/amika/setup.log"`,
		`mirror_to_daemon=1`,
		`exec >>"$log_file" 2>&1`,
		`sudo cp "$log_file" "$daemon_log_file"`,
		`export BASH_ENV="/usr/lib/amikad/bash-error-prelude.sh"`,
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("run-hook.sh missing %q", want)
		}
	}
}

func TestPresetBashErrorPrelude_LogsErrTrapDetails(t *testing.T) {
	data, err := presetFS.ReadFile("presets/bash-error-prelude.sh")
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}

	content := string(data)
	for _, want := range []string{
		`trap 'status=$?; if [[ $status -ne 0 ]]; then`,
		`ERROR ${AMIKA_HOOK_SCRIPT_NAME:-hook} exit=$status`,
		`command=${BASH_COMMAND@Q}`,
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("bash-error-prelude.sh missing %q", want)
		}
	}
}
