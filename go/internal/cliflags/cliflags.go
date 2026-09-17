// Package cliflags holds flag-naming rules shared across the amika CLI.
//
// The CLI renamed its core noun from "sandbox" to "rig": the command is now
// `amika rig`, with `sandbox` kept as a Cobra alias. The flags that name a rig
// followed, so `--rig`, `--rig-name`, and `--rig-by` are the spellings help
// output advertises. The `--sandbox…` names they replaced keep working, so
// scripts written against the old vocabulary do not break.
package cliflags

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

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
// replaced it.
//
// A name appearing here must never also be registered as a flag of its own,
// because normalization is applied at registration too, so the pair collides on
// the rig name. Which way that breaks depends on the order the command was
// built in, and neither way is pleasant:
//
//   - Normalizer already installed: pflag's AddFlag panics on the duplicate
//     ("flag redefined"), taking every invocation of the binary down at startup.
//   - Normalizer installed afterwards: SetNormalizeFunc's rename loop overwrites
//     the first entry, leaving one flag under the rig name carrying the legacy
//     registration's default and usage string. No panic, no error.
//
// The rig command tree is on the second path — sandboxcmd.New registers its
// flags and only then is the built tree handed to rootCmd.AddCommand — so a
// legacy name reintroduced there fails silently. TestRigFlagsAccept... in
// package main guards against it by checking the surviving flag's usage text.
var legacyRigFlagNames = map[string]string{
	"sandbox":      "rig",
	"sandbox-name": "rig-name",
	"sandbox-by":   "rig-by",
}

// RemovedLocalFlagName is the retired --local flag. Rigs are always remote, so
// the flag is registered (hidden) on the command trees that used to offer it
// purely so it parses and can be reported as removed rather than surfacing as
// Cobra's bare "unknown flag: --local".
const RemovedLocalFlagName = "local"

// removedLocalFlagError is the migration message both rejections return.
func removedLocalFlagError() error {
	return fmt.Errorf("--%s has been removed; rigs are always remote now, so run the command without it",
		RemovedLocalFlagName)
}

// RejectRemovedLocalFlag returns the migration error when --local was passed to
// cmd. Commands whose tree never registered the flag are unaffected, so those
// keep Cobra's unknown-flag error.
func RejectRemovedLocalFlag(cmd *cobra.Command) error {
	if f := cmd.Flags().Lookup(RemovedLocalFlagName); f != nil && f.Changed {
		return removedLocalFlagError()
	}
	return nil
}

// RejectRemovedLocalFlagInArgs is RejectRemovedLocalFlag for a command that
// sets DisableFlagParsing and forwards its tail to another program: --local
// never reaches a pflag set there, so the raw args have to be scanned instead.
// Without this, `amika rig ssh --local box` would forward --local to ssh, and
// `amika rig --local ssh box` would parse it and silently ignore it.
func RejectRemovedLocalFlagInArgs(rawArgs []string) error {
	long := "--" + RemovedLocalFlagName
	for _, arg := range rawArgs {
		if arg == long || strings.HasPrefix(arg, long+"=") {
			return removedLocalFlagError()
		}
	}
	return nil
}
