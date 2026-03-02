package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofixpoint/amika/pkg/amika"
)

type stubService struct{}

func (stubService) CreateSandbox(context.Context, amika.CreateSandboxRequest) (amika.Sandbox, error) {
	return amika.Sandbox{}, amika.ErrUnimplemented
}
func (stubService) DeleteSandbox(context.Context, amika.DeleteSandboxRequest) (amika.DeleteSandboxResult, error) {
	return amika.DeleteSandboxResult{}, amika.ErrUnimplemented
}
func (stubService) ListSandboxes(context.Context, amika.ListSandboxesRequest) (amika.ListSandboxesResult, error) {
	return amika.ListSandboxesResult{Items: []amika.Sandbox{{Name: "sb"}}}, nil
}
func (stubService) ConnectSandbox(context.Context, amika.ConnectSandboxRequest) error {
	return amika.ErrUnimplemented
}
func (stubService) Materialize(context.Context, amika.MaterializeRequest) (amika.MaterializeResult, error) {
	return amika.MaterializeResult{}, amika.ErrInvalidArgument
}
func (stubService) ListVolumes(context.Context, amika.ListVolumesRequest) (amika.ListVolumesResult, error) {
	return amika.ListVolumesResult{Items: []amika.Volume{{Name: "v"}}}, nil
}
func (stubService) DeleteVolume(context.Context, amika.DeleteVolumeRequest) (amika.DeleteVolumeResult, error) {
	return amika.DeleteVolumeResult{}, amika.ErrUnimplemented
}
func (stubService) ExtractAuth(context.Context, amika.AuthExtractRequest) (amika.AuthExtractResult, error) {
	return amika.AuthExtractResult{Lines: []string{"A='1'"}}, nil
}

func TestEndpoints(t *testing.T) {
	h := NewHandler(stubService{})
	cases := []struct {
		m, u string
		code int
	}{
		{http.MethodGet, "/v1/health", 200},
		{http.MethodGet, "/v1/sandboxes", 200},
		{http.MethodPost, "/v1/sandboxes", 422},
		{http.MethodDelete, "/v1/sandboxes/sb", 501},
		{http.MethodGet, "/v1/volumes", 200},
		{http.MethodDelete, "/v1/volumes/v", 501},
		{http.MethodPost, "/v1/auth/extract", 422},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(tc.m, tc.u, bytes.NewReader([]byte(`{}`)))
		res := httptest.NewRecorder()
		h.ServeHTTP(res, req)
		if res.Code != tc.code {
			t.Fatalf("%s %s status=%d want=%d body=%s", tc.m, tc.u, res.Code, tc.code, res.Body.String())
		}
	}
}

func TestMaterializeBadRequestMaps400(t *testing.T) {
	h := NewHandler(stubService{})
	req := httptest.NewRequest(http.MethodPost, "/v1/materialize", bytes.NewReader([]byte(`{}`)))
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	if res.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestOpenAPIIncludesV1Paths(t *testing.T) {
	h := NewHandler(stubService{})
	req := httptest.NewRequest(http.MethodGet, "/openapi.json", nil)
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status=%d", res.Code)
	}
	var doc map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	paths := doc["paths"].(map[string]any)
	for _, p := range []string{"/v1/sandboxes", "/v1/volumes", "/v1/auth/extract", "/v1/materialize"} {
		if _, ok := paths[p]; !ok {
			t.Fatalf("missing path %s", p)
		}
	}
}
