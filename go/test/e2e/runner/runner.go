package runner

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
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
}

// Expectation describes the assertions to make about a step's result. All
// fields are optional; Exit defaults to 0 when unset.
type Expectation struct {
	// Exit is the expected process exit code. Defaults to 0 when nil.
	Exit *int `yaml:"exit"`
	// StdoutJSON, if set, is matched structurally against stdout parsed as
	// JSON. See Match for matching semantics. May contain "{{var}}"
	// templates and matcher placeholder strings.
	StdoutJSON any `yaml:"stdout_json"`
	// StdoutContains, if set, must be a substring of stdout.
	StdoutContains string `yaml:"stdout_contains"`
	// StderrContains, if set, must be a substring of stderr.
	StderrContains string `yaml:"stderr_contains"`
	// Schema, if set, names a components.schemas.<Schema> definition in
	// the OpenAPI document that stdout, parsed as JSON, must validate
	// against.
	Schema string `yaml:"schema"`
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
}

// LoadCase reads and parses a case file at path.
func LoadCase(path string) (*Case, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read case %s: %w", path, err)
	}
	var c Case
	if err := yaml.Unmarshal(data, &c); err != nil {
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
	}
	c.SourcePath = path
	return &c, nil
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
	// SchemaDoc, if set, is the path to an OpenAPI document used to
	// resolve expect.schema names. Steps using expect.schema fail clearly
	// if this is empty.
	SchemaDoc string
}

// Runner executes case files against a built amika binary, tracking
// resources the steps create in a ledger so they can be cleaned up in
// reverse order once the run ends (see Cleanup).
type Runner struct {
	opts   Options
	ledger *Ledger
	schema *SchemaValidator
	vars   map[string]string
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
	ledger, err := NewLedger(filepath.Join(opts.RunDir, "ledger.json"))
	if err != nil {
		return nil, err
	}

	var schema *SchemaValidator
	if opts.SchemaDoc != "" {
		schema = LoadOpenAPISchema(opts.SchemaDoc)
	}

	return &Runner{
		opts:   opts,
		ledger: ledger,
		schema: schema,
		vars:   map[string]string{},
	}, nil
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

	if err := r.writeTranscript(index, step.Name, stdout, stderr, exitCode); err != nil {
		return err
	}

	if err := checkExitAndSubstrings(step, stdout, stderr, exitCode); err != nil {
		return err
	}

	parsed, err := r.checkJSONExpectations(step, stdout)
	if err != nil {
		return err
	}

	if err := r.captureVars(step, parsed); err != nil {
		return err
	}

	return r.registerResource(step)
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

// stepEnv builds the environment for one step: the runner's base
// environment (or os.Environ() if unset), an injected AMIKA_STATE_DIRECTORY
// when configured, and finally the step's own overrides. Keys are
// deduplicated (last write wins) so no name appears twice in the resulting
// slice, since the C library that resolves getenv() for the child process
// is free to return the first match rather than the last.
func (r *Runner) stepEnv(overrides map[string]string) []string {
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

	env := make([]string, 0, len(order))
	for _, key := range order {
		env = append(env, key+"="+values[key])
	}
	return env
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

// checkExitAndSubstrings asserts the exit code and any substring
// expectations, which do not require stdout to be JSON.
func checkExitAndSubstrings(step Step, stdout, stderr []byte, exitCode int) error {
	wantExit := 0
	if step.Expect.Exit != nil {
		wantExit = *step.Expect.Exit
	}
	if exitCode != wantExit {
		return fmt.Errorf("exit code: expected %d, got %d\nstdout:\n%s\nstderr:\n%s", wantExit, exitCode, stdout, stderr)
	}
	if step.Expect.StdoutContains != "" && !strings.Contains(string(stdout), step.Expect.StdoutContains) {
		return fmt.Errorf("stdout_contains: %q not found in stdout:\n%s", step.Expect.StdoutContains, stdout)
	}
	if step.Expect.StderrContains != "" && !strings.Contains(string(stderr), step.Expect.StderrContains) {
		return fmt.Errorf("stderr_contains: %q not found in stderr:\n%s", step.Expect.StderrContains, stderr)
	}
	return nil
}

// checkJSONExpectations parses stdout as JSON if the step needs it (for
// stdout_json, schema, or capture) and applies those checks. It returns
// the parsed value (nil if none of those were needed) for capturing.
func (r *Runner) checkJSONExpectations(step Step, stdout []byte) (any, error) {
	needsJSON := step.Expect.StdoutJSON != nil || step.Expect.Schema != "" || len(step.Capture) > 0
	if !needsJSON {
		return nil, nil
	}

	var parsed any
	if err := json.Unmarshal(stdout, &parsed); err != nil {
		return nil, fmt.Errorf("stdout is not valid JSON: %w\nstdout:\n%s", err, stdout)
	}

	if step.Expect.StdoutJSON != nil {
		if err := Match(step.Expect.StdoutJSON, parsed); err != nil {
			return nil, fmt.Errorf("stdout_json mismatch:\n%s", err)
		}
	}

	if step.Expect.Schema != "" {
		if r.schema == nil {
			return nil, fmt.Errorf("expect.schema %q requested but no OpenAPI document was loaded (Options.SchemaDoc empty)", step.Expect.Schema)
		}
		if err := r.schema.Validate(step.Expect.Schema, parsed); err != nil {
			return nil, fmt.Errorf("schema %q: %w", step.Expect.Schema, err)
		}
	}

	return parsed, nil
}

func (r *Runner) captureVars(step Step, parsed any) error {
	for name, path := range step.Capture {
		val, err := ExtractJSONPath(path, parsed)
		if err != nil {
			return fmt.Errorf("capture %q: %w", name, err)
		}
		r.vars[name] = toVarString(val)
	}
	return nil
}

func (r *Runner) registerResource(step Step) error {
	if step.Resource == nil {
		return nil
	}
	entry := Entry{
		Type:          step.Resource.Type,
		Name:          step.Resource.Name,
		CreatedByStep: step.Name,
		CleanupArgv:   step.Resource.Cleanup,
		CreatedAt:     time.Now().UTC(),
	}
	if err := r.ledger.Append(entry); err != nil {
		return fmt.Errorf("register resource %q: %w", step.Resource.Name, err)
	}
	return nil
}

// templateVarPattern matches "{{name}}" placeholders. Names may contain
// letters, digits, underscore, dot, and hyphen.
var templateVarPattern = regexp.MustCompile(`\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}`)

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

// substituteStep returns a copy of step with "{{var}}" templates resolved
// in cmd, stdin, env, resource, and expectation strings.
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

	if step.Resource != nil {
		res := *step.Resource
		name, err := substituteString(res.Name, r.vars)
		if err != nil {
			return Step{}, fmt.Errorf("resource.name: %w", err)
		}
		res.Name = name

		cleanup := make([]string, len(res.Cleanup))
		for i, arg := range res.Cleanup {
			v, err := substituteString(arg, r.vars)
			if err != nil {
				return Step{}, fmt.Errorf("resource.cleanup[%d]: %w", i, err)
			}
			cleanup[i] = v
		}
		res.Cleanup = cleanup
		out.Resource = &res
	}

	stdoutContains, err := substituteString(step.Expect.StdoutContains, r.vars)
	if err != nil {
		return Step{}, fmt.Errorf("expect.stdout_contains: %w", err)
	}
	out.Expect.StdoutContains = stdoutContains

	stderrContains, err := substituteString(step.Expect.StderrContains, r.vars)
	if err != nil {
		return Step{}, fmt.Errorf("expect.stderr_contains: %w", err)
	}
	out.Expect.StderrContains = stderrContains

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
