package runner

import (
	"fmt"
	"math"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Match compares actual (a value decoded from JSON via encoding/json into
// any — so map[string]any, []any, string, float64, bool, or nil) against
// expected, which is typically decoded from a case file's YAML and may
// contain matcher placeholder strings.
//
// Matching semantics:
//   - A scalar in expected (string, number, bool, null) must equal actual
//     exactly, unless the string is a matcher placeholder (see below).
//   - When expected is a map, matching is a SUBSET match: only keys present
//     in expected are asserted, and extra keys in actual are ignored. This
//     is what lets a case assert only the fields it cares about instead of
//     enumerating every field a command happens to return.
//   - When expected is a slice, elements are matched positionally in
//     order; actual must have at least len(expected) items, and any extra
//     trailing items in actual are ignored.
//
// Matcher placeholder strings (used in place of a literal expected value):
//   - "@string", "@number", "@bool", "@array", "@object" — assert actual's
//     JSON type.
//   - "@string?" (or any of the above with a trailing "?") — same type
//     assertion, but also accepts the key being entirely absent from the
//     actual object, or present with a JSON null value.
//   - "@oneof: a, b, c" — actual, stringified, must equal one of the
//     comma-separated tokens (tokens and actual are compared as trimmed
//     strings).
//   - "@timestamp" — actual must be a string parseable as RFC3339 (with or
//     without fractional seconds).
//   - "@regex: <pattern>" — actual must be a string matching the Go
//     regexp <pattern>.
//
// On mismatch, Match returns a single error listing every mismatching
// path, one per line, in the form "$.a.b[0]: expected X, got Y".
func Match(expected, actual any) error {
	var problems []string
	matchAt("$", expected, actual, &problems)
	if len(problems) == 0 {
		return nil
	}
	return fmt.Errorf("%s", strings.Join(problems, "\n"))
}

func matchAt(path string, expected, actual any, problems *[]string) {
	if spec, ok := expected.(string); ok && isMatcher(spec) {
		if err := applyMatcher(spec, actual); err != nil {
			*problems = append(*problems, fmt.Sprintf("%s: %s", path, err))
		}
		return
	}

	switch exp := expected.(type) {
	case map[string]any:
		matchObjectAt(path, exp, actual, problems)
	case []any:
		matchArrayAt(path, exp, actual, problems)
	default:
		if !scalarEqual(expected, actual) {
			*problems = append(*problems, fmt.Sprintf("%s: expected %s, got %s", path, formatValue(expected), formatValue(actual)))
		}
	}
}

func matchObjectAt(path string, expected map[string]any, actual any, problems *[]string) {
	am, ok := actual.(map[string]any)
	if !ok {
		*problems = append(*problems, fmt.Sprintf("%s: expected @object, got %s", path, typeName(actual)))
		return
	}
	for key, expectedVal := range expected {
		childPath := path + "." + key
		actualVal, present := am[key]
		if !present {
			if matcherAllowsAbsent(expectedVal) {
				continue
			}
			*problems = append(*problems, fmt.Sprintf("%s: missing key %q", path, key))
			continue
		}
		matchAt(childPath, expectedVal, actualVal, problems)
	}
}

func matchArrayAt(path string, expected []any, actual any, problems *[]string) {
	aa, ok := actual.([]any)
	if !ok {
		*problems = append(*problems, fmt.Sprintf("%s: expected @array, got %s", path, typeName(actual)))
		return
	}
	if len(aa) < len(expected) {
		*problems = append(*problems, fmt.Sprintf("%s: expected at least %d item(s), got %d", path, len(expected), len(aa)))
		return
	}
	for i, expectedVal := range expected {
		matchAt(fmt.Sprintf("%s[%d]", path, i), expectedVal, aa[i], problems)
	}
}

// isMatcher reports whether s is a matcher placeholder rather than a
// literal expected string value.
func isMatcher(s string) bool {
	return strings.HasPrefix(s, "@")
}

// matcherAllowsAbsent reports whether expectedVal is an optional matcher
// placeholder (one ending in "?", e.g. "@string?"), which permits the key
// to be missing entirely from the actual object.
func matcherAllowsAbsent(expectedVal any) bool {
	s, ok := expectedVal.(string)
	if !ok {
		return false
	}
	name, _ := splitMatcher(s)
	return strings.HasSuffix(name, "?")
}

// splitMatcher splits a matcher placeholder like "@oneof: a, b, c" into its
// name ("@oneof") and argument ("a, b, c"). Placeholders with no argument
// (e.g. "@string", "@string?") return an empty argument.
func splitMatcher(spec string) (name, arg string) {
	idx := strings.Index(spec, ":")
	if idx < 0 {
		return spec, ""
	}
	return strings.TrimSpace(spec[:idx]), strings.TrimSpace(spec[idx+1:])
}

func applyMatcher(spec string, actual any) error {
	name, arg := splitMatcher(spec)
	optional := strings.HasSuffix(name, "?")
	base := strings.TrimSuffix(name, "?")

	if optional && actual == nil {
		return nil
	}

	switch base {
	case "@string":
		if _, ok := actual.(string); !ok {
			return fmt.Errorf("expected @string, got %s", typeName(actual))
		}
	case "@number":
		if _, ok := numeric(actual); !ok {
			return fmt.Errorf("expected @number, got %s", typeName(actual))
		}
	case "@bool":
		if _, ok := actual.(bool); !ok {
			return fmt.Errorf("expected @bool, got %s", typeName(actual))
		}
	case "@array":
		if _, ok := actual.([]any); !ok {
			return fmt.Errorf("expected @array, got %s", typeName(actual))
		}
	case "@object":
		if _, ok := actual.(map[string]any); !ok {
			return fmt.Errorf("expected @object, got %s", typeName(actual))
		}
	case "@oneof":
		return matchOneOf(arg, actual)
	case "@timestamp":
		return matchTimestamp(actual)
	case "@regex":
		return matchRegex(arg, actual)
	default:
		return fmt.Errorf("unknown matcher %q", spec)
	}
	return nil
}

func matchOneOf(arg string, actual any) error {
	tokens := splitCSV(arg)
	got := stringify(actual)
	for _, tk := range tokens {
		if tk == got {
			return nil
		}
	}
	return fmt.Errorf("expected one of [%s], got %q", strings.Join(tokens, ", "), got)
}

func matchTimestamp(actual any) error {
	s, ok := actual.(string)
	if !ok {
		return fmt.Errorf("expected @timestamp string, got %s", typeName(actual))
	}
	if !isTimestamp(s) {
		return fmt.Errorf("expected RFC3339 timestamp, got %q", s)
	}
	return nil
}

func matchRegex(pattern string, actual any) error {
	s, ok := actual.(string)
	if !ok {
		return fmt.Errorf("expected string matching /%s/, got %s", pattern, typeName(actual))
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return fmt.Errorf("invalid @regex pattern %q: %w", pattern, err)
	}
	if !re.MatchString(s) {
		return fmt.Errorf("expected string matching /%s/, got %q", pattern, s)
	}
	return nil
}

// isTimestamp reports whether s parses as RFC3339, with or without
// fractional seconds.
func isTimestamp(s string) bool {
	if _, err := time.Parse(time.RFC3339, s); err == nil {
		return true
	}
	_, err := time.Parse(time.RFC3339Nano, s)
	return err == nil
}

// numeric normalizes any JSON-decoded numeric type to float64.
func numeric(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	case uint64:
		return float64(n), true
	default:
		return 0, false
	}
}

// scalarEqual compares two plain JSON scalars (as opposed to matcher
// placeholders), normalizing numeric types so that, e.g., a YAML-decoded
// int expected value compares equal to a JSON-decoded float64 actual
// value.
func scalarEqual(expected, actual any) bool {
	if expected == nil || actual == nil {
		return expected == nil && actual == nil
	}
	if es, ok := expected.(string); ok {
		as, ok2 := actual.(string)
		return ok2 && es == as
	}
	if eb, ok := expected.(bool); ok {
		ab, ok2 := actual.(bool)
		return ok2 && eb == ab
	}
	if en, ok := numeric(expected); ok {
		an, ok2 := numeric(actual)
		return ok2 && en == an
	}
	return reflect.DeepEqual(expected, actual)
}

// typeName describes actual's JSON type for error messages.
func typeName(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "bool"
	case float64, float32, int, int32, int64, uint64:
		return "number"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	default:
		return fmt.Sprintf("%T", v)
	}
}

// stringify renders a JSON scalar in the plain form used to compare
// against @oneof tokens.
func stringify(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
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

func formatFloat(f float64) string {
	if f == math.Trunc(f) && !math.IsInf(f, 0) {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// formatValue renders a value for diff-style error messages.
func formatValue(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case string:
		return strconv.Quote(t)
	default:
		return fmt.Sprintf("%v", t)
	}
}

// splitCSV splits a comma-separated matcher argument into trimmed tokens.
func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		out = append(out, strings.TrimSpace(p))
	}
	return out
}
