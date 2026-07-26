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

	// The Amika spec declares openapi 3.1.0 but expresses nullability with the
	// OpenAPI 3.0 keyword `nullable: true`, which is not part of JSON Schema
	// 2020-12 (what jsonschema/v6 enforces): a `{type: string, nullable: true}`
	// schema would reject a real `null` value the API legitimately returns.
	// Rewrite those into `type: [..., "null"]` so validation honors the spec's
	// intent instead of failing on every nullable field.
	rewriteNullable(doc)

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

// rewriteNullable walks a decoded JSON Schema / OpenAPI document in place and
// rewrites every `{"nullable": true}` object that also has a concrete `type`
// into one whose `type` includes "null", so a JSON Schema 2020-12 validator
// accepts the null values an OpenAPI-3.0-style `nullable` field allows. A
// `nullable` schema with no `type` (e.g. one using anyOf, or a bare
// `additionalProperties: {nullable: true}`) already accepts null, so it is
// left as-is aside from dropping the now-meaningless keyword.
func rewriteNullable(node any) {
	switch n := node.(type) {
	case map[string]any:
		if isTrue(n["nullable"]) {
			addNullType(n)
		}
		delete(n, "nullable")
		for _, child := range n {
			rewriteNullable(child)
		}
	case []any:
		for _, child := range n {
			rewriteNullable(child)
		}
	}
}

// addNullType adds "null" to a schema object's `type`, whether it is a single
// string or a list. A schema with no `type` is left untouched (it already
// permits null under JSON Schema).
func addNullType(schema map[string]any) {
	switch t := schema["type"].(type) {
	case string:
		if t != "null" {
			schema["type"] = []any{t, "null"}
		}
	case []any:
		for _, existing := range t {
			if s, ok := existing.(string); ok && s == "null" {
				return
			}
		}
		schema["type"] = append(t, "null")
	}
}

// isTrue reports whether v is the boolean true.
func isTrue(v any) bool {
	b, ok := v.(bool)
	return ok && b
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
