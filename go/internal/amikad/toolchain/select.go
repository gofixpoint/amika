package toolchain

import (
	"fmt"
	"sort"
	"strings"
)

// OpenSSHServer is the one dependency the lockfile does not list: it comes
// from the image's package manager, and only when the image has no sshd. It
// is a default.
const OpenSSHServer = "openssh-server"

// nodeDepName is the dependency whose Node installs every KindNPM one.
const nodeDepName = "node"

// Selection is what one install run installs.
type Selection struct {
	// OpenSSHServer asks for sshd from the package manager when missing.
	OpenSSHServer bool
	// Deps are the lockfile dependencies, in lockfile order.
	Deps []Dep
}

// Select resolves the defaults, plus add, minus without. An npm dependency
// brings the lockfile's Node with it. Unknown names, a name both added and
// excluded, and an excluded Node an npm dependency needs are errors.
func Select(lock *Lockfile, add, without []string) (Selection, error) {
	known := map[string]bool{OpenSSHServer: true}
	for _, dep := range lock.Deps {
		known[dep.Name] = true
	}
	adding, err := nameSet(add, known)
	if err != nil {
		return Selection{}, err
	}
	excluding, err := nameSet(without, known)
	if err != nil {
		return Selection{}, err
	}
	for name := range adding {
		if excluding[name] {
			return Selection{}, fmt.Errorf("%s is both added and excluded", name)
		}
	}

	wanted := map[string]bool{}
	for _, dep := range lock.Deps {
		if (dep.Default || adding[dep.Name]) && !excluding[dep.Name] {
			wanted[dep.Name] = true
		}
	}
	for _, dep := range lock.Deps {
		if wanted[dep.Name] && dep.Kind == KindNPM && !wanted[nodeDepName] {
			if excluding[nodeDepName] {
				return Selection{}, fmt.Errorf("%s needs %s, which is excluded", dep.Name, nodeDepName)
			}
			if _, ok := lock.Dep(nodeDepName); !ok {
				return Selection{}, fmt.Errorf("%s needs %s, which the lockfile does not list", dep.Name, nodeDepName)
			}
			wanted[nodeDepName] = true
		}
	}

	selection := Selection{OpenSSHServer: !excluding[OpenSSHServer]}
	for _, dep := range lock.Deps {
		if wanted[dep.Name] {
			selection.Deps = append(selection.Deps, dep)
		}
	}
	return selection, nil
}

func nameSet(names []string, known map[string]bool) (map[string]bool, error) {
	set := map[string]bool{}
	for _, name := range names {
		if !known[name] {
			return nil, fmt.Errorf("unknown dependency %q (known: %s)", name, strings.Join(sortedNames(known), ", "))
		}
		set[name] = true
	}
	return set, nil
}

func sortedNames(set map[string]bool) []string {
	names := make([]string, 0, len(set))
	for name := range set {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
