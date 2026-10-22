package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/gofixpoint/amika/go/internal/agentskill"
	"github.com/gofixpoint/amika/go/internal/buildmeta"
	"github.com/gofixpoint/amika/go/internal/gitrepo"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/sandbox"
	"github.com/spf13/cobra"
)

var skillCmd = &cobra.Command{
	Use:   "skill",
	Short: "Manage the amika agent skill",
	Long: `Manage the amika-cli agent skill, which teaches coding agents (Claude Code,
Codex, Cursor) to drive this CLI non-interactively.`,
}

var skillInstallCmd = &cobra.Command{
	Use:   "install",
	Short: "Install the amika agent skill for coding agents",
	Long: `Install the amika-cli agent skill for coding agents.

The skill is built into this binary, so the installed copy always matches the
installed CLI. Run the command again after upgrading amika to upgrade the
skill; an existing copy is replaced, and the output says so.

Choose where to install with exactly one of:

  --global  the user's home directory, for every project
  --local   the current project: the root of the git repository containing the
            working directory, or the working directory itself outside one

Each agent reads skills from its own directory under that root:

  claude  .claude/skills/amika-cli
  codex   .agents/skills/amika-cli
  cursor  .agents/skills/amika-cli

Codex and Cursor share .agents/skills, so choosing both writes one copy.
--agents defaults to all three.`,
	Example: `  # Install for Claude Code, Codex, and Cursor in your home directory
  amika skill install --global

  # Install into the current repository for Claude Code only
  amika skill install --local --agents claude

  # Report the installed paths as JSON
  amika skill install --global --agents codex,cursor -o json`,
	Args: cobra.NoArgs,
	RunE: runSkillInstall,
}

const (
	skillScopeGlobal = "global"
	skillScopeLocal  = "local"
)

// skillInstallResult is the JSON result of `amika skill install`.
type skillInstallResult struct {
	Skill    string              `json:"skill"`
	Version  string              `json:"version"`
	Scope    string              `json:"scope"`
	Installs []agentskill.Result `json:"installs"`
}

func init() {
	skillInstallCmd.Flags().Bool("global", false, "Install into the user's home directory")
	skillInstallCmd.Flags().Bool("local", false, "Install into the current project (the enclosing git repository root, else the working directory)")
	skillInstallCmd.Flags().String("agents", strings.Join(agentNames(agentskill.AllAgents), ","),
		"Comma-separated agents to install for: claude, codex, cursor")
	skillCmd.AddCommand(skillInstallCmd)
	rootCmd.AddCommand(skillCmd)
}

func runSkillInstall(cmd *cobra.Command, _ []string) error {
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	scope, err := skillScope(cmd)
	if err != nil {
		return err
	}
	names, err := cmd.Flags().GetString("agents")
	if err != nil {
		return err
	}
	agents, err := agentskill.ParseAgents(strings.Split(names, ","))
	if err != nil {
		return fmt.Errorf("--agents: %w", err)
	}
	root, err := skillRoot(scope)
	if err != nil {
		return err
	}

	results, err := agentskill.InstallAll(sandbox.AgentSkillFS(), agentskill.ResolveTargets(root, agents))
	if err != nil {
		return err
	}
	result := skillInstallResult{
		Skill:    agentskill.Name,
		Version:  buildmeta.AmikaVersion.String(),
		Scope:    scope,
		Installs: results,
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), result)
	}
	printSkillInstall(cmd.OutOrStdout(), result)
	return nil
}

// skillScope reads --global/--local. Exactly one is required: installing into
// the wrong place silently would leave an agent without the skill, and the CLI
// does not prompt, so it asks for the choice up front.
func skillScope(cmd *cobra.Command) (string, error) {
	global, err := cmd.Flags().GetBool("global")
	if err != nil {
		return "", err
	}
	local, err := cmd.Flags().GetBool("local")
	if err != nil {
		return "", err
	}
	switch {
	case global && local:
		return "", errors.New("--global and --local cannot be used together; choose one")
	case global:
		return skillScopeGlobal, nil
	case local:
		return skillScopeLocal, nil
	default:
		return "", errors.New("choose where to install: --global (your home directory) or --local (the current project)")
	}
}

// skillRoot is the directory the agents' skill directories live under: the
// home directory for a global install, the project root for a local one.
func skillRoot(scope string) (string, error) {
	if scope == skillScopeGlobal {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home directory: %w", err)
		}
		return home, nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("resolve working directory: %w", err)
	}
	if root, err := gitrepo.ResolveRoot(cwd); err == nil {
		return root, nil
	}
	return cwd, nil
}

func printSkillInstall(w io.Writer, result skillInstallResult) {
	for _, install := range result.Installs {
		verb := "Installed"
		note := ""
		if install.Replaced {
			verb = "Updated"
			note = " (replaced the existing copy)"
		}
		fmt.Fprintf(w, "%s %s skill (amika %s) for %s: %s%s\n",
			verb, result.Skill, result.Version, agentskill.AgentList(install.Agents), install.Path, note)
	}
}

func agentNames(agents []agentskill.Agent) []string {
	names := make([]string, len(agents))
	for i, agent := range agents {
		names[i] = string(agent)
	}
	return names
}
