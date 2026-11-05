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
	"azure", "bronze", "cedar", "dusk", "ebony",
	"fawn", "gray", "hazel", "iron", "khaki",
	"lemon", "mint", "navy", "opal", "pearl",
	"quartz", "rose", "slate", "tan", "umber",
	"wine", "almond", "basil", "chalk", "denim",
	"flint", "ginger", "honey", "ink", "linen",
}

var cities = []string{
	"tokyo", "paris", "london", "berlin", "oslo",
	"lima", "rome", "seoul", "delhi", "cairo",
	"lagos", "dublin", "milan", "zurich", "vienna",
	"prague", "lisbon", "havana", "bogota", "nairobi",
	"kyoto", "austin", "porto", "cusco", "dhaka",
	"doha", "baku", "lyon", "cork", "split",
	"fez", "nice", "goa", "malmo", "quito",
	"riga", "sofia", "accra", "bergen", "brno",
	"ghent", "hanoi", "jaipur", "kobe", "busan",
	"natal", "nantes", "osaka", "perth", "rabat",
}

// GenerateName returns a random name in the format "{color}-{city}".
func GenerateName() string {
	color := colors[rand.Intn(len(colors))]
	city := cities[rand.Intn(len(cities))]
	return fmt.Sprintf("%s-%s", color, city)
}
