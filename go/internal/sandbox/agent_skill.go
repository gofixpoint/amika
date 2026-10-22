package sandbox

import (
	"io/fs"
)

// agentSkillDirectory is where the image bundle carries its generated copy of
// the amika-cli agent skill. sandbox-image/generate.py writes it from the
// repository's .agents/skills/amika-cli, and CI fails when it goes stale.
const agentSkillDirectory = "sandbox-image/assets/skills/amika-cli"

// AgentSkillFS returns the amika-cli agent skill tree (SKILL.md and its
// references) compiled into this binary, rooted at the skill directory.
//
// The binary already embeds the image bundle, which must carry the skill for
// the image build, so the installer reads that copy rather than embedding a
// second one: the skill a user installs is exactly the one this CLI version
// was built with.
func AgentSkillFS() fs.FS {
	skill, err := fs.Sub(sandboxImageFS, agentSkillDirectory)
	if err != nil {
		// fs.Sub fails only for an invalid path, and this one is a constant.
		panic(err)
	}
	return skill
}
