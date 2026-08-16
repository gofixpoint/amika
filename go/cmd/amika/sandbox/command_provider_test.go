package sandboxcmd

import (
	"testing"

	"github.com/spf13/cobra"
)

func TestSandboxCreateProviderFlagIsHidden(t *testing.T) {
	cmd := &cobra.Command{}
	addProviderFlag(cmd)
	flag := cmd.Flags().Lookup("provider")
	if flag == nil {
		t.Fatal("provider flag is missing")
	}
	if !flag.Hidden {
		t.Fatal("provider flag should be hidden")
	}
	if flag.DefValue != "" {
		t.Fatalf("provider flag default = %q, want empty", flag.DefValue)
	}
}

func TestRequestedRemoteProvider(t *testing.T) {
	cmd := &cobra.Command{}
	addProviderFlag(cmd)

	if got := requestedRemoteProvider(cmd); got != "" {
		t.Fatalf("unchanged provider = %q, want omitted", got)
	}
	if err := cmd.Flags().Set("provider", "freestyle"); err != nil {
		t.Fatal(err)
	}
	if got := requestedRemoteProvider(cmd); got != "freestyle" {
		t.Fatalf("explicit provider = %q, want freestyle", got)
	}
}
