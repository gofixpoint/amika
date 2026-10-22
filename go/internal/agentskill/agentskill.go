// Package agentskill installs the amika CLI's agent skill into the directories
// coding agents discover skills in.
//
// The skill ships inside the CLI binary, so an installed copy always matches
// the CLI that installed it. Each agent looks for skills in its own place:
//
//   - Claude Code reads <root>/.claude/skills and nothing else.
//   - Codex reads <root>/.agents/skills.
//   - Cursor reads <root>/.agents/skills (and its own .cursor/skills).
//
// <root> is the user's home directory for a global install and the project
// root for a local one. Codex and Cursor share .agents/skills, so choosing
// both writes a single copy.
package agentskill

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// Name is the skill's name, and the directory it is installed under.
const Name = "amika-cli"

// Agent is a coding agent the skill can be installed for.
type Agent string

// The agents the skill can be installed for.
const (
	Claude Agent = "claude"
	Codex  Agent = "codex"
	Cursor Agent = "cursor"
)

// AllAgents lists every supported agent in canonical order. It is also the
// default set when the caller names none.
var AllAgents = []Agent{Claude, Codex, Cursor}

// Target is one skill directory to write and the agents that read it.
type Target struct {
	Dir    string
	Agents []Agent
}

// Result reports one installed copy of the skill.
type Result struct {
	Path     string  `json:"path"`
	Agents   []Agent `json:"agents"`
	Replaced bool    `json:"replaced"`
}

// ParseAgents validates agent names, as given to --agents, and returns them
// deduplicated in canonical order. Names are matched case-insensitively and
// surrounding whitespace is ignored. An empty list is an error: the caller
// applies its default before parsing.
func ParseAgents(names []string) ([]Agent, error) {
	chosen := map[Agent]bool{}
	for _, raw := range names {
		name := Agent(strings.ToLower(strings.TrimSpace(raw)))
		if name == "" {
			continue
		}
		if !slices.Contains(AllAgents, name) {
			return nil, fmt.Errorf("unknown agent %q; choose from %s", raw, AgentList(AllAgents))
		}
		chosen[name] = true
	}
	if len(chosen) == 0 {
		return nil, fmt.Errorf("no agents given; choose from %s", AgentList(AllAgents))
	}
	var agents []Agent
	for _, agent := range AllAgents {
		if chosen[agent] {
			agents = append(agents, agent)
		}
	}
	return agents, nil
}

// ResolveTargets returns the skill directories to write under root (a home
// directory or a project root) for agents, one per distinct directory, in the
// order the agents are given.
func ResolveTargets(root string, agents []Agent) []Target {
	var targets []Target
	for _, agent := range agents {
		dir := filepath.Join(root, skillsDirectory(agent), Name)
		if i := slices.IndexFunc(targets, func(t Target) bool { return t.Dir == dir }); i >= 0 {
			targets[i].Agents = append(targets[i].Agents, agent)
			continue
		}
		targets = append(targets, Target{Dir: dir, Agents: []Agent{agent}})
	}
	return targets
}

// InstallAll writes skill into every target and reports each copy. It stops at
// the first failure, returning the copies already written.
func InstallAll(skill fs.FS, targets []Target) ([]Result, error) {
	results := []Result{}
	for _, target := range targets {
		replaced, err := Install(skill, target.Dir)
		if err != nil {
			return results, fmt.Errorf("install skill for %s into %s: %w", AgentList(target.Agents), target.Dir, err)
		}
		results = append(results, Result{Path: target.Dir, Agents: target.Agents, Replaced: replaced})
	}
	return results, nil
}

// Install writes the skill tree to dir, replacing whatever dir held, and
// reports whether something was there before. The new tree is assembled in a
// sibling temporary directory and moved into place, so a failed copy leaves
// the previous install intact.
func Install(skill fs.FS, dir string) (replaced bool, err error) {
	parent := filepath.Dir(dir)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return false, err
	}
	if _, err := os.Lstat(dir); err == nil {
		replaced = true
	} else if !os.IsNotExist(err) {
		return false, err
	}

	staging, err := os.MkdirTemp(parent, "."+filepath.Base(dir)+"-*")
	if err != nil {
		return false, err
	}
	defer os.RemoveAll(staging)
	if err := os.Chmod(staging, 0o755); err != nil {
		return false, err
	}
	if err := copyTree(skill, staging); err != nil {
		return false, err
	}

	if err := os.RemoveAll(dir); err != nil {
		return false, err
	}
	if err := os.Rename(staging, dir); err != nil {
		return false, err
	}
	return replaced, nil
}

// skillsDirectory is where agent looks for skills, relative to the install
// root.
func skillsDirectory(agent Agent) string {
	if agent == Claude {
		return filepath.Join(".claude", "skills")
	}
	return filepath.Join(".agents", "skills")
}

// copyTree copies every file in src into dst, which must exist.
func copyTree(src fs.FS, dst string) error {
	return fs.WalkDir(src, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		target := filepath.Join(dst, filepath.FromSlash(path))
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		return copyFile(src, path, target)
	})
}

func copyFile(src fs.FS, path, target string) error {
	in, err := src.Open(path)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// AgentList joins agent names for display, e.g. "codex, cursor".
func AgentList(agents []Agent) string {
	names := make([]string, len(agents))
	for i, agent := range agents {
		names[i] = string(agent)
	}
	return strings.Join(names, ", ")
}
