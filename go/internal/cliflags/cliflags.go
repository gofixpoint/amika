// Package cliflags holds flag-naming rules shared across the amika CLI.
//
// The CLI renamed its core noun from "sandbox" to "rig": the command is now
// `amika rig`, with `sandbox` kept as a Cobra alias. The flags that name a rig
// followed, so `--rig`, `--rig-name`, and `--rig-by` are the spellings help
// output advertises. The `--sandbox…` names they replaced keep working, so
// scripts written against the old vocabulary do not break.
package cliflags

import "github.com/spf13/pflag"

// NormalizeFlagName maps a flag name written on the command line to the name
// its flag is registered under, so a retired `--sandbox…` spelling reaches the
// `--rig…` flag that replaced it. Every other name passes through untouched.
//
// Install it once on the root command with SetGlobalNormalizationFunc: Cobra
// applies it to every command already attached and to every command added
// afterwards, so the aliases hold across the whole tree regardless of the order
// package-level init functions run in.
func NormalizeFlagName(_ *pflag.FlagSet, name string) pflag.NormalizedName {
	if canonical, ok := legacyRigFlagNames[name]; ok {
		return pflag.NormalizedName(canonical)
	}
	return pflag.NormalizedName(name)
}

// legacyRigFlagNames maps each sandbox-era flag name to the rig-era name that
// replaced it. A name appearing here must not also be registered as a flag of
// its own anywhere in the command tree: normalization is applied at
// registration too, so such a flag would silently land on its replacement.
var legacyRigFlagNames = map[string]string{
	"sandbox":      "rig",
	"sandbox-name": "rig-name",
	"sandbox-by":   "rig-by",
}
