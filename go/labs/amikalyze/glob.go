package amikalyze

import (
	"path"
	"strings"
)

// matchPattern matches slash-separated paths. A segment containing a single
// star follows path.Match semantics; a segment equal to ** matches zero or
// more complete path segments.
func matchPattern(pattern, name string) bool {
	patternSegments := strings.Split(pattern, "/")
	nameSegments := strings.Split(name, "/")
	type state struct{ pattern, name int }
	memo := make(map[state]bool)
	seen := make(map[state]bool)

	var match func(int, int) bool
	match = func(patternIndex, nameIndex int) bool {
		key := state{pattern: patternIndex, name: nameIndex}
		if seen[key] {
			return memo[key]
		}
		seen[key] = true

		var matched bool
		switch {
		case patternIndex == len(patternSegments):
			matched = nameIndex == len(nameSegments)
		case patternSegments[patternIndex] == "**":
			matched = match(patternIndex+1, nameIndex) ||
				(nameIndex < len(nameSegments) && match(patternIndex, nameIndex+1))
		case nameIndex < len(nameSegments):
			segmentMatched, _ := path.Match(patternSegments[patternIndex], nameSegments[nameIndex])
			matched = segmentMatched && match(patternIndex+1, nameIndex+1)
		}
		memo[key] = matched
		return matched
	}

	return match(0, 0)
}
