package testutil

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func init() {
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "GIT_") {
			continue
		}
		eq := strings.IndexByte(kv, '=')
		if eq < 0 {
			continue
		}
		os.Unsetenv(kv[:eq])
	}
}

// SetHome sets HOME (and Windows profile vars) for the duration of the test.
func SetHome(t *testing.T, dir string) {
	t.Helper()
	t.Setenv("HOME", dir)
	t.Setenv("CODEX_HOME", "")
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", dir)
		t.Setenv("HOMEDRIVE", "")
		t.Setenv("HOMEPATH", "")
	}
}

// InitTestRepo creates a temp git repo with an initial commit on main.
func InitTestRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	Git(t, dir, "init")
	Git(t, dir, "config", "user.email", "test@test.com")
	Git(t, dir, "config", "user.name", "Test")
	WriteFile(t, filepath.Join(dir, "README.md"), "# Test")
	Git(t, dir, "add", "README.md")
	Git(t, dir, "commit", "-m", "initial")
	Git(t, dir, "branch", "-M", "main")
	return dir
}

// Git runs a git command in dir with a sanitized environment.
func Git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	src := os.Environ()
	env := make([]string, 0, len(src)+4)
	for _, kv := range src {
		if strings.HasPrefix(kv, "GIT_") || strings.HasPrefix(kv, "HOME=") {
			continue
		}
		if runtime.GOOS == "windows" && (strings.HasPrefix(kv, "USERPROFILE=") ||
			strings.HasPrefix(kv, "HOMEDRIVE=") || strings.HasPrefix(kv, "HOMEPATH=")) {
			continue
		}
		env = append(env, kv)
	}
	env = append(env, "GIT_CONFIG_NOSYSTEM=1", "HOME="+dir)
	if runtime.GOOS == "windows" {
		env = append(env, "USERPROFILE="+dir)
	}
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// WriteFile writes content to path, creating parent directories as needed.
func WriteFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// MustMkdirAll ensures the parent directory of path exists, then returns path.
func MustMkdirAll(path string) string {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		panic(err)
	}
	return path
}

// RunWithTempHome runs a package's tests with a throwaway HOME, for use from
// TestMain. Review sessions, config and auth live under ~/.crit; a crit daemon
// running in the same checkout (or the developer's own config) must not change
// test results. Helper subprocesses inherit it.
//
// It also fails the run when the developer's real ~/.crit/ui-settings.json
// changed while the tests ran: that file is shared by every review on the
// machine, so a test that reaches it would silently rewrite the user's setup.
func RunWithTempHome(m *testing.M) int {
	unchanged := GuardRealUISettings()
	home, err := os.MkdirTemp("", "crit-test-home-")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(home)
	os.Setenv("HOME", home)
	os.Setenv("USERPROFILE", home)
	os.Setenv("CODEX_HOME", "")
	code := m.Run()
	if err := unchanged(); err != nil {
		fmt.Fprintln(os.Stderr, "FAIL:", err)
		return 1
	}
	return code
}

// GuardRealUISettings snapshots ~/.crit/ui-settings.json under the current
// HOME and returns a check that errors if the file was created, changed or
// removed since. Call it before HOME is swapped for a temp dir.
func GuardRealUISettings() func() error {
	path := ""
	if home, err := os.UserHomeDir(); err == nil {
		path = filepath.Join(home, ".crit", "ui-settings.json")
	}
	before := readOrAbsent(path)
	return func() error {
		if path != "" && readOrAbsent(path) != before {
			return fmt.Errorf("tests changed the real %s; tests must use a temp HOME", path)
		}
		return nil
	}
}

// readOrAbsent returns the file's bytes, or a marker no file can hold when it
// does not exist (so "created" and "deleted" both count as a change).
func readOrAbsent(path string) string {
	if path == "" {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "\x00absent"
	}
	return string(data)
}
