package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/gofixpoint/amika/go/internal/auth"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/config"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
)

// ensureSSHSessionConfig refreshes the managed SSH config for the control
// plane just logged in to, so a user whose public key was uploaded through
// the web UI (and who therefore never runs `amika secret ssh-keygen`) still
// ends up with the session block `amika sandbox ssh` needs.
//
// It names the files it touched. `~/.ssh/config` governs every SSH connection
// the machine makes, not just Amika's, and it is commonly a symlink into a
// dotfiles repo, so editing it as a side effect of logging in is not
// something to do quietly.
//
// A failure only warns. The credential is already stored by this point, so
// returning an error would report a login that actually succeeded as failed,
// and every command that needs the block rewrites it on use anyway. The
// warning goes to stderr to keep `-o json` stdout a single JSON value, while
// the routine disclosure goes through Progress, which discards it in JSON
// mode.
func ensureSSHSessionConfig(cmd *cobra.Command, format output.Format) {
	paths := basedir.New("")
	session, err := ssh.EnsureSessionConfig(paths)
	if err != nil {
		fmt.Fprintf(cmd.ErrOrStderr(),
			"Warning: could not update the managed SSH config (%v); run `amika secret ssh-keygen` to retry.\n", err)
		return
	}
	out := format.Progress(cmd.OutOrStdout())
	amikaConfig, configErr := paths.SSHAmikaConfigFile()
	sshConfig, sshConfigErr := paths.SSHConfigFile()
	if configErr == nil && sshConfigErr == nil {
		fmt.Fprintf(out, "Updated %s, included from %s.\n", amikaConfig, sshConfig)
	}

	// The block names an identity whether or not one exists yet, so say so
	// rather than letting the first `sandbox ssh` be where the user finds
	// out. Both fixes are offered: a UI-uploaded key already has a private
	// half somewhere, and only --import points the config at it.
	if info, statErr := os.Stat(session.IdentityFile); statErr != nil || !info.Mode().IsRegular() {
		fmt.Fprintf(out, "No SSH identity at %s yet, so `amika sandbox ssh` will not connect until you add one:\n",
			session.IdentityFile)
		fmt.Fprintln(out, "  amika secret ssh-keygen                                 # create a new key")
		fmt.Fprintln(out, "  amika secret ssh-keygen --import <path>.pub             # use a key you already have")
	}
}

// logoutJSON is the JSON representation of `auth logout`, reporting which
// stored credentials were cleared.
type logoutJSON struct {
	ClearedAPIKey  bool   `json:"cleared_api_key"`
	ClearedSession bool   `json:"cleared_session"`
	SessionEmail   string `json:"session_email,omitempty"`
}

// authStatusJSON is the JSON representation of `auth status`.
type authStatusJSON struct {
	Authenticated bool     `json:"authenticated"`
	Method        string   `json:"method"`
	Email         string   `json:"email,omitempty"`
	OrgID         string   `json:"org_id,omitempty"`
	Warnings      []string `json:"warnings"`
}

var authCmd = &cobra.Command{
	Use:   "auth",
	Short: "Authentication credential commands",
	Long:  `Discover and transform local credentials for agent and sandbox use.`,
}

var authLoginCmd = &cobra.Command{
	Use:   "login",
	Short: "Log in to Amika",
	Long: `Authenticate with Amika.

By default runs a device authorization flow and opens a browser.

Pass --api-key-file to skip the browser flow and store an Amika API key
instead. Use "-" to read the key from stdin, which pairs well with secret
managers in CI (for example: "vault kv get -field=key … | amika auth login --api-key-file -").`,
	RunE: func(cmd *cobra.Command, _ []string) error {
		apiKeyFile, _ := cmd.Flags().GetString("api-key-file")

		format, err := output.FormatFrom(cmd)
		if err != nil {
			return err
		}
		if format.IsJSON() && apiKeyFile == "" {
			return fmt.Errorf("interactive device login cannot be combined with --%s %s; use --api-key-file", output.FlagName, format)
		}

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

		// --api-key-file is local-only by design (it pairs with secret
		// managers in CI). Sessions don't conflict with stored API
		// keys — runmode.DefaultAuthChecker resolves API keys ahead of
		// sessions — so neither valid nor stale sessions need to gate
		// this path. Refusing only on existing API-key state keeps
		// the path reliably non-interactive: no network, no session
		// validation.
		if apiKeyFile != "" {
			if existingKey != nil || keyCorrupt {
				who := "an API key"
				if keyCorrupt {
					who = "an unreadable API key file"
				}
				return fmt.Errorf("already have %s stored, run `amika auth logout` first", who)
			}
			return loginWithAPIKeyFile(cmd, apiKeyFile, format)
		}

		// Device-flow path. If GetValidSession (the same gate commands
		// use) succeeds, the user is still effectively logged in and
		// re-authenticating would be wasted work — refuse. If it
		// fails, the user is stuck: commands say "not logged in" but
		// the literal "already have a session" message would trap
		// them behind a mandatory `auth logout`. Treat the session as
		// absent so login can replace it in-place.
		if existingSession != nil {
			if _, refreshErr := auth.GetValidSession(config.WorkOSClientID()); refreshErr != nil {
				fmt.Fprintf(cmd.OutOrStdout(), "Stored session for %s is unusable (%v); replacing.\n", existingSession.Email, refreshErr)
				existingSession = nil
			}
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

		session, err := auth.DeviceLogin(config.WorkOSClientID())
		if err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Logged in as %s\n", session.Email)
		ensureSSHSessionConfig(cmd, format)
		return nil
	},
}

func loginWithAPIKeyFile(cmd *cobra.Command, path string, format output.Format) error {
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
	if format.IsJSON() {
		ensureSSHSessionConfig(cmd, format)
		return format.JSON(cmd.OutOrStdout(), authStatusJSON{Authenticated: true, Method: "stored_api_key", Warnings: []string{}})
	}
	fmt.Fprintln(cmd.OutOrStdout(), "Stored API key")
	ensureSSHSessionConfig(cmd, format)
	return nil
}

var authLogoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "Log out of Amika",
	RunE: func(cmd *cobra.Command, _ []string) error {
		format, err := output.FormatFrom(cmd)
		if err != nil {
			return err
		}
		out := format.Progress(cmd.OutOrStdout())
		result := logoutJSON{}

		// A delete can fail after an earlier one already changed auth state
		// (e.g. the API key was cleared but the session delete then fails).
		// Emit the JSON result first so -o json reports what was cleared
		// before the error surfaces, instead of exiting with empty stdout.
		failJSON := func(e error) error {
			if format.IsJSON() {
				_ = format.JSON(cmd.OutOrStdout(), result)
			}
			return e
		}

		// Parse errors must not block deletion: a corrupt credential file
		// would otherwise trap the user, since `auth login` refuses to
		// proceed while any stored credential is present.
		apiKeyPath, _ := config.APIKeyFile()
		if existingKey, loadErr := auth.LoadAPIKey(); loadErr != nil {
			fmt.Fprintf(out, "Warning: stored API key file is unreadable (%v); removing %s\n", loadErr, apiKeyPath)
			if err := auth.DeleteAPIKey(); err != nil {
				return failJSON(err)
			}
			result.ClearedAPIKey = true
		} else if existingKey != nil {
			if err := auth.DeleteAPIKey(); err != nil {
				return failJSON(err)
			}
			fmt.Fprintln(out, "Cleared stored API key")
			result.ClearedAPIKey = true
		}

		sessionPath, _ := config.WorkOSAuthSessionFile()
		if existingSession, loadErr := auth.LoadSession(); loadErr != nil {
			fmt.Fprintf(out, "Warning: stored session file is unreadable (%v); removing %s\n", loadErr, sessionPath)
			if err := auth.DeleteSession(); err != nil {
				return failJSON(err)
			}
			result.ClearedSession = true
		} else if existingSession != nil {
			if err := auth.DeleteSession(); err != nil {
				return failJSON(err)
			}
			fmt.Fprintf(out, "Cleared logged-in session (%s)\n", existingSession.Email)
			result.ClearedSession = true
			result.SessionEmail = existingSession.Email
		}

		if format.IsJSON() {
			return format.JSON(cmd.OutOrStdout(), result)
		}
		if !result.ClearedAPIKey && !result.ClearedSession {
			fmt.Fprintln(cmd.OutOrStdout(), "Already logged out")
		}
		return nil
	},
}

// buildAuthStatusJSON mirrors the text status logic: it picks the winning
// credential source and collects the same shadow/unreadable notes as the text
// annotations into a warnings list.
func buildAuthStatusJSON(
	envKeySet bool,
	storedKey *auth.APIKeyAuth,
	keyErr error,
	session *auth.WorkOSSession,
	sessErr error,
	apiKeyPath, sessionPath string,
) authStatusJSON {
	status := authStatusJSON{Warnings: []string{}}
	switch {
	case envKeySet:
		status.Authenticated = true
		status.Method = "env_api_key"
		status.Warnings = append(status.Warnings, apiKeyAnnotation(storedKey, keyErr, apiKeyPath)...)
		status.Warnings = append(status.Warnings, sessionAnnotation(session, sessErr, sessionPath)...)
	case storedKey != nil:
		status.Authenticated = true
		status.Method = "stored_api_key"
		status.Warnings = append(status.Warnings, sessionAnnotation(session, sessErr, sessionPath)...)
	case session != nil:
		status.Authenticated = true
		status.Method = "session"
		status.Email = session.Email
		status.OrgID = session.OrgID
		status.Warnings = append(status.Warnings, apiKeyAnnotation(storedKey, keyErr, apiKeyPath)...)
	default:
		status.Method = "none"
		// Mirror the text output's recovery hint so the two formats stay in sync.
		if keyErr != nil {
			status.Warnings = append(status.Warnings, fmt.Sprintf("stored API key file is unreadable (%v); run `amika auth logout` to clear it", keyErr))
		}
		if sessErr != nil {
			status.Warnings = append(status.Warnings, fmt.Sprintf("stored session file is unreadable (%v); run `amika auth logout` to clear it", sessErr))
		}
	}
	return status
}

// apiKeyAnnotation returns the warnings the text output would print for a
// shadowed or unreadable stored API key.
func apiKeyAnnotation(key *auth.APIKeyAuth, loadErr error, path string) []string {
	switch {
	case loadErr != nil:
		return []string{fmt.Sprintf("ignoring unreadable API key file (%s: %v)", path, loadErr)}
	case key != nil:
		return []string{fmt.Sprintf("shadows stored API key (%s)", path)}
	}
	return nil
}

// sessionAnnotation returns the warnings the text output would print for a
// shadowed or unreadable stored session.
func sessionAnnotation(s *auth.WorkOSSession, loadErr error, path string) []string {
	switch {
	case loadErr != nil:
		return []string{fmt.Sprintf("ignoring unreadable session file (%s: %v)", path, loadErr)}
	case s != nil:
		msg := fmt.Sprintf("shadows logged-in session: %s", s.Email)
		if s.OrgID != "" {
			msg += fmt.Sprintf(" (org: %s)", s.OrgID)
		}
		return []string{msg}
	}
	return nil
}

func printAPIKeyAnnotation(out io.Writer, key *auth.APIKeyAuth, loadErr error, path string) {
	for _, w := range apiKeyAnnotation(key, loadErr, path) {
		fmt.Fprintf(out, "  %s\n", w)
	}
}

func printSessionAnnotation(out io.Writer, s *auth.WorkOSSession, loadErr error, path string) {
	for _, w := range sessionAnnotation(s, loadErr, path) {
		fmt.Fprintf(out, "  %s\n", w)
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

		format, err := output.FormatFrom(cmd)
		if err != nil {
			return err
		}
		if format.IsJSON() {
			return format.JSON(out, buildAuthStatusJSON(
				envKeySet, storedKey, keyErr, session, sessErr, apiKeyPath, sessionPath))
		}

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

	authLoginCmd.Flags().String("api-key-file", "", `Read an Amika API key from this path instead of running the device flow ("-" for stdin)`)
}
