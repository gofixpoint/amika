package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/gofixpoint/amika/internal/apiclient"
	"github.com/gofixpoint/amika/internal/auth"
	"github.com/spf13/cobra"
)

var secretsCmd = &cobra.Command{
	Use:   "secrets",
	Short: "Manage secrets",
	Long:  `Discover local credentials and push them to the Amika remote secrets store.`,
}

var secretsExtractCmd = &cobra.Command{
	Use:   "extract",
	Short: "Extract and optionally push local credentials as secrets",
	Long: `Discover local API credentials and display them.

With --push, push the discovered secrets to the remote Amika secrets store
after confirmation. Use --only to restrict which secrets are pushed.

Examples:
  amika secrets extract
  amika secrets extract --push
  amika secrets extract --push --only=ANTHROPIC_API_KEY,OPENAI_API_KEY`,
	RunE: func(cmd *cobra.Command, _ []string) error {
		cmd.SilenceUsage = true
		cmd.SilenceErrors = true

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

var secretsPushCmd = &cobra.Command{
	Use:   "push [KEY=VALUE ...]",
	Short: "Push secrets to the remote Amika secrets store",
	Long: `Push secrets to the remote Amika secrets store.

Secrets can be provided as KEY=VALUE positional arguments and/or read from
the current environment using --from-env.

Examples:
  amika secrets push ANTHROPIC_API_KEY=sk-ant-xxx
  amika secrets push --from-env=ANTHROPIC_API_KEY,OPENAI_API_KEY
  amika secrets push CUSTOM_KEY=val --from-env=ANTHROPIC_API_KEY`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true
		cmd.SilenceErrors = true

		fromEnvFlag, _ := cmd.Flags().GetString("from-env")
		scope, _ := cmd.Flags().GetString("scope")

		// Collect secrets from positional args.
		secrets := make(map[string]string)
		var keys []string
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

		// Collect secrets from environment.
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
			return fmt.Errorf("no secrets provided; pass KEY=VALUE args or use --from-env")
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
func getSecretsClient() (*apiclient.Client, error) {
	baseURL := os.Getenv(envAPIURL)
	if baseURL == "" {
		baseURL = apiclient.DefaultAPIURL
	}
	return apiclient.NewClientWithTokenSource(baseURL, apiclient.NewWorkOSTokenSource(defaultWorkOSClientID)), nil
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

func init() {
	rootCmd.AddCommand(secretsCmd)
	secretsCmd.AddCommand(secretsExtractCmd)
	secretsCmd.AddCommand(secretsPushCmd)

	secretsExtractCmd.Flags().String("homedir", "", "Override home directory used for credential discovery")
	secretsExtractCmd.Flags().Bool("no-oauth", false, "Skip OAuth credential sources")
	secretsExtractCmd.Flags().Bool("push", false, "Push discovered secrets to the remote Amika secrets store")
	secretsExtractCmd.Flags().String("only", "", "Comma-separated list of secret names to include (e.g. ANTHROPIC_API_KEY,OPENAI_API_KEY)")
	secretsExtractCmd.Flags().String("scope", "user", "Secret scope: \"user\" (default, private) or \"org\" (visible to org members)")

	secretsPushCmd.Flags().String("from-env", "", "Comma-separated list of environment variable names to read and push (e.g. ANTHROPIC_API_KEY,OPENAI_API_KEY)")
	secretsPushCmd.Flags().String("scope", "user", "Secret scope: \"user\" (default, private) or \"org\" (visible to org members)")
}
