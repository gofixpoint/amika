// Package main runs the Amika HTTP server.
package main

import (
	"flag"
	"fmt"
	"net/http"

	"github.com/gofixpoint/amika/internal/httpapi"
	"github.com/gofixpoint/amika/pkg/amika"
)

func main() {
	addr := flag.String("addr", ":8080", "HTTP listen address")
	flag.Parse()

	handler := httpapi.NewHandler(amika.NewService(amika.Options{}))
	if err := http.ListenAndServe(*addr, handler); err != nil {
		panic(fmt.Errorf("server failed: %w", err))
	}
}
