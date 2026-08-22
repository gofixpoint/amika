package main

import (
	"encoding/json"
	"fmt"

	policy "github.com/gofixpoint/amika/go/labs/amikalyze"
	"github.com/spf13/cobra"
)

var hookCmd = &cobra.Command{
	Use:    "hook",
	Short:  "Evaluate an agent PreToolUse hook",
	Hidden: true,
	Args:   cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		source := policy.Source(mustString(cmd.Flags().GetString("source")))
		if source != policy.SourceClaude && source != policy.SourceCodex {
			return fmt.Errorf("unsupported --source %q (want claude or codex)", source)
		}
		overrides, err := policy.OverridesFromEnvironment()
		if err != nil {
			return writeDenial(cmd, "Amikalyze blocked this edit because its run overrides are invalid: "+err.Error())
		}
		decision, err := policy.EvaluateHook(source, cmd.InOrStdin(), overrides)
		if err != nil {
			return writeDenial(cmd, "Amikalyze blocked this edit because policy evaluation failed: "+err.Error())
		}
		if !decision.Frozen() {
			return nil
		}
		return writeDenial(cmd, decision.DenialReason())
	},
}

type preToolUseOutput struct {
	HookSpecificOutput preToolUseDecision `json:"hookSpecificOutput"`
}

type preToolUseDecision struct {
	HookEventName            string `json:"hookEventName"`
	PermissionDecision       string `json:"permissionDecision"`
	PermissionDecisionReason string `json:"permissionDecisionReason"`
}

func writeDenial(cmd *cobra.Command, reason string) error {
	output := preToolUseOutput{HookSpecificOutput: preToolUseDecision{
		HookEventName:            "PreToolUse",
		PermissionDecision:       "deny",
		PermissionDecisionReason: reason,
	}}
	if err := json.NewEncoder(cmd.OutOrStdout()).Encode(output); err != nil {
		return fmt.Errorf("writing hook denial: %w", err)
	}
	return nil
}

func mustString(value string, _ error) string { return value }

func init() {
	rootCmd.AddCommand(hookCmd)
	hookCmd.Flags().String("source", "", "Source agent (claude|codex)")
	_ = hookCmd.MarkFlagRequired("source")
}
