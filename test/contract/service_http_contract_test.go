package contract_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/gofixpoint/amika/internal/httpapi"
	"github.com/gofixpoint/amika/internal/sandbox"
	"github.com/gofixpoint/amika/pkg/amika"
)

func TestServiceHTTPParity_ListSandboxes(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", dir)
	store := sandbox.NewStore(filepath.Join(dir, "sandboxes.jsonl"))
	_ = store.Save(sandbox.Info{Name: "sb-a", Provider: "docker", Image: "img", CreatedAt: "now"})
	svc := amika.NewService(amika.Options{})
	direct, err := svc.ListSandboxes(context.Background(), amika.ListSandboxesRequest{})
	if err != nil {
		t.Fatal(err)
	}

	h := httpapi.NewHandler(svc)
	res := httptest.NewRecorder()
	h.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/v1/sandboxes", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("status=%d", res.Code)
	}
	var body amika.ListSandboxesResult
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != len(direct.Items) {
		t.Fatalf("len mismatch %d %d", len(body.Items), len(direct.Items))
	}
}

func TestServiceHTTPParity_MaterializeInvalid(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	svc := amika.NewService(amika.Options{})
	_, err := svc.Materialize(context.Background(), amika.MaterializeRequest{})
	if err == nil {
		t.Fatal("expected error")
	}

	h := httpapi.NewHandler(svc)
	res := httptest.NewRecorder()
	h.ServeHTTP(res, httptest.NewRequest(http.MethodPost, "/v1/materialize", bytes.NewReader([]byte(`{}`))))
	if res.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
}
