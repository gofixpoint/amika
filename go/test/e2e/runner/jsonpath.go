package runner

import (
	"fmt"
	"strconv"
	"strings"
)

// ExtractJSONPath extracts a value from a JSON-decoded tree (as produced by
// encoding/json into any) using a deliberately minimal JSONPath-like
// expression. Supported forms:
//
//	$.field          field access on an object
//	$.a.b            chained field access
//	$[0]             index into an array
//	$.items[0].name  field access, then index, then field access
//
// Anything beyond plain "$", ".field", and "[N]" segments (wildcards,
// filters, slices, recursive descent) is not supported; ExtractJSONPath
// returns an error naming the unsupported syntax rather than guessing.
func ExtractJSONPath(path string, value any) (any, error) {
	if !strings.HasPrefix(path, "$") {
		return nil, fmt.Errorf("jsonpath %q: must start with \"$\"", path)
	}

	cur := value
	rest := path[1:]
	for len(rest) > 0 {
		switch rest[0] {
		case '.':
			field, remainder, err := readField(path, rest[1:])
			if err != nil {
				return nil, err
			}
			m, ok := cur.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("jsonpath %q: %q is not an object (got %s)", path, field, typeName(cur))
			}
			v, ok := m[field]
			if !ok {
				return nil, fmt.Errorf("jsonpath %q: field %q not found", path, field)
			}
			cur = v
			rest = remainder
		case '[':
			idx, remainder, err := readIndex(path, rest)
			if err != nil {
				return nil, err
			}
			arr, ok := cur.([]any)
			if !ok {
				return nil, fmt.Errorf("jsonpath %q: index [%d] applied to non-array (got %s)", path, idx, typeName(cur))
			}
			if idx < 0 || idx >= len(arr) {
				return nil, fmt.Errorf("jsonpath %q: index %d out of range (len %d)", path, idx, len(arr))
			}
			cur = arr[idx]
			rest = remainder
		default:
			return nil, fmt.Errorf("jsonpath %q: unsupported syntax at %q", path, rest)
		}
	}
	return cur, nil
}

// readField reads a bare field name up to the next "." or "[", returning
// the field and the unconsumed remainder (which still starts with that
// delimiter, if any).
func readField(fullPath, s string) (field, remainder string, err error) {
	end := strings.IndexAny(s, ".[")
	if end == -1 {
		field, remainder = s, ""
	} else {
		field, remainder = s[:end], s[end:]
	}
	if field == "" {
		return "", "", fmt.Errorf("jsonpath %q: empty field name", fullPath)
	}
	return field, remainder, nil
}

// readIndex reads a "[N]" segment starting at s (s[0] == '['), returning
// the index and the unconsumed remainder.
func readIndex(fullPath, s string) (idx int, remainder string, err error) {
	end := strings.IndexByte(s, ']')
	if end == -1 {
		return 0, "", fmt.Errorf("jsonpath %q: unterminated \"[\"", fullPath)
	}
	idxStr := s[1:end]
	idx, err = strconv.Atoi(idxStr)
	if err != nil {
		return 0, "", fmt.Errorf("jsonpath %q: invalid array index %q", fullPath, idxStr)
	}
	return idx, s[end+1:], nil
}
