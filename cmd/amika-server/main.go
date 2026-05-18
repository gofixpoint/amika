// Package main runs the Amika HTTP server.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/gofixpoint/amika/internal/buildmeta"
	"github.com/gofixpoint/amika/internal/config"
	"github.com/gofixpoint/amika/internal/httpapi"
	"github.com/gofixpoint/amika/internal/sandbox"
	"github.com/gofixpoint/amika/internal/watcher"
	"github.com/gofixpoint/amika/pkg/amika"
)

func main() {
	if err := run(os.Args[1:], os.Stdout, os.LookupEnv, http.ListenAndServe); err != nil {
		panic(err)
	}
}

func run(
	args []string,
	stdout io.Writer,
	lookupEnv func(string) (string, bool),
	listenAndServe func(string, http.Handler) error,
) error {
	fs := flag.NewFlagSet("amika-server", flag.ContinueOnError)
	fs.SetOutput(io.Discard)

	addr, addrFlagSet, showVersion, err := parseServerFlags(fs, args)
	if err != nil {
		return fmt.Errorf("invalid listen address configuration: %w", err)
	}
	if showVersion {
		fmt.Fprintln(stdout, buildmeta.New("amika-server", buildmeta.AmikaServerVersion).String())
		return nil
	}
	addr, err = applyListenAddrEnv(addr, addrFlagSet, lookupEnv)
	if err != nil {
		return fmt.Errorf("invalid listen address configuration: %w", err)
	}

	// Start lifecycle watcher with SSE event broker.
	broker := httpapi.NewEventBroker()
	var watcherStore sandbox.Store
	if sandboxesFile, err := config.SandboxesStateFile(); err == nil {
		watcherStore = sandbox.NewStore(sandboxesFile)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if watcherStore != nil {
		w := watcher.New(watcher.Options{
			Store:    watcherStore,
			Handlers: []watcher.Handler{broker.Handler()},
		})
		go w.Run(ctx)
	}

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		cancel()
	}()

	handler := httpapi.NewHandlerWithEvents(amika.NewService(amika.Options{}), broker)
	log.Printf("amika-server listening on %s", addr)
	if err := listenAndServe(addr, handler); err != nil {
		return fmt.Errorf("server failed: %w", err)
	}
	return nil
}

func resolveListenAddr(
	fs *flag.FlagSet,
	args []string,
	lookupEnv func(string) (string, bool),
) (string, error) {
	addr, addrFlagSet, _, err := parseServerFlags(fs, args)
	if err != nil {
		return "", err
	}
	return applyListenAddrEnv(addr, addrFlagSet, lookupEnv)
}

func parseServerFlags(fs *flag.FlagSet, args []string) (string, bool, bool, error) {
	const defaultAddr = ":8080"

	addr := defaultAddr
	addrFlagSet := false
	showVersion := false

	fs.BoolVar(&showVersion, "version", false, "Print version information and exit")
	fs.Func("addr", "HTTP listen address", func(value string) error {
		addr = value
		addrFlagSet = true
		return nil
	})

	if err := fs.Parse(args); err != nil {
		return "", false, false, err
	}
	return addr, addrFlagSet, showVersion, nil
}

func applyListenAddrEnv(addr string, addrFlagSet bool, lookupEnv func(string) (string, bool)) (string, error) {
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
