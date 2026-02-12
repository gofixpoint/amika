package sandbox

import (
	"fmt"
	"math/rand"
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

// GenerateName returns a random name in the format "{color}-{city}".
func GenerateName() string {
	color := colors[rand.Intn(len(colors))]
	city := cities[rand.Intn(len(cities))]
	return fmt.Sprintf("%s-%s", color, city)
}
