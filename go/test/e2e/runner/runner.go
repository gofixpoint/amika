package runner

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// Case is a parsed E2E case file: a human-readable name and an ordered
// sequence of steps run against the amika binary.
type Case struct {
	Name  string `yaml:"name"`
	Steps []Step `yaml:"steps"`

	// SourcePath is the file the case was loaded from. Not part of the
	// YAML schema; set by LoadCase for diagnostics.
	SourcePath string `yaml:"-"`
}

// Step is a single command execution and the assertions to make about its
// result.
type Step struct {
	// Name is a required human label, used in transcripts and error
	// messages.
	Name string `yaml:"name"`
	// Cmd is the argv passed to the amika binary, not including the binary
	// itself. Elements may contain "{{var}}" templates.
	Cmd []string `yaml:"cmd"`
	// Stdin, if set, is written to the process's standard input. May
	// contain "{{var}}" templates.
	Stdin string `yaml:"stdin"`
	// Env sets additional environment variables for this step only.
	// Values may contain "{{var}}" templates.
	Env map[string]string `yaml:"env"`
	// Expect describes the assertions to make about the step's result.
	Expect Expectation `yaml:"expect"`
	// Capture extracts named variables from the step's parsed stdout JSON
	// for use by "{{var}}" templates in later steps. Values are minimal
	// JSONPath-like expressions; see ExtractJSONPath.
	Capture map[string]string `yaml:"capture"`
	// Resource, if set, registers a resource the step created so it is
	// cleaned up after the run.
	Resource *Resource `yaml:"resource"`
	// ReleaseResource, if set, removes a previously registered resource from
	// the cleanup ledger after this step and all of its assertions succeed.
	ReleaseResource *ResourceRef `yaml:"release_resource"`
}

// Expectation describes the assertions to make about a step's result. All
// fields are optional; Exit defaults to 0 when unset.
type Expectation struct {
	// Exit is the expected process exit code. Defaults to 0 when nil.
	Exit *int `yaml:"exit"`
	// StdoutJSON, if present, is matched structurally against stdout parsed
	// as JSON. See Match for matching semantics. May contain "{{var}}"
	// templates and matcher placeholder strings. Presence is tracked
	// separately (stdoutJSONSet) so an explicit "stdout_json: null" (assert
	// stdout is JSON null) is distinguished from omitting the field.
	StdoutJSON any `yaml:"stdout_json"`
	// StdoutContains, if set, must be a substring of stdout.
	StdoutContains string `yaml:"stdout_contains"`
	// StdoutNotContains, if set, must not be a substring of stdout.
	StdoutNotContains string `yaml:"stdout_not_contains"`
	// StderrContains, if set, must be a substring of stderr.
	StderrContains string `yaml:"stderr_contains"`
	// StderrNotContains, if set, must not be a substring of stderr.
	StderrNotContains string `yaml:"stderr_not_contains"`
	// Schema, if set, names a components.schemas.<Schema> definition in
	// the OpenAPI document that stdout, parsed as JSON, must validate
	// against.
	Schema string `yaml:"schema"`

	// stdoutJSONSet records whether the case file actually contained a
	// "stdout_json" key, so an explicit null value is not confused with the
	// field being omitted. It is populated by LoadCase, not by YAML decoding
	// (an unexported field is ignored by the decoder).
	stdoutJSONSet bool
}

// hasStdoutJSON reports whether a stdout_json assertion should run for this
// expectation. It is true when the case file spelled out the key (including
// an explicit null, recorded in stdoutJSONSet by LoadCase) or when a non-nil
// value was set programmatically, so a caller building an Expectation in Go
// still gets its stdout_json matched.
func (e Expectation) hasStdoutJSON() bool {
	return e.stdoutJSONSet || e.StdoutJSON != nil
}

// Resource describes a resource a step created that must be cleaned up
// after the run.
type Resource struct {
	// Type is a free-form resource kind, e.g. "sandbox" or "volume".
	Type string `yaml:"type"`
	// Name identifies the resource. May contain "{{var}}" templates.
	Name string `yaml:"name"`
	// Cleanup is the amika argv (not including the binary itself) that
	// deletes the resource. Elements may contain "{{var}}" templates.
	Cleanup []string `yaml:"cleanup"`
	// RegisterOnFailure, when true, registers the resource for cleanup even if
	// the creating step exits with an unexpected status. Off by default: an
	// unexpected exit is ambiguous (the command may have failed before
	// creating anything, e.g. a name collision), so cleaning up a resource this
	// run may not have created could delete one owned by another run. Enable it
	// only for a command known to create the resource before it can fail.
	RegisterOnFailure bool `yaml:"register_on_failure"`
}

// ResourceRef identifies a previously registered resource that a successful
// step has verified no longer exists.
type ResourceRef struct {
	Type string `yaml:"type"`
	Name string `yaml:"name"`
}

// LoadCase reads and parses a case file at path.
func LoadCase(path string) (*Case, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read case %s: %w", path, err)
	}
	// Decode with KnownFields so a misspelled key (e.g. "stdout_josn" for
	// "stdout_json") fails at load time instead of being silently dropped,
	// which would leave a step with no structural assertion and let it pass
	// on the default exit-code check alone (a false-positive E2E result).
	var c Case
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("parse case %s: %w", path, err)
	}
	// A case file must hold exactly one content-bearing YAML document. A stray
	// "---" followed by more content would otherwise be silently ignored,
	// bypassing the known-field validation above and letting a weaker first
	// document pass. Bare trailing "---" separators (empty/null documents) are
	// harmless and allowed, so scan every remaining document to EOF rather than
	// stopping at the first, which could let a real document hide behind an
	// empty one.
	for {
		var extra yaml.Node
		err := dec.Decode(&extra)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("parse case %s: %w", path, err)
		}
		if documentHasContent(&extra) {
			return nil, fmt.Errorf("parse case %s: only one YAML document is allowed per case file", path)
		}
	}
	// A second, lightweight pass records whether each step actually spelled
	// out a "stdout_json" key. YAML decodes both an omitted field and an
	// explicit "stdout_json: null" to a nil any, so this is the only way to
	// tell "assert stdout is JSON null" apart from "no JSON assertion". A
	// populated yaml.Node has a non-zero Kind; an absent key leaves it zero.
	if err := markStdoutJSONPresence(data, &c); err != nil {
		return nil, fmt.Errorf("parse case %s: %w", path, err)
	}
	if c.Name == "" {
		return nil, fmt.Errorf("case %s: top-level \"name\" is required", path)
	}
	if len(c.Steps) == 0 {
		return nil, fmt.Errorf("case %s: at least one step is required", path)
	}
	for i, step := range c.Steps {
		if step.Name == "" {
			return nil, fmt.Errorf("case %s: step %d: \"name\" is required", path, i+1)
		}
		if len(step.Cmd) == 0 {
			return nil, fmt.Errorf("case %s: step %d (%s): \"cmd\" is required", path, i+1, step.Name)
		}
		// A capture name must match the "{{var}}" template grammar; otherwise
		// its value is stored but can never be referenced (e.g. "{{a/b}}" is
		// not recognized as a placeholder and passes through verbatim), which
		// can silently untrack a resource or produce a false assertion. Reject
		// such names at load time, in sorted order for a deterministic error.
		captureNames := make([]string, 0, len(step.Capture))
		for name := range step.Capture {
			captureNames = append(captureNames, name)
		}
		sort.Strings(captureNames)
		for _, name := range captureNames {
			if !validVarNamePattern.MatchString(name) {
				return nil, fmt.Errorf("case %s: step %d (%s): capture name %q must match %s", path, i+1, step.Name, name, validVarNameGrammar)
			}
		}
		if step.Resource != nil {
			// A resource with no cleanup argv would record an entry whose
			// cleanup runs a bare "amika" (which exits 0 without deleting
			// anything), so cleanup looks successful while the real resource
			// leaks. Require both a name and a non-empty cleanup argv.
			if step.Resource.Name == "" {
				return nil, fmt.Errorf("case %s: step %d (%s): resource requires a \"name\"", path, i+1, step.Name)
			}
			if len(step.Resource.Cleanup) == 0 {
				return nil, fmt.Errorf("case %s: step %d (%s): resource requires a non-empty \"cleanup\" argv", path, i+1, step.Name)
			}
		}
		if step.ReleaseResource != nil {
			if step.ReleaseResource.Type == "" {
				return nil, fmt.Errorf("case %s: step %d (%s): release_resource requires a \"type\"", path, i+1, step.Name)
			}
			if step.ReleaseResource.Name == "" {
				return nil, fmt.Errorf("case %s: step %d (%s): release_resource requires a \"name\"", path, i+1, step.Name)
			}
		}
	}
	c.SourcePath = path
	return &c, nil
}

// documentHasContent reports whether a decoded YAML document carries a
// non-null value. A bare trailing "---" or an explicit null second document
// decodes to a document node whose content is a null scalar; those are
// harmless, so only a document with real content counts as a disallowed
// second document.
func documentHasContent(doc *yaml.Node) bool {
	content := doc
	if doc.Kind == yaml.DocumentNode {
		if len(doc.Content) == 0 {
			return false
		}
		content = doc.Content[0]
	}
	return content.Kind != 0 && content.Tag != "!!null"
}

// markStdoutJSONPresence decodes data a second time into a structure that
// captures each step's expect.stdout_json as a raw yaml.Node, then sets
// stdoutJSONSet on the matching step in c. A node whose Kind is non-zero was
// present in the source (even if its value is null); a zero node means the
// key was omitted. The two decodes see the same document, so the step slices
// line up by index.
func markStdoutJSONPresence(data []byte, c *Case) error {
	var raw struct {
		Steps []struct {
			Expect struct {
				StdoutJSON yaml.Node `yaml:"stdout_json"`
			} `yaml:"expect"`
		} `yaml:"steps"`
	}
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return err
	}
	for i := range raw.Steps {
		if i >= len(c.Steps) {
			break
		}
		if raw.Steps[i].Expect.StdoutJSON.Kind != 0 {
			c.Steps[i].Expect.stdoutJSONSet = true
		}
	}
	return nil
}

// DiscoverCases returns every "*.yaml" file directly under dir, sorted by
// filename for deterministic ordering.
func DiscoverCases(dir string) ([]string, error) {
	matches, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil {
		return nil, fmt.Errorf("glob cases in %s: %w", dir, err)
	}
	sort.Strings(matches)
	return matches, nil
}

// Options configures a Runner.
type Options struct {
	// BinPath is the path to the amika binary under test. Required.
	BinPath string
	// RunDir is the directory a Runner writes its ledger.json and
	// per-step transcripts to. Required.
	RunDir string
	// StateDir, if set, is exported to every step as AMIKA_STATE_DIRECTORY
	// (unless a step's own Env already sets it), isolating the run from
	// the invoking user's real amika state.
	StateDir string
	// Env is the base environment for every step. Defaults to
	// os.Environ() when nil.
	Env []string
	// SchemaDoc, if set, locates the OpenAPI document used to resolve
	// expect.schema names. It is either an http(s) URL (fetched over the
	// network) or a local filesystem path. Steps using expect.schema fail
	// clearly if this is empty.
	SchemaDoc string
	// RunID, if set, is exposed to every case as the `{{run_id}}` template
	// variable. Cases that name a remote resource should build the name from
	// it, so two runs sharing an account cannot collide with each other or
	// adopt a same-named resource the account already had.
	RunID string
}

// Runner executes case files against a built amika binary, tracking
// resources the steps create in a ledger so they can be cleaned up in
// reverse order once the run ends (see Cleanup).
//
// A Runner is intended to be used by a single goroutine, one per case:
// RunCase runs a case's steps sequentially. Its captured variables (Vars) are
// not guarded by a lock, so a Runner must not be shared across goroutines. The
// Ledger it exposes is independently goroutine-safe.
type Runner struct {
	opts   Options
	ledger *Ledger
	vars   map[string]string

	// schema is loaded lazily, the first time a step actually uses
	// expect.schema, so a run whose cases never request schema validation
	// (e.g. the offline sample cases) never fetches the OpenAPI document.
	schemaOnce sync.Once
	schema     *SchemaValidator
}

// New creates a Runner backed by a fresh ledger.json under opts.RunDir.
func New(opts Options) (*Runner, error) {
	if opts.BinPath == "" {
		return nil, errors.New("runner: Options.BinPath is required")
	}
	if opts.RunDir == "" {
		return nil, errors.New("runner: Options.RunDir is required")
	}
	if err := os.MkdirAll(opts.RunDir, 0o755); err != nil {
		return nil, fmt.Errorf("create run directory %s: %w", opts.RunDir, err)
	}
	ledger, err := NewLedger(filepath.Join(opts.RunDir, ledgerFileName))
	if err != nil {
		return nil, err
	}

	vars := map[string]string{}
	if opts.RunID != "" {
		vars["run_id"] = opts.RunID
	}
	return &Runner{
		opts:   opts,
		ledger: ledger,
		vars:   vars,
	}, nil
}

// schemaValidator returns the OpenAPI schema validator, loading (and, for a
// URL source, fetching) the document on first use so a run whose steps never
// request expect.schema does no schema I/O at all. It returns nil when no
// SchemaDoc was configured.
func (r *Runner) schemaValidator() *SchemaValidator {
	if r.opts.SchemaDoc == "" {
		return nil
	}
	r.schemaOnce.Do(func() {
		r.schema = LoadOpenAPISchema(r.opts.SchemaDoc)
	})
	return r.schema
}

// Ledger returns the run's ledger of registered resources.
func (r *Runner) Ledger() *Ledger {
	return r.ledger
}

// Vars returns a copy of the variables captured so far.
func (r *Runner) Vars() map[string]string {
	out := make(map[string]string, len(r.vars))
	for k, v := range r.vars {
		out[k] = v
	}
	return out
}

// RunCase executes every step of c in order against the binary, stopping
// at the first failing step. Resources registered by steps before a
// failure remain in the ledger regardless, so cleanup still runs for them.
func (r *Runner) RunCase(c *Case) error {
	for i, step := range c.Steps {
		if err := r.runStep(i, step); err != nil {
			return fmt.Errorf("case %q step %d (%s): %w", c.Name, i+1, step.Name, err)
		}
	}
	return nil
}

func (r *Runner) runStep(index int, rawStep Step) error {
	step, err := r.substituteStep(rawStep)
	if err != nil {
		return fmt.Errorf("template substitution: %w", err)
	}

	stdout, stderr, exitCode, err := r.execStep(step)
	if err != nil {
		return err
	}

	// A resource the command created must reach the ledger even when the step
	// then fails, so capture and registration run before any failure is
	// returned (including before the transcript is written, so a transcript
	// I/O error does not strand a just-created resource).
	exitErr := checkExit(step, stdout, stderr, exitCode)

	// Invalidate any prior values for this step's capture names before
	// extracting them. A reused capture name whose capture fails this step, for
	// ANY reason (a bad path, or stdout that is not valid JSON so captureVars
	// is skipped below), must become undefined rather than retain an earlier
	// step's value that registerResource could template into the wrong
	// resource. Doing it here, not inside captureVars, covers the parse-failure
	// case where captureVars never runs.
	for name := range step.Capture {
		delete(r.vars, name)
	}

	parsed, parseErr := parseStdout(step, stdout)
	var captureErr error
	if parseErr == nil {
		captureErr = r.captureVars(step, parsed)
	}

	// When the exit code matched, the command did what the step expected, so a
	// resource it declared exists and is registered unconditionally (even if a
	// later capture/assertion then fails). An UNEXPECTED exit is ambiguous: the
	// command may have created the resource and then failed, or it may have
	// failed before creating anything (e.g. a name collision, where cleanup
	// would delete a pre-existing resource this run does not own). So on an
	// unexpected exit a resource is registered only when the case explicitly
	// opts in via resource.register_on_failure.
	var regErr error
	if exitErr == nil || (step.Resource != nil && step.Resource.RegisterOnFailure) {
		regErr = r.registerResource(step)
	}

	transcriptErr := r.writeTranscript(index, step.Name, stdout, stderr, exitCode)

	// Surface failures in cause order: an unexpected exit is the most
	// informative (the command did not behave as the step expected), then a
	// parse/capture/registration failure, then a transcript I/O failure, then
	// the content assertions.
	if exitErr != nil {
		return exitErr
	}
	if parseErr != nil {
		return parseErr
	}
	if captureErr != nil {
		return captureErr
	}
	if regErr != nil {
		return regErr
	}
	if transcriptErr != nil {
		return transcriptErr
	}

	if err := r.checkContent(step, parsed, stdout, stderr); err != nil {
		return err
	}
	return r.releaseResource(step)
}

// execStep runs step.Cmd through the binary under test and returns its
// captured stdout, stderr, and exit code.
func (r *Runner) execStep(step Step) (stdout, stderr []byte, exitCode int, err error) {
	cmd := exec.Command(r.opts.BinPath, step.Cmd...) //nolint:gosec // argv comes from trusted case files under version control
	cmd.Env = r.stepEnv(step.Env)
	if step.Stdin != "" {
		cmd.Stdin = strings.NewReader(step.Stdin)
	}

	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf

	runErr := cmd.Run()
	if runErr == nil {
		return outBuf.Bytes(), errBuf.Bytes(), 0, nil
	}

	var exitErr *exec.ExitError
	if errors.As(runErr, &exitErr) {
		return outBuf.Bytes(), errBuf.Bytes(), exitErr.ExitCode(), nil
	}
	return outBuf.Bytes(), errBuf.Bytes(), -1, fmt.Errorf("exec %v: %w", step.Cmd, runErr)
}

// CleanupEnv returns the environment that cleanup commands should run with:
// the same base environment and injected AMIKA_STATE_DIRECTORY the run's
// steps used (with no per-step overrides). Passing this to Cleanup ensures a
// resource created under the run's isolated state directory is deleted from
// that same state rather than the invoking user's default state.
func (r *Runner) CleanupEnv() []string {
	return r.stepEnv(nil)
}

// stepEnv builds the environment for one step: the runner's base
// environment (or os.Environ() if unset), an injected AMIKA_STATE_DIRECTORY
// when configured, and finally the step's own overrides. Keys are
// deduplicated (last write wins) so no name appears twice in the resulting
// slice, since the C library that resolves getenv() for the child process
// is free to return the first match rather than the last.
func (r *Runner) stepEnv(overrides map[string]string) []string {
	values, order := r.resolvedEnv(overrides)
	env := make([]string, 0, len(order))
	for _, key := range order {
		env = append(env, key+"="+values[key])
	}
	return env
}

// resolvedEnv computes the fully resolved environment for a step as a map plus
// the insertion order of its keys: the runner's base environment (or
// os.Environ() if unset), an injected AMIKA_STATE_DIRECTORY when configured,
// then the step's own overrides (last write wins). stepEnv renders this into a
// "KEY=VALUE" slice; resourceEnv reads specific resolved values from it.
func (r *Runner) resolvedEnv(overrides map[string]string) (map[string]string, []string) {
	base := r.opts.Env
	if base == nil {
		base = os.Environ()
	}

	values := make(map[string]string, len(base)+len(overrides)+1)
	order := make([]string, 0, len(base)+len(overrides)+1)
	set := func(key, val string) {
		if _, exists := values[key]; !exists {
			order = append(order, key)
		}
		values[key] = val
	}

	for _, kv := range base {
		key, val, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		set(key, val)
	}
	if r.opts.StateDir != "" {
		if _, ok := overrides["AMIKA_STATE_DIRECTORY"]; !ok {
			set("AMIKA_STATE_DIRECTORY", r.opts.StateDir)
		}
	}
	for key, val := range overrides {
		set(key, val)
	}
	return values, order
}

func (r *Runner) writeTranscript(index int, name string, stdout, stderr []byte, exitCode int) error {
	dir := filepath.Join(r.opts.RunDir, "steps")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create steps directory: %w", err)
	}
	base := fmt.Sprintf("%02d-%s", index+1, slugify(name))
	if err := os.WriteFile(filepath.Join(dir, base+".stdout"), stdout, 0o644); err != nil {
		return fmt.Errorf("write stdout transcript: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, base+".stderr"), stderr, 0o644); err != nil {
		return fmt.Errorf("write stderr transcript: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, base+".exit"), []byte(strconv.Itoa(exitCode)+"\n"), 0o644); err != nil {
		return fmt.Errorf("write exit transcript: %w", err)
	}
	return nil
}

// checkExit asserts the step's exit code. It runs before capture, resource
// registration, and the content assertions: a mismatch means the command did
// not behave as the step expected, so there is nothing further to do.
func checkExit(step Step, stdout, stderr []byte, exitCode int) error {
	wantExit := 0
	if step.Expect.Exit != nil {
		wantExit = *step.Expect.Exit
	}
	if exitCode != wantExit {
		return fmt.Errorf("exit code: expected %d, got %d\nstdout:\n%s\nstderr:\n%s", wantExit, exitCode, stdout, stderr)
	}
	return nil
}

// parseStdout decodes stdout as JSON when the step has a JSON-based check
// (stdout_json or schema) or a capture that needs it. It returns nil when no
// such need exists.
func parseStdout(step Step, stdout []byte) (any, error) {
	if !step.Expect.hasStdoutJSON() && step.Expect.Schema == "" && len(step.Capture) == 0 {
		return nil, nil
	}
	var parsed any
	if err := json.Unmarshal(stdout, &parsed); err != nil {
		return nil, fmt.Errorf("stdout is not valid JSON: %w\nstdout:\n%s", err, stdout)
	}
	return parsed, nil
}

// checkContent runs the value assertions: substring checks, structural
// stdout_json matching, and OpenAPI schema validation. It runs AFTER capture
// and resource registration so that a resource the step created is tracked
// for cleanup even when one of these assertions fails.
func (r *Runner) checkContent(step Step, parsed any, stdout, stderr []byte) error {
	if step.Expect.StdoutContains != "" && !strings.Contains(string(stdout), step.Expect.StdoutContains) {
		return fmt.Errorf("stdout_contains: %q not found in stdout:\n%s", step.Expect.StdoutContains, stdout)
	}
	if step.Expect.StdoutNotContains != "" && strings.Contains(string(stdout), step.Expect.StdoutNotContains) {
		return fmt.Errorf("stdout_not_contains: %q unexpectedly found in stdout:\n%s", step.Expect.StdoutNotContains, stdout)
	}
	if step.Expect.StderrContains != "" && !strings.Contains(string(stderr), step.Expect.StderrContains) {
		return fmt.Errorf("stderr_contains: %q not found in stderr:\n%s", step.Expect.StderrContains, stderr)
	}
	if step.Expect.StderrNotContains != "" && strings.Contains(string(stderr), step.Expect.StderrNotContains) {
		return fmt.Errorf("stderr_not_contains: %q unexpectedly found in stderr:\n%s", step.Expect.StderrNotContains, stderr)
	}
	if step.Expect.hasStdoutJSON() {
		if err := Match(step.Expect.StdoutJSON, parsed); err != nil {
			return fmt.Errorf("stdout_json mismatch:\n%s", err)
		}
	}
	if step.Expect.Schema != "" {
		v := r.schemaValidator()
		if v == nil {
			return fmt.Errorf("expect.schema %q requested but no OpenAPI document was configured (Options.SchemaDoc empty)", step.Expect.Schema)
		}
		if err := v.Validate(step.Expect.Schema, parsed); err != nil {
			return fmt.Errorf("schema %q: %w", step.Expect.Schema, err)
		}
	}
	return nil
}

// captureVars extracts every capture into r.vars. It does NOT stop at the
// first bad path: a valid capture is saved even when a sibling capture fails,
// so a resource block that references a valid capture can still be templated
// and registered for cleanup. Captures are processed in sorted name order so
// the outcome does not depend on Go's randomized map iteration, and all path
// errors are joined into the returned error.
//
// The caller (runStep) invalidates this step's capture names in r.vars before
// calling captureVars, so a name whose extraction fails here is left undefined
// rather than retaining an earlier step's value.
func (r *Runner) captureVars(step Step, parsed any) error {
	names := make([]string, 0, len(step.Capture))
	for name := range step.Capture {
		names = append(names, name)
	}
	sort.Strings(names)

	var errs []error
	for _, name := range names {
		val, err := ExtractJSONPath(step.Capture[name], parsed)
		if err != nil {
			errs = append(errs, fmt.Errorf("capture %q: %w", name, err))
			continue
		}
		r.vars[name] = toVarString(val)
	}
	return errors.Join(errs...)
}

// registerResource templates the step's resource block and appends it to the
// ledger. Templating happens here, not in substituteStep, so a resource whose
// name or cleanup argv references a variable captured from this same step's
// output resolves correctly (r.vars has already been updated by captureVars).
func (r *Runner) registerResource(step Step) error {
	if step.Resource == nil {
		return nil
	}
	name, err := substituteString(step.Resource.Name, r.vars)
	if err != nil {
		return fmt.Errorf("resource.name: %w", err)
	}
	cleanup := make([]string, len(step.Resource.Cleanup))
	for i, arg := range step.Resource.Cleanup {
		v, err := substituteString(arg, r.vars)
		if err != nil {
			return fmt.Errorf("resource.cleanup[%d]: %w", i, err)
		}
		cleanup[i] = v
	}
	entry := Entry{
		Type:          step.Resource.Type,
		Name:          name,
		CreatedByStep: step.Name,
		CleanupArgv:   cleanup,
		Env:           r.resourceEnv(step),
		CreatedAt:     time.Now().UTC(),
	}
	if err := r.ledger.Append(entry); err != nil {
		return fmt.Errorf("register resource %q: %w", name, err)
	}
	return nil
}

func (r *Runner) releaseResource(step Step) error {
	if step.ReleaseResource == nil {
		return nil
	}
	removed, err := r.ledger.Remove(step.ReleaseResource.Type, step.ReleaseResource.Name)
	if err != nil {
		return fmt.Errorf("release resource %s %q: %w", step.ReleaseResource.Type, step.ReleaseResource.Name, err)
	}
	if !removed {
		return fmt.Errorf("release resource %s %q: no matching resource is registered", step.ReleaseResource.Type, step.ReleaseResource.Name)
	}
	return nil
}

// cleanupTargetEnvKeys are the environment variables that determine which
// amika deployment and state a cleanup command targets. Their resolved values
// (base env + injected state dir + step overrides) are persisted on each
// ledger entry so a standalone reaper replaying the ledger with no base env of
// its own (CleanupFromLedgerFile) still deletes the resource from the same
// place it was created, even when the value came only from the run's base
// Options.Env. These are the ONLY keys pulled from the base environment, so
// ambient base-env credentials are not written to the on-disk ledger;
// standalone recovery must run where those are already set. (A credential set
// in a step's own env block is still persisted verbatim; see Entry.Env.)
var cleanupTargetEnvKeys = []string{"AMIKA_STATE_DIRECTORY", "AMIKA_API_URL"}

// resourceEnv returns the env overrides to persist on a ledger entry so
// cleanup targets the same amika deployment and state the resource was created
// against. It carries the creating step's own env overrides plus the resolved
// values of the cleanup target vars (see cleanupTargetEnvKeys), so a standalone
// reaper (CleanupFromLedgerFile with a nil base env) deletes the resource from
// the run's isolated state and correct API rather than the invoking user's
// defaults.
func (r *Runner) resourceEnv(step Step) map[string]string {
	resolved, _ := r.resolvedEnv(step.Env)
	out := make(map[string]string, len(step.Env)+len(cleanupTargetEnvKeys))
	for _, key := range cleanupTargetEnvKeys {
		if v, ok := resolved[key]; ok {
			out[key] = v
		}
	}
	for k, v := range step.Env {
		out[k] = v
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// templateVarPattern matches "{{name}}" placeholders. Names may contain
// letters, digits, underscore, dot, and hyphen.
var templateVarPattern = regexp.MustCompile(`\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}`)

// validVarNameGrammar describes the characters a capture/template variable
// name may contain; validVarNamePattern matches a whole name against it. They
// mirror the name class inside templateVarPattern, so any accepted capture
// name is one "{{name}}" can actually reference.
const validVarNameGrammar = "[A-Za-z0-9_.-]+"

var validVarNamePattern = regexp.MustCompile("^" + validVarNameGrammar + "$")

// substituteString replaces every "{{var}}" placeholder in s with the
// corresponding entry from vars. It returns an error naming any
// placeholder whose variable was never captured.
func substituteString(s string, vars map[string]string) (string, error) {
	var missing []string
	result := templateVarPattern.ReplaceAllStringFunc(s, func(match string) string {
		name := templateVarPattern.FindStringSubmatch(match)[1]
		val, ok := vars[name]
		if !ok {
			missing = append(missing, name)
			return match
		}
		return val
	})
	if len(missing) > 0 {
		return "", fmt.Errorf("undefined template var(s): %s", strings.Join(missing, ", "))
	}
	return result, nil
}

// substituteAny applies substituteString to every string found while
// recursing through maps and slices, leaving other value types unchanged.
// It is used for expect.stdout_json, whose values may mix matcher
// placeholders with "{{var}}" templates.
func substituteAny(v any, vars map[string]string) (any, error) {
	switch t := v.(type) {
	case string:
		return substituteString(t, vars)
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			sv, err := substituteAny(val, vars)
			if err != nil {
				return nil, err
			}
			out[k] = sv
		}
		return out, nil
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			sv, err := substituteAny(val, vars)
			if err != nil {
				return nil, err
			}
			out[i] = sv
		}
		return out, nil
	default:
		return v, nil
	}
}

// substituteStep returns a copy of step with "{{var}}" templates resolved in
// cmd, stdin, env, and expectation strings. The resource block is templated
// later, by registerResource, so it can reference this step's own captures.
func (r *Runner) substituteStep(step Step) (Step, error) {
	out := step

	cmd := make([]string, len(step.Cmd))
	for i, arg := range step.Cmd {
		v, err := substituteString(arg, r.vars)
		if err != nil {
			return Step{}, fmt.Errorf("cmd[%d]: %w", i, err)
		}
		cmd[i] = v
	}
	out.Cmd = cmd

	stdin, err := substituteString(step.Stdin, r.vars)
	if err != nil {
		return Step{}, fmt.Errorf("stdin: %w", err)
	}
	out.Stdin = stdin

	if step.Env != nil {
		env := make(map[string]string, len(step.Env))
		for k, v := range step.Env {
			sv, err := substituteString(v, r.vars)
			if err != nil {
				return Step{}, fmt.Errorf("env[%s]: %w", k, err)
			}
			env[k] = sv
		}
		out.Env = env
	}

	// step.Resource is intentionally NOT templated here. Its Name/Cleanup
	// often reference a variable this same step captures from its own output
	// (e.g. the id of the resource just created), which is only known after
	// the command runs and captureVars populates r.vars. registerResource
	// templates the resource block afterward, once those vars exist.
	if step.ReleaseResource != nil {
		release := *step.ReleaseResource
		release.Type, err = substituteString(release.Type, r.vars)
		if err != nil {
			return Step{}, fmt.Errorf("release_resource.type: %w", err)
		}
		release.Name, err = substituteString(release.Name, r.vars)
		if err != nil {
			return Step{}, fmt.Errorf("release_resource.name: %w", err)
		}
		out.ReleaseResource = &release
	}

	stdoutContains, err := substituteString(step.Expect.StdoutContains, r.vars)
	if err != nil {
		return Step{}, fmt.Errorf("expect.stdout_contains: %w", err)
	}
	out.Expect.StdoutContains = stdoutContains

	stdoutNotContains, err := substituteString(step.Expect.StdoutNotContains, r.vars)
	if err != nil {
		return Step{}, fmt.Errorf("expect.stdout_not_contains: %w", err)
	}
	out.Expect.StdoutNotContains = stdoutNotContains

	stderrContains, err := substituteString(step.Expect.StderrContains, r.vars)
	if err != nil {
		return Step{}, fmt.Errorf("expect.stderr_contains: %w", err)
	}
	out.Expect.StderrContains = stderrContains

	stderrNotContains, err := substituteString(step.Expect.StderrNotContains, r.vars)
	if err != nil {
		return Step{}, fmt.Errorf("expect.stderr_not_contains: %w", err)
	}
	out.Expect.StderrNotContains = stderrNotContains

	if step.Expect.StdoutJSON != nil {
		v, err := substituteAny(step.Expect.StdoutJSON, r.vars)
		if err != nil {
			return Step{}, fmt.Errorf("expect.stdout_json: %w", err)
		}
		out.Expect.StdoutJSON = v
	}

	return out, nil
}

// slugify converts name into a lowercase, hyphen-separated token suitable
// for use in a filename.
func slugify(name string) string {
	var b strings.Builder
	lastHyphen := true
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
			lastHyphen = false
		default:
			if !lastHyphen {
				b.WriteByte('-')
				lastHyphen = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

// toVarString renders a JSONPath-extracted value as a string suitable for
// "{{var}}" substitution.
func toVarString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		return strconv.FormatBool(t)
	case float64:
		return formatFloat(t)
	default:
		return fmt.Sprintf("%v", t)
	}
}
