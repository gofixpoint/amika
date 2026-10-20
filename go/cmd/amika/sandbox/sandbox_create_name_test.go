package sandboxcmd

import (
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func TestCreateName(t *testing.T) {
	newCmd := func() *cobra.Command {
		c := &cobra.Command{}
		c.Flags().String("name", "", "")
		return c
	}

	t.Run("takes the positional argument", func(t *testing.T) {
		got, err := createName(newCmd(), []string{"dev"})
		if err != nil || got != "dev" {
			t.Errorf("got %q, %v; want dev", got, err)
		}
	})

	t.Run("still reads the legacy --name flag", func(t *testing.T) {
		c := newCmd()
		c.Flags().Set("name", "dev")
		got, err := createName(c, nil)
		if err != nil || got != "dev" {
			t.Errorf("got %q, %v; want dev", got, err)
		}
	})

	t.Run("returns empty when unnamed so a name is generated", func(t *testing.T) {
		got, err := createName(newCmd(), nil)
		if err != nil || got != "" {
			t.Errorf("got %q, %v; want empty", got, err)
		}
	})

	t.Run("refuses naming the rig both ways", func(t *testing.T) {
		c := newCmd()
		c.Flags().Set("name", "dev")
		_, err := createName(c, []string{"dev"})
		if err == nil || !strings.Contains(err.Error(), "not both") {
			t.Errorf("got %v; want the both-ways error", err)
		}
	})
}
