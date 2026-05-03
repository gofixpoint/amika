package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"
	"github.com/gofixpoint/amika/internal/watcher"
	"github.com/gofixpoint/amika/pkg/amika"
)

// NewHandler creates an HTTP handler that exposes the Amika API.
func NewHandler(service amika.Service) http.Handler {
	return NewHandlerWithEvents(service, nil)
}

// NewHandlerWithEvents creates an HTTP handler with optional SSE event streaming.
// If eventBroker is non-nil, a GET /v1/events SSE endpoint is registered.
func NewHandlerWithEvents(service amika.Service, eventBroker *EventBroker) http.Handler {
	mux := http.NewServeMux()
	config := huma.DefaultConfig("Amika API", "0.1.0")
	config.OpenAPIPath = "/openapi.json"
	config.DocsPath = "/docs"

	api := humago.New(mux, config)
	registerHealth(api)
	registerListSandboxes(api, service)
	registerCreateSandbox(api, service)
	registerDeleteSandbox(api, service)
	registerListVolumes(api, service)
	registerDeleteVolume(api, service)
	registerAuthExtract(api, service)
	registerMaterialize(api, service)
	registerListServices(api, service)
	mux.HandleFunc("/openapi.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(api.OpenAPI())
	})
	if eventBroker != nil {
		mux.HandleFunc("/v1/events", eventBroker.ServeHTTP)
	}

	return mux
}

// EventBroker distributes watcher events to SSE clients.
type EventBroker struct {
	mu      sync.Mutex
	clients map[chan watcher.Event]struct{}
}

// NewEventBroker creates an EventBroker.
func NewEventBroker() *EventBroker {
	return &EventBroker{clients: make(map[chan watcher.Event]struct{})}
}

// Handler returns a watcher.Handler that broadcasts events to all SSE clients.
func (b *EventBroker) Handler() watcher.Handler {
	return func(e watcher.Event) {
		b.mu.Lock()
		defer b.mu.Unlock()
		for ch := range b.clients {
			select {
			case ch <- e:
			default:
				// drop if client is slow
			}
		}
	}
}

// ServeHTTP handles SSE connections on GET /v1/events.
func (b *EventBroker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch := make(chan watcher.Event, 16)
	b.mu.Lock()
	b.clients[ch] = struct{}{}
	b.mu.Unlock()

	defer func() {
		b.mu.Lock()
		delete(b.clients, ch)
		b.mu.Unlock()
	}()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case e := <-ch:
			data, err := json.Marshal(e)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", e.Type, data)
			flusher.Flush()
		}
	}
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

type listSandboxesOutput struct{ Body amika.ListSandboxesResult }

func registerListSandboxes(api huma.API, service amika.Service) {
	huma.Get(api, "/v1/sandboxes", func(ctx context.Context, _ *struct{}) (*listSandboxesOutput, error) {
		result, err := service.ListSandboxes(ctx, amika.ListSandboxesRequest{})
		if err != nil {
			return nil, toHTTPError(err)
		}
		return &listSandboxesOutput{Body: result}, nil
	})
}

type createSandboxInput struct{ Body amika.CreateSandboxRequest }
type createSandboxOutput struct{ Body amika.Sandbox }

func registerCreateSandbox(api huma.API, service amika.Service) {
	huma.Post(api, "/v1/sandboxes", func(ctx context.Context, input *createSandboxInput) (*createSandboxOutput, error) {
		result, err := service.CreateSandbox(ctx, input.Body)
		if err != nil {
			return nil, toHTTPError(err)
		}
		return &createSandboxOutput{Body: result}, nil
	})
}

type deleteSandboxInput struct {
	Name string `path:"name"`
}
type deleteSandboxOutput struct{ Body amika.DeleteSandboxResult }

func registerDeleteSandbox(api huma.API, service amika.Service) {
	huma.Delete(api, "/v1/sandboxes/{name}", func(ctx context.Context, input *deleteSandboxInput) (*deleteSandboxOutput, error) {
		result, err := service.DeleteSandbox(ctx, amika.DeleteSandboxRequest{Names: []string{input.Name}})
		if err != nil {
			return nil, toHTTPError(err)
		}
		return &deleteSandboxOutput{Body: result}, nil
	})
}

type listVolumesOutput struct{ Body amika.ListVolumesResult }

func registerListVolumes(api huma.API, service amika.Service) {
	huma.Get(api, "/v1/volumes", func(ctx context.Context, _ *struct{}) (*listVolumesOutput, error) {
		result, err := service.ListVolumes(ctx, amika.ListVolumesRequest{})
		if err != nil {
			return nil, toHTTPError(err)
		}
		return &listVolumesOutput{Body: result}, nil
	})
}

type deleteVolumeInput struct {
	Name string `path:"name"`
}
type deleteVolumeOutput struct{ Body amika.DeleteVolumeResult }

func registerDeleteVolume(api huma.API, service amika.Service) {
	huma.Delete(api, "/v1/volumes/{name}", func(ctx context.Context, input *deleteVolumeInput) (*deleteVolumeOutput, error) {
		result, err := service.DeleteVolume(ctx, amika.DeleteVolumeRequest{Names: []string{input.Name}})
		if err != nil {
			return nil, toHTTPError(err)
		}
		return &deleteVolumeOutput{Body: result}, nil
	})
}

type authExtractInput struct{ Body amika.AuthExtractRequest }
type authExtractOutput struct{ Body amika.AuthExtractResult }

func registerAuthExtract(api huma.API, service amika.Service) {
	huma.Post(api, "/v1/auth/extract", func(ctx context.Context, input *authExtractInput) (*authExtractOutput, error) {
		result, err := service.ExtractAuth(ctx, input.Body)
		if err != nil {
			return nil, toHTTPError(err)
		}
		return &authExtractOutput{Body: result}, nil
	})
}

type materializeInput struct{ Body amika.MaterializeRequest }
type materializeOutput struct{ Body amika.MaterializeResult }

func registerMaterialize(api huma.API, service amika.Service) {
	huma.Post(api, "/v1/materialize", func(ctx context.Context, input *materializeInput) (*materializeOutput, error) {
		result, err := service.Materialize(ctx, input.Body)
		if err != nil {
			return nil, toHTTPError(err)
		}
		return &materializeOutput{Body: result}, nil
	})
}

type listServicesInput struct {
	SandboxName string `query:"sandbox_name"`
}
type listServicesOutput struct{ Body amika.ListServicesResult }

func registerListServices(api huma.API, service amika.Service) {
	huma.Get(api, "/v1/services", func(ctx context.Context, input *listServicesInput) (*listServicesOutput, error) {
		result, err := service.ListServices(ctx, amika.ListServicesRequest{
			SandboxName: input.SandboxName,
		})
		if err != nil {
			return nil, toHTTPError(err)
		}
		return &listServicesOutput{Body: result}, nil
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
