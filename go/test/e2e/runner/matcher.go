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
//   - When expected is a slice, elements are matched positionally in order
//     and, by default, the lengths must match EXACTLY. A trailing "@..."
//     element relaxes this to a prefix match: the elements before it are
//     matched positionally and any number of further items in actual are
//     allowed and left unchecked. Use "@any" as an element to assert a
//     position is present without constraining its value.
//
// Matcher placeholder strings (used in place of a literal expected value):
//   - "@string", "@number", "@bool", "@array", "@object" — assert actual's
//     JSON type.
//   - "@string?" (or any of the above with a trailing "?") — same type
//     assertion, but also accepts the key being entirely absent from the
//     actual object, or present with a JSON null value.
//   - "@any" — matches any value in that position (any type, including
//     null). Useful as an array placeholder to skip a single element.
//   - "@..." — valid only as the final element of an expected array; allows
//     any number of further unchecked elements after the matched prefix.
//   - "@oneof: a, b, c" — actual, stringified, must equal one of the
//     comma-separated tokens (tokens and actual are compared as trimmed
//     strings).
//   - "@timestamp" — actual must be a string parseable as RFC3339 (with or
//     without fractional seconds).
//   - "@regex: <pattern>" — actual must be a string matching the Go
//     regexp <pattern>.
//
// A literal expected string that must itself begin with "@" is written with a
// doubled leading "@": "@@foo" asserts the literal value "@foo".
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
	if spec, ok := expected.(string); ok {
		if strings.HasPrefix(spec, "@@") {
			// Escaped literal: "@@foo" asserts the literal string "@foo", the
			// way to match a value that really starts with "@".
			expected = spec[1:]
		} else if isMatcher(spec) {
			if err := applyMatcher(spec, actual); err != nil {
				*problems = append(*problems, fmt.Sprintf("%s: %s", path, err))
			}
			return
		}
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
			// An optional matcher ("@string?") lets the key be absent, but
			// only if its base name is a real matcher: a typo like "@strng?"
			// must be reported rather than silently accepting an absent key.
			if optional, known := optionalMatcher(expectedVal); optional {
				if !known {
					*problems = append(*problems, fmt.Sprintf("%s: unknown matcher %s", childPath, formatValue(expectedVal)))
				}
				continue
			}
			*problems = append(*problems, fmt.Sprintf("%s: missing key %q", path, key))
			continue
		}
		matchAt(childPath, expectedVal, actualVal, problems)
	}
}

// arrayRestMatcher, as the final element of an expected array, switches array
// matching from exact-length to prefix: elements before it are matched
// positionally and any further elements in actual are allowed and unchecked.
const arrayRestMatcher = "@..."

func matchArrayAt(path string, expected []any, actual any, problems *[]string) {
	aa, ok := actual.([]any)
	if !ok {
		*problems = append(*problems, fmt.Sprintf("%s: expected @array, got %s", path, typeName(actual)))
		return
	}

	// A trailing "@..." element means "match the elements before it
	// positionally, then allow any number of further unchecked elements".
	// Without it the match is exact: actual must have exactly as many
	// elements as expected.
	prefix := false
	exp := expected
	if n := len(exp); n > 0 {
		if s, ok := exp[n-1].(string); ok && s == arrayRestMatcher {
			prefix = true
			exp = exp[:n-1]
		}
	}

	// "@..." is only meaningful as the final element. Reject it anywhere else
	// with a clear message rather than letting it fall through to matchAt,
	// which would report the less helpful "unknown matcher".
	for i, expectedVal := range exp {
		if s, ok := expectedVal.(string); ok && s == arrayRestMatcher {
			*problems = append(*problems, fmt.Sprintf("%s[%d]: %q is only valid as the last array element", path, i, arrayRestMatcher))
			return
		}
	}

	if prefix {
		if len(aa) < len(exp) {
			*problems = append(*problems, fmt.Sprintf("%s: expected at least %d item(s), got %d", path, len(exp), len(aa)))
			return
		}
	} else if len(aa) != len(exp) {
		*problems = append(*problems, fmt.Sprintf("%s: expected exactly %d item(s), got %d", path, len(exp), len(aa)))
		return
	}

	for i, expectedVal := range exp {
		matchAt(fmt.Sprintf("%s[%d]", path, i), expectedVal, aa[i], problems)
	}
}

// isMatcher reports whether s is a matcher placeholder rather than a
// literal expected string value.
func isMatcher(s string) bool {
	return strings.HasPrefix(s, "@")
}

// optionalMatcher reports whether expectedVal is an optional matcher
// placeholder (name ending in "?", e.g. "@string?"), and whether that
// matcher's base name is one the runner actually supports. A "?"-suffixed
// placeholder whose base is unsupported (e.g. "@strng?") returns
// optional=true, known=false so the caller rejects it rather than silently
// accepting an absent key.
func optionalMatcher(expectedVal any) (optional, known bool) {
	s, ok := expectedVal.(string)
	if !ok || !isMatcher(s) {
		return false, false
	}
	name, _ := splitMatcher(s)
	if !strings.HasSuffix(name, "?") {
		return false, false
	}
	return true, isKnownMatcher(strings.TrimSuffix(name, "?"))
}

// isKnownMatcher reports whether base (a matcher name with any trailing "?"
// already stripped) is a supported matcher. It mirrors the cases handled in
// applyMatcher; keep the two in sync when adding a matcher.
func isKnownMatcher(base string) bool {
	switch base {
	case "@string", "@number", "@bool", "@array", "@object", "@any", "@oneof", "@timestamp", "@regex":
		return true
	default:
		return false
	}
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

	// Validate the matcher name BEFORE the optional/nil short-circuit below:
	// otherwise a typo like "@strng?" matched against a present null value
	// would pass, the same class of silent false-positive the absent-key
	// path already rejects.
	if !isKnownMatcher(base) {
		return fmt.Errorf("unknown matcher %q", spec)
	}

	if optional && actual == nil {
		return nil
	}

	switch base {
	case "@any":
		// Matches any value (any type, including null). Used as a placeholder
		// to assert a position or key is present without checking its value.
		return nil
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
