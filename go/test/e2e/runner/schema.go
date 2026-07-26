// Package runner implements a black-box test runner that drives a compiled
// amika binary as a subprocess: it loads YAML case files, runs each step's
// argv/stdin/env against the binary, asserts on stdout/stderr/exit code,
// and tracks any resources the steps create so they can be cleaned up in
// reverse order afterward.
package runner

import (
	"fmt"
	"os"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// schemaDocURL is the synthetic base URI the OpenAPI document is registered
// under with the jsonschema compiler. It never needs to resolve over the
// network; it only anchors "#/components/schemas/<Name>" fragment lookups.
const schemaDocURL = "amika-e2e://openapi.json"

// SchemaValidator validates decoded JSON values against named schemas under
// components.schemas in an OpenAPI document.
//
// Loading is best-effort by design: OpenAPI documents can use dialect
// features that trip up a strict JSON Schema loader, and a case author
// asking for schema validation shouldn't be blocked by that. LoadOpenAPI
// always returns a usable, non-nil validator; if the document failed to
// load, every Validate call fails with a clear, specific error instead of
// panicking or silently skipping the check.
type SchemaValidator struct {
	compiler *jsonschema.Compiler
	loadErr  error

	mu    sync.Mutex
	cache map[string]*jsonschema.Schema
}

// LoadOpenAPISchema loads an OpenAPI document from path for later
// validation against its components.schemas definitions.
func LoadOpenAPISchema(path string) *SchemaValidator {
	v := &SchemaValidator{cache: map[string]*jsonschema.Schema{}}

	f, err := os.Open(path)
	if err != nil {
		v.loadErr = fmt.Errorf("open openapi document %s: %w", path, err)
		return v
	}
	defer f.Close()

	doc, err := jsonschema.UnmarshalJSON(f)
	if err != nil {
		v.loadErr = fmt.Errorf("parse openapi document %s: %w", path, err)
		return v
	}

	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource(schemaDocURL, doc); err != nil {
		v.loadErr = fmt.Errorf("register openapi document %s: %w", path, err)
		return v
	}
	v.compiler = compiler
	return v
}

// Validate validates instance (a value decoded from JSON, e.g. via
// encoding/json into any) against components.schemas.<name> in the loaded
// OpenAPI document. It returns a clear error if the document never loaded,
// the named schema doesn't exist, or instance does not conform.
func (v *SchemaValidator) Validate(name string, instance any) error {
	if v.loadErr != nil {
		return fmt.Errorf("openapi document unavailable: %w", v.loadErr)
	}

	schema, err := v.compiled(name)
	if err != nil {
		return err
	}
	if err := schema.Validate(instance); err != nil {
		return err
	}
	return nil
}

func (v *SchemaValidator) compiled(name string) (*jsonschema.Schema, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	if schema, ok := v.cache[name]; ok {
		return schema, nil
	}
	schema, err := v.compiler.Compile(schemaDocURL + "#/components/schemas/" + name)
	if err != nil {
		return nil, fmt.Errorf("schema %q not found under components.schemas: %w", name, err)
	}
	v.cache[name] = schema
	return schema, nil
}
