package sandboxcmd

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/sandbox"
	"github.com/spf13/cobra"
)

func TestSandboxDetailFromInfo(t *testing.T) {
	info := sandbox.Info{
		Name:        "box",
		Provider:    "docker",
		ContainerID: "abc123",
		Image:       "img:latest",
		Branch:      "main",
		Ports:       []sandbox.PortBinding{{HostIP: "127.0.0.1", HostPort: 8080, ContainerPort: 80, Protocol: "tcp"}},
		Services: []sandbox.ServiceInfo{{
			Name:  "web",
			Ports: []sandbox.ServicePortInfo{{PortBinding: sandbox.PortBinding{HostPort: 8080, ContainerPort: 80}, URL: "http://x"}},
		}},
	}
	d := sandboxDetailFromInfo(info)
	if d.Location != "local" {
		t.Errorf("Location = %q, want local", d.Location)
	}
	var buf bytes.Buffer
	if err := output.FormatJSON.JSON(&buf, d); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"name":"box"`,
		`"location":"local"`,
		`"container_id":"abc123"`,
		`"host_port":8080`,
		`"services":[{"name":"web"`,
		`"url":"http://x"`,
	} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("detail JSON missing %q, got:\n%s", want, buf.String())
		}
	}
}

func TestSandboxDetailFromRemoteGroupsServices(t *testing.T) {
	sb := &apiclient.RemoteSandbox{
		Name:     "rbox",
		State:    "started",
		Provider: "daytona",
		Services: []apiclient.RemoteSandboxService{
			{Name: "web", HostPort: 80, ContainerPort: 80, Protocol: "tcp", URL: "https://a"},
			{Name: "web", HostPort: 443, ContainerPort: 443, Protocol: "tcp", URL: "https://b"},
			{Name: "db", HostPort: 5432, ContainerPort: 5432, Protocol: "tcp"},
		},
	}
	d := sandboxDetailFromRemote(sb)
	if d.Location != "remote" || d.State != "started" {
		t.Fatalf("unexpected detail: %+v", d)
	}
	if len(d.Services) != 2 {
		t.Fatalf("expected 2 grouped services, got %d", len(d.Services))
	}
	if d.Services[0].Name != "web" || len(d.Services[0].Ports) != 2 {
		t.Errorf("web service not grouped: %+v", d.Services[0])
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
		if err := finishBatch(c, output.FormatJSON, nil); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if buf.String() != "[]\n" {
			t.Fatalf("got %q, want %q", buf.String(), "[]\n")
		}
	})

	t.Run("json with failure returns error and emits results", func(t *testing.T) {
		c, buf := newCmd()
		results := []output.ItemResult{
			{Name: "a", Status: "started"},
			batchError("b", errors.New("boom")),
		}
		err := finishBatch(c, output.FormatJSON, results)
		if err == nil {
			t.Fatal("expected error when an item failed")
		}
		if !strings.Contains(buf.String(), `"status":"error"`) || !strings.Contains(buf.String(), `"error":"boom"`) {
			t.Fatalf("JSON missing failure detail: %s", buf.String())
		}
	})

	t.Run("text with failure returns combined error, no stdout", func(t *testing.T) {
		c, buf := newCmd()
		results := []output.ItemResult{batchError("b", errors.New("boom"))}
		err := finishBatch(c, output.FormatText, results)
		if err == nil || !strings.Contains(err.Error(), "boom") {
			t.Fatalf("expected combined error, got %v", err)
		}
		if buf.Len() != 0 {
			t.Fatalf("text finishBatch should not write to stdout, got %q", buf.String())
		}
	})
}
