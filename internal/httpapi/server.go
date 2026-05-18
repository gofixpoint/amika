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
	registerCreateSandbox(api, service)
	registerDeleteSandbox(api, service)
	registerListVolumes(api, service)
	registerDeleteVolume(api, service)
	registerAuthExtract(api, service)
	registerMaterialize(api, service)
	registerListServices(api, service)
	registerSandboxCp(api, service)
	registerSandboxLs(api, service)
	registerSandboxCat(api, service)
	registerSandboxRm(api, service)
	registerSandboxStat(api, service)
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

type sandboxCpInput struct {
	Name string `path:"name"`
	Body struct {
		ContainerPath string `json:"containerPath"`
		HostPath      string `json:"hostPath"`
	}
}
type sandboxCpOutput struct{ Body amika.CopyFromSandboxResult }

func registerSandboxCp(api huma.API, service amika.Service) {
	huma.Post(api, "/v1/sandboxes/{name}/cp", func(ctx context.Context, input *sandboxCpInput) (*sandboxCpOutput, error) {
		result, err := service.CopyFromSandbox(ctx, amika.CopyFromSandboxRequest{
			Name:          input.Name,
			ContainerPath: input.Body.ContainerPath,
			HostPath:      input.Body.HostPath,
		})
		if err != nil {
			return nil, toHTTPError(err)
		}
		return &sandboxCpOutput{Body: result}, nil
	})
}

type sandboxLsInput struct {
	Name string `path:"name"`
	Body struct {
		Path string `json:"path"`
	}
}
type sandboxLsOutput struct{ Body amika.SandboxLsResult }

func registerSandboxLs(api huma.API, service amika.Service) {
	huma.Post(api, "/v1/sandboxes/{name}/ls", func(ctx context.Context, input *sandboxLsInput) (*sandboxLsOutput, error) {
		result, err := service.SandboxLs(ctx, amika.SandboxLsRequest{
			Name: input.Name,
			Path: input.Body.Path,
		})
		if err != nil {
			return nil, toHTTPError(err)
		}
		return &sandboxLsOutput{Body: result}, nil
	})
}

type sandboxCatInput struct {
	Name string `path:"name"`
	Body struct {
		Path     string `json:"path"`
		MaxBytes int64  `json:"maxBytes,omitempty"`
	}
}
type sandboxCatOutput struct{ Body amika.SandboxCatResult }

func registerSandboxCat(api huma.API, service amika.Service) {
	huma.Post(api, "/v1/sandboxes/{name}/cat", func(ctx context.Context, input *sandboxCatInput) (*sandboxCatOutput, error) {
		result, err := service.SandboxCat(ctx, amika.SandboxCatRequest{
			Name:     input.Name,
			Path:     input.Body.Path,
			MaxBytes: input.Body.MaxBytes,
		})
		if err != nil {
			return nil, toHTTPError(err)
		}
		return &sandboxCatOutput{Body: result}, nil
	})
}

type sandboxRmInput struct {
	Name string `path:"name"`
	Body struct {
		Path      string `json:"path"`
		Recursive bool   `json:"recursive,omitempty"`
		Force     bool   `json:"force,omitempty"`
	}
}
type sandboxRmOutput struct{ Body amika.SandboxRmResult }

func registerSandboxRm(api huma.API, service amika.Service) {
	huma.Post(api, "/v1/sandboxes/{name}/rm", func(ctx context.Context, input *sandboxRmInput) (*sandboxRmOutput, error) {
		result, err := service.SandboxRm(ctx, amika.SandboxRmRequest{
			Name:      input.Name,
			Path:      input.Body.Path,
			Recursive: input.Body.Recursive,
			Force:     input.Body.Force,
		})
		if err != nil {
			return nil, toHTTPError(err)
		}
		return &sandboxRmOutput{Body: result}, nil
	})
}

type sandboxStatInput struct {
	Name string `path:"name"`
	Body struct {
		Path string `json:"path"`
	}
}
type sandboxStatOutput struct{ Body amika.SandboxStatResult }

func registerSandboxStat(api huma.API, service amika.Service) {
	huma.Post(api, "/v1/sandboxes/{name}/stat", func(ctx context.Context, input *sandboxStatInput) (*sandboxStatOutput, error) {
		result, err := service.SandboxStat(ctx, amika.SandboxStatRequest{
			Name: input.Name,
			Path: input.Body.Path,
		})
		if err != nil {
			return nil, toHTTPError(err)
		}
		return &sandboxStatOutput{Body: result}, nil
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