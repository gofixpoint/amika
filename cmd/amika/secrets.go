package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"text/tabwriter"

	"github.com/gofixpoint/amika/internal/apiclient"
	"github.com/gofixpoint/amika/internal/arch"
	"github.com/gofixpoint/amika/internal/auth"
	"github.com/gofixpoint/amika/internal/config"
	"github.com/spf13/cobra"
)

var secretCmd = &cobra.Command{
	Use:   "secret",
	Short: "Manage secrets",
	Long:  `Discover local credentials and push them to the Amika remote secrets store.`,
}

// secretsAliasCmd is a hidden alias so that "amika secrets" still works.
var secretsAliasCmd = &cobra.Command{
	Use:    "secrets",
	Short:  "Manage secrets",
	Long:   `Discover local credentials and push them to the Amika remote secrets store.`,
	Hidden: true,
}

func newSecretExtractCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "extract",
		Short: "Extract and optionally push local credentials as secrets",
		Long: `Discover local API credentials and display them.

With --push, push the discovered secrets to the remote Amika secrets store
after confirmation. Use --only to restrict which secrets are pushed.

Examples:
  amika secret extract
  amika secret extract --push
  amika secret extract --push --only=ANTHROPIC_API_KEY,OPENAI_API_KEY`,
		RunE: func(cmd *cobra.Command, _ []string) error {

			homeDir, _ := cmd.Flags().GetString("homedir")
			noOAuth, _ := cmd.Flags().GetBool("no-oauth")
			push, _ := cmd.Flags().GetBool("push")
			onlyFlag, _ := cmd.Flags().GetString("only")
			scope, _ := cmd.Flags().GetString("scope")

			result, err := auth.Discover(auth.Options{
				HomeDir:      homeDir,
				IncludeOAuth: !noOAuth,
			})
			if err != nil {
				return err
			}

			env := auth.BuildEnvMap(result)
			keys := env.SortedKeys()

			if len(keys) == 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "No secrets discovered.")
				return nil
			}

			// Apply --only filter.
			if onlyFlag != "" {
				allowed := parseOnlyFilter(onlyFlag)
				keys = filterKeys(keys, allowed)
				if len(keys) == 0 {
					fmt.Fprintln(cmd.OutOrStdout(), "No secrets match the --only filter.")
					return nil
				}
			}

			// Display discovered secrets.
			w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
			fmt.Fprintln(w, "SECRET\tVALUE")
			for _, key := range keys {
				value, _ := env.Get(key)
				fmt.Fprintf(w, "%s\t%s\n", key, maskValue(value))
			}
			w.Flush()

			if !push {
				return nil
			}

			// Confirm before pushing.
			fmt.Fprintf(cmd.OutOrStdout(), "\nPush %d secret(s) to remote store? [y/N] ", len(keys))
			reader := bufio.NewReader(cmd.InOrStdin())
			answer, err := reader.ReadString('\n')
			if err != nil {
				return fmt.Errorf("reading confirmation: %w", err)
			}
			answer = strings.TrimSpace(strings.ToLower(answer))
			if answer != "y" && answer != "yes" {
				fmt.Fprintln(cmd.OutOrStdout(), "Aborted.")
				return nil
			}

			// Get remote API client.
			client, err := getSecretsClient()
			if err != nil {
				return fmt.Errorf("authenticating with remote API: %w", err)
			}

			// Fetch existing remote secrets to decide create vs update.
			existing, err := client.ListSecrets()
			if err != nil {
				return fmt.Errorf("listing remote secrets: %w", err)
			}
			existingByName := make(map[string]apiclient.Secret)
			for _, s := range existing {
				existingByName[s.Name] = s
			}

			// Push each secret.
			for _, key := range keys {
				value, _ := env.Get(key)
				action, err := pushSecret(client, existingByName, key, value, scope)
				if err != nil {
					return err
				}
				fmt.Fprintf(cmd.OutOrStdout(), "  %s %s\n", action, key)
			}

			fmt.Fprintf(cmd.OutOrStdout(), "\nPushed %d secret(s).\n", len(keys))
			return nil
		},
	}

	cmd.Flags().String("homedir", "", "Override home directory used for credential discovery")
	cmd.Flags().Bool("no-oauth", false, "Skip OAuth credential sources")
	cmd.Flags().Bool("push", false, "Push discovered secrets to the remote Amika secrets store")
	cmd.Flags().String("only", "", "Comma-separated list of secret names to include (e.g. ANTHROPIC_API_KEY,OPENAI_API_KEY)")
	cmd.Flags().String("scope", "user", "Secret scope: \"user\" (default, private) or \"org\" (visible to org members)")

	return cmd
}

func newSecretPushCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "push [KEY=VALUE ...]",
		Short: "Push secrets to the remote Amika secrets store",
		Long: `Push secrets to the remote Amika secrets store.

Secrets can be provided as KEY=VALUE positional arguments, read from
the current environment using --from-env, or loaded from a .env file
using --from-file.

When multiple sources are used, positional arguments override --from-file
values, and --from-env overrides both.

The .env file format is Docker-style: blank lines and lines starting with #
are skipped, and values are taken verbatim (no quote stripping).

Examples:
  amika secret push ANTHROPIC_API_KEY=sk-ant-xxx
  amika secret push --from-env=ANTHROPIC_API_KEY,OPENAI_API_KEY
  amika secret push --from-file=.env
  amika secret push --from-file=.env CUSTOM_KEY=val --from-env=ANTHROPIC_API_KEY`,
		RunE: func(cmd *cobra.Command, args []string) error {

			fromEnvFlag, _ := cmd.Flags().GetString("from-env")
			fromFileFlag, _ := cmd.Flags().GetString("from-file")
			scope, _ := cmd.Flags().GetString("scope")

			// Collect secrets from --from-file first (lowest priority).
			secrets := make(map[string]string)
			var keys []string
			if fromFileFlag != "" {
				fileSecrets, fileKeys, err := parseEnvFile(fromFileFlag)
				if err != nil {
					return err
				}
				for _, key := range fileKeys {
					if _, exists := secrets[key]; !exists {
						keys = append(keys, key)
					}
					secrets[key] = fileSecrets[key]
				}
			}

			// Collect secrets from positional args (override file).
			for _, arg := range args {
				idx := strings.IndexByte(arg, '=')
				if idx < 1 {
					return fmt.Errorf("invalid argument %q: expected KEY=VALUE", arg)
				}
				key := arg[:idx]
				value := arg[idx+1:]
				if _, exists := secrets[key]; !exists {
					keys = append(keys, key)
				}
				secrets[key] = value
			}

			// Collect secrets from environment (override both).
			if fromEnvFlag != "" {
				for _, name := range strings.Split(fromEnvFlag, ",") {
					name = strings.TrimSpace(name)
					if name == "" {
						continue
					}
					value, ok := os.LookupEnv(name)
					if !ok {
						return fmt.Errorf("environment variable %q is not set", name)
					}
					if _, exists := secrets[name]; !exists {
						keys = append(keys, name)
					}
					secrets[name] = value
				}
			}

			if len(secrets) == 0 {
				return fmt.Errorf("no secrets provided; pass KEY=VALUE args, use --from-env, or use --from-file")
			}

			// Display and confirm.
			w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
			fmt.Fprintln(w, "SECRET\tVALUE")
			for _, key := range keys {
				fmt.Fprintf(w, "%s\t%s\n", key, maskValue(secrets[key]))
			}
			w.Flush()

			fmt.Fprintf(cmd.OutOrStdout(), "\nPush %d secret(s) to remote store? [y/N] ", len(keys))
			reader := bufio.NewReader(cmd.InOrStdin())
			answer, err := reader.ReadString('\n')
			if err != nil {
				return fmt.Errorf("reading confirmation: %w", err)
			}
			answer = strings.TrimSpace(strings.ToLower(answer))
			if answer != "y" && answer != "yes" {
				fmt.Fprintln(cmd.OutOrStdout(), "Aborted.")
				return nil
			}

			// Get remote API client.
			client, err := getSecretsClient()
			if err != nil {
				return fmt.Errorf("authenticating with remote API: %w", err)
			}

			// Fetch existing remote secrets to decide create vs update.
			existing, err := client.ListSecrets()
			if err != nil {
				return fmt.Errorf("listing remote secrets: %w", err)
			}
			existingByName := make(map[string]apiclient.Secret)
			for _, s := range existing {
				existingByName[s.Name] = s
			}

			// Push each secret.
			for _, key := range keys {
				value := secrets[key]
				action, err := pushSecret(client, existingByName, key, value, scope)
				if err != nil {
					return err
				}
				fmt.Fprintf(cmd.OutOrStdout(), "  %s %s\n", action, key)
			}

			fmt.Fprintf(cmd.OutOrStdout(), "\nPushed %d secret(s).\n", len(keys))
			return nil
		},
	}

	cmd.Flags().String("from-env", "", "Comma-separated list of environment variable names to read and push (e.g. ANTHROPIC_API_KEY,OPENAI_API_KEY)")
	cmd.Flags().String("from-file", "", "Path to a .env file containing KEY=VALUE secrets (one per line)")
	cmd.Flags().String("scope", "user", "Secret scope: \"user\" (default, private) or \"org\" (visible to org members)")

	return cmd
}

// parseEnvFile reads a .env file and returns the secrets and their keys in order.
// The format is Docker-style: blank lines and lines starting with # are skipped.
// Each non-empty, non-comment line must contain KEY=VALUE, split on the first =.
// Values are taken verbatim (no quote stripping or inline comment handling).
func parseEnvFile(path string) (map[string]string, []string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, fmt.Errorf("opening env file: %w", err)
	}
	defer f.Close()

	secrets := make(map[string]string)
	var keys []string
	scanner := bufio.NewScanner(f)
	lineNum := 0
	for scanner.Scan() {
		lineNum++
		line := scanner.Text()

		// Skip blank lines and comments.
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}

		idx := strings.IndexByte(line, '=')
		if idx < 1 {
			return nil, nil, fmt.Errorf("%s:%d: invalid line %q: expected KEY=VALUE", path, lineNum, line)
		}

		key := strings.TrimSpace(line[:idx])
		value := line[idx+1:]
		if _, exists := secrets[key]; !exists {
			keys = append(keys, key)
		}
		secrets[key] = value
	}
	if err := scanner.Err(); err != nil {
		return nil, nil, fmt.Errorf("reading env file %s: %w", path, err)
	}
	return secrets, keys, nil
}

// pushSecret creates or updates a single secret. It returns the action taken ("Created" or "Updated").
// If the secret already exists with a different scope, it returns an error.
func pushSecret(client *apiclient.Client, existing map[string]apiclient.Secret, name, value, scope string) (string, error) {
	remote, exists := existing[name]
	if !exists {
		err := client.CreateSecret(apiclient.CreateSecretRequest{
			Name:  name,
			Value: value,
			Scope: scope,
		})
		if err != nil {
			return "", fmt.Errorf("creating secret %s: %w", name, err)
		}
		return "Created", nil
	}

	if remote.Scope != scope {
		return "", fmt.Errorf(
			"secret %q already exists with scope %q but you are pushing with scope %q; "+
				"use --scope=%s to match the existing secret, or delete it first",
			name, remote.Scope, scope, remote.Scope,
		)
	}

	err := client.UpdateSecret(remote.ID, apiclient.UpdateSecretRequest{
		Value: value,
	})
	if err != nil {
		return "", fmt.Errorf("updating secret %s: %w", name, err)
	}
	return "Updated", nil
}

// getSecretsClient returns an API client for secrets operations.
// Credentials are resolved per request in the order: AMIKA_API_KEY env var,
// stored API key file, then WorkOS session.
func getSecretsClient() (*apiclient.Client, error) {
	return apiclient.NewClientWithTokenSource(config.APIURL(), apiclient.NewResolvedTokenSource(config.WorkOSClientID())), nil
}

// parseOnlyFilter splits a comma-separated list of secret names into a set.
func parseOnlyFilter(flag string) map[string]bool {
	parts := strings.Split(flag, ",")
	result := make(map[string]bool, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			result[p] = true
		}
	}
	return result
}

// filterKeys returns only the keys present in the allowed set.
func filterKeys(keys []string, allowed map[string]bool) []string {
	var filtered []string
	for _, k := range keys {
		if allowed[k] {
			filtered = append(filtered, k)
		}
	}
	return filtered
}

// maskValue shows the first 4 and last 4 characters of a value, masking the rest.
func maskValue(value string) string {
	if len(value) <= 12 {
		return strings.Repeat("*", len(value))
	}
	return value[:4] + strings.Repeat("*", len(value)-8) + value[len(value)-4:]
}

// discoveredCredential is a credential found on the local system, normalized
// across providers for display and interactive selection.
type discoveredCredential struct {
	// Type is a human-readable label: "API Key" or "OAuth".
	Type string
	// Source describes where the credential was found (e.g. file path).
	Source string
	// Value is the raw credential data to upload.
	Value string
}

// providerConfig captures the per-provider configuration driving the generic
// push/list/delete commands for provider-scoped credentials (Claude, Codex).
type providerConfig struct {
	// Use is the cobra subcommand name ("claude", "codex").
	Use string
	// DisplayName is the user-facing provider name shown in help text
	// ("Claude Code", "Codex").
	DisplayName string
	// ShortName is the prefix used for default credential labels and
	// terse messages ("Claude", "Codex").
	ShortName string
	// APIPath is the provider segment of the API endpoint used to build
	// /api/v0beta1/secrets/<APIPath>.
	APIPath string
	// PushLongHelp is the "Long" description for the push command.
	PushLongHelp string
	// Discover scans local credential sources for this provider.
	Discover func() ([]discoveredCredential, error)
	// AutoResolve resolves a credential value for a given credType
	// ("oauth" or "api_key") without interactive prompts.
	AutoResolve func(credType string) (string, error)
}

var claudeProvider = providerConfig{
	Use:         "claude",
	DisplayName: "Claude Code",
	ShortName:   "Claude",
	APIPath:     "claude",
	PushLongHelp: `Push Claude Code credentials to the remote Amika secrets store.

Scans your system for Claude credentials (API keys and OAuth tokens) and
lets you choose which one to push. On macOS, the keychain is also checked.

You can also provide credentials directly via --value or from a file via --from-file.

When using --type to auto-resolve credentials:
  --type api_key  Reads the ANTHROPIC_API_KEY environment variable.
  --type oauth    On macOS, reads from the macOS Keychain first, then falls
                  back to ~/.claude/.credentials.json and
                  ~/.claude-oauth-credentials.json.

When run interactively (no flags), scans all known credential sources:
  API keys:  ~/.claude.json.api, ~/.claude.json (fields: primaryApiKey,
             apiKey, anthropicApiKey, customApiKey with sk-ant- prefix)
  OAuth:     ~/.claude/.credentials.json, ~/.claude-oauth-credentials.json,
             and macOS Keychain (on macOS)

Examples:
  amika secret claude push
  amika secret claude push --name "Claude OAuth (Work Laptop)"
  amika secret claude push --from-file ~/.claude/.credentials.json
  amika secret claude push --value '{"claudeAiOauth":{...}}'`,
	Discover:    discoverClaudeCredentials,
	AutoResolve: autoResolveClaudeCredential,
}

var codexProvider = providerConfig{
	Use:         "codex",
	DisplayName: "Codex",
	ShortName:   "Codex",
	APIPath:     "codex",
	PushLongHelp: `Push Codex credentials to the remote Amika secrets store.

Scans ~/.codex/auth.json for credentials (API keys and OAuth tokens) and
lets you choose which one to push.

You can also provide credentials directly via --value or from a file via --from-file.

When using --type to auto-resolve credentials:
  --type api_key  Reads the OPENAI_API_KEY environment variable, then falls
                  back to the OPENAI_API_KEY field in ~/.codex/auth.json.
  --type oauth    Reads the full contents of ~/.codex/auth.json.

Examples:
  amika secret codex push
  amika secret codex push --type oauth --name "Codex OAuth"
  amika secret codex push --type api_key --name "Codex API Key"
  amika secret codex push --from-file ~/.codex/auth.json
  amika secret codex push --value '{"tokens":{"access_token":"..."}}'`,
	Discover:    discoverCodexCredentials,
	AutoResolve: autoResolveCodexCredential,
}

// newProviderCmd builds the parent subcommand for a provider
// (e.g. "amika secret claude").
func newProviderCmd(p providerConfig) *cobra.Command {
	return &cobra.Command{
		Use:   p.Use,
		Short: fmt.Sprintf("Manage %s credentials", p.DisplayName),
		Long:  fmt.Sprintf("Push and list %s credentials for sandbox authentication.", p.DisplayName),
	}
}

func newProviderPushCmd(p providerConfig) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "push",
		Short: fmt.Sprintf("Push %s credentials to the remote secrets store", p.DisplayName),
		Long:  p.PushLongHelp,
		RunE: func(cmd *cobra.Command, _ []string) error {

			credValue, credType, err := parseProviderCreds(cmd, p)
			if err != nil {
				return err
			}

			name, err := parseProviderName(cmd, p, credType)
			if err != nil {
				return err
			}

			client, err := getSecretsClient()
			if err != nil {
				return fmt.Errorf("authenticating with remote API: %w", err)
			}

			summary, err := client.CreateProviderSecret(p.APIPath, apiclient.CreateProviderSecretRequest{
				Name:  name,
				Value: credValue,
				Type:  credType,
			})
			if err != nil {
				return err
			}

			fmt.Fprintf(cmd.OutOrStdout(), "Created %s credential %q\n", p.ShortName, summary.Name)
			return nil
		},
	}

	cmd.Flags().String("name", "", "Human-readable label for the credential (required, prompted if omitted)")
	cmd.Flags().String("value", "", "Credential value (skips interactive discovery)")
	cmd.Flags().String("from-file", "", "Path to a credentials file (skips interactive discovery)")
	cmd.Flags().String("type", "oauth", "Credential type: \"oauth\" (default) or \"api_key\"")

	return cmd
}

func newProviderListCmd(p providerConfig) *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   fmt.Sprintf("List pushed %s credentials", p.DisplayName),
		RunE: func(cmd *cobra.Command, _ []string) error {

			client, err := getSecretsClient()
			if err != nil {
				return fmt.Errorf("authenticating with remote API: %w", err)
			}

			items, err := client.ListProviderSecrets(p.APIPath)
			if err != nil {
				return err
			}

			if len(items) == 0 {
				fmt.Fprintf(cmd.OutOrStdout(), "No %s credentials found.\n", p.ShortName)
				return nil
			}

			w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
			fmt.Fprintln(w, "ID\tNAME\tTYPE")
			for _, item := range items {
				fmt.Fprintf(w, "%s\t%s\t%s\n", item.ID, item.Name, item.Type)
			}
			return w.Flush()
		},
	}
}

func newProviderDeleteCmd(p providerConfig) *cobra.Command {
	return &cobra.Command{
		Use:     "delete <id>",
		Aliases: []string{"rm"},
		Short:   fmt.Sprintf("Delete a %s credential by ID", p.DisplayName),
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {

			client, err := getSecretsClient()
			if err != nil {
				return fmt.Errorf("authenticating with remote API: %w", err)
			}

			if err := client.DeleteProviderSecret(p.APIPath, args[0]); err != nil {
				return err
			}

			fmt.Fprintf(cmd.OutOrStdout(), "Deleted credential %s\n", args[0])
			return nil
		},
	}
}

// parseProviderCreds resolves the credential value and type from command
// flags, using the provider's hooks for auto-resolution and interactive
// discovery when needed. credType is "oauth" or "api_key". Returns an error
// if mutually exclusive flags --value and --from-file are both provided.
func parseProviderCreds(cmd *cobra.Command, p providerConfig) (credValue string, credType string, err error) {
	value, _ := cmd.Flags().GetString("value")
	fromFile, _ := cmd.Flags().GetString("from-file")
	typeFlag, _ := cmd.Flags().GetString("type")

	if value != "" && fromFile != "" {
		return "", "", fmt.Errorf("--value and --from-file are mutually exclusive")
	}

	switch {
	case value != "":
		credValue = value
		credType = typeFlag
	case fromFile != "":
		data, err := os.ReadFile(fromFile)
		if err != nil {
			return "", "", fmt.Errorf("reading credentials file: %w", err)
		}
		credValue = strings.TrimSpace(string(data))
		credType = typeFlag
	case cmd.Flags().Changed("type"):
		// --type was set explicitly without --value/--from-file;
		// auto-resolve based on the requested type.
		resolved, err := p.AutoResolve(typeFlag)
		if err != nil {
			return "", "", err
		}
		credValue = resolved
		credType = typeFlag
	default:
		// Interactive discovery — show all found credentials.
		cred, err := discoverAndPickCredential(cmd, p)
		if err != nil {
			return "", "", err
		}
		credValue = cred.Value
		credType = credentialTypeToAPI(cred.Type)
	}

	// Validate: OAuth credentials must be valid JSON.
	if credType == "oauth" && !json.Valid([]byte(credValue)) {
		return "", "", fmt.Errorf("OAuth credentials must be valid JSON")
	}

	return credValue, credType, nil
}

// parseProviderName resolves the credential name from the --name flag or by
// prompting the user interactively with a type-appropriate default.
func parseProviderName(cmd *cobra.Command, p providerConfig, credType string) (string, error) {
	name, _ := cmd.Flags().GetString("name")
	if name != "" {
		return name, nil
	}

	reader := bufio.NewReader(cmd.InOrStdin())
	defaultName := p.ShortName + " OAuth"
	if credType == "api_key" {
		defaultName = p.ShortName + " API Key"
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Name for this credential [%s]: ", defaultName)
	input, err := reader.ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("reading name: %w", err)
	}
	name = strings.TrimSpace(input)
	if name == "" {
		name = defaultName
	}
	return name, nil
}

// discoverAndPickCredential scans for local credentials via the provider's
// Discover hook, displays them, and lets the user pick one to push.
func discoverAndPickCredential(cmd *cobra.Command, p providerConfig) (discoveredCredential, error) {
	creds, err := p.Discover()
	if err != nil {
		return discoveredCredential{}, err
	}

	if len(creds) == 0 {
		return discoveredCredential{}, fmt.Errorf("no %s credentials found on this system\n\nUse --value or --from-file to provide credentials manually", p.ShortName)
	}

	fmt.Fprintf(cmd.OutOrStdout(), "Discovered %s credentials:\n\n", p.ShortName)
	for i, c := range creds {
		fmt.Fprintf(cmd.OutOrStdout(), "  [%d] %s  (%s)\n", i+1, c.Type, c.Source)
	}
	fmt.Fprintln(cmd.OutOrStdout())

	var selected discoveredCredential
	reader := bufio.NewReader(cmd.InOrStdin())
	if len(creds) == 1 {
		selected = creds[0]
		fmt.Fprintf(cmd.OutOrStdout(), "Push this credential? [y/N] ")
	} else {
		fmt.Fprintf(cmd.OutOrStdout(), "Select credential to push [1-%d]: ", len(creds))
		input, err := reader.ReadString('\n')
		if err != nil {
			return discoveredCredential{}, fmt.Errorf("reading selection: %w", err)
		}
		input = strings.TrimSpace(input)
		choice, err := strconv.Atoi(input)
		if err != nil || choice < 1 || choice > len(creds) {
			return discoveredCredential{}, fmt.Errorf("invalid selection: %q", input)
		}
		selected = creds[choice-1]

		fmt.Fprintf(cmd.OutOrStdout(), "\nPush %s from %s? [y/N] ", selected.Type, selected.Source)
	}

	answer, err := reader.ReadString('\n')
	if err != nil {
		return discoveredCredential{}, fmt.Errorf("reading confirmation: %w", err)
	}
	answer = strings.TrimSpace(strings.ToLower(answer))
	if answer != "y" && answer != "yes" {
		return discoveredCredential{}, fmt.Errorf("aborted")
	}

	return selected, nil
}

// credentialTypeToAPI maps a discovery type label ("API Key" / "OAuth") to
// the API type field ("api_key" / "oauth").
func credentialTypeToAPI(discoveryType string) string {
	switch discoveryType {
	case "API Key":
		return "api_key"
	default:
		return "oauth"
	}
}

// discoverClaudeCredentials returns Claude credentials from files plus
// (on macOS) the keychain.
func discoverClaudeCredentials() ([]discoveredCredential, error) {
	raw, err := auth.DiscoverClaudeCredentials("")
	if err != nil {
		return nil, err
	}

	creds := make([]discoveredCredential, 0, len(raw)+1)
	for _, c := range raw {
		creds = append(creds, discoveredCredential{Type: c.Type, Source: c.Source, Value: c.Value})
	}

	if arch.IsMacOS() {
		if v, err := readClaudeCredentialFromKeychain(); err == nil && v != "" && json.Valid([]byte(v)) {
			creds = append(creds, discoveredCredential{
				Type:   "OAuth",
				Source: "macOS Keychain",
				Value:  v,
			})
		}
	}

	return creds, nil
}

// readClaudeCredentialFromKeychain reads Claude Code credentials from the
// macOS keychain.
func readClaudeCredentialFromKeychain() (string, error) {
	out, err := exec.Command("security", "find-generic-password", "-s", "Claude Code-credentials", "-w").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// autoResolveClaudeCredential resolves a Claude credential value automatically
// based on the requested type, without interactive prompts.
//   - "api_key": reads the ANTHROPIC_API_KEY environment variable.
//   - "oauth": on macOS reads from the keychain first, then from credential files.
func autoResolveClaudeCredential(credType string) (string, error) {
	if credType == "api_key" {
		key := os.Getenv("ANTHROPIC_API_KEY")
		if key == "" {
			return "", fmt.Errorf("ANTHROPIC_API_KEY environment variable is not set")
		}
		return key, nil
	}

	// OAuth: try keychain on macOS, then credential files.
	if arch.IsMacOS() {
		value, err := readClaudeCredentialFromKeychain()
		if err == nil && value != "" {
			return value, nil
		}
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("determining home directory: %w", err)
	}

	for _, rel := range auth.ClaudeOAuthPaths() {
		path := filepath.Join(homeDir, rel)
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		value := strings.TrimSpace(string(data))
		if !json.Valid([]byte(value)) {
			continue
		}
		// Verify OAuth-specific field: claudeAiOauth.accessToken must be
		// present, matching the check in DiscoverClaudeCredentials.
		var obj map[string]any
		if err := json.Unmarshal([]byte(value), &obj); err != nil {
			continue
		}
		oauth, ok := obj["claudeAiOauth"].(map[string]any)
		if !ok {
			continue
		}
		at, ok := oauth["accessToken"].(string)
		if !ok || at == "" {
			continue
		}
		return value, nil
	}

	return "", fmt.Errorf("no OAuth credentials found; on macOS check keychain, or provide --value or --from-file")
}

// discoverCodexCredentials returns Codex credentials from ~/.codex/auth.json.
func discoverCodexCredentials() ([]discoveredCredential, error) {
	raw, err := auth.DiscoverCodexCredentials("")
	if err != nil {
		return nil, err
	}
	creds := make([]discoveredCredential, 0, len(raw))
	for _, c := range raw {
		creds = append(creds, discoveredCredential{Type: c.Type, Source: c.Source, Value: c.Value})
	}
	return creds, nil
}

// autoResolveCodexCredential resolves a Codex credential value automatically
// based on the requested type, without interactive prompts.
//   - "api_key": reads OPENAI_API_KEY from the environment, falling back to
//     the OPENAI_API_KEY field in ~/.codex/auth.json.
//   - "oauth": reads the full contents of ~/.codex/auth.json.
func autoResolveCodexCredential(credType string) (string, error) {
	if credType == "api_key" {
		if key := os.Getenv("OPENAI_API_KEY"); key != "" {
			return key, nil
		}
		// Fall back to the API key field inside auth.json.
		creds, err := auth.DiscoverCodexCredentials("")
		if err != nil {
			return "", err
		}
		for _, c := range creds {
			if c.Type == "API Key" {
				return c.Value, nil
			}
		}
		return "", fmt.Errorf("OPENAI_API_KEY environment variable is not set and no API key found in ~/.codex/auth.json")
	}

	// OAuth: read the auth.json file contents directly.
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("determining home directory: %w", err)
	}
	for _, rel := range auth.CodexCredentialPaths() {
		path := filepath.Join(homeDir, rel)
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		value := strings.TrimSpace(string(data))
		if !json.Valid([]byte(value)) {
			continue
		}
		// Verify OAuth-specific field: tokens.access_token must be present,
		// matching the check in DiscoverCodexCredentials.
		var obj map[string]any
		if err := json.Unmarshal([]byte(value), &obj); err != nil {
			continue
		}
		tokens, ok := obj["tokens"].(map[string]any)
		if !ok {
			continue
		}
		at, ok := tokens["access_token"].(string)
		if !ok || at == "" {
			continue
		}
		return value, nil
	}

	return "", fmt.Errorf("no OAuth credentials found in ~/.codex/auth.json (missing tokens.access_token); provide --value or --from-file")
}

// addProviderCommands attaches the push/list/delete subcommands for a
// provider under a shared parent on `parent`. When hidden is true, the
// provider's own subcommand is hidden (used under the `secrets` alias).
func addProviderCommands(parent *cobra.Command, p providerConfig, hidden bool) {
	cmd := newProviderCmd(p)
	cmd.Hidden = hidden
	cmd.AddCommand(newProviderPushCmd(p))
	cmd.AddCommand(newProviderListCmd(p))
	cmd.AddCommand(newProviderDeleteCmd(p))
	parent.AddCommand(cmd)
}

func init() {
	rootCmd.AddCommand(secretCmd)
	secretCmd.AddCommand(newSecretExtractCmd())
	secretCmd.AddCommand(newSecretPushCmd())
	addProviderCommands(secretCmd, claudeProvider, false)
	addProviderCommands(secretCmd, codexProvider, false)

	rootCmd.AddCommand(secretsAliasCmd)
	secretsAliasCmd.AddCommand(newSecretExtractCmd())
	secretsAliasCmd.AddCommand(newSecretPushCmd())
	addProviderCommands(secretsAliasCmd, claudeProvider, true)
	addProviderCommands(secretsAliasCmd, codexProvider, true)
}
