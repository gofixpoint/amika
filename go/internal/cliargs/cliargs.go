// Package cliargs splits a command line between the arguments amika interprets
// itself and the arguments it forwards verbatim to an underlying utility such
// as ssh or scp.
//
// The split is positional, mirroring the underlying utility: arguments written
// before the subcommand name belong to amika, arguments written after it are
// forwarded. That distinction is not recoverable from the arguments Cobra hands
// a command, because Cobra removes the command path from the argv first. Both
//
//	amika --output json sandbox sshv2 my-box
//	amika sandbox sshv2 --output json my-box
//
// reach the sshv2 command as the identical slice
//
//	["--output", "json", "my-box"]
//
// so Split needs the original process argv, where the "sshv2" token still marks
// the boundary. Callers pass it in rather than reading os.Args here, so tests
// can exercise the split with a synthetic argv.
package cliargs

import "strings"

// SSHArgLetters are ssh's single-letter options that take their argument as a
// separate token (from ssh(1)). Locating an operand requires them: without
// them the "6789:localhost:3010" in "-L 6789:localhost:3010 my-box" would be
// mistaken for the destination.
const SSHArgLetters = "BbcDEeFIiJLlmOopQRSWw"

// Split divides the arguments Cobra delivered to a leaf command into the
// amika-owned prefix and the suffix to forward to the underlying utility.
//
// cmdName is the leaf command's name as written on the command line, and
// valueFlags lists the amika flags that take their value as a separate token,
// so a value that happens to equal cmdName is not mistaken for the command
// itself. If cmdName does not appear in procArgs, nothing can be attributed by
// position and every argument is treated as amika's.
func Split(procArgs, leafArgs []string, cmdName string, valueFlags map[string]bool) (own, forward []string) {
	idx := commandIndex(procArgs, cmdName, valueFlags)
	if idx < 0 {
		return leafArgs, nil
	}
	// Every token after the command name survives in leafArgs as a contiguous
	// suffix: Cobra strips only the command path, which lies entirely before
	// that point. So the count of trailing tokens locates the boundary without
	// having to match tokens between the two slices.
	n := len(procArgs) - (idx + 1)
	if n > len(leafArgs) {
		n = len(leafArgs)
	}
	return leafArgs[:len(leafArgs)-n], leafArgs[len(leafArgs)-n:]
}

// commandIndex returns the position of the leaf command's name in the process
// argv, or -1. Element 0 is the binary path and is never considered.
func commandIndex(procArgs []string, cmdName string, valueFlags map[string]bool) int {
	for i := 1; i < len(procArgs); i++ {
		tok := procArgs[i]
		if tok == cmdName {
			return i
		}
		if valueFlags[tok] {
			i++ // skip the flag's value, which may itself read as a command name
		}
	}
	return -1
}

// FirstOperand returns the index of the first operand in a getopt-style argv:
// the first token that is neither an option nor an option's value. It returns
// -1 when the argv holds no operand. argLetters lists the utility's
// single-letter options that take a separate argument.
func FirstOperand(args []string, argLetters string) int {
	for i := 0; i < len(args); i++ {
		tok := args[i]
		if tok == "--" {
			// End of options: the next token is an operand, whatever it looks
			// like. This mirrors "ssh -- -weird-host".
			if i+1 < len(args) {
				return i + 1
			}
			return -1
		}
		if len(tok) >= 2 && tok[0] == '-' {
			if ConsumesNextArg(tok, argLetters) && i+1 < len(args) {
				i++
			}
			continue
		}
		// A bare "-" is an operand, as is any token not starting with "-".
		return i
	}
	return -1
}

// ConsumesNextArg reports whether an option token takes the following argv
// token as its argument rather than an attached value. It mirrors getopt: in a
// bundled cluster such as "-Nl" only the first argument-taking letter takes a
// value, and it takes the following token only when nothing is attached after
// it ("-o" takes the next token, while "-oVALUE" and "-Nl root" do not).
func ConsumesNextArg(tok, argLetters string) bool {
	if len(tok) < 2 || tok[0] != '-' || tok[1] == '-' {
		return false // an operand, a bare "-", or a "--" end-of-options marker
	}
	for i := 1; i < len(tok); i++ {
		if strings.IndexByte(argLetters, tok[i]) >= 0 {
			return i == len(tok)-1
		}
	}
	return false
}

// HasHelpFlag reports whether args requests help. Only a help flag written
// among the leading options counts: once the first operand or a "--" appears,
// later tokens belong to the underlying utility (for ssh, they form the remote
// command), so "sshv2 my-box --help" asks the sandbox for help rather than
// amika.
func HasHelpFlag(args []string) bool {
	for _, a := range args {
		if len(a) == 0 || a[0] != '-' || a == "--" || a == "-" {
			return false // first operand or end-of-options marker
		}
		if a == "-h" || a == "--help" {
			return true
		}
	}
	return false
}
