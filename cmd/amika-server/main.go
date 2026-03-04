// Package main runs the Amika HTTP server.
package main

import (
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/gofixpoint/amika/internal/httpapi"
	"github.com/gofixpoint/amika/pkg/amika"
)

func main() {
	addr, err := resolveListenAddr(flag.CommandLine, os.Args[1:], os.LookupEnv)
	if err != nil {
		panic(fmt.Errorf("invalid listen address configuration: %w", err))
	}

	handler := httpapi.NewHandler(amika.NewService(amika.Options{}))
	log.Printf("amika-server listening on %s", addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		panic(fmt.Errorf("server failed: %w", err))
	}
}

func resolveListenAddr(
	fs *flag.FlagSet,
	args []string,
	lookupEnv func(string) (string, bool),
) (string, error) {
	const defaultAddr = ":8080"

	addr := defaultAddr
	addrFlagSet := false
	fs.Func("addr", "HTTP listen address", func(value string) error {
		addr = value
		addrFlagSet = true
		return nil
	})

	if err := fs.Parse(args); err != nil {
		return "", err
	}

	port, portSet := lookupEnv("PORT")
	if !portSet || port == "" {
		return addr, nil
	}
	if addrFlagSet {
		return "", errors.New("PORT and -addr are mutually exclusive")
	}
	if strings.Contains(port, ":") {
		return port, nil
	}
	return ":" + port, nil
}
