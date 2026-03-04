package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofixpoint/amika/pkg/amika"
)

func TestHealthEndpoint(t *testing.T) {
	h := NewHandler(amika.NewService(amika.Options{}))

	req := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to unmarshal health payload: %v", err)
	}
	if body.Status != "ok" {
		t.Fatalf("status body = %q, want %q", body.Status, "ok")
	}
}

func TestOpenAPIServed(t *testing.T) {
	h := NewHandler(amika.NewService(amika.Options{}))

	req := httptest.NewRequest(http.MethodGet, "/openapi.json", nil)
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
}

func TestUnimplementedServiceMapsTo501(t *testing.T) {
	h := NewHandler(amika.NewService(amika.Options{}))

	req := httptest.NewRequest(http.MethodGet, "/v1/sandboxes", nil)
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)

	if res.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusNotImplemented)
	}
}
