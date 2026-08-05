// Command ghfind-healthcheck probes a list of HTTP endpoints and exits
// non-zero when any of them fails. It exists because the runtime image is
// distroless and has no curl/wget or shell: Docker HEALTHCHECK and compose
// healthchecks run this binary directly.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: ghfind-healthcheck <url> [<url>...]")
		os.Exit(2)
	}
	client := &http.Client{Timeout: 4 * time.Second}
	var failed bool
	for _, url := range os.Args[1:] {
		request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
		if err != nil {
			fmt.Fprintf(os.Stderr, "build request for %s: %v\n", url, err)
			failed = true
			continue
		}
		response, err := client.Do(request)
		if err != nil {
			fmt.Fprintf(os.Stderr, "probe %s: %v\n", url, err)
			failed = true
			continue
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			fmt.Fprintf(os.Stderr, "probe %s: status %d\n", url, response.StatusCode)
			failed = true
			continue
		}
		fmt.Printf("probe %s: ok\n", url)
	}
	if failed {
		os.Exit(1)
	}
}
