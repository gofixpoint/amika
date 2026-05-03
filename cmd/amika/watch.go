package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/gofixpoint/amika/internal/config"
	"github.com/gofixpoint/amika/internal/sandbox"
	"github.com/gofixpoint/amika/internal/watcher"
	"github.com/spf13/cobra"
)

var sandboxWatchCmd = &cobra.Command{
	Use:   "watch",
	Short: "Watch sandbox lifecycle events",
	Long:  `Watch for sandbox expiration warnings and agent completion events. Press Ctrl+C to stop.`,
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		sandboxesFile, err := config.SandboxesStateFile()
		if err != nil {
			return err
		}
		store := sandbox.NewStore(sandboxesFile)

		nameFilter, _ := cmd.Flags().GetString("sandbox")

		handler := func(e watcher.Event) {
			if nameFilter != "" && e.SandboxName != nameFilter {
				return
			}
			switch e.Type {
			case watcher.EventExpirationWarning:
				fmt.Fprintf(os.Stderr, "[amika] WARNING: %s\n", e.Message)
			case watcher.EventExpired:
				fmt.Fprintf(os.Stderr, "[amika] %s\n", e.Message)
			case watcher.EventAgentCompleted:
				fmt.Fprintf(os.Stderr, "[amika] %s\n", e.Message)
			}
		}

		w := watcher.New(watcher.Options{
			Store:    store,
			Handlers: []watcher.Handler{handler},
		})

		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

		go func() {
			<-sigCh
			cancel()
		}()

		fmt.Fprintln(os.Stderr, "[amika] Watching sandbox events... (Ctrl+C to stop)")
		w.Run(ctx)
		return nil
	},
}

func init() {
	sandboxCmd.AddCommand(sandboxWatchCmd)
	sandboxWatchCmd.Flags().String("sandbox", "", "Watch a specific sandbox by name")
}
