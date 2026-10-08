package uisettings

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/tomasz-tomczyk/crit/internal/testutil"
)

func settingsFile(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	testutil.SetHome(t, home)
	return filepath.Join(home, ".crit", "ui-settings.json")
}

func TestCRIT02_1_SaveCreatesFileUnderHome(t *testing.T) {
	path := settingsFile(t)
	snap, err := Save(map[string]any{"theme": "dark"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if !snap.Exists || snap.Path != path || snap.Settings["theme"] != "dark" {
		t.Fatalf("snapshot = %+v", snap)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"theme": "dark"`) {
		t.Fatalf("file = %s", data)
	}
}

func TestCRIT02_7_InvalidJSONFallsBackAndIsNotOverwrittenOnLoad(t *testing.T) {
	path := settingsFile(t)
	testutil.WriteFile(t, path, `{"theme": "dark",`)
	snap, problem := Load()
	if !snap.Exists || len(snap.Settings) != 0 {
		t.Fatalf("snapshot = %+v", snap)
	}
	if !strings.Contains(problem, "invalid JSON") {
		t.Fatalf("problem = %q", problem)
	}
	data, _ := os.ReadFile(path)
	if string(data) != `{"theme": "dark",` {
		t.Fatalf("Load rewrote the file: %s", data)
	}
	// The next change replaces the broken file with valid settings.
	if _, err := Save(map[string]any{"lineNumbers": "off"}, false); err != nil {
		t.Fatal(err)
	}
	snap, problem = Load()
	if problem != "" || snap.Settings["lineNumbers"] != "off" {
		t.Fatalf("after save: %+v %q", snap, problem)
	}
}

func TestCRIT02_7_UnknownValuesFallBackPerKey(t *testing.T) {
	path := settingsFile(t)
	testutil.WriteFile(t, path, `{"theme":"purple","darkPalette":"no-such-palette","lightPalette":"tokyo-night","lineNumbers":"off","codeFont":"Menlo"}`)
	snap, problem := Load()
	for _, k := range []string{"theme", "darkPalette", "lightPalette"} {
		if _, ok := snap.Settings[k]; ok {
			t.Errorf("%s kept: %v", k, snap.Settings[k])
		}
		if !strings.Contains(problem, k) {
			t.Errorf("problem %q does not name %s", problem, k)
		}
	}
	if snap.Settings["lineNumbers"] != "off" || snap.Settings["codeFont"] != "Menlo" {
		t.Fatalf("valid values dropped: %+v", snap.Settings)
	}
}

func TestCRIT02_7_WarningNamesFileOnce(t *testing.T) {
	path := settingsFile(t)
	testutil.WriteFile(t, path, `not json`)
	var b strings.Builder
	WarnIfInvalid(&b)
	out := b.String()
	if strings.Count(out, "\n") != 1 || !strings.Contains(out, path) || !strings.Contains(out, "invalid JSON") {
		t.Fatalf("warning = %q", out)
	}
	b.Reset()
	testutil.WriteFile(t, path, `{"theme":"dark"}`)
	WarnIfInvalid(&b)
	if b.String() != "" {
		t.Fatalf("valid file warned: %q", b.String())
	}
}

func TestCRIT02_11_SaveMergesOnlySentKeys(t *testing.T) {
	path := settingsFile(t)
	testutil.WriteFile(t, path, `{"theme":"light","lineNumbers":"off"}`)
	// Another process changed the palette after this one loaded.
	if _, err := Save(map[string]any{"lightPalette": "ayu-light"}, false); err != nil {
		t.Fatal(err)
	}
	if _, err := Save(map[string]any{"theme": "dark"}, false); err != nil {
		t.Fatal(err)
	}
	snap, _ := Load()
	want := map[string]any{"theme": "dark", "lineNumbers": "off", "lightPalette": "ayu-light"}
	for k, v := range want {
		if snap.Settings[k] != v {
			t.Errorf("%s = %v, want %v", k, snap.Settings[k], v)
		}
	}
	if len(snap.Settings) != len(want) {
		t.Errorf("settings = %+v", snap.Settings)
	}
}

func TestCRIT02_2_ValidateAcceptsEveryDialogControl(t *testing.T) {
	ok := map[string]any{
		"theme": "dark", "lightPalette": "ayu-light", "darkPalette": "tokyo-night", "codeFont": "'Fira Code', monospace",
		"lineNumbers": "off", "boostContrast": "on", "codeOverflow": "wrap", "inlineDiff": "char",
		"changeIndicators": "classic", "unchangedContext": "expanded", "width": "wide",
		"hideResolved": true, "ignoreWhitespace": true, "live_hideResolved": true,
		"shortcuts": map[string]any{"next_block": "ArrowDown"},
	}
	for k, v := range ok {
		if err := Validate(k, v); err != nil {
			t.Errorf("%s=%v rejected: %v", k, v, err)
		}
	}
	bad := map[string]any{
		"theme": "purple", "darkPalette": "ayu-light", "lineNumbers": true, "hideResolved": "yes",
		"shortcuts": map[string]any{"next_block": 1}, "fileTreeWidth": 300, "codeFont": strings.Repeat("a", 300),
	}
	for k, v := range bad {
		if err := Validate(k, v); err == nil {
			t.Errorf("%s=%v accepted", k, v)
		}
	}
}

func TestCRIT02_3_PerReviewKeysAreNotSettings(t *testing.T) {
	for _, k := range []string{"fileTreeWidth", "commentsPanelWidth", "storyRailWidth", "live_commentsPanelOpen", "live_commentsPanelWidth", "fileTree", "toc", "diffScope", "diffMode", "live_viewport"} {
		if IsSetting(k) {
			t.Errorf("%s is per-review state, not a Settings-dialog control", k)
		}
	}
}

func TestCRIT02_4_ImportOnlyWritesWhenFileIsAbsent(t *testing.T) {
	path := settingsFile(t)
	snap, err := Save(map[string]any{"theme": "light"}, true)
	if err != nil || snap.Settings["theme"] != "light" {
		t.Fatalf("first import: %+v %v", snap, err)
	}
	snap, err = Save(map[string]any{"theme": "dark"}, true)
	if err != nil || snap.Settings["theme"] != "light" {
		t.Fatalf("second import overwrote: %+v %v", snap, err)
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "light") {
		t.Fatalf("file = %s", data)
	}
}

func TestCRIT02_8_ReadOnlyFileIsNotReplaced(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file mode bits")
	}
	path := settingsFile(t)
	testutil.WriteFile(t, path, `{"theme":"light"}`)
	if err := os.Chmod(path, 0o444); err != nil {
		t.Fatal(err)
	}
	_, err := Save(map[string]any{"theme": "dark"}, false)
	if err == nil || !strings.Contains(err.Error(), path) {
		t.Fatalf("err = %v, want one naming %s", err, path)
	}
	data, _ := os.ReadFile(path)
	if string(data) != `{"theme":"light"}` {
		t.Fatalf("read-only file replaced: %s", data)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatalf("temp files left behind: %v", entries)
	}
}

func TestCRIT02_8_FailedWriteLeavesNoTempFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file mode bits")
	}
	path := settingsFile(t)
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// A directory where the file should be makes the rename fail after the
	// temp file was written.
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Save(map[string]any{"theme": "dark"}, false); err == nil {
		t.Fatal("save into a directory succeeded")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("temp files left behind: %v", entries)
	}
}

func TestCRIT02_4_ResetRemovesFile(t *testing.T) {
	path := settingsFile(t)
	testutil.WriteFile(t, path, `{"theme":"light"}`)
	if err := Reset(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("file still there: %v", err)
	}
	if err := Reset(); err != nil {
		t.Fatalf("reset of a missing file: %v", err)
	}
}
