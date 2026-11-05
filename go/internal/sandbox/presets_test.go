package sandbox

import "testing"

func TestValidateRemotePreset(t *testing.T) {
	for _, preset := range append([]string{""}, RemotePresets...) {
		if err := ValidateRemotePreset(preset); err != nil {
			t.Errorf("ValidateRemotePreset(%q) = %v, want nil", preset, err)
		}
	}
	if err := ValidateRemotePreset("missing-preset"); err == nil {
		t.Error("ValidateRemotePreset(\"missing-preset\") = nil, want error")
	}
}
