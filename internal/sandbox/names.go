package sandbox

import (
	"fmt"
	"math/rand"
	"regexp"
)

var colors = []string{
	"red", "blue", "green", "amber", "coral",
	"cyan", "gold", "ivory", "jade", "lime",
	"mauve", "olive", "peach", "plum", "ruby",
	"sage", "teal", "violet", "scarlet", "indigo",
}

var cities = []string{
	"tokyo", "paris", "london", "berlin", "oslo",
	"lima", "rome", "seoul", "delhi", "cairo",
	"lagos", "dublin", "milan", "zurich", "vienna",
	"prague", "lisbon", "havana", "bogota", "nairobi",
}

// MaxNameLength is the maximum allowed length for a sandbox name (DNS label limit).
const MaxNameLength = 63

// namePattern matches lowercase alphanumeric strings with optional hyphens
// between segments. Leading/trailing/consecutive hyphens are not allowed.
var namePattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// ValidateName checks that name contains only lowercase letters, numbers, and
// hyphens, with no leading/trailing/consecutive hyphens, and is at most 63
// characters long (DNS label compatible).
func ValidateName(name string) error {
	if name == "" {
		return fmt.Errorf("sandbox name must not be empty")
	}
	if len(name) > MaxNameLength {
		return fmt.Errorf("sandbox name %q exceeds maximum length of %d characters", name, MaxNameLength)
	}
	if !namePattern.MatchString(name) {
		return fmt.Errorf("sandbox name %q is invalid: must contain only lowercase letters, numbers, and hyphens (no leading, trailing, or consecutive hyphens)", name)
	}
	return nil
}

// GenerateName returns a random name in the format "{color}-{city}".
func GenerateName() string {
	color := colors[rand.Intn(len(colors))]
	city := cities[rand.Intn(len(cities))]
	return fmt.Sprintf("%s-%s", color, city)
}
