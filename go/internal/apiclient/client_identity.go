package apiclient

import (
	"net/http"
	"net/url"
	"os"
	"runtime"
	"sync"

	"github.com/gofixpoint/amika/go/internal/buildmeta"
)

// identifyingTransport sets the CLI's User-Agent on each request for the API
// host. Requests to other hosts, such as signed storage URLs, go out
// unchanged.
type identifyingTransport struct {
	base    http.RoundTripper
	apiHost string
}

func newIdentifyingTransport(baseURL string) http.RoundTripper {
	host := ""
	if parsed, err := url.Parse(baseURL); err == nil {
		host = parsed.Host
	}
	return identifyingTransport{base: http.DefaultTransport, apiHost: host}
}

func (t identifyingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Host != t.apiHost {
		return t.base.RoundTrip(req)
	}
	// A RoundTripper must not change the request it is given.
	req = req.Clone(req.Context())
	req.Header.Set("User-Agent", userAgent())
	return t.base.RoundTrip(req)
}

// userAgent is `amika-cli/<version> (<os>; <arch>; tty|notty)`. The last part
// says whether the process has a controlling terminal.
func userAgent() string {
	terminal := "notty"
	if hasTerminal() {
		terminal = "tty"
	}
	return "amika-cli/" + buildmeta.AmikaVersion.String() +
		" (" + runtime.GOOS + "; " + runtime.GOARCH + "; " + terminal + ")"
}

// hasTerminal reports whether the process has a controlling terminal. It
// opens the terminal device, not stdin: a ProxyCommand that ssh starts has a
// pipe on stdin even when ssh runs in a terminal. It is checked once, because
// the answer does not change while the process runs.
var hasTerminal = sync.OnceValue(func() bool {
	device := "/dev/tty"
	if runtime.GOOS == "windows" {
		device = "CONIN$"
	}
	f, err := os.Open(device)
	if err != nil {
		return false
	}
	_ = f.Close()
	return true
})
