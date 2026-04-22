package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/gofixpoint/amika/internal/auth"
	"github.com/gofixpoint/amika/internal/config"
	"github.com/spf13/cobra"
)

var authCmd = &cobra.Command{
	Use:   "auth",
	Short: "Authentication credential commands",
	Long:  `Discover and transform local credentials for agent and sandbox use.`,
}

var authLoginCmd = &cobra.Command{
	Use:   "login",
	Short: "Log in to Amika",
	Long: `Authenticate with Amika.

By default runs the WorkOS Device Authorization Flow and opens a browser.

Pass --api-key-file to skip the browser flow and store a WorkOS organization
API key instead. Use "-" to read the key from stdin, which pairs well with
secret managers in CI (for example: "vault kv get -field=key … | amika auth login --api-key-file -").`,
	RunE: func(cmd *cobra.Command, _ []string) error {
		apiKeyFile, _ := cmd.Flags().GetString("api-key-file")

		existingSession, sessionErr := auth.LoadSession()
		existingKey, keyErr := auth.LoadAPIKey()

		// I/O failures that aren't recoverable via logout (permission
		// denied, invalid AMIKA_STATE_DIRECTORY, etc.) must surface
		// directly — redirecting the user to `auth logout` would just
		// fail with the same underlying error.
		sessionCorrupt := sessionErr != nil && errors.Is(sessionErr, auth.ErrCorruptSession)
		keyCorrupt := keyErr != nil && errors.Is(keyErr, auth.ErrCorruptAPIKey)
		if sessionErr != nil && !sessionCorrupt {
			return fmt.Errorf("reading stored session: %w", sessionErr)
		}
		if keyErr != nil && !keyCorrupt {
			return fmt.Errorf("reading stored API key: %w", keyErr)
		}

		// A corrupt credential file counts as "something stored" —
		// point the user at `auth logout`, which tolerates parse errors.
		if existingSession != nil || existingKey != nil || sessionCorrupt || keyCorrupt {
			who := "a credential"
			switch {
			case sessionCorrupt:
				who = "an unreadable session file"
			case keyCorrupt:
				who = "an unreadable API key file"
			case existingSession != nil:
				who = fmt.Sprintf("session for %s", existingSession.Email)
			case existingKey != nil:
				who = "an API key"
			}
			return fmt.Errorf("already have %s stored, run `amika auth logout` first", who)
		}

		if apiKeyFile != "" {
			return loginWithAPIKeyFile(cmd, apiKeyFile)
		}

		session, err := auth.DeviceLogin(config.WorkOSClientID())
		if err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Logged in as %s\n", session.Email)
		return nil
	},
}

func loginWithAPIKeyFile(cmd *cobra.Command, path string) error {
	var src io.Reader
	if path == "-" {
		src = cmd.InOrStdin()
	} else {
		f, err := os.Open(path)
		if err != nil {
			return fmt.Errorf("opening api key file: %w", err)
		}
		defer f.Close()
		src = f
	}
	key, err := auth.ReadAPIKeyFromReader(src)
	if err != nil {
		return err
	}
	if err := auth.SaveAPIKey(auth.APIKeyAuth{Key: key, StoredAt: time.Now().UTC()}); err != nil {
		return fmt.Errorf("saving api key: %w", err)
	}
	fmt.Fprintln(cmd.OutOrStdout(), "Stored API key")
	return nil
}

var authLogoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "Log out of Amika",
	RunE: func(cmd *cobra.Command, _ []string) error {
		out := cmd.OutOrStdout()
		clearedAny := false

		// Parse errors must not block deletion: a corrupt credential file
		// would otherwise trap the user, since `auth login` refuses to
		// proceed while any stored credential is present.
		apiKeyPath, _ := config.APIKeyFile()
		if existingKey, loadErr := auth.LoadAPIKey(); loadErr != nil {
			fmt.Fprintf(out, "Warning: stored API key file is unreadable (%v); removing %s\n", loadErr, apiKeyPath)
			if err := auth.DeleteAPIKey(); err != nil {
				return err
			}
			clearedAny = true
		} else if existingKey != nil {
			if err := auth.DeleteAPIKey(); err != nil {
				return err
			}
			fmt.Fprintln(out, "Cleared stored API key")
			clearedAny = true
		}

		sessionPath, _ := config.WorkOSAuthSessionFile()
		if existingSession, loadErr := auth.LoadSession(); loadErr != nil {
			fmt.Fprintf(out, "Warning: stored session file is unreadable (%v); removing %s\n", loadErr, sessionPath)
			if err := auth.DeleteSession(); err != nil {
				return err
			}
			clearedAny = true
		} else if existingSession != nil {
			if err := auth.DeleteSession(); err != nil {
				return err
			}
			fmt.Fprintf(out, "Cleared logged-in session (%s)\n", existingSession.Email)
			clearedAny = true
		}

		if !clearedAny {
			fmt.Fprintln(out, "Already logged out")
		}
		return nil
	},
}

func printAPIKeyAnnotation(out io.Writer, key *auth.APIKeyAuth, loadErr error, path string) {
	switch {
	case loadErr != nil:
		fmt.Fprintf(out, "  ignoring unreadable API key file (%s: %v)\n", path, loadErr)
	case key != nil:
		fmt.Fprintf(out, "  shadows stored API key (%s)\n", path)
	}
}

func printSessionAnnotation(out io.Writer, s *auth.WorkOSSession, loadErr error, path string) {
	switch {
	case loadErr != nil:
		fmt.Fprintf(out, "  ignoring unreadable session file (%s: %v)\n", path, loadErr)
	case s != nil:
		fmt.Fprintf(out, "  shadows logged-in session: %s", s.Email)
		if s.OrgID != "" {
			fmt.Fprintf(out, " (org: %s)", s.OrgID)
		}
		fmt.Fprintln(out)
	}
}

var authStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show current authentication status",
	RunE: func(cmd *cobra.Command, _ []string) error {
		out := cmd.OutOrStdout()

		envKeySet := os.Getenv(config.EnvAPIKey) != ""

		// Lower-priority parse failures must not mask a higher-priority
		// credential that's still valid. Collect load errors and surface
		// them as warnings against the winning source instead.
		storedKey, keyErr := auth.LoadAPIKey()
		session, sessErr := auth.LoadSession()

		apiKeyPath, _ := config.APIKeyFile()
		sessionPath, _ := config.WorkOSAuthSessionFile()

		switch {
		case envKeySet:
			fmt.Fprintf(out, "Authenticated via %s environment variable\n", config.EnvAPIKey)
			printAPIKeyAnnotation(out, storedKey, keyErr, apiKeyPath)
			printSessionAnnotation(out, session, sessErr, sessionPath)
		case storedKey != nil:
			fmt.Fprintf(out, "Authenticated via stored API key (%s)\n", apiKeyPath)
			printSessionAnnotation(out, session, sessErr, sessionPath)
		case session != nil:
			fmt.Fprintf(out, "Logged in as %s", session.Email)
			if session.OrgID != "" {
				fmt.Fprintf(out, " (org: %s)", session.OrgID)
			}
			fmt.Fprintln(out)
			// The API key file is higher-priority; a corrupt one is
			// being skipped, not shadowed. Surface it so the user
			// knows to clean up.
			printAPIKeyAnnotation(out, storedKey, keyErr, apiKeyPath)
		default:
			// No usable credential. If something's on disk but unreadable,
			// point the user at the recovery path.
			if keyErr != nil {
				fmt.Fprintf(out, "Stored API key file is unreadable (%v); run `amika auth logout` to clear it\n", keyErr)
			}
			if sessErr != nil {
				fmt.Fprintf(out, "Stored session file is unreadable (%v); run `amika auth logout` to clear it\n", sessErr)
			}
			if keyErr == nil && sessErr == nil {
				fmt.Fprintln(out, "Not logged in")
			}
		}
		return nil
	},
}

func init() {
	rootCmd.AddCommand(authCmd)
	authCmd.AddCommand(authLoginCmd)
	authCmd.AddCommand(authLogoutCmd)
	authCmd.AddCommand(authStatusCmd)

	authLoginCmd.Flags().String("api-key-file", "", `Read a WorkOS organization API key from this path instead of running the device flow ("-" for stdin)`)
}
