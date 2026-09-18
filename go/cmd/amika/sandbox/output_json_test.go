package sandboxcmd

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/spf13/cobra"
)

func TestNormalizeSandboxJSON_ServicesNeverNull(t *testing.T) {
	sb := apiclient.RemoteSandbox{ID: "a", Name: "a"}
	if sb.Services != nil {
		t.Fatalf("precondition: Services should start nil")
	}
	got := normalizeSandboxJSON(sb)
	if got.Services == nil {
		t.Fatal("normalizeSandboxJSON should turn a nil Services into an empty slice")
	}

	var buf bytes.Buffer
	if err := output.FormatJSON.JSON(&buf, got); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), `"services":[]`) {
		t.Errorf("expected services:[], got: %s", buf.String())
	}
}

func TestFinishBatch(t *testing.T) {
	newCmd := func() (*cobra.Command, *bytes.Buffer) {
		buf := &bytes.Buffer{}
		c := &cobra.Command{}
		c.SetOut(buf)
		return c, buf
	}

	t.Run("json empty is empty array", func(t *testing.T) {
		c, buf := newCmd()
		if err := finishBatch(c, output.FormatJSON, nil, nil); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if buf.String() != "[]\n" {
			t.Fatalf("got %q, want %q", buf.String(), "[]\n")
		}
	})

	t.Run("json with failure returns error and emits results", func(t *testing.T) {
		c, buf := newCmd()
		var items []any
		var failed []string
		items = append(items, apiclient.RemoteSandbox{ID: "a", Name: "a", Services: []apiclient.RemoteSandboxService{}})
		appendBatchFailure(&items, &failed, "b", errors.New("boom"))
		err := finishBatch(c, output.FormatJSON, items, failed)
		if err == nil {
			t.Fatal("expected error when an item failed")
		}
		if !strings.Contains(buf.String(), `"status":"error"`) || !strings.Contains(buf.String(), `"error":"boom"`) {
			t.Fatalf("JSON missing failure detail: %s", buf.String())
		}
		if !strings.Contains(buf.String(), `"name":"a"`) {
			t.Fatalf("JSON missing successful resource: %s", buf.String())
		}
	})

	t.Run("text with failure returns combined error, no stdout", func(t *testing.T) {
		c, buf := newCmd()
		var items []any
		var failed []string
		appendBatchFailure(&items, &failed, "b", errors.New("boom"))
		err := finishBatch(c, output.FormatText, items, failed)
		if err == nil || !strings.Contains(err.Error(), "boom") {
			t.Fatalf("expected combined error, got %v", err)
		}
		if buf.Len() != 0 {
			t.Fatalf("text finishBatch should not write to stdout, got %q", buf.String())
		}
	})
}
