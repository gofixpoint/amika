package wslbridge

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

// stubInterop replaces interop execution with scripted answers keyed by the
// invoked program, so no test needs a Windows side.
func stubInterop(t *testing.T, answers map[string]string) *[]string {
	t.Helper()
	var calls []string
	prev := runInterop
	runInterop = func(name string, args ...string) (string, error) {
		calls = append(calls, name+" "+strings.Join(args, " "))
		answer, ok := answers[name]
		if !ok {
			return "", errors.New("unexpected interop call: " + name)
		}
		return answer, nil
	}
	t.Cleanup(func() { runInterop = prev })
	return &calls
}

func TestIsWSL(t *testing.T) {
	tests := []struct {
		name    string
		version string
		readErr error
		want    bool
	}{
		{name: "wsl2 kernel", version: "Linux version 5.15.167.4-microsoft-standard-WSL2...", want: true},
		{name: "case insensitive", version: "Linux version ... Microsoft-WSL", want: true},
		{name: "plain linux", version: "Linux version 6.8.0-40-generic...", want: false},
		{name: "unreadable", readErr: errors.New("no such file"), want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			prev := readProcVersion
			readProcVersion = func() ([]byte, error) {
				if tt.readErr != nil {
					return nil, tt.readErr
				}
				return []byte(tt.version), nil
			}
			t.Cleanup(func() { readProcVersion = prev })

			if got := IsWSL(); got != tt.want {
				t.Fatalf("IsWSL() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestDistro(t *testing.T) {
	t.Setenv("WSL_DISTRO_NAME", "Ubuntu-22.04")
	distro, err := Distro()
	if err != nil {
		t.Fatalf("Distro: %v", err)
	}
	if distro != "Ubuntu-22.04" {
		t.Fatalf("Distro = %q", distro)
	}

	t.Setenv("WSL_DISTRO_NAME", "")
	if _, err := Distro(); err == nil {
		t.Fatal("expected error when WSL_DISTRO_NAME is unset")
	}
}

func TestUserProfileIgnoresLeadingNoise(t *testing.T) {
	stubInterop(t, map[string]string{
		"cmd.exe": "'\\\\wsl.localhost\\Ubuntu\\home\\u'\r\nCMD.EXE was started with the above path as the current directory.\r\nC:\\Users\\Test User\r\n",
	})
	profile, err := UserProfile()
	if err != nil {
		t.Fatalf("UserProfile: %v", err)
	}
	if profile != `C:\Users\Test User` {
		t.Fatalf("UserProfile = %q", profile)
	}
}

func TestUserProfileRejectsGarbage(t *testing.T) {
	stubInterop(t, map[string]string{"cmd.exe": "\r\n"})
	if _, err := UserProfile(); err == nil {
		t.Fatal("expected error for output without a drive path")
	}
}

func TestResolveTarget(t *testing.T) {
	t.Setenv("WSL_DISTRO_NAME", "Ubuntu")
	stubInterop(t, map[string]string{
		"cmd.exe": "C:\\Users\\hrishikesh\r\n",
		"wslpath": "/mnt/c/Users/hrishikesh/.ssh\n",
	})
	target, err := ResolveTarget()
	if err != nil {
		t.Fatalf("ResolveTarget: %v", err)
	}
	want := Target{
		SSHDir:        "/mnt/c/Users/hrishikesh/.ssh",
		SSHDirWindows: `C:\Users\hrishikesh\.ssh`,
		Distro:        "Ubuntu",
		User:          "hrishikesh",
	}
	if target != want {
		t.Fatalf("ResolveTarget = %+v, want %+v", target, want)
	}
}

func TestResolveTargetRequiresDistro(t *testing.T) {
	t.Setenv("WSL_DISTRO_NAME", "")
	if _, err := ResolveTarget(); err == nil {
		t.Fatal("expected error when WSL_DISTRO_NAME is unset")
	}
}

func TestEditorExeFromWhere(t *testing.T) {
	install := t.TempDir()
	fake := filepath.Join(install, "Code.exe")
	if err := os.WriteFile(fake, []byte("fake"), 0o755); err != nil {
		t.Fatal(err)
	}
	prev := runInterop
	runInterop = func(name string, args ...string) (string, error) {
		switch name {
		case "where.exe":
			// where reports the CLI launcher one bin/ level below the executable.
			return "C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd\r\n", nil
		case "cmd.exe":
			return "C:\\Users\\u\r\n", nil
		case "wslpath":
			if strings.Contains(args[1], "Code.exe") {
				return fake + "\n", nil
			}
			return "", errors.New("unexpected path " + args[1])
		}
		return "", errors.New("unexpected call " + name)
	}
	t.Cleanup(func() { runInterop = prev })

	exe, err := EditorExe("code")
	if err != nil {
		t.Fatalf("EditorExe: %v", err)
	}
	want := `C:\Users\u\AppData\Local\Programs\Microsoft VS Code\Code.exe`
	if exe != want {
		t.Fatalf("EditorExe = %q, want %q", exe, want)
	}
}

// TestExecDetachedReturnsWhileChildRuns encodes the contract the WSL launch
// depends on: the spawn returns immediately even though the launched process
// is still running, because WSL interop would otherwise hold the caller until
// every Windows descendant exits.
func TestExecDetachedReturnsWhileChildRuns(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix-only check")
	}
	done := make(chan error, 1)
	start := time.Now()
	go func() {
		done <- execDetached("sleep", "5")
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("execDetached: %v", err)
		}
		if elapsed := time.Since(start); elapsed > 3*time.Second {
			t.Fatalf("execDetached waited %v for a running child", elapsed)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("execDetached blocked while the child was still running")
	}
}

func TestLaunchDetachedStartsWithEmptyTitle(t *testing.T) {
	var got []string
	prev := execDetached
	execDetached = func(name string, args ...string) error {
		got = append([]string{name}, args...)
		return nil
	}
	t.Cleanup(func() { execDetached = prev })

	exe := `C:\Program Files\Microsoft VS Code\Code.exe`
	if err := LaunchDetached(exe, "--remote", "ssh-remote+sb.example.amika", "/home/amika/workspace"); err != nil {
		t.Fatalf("LaunchDetached: %v", err)
	}
	want := []string{"cmd.exe", "/c", "start", "", exe, "--remote", "ssh-remote+sb.example.amika", "/home/amika/workspace"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("argv = %q, want %q", got, want)
	}
}

func TestEditorExeNotFound(t *testing.T) {
	prev := runInterop
	runInterop = func(string, ...string) (string, error) {
		return "", errors.New("not found")
	}
	t.Cleanup(func() { runInterop = prev })

	if _, err := EditorExe("code"); err == nil {
		t.Fatal("expected error when nothing resolves")
	}
}

func TestEditorExeUnsupportedCLI(t *testing.T) {
	if _, err := EditorExe("vim"); err == nil {
		t.Fatal("expected error for an editor without a Windows install layout")
	}
}
