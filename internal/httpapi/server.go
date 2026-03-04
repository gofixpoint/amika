package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"
	"github.com/gofixpoint/amika/pkg/amika"
)

// NewHandler creates an HTTP handler that exposes the Amika API.
func NewHandler(service amika.Service) http.Handler {
	mux := http.NewServeMux()
	config := huma.DefaultConfig("Amika API", "0.1.0")
	config.OpenAPIPath = "/openapi.json"
	config.DocsPath = "/docs"

	api := humago.New(mux, config)
	registerHealth(api)
	registerListSandboxes(api, service)
	registerMaterialize(api, service)
	mux.HandleFunc("/openapi.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(api.OpenAPI())
	})

	return mux
}

type healthOutput struct {
	Body struct {
		Status string `json:"status"`
	}
}

func registerHealth(api huma.API) {
	huma.Get(api, "/v1/health", func(context.Context, *struct{}) (*healthOutput, error) {
		out := &healthOutput{}
		out.Body.Status = "ok"
		return out, nil
	})
}

type listSandboxesOutput struct {
	Body amika.ListSandboxesResult
}

func registerListSandboxes(api huma.API, service amika.Service) {
	huma.Get(api, "/v1/sandboxes", func(ctx context.Context, _ *struct{}) (*listSandboxesOutput, error) {
		result, err := service.ListSandboxes(ctx, amika.ListSandboxesRequest{})
		if err != nil {
			return nil, toHTTPError(err)
		}
		return &listSandboxesOutput{Body: result}, nil
	})
}

type materializeInput struct {
	Body amika.MaterializeRequest
}

type materializeOutput struct {
	Body amika.MaterializeResult
}

func registerMaterialize(api huma.API, service amika.Service) {
	huma.Post(api, "/v1/materialize", func(ctx context.Context, input *materializeInput) (*materializeOutput, error) {
		result, err := service.Materialize(ctx, input.Body)
		if err != nil {
			return nil, toHTTPError(err)
		}
		return &materializeOutput{Body: result}, nil
	})
}

func toHTTPError(err error) huma.StatusError {
	switch {
	case errors.Is(err, amika.ErrInvalidArgument):
		return huma.Error400BadRequest(err.Error())
	case errors.Is(err, amika.ErrNotFound):
		return huma.Error404NotFound(err.Error())
	case errors.Is(err, amika.ErrUnimplemented):
		return huma.Error501NotImplemented(err.Error())
	case errors.Is(err, amika.ErrDependency):
		return huma.Error503ServiceUnavailable(err.Error())
	default:
		return huma.Error500InternalServerError(fmt.Sprintf("internal error: %v", err))
	}
}
